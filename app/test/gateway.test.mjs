import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createNemoServer } from '../lib/personal-gateway.mjs';

const requestHeaders = { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' };
const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test('personal chat preserves safe ChatGPT limit recovery without leaking inference diagnostics', async t => {
  const privateText = 'PRIVATE_PROVIDER_TOKEN_AND_DIAGNOSTICS';
  const f = await fixture(t, { status: () => ({ connected: true, inferenceProvider: 'chatgpt', planUsageEnabled: true, accessToken: privateText }), async run() { throw Object.assign(new Error(privateText), { code: 'CHATGPT_USAGE_LIMIT' }); } });
  assert.equal((await f.request('/api/session')).data.planUsage, undefined);
  const cookie = await f.pair();
  const session = (await f.request('/api/session', { cookie })).data;
  assert.equal(session.planUsage.provider, 'chatgpt');
  assert.ok(!JSON.stringify(session).includes(privateText));
  const accepted = await f.chat(cookie);
  const run = await f.completed(cookie, accepted.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'CHATGPT_USAGE_LIMIT');
  assert.equal(run.manageUsageUrl, 'https://chatgpt.com/settings/usage');
  assert.ok(!JSON.stringify(run).includes(privateText));
});

test('disconnected ChatGPT preflight definitively rejects a message before creating a pending run', async t => {
  let runs = 0;
  const f = await fixture(t, { status: () => ({ connected: false, inferenceProvider: 'chatgpt', planUsageEnabled: false }), async run() { runs++; throw new Error('Must not run'); } });
  const cookie = await f.pair();
  const rejected = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Synthetic signed-out test', requestId: randomUUID() } });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.data.code, 'CHATGPT_SIGN_IN_REQUIRED');
  assert.equal(runs, 0);
  const conversation = (await f.request('/api/conversation', { cookie })).data;
  assert.equal(conversation.messages.length, 0);
  assert.equal(conversation.activeRunId, undefined);
});

async function fixture(t, provider = { status: () => ({ connected: true }), run: async () => ({ text: 'Reply from test provider', sessionId: 'hermes-test-session', model: 'test-model' }) }) {
  const tempPrefix = fileURLToPath(new URL('./.tmp-gateway-', import.meta.url));
  const root = await mkdtemp(tempPrefix);
  const dataDir = join(root, '.nemo');
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Nemo test</title>');
  await writeFile(join(root, 'private.txt'), 'private fixture data');
  let app;
  let base;
  const events = [];
  async function start() {
    app = await createNemoServer({ dataDir, publicDir, provider, pairingCode: '12345678', logger: entry => events.push(JSON.parse(entry)) });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => {
    provider.finishAll?.();
    if (app) await app.close();
    const absoluteRoot = resolve(root);
    assert.equal(dirname(absoluteRoot), dirname(resolve(tempPrefix)), 'Cleanup target must remain inside the test directory');
    assert.ok(basename(absoluteRoot).startsWith(basename(tempPrefix)), 'Cleanup target must use the generated fixture prefix');
    assert.ok(basename(absoluteRoot).length > basename(tempPrefix).length, 'Cleanup target must be an individual mkdtemp fixture');
    await rm(absoluteRoot, { recursive: true, force: true });
  });
  await start();
  async function request(path, { method = 'GET', cookie, raw, body, headers = {}, fragments } = {}) {
    const options = { method, headers: { ...(method === 'POST' ? requestHeaders : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(method === 'POST' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}) };
    // Fetch normalizes Host; exercise host validation with the actual wire header.
    const response = headers.Host || fragments ? await new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: options.headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
        res.on('error', reject);
      });
      req.on('error', reject);
      if (fragments) {
        req.setNoDelay(true);
        void (async () => {
          for (const fragment of fragments) {
            await new Promise((resolveWrite, rejectWrite) => req.write(fragment, error => error ? rejectWrite(error) : resolveWrite()));
            // Flush separate network writes so the server actually receives an
            // incomplete UTF-8 character before the following fragment arrives.
            await pause(20);
          }
          req.end();
        })().catch(error => { req.destroy(); reject(error); });
      } else req.end(options.body);
    }) : await fetch(base + path, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  }
  async function pair(headers) {
    const { response, data } = await request('/api/pair', { method: 'POST', body: { code: '12345678' }, headers });
    assert.equal(response.status, 200, JSON.stringify({ data, events }));
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function chat(cookie, message = 'Hello', requestId = randomUUID()) {
    const { response, data } = await request('/api/chat', { method: 'POST', cookie, body: { message, requestId } });
    assert.equal(response.status, 202, JSON.stringify(data));
    return data;
  }
  async function completed(cookie, runId) {
    const deadline = Date.now() + 4000;
    do {
      const { response, data } = await request(`/api/runs/${runId}`, { cookie });
      assert.equal(response.status, 200);
      if (['failed', 'completed'].includes(data.status)) return data;
      await pause();
    } while (Date.now() < deadline);
    assert.fail(`Run ${runId} did not finish`);
  }
  return { request, pair, chat, completed, dataDir, async restart(editState) {
    await app.close();
    app = null;
    if (editState) {
      const statePath = join(dataDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      editState(state);
      await writeFile(statePath, JSON.stringify(state));
    }
    await start();
  } };
}

function controlledProvider() {
  const calls = [];
  return {
    calls,
    status: () => ({ connected: true }),
    run(input) {
      return new Promise((resolve, reject) => {
        const call = { ...input, finish: (text = 'Controlled reply', sessionId = `hermes-${calls.length}`) => resolve({ text, sessionId, model: 'test' }), fail: reject };
        calls.push(call);
        input.signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
      });
    },
    finishAll() { for (const call of calls) call.finish(); },
    async waitForCalls(count) {
      const deadline = Date.now() + 4000;
      while (calls.length < count && Date.now() < deadline) await pause();
      assert.equal(calls.length, count, 'Provider invocation count');
      return calls[count - 1];
    },
  };
}

test('protected endpoints require pairing and reject arbitrary session cookies', async t => {
  const f = await fixture(t);
  for (const cookie of [undefined, 'nemo_session=untrusted', `nemo_session=${'a'.repeat(64)}`]) {
    for (const path of ['/api/conversation', `/api/runs/${randomUUID()}`]) {
      const { response, data } = await f.request(path, { cookie });
      assert.equal(response.status, 401);
      assert.equal(data.code, 'AUTH_REQUIRED');
    }
  }
  const session = await f.request('/api/session');
  assert.equal(session.data.authenticated, false);
  assert.equal((await f.request('/api/health')).response.status, 200);
});

test('pairing checks the code and sets a private strict cookie', async t => {
  const f = await fixture(t);
  const wrong = await f.request('/api/pair', { method: 'POST', body: { code: '87654321' } });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.data.code, 'PAIR_INVALID');
  assert.equal(wrong.response.headers.get('set-cookie'), null);
  const paired = await f.request('/api/pair', { method: 'POST', body: { code: '12345678' }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(paired.response.status, 200);
  const cookie = paired.response.headers.get('set-cookie');
  assert.match(cookie, /^nemo_session=[a-f0-9]{64};/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/);
  assert.match(cookie, /; Secure(?:;|$)/);
  const session = await f.request('/api/session', { cookie: cookie.split(';')[0] });
  assert.equal(session.data.authenticated, true);
});

test('chat returns provider text, persists the conversation, and restores it after restart', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const accepted = await f.chat(cookie, 'Say something from the PC');
  const run = await f.completed(cookie, accepted.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.text, 'Reply from test provider');
  const before = (await f.request('/api/conversation', { cookie })).data;
  assert.equal(before.conversationId, accepted.conversationId);
  assert.deepEqual(before.messages.map(({ role, text }) => ({ role, text })), [{ role: 'user', text: 'Say something from the PC' }, { role: 'assistant', text: 'Reply from test provider' }]);
  await f.restart();
  const after = (await f.request('/api/conversation', { cookie })).data;
  assert.deepEqual(after, before);
  assert.equal((await f.request(`/api/runs/${accepted.runId}`, { cookie })).data.status, 'completed');
  const state = JSON.parse(await readFile(join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(JSON.stringify(state).includes(cookie.split('=')[1]), false, 'Raw browser token must not be persisted');
});

test('retrying a UUID runs once and conflicting reuse is rejected', async t => {
  const provider = controlledProvider();
  const f = await fixture(t, provider);
  const cookie = await f.pair();
  const requestId = randomUUID();
  const accepted = await f.chat(cookie, 'Only once', requestId);
  const call = await provider.waitForCalls(1);
  const retry = await f.chat(cookie, 'Only once', requestId);
  assert.equal(retry.runId, accepted.runId);
  const conflict = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Different message', requestId } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.code, 'REQUEST_ID_CONFLICT');
  call.finish();
  await f.completed(cookie, accepted.runId);
  assert.equal((await f.chat(cookie, 'Only once', requestId)).runId, accepted.runId);
  assert.equal(provider.calls.length, 1);
  const conversation = (await f.request('/api/conversation', { cookie })).data;
  assert.equal(conversation.messages.length, 2);
});

test('paired browsers cannot see each other\'s runs and resume distinct Hermes sessions', async t => {
  const calls = [];
  const provider = { status: () => ({ connected: true }), async run(input) { calls.push(input); return { text: `Response ${calls.length}`, sessionId: input.sessionId || `hermes-owner-${calls.length}`, model: 'test' }; } };
  const f = await fixture(t, provider);
  const alice = await f.pair();
  const bob = await f.pair();
  const first = await f.chat(alice, 'Alice first');
  await f.completed(alice, first.runId);
  const forbidden = await f.request(`/api/runs/${first.runId}`, { cookie: bob });
  assert.equal(forbidden.response.status, 404);
  assert.equal(forbidden.data.code, 'RUN_NOT_FOUND');
  const second = await f.chat(bob, 'Bob first');
  await f.completed(bob, second.runId);
  const third = await f.chat(alice, 'Alice second');
  await f.completed(alice, third.runId);
  assert.deepEqual(calls.map(call => call.sessionId), [null, null, 'hermes-owner-1']);
  const bobConversation = (await f.request('/api/conversation', { cookie: bob })).data;
  assert.deepEqual(bobConversation.messages.map(message => message.text), ['Bob first', 'Response 2']);
});

test('shell metacharacters and Unicode remain literal provider input', async t => {
  const inputs = [];
  const provider = { status: () => ({ connected: true }), async run(input) { inputs.push(input.message); return { text: 'Literal text received', sessionId: 'literal', model: 'test' }; } };
  const f = await fixture(t, provider);
  const cookie = await f.pair();
  const message = 'Hello 世界 🐟\n"quoted" \'single\' & | < > %PATH% ^ ` $(Get-Content secret) ${value} C:\\hello\\file';
  const accepted = await f.chat(cookie, message);
  await f.completed(cookie, accepted.runId);
  assert.deepEqual(inputs, [message]);
});

test('UTF-8 characters split across HTTP chunks reach the provider unchanged', async t => {
  const inputs = [];
  const provider = { status: () => ({ connected: true }), async run(input) { inputs.push(input.message); return { text: 'Unicode received', sessionId: 'fragmented', model: 'test' }; } };
  const f = await fixture(t, provider);
  const cookie = await f.pair();
  const message = 'From iPhone: 🐟 世界 café';
  const bytes = Buffer.from(JSON.stringify({ message, requestId: randomUUID() }));
  const emojiStart = bytes.indexOf(Buffer.from('🐟'));
  assert.ok(emojiStart >= 0);
  // U+1F41F uses four bytes; split after byte one and byte three.
  const result = await f.request('/api/chat', { method: 'POST', cookie, fragments: [bytes.subarray(0, emojiStart + 1), bytes.subarray(emojiStart + 1, emojiStart + 3), bytes.subarray(emojiStart + 3)] });
  assert.equal(result.response.status, 202, JSON.stringify(result.data));
  assert.equal((await f.completed(cookie, result.data.runId)).status, 'completed');
  assert.deepEqual(inputs, [message]);
});

test('prototype names and malformed UUID request identifiers return a controlled 400', async t => {
  let calls = 0;
  const provider = { status: () => ({ connected: true }), async run() { calls++; return { text: 'Unexpected provider invocation' }; } };
  const f = await fixture(t, provider);
  const cookie = await f.pair();
  for (const requestId of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'not-a-real-uuid', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
    const result = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Reject this request identifier', requestId } });
    assert.equal(result.response.status, 400, requestId);
    assert.equal(result.data.code, 'INVALID_REQUEST_ID', requestId);
  }
  assert.equal(calls, 0);
  assert.equal((await f.request('/api/conversation', { cookie })).data.messages.length, 0);
});

test('invalid JSON, invalid fields, and oversized bodies never reach the provider', async t => {
  let calls = 0;
  const f = await fixture(t, { status: () => ({ connected: true }), async run() { calls++; return { text: 'unexpected' }; } });
  const cookie = await f.pair();
  for (const raw of ['{broken', 'null', '[]', '42', '"text"']) {
    const result = await f.request('/api/chat', { method: 'POST', cookie, raw });
    assert.equal(result.response.status, 400);
    assert.equal(result.data.code, 'INVALID_JSON');
  }
  for (const message of ['', '   ', 1, 'x'.repeat(8001), 'hello\0world']) {
    const result = await f.request('/api/chat', { method: 'POST', cookie, body: { message, requestId: randomUUID() } });
    assert.equal(result.response.status, 400);
    assert.equal(result.data.code, 'INVALID_MESSAGE');
  }
  const invalidId = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello', requestId: 'x' } });
  assert.equal(invalidId.response.status, 400);
  const oversized = await f.request('/api/chat', { method: 'POST', cookie, raw: JSON.stringify({ message: 'x'.repeat(40_000), requestId: randomUUID() }) });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.data.code, 'TOO_LARGE');
  assert.equal(calls, 0);
});

test('cross-origin, unexpected Host, and missing application headers are rejected', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const crossOrigin = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello', requestId: randomUUID() }, headers: { Origin: 'https://attacker.example' } });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.data.code, 'ORIGIN');
  const host = await f.request('/api/health', { headers: { Host: 'attacker.example' } });
  assert.equal(host.response.status, 403);
  assert.equal(host.data.code, 'HOST');
  for (const headers of [{ 'X-Nemo-Request': '' }, { 'Content-Type': 'text/plain' }]) {
    const result = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello', requestId: randomUUID() }, headers });
    assert.equal(result.response.status, 403);
    assert.equal(result.data.code, 'REQUEST_HEADERS');
  }
});

test('static routes cannot expose private state or traverse outside publicDir', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).response.status, 200);
  for (const path of ['/.nemo/state.json', '/.nemo/pairing-code.txt', '/%2e%2e%2fprivate.txt', '/%2e%2e%5cprivate.txt', '/%00', '/.git/config']) {
    const result = await f.request(path);
    assert.equal(result.response.status, 404, path);
    assert.equal(JSON.stringify(result.data).includes('12345678'), false);
    assert.equal(JSON.stringify(result.data).includes('private fixture data'), false);
  }
});

test('provider failure is visible and does not manufacture an assistant reply', async t => {
  const f = await fixture(t, { status: () => ({ connected: true }), async run() { throw new Error('Test agent is unavailable'); } });
  const cookie = await f.pair();
  const accepted = await f.chat(cookie, 'This should fail honestly');
  const run = await f.completed(cookie, accepted.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Test agent is unavailable');
  assert.equal(run.text, '');
  const conversation = (await f.request('/api/conversation', { cookie })).data;
  assert.deepEqual(conversation.messages.map(message => message.role), ['user']);
  assert.equal(conversation.activeRunId, undefined);
});

test('restart fails interrupted work and clears its active conversation marker', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const accepted = await f.chat(cookie, 'A request before restart');
  await f.completed(cookie, accepted.runId);
  await f.restart(state => {
    const run = state.runs[accepted.runId];
    run.status = 'running';
    delete run.finishedAt;
    state.sessions[run.owner].activeRunId = run.id;
    state.sessions[run.owner].messages = state.sessions[run.owner].messages.filter(message => message.role !== 'assistant');
  });
  const recovered = (await f.request(`/api/runs/${accepted.runId}`, { cookie })).data;
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /PC restarted/);
  const conversation = (await f.request('/api/conversation', { cookie })).data;
  assert.equal(conversation.activeRunId, undefined);
  assert.equal(conversation.messages.length, 1);
});
