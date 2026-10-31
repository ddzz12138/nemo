import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalendarStore } from '../lib/calendar.mjs';
import { buildToolConnectionPrompt, connectionTools, createConnectionToolRunner } from '../lib/connections.mjs';
import { GMAIL_SCOPE, GmailError, createGmailClient } from '../lib/gmail.mjs';
import { createMcpHandler } from '../mcp-server.mjs';

const NOW = Date.parse('2026-10-20T01:00:00.000Z');
const CLIENT_ID = '1234567890-grok-paging.apps.googleusercontent.com';
const ACCESS = 'fixture-access-token';
const REFRESH = 'fixture-refresh-token';
const RAW_PAGE = 'google-page-token-must-stay-local';
const WINDOW = {
  rangeStart: '2026-10-20T08:00:00+11:00',
  rangeEnd: '2026-10-21T08:00:00+11:00',
  timeZone: 'Australia/Sydney',
};

function findPython() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  const toolsDir = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools');
  if (!existsSync(toolsDir)) return null;
  return readdirSync(toolsDir).filter(name => name.startsWith('python-'))
    .map(name => join(toolsDir, name, 'python.exe')).find(existsSync) || null;
}

async function tempDirectory(t) {
  const prefix = fileURLToPath(new URL('./.tmp-grok-paging-', import.meta.url));
  const path = await mkdtemp(prefix);
  t.after(async () => {
    const target = resolve(path);
    assert.equal(dirname(target), dirname(resolve(prefix)));
    assert.ok(basename(target).startsWith(basename(prefix)) && basename(target).length > basename(prefix).length);
    await rm(target, { recursive: true, force: true });
  });
  return path;
}

function event(title, start, end) {
  return { title, start, end, allDay: false, notes: 'PRIVATE_NOTE', location: 'PRIVATE_PLACE' };
}

async function calendarFixture(t, events, now = () => NOW) {
  const dataDir = join(await tempDirectory(t), 'data');
  await mkdir(dataDir);
  const calendar = await createCalendarStore({ dataDir, now });
  const token = await calendar.issueToken();
  await calendar.importSnapshot({ ...WINDOW, events }, token);
  return { calendar, token, dataDir };
}

function mailFixture() {
  const calls = [];
  let connected = true;
  const gmail = {
    calls,
    disconnect() { connected = false; },
    reconnect() { connected = true; },
    async searchPage(input) {
      if (!connected) throw new Error('Connect Gmail first');
      calls.push(structuredClone(input));
      if (input.pageToken) {
        return { messages: [{ id: 'm11', from: 'Ada', subject: 'Confirmation', date: 'Date', snippet: 'Code 4412', body: 'SECRET_BODY', accessToken: ACCESS }], nextPageToken: null, hasMore: false, resultSizeEstimate: 11 };
      }
      return {
        messages: Array.from({ length: input.limit }, (_, index) => ({ id: `m${index + 1}`, from: 'Ada', subject: 'Other', date: 'Date', snippet: 'Earlier', body: 'SECRET_BODY' })),
        nextPageToken: RAW_PAGE, hasMore: true, resultSizeEstimate: 11,
      };
    },
  };
  return { gmail, calls };
}

test('Node and Python schemas agree on the read tools, with cursor exclusivity enforced before dispatch', { skip: !findPython() }, () => {
  const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("grok_schema", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
cases = [
  ("empty", "mcp__nemo__gmail_search", {}),
  ("limit-only", "mcp__nemo__gmail_search", {"limit": 5}),
  ("cursor-and-query", "mcp__nemo__gmail_search", {"query": "subject:flight", "cursor": "a" * 64}),
  ("cursor-and-limit", "mcp__nemo__gmail_search", {"cursor": "ab" * 32, "limit": 10}),
  ("cursor", "mcp__nemo__gmail_search", {"cursor": "ab" * 32}),
  ("query", "mcp__nemo__gmail_search", {"query": "subject:flight", "limit": 10}),
  ("feb31", "mcp__nemo__calendar_list", {"start": "2026-02-31T00:00:00+11:00"}),
  ("hour24", "mcp__nemo__calendar_list", {"start": "2026-10-21T24:00:00+11:00"}),
  ("calendar", "mcp__nemo__calendar_list", {"limit": 20, "titleContains": "Focus"}),
  ("memory-empty", "mcp__nemo__memory_search", {}),
  ("memory-query", "mcp__nemo__memory_search", {"query": "flight note", "limit": 5}),
  ("memory-cursor", "mcp__nemo__memory_search", {"query": "flight note", "cursor": "ab" * 32}),
]
outcomes = []
for label, name, arguments in cases:
    try:
        guard.validate_tool_arguments(name, arguments)
        outcomes.append([label, "allow"])
    except guard.ToolPolicyError:
        outcomes.append([label, "deny"])
print(json.dumps({"parameters": guard._PARAMETERS, "mcp": guard._MCP_PARAMETERS, "maxToolCalls": guard.MAX_TOOL_CALLS, "outcomes": outcomes}))
`;
  const result = spawnSync(findPython(), ['-I', '-B', '-c', script, fileURLToPath(new URL('../lib/hermes_guard.py', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const dumped = JSON.parse(result.stdout);
  assert.equal(dumped.maxToolCalls, 6);
  const node = Object.fromEntries(connectionTools.map(tool => [tool.name, tool.inputSchema]));
  assert.deepEqual(node.calendar_list.properties, dumped.parameters['mcp__nemo__calendar_list'].properties);
  assert.deepEqual(node.gmail_search.properties, dumped.mcp['mcp__nemo__gmail_search'].properties);
  assert.deepEqual(node.gmail_search.anyOf, [{ required: ['query'] }, { required: ['cursor'] }]);
  assert.deepEqual(dumped.mcp['mcp__nemo__gmail_search'].anyOf, node.gmail_search.anyOf);
  assert.equal(Object.hasOwn(dumped.parameters['mcp__nemo__gmail_search'], 'anyOf'), false);
  assert.equal(node.calendar_list.additionalProperties, false);
  assert.equal(node.gmail_search.additionalProperties, false);
  assert.deepEqual(node.memory_search.properties, dumped.parameters['mcp__nemo__memory_search'].properties);
  assert.deepEqual(node.memory_search.properties, dumped.mcp['mcp__nemo__memory_search'].properties);
  assert.deepEqual(node.memory_search.required, ['query']);
  assert.equal(node.memory_search.additionalProperties, false);
  assert.deepEqual(dumped.outcomes, [
    ['empty', 'deny'], ['limit-only', 'deny'], ['cursor-and-query', 'deny'], ['cursor-and-limit', 'deny'],
    ['cursor', 'allow'], ['query', 'allow'], ['feb31', 'deny'], ['hour24', 'deny'], ['calendar', 'allow'],
    ['memory-empty', 'deny'], ['memory-query', 'allow'], ['memory-cursor', 'deny'],
  ]);
});

test('calendar selection defaults to 20, reuses a matching revision, and invalidates it on replace or disconnect', async t => {
  const events = [
    event('Early', '2026-10-20T10:00:00+11:00', '2026-10-20T11:00:00+11:00'),
    event('Boundary', '2026-10-20T11:00:00+11:00', '2026-10-20T12:00:00+11:00'),
    ...Array.from({ length: 21 }, (_, index) => event(`Later ${index}`, '2026-10-20T13:00:00+11:00', '2026-10-20T13:15:00+11:00')),
  ];
  const { calendar, token } = await calendarFixture(t, events);
  const selected = calendar.read({});
  assert.equal(selected.returnedCount, 20);
  assert.equal(selected.matchedCount > 20, true);
  assert.equal(selected.hasMore, true);
  assert.equal(selected.unchanged, false);
  assert.equal(selected.events.length, 20);
  assert.equal(selected.events.some(item => item.notes || item.location), false);
  assert.equal(selected.coverage.complete, true);

  const morning = calendar.read({ start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00' });
  assert.deepEqual(morning.events.map(item => item.title), ['Early']);
  assert.equal(morning.events[0].start, '2026-10-20T10:00:00+11:00');
  const nextHour = calendar.read({ start: '2026-10-20T11:00:00+11:00', end: '2026-10-20T12:00:00+11:00', titleContains: 'BOUND' });
  assert.deepEqual(nextHour.events.map(item => item.title), ['Boundary']);

  const again = calendar.read({ ifRevision: morning.revision, start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00' });
  assert.equal(again.unchanged, true);
  assert.equal(again.returnedCount, 0);
  assert.equal(Object.hasOwn(again, 'events'), false);
  assert.equal(JSON.stringify(again).includes('Early'), false);
  const fresh = calendar.read({ start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00' });
  assert.equal(fresh.unchanged, false);
  assert.deepEqual(fresh.events.map(item => item.title), ['Early']);
  const narrower = calendar.read({ ifRevision: morning.revision, start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00', limit: 1 });
  assert.equal(narrower.unchanged, false);
  assert.equal(narrower.events[0].title, 'Early');

  await calendar.importSnapshot({ ...WINDOW, events }, token);
  const resynced = calendar.read({ ifRevision: morning.revision, start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00' });
  assert.equal(resynced.unchanged, false);
  assert.equal(resynced.events[0].title, 'Early');

  await calendar.importSnapshot({ ...WINDOW, events: [events[0], events[0]] }, token);
  assert.equal(calendar.read({}).total, 1);
  const replaced = calendar.read({ ifRevision: morning.revision, start: '2026-10-20T10:00:00+11:00', end: '2026-10-20T11:00:00+11:00' });
  assert.equal(replaced.unchanged, false);
  assert.equal(replaced.events[0].title, 'Early');
  assert.equal(JSON.stringify(replaced).includes('Boundary'), false);

  await calendar.disconnect();
  const gone = calendar.read({ ifRevision: replaced.revision });
  assert.equal(gone.connected, false);
  assert.equal(gone.unchanged, false);
  assert.deepEqual(gone.events, []);
  assert.equal(JSON.stringify(gone).includes('Early'), false);
  assert.throws(() => calendar.read({ start: '2026-02-31T00:00:00+11:00' }));
  assert.throws(() => calendar.read({ start: '2026-10-21T24:00:00+11:00' }));
});

test('a stale snapshot invalidates a conditional revision and still returns the selected event', async t => {
  let clock = NOW;
  const { calendar } = await calendarFixture(t, [event('Early', '2026-10-20T13:00:00+11:00', '2026-10-20T14:00:00+11:00')], () => clock);
  const args = { start: '2026-10-20T13:00:00+11:00', end: '2026-10-20T14:00:00+11:00' };
  const first = calendar.read(args);
  assert.equal(first.stale, false);
  assert.equal(calendar.read({ ...args, ifRevision: first.revision }).unchanged, true);
  clock = NOW + 86_400_000 + 1;
  const stale = calendar.read({ ...args, ifRevision: first.revision });
  assert.equal(stale.stale, true);
  assert.equal(stale.unchanged, false);
  assert.equal(stale.coverage.complete, false);
  assert.equal(stale.coverage.reason, 'stale_snapshot');
  assert.equal(stale.events[0].title, 'Early');
  assert.equal(stale.events[0].start, '2026-10-20T13:00:00+11:00');
});

test('Gmail continuation is cursor-only, session-local, and does not retain a page after disconnect', async () => {
  const f = mailFixture();
  let clock = 1_000;
  const runner = createConnectionToolRunner(f, { now: () => clock, cursorTtlMs: 600_000 });
  await assert.rejects(runner('gmail_search', {}));
  await assert.rejects(runner('gmail_search', { limit: 10 }));
  await assert.rejects(runner('gmail_search', { query: 'in:inbox newer_than:7d', cursor: 'ab'.repeat(32) }));
  assert.equal(f.calls.length, 0);

  const first = await runner('gmail_search', { query: ' subject:flight ', limit: 10 });
  assert.equal(first.returnedCount, 10);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes(RAW_PAGE), false);
  assert.equal(JSON.stringify(first).includes('SECRET_BODY'), false);
  assert.equal(JSON.stringify(first).includes(ACCESS), false);
  const second = await runner('gmail_search', { cursor: first.nextCursor });
  assert.equal(second.messages[0].id, 'm11');
  assert.equal(second.messages[0].snippet, 'Code 4412');
  assert.equal(second.hasMore, false);
  assert.equal(second.query, 'subject:flight');
  assert.equal(second.pageSize, 10);
  assert.deepEqual(Object.keys(second.messages[0]).sort(), ['date', 'from', 'id', 'snippet', 'subject']);
  assert.equal(JSON.stringify(second).includes(RAW_PAGE), false);
  assert.equal(JSON.stringify(second).includes('SECRET_BODY'), false);
  const replay = await runner('gmail_search', { cursor: first.nextCursor });
  assert.equal(replay.messages[0].id, 'm11');
  assert.equal(f.calls.at(-1).pageToken, RAW_PAGE);
  assert.equal(f.calls.at(-1).query, 'subject:flight');

  await assert.rejects(createConnectionToolRunner(f)('gmail_search', { cursor: first.nextCursor }));
  const other = createMcpHandler(f);
  await other({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await other({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const foreign = await other({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gmail_search', arguments: { cursor: first.nextCursor } } });
  assert.equal(foreign.result.isError, true);
  assert.equal(JSON.stringify(foreign).includes(RAW_PAGE), false);

  f.gmail.disconnect();
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), /Connect Gmail/);
  f.gmail.reconnect();
  const after = await runner('gmail_search', { cursor: first.nextCursor });
  assert.equal(after.messages[0].id, 'm11');
  clock = 1_000 + 600_000;
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), /expired/);
  assert.equal(f.calls.every(call => call.query === 'subject:flight' && call.limit === 10), true);
});

test('the legacy Gmail adapter still has a direct default, and the tool prompt tells the model to disclose a partial search', async t => {
  const dataDir = join(await tempDirectory(t), 'data');
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'google-client.json'), JSON.stringify({ installed: { client_id: CLIENT_ID } }));
  const urls = [];
  const client = await createGmailClient({
    dataDir,
    secretStore: { async load() { return { version: 1, clientId: CLIENT_ID, scope: GMAIL_SCOPE, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_600_000 }; }, async save() {}, async remove() {} },
    now: () => NOW,
    fetchImpl: async url => {
      urls.push(String(url));
      assert.equal(String(url).includes(ACCESS), false);
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const messages = await client.search({});
  assert.deepEqual(messages, []);
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'in:inbox newer_than:7d');
  const runner = createConnectionToolRunner({ gmail: { async searchPage() { throw new Error('tool boundary called the adapter'); } } });
  await assert.rejects(runner('gmail_search', {}));
  const prompt = buildToolConnectionPrompt({ message: 'Find the later confirmation', history: [], now: () => NOW });
  assert.match(prompt, /nextCursor alone/);
  assert.match(prompt, /do not claim the email does not exist/);
  assert.match(prompt, /at most six tool calls/);
  assert.match(prompt, /ifRevision/);
  assert.equal(prompt.includes('in:inbox newer_than:7d'), false);
});

test('a version-1 snapshot without a generation is still readable', async t => {
  const dataDir = join(await tempDirectory(t), 'data');
  await mkdir(dataDir);
  const legacy = {
    version: 1, tokenHash: null, tokenExpiresAt: null,
    snapshot: {
      events: [{ id: 'legacy-1', title: 'Legacy focus', start: '2026-10-20T13:00:00+11:00', end: '2026-10-20T14:00:00+11:00', allDay: false }],
      rangeStart: WINDOW.rangeStart, rangeEnd: WINDOW.rangeEnd, timeZone: 'Australia/Sydney', syncedAt: new Date(NOW).toISOString(),
    },
  };
  await writeFile(join(dataDir, 'calendar.json'), JSON.stringify(legacy));
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const read = calendar.read({ start: '2026-10-20T13:00:00+11:00', end: '2026-10-20T14:00:00+11:00' });
  assert.equal(read.connected, true);
  assert.equal(read.events[0].title, 'Legacy focus');
  assert.equal(read.events[0].start, '2026-10-20T13:00:00+11:00');
});

test('the default continuation lifetime is ten minutes', async () => {
  const f = mailFixture();
  let clock = 1_000;
  const runner = createConnectionToolRunner(f, { now: () => clock });
  const first = await runner('gmail_search', { query: 'subject:flight', limit: 10 });
  clock = 1_000 + 600_000 - 1;
  assert.equal((await runner('gmail_search', { cursor: first.nextCursor })).messages[0].id, 'm11');
  clock = 1_000 + 600_000;
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), /expired/);
});

test('a real Gmail client rejects a continuation after disconnect', async t => {
  const dataDir = join(await tempDirectory(t), 'data');
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'google-client.json'), JSON.stringify({ installed: { client_id: CLIENT_ID } }));
  let record = { version: 1, clientId: CLIENT_ID, scope: GMAIL_SCOPE, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3_600_000 };
  const client = await createGmailClient({
    dataDir,
    secretStore: { async load() { return record && structuredClone(record); }, async save(next) { record = structuredClone(next); }, async remove() { record = null; } },
    now: () => NOW,
    fetchImpl: async url => {
      assert.equal(String(url).includes(ACCESS), false);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/messages')) return new Response(JSON.stringify({ messages: [{ id: 'mail-1' }], nextPageToken: RAW_PAGE, resultSizeEstimate: 11 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (parsed.origin === 'https://oauth2.googleapis.com') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ id: 'mail-1', snippet: 'First page', payload: { headers: [{ name: 'From', value: 'Ada' }, { name: 'Subject', value: 'Flight' }, { name: 'Date', value: 'Date' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const runner = createConnectionToolRunner({ gmail: client }, { now: () => NOW });
  const first = await runner('gmail_search', { query: 'subject:flight', limit: 1 });
  assert.equal(first.hasMore, true);
  assert.equal(JSON.stringify(first).includes(RAW_PAGE), false);
  await client.disconnect();
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), error => error instanceof GmailError && error.code === 'GMAIL_NOT_CONNECTED' && !error.message.includes(ACCESS) && !error.message.includes(RAW_PAGE));
});
