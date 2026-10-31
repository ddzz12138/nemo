import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionToolRunner, connectionTools } from '../lib/connections.mjs';
import { createMcpHandler } from '../mcp-server.mjs';

const RAW_PAGE = 'google-page-token-must-stay-local';
function fixture() {
  const calls = [];
  let connected = true;
  const gmail = {
    calls,
    disconnect() { connected = false; },
    async searchPage(input) {
      if (!connected) throw new Error('Connect Gmail first');
      calls.push(input);
      return input.pageToken
        ? { messages: [{ id: '11', subject: 'Wanted flight confirmation' }], nextPageToken: null, hasMore: false, resultSizeEstimate: 11 }
        : { messages: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), subject: 'Other match' })), nextPageToken: RAW_PAGE, hasMore: true, resultSizeEstimate: 11 };
    },
  };
  return { gmail, calls };
}

test('MCP Gmail continuation reaches match eleven and preserves the original query/page size', async () => {
  const f = fixture();
  const runner = createConnectionToolRunner(f);
  const first = await runner('gmail_search', { query: ' subject:flight ', limit: 10 });
  assert.equal(first.messages.length, 10);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first).includes(RAW_PAGE));
  const next = await runner('gmail_search', { cursor: first.nextCursor });
  assert.equal(next.messages[0].id, '11');
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, null);
  assert.equal(next.bodyAccess, false);
  assert.deepEqual(f.calls, [{ query: 'subject:flight', limit: 10 }, { query: 'subject:flight', limit: 10, pageToken: RAW_PAGE }]);
  const retries = await runner('gmail_search', { cursor: first.nextCursor });
  assert.equal(retries.messages[0].id, '11', 'Reusing a cursor does not advance to the wrong page');
  f.gmail.disconnect();
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), /Connect Gmail/);
});

test('continuations are session local, expiring and cannot be rebound to another query or page size', async () => {
  const f = fixture();
  let clock = 1000;
  const runner = createConnectionToolRunner(f, { now: () => clock, cursorTtlMs: 100 });
  const first = await runner('gmail_search', { query: 'subject:flight', limit: 10 });
  for (const args of [{ cursor: first.nextCursor, query: 'in:anywhere' }, { cursor: first.nextCursor, limit: 1 }, { cursor: RAW_PAGE }, { cursor: null }, { cursor: 'f'.repeat(64) }, { cursor: first.nextCursor, pageToken: RAW_PAGE }]) await assert.rejects(runner('gmail_search', args));
  await assert.rejects(createConnectionToolRunner(f)('gmail_search', { cursor: first.nextCursor }));
  assert.equal(f.calls.length, 1);
  clock = 1100;
  await assert.rejects(runner('gmail_search', { cursor: first.nextCursor }), /expired/);
  assert.equal(f.calls.length, 1);
});

test('mail query options fail before an adapter call, including null fields', async () => {
  const f = fixture(); const runner = createConnectionToolRunner(f);
  for (const args of [null, [], {}, { limit: 1 }, { query: 9 }, { query: '' }, { query: '\nsecret' }, { query: 'x'.repeat(501) }, { limit: 11 }, { limit: true }, { query: null }, { limit: null }, { command: 'anything' }]) await assert.rejects(runner('gmail_search', args));
  assert.equal(f.calls.length, 0);
});

test('tool boundary projects only bounded Gmail metadata even if an adapter returns additional private fields', async () => {
  const runner = createConnectionToolRunner({ gmail: { async searchPage() { return { messages: [{ id: 'fixture', from: 'Sender', subject: 'Test', date: 'Date', snippet: 'Summary', body: 'SECRET_BODY', attachments: ['SECRET_ATTACHMENT'], accessToken: 'SECRET_TOKEN' }], hasMore: false, nextPageToken: null, resultSizeEstimate: 1 }; } } });
  const page = await runner('gmail_search', { query: 'subject:Test' });
  assert.deepEqual(Object.keys(page.messages[0]).sort(), ['date', 'from', 'id', 'snippet', 'subject']);
  assert.ok(!JSON.stringify(page).includes('SECRET'));
});

test('tool boundary drops invalid Gmail result estimates without forwarding adapter text or objects', async () => {
  for (const estimate of ['SECRET_ESTIMATE', { token: 'SECRET_ESTIMATE' }, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, true, undefined, null]) {
    const runner = createConnectionToolRunner({ gmail: { async searchPage() {
      return { messages: [], hasMore: false, nextPageToken: null, resultSizeEstimate: estimate };
    } } });
    const page = await runner('gmail_search', { query: 'subject:fixture' });
    assert.equal(page.resultSizeEstimate, null);
    assert.ok(!JSON.stringify(page).includes('SECRET_ESTIMATE'));
  }
});

test('tool boundary preserves nonnegative safe integer Gmail estimates, including zero', async () => {
  for (const estimate of [0, 11, Number.MAX_SAFE_INTEGER]) {
    const runner = createConnectionToolRunner({ gmail: { async searchPage() {
      return { messages: [], hasMore: false, nextPageToken: null, resultSizeEstimate: estimate };
    } } });
    assert.equal((await runner('gmail_search', { query: 'subject:fixture' })).resultSizeEstimate, estimate);
  }
});

test('MCP protocol returns usable page cursors and sanitizes expired cursor failures', async () => {
  const f = fixture(); const handle = createMcpHandler(f);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = (id, args) => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'gmail_search', arguments: args } });
  const response = await call(2, { query: 'subject:flight', limit: 10 });
  const first = JSON.parse(response.result.content[0].text);
  const next = await call(3, { cursor: first.nextCursor });
  assert.equal(JSON.parse(next.result.content[0].text).messages[0].id, '11');
  const invalid = await call(4, { cursor: '0'.repeat(64) });
  assert.equal(invalid.result.isError, true);
  assert.ok(!JSON.stringify(invalid).includes(RAW_PAGE));
  assert.equal(connectionTools.find(tool => tool.name === 'gmail_search').inputSchema.properties.cursor.maxLength, 64);
});
