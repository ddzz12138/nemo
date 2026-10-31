import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesForwarder } from '../lib/hermes-forwarder.mjs';

const profileId = '11111111-1111-4111-8111-111111111111';
const paths = { pythonPath: resolve('synthetic-python'), sourceRoot: resolve('synthetic-source'), hermesHome: resolve('synthetic-host-home') };
const encode = value => JSON.stringify(value) + '\n';
function fixture(handler, timeoutMs = 1000) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.killed = false;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); let input = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) { queueMicrotask(() => handler(child, JSON.parse(input))); done(); } });
    child.kill = () => { child.killed = true; child.stdout.resume(); child.stdout.destroy(); queueMicrotask(() => child.emit('close', 0)); };
    calls.push({ command, args, options, child }); return child;
  };
  const forward = createHermesForwarder({ ...paths, spawn, timeoutMs, environment: { NEMO_MCP_DATA_DIR: 'another-profile', HERMES_TUI_TOOLSETS: 'all', HERMES_YOLO_MODE: '1' } });
  return { forward, calls };
}
const input = { profileId, path: '/v1/responses', method: 'POST', body: { input: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_MESSAGE' }], stream: true } };

test('host forwarder streams bytes with no prompt/credentials in argv and no inherited worker context', async () => {
  let received;
  const f = fixture((child, request) => { received = request; child.stdout.write(encode({ type: 'headers', status: 200, contentType: 'text/event-stream' }) + encode({ type: 'chunk', data: Buffer.from('data: synthetic\n\n').toString('base64') }) + encode({ type: 'end' })); });
  const response = await f.forward(input);
  assert.equal(await response.text(), 'data: synthetic\n\n'); assert.equal(received.profileId, profileId);
  assert.equal(f.calls[0].options.shell, false); assert.equal(JSON.stringify(f.calls[0].args).includes('SYNTHETIC_PRIVATE_MESSAGE'), false);
  assert.equal(f.calls[0].options.env.NEMO_MCP_DATA_DIR, undefined); assert.equal(f.calls[0].options.env.HERMES_YOLO_MODE, undefined);
  assert.equal(f.calls[0].options.env.HERMES_HOME, paths.hermesHome); assert.equal(f.calls[0].child.killed, true);
});

test('host forwarder redacts diagnostics and never retries a timeout or cancellation', async () => {
  const f = fixture(child => child.stdout.write(encode({ type: 'error', status: 401, code: 'SYNTHETIC_SECRET_DIAGNOSTIC' })));
  const response = await f.forward(input); assert.equal(response.status, 401); assert.equal((await response.text()).includes('SYNTHETIC_SECRET'), false);
  assert.equal(f.calls.length, 1);
  const timed = fixture(() => {}, 15); await assert.rejects(timed.forward(input), /not retried/); assert.equal(timed.calls.length, 1); assert.equal(timed.calls[0].child.killed, true);
  const aborted = fixture(() => {}); const controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.forward({ ...input, signal: controller.signal })); assert.equal(aborted.calls.length, 0);
});

test('host forwarder aborts an admitted stream and rejects malformed or excessive protocol data', async () => {
  const f = fixture(child => child.stdout.write(encode({ type: 'headers', status: 200, contentType: 'text/event-stream' })));
  const controller = new AbortController(); const response = await f.forward({ ...input, signal: controller.signal }); const text = response.text(); controller.abort();
  await assert.rejects(text, /not retried/); assert.equal(f.calls[0].child.killed, true);
  for (const value of ['null\n', 'x'.repeat(65_537)]) {
    const malformed = fixture(child => child.stdout.write(value)); await assert.rejects(malformed.forward(input)); assert.equal(malformed.calls[0].child.killed, true);
  }
  const invalid = fixture(() => {}); await assert.rejects(invalid.forward({ ...input, profileId: '../other' })); assert.equal(invalid.calls.length, 0);
});

function python() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  if (process.platform !== 'win32') return 'python3';
  const tools = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools');
  return existsSync(tools) ? readdirSync(tools).filter(name => name.startsWith('python-')).map(name => join(tools, name, 'python.exe')).find(existsSync) : null;
}
const executable = python();
test('host Python adapter enforces model/protocol/endpoint and account-free metadata boundaries', { skip: !executable }, () => {
  const result = spawnSync(executable, ['-I', '-B', fileURLToPath(new URL('./fixtures/provider-host.py', import.meta.url)), fileURLToPath(new URL('../lib/hermes_provider_host.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, credentials: 'synthetic-only', network: false });
});
