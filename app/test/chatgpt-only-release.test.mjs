import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDesktopAssistant } from '../lib/desktop-assistant.mjs';
import { createNemoServer } from '../server.mjs';
import { setupState, canOpenPersonalSpace } from '../public/desktop-setup.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'nemo-subscription-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'nemo-subscription-'))); await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); });
  return root;
}
const ready = { provider: 'chatgpt', connected: true, phase: 'connected', planUsageEnabled: true, planUsageAcknowledged: true };
function cloudFixture() {
  const calls = [], cloud = { status: () => ready, credentials: async () => ({ provider: 'chatgpt', accessToken: 'synthetic-subscription-token' }),
    begin: async input => { calls.push(input); return ready; }, retryConnection: async () => { calls.push('retry'); return ready; }, close: async () => {} };
  return { cloud, calls };
}
test('fresh public setup uses only ChatGPT and refuses forged local selection without changing data', async t => {
  const dataDir = await directory(t), f = cloudFixture(); let cloudCalls = 0, localCalls = 0;
  const assistant = await createDesktopAssistant({ dataDir, cloudFactory: async () => { cloudCalls++; return f.cloud; }, localCheck: async () => { localCalls++; throw Error('Must not contact local inference'); } });
  t.after(() => assistant.close());
  assert.equal(assistant.status().provider, 'chatgpt'); assert.equal(cloudCalls, 1);
  await assert.rejects(assistant.begin({ provider: 'local' }), /requires a ChatGPT subscription/);
  assert.equal(localCalls, 0); assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(join(dataDir, 'assistant-mode.json')), { code: 'ENOENT' });
  assert.equal((await assistant.credentials()).provider, 'chatgpt');
});
test('a legacy local choice never opens saved cloud grants until explicit ChatGPT opt-in', async t => {
  const dataDir = await directory(t), grant = 'SYNTHETIC_PROTECTED_GRANT_BYTES', f = cloudFixture(); let cloudCalls = 0, paused = 0;
  await writeFile(join(dataDir, 'assistant-mode.json'), JSON.stringify({ version: 1, provider: 'local' }));
  await writeFile(join(dataDir, 'assistant-provider.dpapi'), grant);
  await writeFile(join(dataDir, 'state.json'), 'SYNTHETIC_HISTORY_UNCHANGED');
  const assistant = await createDesktopAssistant({ dataDir, cloudFactory: async () => { cloudCalls++; return f.cloud; }, onConnectionChanging: async () => { paused++; } });
  t.after(() => assistant.close());
  assert.equal(assistant.status().provider, 'chatgpt'); assert.equal(assistant.status().connected, false);
  assert.equal(await assistant.credentials(), null); await assert.rejects(assistant.retryConnection(), /Choose Continue/);
  await assert.rejects(assistant.begin({ retry: true }), /Choose Continue/); assert.equal(cloudCalls, 0);
  await assistant.begin({ provider: 'chatgpt' }); assert.equal(cloudCalls, 1); assert.equal(paused, 1);
  assert.equal((await assistant.credentials()).provider, 'chatgpt');
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'assistant-mode.json'))), { version: 1, provider: 'chatgpt' });
  assert.equal(await readFile(join(dataDir, 'assistant-provider.dpapi'), 'utf8'), grant);
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), 'SYNTHETIC_HISTORY_UNCHANGED');
});
test('existing ChatGPT selections resume across two launches without a new sign-in', async t => {
  const dataDir = await directory(t), f = cloudFixture();
  await writeFile(join(dataDir, 'assistant-mode.json'), JSON.stringify({ version: 1, provider: 'chatgpt' }));
  for (let i = 0; i < 2; i++) {
    const assistant = await createDesktopAssistant({ dataDir, cloudFactory: async () => f.cloud });
    assert.equal(assistant.status().connected, true); assert.equal((await assistant.credentials()).accessToken, 'synthetic-subscription-token'); await assistant.close();
  }
  assert.deepEqual(f.calls, []);
});
test('completed onboarding cannot make an old local provider ready in public setup', () => {
  const status = { setupCompleted: true, owner: { configured: true }, runtime: { ready: true, connected: true }, app: { ready: true, assistantConnected: true }, assistant: { provider: 'ollama', connected: true, phase: 'connected', localOnly: true } };
  assert.equal(setupState(status), 'assistant'); assert.equal(canOpenPersonalSpace(status), false);
});
async function serverFixture(t, options = {}) {
  const dataDir = await directory(t), app = await createNemoServer({ dataDir, logger() {}, ...options });
  t.after(() => app.close()); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port, owner = await app.profiles.owner(), invite = await app.profiles.invite(owner.id);
  const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invite.code, expectedProfileId: owner.id, deviceName: 'Synthetic subscription test' }) });
  assert.equal(paired.status, 200); const cookie = paired.headers.get('set-cookie').split(';')[0];
  async function request(path, body) {
    const result = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'X-Nemo-Request': '1', 'X-Nemo-Profile': owner.id }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  }
  return { app, dataDir, owner, request };
}
test('public server pins ChatGPT and exposes no Memory/native or local-only school workflow', async t => {
  let credentialCalls = 0;
  const f = await serverFixture(t, { hermesOptions: { chatgptSession: async () => { credentialCalls++; return null; } } });
  const session = await f.request('/api/session'); assert.equal(session.status, 200); assert.equal(session.data.memoryMode, 'chat-history');
  assert.equal(session.data.inference, undefined); assert.equal(session.data.planUsage.provider, 'chatgpt'); assert.equal(session.data.connected, false);
  assert.equal((await f.request('/api/memory/board')).status, 410);
  assert.equal((await f.request('/api/native/status')).data.available, false);
  const notice = await f.request('/api/gmail/notices/search', { query: 'school' }); assert.notEqual(notice.status, 200);
  assert.equal(credentialCalls, 0);
  for (const hermesOptions of [{ localModel: { model: 'gemma4:12b' } }, { providerKey: 'synthetic-direct-api-key' }, { requireChatGPT: false }]) {
    await assert.rejects(createNemoServer({ dataDir: f.dataDir, hermesOptions }), /only a ChatGPT subscription/);
  }
});
test('deferred Memory blocks all Gmail-copy removal routes while preserving the earlier store', async t => {
  let mutations = 0;
  const f = await serverFixture(t, { provider: { status: () => ({ connected: true }), async run() { throw Error('No inference expected'); } },
    async integrationsForProfile() { return { gmail: { async status() { return { connected: true, configured: true }; }, async disconnect() { mutations++; }, async setSyncMode() { mutations++; }, async close() {} } }; } });
  const directory = f.app.profiles.directory(f.owner.id); await mkdir(join(directory, 'gbrain-data'), { recursive: true });
  const marker = join(directory, 'gbrain-data', 'synthetic-preserved.txt'); await writeFile(marker, 'SYNTHETIC_SAVED_MEMORY');
  for (const [path, body] of [['/api/gmail/disconnect', {}], ['/api/gmail/cache/clear', {}], ['/api/gmail/mode', { mode: 'demand' }]]) {
    const result = await f.request(path, body); assert.notEqual(result.status, 200, path); assert.match(result.data.error, /Memory|memory/);
  }
  assert.equal(mutations, 0); assert.equal(await readFile(marker, 'utf8'), 'SYNTHETIC_SAVED_MEMORY');
});
test('legacy CLI local and alternative-provider enable actions are rejected without creating selection files', async t => {
  const dataDir = await directory(t);
  for (const args of [['assistant', 'local'], ['preview', 'enable', 'chat_completions']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['bin/nemo.mjs', ...args], { env: { ...process.env, NEMO_DATA_DIR: dataDir }, windowsHide: true }), error => /ChatGPT subscription/.test(error.stderr));
  }
  await assert.rejects(readFile(join(dataDir, 'assistant-mode.json')), { code: 'ENOENT' });
});
