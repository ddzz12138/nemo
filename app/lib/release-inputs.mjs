import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, mkdtemp, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function artifact(value, python = false) {
  if (!value || !/^[\w.+-]+$/.test(value.file || '') || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 100_000_000) throw new Error('Invalid pinned runtime artifact.');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || decodeURIComponent(url.pathname.split('/').at(-1)) !== value.file) throw new Error('Invalid runtime artifact URL.');
  if (python ? (url.hostname !== 'github.com' || !url.pathname.startsWith('/astral-sh/python-build-standalone/releases/download/') || !/^cpython-3\.14\.\d+\+\d{8}-x86_64-pc-windows-msvc-install_only_stripped\.tar\.gz$/.test(value.file)) : (url.hostname !== 'files.pythonhosted.org' || !url.pathname.startsWith('/packages/') || !value.file.endsWith('.whl'))) throw new Error('Unexpected runtime artifact origin/platform.');
  return value;
}

export function validateReleaseInputs(value) {
  if (value?.version !== 1 || value.platform !== 'win32' || value.arch !== 'x64' || !/^3\.14\.\d+$/.test(value.pythonVersion || '') || !Array.isArray(value.packages) || !value.packages.length || value.packages.length > 300) throw new Error('Invalid Windows runtime input lock.');
  artifact(value.python, true);
  if (!value.python.file.startsWith('cpython-' + value.pythonVersion + '+')) throw new Error('Python artifact/version mismatch.');
  const names = new Set(), files = new Set([value.python.file]);
  for (const item of value.packages) {
    artifact(item);
    const name = String(item.name || '').toLowerCase().replace(/[-_.]+/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/.test(item.version || '') || names.has(name) || files.has(item.file) || item.file.split('-')[0].toLowerCase().replace(/[-_.]+/g,'-') !== name || item.file.split('-')[1] !== item.version) throw new Error('Invalid/duplicate pinned wheel.');
    names.add(name); files.add(item.file);
  }
  return value;
}

/** A cache hit is accepted only after the same size/hash check as a new download. */
export async function downloadPinnedArtifact(input, directory, { fetchImpl = fetch, python = false } = {}) {
  artifact(input, python);
  if (!isAbsolute(directory)) throw new Error('Build input directory must be absolute.');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Runtime artifact cache cannot be a link.');
  const path = join(directory, input.file);
  let bytes;
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Runtime artifact cannot be a link.'); bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const check = buffer => buffer.length === input.bytes && sha(buffer) === input.sha256;
  if (bytes) {
    if (!check(bytes)) throw new Error('Cached runtime artifact failed its pin.');
    return path;
  }
  const response = await fetchImpl(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > input.bytes) throw new Error('Pinned runtime artifact download failed.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > input.bytes) throw new Error('Runtime artifact exceeded its pinned size.');
    chunks.push(Buffer.from(chunk));
  }
  bytes = Buffer.concat(chunks);
  if (!check(bytes)) throw new Error('Downloaded runtime artifact failed its pin.');
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return path;
}

export async function prepareReleaseInputs({ lock, cache, fetchImpl = fetch, run = execute }) {
  validateReleaseInputs(lock);
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isAbsolute(cache)) throw new Error('Runtime preparation requires Windows x64 and an absolute build directory.');
  const inputs = [lock.python, ...lock.packages]; let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) { const index = next++; if (index >= inputs.length) break; await downloadPinnedArtifact(inputs[index], cache, { fetchImpl, python: index === 0 }); }
  }));
  // Only archives are cached. Never reuse an extracted interpreter or installed
  // dependency tree: a changed cache must not execute before verification.
  const work = await mkdtemp(join(cache, 'prepared-'));
  const archive = join(cache, lock.python.file);
  const command = (file, args, options = {}) => run(file, args, { windowsHide: true, timeout: 180_000, maxBuffer: 8_000_000, ...options });
  const listing = await command('tar', ['-tf', archive]);
  const members = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (!members.length || members.some(name => !name.startsWith('python/') || name.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/.test(name))) throw new Error('Unsafe pinned Python archive members.');
  await command('tar', ['-xf', archive, '-C', work]);
  const pythonRoot = join(work, 'python'), python = join(pythonRoot, 'python.exe');
  const version = await command(python, ['-I', '-B', '--version']);
  if (version.stdout.trim() !== 'Python ' + lock.pythonVersion) throw new Error('Prepared Python version differs from its pin.');
  const requirements = join(work, 'requirements.txt'), sitePackages = join(work, 'site-packages');
  await writeFile(requirements, lock.packages.map(item => `${item.name}==${item.version} --hash=sha256:${item.sha256}`).join('\n') + '\n');
  await command(python, ['-I', '-B', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-cache-dir', 'install', '--no-index', '--only-binary=:all:', '--no-deps', '--no-compile', '--require-hashes', '--find-links', cache, '--target', sitePackages, '-r', requirements]);
  return { pythonRoot, sitePackages, python, packages: lock.packages.length };
}
