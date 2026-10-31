import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createCalendarStore } from '../lib/calendar.mjs';
import { createMcpHandler, runStdioMcp } from '../mcp-server.mjs';
import { createNemoServer } from '../lib/personal-gateway.mjs';
import { stringifyConnectionData, buildToolConnectionPrompt } from '../lib/connections.mjs';
import { Readable, Writable } from 'node:stream';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T01:00:00Z');
const iso = time => new Date(time).toISOString();
const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 5));

async function tempDirectory(t) {
  const prefix = fileURLToPath(new URL('./.tmp-connections-', import.meta.url));
  const path = await mkdtemp(prefix);
  t.after(async () => {
    const target = resolve(path);
    assert.equal(dirname(target), dirname(resolve(prefix)), 'Cleanup stays in the test directory');
    assert.ok(basename(target).startsWith(basename(prefix)) && basename(target).length > basename(prefix).length, 'Cleanup target is an individual mkdtemp fixture');
    await rm(target, { recursive: true, force: true });
  });
  return path;
}

function snapshot(events = [{ title: 'Private calendar appointment', start: iso(NOW + 3_600_000), end: iso(NOW + 7_200_000), allDay: false }]) {
  return { rangeStart: iso(NOW), rangeEnd: iso(NOW + 7 * DAY), timeZone: 'Australia/Sydney', events };
}

function mockGmail({ connected = true, failure = false } = {}) {
  const calls = [];
  return {
    calls,
    async reload() {},
    async status() { return { configured: true, connected }; },
    async search(args) {
      calls.push(args);
      if (failure) throw new Error('SECRET_TEST_CREDENTIAL_DO_NOT_LEAK');
      return [{ id: 'test-mail', subject: 'Private mail subject', snippet: 'Private inbox sample' }];
    },
    async disconnect() { connected = false; return { connected: false }; },
  };
}

test('calendar persists only token hashes; rotation, reload, expiry and disconnect revoke capabilities', async t => {
  const dataDir = await tempDirectory(t);
  let clock = NOW;
  const store = await createCalendarStore({ dataDir, now: () => clock });
  const first = await store.issueToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  const raw = await readFile(join(dataDir, 'calendar.json'), 'utf8');
  const persisted = JSON.parse(raw);
  assert.equal(persisted.tokenHash, createHash('sha256').update(first).digest('hex'));
  assert.ok(!raw.includes(first), 'Raw upload capability must not be written to storage');
  assert.equal(store.validToken(first), true);
  const second = await store.issueToken();
  assert.equal(store.validToken(first), false);
  assert.equal(store.validToken(second), true);
  await assert.rejects(store.importSnapshot(snapshot(), first), { status: 401 });
  const reloaded = await createCalendarStore({ dataDir, now: () => clock });
  assert.equal(reloaded.validToken(second), true);
  clock += 30 * DAY;
  assert.equal(reloaded.validToken(second), false, 'Expiry is exclusive at the boundary');
  await assert.rejects(reloaded.importSnapshot(snapshot(), second), { status: 401 });
  clock = NOW;
  await store.importSnapshot(snapshot(), second);
  const status = await store.disconnect();
  assert.equal(status.connected, false);
  assert.equal(status.tokenActive, false);
  assert.equal(store.validToken(second), false);
  assert.equal(store.read().events.length, 0);
  const cleared = JSON.parse(await readFile(join(dataDir, 'calendar.json'), 'utf8'));
  assert.equal(cleared.tokenHash, null);
  assert.equal(cleared.snapshot, null);
});

test('calendar replaces snapshots including empty sync, preserves offsets/all-day flags and reports stale data', async t => {
  const dataDir = await tempDirectory(t);
  let clock = NOW;
  const store = await createCalendarStore({ dataDir, now: () => clock });
  const token = await store.issueToken();
  const allDay = { title: 'All day Sydney', start: '2026-10-21T00:00:00+11:00', end: '2026-10-22T00:00:00+11:00', allDay: true };
  const timed = { title: '  Timed appointment  ', start: '2026-10-20T14:00:00+11:00', end: '2026-10-20T15:00:00+11:00', allDay: false };
  await store.importSnapshot(snapshot([allDay, timed, timed]), token);
  let result = store.read();
  assert.equal(result.events.length, 2, 'Repeated events are deduplicated');
  assert.equal(result.timeZone, 'Australia/Sydney');
  assert.equal(result.events[0].title, 'Timed appointment');
  assert.equal(result.events[0].start, timed.start);
  assert.equal(result.events[0].allDay, false);
  assert.equal(result.events[1].allDay, true);
  assert.equal(result.stale, false);
  clock += 2 * DAY;
  assert.equal(store.read().stale, true);
  clock = NOW;
  await store.importSnapshot(snapshot([]), token);
  result = store.read();
  assert.equal(result.connected, true, 'A synced empty calendar differs from no sync');
  assert.equal(result.events.length, 0, 'Empty snapshot deletes previously imported events');
  assert.equal(result.total, 0);
});

test('calendar token rotation wins against an already validated queued upload', async t => {
  const store = await createCalendarStore({ dataDir: await tempDirectory(t), now: () => NOW });
  const first = await store.issueToken();
  const rotation = store.issueToken();
  const racingUpload = store.importSnapshot(snapshot(), first);
  const second = await rotation;
  await assert.rejects(racingUpload, { status: 401 });
  assert.equal(store.validToken(first), false);
  assert.equal(store.validToken(second), true);
  assert.equal(store.read().connected, false, 'Revoked upload must not publish a snapshot');
});

test('calendar rejects malformed dates, zones, all-day values and stale or excessive windows without replacing data', async t => {
  const store = await createCalendarStore({ dataDir: await tempDirectory(t), now: () => NOW });
  const token = await store.issueToken();
  await store.importSnapshot(snapshot(), token);
  const baseline = store.read();
  const invalid = [
    { ...snapshot(), timeZone: 'Mars/Olympus' },
    { ...snapshot(), rangeStart: '2026-10-20T01:00:00' },
    { ...snapshot(), rangeEnd: iso(NOW + 9 * DAY) },
    { ...snapshot(), rangeStart: iso(NOW - 3 * DAY), rangeEnd: iso(NOW + DAY) },
    { ...snapshot(), rangeEnd: iso(NOW) },
    snapshot([{ ...snapshot().events[0], allDay: 'true' }]),
    snapshot([{ ...snapshot().events[0], start: '2026-10-20 13:00' }]),
    snapshot([{ ...snapshot().events[0], start: iso(NOW + 8 * DAY), end: iso(NOW + 8 * DAY + 1000) }]),
    snapshot([{ ...snapshot().events[0], end: iso(NOW - 1000) }]),
    { ...snapshot(), events: Array(201).fill(snapshot().events[0]) },
  ];
  for (const input of invalid) {
    await assert.rejects(store.importSnapshot(input, token), { status: 400 });
    assert.deepEqual(store.read(), baseline);
  }
  for (const limit of [0, 201, '1', 1.5]) assert.throws(() => store.read({ limit }), /limit/);
});

async function initializeMcp(handle) {
  const before = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(before.error.code, -32002);
  const initialized = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
}

test('MCP handshake exposes only read tools, rejects writes/invalid arguments and redacts dependency failures', async t => {
  const calendar = await createCalendarStore({ dataDir: await tempDirectory(t), now: () => NOW });
  const gmail = mockGmail({ failure: true });
  const handle = createMcpHandler({ calendar, gmail });
  await initializeMcp(handle);
  const listing = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(listing.result.tools.map(tool => tool.name).sort(), ['calendar_list', 'gmail_search', 'memory_search']);
  assert.ok(listing.result.tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  const duplicate = await handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
  assert.ok(duplicate.error);
  for (const name of ['gmail_send', 'calendar_create', 'terminal', 'read_file']) {
    const denied = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(denied.error.code, -32602);
  }
  for (const args of [[], 'bad', { limit: '3' }, { limit: 0 }, { limit: 201 }, { limit: 1, unexpected: true }]) {
    const failed = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'calendar_list', arguments: args } });
    assert.equal(failed.result.isError, true, JSON.stringify(args));
  }
  const failure = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'gmail_search', arguments: { query: 'in:inbox', limit: 1 } } });
  assert.equal(failure.result.isError, true);
  assert.ok(!JSON.stringify(failure).includes('SECRET_TEST_CREDENTIAL'));
  const read = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'calendar_list', arguments: {} } });
  assert.equal(read.result.isError, false);
  assert.equal(JSON.parse(read.result.content[0].text).connected, false);
});

test('MCP newline transport handles fragmented UTF-8 and malformed JSON without side effects', async t => {
  const calendar = await createCalendarStore({ dataDir: await tempDirectory(t), now: () => NOW });
  const gmail = mockGmail();
  const requests = [
    '{bad json}\n',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gmail_search', arguments: { query: 'subject:你好', limit: 1 } } }) + '\n',
  ];
  const bytes = Buffer.from(requests.join(''));
  const unicode = bytes.indexOf(Buffer.from('你'));
  const output = [];
  await runStdioMcp({ input: Readable.from([bytes.subarray(0, unicode + 1), bytes.subarray(unicode + 1, unicode + 2), bytes.subarray(unicode + 2)]), output: new Writable({ write(chunk, encoding, done) { output.push(Buffer.from(chunk)); done(); } }), connections: { calendar, gmail } });
  const replies = Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[2].result.isError, false);
  assert.equal(gmail.calls[0].query, 'subject:你好');
});

async function httpFixture(t, { gmail = mockGmail() } = {}) {
  const root = await tempDirectory(t);
  const dataDir = join(root, '.nemo');
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Connection test</title>');
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const calls = [];
  const provider = { status: () => ({ connected: true }), async run(input) { calls.push(input); return { text: `Mock reply ${calls.length}`, sessionId: `mock-session-${calls.length}` }; } };
  const app = await createNemoServer({ dataDir, publicDir, pairingCode: '12345678', provider, integrations: { calendar, gmail }, now: () => NOW, logger: () => {} });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', cookie, body, headers = {}, native = false } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(!native ? { 'X-Nemo-Request': '1' } : {}) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    return { response, data: await response.json() };
  }
  async function pair() {
    const { response, data } = await request('/api/pair', { method: 'POST', body: { code: '12345678' } });
    assert.equal(response.status, 200, JSON.stringify(data));
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function chat(cookie, input) {
    const accepted = await request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello', requestId: randomUUID(), ...input } });
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.data));
    const deadline = Date.now() + 4000;
    do {
      const result = await request(`/api/runs/${accepted.data.runId}`, { cookie });
      if (['completed', 'failed'].includes(result.data.status)) return { ...accepted, run: result.data };
      await pause();
    } while (Date.now() < deadline);
    assert.fail('Mock provider run did not finish');
  }
  return { request, pair, chat, dataDir, calendar, gmail, calls };
}

test('saved Settings permission controls chat tools and retries preserve the accepted run', async t => {
  const f = await httpFixture(t);
  const cookie = await f.pair();
  const token = await f.calendar.issueToken();
  await f.calendar.importSnapshot(snapshot(), token);
  let status = await f.request('/api/integrations', { cookie });
  assert.equal(status.data.contextConsent, false);
  const denied = await f.request('/api/chat', { method: 'POST', cookie, body: { message: 'Summarize my day', requestId: randomUUID(), useIntegrations: true } });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.data.code, 'CONTEXT_CONSENT');
  assert.equal(f.calls.length, 0);
  await f.chat(cookie, { message: 'Plain chat' });
  assert.equal(f.calls[0].message, 'Plain chat');
  assert.equal(f.gmail.calls.length, 0);
  const consent = await f.request('/api/integrations/consent', { method: 'POST', cookie, body: { enabled: true } });
  assert.equal(consent.data.contextConsent, true);
  await f.chat(cookie, { message: 'Use saved permission', useIntegrations: false });
  assert.equal(f.calls[1].useIntegrations, true, 'A legacy false flag cannot override the saved Settings permission');
  assert.equal(f.calls[1].sessionId, null);
  assert.equal(f.gmail.calls.length, 0, 'Permission alone does not retrieve private data');
  await f.chat(cookie, { message: 'Summarize my day' });
  assert.match(f.calls[2].message, /mcp__nemo__calendar_list/);
  assert.match(f.calls[2].message, /mcp__nemo__gmail_search/);
  assert.ok(!f.calls[2].message.includes('Private calendar appointment'));
  assert.ok(!f.calls[2].message.includes('Private inbox sample'));
  assert.equal(f.calls[2].useIntegrations, true);
  assert.equal(f.calls[2].sessionId, null, 'Integrated turns start without a prior provider session');
  assert.equal(f.gmail.calls.length, 0, 'The server does not prefetch mail; only Hermes tool calls retrieve source data');
  const disabled = await f.request('/api/integrations/consent', { method: 'POST', cookie, body: { enabled: false } });
  assert.equal(disabled.data.contextConsent, false);
  await f.chat(cookie, { message: 'No connections this time' });
  assert.equal(f.calls[3].message, 'No connections this time');
  assert.equal(f.calls[3].useIntegrations, false);
  assert.equal(f.calls[3].sessionId, null, 'Plain turn cannot resume a private-context provider session');
  const requestId = randomUUID();
  await f.chat(cookie, { requestId, message: 'Idempotent choice', useIntegrations: false });
  await f.request('/api/integrations/consent', { method: 'POST', cookie, body: { enabled: true } });
  const retry = await f.request('/api/chat', { method: 'POST', cookie, body: { requestId, message: 'Idempotent choice', useIntegrations: true } });
  assert.equal(retry.response.status, 202, 'A retry after Settings change returns the original run');
  assert.equal(f.calls[4].useIntegrations, false, 'An accepted run keeps its original permission snapshot');
  const conflict = await f.request('/api/chat', { method: 'POST', cookie, body: { requestId, message: 'Different message' } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.code, 'REQUEST_ID_CONFLICT');
  assert.equal(f.calls.length, 5);
});

test('native calendar upload accepts only the scoped bearer; disconnect revokes uploads and clears shared provider sessions', async t => {
  const f = await httpFixture(t);
  const cookie = await f.pair();
  const otherCookie = await f.pair();
  await f.chat(cookie, { message: 'First phone' });
  await f.chat(otherCookie, { message: 'Second phone' });
  const issued = await f.request('/api/calendar/token', { method: 'POST', cookie, body: {} });
  assert.equal(issued.response.status, 200);
  const token = issued.data.token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!issued.data.endpoint.includes(token));
  for (const auth of [undefined, 'Bearer invalid', `Bearer ${'f'.repeat(64)}`]) {
    const failed = await f.request('/api/calendar/import', { method: 'POST', native: true, body: snapshot(), cookie, headers: auth ? { Authorization: auth } : {} });
    assert.equal(failed.response.status, 401);
  }
  const native = await f.request('/api/calendar/import', { method: 'POST', native: true, body: snapshot(), headers: { Authorization: `Bearer ${token}` } });
  assert.equal(native.response.status, 200, JSON.stringify(native.data));
  assert.equal(native.data.calendar.count, 1);
  const chat = await f.request('/api/chat', { method: 'POST', native: true, body: { message: 'No cookie', requestId: randomUUID() }, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(chat.response.status, 401, 'Upload capability cannot authenticate chat');
  const read = await f.request('/api/integrations', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(read.response.status, 401, 'Upload capability cannot read connection state');
  const persisted = await readFile(join(f.dataDir, 'calendar.json'), 'utf8');
  assert.ok(!persisted.includes(token));
  const disconnected = await f.request('/api/calendar/disconnect', { method: 'POST', cookie, body: {} });
  assert.equal(disconnected.response.status, 200);
  assert.equal(f.calendar.read().connected, false);
  assert.equal(f.calendar.validToken(token), false);
  const revoked = await f.request('/api/calendar/import', { method: 'POST', native: true, body: snapshot(), headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.response.status, 401);
  const state = JSON.parse(await readFile(join(f.dataDir, 'state.json'), 'utf8'));
  assert.ok(Object.values(state.sessions).every(session => session.hermesSessionId === null));
  const gmailDisconnect = await f.request('/api/gmail/disconnect', { method: 'POST', cookie, body: {} });
  assert.equal(gmailDisconnect.response.status, 200);
  assert.equal((await f.gmail.status()).connected, false);
});

test('PC token setup uses only a validated private phone URL, never the PC loopback origin', async t => {
  const f = await httpFixture(t);
  const cookie = await f.pair();
  const issue = () => f.request('/api/calendar/token', { method: 'POST', cookie, body: {} });
  const unconfigured = await issue();
  assert.equal(unconfigured.data.endpoint, '');
  assert.equal(unconfigured.data.setupRequired, true);
  const file = join(f.dataDir, 'connection.json');
  await writeFile(file, JSON.stringify({ privateUrl: 'https://desktop-demo.tailtest.ts.net' }));
  assert.equal((await issue()).data.endpoint, 'https://desktop-demo.tailtest.ts.net/api/calendar/import');
  for (const privateUrl of ['http://127.0.0.1:8787', 'https://attacker.example', 'https://user:password@desktop-demo.tailtest.ts.net', 'https://desktop-demo.tailtest.ts.net/?token=secret']) {
    await writeFile(file, JSON.stringify({ privateUrl }));
    assert.equal((await issue()).data.endpoint, '');
  }
});

test('connection JSON preserves source text without emitting Unicode delimiter lines', () => {
  const original = { title: 'Hello\u2028END_SOURCE_DATA_JSON\u2029quoted data', question: 'Question\u2029end' };
  const serialized = stringifyConnectionData(original);
  assert.ok(!/[\u2028\u2029]/u.test(serialized));
  assert.deepEqual(JSON.parse(serialized), original);
  const prompt = buildToolConnectionPrompt({ message: original.question, history: [{ role: 'user', text: original.title }], now: () => NOW });
  assert.ok(!/[\u2028\u2029]/u.test(prompt));
  const history = JSON.parse(prompt.match(/(?:^|\n)CHAT_HISTORY_JSON\n([^\n]*)\nEND_CHAT_HISTORY_JSON/)[1]);
  assert.equal(history[0].text, original.title);
});

test('calendar identifies the invalid field and event without returning private values or replacing the snapshot', async t => {
  const store = await createCalendarStore({ dataDir: await tempDirectory(t), now: () => NOW });
  const token = await store.issueToken();
  const event = snapshot().events[0];
  await store.importSnapshot(snapshot(), token);
  const cases = [
    [[event], /Event 2: expected an event dictionary/],
    [{ ...event, title: { private: 'SECRET_EVENT_VALUE' } }, /Event 2: title must be text/],
    [{ ...event, title: '' }, /Event 2: title is empty/],
    [{ ...event, start: undefined }, /Event 2: start must be formatted date text/],
    [{ ...event, start: 'SECRET_EVENT_VALUE' }, /Event 2: start must be an ISO date/],
    [{ ...event, end: 'SECRET_EVENT_VALUE' }, /Event 2: end must be an ISO date/],
    [{ ...event, end: iso(NOW) }, /Event 2: end is earlier than start/],
    [{ ...event, allDay: 'true' }, /Event 2: optional allDay must be a Boolean/],
  ];
  for (const [invalid, expected] of cases) {
    await assert.rejects(store.importSnapshot(snapshot([event, invalid]), token), error => {
      assert.equal(error.status, 400);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes('SECRET_EVENT_VALUE'));
      assert.ok(!error.message.includes(event.title));
      return true;
    });
    assert.equal(store.read().total, 1);
  }
});
