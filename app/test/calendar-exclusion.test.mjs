import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCalendarStore } from '../lib/calendar.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-20T00:00:00Z');
const iso = time => new Date(time).toISOString();
const WINDOW = { rangeStart: iso(NOW - DAY), rangeEnd: iso(NOW + 6 * DAY), timeZone: 'Australia/Sydney' };

async function tempDirectory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-calendar-exclusion-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function event(title, start = NOW + HOUR, end = start + HOUR) {
  return { title, start: iso(start), end: iso(end), allDay: false };
}

test('excluded event ids persist, block the same upload, and allow an edited event', async t => {
  const dataDir = await tempDirectory(t);
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const token = await calendar.issueToken();
  const dentist = event('Dentist visit');
  const lunch = event('Lunch', NOW + 3 * HOUR);
  const upload = (events, store = calendar, uploadToken = token) => store.importSnapshot({ ...WINDOW, events }, uploadToken);
  await upload([dentist, lunch]);
  const first = calendar.inventory();
  const dentistId = first.events.find(item => item.title === 'Dentist visit').id;
  const lunchId = first.events.find(item => item.title === 'Lunch').id;
  assert.match(dentistId, /^[a-f0-9]{24}$/);
  assert.equal(first.excludedCount, 0);

  const removed = await calendar.removeStoredEvents([dentistId]);
  assert.equal(removed.removedCount, 1);
  assert.equal(removed.reimportBlocked, true);
  assert.deepEqual(calendar.inventory().events.map(item => item.id), [lunchId]);
  assert.equal(calendar.inventory().excludedCount, 1);

  const reopened = await createCalendarStore({ dataDir, now: () => NOW });
  assert.equal(reopened.validToken(token), true);
  assert.deepEqual(reopened.inventory().events.map(item => item.title), ['Lunch']);
  assert.equal(reopened.inventory().excludedCount, 1);
  await upload([dentist, lunch], reopened);
  assert.deepEqual(reopened.inventory().events.map(item => item.title), ['Lunch']);
  assert.equal(reopened.read().events.some(item => item.title === 'Dentist visit'), false);

  const edited = event('Dentist follow up');
  await upload([dentist, edited, lunch], reopened);
  const afterEdit = reopened.inventory();
  assert.deepEqual(afterEdit.events.map(item => item.title).sort(), ['Dentist follow up', 'Lunch']);
  assert.equal(afterEdit.events.some(item => item.id === dentistId), false);
  assert.notEqual(afterEdit.events.find(item => item.title === 'Dentist follow up').id, dentistId);
  assert.equal(afterEdit.excludedCount, 1);
  const stored = await readFile(join(dataDir, 'calendar.json'), 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes('Dentist visit'), false);
  assert.equal(stored.includes(dentistId), true);

  const disconnected = await reopened.disconnect();
  assert.equal(disconnected.connected, false);
  assert.equal(reopened.inventory().events.length, 0);
  assert.equal(reopened.inventory().excludedCount, 1);
  const cleared = JSON.parse(await readFile(join(dataDir, 'calendar.json'), 'utf8'));
  assert.equal(cleared.snapshot, null);
  assert.equal(cleared.tokenHash, null);
  assert.deepEqual(cleared.excludedEventIds, [dentistId]);

  const retained = await createCalendarStore({ dataDir, now: () => NOW });
  assert.equal(retained.inventory().excludedCount, 1);
  assert.deepEqual(retained.inventory().events, []);
  const nextToken = await retained.issueToken();
  await upload([dentist], retained, nextToken);
  assert.deepEqual(retained.inventory().events, []);
  assert.equal(retained.inventory().excludedCount, 1);
  await upload([edited], retained, nextToken);
  assert.equal(retained.inventory().events.length, 1);
  assert.equal(retained.inventory().events[0].title, 'Dentist follow up');
  assert.notEqual(retained.inventory().events[0].id, dentistId);
});

test('a corrupt exclusion list fails closed and a failed reload keeps the previous list', async t => {
  const dataDir = await tempDirectory(t);
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const token = await calendar.issueToken();
  await calendar.importSnapshot({ ...WINDOW, events: [event('Dentist visit')] }, token);
  const dentistId = calendar.inventory().events[0].id;
  await calendar.removeStoredEvents([dentistId]);
  assert.equal(calendar.inventory().excludedCount, 1);
  const good = 'a'.repeat(24);
  const corruptions = [
    ['nope'],
    'abc',
    null,
    { 0: good },
    [good, 'B'.repeat(24)],
    [good, 'short'],
    [good, null],
    Array.from({ length: 10_001 }, (_, index) => index.toString(16).padStart(24, '0')),
  ];
  const corruptDir = await tempDirectory(t);
  for (const excludedEventIds of corruptions) {
    const body = JSON.stringify({ version: 1, tokenHash: null, tokenExpiresAt: null, snapshot: null, excludedEventIds });
    const file = join(corruptDir, 'calendar.json');
    await writeFile(file, body);
    await assert.rejects(() => createCalendarStore({ dataDir: corruptDir, now: () => NOW }), /could not be read/);
    assert.equal(await readFile(file, 'utf8'), body);
  }
  const marker = 'not-an-id';
  const broken = JSON.stringify({ version: 1, tokenHash: null, tokenExpiresAt: null, snapshot: null, excludedEventIds: [marker] });
  await writeFile(join(dataDir, 'calendar.json'), broken);
  await assert.rejects(() => calendar.reload(), /could not be read/);
  assert.equal(calendar.inventory().excludedCount, 1);
  assert.equal(calendar.inventory().events.length, 0);
  assert.equal(await readFile(join(dataDir, 'calendar.json'), 'utf8'), broken);
  await assert.rejects(() => createCalendarStore({ dataDir, now: () => NOW }), error => {
    assert.match(error.message, /could not be read/);
    assert.equal(error.message.includes(marker), false);
    return true;
  });
});

test('a version-1 snapshot without generation or exclusions still loads', async t => {
  const dataDir = await tempDirectory(t);
  const legacyId = 'cd'.repeat(12);
  const legacy = {
    version: 1, tokenHash: null, tokenExpiresAt: null,
    snapshot: {
      events: [{ id: 'legacy-1', title: 'Legacy focus', start: '2026-10-20T01:00:00Z', end: '2026-10-20T02:00:00Z', allDay: false }],
      rangeStart: WINDOW.rangeStart, rangeEnd: WINDOW.rangeEnd, timeZone: 'Australia/Sydney', syncedAt: new Date(NOW).toISOString(),
    },
  };
  await writeFile(join(dataDir, 'calendar.json'), JSON.stringify(legacy));
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const read = calendar.read({ start: '2026-10-20T01:00:00Z', end: '2026-10-20T02:00:00Z' });
  assert.equal(read.connected, true);
  assert.equal(read.events[0].title, 'Legacy focus');
  assert.equal(calendar.inventory().generation, null);
  assert.equal(calendar.inventory().excludedCount, 0);

  const withExclusion = {
    ...legacy,
    excludedEventIds: [legacyId],
    snapshot: { ...legacy.snapshot, events: [{ ...legacy.snapshot.events[0], id: 'ef'.repeat(12), title: 'Still visible' }] },
  };
  delete withExclusion.snapshot.generation;
  await writeFile(join(dataDir, 'calendar.json'), JSON.stringify(withExclusion));
  const reloaded = await createCalendarStore({ dataDir, now: () => NOW });
  assert.equal(reloaded.inventory().excludedCount, 1);
  assert.equal(reloaded.inventory().generation, null);
  assert.equal(reloaded.inventory().events[0].title, 'Still visible');
});

test('the exclusion cap refuses another id without dropping the ones already stored', async t => {
  const dataDir = await tempDirectory(t);
  const calendar = await createCalendarStore({ dataDir, now: () => NOW });
  const ids = Array.from({ length: 10_000 }, (_, index) => index.toString(16).padStart(24, '0'));
  const removed = await calendar.removeStoredEvents(ids);
  assert.equal(removed.removedCount, 0);
  assert.equal(calendar.inventory().excludedCount, 10_000);
  const extra = 'f'.repeat(24);
  await assert.rejects(() => calendar.removeStoredEvents([extra]), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /exclusion limit/);
    return true;
  });
  assert.equal(calendar.inventory().excludedCount, 10_000);
  const reopened = await createCalendarStore({ dataDir, now: () => NOW });
  assert.equal(reopened.inventory().excludedCount, 10_000);
  const raw = await readFile(join(dataDir, 'calendar.json'), 'utf8');
  assert.equal(raw.includes(extra), false);
});
