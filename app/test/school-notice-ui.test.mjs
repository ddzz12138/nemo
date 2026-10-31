import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url); let electron; try { electron = require('electron'); } catch {}
test('school notice renderer requires selection and consent, shows cited chat/Activity, and fits phone/tablet/desktop', { skip: typeof electron !== 'string', timeout: 60000 }, async () => {
  const parent = resolve('.work/school-ui'); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(join(parent, 'synthetic-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let result;
  try { await promisify(execFile)(electron, [resolve('test/fixtures/school-notice-ui.cjs'), directory], { env, windowsHide: true, timeout: 55000 }); }
  finally { result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')); }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.widths, [320,768,1024,1440]); assert.equal(result.localExtractions, 1); assert.equal(result.consentRequired, true);
});
