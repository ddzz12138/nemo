import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
import { createDesktopApi } from '../public/desktop-api.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { legacy } = {}) {
  const root = await mkdtemp(resolve('.work/conversation-test-')), calls = [];
  if (legacy) {
    const profiles = await createProfileStore({ dataDir: root, ownerName: 'Dan' }), owner = await profiles.owner(), directory = profiles.directory(owner.id);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'history-archive.json'), legacy);
  }
  let app, base, blocked;
  async function start() {
    app = await createFamilyServer({ dataDir: root, publicDir: resolve('public'), ownerName: 'Dan', memoryFactory: null, nativeFactory: null, logger() {}, provider: { status: () => ({ connected: true, verified: true }), async run(input) { calls.push(input); const gate = blocked; if (gate) { gate.started.resolve(); await gate.finish.promise; } return { text: `Synthetic reply ${calls.length}`, sessionId: `synthetic-session-${calls.length}` }; } }, async integrationsForProfile(_profile, { dataDir }) { return { calendar: await createCalendarStore({ dataDir }), gmail: { status: async () => ({ connected: false }), syncStatus: async () => ({ mode: 'demand', count: 0 }) } }; } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => { blocked?.finish.resolve(); await app?.close(); assert.equal(dirname(root), resolve('.work')); assert.ok(root.startsWith(resolve('.work/conversation-test-'))); await rm(root, { recursive: true, force: true }); });
  const owner = await app.profiles.owner(), member = await app.profiles.create('Alex');
  async function pair(profile) {
    const invite = await app.profiles.invite(profile.id);
    const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invite.code, expectedProfileId: profile.id }) });
    assert.equal(paired.status, 200); const cookie = paired.headers.get('set-cookie').split(';')[0];
    const api = createDesktopApi({ getProfile: () => profile, fetchImpl: (path, options) => fetch(base + path, { ...options, headers: { ...options.headers, Cookie: cookie } }) });
    return { api, async raw(path, input, headers = {}) { const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Nemo-Profile': profile.id, ...(input === undefined ? {} : { 'X-Nemo-Request': '1', 'Content-Type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; } };
  }
  async function send(api, message, requestId = randomUUID()) {
    const current = await api.conversation(), accepted = await api.send(message, requestId, current.conversationId);
    for (let i = 0; i < 100; i++) { const run = await api.run(accepted.runId); if (run.status === 'completed') return { ...accepted, requestId }; assert.notEqual(run.status, 'failed'); await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Synthetic reply did not settle.');
  }
  return { root, owner, member, pair, send, calls, get app() { return app; }, async restart() { await app.close(); await start(); }, block() { blocked = { started: deferred(), finish: deferred() }; return blocked; } };
}

test('New Chat archives the old conversation, starts with fresh provider context and reopens history for continued replies', async t => {
  const f = await fixture(t), { api } = await f.pair(f.owner);
  const first = await f.send(api, 'FIRST_CHAT_PRIVATE_TOPIC');
  const fresh = await api.newConversation(first.conversationId);
  assert.notEqual(fresh.conversationId, first.conversationId); assert.deepEqual(fresh.messages, []);
  let history = (await api.history()).conversations;
  assert.equal(history.find(item => item.id === first.conversationId).count, 2);
  await f.send(api, 'SECOND_CHAT_TOPIC');
  assert.equal(f.calls[1].sessionId, null); assert.doesNotMatch(f.calls[1].message, /FIRST_CHAT_PRIVATE_TOPIC/);
  const reopened = await api.openConversation(first.conversationId, fresh.conversationId);
  assert.equal(reopened.messages[0].text, 'FIRST_CHAT_PRIVATE_TOPIC');
  await f.send(api, 'Continue the first topic');
  assert.equal(f.calls[2].sessionId, null); assert.match(f.calls[2].message, /FIRST_CHAT_PRIVATE_TOPIC/); assert.doesNotMatch(f.calls[2].message, /SECOND_CHAT_TOPIC/);
  history = (await api.history()).conversations;
  assert.equal(history.find(item => item.id === first.conversationId).count, 4);
  assert.equal(history.find(item => item.id === fresh.conversationId).count, 2);
  const state = JSON.parse(await readFile(join(f.app.profiles.directory(f.owner.id), 'state.json')));
  assert.equal(state.sessions[f.owner.id].conversationId, first.conversationId);
  assert.equal(state.archivedConversations[0].id, fresh.conversationId);
});

test('multiple chats survive restart, and archived request IDs still prevent duplicate messages after reopening', async t => {
  const f = await fixture(t), { api } = await f.pair(f.owner);
  const first = await f.send(api, 'Remember this conversation');
  const second = await api.newConversation(first.conversationId); await f.send(api, 'A separate conversation');
  await f.restart();
  assert.equal((await api.conversation()).conversationId, second.conversationId);
  assert.equal((await api.savedConversation(first.conversationId)).messages.length, 2);
  await api.openConversation(first.conversationId, second.conversationId);
  const replay = await api.send('Remember this conversation', first.requestId, first.conversationId);
  assert.equal(replay.runId, first.runId); assert.equal(f.calls.length, 2);
  assert.equal((await api.conversation()).messages.length, 2);
});

test('a second device shares personal history while other profiles cannot open guessed chat IDs', async t => {
  const f = await fixture(t), a = await f.pair(f.owner), same = await f.pair(f.owner), other = await f.pair(f.member);
  const first = await f.send(a.api, 'DAN_ONLY_CHAT'), fresh = await a.api.newConversation(first.conversationId);
  assert.equal((await same.api.conversation()).conversationId, fresh.conversationId);
  await same.api.openConversation(first.conversationId, fresh.conversationId);
  assert.equal((await a.api.conversation()).messages[0].text, 'DAN_ONLY_CHAT');
  const otherId = (await other.api.conversation()).conversationId;
  await assert.rejects(other.api.openConversation(first.conversationId, otherId), error => error.status === 404);
  await assert.rejects(other.api.savedConversation(first.conversationId), error => error.status === 404);
  assert.doesNotMatch(JSON.stringify(await other.api.history()), /DAN_ONLY_CHAT/);
  assert.equal((await a.raw('/api/conversations/new', { fromConversationId: first.conversationId }, { 'X-Nemo-Profile': f.member.id })).status, 409);
});

test('stale tabs and concurrent New Chat requests cannot move or append to a different conversation', async t => {
  const f = await fixture(t), { api } = await f.pair(f.owner);
  const first = await f.send(api, 'Original chat');
  const results = await Promise.allSettled([api.newConversation(first.conversationId), api.newConversation(first.conversationId)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'CONVERSATION_CHANGED');
  const current = await api.conversation();
  await assert.rejects(api.send('Late message from stale tab', randomUUID(), first.conversationId), error => error.code === 'CONVERSATION_CHANGED');
  await assert.rejects(api.send('Original chat', first.requestId, current.conversationId), error => error.code === 'CONVERSATION_CHANGED');
  assert.deepEqual((await api.conversation()).messages, []);
  assert.equal((await api.savedConversation(first.conversationId)).messages.length, 2);
  assert.equal((await api.newConversation(current.conversationId)).conversationId, current.conversationId, 'Repeated clicks do not create empty history entries');
});

test('an active reply blocks chat switching until its messages are safely saved', async t => {
  const f = await fixture(t), { api } = await f.pair(f.owner), blocked = f.block();
  const initial = await api.conversation(), accepted = await api.send('A slower synthetic reply', randomUUID(), initial.conversationId);
  await blocked.started.promise;
  await assert.rejects(api.newConversation(initial.conversationId), error => error.code === 'RUN_ACTIVE');
  blocked.finish.resolve();
  for (let i = 0; i < 100 && (await api.run(accepted.runId)).status !== 'completed'; i++) await new Promise(done => setTimeout(done, 10));
  const next = await api.newConversation(initial.conversationId);
  assert.notEqual(next.conversationId, initial.conversationId); assert.equal((await api.savedConversation(initial.conversationId)).messages.length, 2);
});

test('legacy histories import once and deleted archive entries cannot reappear from the retained backup', async t => {
  const oldId = randomUUID();
  const backup = JSON.stringify([{ id: oldId, messages: [{ id: randomUUID(), role: 'user', text: 'Legacy private conversation', createdAt: 1 }] }]);
  const f = await fixture(t, { legacy: backup }), directory = f.app.profiles.directory(f.owner.id);
  const { api } = await f.pair(f.owner), current = await api.conversation();
  await api.openConversation(oldId, current.conversationId);
  assert.equal((await api.conversation()).messages[0].text, 'Legacy private conversation');
  await api.newConversation(oldId);
  await api.request(`/api/history/${oldId}/clear`, {});
  await f.restart();
  await assert.rejects(api.savedConversation(oldId), error => error.status === 404);
  assert.equal(await readFile(join(directory, 'history-archive.json'), 'utf8'), backup);
});

test('a failed atomic save keeps the current chat and history intact and permits a safe retry', async t => {
  const f = await fixture(t), { api } = await f.pair(f.owner), first = await f.send(api, 'Keep this chat if storage fails');
  const directory = resolve(f.app.profiles.directory(f.owner.id));
  assert.ok(directory.startsWith(resolve(f.root) + sep));
  const path = join(directory, 'state.json'), saved = join(directory, 'state.saved.json');
  await rename(path, saved); await mkdir(path);
  try { await assert.rejects(api.newConversation(first.conversationId), error => error.status >= 500); }
  finally { await rmdir(path); await rename(saved, path); }
  const current = await api.conversation();
  assert.equal(current.conversationId, first.conversationId); assert.equal(current.messages.length, 2);
  assert.equal((await api.history()).conversations.filter(item => item.count > 0).length, 1);
  const fresh = await api.newConversation(first.conversationId); assert.notEqual(fresh.conversationId, first.conversationId);
  assert.equal((await api.savedConversation(first.conversationId)).messages.length, 2);
});
