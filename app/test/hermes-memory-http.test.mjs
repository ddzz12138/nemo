import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
import { createDesktopApi } from '../public/desktop-api.mjs';

const python = resolve('.work/desktop-runtime/hermes/python/python.exe');
const source = resolve('vendor/hermes-source');
const bridge = fileURLToPath(new URL('../lib/hermes_memory.py', import.meta.url));
const available = existsSync(python);
const command = () => [python, '-B', '-I', '-c', `import sys, runpy; sys.dont_write_bytecode=True; sys.path.insert(0, ${JSON.stringify(source)}); import hermes_bootstrap; runpy.run_path(${JSON.stringify(bridge)}, run_name='__main__')`];

// The agent reply is synthetic, but the HTTP/API -> Python bridge -> pinned
// Hermes MemoryStore boundary is real and uses a fresh profile-owned workspace.
async function fixture(t, { native = true } = {}) {
  await mkdir(resolve('.work'), { recursive: true });
  const root = await mkdtemp(resolve('.work/hermes-native-http-'));
  const calls = [], mailChanges = [];
  let app, base, builtin = native;
  async function start() {
    app = await createFamilyServer({ dataDir: root, publicDir: resolve('public'), builtinMemory: builtin, logger() {},
      provider: { status: () => ({ connected: true, verified: true, inferenceProvider: 'chatgpt', planUsageEnabled: true }), memoryCommand: async () => command(),
        async run(input) { calls.push(input); return { text: 'Synthetic native-memory reply.', sessionId: `private-synthetic-${calls.length}` }; } },
      async integrationsForProfile(profile, { dataDir }) { return { calendar: await createCalendarStore({ dataDir }), gmail: {
        async status() { return { connected: true, configured: true }; }, async syncStatus() { return { mode: 'demand', count: 0 }; },
        async disconnect() { mailChanges.push(profile.id); return { connected: false }; }, async close() {},
      } }; },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await app.close(); assert.equal(dirname(root), resolve('.work')); assert.ok(root.startsWith(resolve('.work/hermes-native-http-')));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const owner = await app.profiles.owner();
  async function pair(profile) {
    const invite = await app.profiles.invite(profile.id);
    const response = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invite.code, expectedProfileId: profile.id }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0];
    async function raw(path, input, extraHeaders = {}) {
      const result = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Nemo-Profile': profile.id,
        ...(input === undefined ? {} : { 'X-Nemo-Request': '1', 'Content-Type': 'application/json' }), ...extraHeaders }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: result.status, data: await result.json() };
    }
    const api = createDesktopApi({ getProfile: () => profile, fetchImpl: (path, options) => fetch(base + path, { ...options, headers: { ...options.headers, Cookie: cookie } }) });
    return { api, raw };
  }
  async function send(api, message) {
    const current = await api.conversation(); const accepted = await api.send(message, randomUUID(), current.conversationId);
    for (let n = 0; n < 500; n++) {
      const run = await api.run(accepted.runId); assert.notEqual(run.status, 'failed', run.error);
      if (run.status === 'completed') return run;
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error('Synthetic native-memory reply did not settle.');
  }
  return { root, owner, pair, send, calls, mailChanges, get app() { return app; }, async restart(enabled = builtin) { await app.close(); builtin = enabled; await start(); } };
}

test('native Memory HTTP uses the same Hermes files and pins every operation to its signed-in profile', { skip: !available }, async t => {
  const f = await fixture(t), owner = await f.pair(f.owner), otherProfile = await f.app.profiles.create('Synthetic other adult'), other = await f.pair(otherProfile);
  assert.equal((await owner.api.session()).memoryMode, 'profile-hermes');
  const added = await owner.api.request('/api/memory/notes', { content: 'SYNTHETIC_PRIVATE_DETAIL <script>literal</script>', title: 'Synthetic private detail', category: 'preferences' });
  assert.equal(added.ok, true);
  const board = await owner.api.request('/api/memory/board'); assert.equal(board.kind, 'hermes-builtin'); assert.equal(board.automatic, true);
  assert.equal(board.items.length, 1); assert.match(board.items[0].text, /SYNTHETIC_PRIVATE_DETAIL/);
  assert.match(await readFile(join(f.app.profiles.directory(f.owner.id), 'hermes/memories/USER.md'), 'utf8'), /SYNTHETIC_PRIVATE_DETAIL/);
  assert.deepEqual((await other.api.request('/api/memory/board')).items, []);
  const guessed = await other.raw('/api/memory/fact?id=' + encodeURIComponent(board.items[0].id)); assert.ok([403, 404].includes(guessed.status)); assert.doesNotMatch(JSON.stringify(guessed.data), /SYNTHETIC_PRIVATE_DETAIL/);
  assert.equal((await owner.raw('/api/memory/board', undefined, { 'X-Nemo-Profile': otherProfile.id })).status, 409);
  assert.equal((await owner.raw('/api/memory/notes', { owner: otherProfile.id, content: 'FORGED_OWNER' })).status, 400);
  for (const path of ['/api/memory/learning', '/api/memory/enable', '/api/memory/mirror', '/api/memory/semantic']) {
    const result = await owner.raw(path, path.endsWith('semantic') ? undefined : { enabled: false }); assert.equal(result.status, 410, path); assert.equal(result.data.code, 'MEMORY_AUTOMATIC');
  }
});

test('private-workspace transition and manual memory changes preserve History/grants while retiring stale agent context', { skip: !available }, async t => {
  const f = await fixture(t, { native: false }), { api } = await f.pair(f.owner);
  await f.send(api, 'SYNTHETIC_OLD_CONVERSATION'); const original = await api.conversation();
  const grantPath = join(f.root, 'assistant-provider.dpapi'); await writeFile(grantPath, 'SYNTHETIC_PROTECTED_GRANT_BYTES');
  const statePath = join(f.app.profiles.directory(f.owner.id), 'state.json');
  assert.ok(JSON.parse(await readFile(statePath, 'utf8')).sessions[f.owner.id].hermesSessionId);
  await f.restart(true);
  assert.equal((await api.conversation()).messages[0].text, 'SYNTHETIC_OLD_CONVERSATION');
  await f.send(api, 'Continue after the native workspace transition.'); assert.equal(f.calls.at(-1).sessionId, null); assert.equal(f.calls.at(-1).builtinMemoryAllowed, true); assert.ok(f.calls.at(-1).permissionRevision);
  await f.send(api, 'Continue with unchanged memory.'); assert.ok(f.calls.at(-1).sessionId);
  await api.request('/api/memory/notes', { content: 'Synthetic stored preference.', category: 'preferences' });
  await f.send(api, 'Use my updated memory.'); assert.equal(f.calls.at(-1).sessionId, null);
  const board = await api.request('/api/memory/board'), item = board.items[0];
  const preview = await api.request('/api/memory/delete/preview', { id: item.id, action: 'forget' });
  const forgotten = await api.request('/api/memory/delete', { confirmation: preview.confirmation }); assert.equal(forgotten.receipt.state, 'complete');
  assert.deepEqual((await api.request('/api/memory/board')).items, []);
  await f.send(api, 'Continue after forgetting.'); assert.equal(f.calls.at(-1).sessionId, null);
  assert.equal((await api.conversation()).conversationId, original.conversationId); assert.equal(await readFile(grantPath, 'utf8'), 'SYNTHETIC_PROTECTED_GRANT_BYTES');
  await f.restart(); assert.equal((await api.conversation()).messages[0].text, 'SYNTHETIC_OLD_CONVERSATION'); assert.deepEqual((await api.request('/api/memory/board')).items, []);
});

test('native Memory retains Gmail cleanup guards and requires verified explicit clear after connected context', { skip: !available }, async t => {
  const f = await fixture(t), { api, raw } = await f.pair(f.owner);
  await api.request('/api/memory/notes', { content: 'Synthetic personal note before any connected context.' });
  assert.equal((await raw('/api/gmail/disconnect', {})).status, 200, 'First connection lifecycle must not erase unrelated direct notes');
  assert.equal((await raw('/api/calendar/disconnect', {})).status, 200);
  await api.consent(true); await f.send(api, 'Use my permitted connected information.'); assert.equal(f.calls.at(-1).useIntegrations, true);
  const before = f.mailChanges.length; const blocked = await raw('/api/gmail/disconnect', {}); assert.notEqual(blocked.status, 200); assert.equal(f.mailChanges.length, before);
  const calendarBlocked = await raw('/api/calendar/disconnect', {}); assert.notEqual(calendarBlocked.status, 200); assert.equal(calendarBlocked.data.code, 'MEMORY_SOURCE_CLEANUP');
  const preview = await api.request('/api/memory/clear/preview', { scope: 'notes' });
  assert.equal((await api.request('/api/memory/delete', { confirmation: preview.confirmation })).receipt.state, 'complete');
  assert.equal((await raw('/api/gmail/disconnect', {})).status, 200);
  assert.equal((await raw('/api/calendar/disconnect', {})).status, 200);
  assert.ok((await api.conversation()).messages.length > 0, 'Clearing persistent Memory must preserve History');
  await api.consent(false);
  await api.request('/api/memory/notes', { content: 'Synthetic note after clear, before replaying connected context.' });
  await f.send(api, 'Continue the earlier conversation without connected tools.');
  assert.equal(f.calls.at(-1).useIntegrations, false);
  assert.notEqual((await raw('/api/gmail/disconnect', {})).status, 200, 'Replayed connected history must not bypass source cleanup after a Memory clear');
  assert.notEqual((await raw('/api/calendar/disconnect', {})).status, 200);
  const retry = await api.request('/api/memory/clear/preview', { scope: 'notes' });
  assert.equal((await api.request('/api/memory/delete', { confirmation: retry.confirmation })).receipt.state, 'complete');
  assert.equal((await raw('/api/gmail/disconnect', {})).status, 200);
  assert.equal((await raw('/api/calendar/disconnect', {})).status, 200);
  const legacy = join(f.app.profiles.directory(f.owner.id), 'gbrain-data'); await mkdir(legacy); await writeFile(join(legacy, 'saved.txt'), 'SYNTHETIC_OLD_MEMORY');
  assert.notEqual((await raw('/api/gmail/disconnect', {})).status, 200); assert.equal(await readFile(join(legacy, 'saved.txt'), 'utf8'), 'SYNTHETIC_OLD_MEMORY');
});

test('native Memory keeps child permission and audited review boundaries while regular chat remains available', { skip: !available }, async t => {
  const f = await fixture(t), child = await f.app.profiles.create('Synthetic child'); await f.app.profiles.classify(child.id, 'child');
  const { api, raw } = await f.pair(child);
  assert.equal((await raw('/api/memory/board')).status, 403); await f.send(api, 'Chat without memory permission.'); assert.equal(f.calls.at(-1).builtinMemoryAllowed, false);
  await f.app.profiles.setCapability(child.id, 'memory', true);
  await api.request('/api/memory/notes', { content: 'SYNTHETIC_CHILD_NOTE' });
  await f.send(api, 'Chat with memory permission.'); assert.equal(f.calls.at(-1).builtinMemoryAllowed, true);
  await f.app.profiles.setCapability(child.id, 'memory', false); await f.send(api, 'Chat after permission revocation.'); assert.equal(f.calls.at(-1).builtinMemoryAllowed, false); assert.equal(f.calls.at(-1).sessionId, null);
  assert.equal((await raw('/api/memory/board')).status, 403);
});
