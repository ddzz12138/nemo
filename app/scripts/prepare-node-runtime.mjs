import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f\d]{64}$/;

export function validateNodeRelease(release) {
  if (release?.version !== 1 || release.platform !== 'win32' || release.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(release.nodeVersion || '') || release.file !== 'node/node.exe' || !digestPattern.test(release.sha256 || '') || release.url !== `https://nodejs.org/dist/v${release.nodeVersion}/win-x64/node.exe` || release.checksums?.url !== `https://nodejs.org/dist/v${release.nodeVersion}/SHASUMS256.txt` || release.checksums?.entry !== 'win-x64/node.exe' || !digestPattern.test(release.checksums?.sha256 || '') || release.license?.url !== `https://raw.githubusercontent.com/nodejs/node/v${release.nodeVersion}/LICENSE` || release.license?.file !== 'node/LICENSE.txt' || !digestPattern.test(release.license?.sha256 || '')) throw new Error('Node release settings must pin official Windows x64 Node.js bytes, checksums, and license.');
  return release;
}

export function verifyNodeBytes(bytes, release) {
  validateNodeRelease(release);
  if (sha256(bytes) !== release.sha256) throw new Error('Node executable does not match the pinned official release. Nothing was installed.');
  // Avoid treating an arbitrary file with an accidental descriptor as a Windows runtime.
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('The pinned Node executable is not a Windows executable.');
  return true;
}

async function fetchPinned(url, maximum, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120000), headers: { accept: 'application/octet-stream' } });
  if (!response.ok || Number(response.headers.get('content-length')) > maximum) throw new Error('The official Node.js release could not be downloaded. Retry release preparation.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) throw new Error('The official Node.js download exceeded its expected size limit.'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

async function sourceBytes(path, url, maximum, fetchImpl) {
  if (path) {
    if (!isAbsolute(path)) throw new Error('Release source paths must be absolute.');
    const bytes = await readFile(path); if (bytes.length > maximum) throw new Error('A Node release input exceeds its expected size limit.'); return bytes;
  }
  return fetchPinned(url, maximum, fetchImpl);
}

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

/** Copy only release-verified code and notices. Never copy an installed Node folder or environment. */
export async function prepareNodeRuntime({ out = join(ROOT, '.work', 'desktop-runtime'), nodeSource, licenseSource, checksumsSource, releasePath = join(ROOT, 'desktop', 'node-release.json'), fetchImpl = fetch } = {}) {
  if (!isAbsolute(out)) throw new Error('The Node release output must be an absolute folder.');
  const release = validateNodeRelease(JSON.parse(await readFile(releasePath, 'utf8')));
  const [node, license, checksums] = await Promise.all([
    sourceBytes(nodeSource, release.url, 150000000, fetchImpl),
    sourceBytes(licenseSource, release.license.url, 1000000, fetchImpl),
    sourceBytes(checksumsSource, release.checksums.url, 65536, fetchImpl),
  ]);
  verifyNodeBytes(node, release);
  if (sha256(license) !== release.license.sha256 || sha256(checksums) !== release.checksums.sha256) throw new Error('The Node.js license or release checksum file does not match its official pin. Nothing was installed.');
  const entry = checksums.toString('utf8').split(/\r?\n/).map(line => /^([a-f\d]{64})\s+(.+)$/.exec(line)).find(match => match?.[2] === release.checksums.entry);
  if (entry?.[1] !== release.sha256) throw new Error('The pinned Node executable does not match the official release checksum list.');
  await mkdir(out, { recursive: true });
  const nodeDirectory = join(out, 'node'); await mkdir(nodeDirectory, { recursive: true });
  if ((await lstat(out)).isSymbolicLink() || (await lstat(nodeDirectory)).isSymbolicLink()) throw new Error('Node release output must not follow a symbolic link.');
  await writeAtomic(join(nodeDirectory, 'node.exe'), node);
  await writeAtomic(join(nodeDirectory, 'LICENSE.txt'), license);
  await writeAtomic(join(nodeDirectory, 'SHASUMS256.txt'), checksums);
  const manifestPath = join(out, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; manifest = { version: 1, platform: release.platform, arch: release.arch }; }
  if (manifest.version !== 1 || manifest.platform !== release.platform || manifest.arch !== release.arch) throw new Error('The existing desktop runtime manifest targets a different platform.');
  const contract = { file: release.file, sha256: release.sha256, version: release.nodeVersion };
  // Read immediately before the merge, preserving independently prepared Hermes/connector settings.
  await writeAtomic(manifestPath, JSON.stringify({ ...manifest, node: contract }, null, 2) + '\n');
  return { node: contract, executable: join(nodeDirectory, 'node.exe'), license: join(nodeDirectory, 'LICENSE.txt') };
}

export async function verifyPreparedNodeRuntime(out = join(ROOT, '.work', 'desktop-runtime')) {
  const release = validateNodeRelease(JSON.parse(await readFile(join(ROOT, 'desktop', 'node-release.json'), 'utf8')));
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  if (manifest.node?.file !== release.file || manifest.node?.sha256 !== release.sha256 || manifest.node?.version !== release.nodeVersion) throw new Error('The desktop manifest does not contain the verified Node release.');
  const executable = join(out, 'node', 'node.exe'); verifyNodeBytes(await readFile(executable), release);
  if (sha256(await readFile(join(out, 'node', 'LICENSE.txt'))) !== release.license.sha256) throw new Error('The Node.js redistribution notice is missing or changed.');
  if (process.platform === 'win32') {
    const version = await new Promise((resolveVersion, reject) => {
      const child = spawn(executable, ['--version'], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows', PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); child.on('error', reject);
      const timeout = setTimeout(() => child.kill(), 10000); timeout.unref?.();
      child.on('close', code => { clearTimeout(timeout); if (code !== 0 || output.trim() !== `v${release.nodeVersion}`) reject(new Error('The bundled Node executable did not start with an empty PATH.')); else resolveVersion(output.trim()); });
    });
    return { executable, version };
  }
  return { executable, version: `v${release.nodeVersion}`, executionSkipped: 'Windows binary verification requires Windows.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' }, node: { type: 'string' }, license: { type: 'string' }, checksums: { type: 'string' }, verify: { type: 'boolean' } }, strict: true });
    const out = values.out ? resolve(values.out) : join(ROOT, '.work', 'desktop-runtime');
    if (!values.verify) await prepareNodeRuntime({ out, nodeSource: values.node, licenseSource: values.license, checksumsSource: values.checksums });
    const verified = await verifyPreparedNodeRuntime(out);
    console.log(`Prepared pinned Node ${verified.version} for private connected tools. No installed packages, personal environment, or credentials were copied.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
