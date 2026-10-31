import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPython() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  if (process.platform !== 'win32') return 'python3';
  const runtime = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools');
  if (!existsSync(runtime)) return null;
  return readdirSync(runtime).filter(name => name.startsWith('python-'))
    .map(name => join(runtime, name, 'python.exe')).find(existsSync) || null;
}

const python = findPython();
test('Hermes MCP guard rejects provider drift, injected tools, malformed batches and exhausted budgets before execution', { skip: !python }, () => {
  const fixture = fileURLToPath(new URL('./fixtures/hermes-guard-policy.py', import.meta.url));
  const guard = fileURLToPath(new URL('../lib/hermes_guard.py', import.meta.url));
  const result = spawnSync(python, ['-I', '-B', fixture, guard], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, maxToolCalls: 6, inference: 'synthetic-only' });
});
