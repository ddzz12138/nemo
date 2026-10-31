import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startNativeChatWorker } from '../lib/native-worker.mjs';
import { verifyNativeRuntime } from '../lib/native-compatibility.mjs';

test('native chat homes inherit no host secrets, history, MCP settings or runtime profile', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-native-worker-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const profile = { id: randomUUID(), role: 'member', childMode: true }; let child, launch;
  const worker = await startNativeChatWorker({ dataDir, profile, pythonPath: resolve('fixture-python'), sourceRoot: resolve('fixture-source'), brokerUrl: 'http://127.0.0.1:12345/v1', brokerGrant: 'a'.repeat(64), model: 'synthetic', apiMode: 'chat_completions', environment: { PATH: 'fixture-path', OPENAI_API_KEY: 'HOST_PRIVATE', HERMES_HOME: 'OTHER_PROFILE', ANTHROPIC_API_KEY: 'OTHER_SECRET', NEMO_MCP_DATA_DIR: 'OTHER_PROFILE' }, verifyRuntime: async () => ({ supported: true, policy: 'chat-only' }), spawn(command, args, options) {
    launch = { command, args, options }; child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {queueMicrotask(()=>child.emit('close',0));};
    queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'synthetic' } } }) + '\n')); return child;
  } });
  t.after(() => worker.close());
  assert.equal(launch.options.env.OPENAI_API_KEY, undefined); assert.equal(launch.options.env.ANTHROPIC_API_KEY, undefined); assert.equal(launch.options.env.NEMO_MCP_DATA_DIR, undefined);
  assert.equal(launch.options.env.HERMES_HOME, worker.home); assert.equal(launch.options.env.HOME, worker.home); assert.equal(launch.options.env.NEMO_CHILD_POLICY, 'child-v1');
  assert.equal(launch.options.shell, false); assert.equal(JSON.stringify(launch.args).includes('a'.repeat(64)), false);
  const config = JSON.parse(await readFile(join(worker.home, 'config.yaml'))); assert.equal(config.model.base_url, 'http://127.0.0.1:12345/v1'); assert.deepEqual(config.mcp_servers, {}); assert.deepEqual(config.dashboard, {turn_isolation:false});
  assert.equal(config.model.api_key, 'a'.repeat(64)); assert.equal(JSON.stringify(config).includes('HOST_PRIVATE'), false);
  assert.deepEqual(config.auxiliary, {title_generation:{enabled:false}});
  assert.equal(config.agent.environment_probe, false);
  assert.equal(launch.options.env.PYTHONDONTWRITEBYTECODE, '1');
  const base = { dataDir, profile, pythonPath: resolve('fixture-python'), sourceRoot: resolve('fixture-source'), brokerGrant: 'a'.repeat(64), model: 'synthetic', apiMode: 'chat_completions' };
  await assert.rejects(startNativeChatWorker({ ...base, brokerUrl: 'https://external.example/v1' }), /loopback/);
});

test('native compatibility pins fail closed on source drift, traversal and unsupported policy', async t => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'nemo-contract-')); t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const files = {}; for (let i = 0; i < 5; i++) { const name = `module_${i}.py`; await writeFile(join(sourceRoot, name), 'x = 1\r\n'); files[name] = createHash('sha256').update('x = 1\n').digest('hex'); }
  const manifest = { version: 1, policy: 'chat-only', files };
  assert.equal((await verifyNativeRuntime({ sourceRoot, manifest })).supported, true);
  await assert.rejects(verifyNativeRuntime({ sourceRoot, manifest: { ...manifest, policy: 'all' } }), /pinned/);
  await assert.rejects(verifyNativeRuntime({ sourceRoot, manifest: { ...manifest, files: { ...files, '../escape.py': 'a'.repeat(64) } } }), /manifest/);
  await writeFile(join(sourceRoot, 'module_0.py'), 'x = 2\n'); await assert.rejects(verifyNativeRuntime({ sourceRoot, manifest }), /changed/);
});

function python() { if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON; if (process.platform !== 'win32') return 'python3'; const root = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools'); return existsSync(root) ? readdirSync(root).filter(name => name.startsWith('python-')).map(name => join(root, name, 'python.exe')).find(existsSync) : null; }
const executable = python();
test('native worker permits only its broker while preserving asyncio socket pairs and captured policy proofs', { skip: !executable }, () => {
  const result = spawnSync(executable, ['-I', '-B', fileURLToPath(new URL('./fixtures/native-network.py', import.meta.url)), fileURLToPath(new URL('../lib/native_worker.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, network: 'synthetic-broker-only', socketpair: true, proofChannel: true });
});
