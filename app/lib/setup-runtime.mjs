import { readFile, lstat, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, saveConfig, APP_ROOT } from './config.mjs';
import { discoverHermes } from './hermes-runtime.mjs';
import { createHermesProvider } from './hermes.mjs';
import { verifyNativeRuntime } from './native-compatibility.mjs';
import { readJson, writeJson } from './profile-store.mjs';

export async function bundleFile(root, file) {
  if (!isAbsolute(root) || typeof file !== 'string' || !file || isAbsolute(file) || /[\\\0\r\n]/.test(file) || file.split('/').some(part => !part || ['.', '..'].includes(part))) throw new Error('Invalid bundled runtime path.');
  const path = resolve(root, file), info = await lstat(path);
  const actualRoot = await realpath(root), actual = await realpath(path);
  const within = relative(actualRoot, actual);
  if (!within || within === '..' || within.startsWith('..\\') || within.startsWith('../') || isAbsolute(within) || info.isSymbolicLink()) throw new Error('Invalid bundled runtime path.');
  return path;
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function canonicalBundleRoot(root, { resolvePath = realpath, inspect = stat } = {}) {
  // Windows can return a logical directory name but a physical package-cache
  // name for its files. Use the manifest's physical directory only after proving
  // that it is the very same filesystem object, not a substituted resource tree.
  const physical = dirname(await resolvePath(join(root, 'manifest.json')));
  const [logicalInfo, physicalInfo] = await Promise.all([inspect(root, { bigint: true }), inspect(physical, { bigint: true })]);
  if (!logicalInfo.isDirectory() || !physicalInfo.isDirectory() || logicalInfo.ino === 0n || logicalInfo.dev !== physicalInfo.dev || logicalInfo.ino !== physicalInfo.ino) throw new Error('Invalid bundled runtime path.');
  return physical;
}

export async function loadDesktopBundle({ resourcesPath, root = APP_ROOT, platform = process.platform, arch = process.arch } = {}) {
  const candidates = [resourcesPath && join(resourcesPath, 'desktop-runtime'), join(root, '.work', 'desktop-runtime')].filter(Boolean);
  for (const path of candidates) {
    let source;
    try { source = await readFile(join(path, 'manifest.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const manifest = JSON.parse(source);
    if (manifest.version !== 1 || manifest.platform !== platform || manifest.arch !== arch) throw new Error('This Nemo download does not match this computer.');
    const bundleRoot = await canonicalBundleRoot(path);
    let connector = {};
    if (manifest.cloudflared) {
      const { file, sha256 } = manifest.cloudflared;
      if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('The bundled phone connection has not been verified.');
      const executablePath = await bundleFile(bundleRoot, file);
      if (!(await lstat(executablePath)).isFile() || await fileDigest(executablePath) !== sha256) throw new Error('The bundled phone connection needs to be repaired.');
      connector = { executablePath, sha256 };
    }
    let node = {};
    if (manifest.node) {
      const { file, sha256 } = manifest.node;
      if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('The bundled connection tools have not been verified.');
      const executablePath = await bundleFile(bundleRoot, file);
      if (!(await lstat(executablePath)).isFile() || await fileDigest(executablePath) !== sha256) throw new Error('The bundled connection tools need to be repaired.');
      node = { executablePath, sha256 };
    }
    return { root: bundleRoot, manifest, connector, node };
  }
  return { root: '', manifest: null, connector: {}, node: {} };
}

/** Trusted release resources and discovered local runtimes only; no browser paths or downloads. */
export async function createSetupRuntime({ dataDir, resourcesPath, bundle: suppliedBundle, probe = async options => createHermesProvider(options).checkRuntime(), verifyBundle = async options => (await import('./hermes-bundle.mjs')).verifyHermesBundle(options), verifyNative = verifyNativeRuntime } = {}) {
  const bundle = suppliedBundle || await loadDesktopBundle({ resourcesPath });
  const markerPath = join(dataDir, 'managed-runtime.json');
  let cached = null, checking = null;
  function absent() {
    return { ready: false, installed: false, state: 'not-installed', available: !!bundle.manifest?.hermes, message: bundle.manifest?.hermes ? 'Choose Set up my assistant to finish preparing Nemo.' : 'This preview does not include the assistant installer yet. Your existing chats stay saved. A complete Nemo download will handle this step for you.' };
  }
  function unavailable(error) {
    const status = absent();
    return error?.code === 'RUNTIME_REPAIR_REQUIRED' ? { ...status, state: 'repair-required', message: error.message } : status;
  }
  async function activateBundle() {
    const runtime = bundle.manifest?.hermes;
    if (!runtime) throw Object.assign(new Error('This preview does not include the assistant installer yet. Install the complete Nemo release to continue.'), { status: 409, code: 'RUNTIME_NOT_INCLUDED' });
    let python, source;
    try {
      const verified = await verifyBundle({ root: bundle.root, manifest: runtime });
      if (!verified?.extras?.includes('mcp')) throw new Error('The verified assistant package is missing its connected tools.');
      python = await bundleFile(bundle.root, runtime.python); source = await bundleFile(bundle.root, runtime.source);
      await verifyNative({ sourceRoot: source });
    } catch (cause) {
      throw Object.assign(new Error('Nemo’s assistant files could not be verified. Reinstall the latest Nemo, then choose Set up my assistant again. Your chats are saved.', { cause }), { status: 409, code: 'RUNTIME_REPAIR_REQUIRED' });
    }
    await probe({ hermesPython: python, hermesSource: source, dataDir });
    const config = await loadConfig({ dataDir });
    const home = config.hermesHome || join(dataDir, 'assistant-home');
    await saveConfig(dataDir, { publicOrigin: config.publicOrigin, port: config.port, hermesLauncher: '', hermesHome: home, hermesPython: python, hermesSource: source });
    await writeJson(markerPath, { version: 1, python, source, inventorySha256: runtime.inventorySha256 });
    return { launcher: '', hermesHome: home, hermesPython: python, hermesSource: source, dataDir };
  }
  async function inspect() {
    try {
      const config = await loadConfig({ dataDir });
      const explicit = !!(config.hermesLauncher || config.hermesPython || config.hermesSource);
      // A clean packaged install must use its own payload, even on a developer
      // computer that happens to have another Hermes installation on PATH.
      if (bundle.manifest?.hermes && !explicit) return cached = absent();
      const marker = await readJson(markerPath, null);
      if (marker && (marker.version !== 1 || typeof marker.python !== 'string' || typeof marker.source !== 'string')) throw new Error('Invalid managed runtime record.');
      const managed = marker && config.hermesPython === marker.python && config.hermesSource === marker.source && !config.hermesLauncher;
      const current = bundle.manifest?.hermes && config.hermesPython === resolve(bundle.root, bundle.manifest.hermes.python) && config.hermesSource === resolve(bundle.root, bundle.manifest.hermes.source) && !config.hermesLauncher;
      const found = discoverHermes();
      let options = { launcher: config.hermesLauncher || found.launcher, hermesHome: config.hermesHome || found.hermesHome, hermesPython: config.hermesPython, hermesSource: config.hermesSource, dataDir };
      // Squirrel updates move application resources. Rebind only our own previous
      // managed paths; preserve deliberately configured external runtimes.
      if (bundle.manifest?.hermes && (managed || current)) options = await activateBundle();
      if (!options.launcher && !(options.hermesPython && options.hermesSource)) throw new Error();
      await probe(options);
      cached = { ready: true, installed: true, state: 'ready', message: 'Your assistant is installed on this computer.' };
    } catch (error) {
      cached = unavailable(error);
    }
    return { ...cached };
  }
  return {
    bundle,
    async status() { if (cached) return { ...cached }; checking ||= inspect().finally(() => { checking = null; }); return checking; },
    async refresh() { cached = null; return inspect(); },
    async install() {
      try { await activateBundle(); }
      catch (error) { cached = unavailable(error); throw error; }
      cached = { ready: true, installed: true, state: 'ready', message: 'Your assistant is installed on this computer.' };
      return { ...cached };
    },
  };
}
