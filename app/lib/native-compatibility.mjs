import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export async function verifyNativeRuntime({ sourceRoot, manifest } = {}) {
  if (!isAbsolute(sourceRoot || '')) throw new Error('An absolute Hermes source directory is required.');
  manifest ||= JSON.parse(await readFile(new URL('./hermes-native-contract.json', import.meta.url), 'utf8'));
  if (manifest.version !== 1 || manifest.policy !== 'chat-only' || !manifest.files || Object.keys(manifest.files).length < 5) throw new Error('Native runtime compatibility has not been pinned.');
  if(manifest.managedReadFiles!==undefined&&(!manifest.managedReadFiles||typeof manifest.managedReadFiles!=='object'||Array.isArray(manifest.managedReadFiles)))throw new Error('Invalid managed-read compatibility manifest.');
  if(manifest.historyFiles!==undefined&&(!manifest.historyFiles||typeof manifest.historyFiles!=='object'||Array.isArray(manifest.historyFiles)))throw new Error('Invalid history compatibility manifest.');
  if(manifest.interactionFiles!==undefined&&(!manifest.interactionFiles||typeof manifest.interactionFiles!=='object'||Array.isArray(manifest.interactionFiles)))throw new Error('Invalid interaction compatibility manifest.');
  for (const [path, expected] of Object.entries({...manifest.files,...manifest.managedReadFiles,...manifest.historyFiles,...manifest.interactionFiles})) {
    if (!/^[a-zA-Z0-9_/-]+\.py$/.test(path) || path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid native compatibility manifest.');
    const actual = createHash('sha256').update((await readFile(join(sourceRoot, path), 'utf8')).replaceAll('\r\n', '\n')).digest('hex');
    if (actual !== expected) throw new Error('This Hermes runtime changed. Native execution needs compatibility review; the existing chat bridge is unchanged.');
  }
  return { supported: true, policy: 'chat-only', managedReads:Object.keys(manifest.managedReadFiles||{}).length>=4,managedHistory:Object.keys(manifest.historyFiles||{}).length>=6,managedInteractions:Object.keys(manifest.interactionFiles||{}).length>=6, files: Object.keys(manifest.files).length };
}
