import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryController, MemoryError } from '../lib/memory.mjs';

const EVENT_ID = 'ab'.repeat(12);
const tick = () => new Promise(resolve => setImmediate(resolve));

function assertError(error, status, code) {
  assert.equal(error instanceof MemoryError, true);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.equal(error.message.includes('secret'), false);
  assert.equal(/[/\\]/.test(error.message), false);
  return true;
}

function setup(options = {}) {
  const store = new Map((options.pages || []).map(page => [page.slug, { ...page }]));
  const calls = { search: 0, models: 0, listArgs: [], get: 0, forget: [], remove: [], save: [], owners: [], clear: [] };
  const clock = { value: options.clock ?? 1_700_000_000_000 };
  const minted = [];
  const chats = {
    'owner-a': { count: 2, content: 'ALPHA_TRANSCRIPT', revision: 'chat-a', createdAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-21T02:00:00Z' },
    'owner-b': { count: 1, content: 'BETA_TRANSCRIPT', revision: 'chat-b', createdAt: '2026-10-21T03:00:00Z', updatedAt: '2026-10-21T04:00:00Z' },
    ...(options.chats || {}),
  };
  const calendarState = { events: (options.events || []).map(event => ({ ...event })), removed: [] };
  const brain = {
    nextRemove: { ok: true, status: 'purged', residuals: ['backup copy remains'], message: 'purged', receipt: { completion: 'complete' } },
    async status() {
      if (options.statusError) throw options.statusError;
      return { connected: options.connected !== false };
    },
    async list(input = {}) {
      calls.listArgs.push({ ...input });
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (Number.isInteger(options.virtualTotal)) {
        const end = Math.min(offset + limit, options.virtualTotal);
        const items = [];
        for (let index = offset; index < end; index += 1) {
          items.push({ slug: `nemo-notes/n${index}`, title: `Note ${index}`, summary: 'listed', content: `SECRET_BODY_${index}`, revision: 'rev-virtual', status: 'active' });
        }
        return { items, hasMore: end < options.virtualTotal };
      }
      const all = [...store.values()];
      return { items: all.slice(offset, offset + limit).map(page => ({ ...page })), hasMore: offset + limit < all.length };
    },
    async get(slug) {
      calls.get += 1;
      if (Number.isInteger(options.virtualTotal)) {
        const match = /^nemo-notes\/n(\d+)$/.exec(slug);
        if (!match) { const error = new Error('missing'); error.status = 404; throw error; }
        return { slug, title: `Note ${match[1]}`, summary: 'listed', content: `body ${match[1]}`, revision: 'rev-virtual', status: 'active' };
      }
      const page = store.get(slug);
      if (!page) { const error = new Error('missing note'); error.status = 404; throw error; }
      return { ...page };
    },
    async search() { calls.search += 1; throw new Error('search is active-only and must not inventory notes'); },
    async embed() { calls.models += 1; throw new Error('writes must not call a model'); },
    async save(input) {
      calls.save.push({ ...input });
      if (options.onSave) options.onSave(input);
      const slug = input.slug || `nemo-notes/saved-${calls.save.length}`;
      const page = {
        slug, title: input.title, content: input.content, summary: input.content.slice(0, 80),
        revision: input.expectedRevision ? 'rev-2' : 'rev-saved', status: 'active',
        createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T01:00:00Z',
      };
      store.set(slug, page);
      return { ...page };
    },
    async forget(slug, forgetOptions) {
      calls.forget.push({ slug, options: { ...forgetOptions } });
      return { ok: true, status: 'forgotten', residuals: ['Recoverable GBrain history remains'], message: 'hidden from recall' };
    },
    async remove(slug, removeOptions) {
      calls.remove.push({ slug, options: { ...removeOptions } });
      if (options.onRemove) await options.onRemove(slug, removeOptions);
      return brain.nextRemove;
    },
  };
  const calendar = {
    async reload() {},
    inventory() {
      return {
        events: calendarState.events.map(event => ({ ...event })),
        syncedAt: '2026-10-21T00:00:00.000Z', generation: 'generation-1', excludedCount: calendarState.removed.length,
      };
    },
    status() { return { connected: true }; },
    async removeStoredEvents(ids) {
      calendarState.removed.push([...ids]);
      const removing = new Set(ids);
      const before = calendarState.events.length;
      calendarState.events = calendarState.events.filter(event => !removing.has(event.id));
      return { removedCount: before - calendarState.events.length, reimportBlocked: true };
    },
  };
  const controller = createMemoryController({
    calendar, gbrain: brain,
    getChat(owner) { calls.owners.push(owner); return chats[owner] ? { ...chats[owner] } : { count: 0 }; },
    clearChat: options.clearChat || (async owner => {
      calls.clear.push(owner);
      if (chats[owner]) chats[owner] = { ...chats[owner], count: 0, content: '' };
    }),
    assertIdle: options.assertIdle || (() => {}),
    now: options.now || (() => clock.value),
    createRequestId: options.createRequestId || (() => {
      const id = `00000000-0000-4000-8000-${String(minted.length + 1).padStart(12, '0')}`;
      minted.push(id);
      return id;
    }),
  });
  return { brain, calendarState, calls, controller, chats, clock, minted, store };
}

const note = (extra = {}) => ({
  slug: 'nemo-notes/note', title: 'Shopping', summary: 'milk and bread', content: 'NOTE_BODY_HIDDEN',
  revision: 'rev-1', status: 'active', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:30:00Z', ...extra,
});

test('two browsers see only their own chat, and list search ignores note bodies', async () => {
  const { controller, calls } = setup({
    pages: [
      note(),
      { slug: 'nemo-notes/old', title: 'Old note', summary: 'kept for the owner', content: 'FORGOTTEN_BODY', revision: 'rev-old', status: 'forgotten' },
      { slug: 'projects/other', title: 'NON_NOTE_TITLE', summary: 'NON_NOTE_SUMMARY', content: 'NON_NOTE_BODY', revision: 'rev-x', status: 'active' },
      { slug: 'nemo-notes/third', title: 'Third note', summary: 'third summary', content: 'THIRD_BODY', revision: 'rev-3', status: 'active' },
    ],
    events: [{ id: EVENT_ID, title: 'Dentist visit', start: '2026-10-21T09:00:00+11:00', end: '2026-10-21T10:00:00+11:00', allDay: false }],
  });
  const listedA = await controller.list('owner-a', new URLSearchParams());
  const listedB = await controller.list('owner-b', new URLSearchParams());
  const rawA = JSON.stringify(listedA);
  const rawB = JSON.stringify(listedB);
  assert.equal(rawA.includes('ALPHA_TRANSCRIPT'), false);
  assert.equal(rawA.includes('BETA_TRANSCRIPT'), false);
  assert.equal(rawB.includes('ALPHA_TRANSCRIPT'), false);
  assert.equal(rawB.includes('BETA_TRANSCRIPT'), false);
  assert.equal(rawA.includes('NOTE_BODY_HIDDEN'), false);
  assert.equal(rawA.includes('FORGOTTEN_BODY'), false);
  assert.equal(rawA.includes('NON_NOTE_TITLE'), false);
  assert.equal(rawA.includes('NON_NOTE_SUMMARY'), false);
  assert.equal(rawA.includes('NON_NOTE_BODY'), false);
  assert.equal(calls.search, 0);
  assert.equal(calls.models, 0);
  assert.equal(calls.listArgs.every(input => !Object.hasOwn(input, 'query') && input.limit === 100), true);
  assert.deepEqual(calls.owners, ['owner-a', 'owner-b']);

  const detailA = await controller.get('owner-a', 'nemo:chat');
  const detailB = await controller.get('owner-b', 'nemo:chat');
  assert.equal(detailA.item.content, 'ALPHA_TRANSCRIPT');
  assert.equal(detailB.item.content, 'BETA_TRANSCRIPT');
  assert.equal(JSON.stringify(detailA).includes('BETA_TRANSCRIPT'), false);

  const forgotten = listedA.items.find(item => item.id === 'gbrain:nemo-notes/old');
  assert.equal(forgotten.status, 'forgotten');
  assert.equal(forgotten.canForget, false);
  assert.equal(forgotten.canEdit, false);
  assert.equal(Object.hasOwn(forgotten, 'content'), false);
  const gbrainStore = listedA.stores.find(item => item.id === 'gbrain');
  assert.match(gbrainStore.description, /excluded from recall/i);
  assert.match(gbrainStore.description, /1 non-note page was excluded from this screen/);
  assert.equal(listedA.totals.gbrain, 3);
  assert.equal(listedA.items.some(item => item.id === 'gbrain:projects/other'), false);
  await assert.rejects(() => controller.preview('owner-a', { id: forgotten.id, action: 'forget' }), error => assertError(error, 400));

  const bySummary = await controller.list('owner-a', new URLSearchParams('q=MILK'));
  assert.deepEqual(bySummary.items.map(item => item.id), ['gbrain:nemo-notes/note']);
  const byBody = await controller.list('owner-a', new URLSearchParams('q=NOTE_BODY_HIDDEN'));
  assert.deepEqual(byBody.items, []);
  const byTranscript = await controller.list('owner-a', new URLSearchParams('q=ALPHA'));
  assert.deepEqual(byTranscript.items, []);
  const notes = await controller.list('owner-a', new URLSearchParams('kind=note&limit=2&offset=0'));
  assert.equal(notes.total, 3);
  assert.equal(notes.items.length, 2);
  assert.equal(notes.hasMore, true);
  const last = await controller.list('owner-a', new URLSearchParams('kind=note&limit=2&offset=2'));
  assert.equal(last.total, 3);
  assert.equal(last.items.length, 1);
  assert.equal(last.hasMore, false);
  const nemoOnly = await controller.list('owner-a', new URLSearchParams('origin=nemo'));
  assert.equal(nemoOnly.items.every(item => item.origin === 'nemo'), true);
  assert.equal(nemoOnly.total, 2);
  const calendarOnly = await controller.list('owner-b', new URLSearchParams('kind=calendar'));
  assert.deepEqual(calendarOnly.items.map(item => item.kind), ['calendar']);
  assert.equal(JSON.stringify(calendarOnly).includes('ALPHA_TRANSCRIPT'), false);
  const calendarStore = listedA.stores.find(item => item.id === 'calendar');
  assert.match(calendarStore.description, /phone originals are unchanged/i);
  assert.match(calendarStore.description, /revised event can reappear as a new copy/i);
});

test('preview confirmation expires, rejects replay and the wrong browser, and ignores a browser id in the body', async () => {
  const { controller, calls, clock } = setup({ pages: [note()] });
  const first = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  assert.match(first.confirmation, /^[a-f0-9]{64}$/);
  assert.equal(first.expiresAt, clock.value + 120_000);
  assert.equal(Object.hasOwn(first, 'requestId'), false);
  clock.value = first.expiresAt - 1;
  const stillValid = await controller.remove('owner-a', { confirmation: first.confirmation });
  assert.equal(stillValid.receipt.state, 'complete');

  const expired = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  clock.value = expired.expiresAt;
  const removalsBeforeExpiry = calls.remove.length;
  await assert.rejects(() => controller.remove('owner-a', { confirmation: expired.confirmation }), error => assertError(error, 409, 'MEMORY_CONFIRMATION'));
  assert.equal(calls.remove.length, removalsBeforeExpiry);

  const owned = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  await assert.rejects(() => controller.remove('owner-b', { confirmation: owned.confirmation }), error => assertError(error, 409, 'MEMORY_CONFIRMATION'));
  await assert.rejects(() => controller.remove('owner-a', { confirmation: owned.confirmation, browserId: 'owner-b' }), error => assertError(error, 400));
  assert.equal(calls.owners.includes('owner-b'), false);
  const completed = await controller.remove('owner-a', { confirmation: owned.confirmation });
  assert.equal(completed.receipt.state, 'complete');
  await assert.rejects(() => controller.remove('owner-a', { confirmation: owned.confirmation }), error => assertError(error, 409, 'MEMORY_CONFIRMATION'));

  const raced = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  const removalsBeforeRace = calls.remove.length;
  const racedResults = await Promise.allSettled([
    controller.remove('owner-a', { confirmation: raced.confirmation }),
    controller.remove('owner-a', { confirmation: raced.confirmation }),
  ]);
  assert.equal(racedResults.filter(result => result.status === 'fulfilled').length, 1);
  assertError(racedResults.find(result => result.status === 'rejected').reason, 409, 'MEMORY_CONFIRMATION');
  assert.equal(calls.remove.length, removalsBeforeRace + 1);
});

test('a body edit with the same title and revision invalidates the preview fingerprint', async () => {
  const page = note({ title: 'Same title', summary: 'Same title', content: 'original body' });
  const { controller, calls, store } = setup({ pages: [page] });
  const preview = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  store.get(page.slug).content = 'edited body';
  const before = calls.remove.length;
  await assert.rejects(() => controller.remove('owner-a', { confirmation: preview.confirmation }), error => assertError(error, 409, 'MEMORY_CHANGED'));
  assert.equal(calls.remove.length, before);
  await assert.rejects(() => controller.remove('owner-a', { confirmation: preview.confirmation }), error => assertError(error, 409, 'MEMORY_CONFIRMATION'));
  assert.equal(calls.remove.length, before);
});

test('an incomplete purge is not counted as removal and does not block reimport', async () => {
  const cases = [
    { ok: false, status: 'purged', residuals: ['row remains'], receipt: { completion: 'complete' } },
    { ok: true, status: 'incomplete', residuals: ['index remains'], receipt: { completion: 'complete' } },
    { ok: true, status: 'purged', residuals: ['file remains'], message: 'fully removed from disk', receipt: { completion: 'incomplete' } },
  ];
  for (const nextRemove of cases) {
    const { controller, brain, calls, minted } = setup({ pages: [note()] });
    const preview = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
    const mintedBefore = minted.length;
    brain.nextRemove = nextRemove;
    const result = await controller.remove('owner-a', { confirmation: preview.confirmation });
    assert.equal(minted.length, mintedBefore);
    assert.equal(result.receipt.state, 'incomplete');
    assert.equal(result.receipt.removedCount, 0);
    assert.equal(result.receipt.reimportBlocked, false);
    assert.equal(result.receipt.residuals.includes(nextRemove.residuals[0]), true);
    assert.doesNotMatch(result.receipt.message, /fully removed|erased everywhere|permanently deleted|were removed/i);
    assert.equal(JSON.stringify(result).includes('fully removed from disk'), false);
    assert.equal(calls.remove[0].options.confirm, true);
    assert.equal(calls.remove[0].options.expectedRevision, 'rev-1');
    assert.equal(calls.remove[0].options.requestId, minted[0]);
  }
});

test('a completed purge forwards the preview request and blocks reimport only then', async () => {
  const { controller, calls, minted } = setup({
    pages: [note(), note({ slug: 'nemo-notes/other', title: 'Other', summary: 'other', revision: 'rev-other' })],
  });
  const preview = await controller.preview('owner-a', { scope: 'gbrain' }, true);
  assert.equal(minted.length, 1);
  const result = await controller.remove('owner-a', { confirmation: preview.confirmation });
  assert.equal(minted.length, 1);
  assert.equal(result.receipt.state, 'complete');
  assert.equal(result.receipt.removedCount, 2);
  assert.equal(result.receipt.reimportBlocked, true);
  assert.equal(result.receipt.residuals.includes('backup copy remains'), true);
  assert.equal(calls.remove.length, 2);
  assert.equal(calls.remove.every(call => call.options.requestId === minted[0] && call.options.confirm === true), true);
  assert.deepEqual(calls.remove.map(call => call.options.expectedRevision).sort(), ['rev-1', 'rev-other']);
  assert.equal(calls.forget.length, 0);
  assert.equal(calls.models, 0);
  assert.equal(calls.search, 0);
});

test('forget stays recoverable and does not claim permanent deletion', async () => {
  const { controller, calls, minted } = setup({ pages: [note()] });
  const preview = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'forget' });
  assert.match(preview.summary, /Stop recalling/);
  assert.match(preview.residuals.join('\n'), /recoverable/i);
  const mintedBefore = minted.length;
  const result = await controller.remove('owner-a', { confirmation: preview.confirmation });
  assert.equal(minted.length, mintedBefore);
  assert.equal(calls.forget.length, 1);
  assert.equal(calls.remove.length, 0);
  assert.equal(calls.forget[0].options.requestId, minted[0]);
  assert.equal(calls.forget[0].options.expectedRevision, 'rev-1');
  assert.equal(result.receipt.state, 'complete');
  assert.equal(result.receipt.reimportBlocked, false);
  assert.match(result.receipt.message, /recoverable/i);
  assert.match(result.receipt.residuals.join('\n'), /not permanently deleted/i);
  assert.doesNotMatch(result.receipt.message, /permanently deleted|fully removed|erased everywhere/i);
  assert.equal(result.receipt.residuals.includes('Recoverable GBrain history remains'), true);
});

test('chat deletion awaits clearChat once for this browser', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let finishClear;
  const { controller, calls } = setup({
    connected: false,
    clearChat(owner) {
      calls.clear.push(owner);
      return new Promise(resolve => {
        finishClear = resolve;
        started();
      });
    },
  });
  const preview = await controller.preview('owner-a', { id: 'nemo:chat', action: 'delete' });
  let settled = false;
  const pending = controller.remove('owner-a', { confirmation: preview.confirmation }).then(value => {
    settled = true;
    return value;
  });
  await entered;
  assert.equal(settled, false);
  assert.deepEqual(calls.clear, ['owner-a']);
  assert.equal(controller.busy(), true);
  finishClear();
  const result = await pending;
  assert.equal(settled, true);
  assert.deepEqual(calls.clear, ['owner-a']);
  assert.equal(result.receipt.state, 'complete');
  assert.equal(result.receipt.removedCount, 1);
  assert.equal(result.receipt.reimportBlocked, false);
});

test('a failed chat clear is incomplete and does not echo the thrown message', async () => {
  const { controller } = setup({
    connected: false,
    chats: { 'owner-a': { count: 1, content: 'ALPHA_TRANSCRIPT', revision: 'chat-a' } },
    async clearChat() { throw new Error('C:\\secret\\chat.json'); },
  });
  const preview = await controller.preview('owner-a', { id: 'nemo:chat', action: 'delete' });
  const result = await controller.remove('owner-a', { confirmation: preview.confirmation });
  assert.equal(result.receipt.state, 'incomplete');
  assert.equal(result.receipt.removedCount, 0);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('chat.json'), false);
});

test('a disconnected or failing GBrain still lists this browser chat and calendar', async () => {
  const events = [{ id: EVENT_ID, title: 'Dentist visit', start: '2026-10-21T09:00:00+11:00', end: '2026-10-21T10:00:00+11:00', allDay: false }];
  const disconnected = setup({ connected: false, events });
  const listed = await disconnected.controller.list('owner-a', new URLSearchParams());
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.items.map(item => item.kind).sort(), ['calendar', 'chat']);
  assert.equal(listed.stores.find(item => item.id === 'gbrain').connected, false);
  assert.equal(disconnected.calls.listArgs.length, 0);
  assert.equal(disconnected.calls.search, 0);
  assert.equal(JSON.stringify(listed).includes('ALPHA_TRANSCRIPT'), false);

  const failing = setup({ statusError: new Error('connect failed C:\\NemoTest\\brain'), events });
  const fallback = await failing.controller.list('owner-a', new URLSearchParams());
  assert.equal(fallback.items.some(item => item.kind === 'chat'), true);
  assert.equal(fallback.items.some(item => item.kind === 'calendar'), true);
  assert.equal(JSON.stringify(fallback).includes('secret'), false);
  assert.equal(JSON.stringify(fallback).includes('Users'), false);
});

test('bulk clear refuses when saved notes continue past the 2000 item cap', async () => {
  const { controller, calls } = setup({ virtualTotal: 2500 });
  const listed = await controller.list('owner-a', new URLSearchParams('limit=50'));
  assert.equal(calls.listArgs.length, 20);
  assert.equal(listed.totals.gbrain, 2000);
  assert.equal(listed.hasMore, true);
  assert.equal(listed.items.length, 50);
  assert.equal(JSON.stringify(listed).includes('SECRET_BODY'), false);
  assert.equal(calls.get, 0);
  await assert.rejects(() => controller.preview('owner-a', { scope: 'all' }, true), error => assertError(error, 409, 'MEMORY_PARTIAL'));
  await assert.rejects(() => controller.preview('owner-a', { scope: 'gbrain' }, true), error => assertError(error, 409, 'MEMORY_PARTIAL'));
  assert.equal(calls.get, 0);
  assert.equal(controller.busy(), false);
  const chatPreview = await controller.preview('owner-a', { scope: 'chat' }, true);
  assert.equal(chatPreview.affectedCount, 1);
  const one = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/n0', action: 'delete' });
  assert.equal(one.affectedCount, 1);
  assert.equal(calls.get, 1);
});

test('calendar deletion uses the stored event id and explains that a revised copy can return', async () => {
  const { controller, calendarState } = setup({
    connected: false,
    events: [{ id: EVENT_ID, title: 'Dentist visit', start: '2026-10-21T09:00:00+11:00', end: '2026-10-21T10:00:00+11:00', allDay: false }],
  });
  const preview = await controller.preview('owner-a', { id: `nemo:calendar:${EVENT_ID}`, action: 'delete' });
  assert.match(preview.residuals.join('\n'), /phone originals are unchanged/i);
  assert.match(preview.residuals.join('\n'), /revised event can reappear as a new copy/i);
  const result = await controller.remove('owner-a', { confirmation: preview.confirmation });
  assert.deepEqual(calendarState.removed, [[EVENT_ID]]);
  assert.equal(result.receipt.state, 'complete');
  assert.equal(result.receipt.removedCount, 1);
  assert.equal(result.receipt.reimportBlocked, true);
  assert.match(result.receipt.residuals.join('\n'), /phone originals are unchanged/i);
  assert.match(result.receipt.residuals.join('\n'), /revised event can reappear as a new copy/i);
  assert.doesNotMatch(result.receipt.message, /erased everywhere|fully removed/i);
});

test('saving a note enforces length limits, edits the previewed revision, and does not call a model', async () => {
  let sawBusy = false;
  const harness = setup({
    onSave() { sawBusy = harness.controller.busy(); },
  });
  const { controller, calls } = harness;
  await assert.rejects(() => controller.save('owner-a', { title: 'x'.repeat(121), content: 'ok' }), error => assertError(error, 400));
  await assert.rejects(() => controller.save('owner-a', { title: 'ok', content: 'y'.repeat(8001) }), error => assertError(error, 400));
  await assert.rejects(() => controller.save('owner-a', { title: 'ok', content: 'text', browserId: 'owner-b' }), error => assertError(error, 400));
  assert.equal(calls.save.length, 0);
  const created = await controller.save('owner-a', { title: 'x'.repeat(120), content: 'y'.repeat(8000) });
  assert.equal(created.ok, true);
  assert.equal(created.item.id, 'gbrain:nemo-notes/saved-1');
  assert.equal(calls.save[0].title.length, 120);
  assert.equal(calls.save[0].content.length, 8000);
  assert.equal(Object.hasOwn(calls.save[0], 'slug'), false);
  assert.equal(sawBusy, true);
  assert.equal(calls.search, 0);
  assert.equal(calls.models, 0);
  await assert.rejects(
    () => controller.save('owner-a', { id: created.item.id, title: 'Updated', content: 'Body', revision: 'stale' }, true),
    error => assertError(error, 409, 'MEMORY_CHANGED'),
  );
  assert.equal(calls.save.length, 1);
  const updated = await controller.save('owner-a', { id: created.item.id, title: 'Updated', content: 'Body', revision: 'rev-saved' }, true);
  assert.equal(updated.item.revision, 'rev-2');
  assert.equal(calls.save[1].slug, 'nemo-notes/saved-1');
  assert.equal(calls.save[1].expectedRevision, 'rev-saved');
  await assert.rejects(
    () => controller.save('owner-a', { id: 'nemo:chat', title: 'Nope', content: 'Nope', revision: 'chat-a' }, true),
    error => assertError(error, 400),
  );
});

test('the confirmation map holds 100 entries and drops the oldest after that', async () => {
  const firstBatch = setup({ connected: false, chats: { 'owner-a': { count: 1, content: 'ALPHA_TRANSCRIPT', revision: 'chat-a' } } });
  const kept = [];
  for (let index = 0; index < 100; index += 1) kept.push((await firstBatch.controller.preview('owner-a', { id: 'nemo:chat', action: 'delete' })).confirmation);
  const removed = await firstBatch.controller.remove('owner-a', { confirmation: kept[0] });
  assert.equal(removed.receipt.state, 'complete');

  const secondBatch = setup({ connected: false, chats: { 'owner-a': { count: 1, content: 'ALPHA_TRANSCRIPT', revision: 'chat-a' } } });
  const overflow = [];
  for (let index = 0; index < 101; index += 1) overflow.push((await secondBatch.controller.preview('owner-a', { id: 'nemo:chat', action: 'delete' })).confirmation);
  await assert.rejects(() => secondBatch.controller.remove('owner-a', { confirmation: overflow[0] }), error => assertError(error, 409, 'MEMORY_CONFIRMATION'));
  const latest = await secondBatch.controller.remove('owner-a', { confirmation: overflow[100] });
  assert.equal(latest.receipt.state, 'complete');
  assert.deepEqual(secondBatch.calls.clear, ['owner-a']);
});

test('assertIdle is the first lock step and a refusal does not wedge the next write', async () => {
  const order = [];
  let block = true;
  const harness = setup({
    assertIdle() {
      order.push('idle');
      assert.equal(harness.controller.busy(), true);
      if (block) throw new MemoryError(409, 'A reply is still running.', 'MEMORY_BUSY');
    },
    onSave() { order.push('save'); },
  });
  await assert.rejects(() => harness.controller.save('owner-a', { title: 'Title', content: 'Body' }), error => assertError(error, 409, 'MEMORY_BUSY'));
  assert.equal(harness.controller.busy(), false);
  assert.deepEqual(order, ['idle']);
  block = false;
  await harness.controller.save('owner-a', { title: 'Title', content: 'Body' });
  assert.deepEqual(order, ['idle', 'idle', 'save']);
  assert.equal(harness.controller.busy(), false);
});

test('exclusive lock holds across an awaited gbrain.remove so a second caller sees busy', async () => {
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let idle = 0;
  const harness = setup({
    pages: [note()],
    assertIdle() { idle += 1; },
    async onRemove() {
      entered();
      await new Promise(resolve => { release = resolve; });
    },
  });
  const { controller } = harness;
  const preview = await controller.preview('owner-a', { id: 'gbrain:nemo-notes/note', action: 'delete' });
  const idleAtPreview = idle;
  let settled = false;
  const pending = controller.remove('owner-a', { confirmation: preview.confirmation }).then(value => {
    settled = true;
    return value;
  });
  await enteredPromise;
  assert.equal(controller.busy(), true);
  assert.equal(settled, false);
  let secondStarted = false;
  const second = controller.exclusive(async () => { secondStarted = true; });
  await tick();
  assert.equal(secondStarted, false);
  assert.equal(idle, idleAtPreview + 1);
  assert.equal(controller.busy(), true);
  release();
  const result = await pending;
  await second;
  assert.equal(secondStarted, true);
  assert.equal(idle, idleAtPreview + 2);
  assert.equal(controller.busy(), false);
  assert.equal(result.receipt.state, 'complete');
  assert.equal(settled, true);
});
