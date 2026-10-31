import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
let electron; try { electron = require('electron'); } catch {}
test('real renderer selects local Gemma without ChatGPT acknowledgement and fits phone/tablet/desktop', { skip: typeof electron !== 'string', timeout: 60000 }, async () => {
  const parent = resolve('.work/local-provider-ui'); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(join(parent, 'synthetic-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron, [resolve('test/fixtures/desktop-local-setup.cjs'), directory], { env, windowsHide: true, timeout: 55000 });
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result.localSelected, true); assert.equal(result.requiresChatGPTAcknowledgement, false); assert.deepEqual(result.responsiveWidths, [320, 768, 1440]);
});
