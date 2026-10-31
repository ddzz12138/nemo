import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createNemoServer } from '../lib/personal-gateway.mjs';
import { parseHermesLine } from '../lib/hermes.mjs';

const jsonHeaders = { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' };

function pause(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fixture(t, provider) {
  const root = await mkdtemp(fileURLToPath(new URL('./.tmp-grok-audit-', import.meta.url)));
  const dataDir = join(root, '.nemo');
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Nemo audit</title>');
  const app = await createNemoServer({
    dataDir,
    publicDir,
    provider,
    pairingCode: '12345678',
    logger: () => {},
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    provider.finishAll?.();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function request(path, { method = 'GET', cookie, body, raw, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(method === 'POST' ? jsonHeaders : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(method === 'POST' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  }

  async function pair() {
    const { response, data } = await request('/api/pair', { method: 'POST', body: { code: '12345678' } });
    assert.equal(response.status, 200, JSON.stringify(data));
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^nemo_session=[a-f0-9]{64};/);
    assert.match(cookie, /HttpOnly/);
    return cookie.split(';')[0];
  }

  return { request, pair };
}

function holdingProvider() {
  const calls = [];
  return {
    calls,
    status: () => ({ connected: true }),
    run(input) {
      return new Promise((resolve, reject) => {
        const call = {
          ...input,
          finish: (text = 'Held reply', sessionId = `hermes-${calls.length}`) => resolve({ text, sessionId, model: 'audit' }),
          fail: reject,
        };
        calls.push(call);
        input.signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
      });
    },
    finishAll() {
      for (const call of calls) call.finish();
    },
    async waitForCalls(count) {
      const deadline = Date.now() + 4000;
      while (calls.length < count && Date.now() < deadline) await pause();
      assert.equal(calls.length, count);
      return calls[count - 1];
    },
  };
}

test('unauthenticated and forged cookies cannot start a chat', async (t) => {
  let calls = 0;
  const provider = {
    status: () => ({ connected: true }),
    async run() { calls += 1; return { text: 'should not run', sessionId: 'x', model: 'audit' }; },
  };
  const f = await fixture(t, provider);
  const body = { message: 'Hello from an unpaired browser', requestId: randomUUID() };
  for (const cookie of [undefined, 'nemo_session=nope', `nemo_session=${'ab'.repeat(32)}`]) {
    const result = await f.request('/api/chat', { method: 'POST', cookie, body });
    assert.equal(result.response.status, 401);
    assert.equal(result.data.code, 'AUTH_REQUIRED');
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  const missingHeaders = await f.request('/api/chat', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'text/plain', 'X-Nemo-Request': '' },
  });
  assert.equal(missingHeaders.response.status, 401);
  assert.equal(calls, 0);
  const session = await f.request('/api/session');
  assert.equal(session.response.status, 200);
  assert.equal(session.data.authenticated, false);
});

test('sessions cannot read each other and request ids are not global', async (t) => {
  const calls = [];
  const provider = {
    status: () => ({ connected: true }),
    async run(input) {
      calls.push(input);
      return { text: `Reply ${calls.length}`, sessionId: input.sessionId || `owner-${calls.length}`, model: 'audit' };
    },
  };
  const f = await fixture(t, provider);
  const alice = await f.pair();
  const bob = await f.pair();
  const requestId = randomUUID();
  const aliceChat = await f.request('/api/chat', { method: 'POST', cookie: alice, body: { message: 'Alice only', requestId } });
  assert.equal(aliceChat.response.status, 202);
  const deadline = Date.now() + 4000;
  let aliceRun;
  do {
    aliceRun = await f.request(`/api/runs/${aliceChat.data.runId}`, { cookie: alice });
    if (aliceRun.data.status === 'completed') break;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(aliceRun.data.status, 'completed');

  const bobRun = await f.request(`/api/runs/${aliceChat.data.runId}`, { cookie: bob });
  assert.equal(bobRun.response.status, 404);
  assert.equal(bobRun.data.code, 'RUN_NOT_FOUND');
  const bobConversation = await f.request('/api/conversation', { cookie: bob });
  assert.deepEqual(bobConversation.data.messages, []);
  const aliceConversation = await f.request('/api/conversation', { cookie: alice });
  assert.equal(aliceConversation.data.messages.some((message) => message.text === 'Alice only'), true);
  assert.equal(JSON.stringify(bobConversation.data).includes('Alice only'), false);

  const bobChat = await f.request('/api/chat', { method: 'POST', cookie: bob, body: { message: 'Bob uses the same id', requestId } });
  assert.equal(bobChat.response.status, 202);
  assert.notEqual(bobChat.data.runId, aliceChat.data.runId);
  const secondDeadline = Date.now() + 4000;
  while (calls.length < 2 && Date.now() < secondDeadline) await pause();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message, 'Bob uses the same id');
  assert.equal(calls[1].sessionId, null);
});

test('malformed and oversized chat bodies never reach the provider', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    status: () => ({ connected: true }),
    async run() { calls += 1; return { text: 'unexpected', sessionId: 'x', model: 'audit' }; },
  });
  const cookie = await f.pair();
  const badJson = await f.request('/api/chat', { method: 'POST', cookie, raw: '{not json' });
  assert.equal(badJson.response.status, 400);
  assert.equal(badJson.data.code, 'INVALID_JSON');
  const badType = await f.request('/api/chat', {
    method: 'POST',
    cookie,
    body: { message: 'Hello', requestId: randomUUID() },
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(badType.response.status, 403);
  assert.equal(badType.data.code, 'REQUEST_HEADERS');
  const tooLong = await f.request('/api/chat', {
    method: 'POST',
    cookie,
    body: { message: 'x'.repeat(8001), requestId: randomUUID() },
  });
  assert.equal(tooLong.response.status, 400);
  assert.equal(tooLong.data.code, 'INVALID_MESSAGE');
  const tooBig = await f.request('/api/chat', {
    method: 'POST',
    cookie,
    raw: JSON.stringify({ message: 'x'.repeat(40_000), requestId: randomUUID() }),
  });
  assert.equal(tooBig.response.status, 413);
  assert.equal(tooBig.data.code, 'TOO_LARGE');
  assert.equal(calls, 0);
  const conversation = await f.request('/api/conversation', { cookie });
  assert.deepEqual(conversation.data.messages, []);
});

test('a dropped poll can resume the same run and a duplicate request does not execute twice', async (t) => {
  const provider = holdingProvider();
  const f = await fixture(t, provider);
  const cookie = await f.pair();
  const requestId = randomUUID();
  const accepted = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Stay on the PC', requestId } });
  assert.equal(accepted.response.status, 202);
  const call = await provider.waitForCalls(1);
  const during = await f.request('/api/conversation', { cookie });
  assert.equal(during.data.activeRunId, accepted.data.runId);
  const queued = await f.request(`/api/runs/${accepted.data.runId}`, { cookie });
  assert.equal(queued.response.status, 200);
  assert.ok(['queued', 'running'].includes(queued.data.status));
  const retry = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Stay on the PC', requestId } });
  assert.equal(retry.response.status, 202);
  assert.equal(retry.data.runId, accepted.data.runId);
  assert.equal(provider.calls.length, 1);
  call.finish('Recovered after reconnect', 'hermes-reconnect');
  const deadline = Date.now() + 4000;
  let done;
  do {
    done = await f.request(`/api/runs/${accepted.data.runId}`, { cookie });
    if (done.data.status === 'completed') break;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.text, 'Recovered after reconnect');
  assert.equal(done.data.error, undefined);
  const after = await f.request('/api/conversation', { cookie });
  assert.equal(after.data.activeRunId, undefined);
  assert.deepEqual(after.data.messages.map((message) => message.text), ['Stay on the PC', 'Recovered after reconnect']);
});

test('provider failure stays failed and does not become an assistant reply', async (t) => {
  const f = await fixture(t, {
    status: () => ({ connected: true }),
    async run(input) {
      input.onText('This partial text is not a completed reply.');
      throw new Error('Hermes stopped before a final reply.');
    },
  });
  const cookie = await f.pair();
  const accepted = await f.request('/api/chat', {
    method: 'POST',
    cookie,
    body: { message: 'Please fail honestly', requestId: randomUUID() },
  });
  assert.equal(accepted.response.status, 202);
  const deadline = Date.now() + 4000;
  let run;
  do {
    run = await f.request(`/api/runs/${accepted.data.runId}`, { cookie });
    if (['failed', 'completed'].includes(run.data.status)) break;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(run.data.status, 'failed');
  assert.match(run.data.error, /Hermes stopped/);
  const conversation = await f.request('/api/conversation', { cookie });
  assert.deepEqual(conversation.data.messages.map((message) => message.role), ['user']);
  assert.equal(conversation.data.activeRunId, undefined);
  assert.equal(JSON.stringify(conversation.data.messages).includes('partial text'), false);
});

test('an empty provider result and a disconnected provider are failures, not replies', async (t) => {
  let calls = 0;
  const empty = await fixture(t, {
    status: () => ({ connected: true }),
    async run() {
      calls += 1;
      return { text: '   ', sessionId: 'blank', model: 'audit' };
    },
  });
  const cookie = await empty.pair();
  const accepted = await empty.request('/api/chat', {
    method: 'POST',
    cookie,
    body: { message: 'Need a real reply', requestId: randomUUID() },
  });
  const deadline = Date.now() + 4000;
  let run;
  do {
    run = await empty.request(`/api/runs/${accepted.data.runId}`, { cookie });
    if (['failed', 'completed'].includes(run.data.status)) break;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(run.data.status, 'failed');
  assert.match(run.data.error, /no text/);
  assert.equal((await empty.request('/api/conversation', { cookie })).data.messages.some((message) => message.role === 'assistant'), false);

  const offline = await fixture(t, {
    status: () => ({ connected: false }),
    async run() { calls += 1; return { text: 'offline echo', sessionId: 'x', model: 'audit' }; },
  });
  const offlineCookie = await offline.pair();
  const rejected = await offline.request('/api/chat', {
    method: 'POST',
    cookie: offlineCookie,
    body: { message: 'Should not run', requestId: randomUUID() },
  });
  assert.equal(rejected.response.status, 503);
  assert.equal(rejected.data.code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await offline.request('/api/conversation', { cookie: offlineCookie })).data.messages.length, 0);
  assert.equal(calls, 1);
});

test('milestone adapter keeps the prompt on stdin and does not enable a real toolset', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/hermes.mjs', import.meta.url)), 'utf8');
  assert.match(source, /--query-file',\s*'-'/);
  assert.match(source, /--toolsets',\s*'none'/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /stdin\.end\(message/);
  assert.match(source, /delete env\.HERMES_YOLO_MODE/);
  assert.doesNotMatch(source, /--oneshot|HERMES_YOLO_MODE\s*=|shell:\s*true/);
  assert.equal(parseHermesLine('{"type":"result","exit_code":0,"text":"ok","session_id":"abc"}').type, 'result');
  assert.equal(parseHermesLine('not-json'), null);
  assert.equal(parseHermesLine('{"type":"tool_use","name":"terminal"}').type, 'tool_use');
});
