import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalendarStore } from '../lib/calendar.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-20T00:00:00Z');
const iso = time => new Date(time).toISOString();
const event = (title, start, end = start + HOUR) => ({ title, start: iso(start), end: iso(end), allDay: false });

async function fixture(t, events = []) {
  const prefix = fileURLToPath(new URL('./.tmp-calendar-query-', import.meta.url));
  const dataDir = await mkdtemp(prefix);
  t.after(async () => {
    const target = resolve(dataDir);
    assert.equal(dirname(target), dirname(resolve(prefix)));
    assert.ok(basename(target).startsWith(basename(prefix)) && target !== resolve(prefix));
    await rm(target, { recursive: true, force: true });
  });
  let clock = NOW;
  const calendar = await createCalendarStore({ dataDir, now: () => clock });
  const token = await calendar.issueToken();
  const upload = values => calendar.importSnapshot({ rangeStart: iso(NOW - DAY), rangeEnd: iso(NOW + 6 * DAY), timeZone: 'Australia/Sydney', events: values }, token);
  await upload(events);
  return { calendar, upload, setClock: value => { clock = value; } };
}

test('calendar queries use half-open windows, real time offsets, literal title filtering and stable order', async t => {
  const values = [
    event('Meeting already ended', NOW, NOW + HOUR),
    event('Meeting at opening', NOW + HOUR, NOW + 2 * HOUR),
    event('Meeting overlapping', NOW + HOUR / 2, NOW + 1.5 * HOUR),
    event('Meeting at closing', NOW + 2 * HOUR, NOW + 3 * HOUR),
    event('Meeting point opening', NOW + HOUR, NOW + HOUR),
    event('Meeting point closing', NOW + 2 * HOUR, NOW + 2 * HOUR),
    { title: 'Holiday', start: '2026-10-20T00:00:00+11:00', end: '2026-10-21T00:00:00+11:00', allDay: true },
    event('Meet.* literal', NOW + HOUR),
  ];
  const { calendar } = await fixture(t, values);
  const input = { start: '2026-10-20T12:00:00+11:00', end: '2026-10-20T13:00:00+11:00', titleContains: '  MEETING  ' };
  const result = calendar.read(input);
  assert.deepEqual(new Set(result.events.map(item => item.title)), new Set(['Meeting at opening', 'Meeting overlapping', 'Meeting point opening']));
  assert.equal(result.events[0].title, 'Meeting overlapping');
  assert.equal(result.matchedCount, 3);
  assert.equal(result.returnedCount, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.requestedWindow.start, input.start);
  assert.equal(calendar.read({ ...input, titleContains: 'Meet.*' }).events[0].title, 'Meet.* literal', 'titleContains is a literal substring, not regex');
  const full = calendar.read({ start: input.start, end: input.end });
  assert.equal(full.events[0].allDay, true);
  assert.equal(full.events[0].start, values[6].start, 'Returned offsets are preserved');
});

test('default selection is small and reports matched results beyond its limit', async t => {
  const values = Array.from({ length: 25 }, (_, index) => event(`Appointment ${index}`, NOW + (index + 1) * 1000));
  const { calendar } = await fixture(t, values);
  const result = calendar.read();
  assert.equal(result.events.length, 20);
  assert.equal(result.matchedCount, 25);
  assert.equal(result.returnedCount, 20);
  assert.equal(result.hasMore, true);
  assert.equal(calendar.read({ limit: 200 }).events.length, 25);
  assert.equal(calendar.read({ limit: 200 }).hasMore, false);
});

test('conditional revision omits repeated events only when the caller supplies the exact matching selection revision', async t => {
  const { calendar, setClock } = await fixture(t, [event('Tomorrow appointment', NOW + DAY)]);
  const first = calendar.read({ limit: 1 });
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.unchanged, false);
  setClock(NOW + 1000);
  const fresh = calendar.read({ limit: 1 });
  assert.equal(fresh.revision, first.revision, 'Advancing milliseconds with the same selection does not invalidate it');
  assert.equal(fresh.events.length, 1, 'New AI contexts receive full data without an explicit ifRevision');
  const conditional = calendar.read({ limit: 1, ifRevision: first.revision });
  assert.equal(conditional.unchanged, true);
  assert.equal(Object.hasOwn(conditional, 'events'), false, 'Omitted events cannot be mistaken for an empty calendar');
  assert.equal(conditional.returnedCount, 0);
  assert.equal(conditional.matchedCount, 1);
  assert.match(conditional.note, /Reuse the earlier result/);
  const changedQuery = calendar.read({ limit: 1, titleContains: 'missing', ifRevision: first.revision });
  assert.equal(changedQuery.unchanged, false);
  assert.equal(changedQuery.events.length, 0);
  assert.notEqual(changedQuery.revision, first.revision);
  const changedLimit = calendar.read({ limit: 2, ifRevision: first.revision });
  assert.equal(changedLimit.unchanged, false);
  assert.equal(changedLimit.events.length, 1);
});

test('resyncs, changed/deleted events and disconnect invalidate old revisions without retaining private results', async t => {
  const values = [event('Fixture one', NOW + DAY)];
  const { calendar, upload } = await fixture(t, values);
  const first = calendar.read();
  await upload(values);
  const resynced = calendar.read({ ifRevision: first.revision });
  assert.equal(resynced.unchanged, false, 'Even an identical sync at the same test clock is a new snapshot');
  assert.notEqual(resynced.revision, first.revision);
  await upload([event('Fixture two', NOW + DAY)]);
  const changed = calendar.read({ ifRevision: resynced.revision });
  assert.equal(changed.events[0].title, 'Fixture two');
  assert.equal(changed.unchanged, false);
  await upload([]);
  const deleted = calendar.read({ ifRevision: changed.revision });
  assert.deepEqual(deleted.events, []);
  assert.equal(deleted.unchanged, false);
  await calendar.disconnect();
  const disconnected = calendar.read({ ifRevision: deleted.revision });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.unchanged, false);
  assert.deepEqual(disconnected.events, []);
  assert.notEqual(disconnected.revision, deleted.revision);
});

test('calendar coverage distinguishes an empty known window from unknown dates and stale snapshots', async t => {
  const { calendar, setClock } = await fixture(t, []);
  const known = calendar.read({ start: iso(NOW + HOUR), end: iso(NOW + 2 * HOUR) });
  assert.equal(known.coverage.complete, true);
  assert.deepEqual(known.events, []);
  const unavailable = calendar.read({ start: iso(NOW + 10 * DAY), end: iso(NOW + 11 * DAY) });
  assert.equal(unavailable.coverage.complete, false);
  assert.equal(unavailable.coverage.windowCovered, false);
  assert.equal(unavailable.coverage.reason, 'outside_snapshot');
  assert.match(unavailable.note, /unknown/);
  setClock(NOW + 2 * DAY);
  const stale = calendar.read({ start: iso(NOW + 3 * DAY), end: iso(NOW + 4 * DAY) });
  assert.equal(stale.coverage.windowCovered, true);
  assert.equal(stale.coverage.complete, false);
  assert.equal(stale.coverage.reason, 'stale_snapshot');
  assert.match(stale.note, /Refresh/);
  setClock(NOW + 10 * DAY);
  const expired = calendar.read();
  assert.equal(expired.coverage.complete, false);
  assert.equal(expired.stale, true);
  assert.deepEqual(expired.events, []);
});

test('event expiry and a stale transition invalidate a conditional revision', async t => {
  const { calendar, setClock } = await fixture(t, [event('Short appointment', NOW + HOUR, NOW + 2 * HOUR)]);
  const first = calendar.read();
  setClock(NOW + 2 * HOUR);
  const ended = calendar.read({ ifRevision: first.revision });
  assert.equal(ended.unchanged, false);
  assert.deepEqual(ended.events, []);
  const emptyRevision = ended.revision;
  setClock(NOW + DAY + 1);
  const stale = calendar.read({ ifRevision: emptyRevision });
  assert.equal(stale.unchanged, false);
  assert.equal(stale.stale, true);
});

test('invalid calendar arguments fail before reading and cannot silently normalize dates', async t => {
  const { calendar } = await fixture(t, [event('Fixture appointment', NOW + HOUR)]);
  const invalid = [null, [], 'bad', { command: 'run' }, { limit: undefined }, { limit: null }, { limit: true },
    { start: null }, { end: '2026-10-20T10:00:00' }, { start: '2026-02-30T12:00:00Z' }, { start: '2026-10-20T24:00:00Z' },
    { start: '0000-01-01T00:00:00Z' }, { start: '2026-10-20T10:00:00+24:00' },
    { start: iso(NOW + HOUR), end: iso(NOW) }, { start: iso(NOW), end: iso(NOW) },
    { titleContains: '' }, { titleContains: '   ' }, { titleContains: 'x\n' }, { titleContains: 2 }, { titleContains: 'x'.repeat(161) },
    { ifRevision: null }, { ifRevision: 'x'.repeat(64) }, { ifRevision: 'a'.repeat(63) }, { ifRevision: 'A'.repeat(64) }];
  for (const input of invalid) assert.throws(() => calendar.read(input), { status: 400 }, JSON.stringify(input));
  assert.equal(calendar.read({ start: '2028-02-29T00:00:00Z', end: '2028-03-01T00:00:00Z' }).coverage.complete, false, 'Real leap days are valid queries, even when outside the snapshot');
  await calendar.disconnect();
  assert.throws(() => calendar.read({ titleContains: '' }), { status: 400 }, 'Disconnected stores still reject invalid arguments');
});
