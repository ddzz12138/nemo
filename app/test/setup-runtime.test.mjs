import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDesktopBundle, bundleFile, createSetupRuntime, canonicalBundleRoot } from '../lib/setup-runtime.mjs';
import { createRequire } from 'node:module';
import { loadConfig, saveConfig } from '../lib/config.mjs';
const { ignore } = createRequire(import.meta.url)('../desktop/packaging.cjs');

test('Windows logical resource aliases normalize only when they identify the same physical directory', async () => {
  const logical = join(tmpdir(), 'logical', 'desktop-runtime'), physical = join(tmpdir(), 'package-cache', 'desktop-runtime');
  const info = ino => ({ dev: 7n, ino, isDirectory: () => true });
  const options = { resolvePath: async path => { assert.equal(path, join(logical, 'manifest.json')); return join(physical, 'manifest.json'); }, inspect: async (_path, flags) => { assert.equal(flags.bigint, true); return info(9007199254740993n); } };
  assert.equal(await canonicalBundleRoot(logical, options), physical);
  await assert.rejects(canonicalBundleRoot(logical, { ...options, inspect: async path => info(path === logical ? 9007199254740993n : 9007199254740992n) }), /Invalid bundled runtime path/);
  await assert.rejects(canonicalBundleRoot(logical, { ...options, inspect: async () => info(0n) }), /Invalid bundled runtime path/);
});

test('unverified bundle binaries and escaping resource paths cannot be used', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-setup-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'desktop-runtime'); await mkdir(bundle);
  await writeFile(join(bundle, 'connector.exe'), 'synthetic-not-a-binary');
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, cloudflared: { file: 'connector.exe', sha256: '0'.repeat(64) } }));
  await assert.rejects(loadDesktopBundle({ resourcesPath: root, root }), /repair/);
  await assert.rejects(bundleFile(bundle, '../outside.exe'), /Invalid/);
  await assert.rejects(bundleFile(bundle, 'sub\\file.exe'), /Invalid/);
});

test('missing assistant artifacts report unavailable rather than pretend clean installation succeeded', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-runtime-status-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await createSetupRuntime({ dataDir, bundle: { root: '', manifest: null, connector: {} }, probe: async () => { throw new Error('Synthetic unavailable runtime'); } });
  assert.equal((await runtime.status()).ready, false);
  await assert.rejects(runtime.install(), error => error.code === 'RUNTIME_NOT_INCLUDED');
});

test('failed assistant verification gives repair steps without exposing diagnostics or changing saved settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-runtime-repair-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  await saveConfig(dataDir, { publicOrigin: 'https://host.example.test', port: 8998, hermesHome: join(dataDir, 'existing-assistant-home') });
  const before = await readFile(join(dataDir, 'nemo.json'), 'utf8');
  const cause = new Error('Extra unverified file at C:\\private\\assistant\\_._');
  let probes = 0;
  const runtime = await createSetupRuntime({
    dataDir, bundle: { root, manifest: { hermes: { python: 'hermes/python.exe', source: 'hermes/source' } } },
    verifyBundle: async () => { throw cause; }, probe: async () => { probes++; },
  });
  await assert.rejects(runtime.install(), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'RUNTIME_REPAIR_REQUIRED'); assert.equal(error.cause, cause);
    assert.match(error.message, /Reinstall the latest Nemo/); assert.match(error.message, /Set up my assistant again/); assert.match(error.message, /Your chats are saved/);
    assert.doesNotMatch(error.message, /private|_\._/); return true;
  });
  const status = await runtime.status();
  assert.equal(status.ready, false); assert.equal(status.state, 'repair-required'); assert.match(status.message, /Reinstall the latest Nemo/);
  assert.equal(probes, 0, 'unverified assistant files never execute');
  assert.equal(await readFile(join(dataDir, 'nemo.json'), 'utf8'), before);
  await assert.rejects(readFile(join(dataDir, 'managed-runtime.json')), { code: 'ENOENT' });
});

test('a managed runtime restoration retains repair guidance and a repaired package can be retried', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-runtime-repair-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  await mkdir(join(root, 'hermes', 'source'), { recursive: true }); await writeFile(join(root, 'hermes', 'python.exe'), 'synthetic executable');
  const python = join(root, 'hermes', 'python.exe'), source = join(root, 'hermes', 'source');
  await saveConfig(dataDir, { hermesPython: python, hermesSource: source });
  await writeFile(join(dataDir, 'managed-runtime.json'), JSON.stringify({ version: 1, python, source }));
  let valid = false, probes = 0;
  const runtime = await createSetupRuntime({
    dataDir, bundle: { root, manifest: { hermes: { python: 'hermes/python.exe', source: 'hermes/source' } } },
    verifyBundle: async () => { if (!valid) throw new Error('Synthetic inventory mismatch'); return { extras: ['mcp'] }; },
    verifyNative: async () => {}, probe: async () => { probes++; },
  });
  assert.equal((await runtime.status()).state, 'repair-required'); assert.equal(probes, 0);
  valid = true;
  assert.equal((await runtime.install()).ready, true); assert.equal((await runtime.status()).state, 'ready'); assert.equal(probes, 1);
});

test('desktop distribution includes only runtime source and production dependencies', () => {
  for (const path of ['/.nemo/profiles.json','/.work/private.json','/coordination/tasks.md','/.env','/test/fixture.mjs','/lib/auth.json','/lib/remote-cloud-service.mjs','/remote-service.mjs','/deploy/remote-service.env.example','/desktop/private.key','/README.md']) assert.equal(ignore(path), true, path);
  for (const path of ['/','/server.mjs','/lib/desktop-host.mjs','/desktop/main.cjs','/public/pair.html','/node_modules/qrcode/lib/index.js']) assert.equal(ignore(path), false, path);
});

test('clean installs use their bundle and verified app updates preserve phone settings and explicit external runtimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-managed-runtime-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  const bundles = [];
  for (const name of ['first', 'update']) {
    const dir = join(root, name); await mkdir(join(dir, 'hermes', 'source'), { recursive: true });
    await writeFile(join(dir, 'hermes', 'python.exe'), 'synthetic package executable');
    bundles.push({ root: dir, manifest: { hermes: { python: 'hermes/python.exe', source: 'hermes/source', inventorySha256: 'a'.repeat(64) } } });
  }
  const probes = [], verified = [];
  const options = { dataDir, probe: async command => { probes.push(command); }, verifyBundle: async value => { verified.push(value.root); return { verified: true, extras: ['mcp'] }; }, verifyNative: async () => {} };
  await saveConfig(dataDir, { publicOrigin: 'https://host.example.test', port: 8998 });
  const first = await createSetupRuntime({ ...options, bundle: bundles[0] });
  assert.equal((await first.status()).ready, false); assert.equal(probes.length, 0, 'a developer PATH runtime cannot stand in for a clean package');
  assert.equal((await first.install()).ready, true);
  const before = await loadConfig({ dataDir });
  const update = await createSetupRuntime({ ...options, bundle: bundles[1] });
  assert.equal((await update.status()).ready, true);
  const after = await loadConfig({ dataDir });
  assert.equal(after.hermesPython, join(bundles[1].root, 'hermes', 'python.exe'));
  assert.equal(after.hermesSource, join(bundles[1].root, 'hermes', 'source'));
  assert.equal(after.hermesHome, before.hermesHome); assert.equal(after.publicOrigin, before.publicOrigin); assert.equal(after.port, before.port);
  assert.deepEqual(verified, bundles.map(item => item.root));
  const external = { ...after, hermesPython: join(root, 'external-python.exe'), hermesSource: join(root, 'external-source') };
  await saveConfig(dataDir, Object.fromEntries(['publicOrigin','port','hermesLauncher','hermesHome','hermesPython','hermesSource'].map(key => [key, external[key]])));
  const explicit = await createSetupRuntime({ ...options, bundle: bundles[0] });
  assert.equal((await explicit.status()).ready, true); assert.equal(verified.length, 2, 'manual runtime settings must not be overwritten during an update');
  assert.equal((await loadConfig({ dataDir })).hermesPython, external.hermesPython);
});
