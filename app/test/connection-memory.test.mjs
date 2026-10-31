import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionTools, createConnectionToolRunner, buildToolConnectionPrompt } from '../lib/connections.mjs';
import { createMcpHandler } from '../mcp-server.mjs';

function fixture({ connected = true, items, failure } = {}) {
  const calls = [];
  return {
    calls,
    gbrain: {
      async status() { calls.push('status'); return { connected }; },
      async search(input) {
        calls.push(input);
        if (failure) throw new Error('SECRET_RUNTIME_PATH_AND_TOKEN');
        return { items: items || [{ slug: 'notes/meeting-preferences', title: 'Meeting preference', summary: 'Prefer meetings after 10 am.', revision: 'abc123', kind: 'note', status: 'active' }], hasMore: false };
      },
    },
  };
}

test('memory search advertises only a bounded explicit-query read and never a memory write', () => {
  const memory = connectionTools.find(tool => tool.name === 'memory_search');
  assert.ok(memory);
  assert.deepEqual(memory.inputSchema.required, ['query']);
  assert.equal(memory.inputSchema.additionalProperties, false);
  assert.equal(memory.annotations.readOnlyHint, true);
  assert.equal(memory.annotations.destructiveHint, false);
  assert.ok(!connectionTools.some(tool => /save|put|forget|delete|purge|capture/.test(tool.name)));
});

test('memory query validation fails before storage inspection and does not accept paths, cursor or write options', async () => {
  const f = fixture();
  const run = createConnectionToolRunner(f);
  for (const args of [null, [], {}, { query: '' }, { query: ' ' }, { query: 7 }, { query: 'x\n' },
    { query: 'x'.repeat(501) }, { query: 'note', limit: 0 }, { query: 'note', limit: 11 },
    { query: 'note', limit: true }, { query: 'note', limit: null }, { query: 'note', cursor: 'a'.repeat(64) },
    { query: 'note', dataDir: 'C:\\private' }, { query: 'note', command: 'must-not-run' }, { query: 'note', save: true }]) {
    await assert.rejects(run('memory_search', args));
  }
  assert.deepEqual(f.calls, []);
});

test('unconfigured saved memory reports disconnected without claiming an empty searched store', async () => {
  const missing = await createConnectionToolRunner({})('memory_search', { query: 'project' });
  assert.equal(missing.connected, false);
  assert.match(missing.note, /not connected/);
  const f = fixture({ connected: false });
  const result = await createConnectionToolRunner(f)('memory_search', { query: 'project' });
  assert.equal(result.connected, false);
  assert.deepEqual(result.items, []);
  assert.deepEqual(f.calls, ['status']);
});

test('memory result projects only active explicit note excerpts with source identifiers and bounded fields', async () => {
  const f = fixture({ items: [{ slug: 'notes/meeting', title: 'x'.repeat(1500), summary: 'y'.repeat(3000),
    revision: 'rev1', kind: 'note', status: 'active', body: 'SECRET_BODY', credentials: 'SECRET_TOKEN',
    filePath: 'SECRET_PATH', sourceLabel: 'SECRET_LABEL' }] });
  const result = await createConnectionToolRunner(f)('memory_search', { query: ' meeting ', limit: 1 });
  assert.deepEqual(f.calls, ['status', { query: 'meeting', limit: 1 }]);
  assert.equal(result.connected, true);
  assert.equal(result.items[0].id, 'gbrain:notes/meeting');
  assert.equal(result.items[0].title.length, 1000);
  assert.equal(result.items[0].excerpt.length, 2000);
  assert.equal(result.items[0].source, 'gbrain');
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['excerpt', 'id', 'revision', 'source', 'title']);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('memory boundary rejects inactive, non-note and malformed identifiers rather than leaking their content', async () => {
  for (const patch of [{ status: 'forgotten' }, { status: 'deleted' }, { kind: 'email' },
    { slug: '../private' }, { slug: 'notes//private' }, { slug: 'notes/../private' }, { slug: '/private' }]) {
    const f = fixture({ items: [{ slug: 'notes/fixture', title: 'SECRET_TITLE', summary: 'SECRET_TEXT', revision: 'rev', kind: 'note', status: 'active', ...patch }] });
    await assert.rejects(createConnectionToolRunner(f)('memory_search', { query: 'fixture' }), /Invalid saved memory item/);
  }
});

test('MCP memory errors redact dependency details and unknown write tools are denied', async () => {
  const f = fixture({ failure: true });
  const handle = createMcpHandler(f);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'note' } } });
  assert.equal(response.result.isError, true);
  assert.ok(!JSON.stringify(response).includes('SECRET'));
  for (const name of ['memory_save', 'memory_forget', 'memory_delete', 'purge_fact', 'capture']) {
    const denied = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(denied.error.code, -32602);
  }
});

test('memory instructions require source citations, separate stored notes from live sources and forbid automatic writes', () => {
  const prompt = buildToolConnectionPrompt({ message: 'What did I save about meetings?' });
  assert.match(prompt, /mcp__nemo__memory_search/);
  assert.match(prompt, /Cite the returned memory identifiers/);
  assert.match(prompt, /may be outdated/);
  assert.match(prompt, /Never save, edit or delete memory through a chat tool/);
  assert.match(prompt, /untrusted quoted data/);
});
