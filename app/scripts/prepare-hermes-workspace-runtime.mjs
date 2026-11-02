import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareHermesWorkspaceRuntime } from '../lib/hermes-pm-bundle.mjs';

const result = await prepareHermesWorkspaceRuntime({
  baseRoot: resolve('.work/desktop-runtime'),
  out: resolve('.work/assistant-preview-resources/desktop-runtime'),
  releaseLock: JSON.parse(await readFile(new URL('../desktop/hermes-release.json', import.meta.url), 'utf8')),
  artifactCache: resolve('.work/release-inputs'),
  onProgress: message => console.log(message),
});
const marker = resolve('.work/assistant-preview-resources/workspace-runtime-ready.json');
const pendingMarker = marker + '.pending';
await writeFile(pendingMarker, JSON.stringify({ version: 1, runtime: 'desktop-runtime', verified: true }) + '\n', { flag: 'wx' });
await rename(pendingMarker, marker);
console.log(JSON.stringify(result));
