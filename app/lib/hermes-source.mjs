import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowedHermesSource } from './hermes-bundle.mjs';

export const HERMES_SOURCE_ROOT = 'vendor/hermes-source';
const metadata = new Set(['.gitattributes', 'UPSTREAM.md']);
const relativePath = value => typeof value === 'string' && value.length > 0 && !/[\\:\0\r\n]/.test(value) && !value.startsWith('/') && value.split('/').every(x => x && x !== '.' && x !== '..');
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{25,}|\bsk-[A-Za-z0-9]{25,}|\bAIza[A-Za-z0-9_-]{30,}|\b(?:[a-z0-9-]+\.)*tail[a-f0-9]{6}\.ts\.net\b/i;
const home = /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+(?:\\{1,2}|\/)/i;

export function validateHermesSourceManifest(value) {
  if (value?.version !== 1 || value.root !== HERMES_SOURCE_ROOT || !/^[a-f0-9]{40}$/.test(value.sourceRevision || '') || !Array.isArray(value.files) || !value.files.length || value.files.length > 20_000 || !Array.isArray(value.reviewedWindowsPathExamples)) throw new Error('Invalid pinned Hermes source manifest.');
  const paths = new Set();
  for (const item of value.files) {
    if (!relativePath(item.path) || !allowedHermesSource(item.path) || paths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 50_000_000) throw new Error('Invalid pinned Hermes source entry.');
    paths.add(item.path);
  }
  if (value.reviewedWindowsPathExamples.some(path => !paths.has(path))) throw new Error('Invalid reviewed source examples.');
  if (!paths.has('LICENSE') || !paths.has('pyproject.toml') || !paths.has('hermes_bootstrap.py')) throw new Error('Required Hermes source/notice missing.');
  return value;
}

/** Exact reviewed bytes allow upstream images/translations; no general binary bypass. */
export async function verifyHermesSource(appRoot, suppliedManifest) {
  const manifest = validateHermesSourceManifest(suppliedManifest || JSON.parse(await readFile(join(appRoot, 'desktop/hermes-source.json'), 'utf8')));
  const root = join(appRoot, HERMES_SOURCE_ROOT);
  for (const path of ['vendor', HERMES_SOURCE_ROOT]) if ((await lstat(join(appRoot,path))).isSymbolicLink()) throw new Error('Hermes source root cannot be a link.');
  const actual = new Set();
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error('Hermes source cannot contain links.');
      if (item.isDirectory()) await walk(join(directory, item.name), name + '/');
      else if (item.isFile()) actual.add(name);
      else throw new Error('Unsupported Hermes source input.');
    }
  }
  await walk(root);
  for (const name of metadata) {
    if (!actual.delete(name)) throw new Error('Hermes source provenance metadata missing.');
  }
  for (const item of manifest.files) {
    if (!actual.delete(item.path)) throw new Error('A pinned Hermes source file is missing.');
    const bytes = await readFile(join(root, item.path));
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Pinned Hermes source changed: ${item.path}`);
    if (bytes.includes(0)) {
      if (!/\.(?:png|ico|mo)$/.test(item.path)) throw new Error('Unexpected binary Hermes source.');
    } else {
      const text = bytes.toString('utf8');
      if (secret.test(text) || (home.test(text) && !manifest.reviewedWindowsPathExamples.includes(item.path))) throw new Error(`Unreviewed private source content: ${item.path}`);
    }
  }
  if (actual.size) throw new Error('Hermes source contains unpinned files.');
  return { verified: true, root, files: manifest.files.length, sourceRevision: manifest.sourceRevision };
}
