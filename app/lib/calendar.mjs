import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const iso = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
// Date.parse normalizes impossible dates and 24:00. Query arguments must agree
// with Hermes's execution guard rather than silently selecting a different day.
const queryIso = value => {
  if (!iso(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
};
const EVENT_ID = /^[a-f0-9]{24}$/;
// Version-1 files may omit generation. excludedEventIds is optional, but a
// present list that is not an array of at most 10000 lowercase 24-hex ids
// fails the read. Treating a corrupt list as empty would restore deleted copies.
function validStore(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1) return false;
  if (saved.tokenHash !== null && !/^[a-f0-9]{64}$/.test(saved.tokenHash)) return false;
  if (!Object.hasOwn(saved, 'excludedEventIds')) return true;
  const ids = saved.excludedEventIds;
  if (!Array.isArray(ids) || ids.length > 10_000) return false;
  return ids.every(id => typeof id === 'string' && EVENT_ID.test(id));
}

// A personal-PC snapshot shared with paired devices. This credential can upload
// calendar data only; it cannot read chat/mail, pair a browser, or run an agent.
export async function createCalendarStore({ dataDir, now = () => Date.now() }) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'calendar.json');
  let state = { version: 1, tokenHash: null, tokenExpiresAt: null, snapshot: null };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (!validStore(saved)) throw new Error('Invalid calendar store');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Calendar storage could not be read. Preserve calendar.json before repairing it.'); }
  let chain = Promise.resolve();
  async function mutate(next) {
    const operation = chain.catch(() => {}).then(async () => {
      const draft = next(state);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 });
      await rename(temporary, path);
      state = draft;
    });
    chain = operation;
    return operation;
  }
  function validToken(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '') || !state.tokenHash || state.tokenExpiresAt <= now()) return false;
    return timingSafeEqual(Buffer.from(digest(token)), Buffer.from(state.tokenHash));
  }
  function status() {
    return { connected: !!state.snapshot, count: state.snapshot?.events.length || 0, lastSyncedAt: state.snapshot?.syncedAt || null,
      windowEnd: state.snapshot?.rangeEnd || null, tokenActive: !!state.tokenHash && state.tokenExpiresAt > now(), tokenExpiresAt: state.tokenExpiresAt };
  }
  return {
    status,
    validToken,
    async reload() {
      const operation = chain.catch(() => {}).then(async () => {
        try {
          const saved = JSON.parse(await readFile(path, 'utf8'));
          if (!validStore(saved)) throw new Error('Invalid calendar store');
          state = saved;
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('Calendar storage could not be read.');
          state = { version: 1, tokenHash: null, tokenExpiresAt: null, snapshot: null };
        }
        return status();
      });
      chain = operation;
      return operation;
    },
    async issueToken() {
      const token = randomBytes(32).toString('hex');
      await mutate(current => ({ ...current, tokenHash: digest(token), tokenExpiresAt: now() + 30 * DAY }));
      return token;
    },
    async importSnapshot(input, token) {
      if (!validToken(token)) { const error = new Error('Calendar upload credential is invalid or expired. Create a new one in Nemo.'); error.status = 401; throw error; }
      if (!input || !Array.isArray(input.events) || input.events.length > 200) fail('Send an events array with at most 200 events.');
      const rangeStart = input.rangeStart ?? new Date(now()).toISOString();
      const rangeEnd = input.rangeEnd ?? new Date(now() + 7 * DAY).toISOString();
      if (!iso(rangeStart) || !iso(rangeEnd) || Date.parse(rangeEnd) <= Date.parse(rangeStart) || Date.parse(rangeEnd) - Date.parse(rangeStart) > 8 * DAY || Math.abs(Date.parse(rangeStart) - now()) > 2 * DAY) fail('Use a current calendar window of at most eight days, with ISO dates including a time zone.');
      const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      try { if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error(); new Intl.DateTimeFormat('en', { timeZone }); }
      catch { fail('Calendar timeZone must be an IANA time zone, such as Australia/Sydney.'); }
      const events = input.events.map((item, index) => {
        // Return field names and positions only, never private event values.
        const at = `Event ${index + 1}`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${at}: expected an event dictionary. Use the whole Events list as the events value, without wrapping it in another list.`);
        if (typeof item.title !== 'string') fail(`${at}: title must be text. Check the lowercase title key and select Repeat Item's Title property.`);
        if (!item.title.trim()) fail(`${at}: title is empty. Supply a title for this event.`);
        if (item.title.length > 240 || item.title.includes('\0')) fail(`${at}: title must be at most 240 characters and contain no null characters.`);
        for (const field of ['start', 'end']) {
          if (typeof item[field] !== 'string') fail(`${at}: ${field} must be formatted date text. Connect the matching Format Date output to the lowercase ${field} key.`);
          if (!iso(item[field])) fail(`${at}: ${field} must be an ISO date with seconds and a time zone, such as 2026-10-21T09:00:00+11:00. Set Format Date to Custom: yyyy-MM-dd'T'HH:mm:ssXXX.`);
        }
        if (Date.parse(item.end) < Date.parse(item.start)) fail(`${at}: end is earlier than start. Check that each field uses the matching event date.`);
        if (item.allDay !== undefined && typeof item.allDay !== 'boolean') fail(`${at}: optional allDay must be a Boolean, not text. Omit that field if it is not configured.`);
        if (Date.parse(item.start) >= Date.parse(rangeEnd) || Date.parse(item.end) < Date.parse(rangeStart)) fail('An event falls outside the calendar snapshot window.');
        const event = { title: item.title.trim(), start: item.start, end: item.end, allDay: item.allDay ?? false };
        return { id: digest(JSON.stringify(event)).slice(0, 24), ...event };
      });
      const unique = [...new Map(events.map(item => [item.id, item])).values()].sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
      await mutate(current => {
        // Check again inside the serialized transaction: rotation/revocation wins
        // over an in-flight import carrying an old credential.
        if (!validToken(token)) { const error = new Error('Calendar upload credential was revoked.'); error.status = 401; throw error; }
        const excluded = new Set(current.excludedEventIds || []);
        return { ...current, snapshot: { events: unique.filter(item => !excluded.has(item.id)), rangeStart, rangeEnd, timeZone, syncedAt: new Date(now()).toISOString(), generation: randomBytes(16).toString('hex') } };
      });
      return status();
    },
    read(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['limit', 'start', 'end', 'titleContains', 'ifRevision'].includes(key))) fail('Use calendar limit, start/end, titleContains, or ifRevision arguments only.');
      const limit = Object.hasOwn(input, 'limit') ? input.limit : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('Calendar limit must be 1–200.');
      for (const field of ['start', 'end']) {
        if (Object.hasOwn(input, field) && !queryIso(input[field])) fail(`Calendar ${field} must be a valid ISO date with seconds and a time zone.`);
      }
      if (Object.hasOwn(input, 'start') && Object.hasOwn(input, 'end') && Date.parse(input.end) <= Date.parse(input.start)) fail('Calendar end must be after start.');
      if (Object.hasOwn(input, 'titleContains') && (typeof input.titleContains !== 'string' || !input.titleContains.trim()
        || input.titleContains.length > 160 || /[\x00-\x1f\x7f]/.test(input.titleContains))) fail('Calendar titleContains must be 1–160 characters of text without control characters.');
      if (Object.hasOwn(input, 'ifRevision') && (typeof input.ifRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.ifRevision))) fail('Calendar ifRevision must be a revision returned by this tool.');
      const clock = now();
      const requestedWindow = { start: input.start ?? new Date(clock).toISOString(), end: input.end ?? state.snapshot?.rangeEnd ?? null };
      // Use semantic query inputs in the revision rather than the moving default
      // clock. The revision still changes when eligible events or freshness do.
      const query = { limit, start: input.start ? new Date(input.start).toISOString() : null,
        end: input.end ? new Date(input.end).toISOString() : null, titleContains: input.titleContains?.trim().toLowerCase() ?? null };
      if (!state.snapshot) return { connected: false, unchanged: false, revision: digest(JSON.stringify({ connected: false, query })),
        requestedWindow, coverage: { complete: false, windowCovered: false, snapshotStart: null, snapshotEnd: null, reason: 'not_synced' },
        events: [], matchedCount: 0, returnedCount: 0, hasMore: false, total: 0, note: 'Calendar has not been synced; no conclusions can be drawn about your actual schedule.' };
      const { events, generation, ...metadata } = state.snapshot;
      const from = Date.parse(requestedWindow.start);
      const until = Date.parse(requestedWindow.end);
      const stale = clock - Date.parse(metadata.syncedAt) > DAY || Date.parse(metadata.rangeEnd) < clock;
      const windowCovered = until > from && from >= Date.parse(metadata.rangeStart) && until <= Date.parse(metadata.rangeEnd);
      const coverage = { complete: windowCovered && !stale, windowCovered, snapshotStart: metadata.rangeStart, snapshotEnd: metadata.rangeEnd,
        reason: stale ? 'stale_snapshot' : windowCovered ? null : 'outside_snapshot' };
      const matching = events.filter(item => {
        const eventStart = Date.parse(item.start), eventEnd = Date.parse(item.end);
        // Windows are [start, end). A zero-duration event belongs to the window
        // containing its instant; an event ending at the start is already over.
        const overlaps = eventStart === eventEnd ? eventStart >= from && eventStart < until : eventEnd > from && eventStart < until;
        return until > from && overlaps && (!query.titleContains || item.title.toLowerCase().includes(query.titleContains));
      }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
      const selected = matching.slice(0, limit);
      const revision = digest(JSON.stringify({ snapshot: state.snapshot, query, stale, windowCovered, selected, matchedCount: matching.length }));
      const result = { connected: true, ...metadata, stale, requestedWindow, coverage, revision,
        matchedCount: matching.length, returnedCount: selected.length, hasMore: matching.length > selected.length, total: events.length };
      if (input.ifRevision === revision) return { ...result, unchanged: true, returnedCount: 0,
        note: 'This selection is unchanged. Reuse the earlier result with this revision; omitted events do not mean an empty calendar.' };
      return { ...result, unchanged: false, events: selected.map(item => ({ ...item })),
        ...(!coverage.complete ? { note: stale
          ? 'This is a stale phone-supplied snapshot. Refresh the iPhone Shortcut before relying on it; events outside the supplied window are unknown.'
          : 'The requested window extends beyond the phone-supplied snapshot. Returned events cover only available data; missing events outside that window are unknown.' } : {}) };
    },
    inventory() {
      const snapshot = state.snapshot;
      return { events: snapshot ? snapshot.events.map(item => ({ ...item })) : [],
        syncedAt: snapshot?.syncedAt || null, generation: snapshot?.generation || null,
        excludedCount: Array.isArray(state.excludedEventIds) ? state.excludedEventIds.length : 0 };
    },
    async removeStoredEvents(ids) {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !EVENT_ID.test(id))) fail('Select valid stored calendar events.');
      let removedCount = 0;
      await mutate(current => {
        const removed = new Set(ids);
        const events = current.snapshot?.events || [];
        removedCount = events.filter(item => removed.has(item.id)).length;
        const excludedEventIds = [...new Set([...(current.excludedEventIds || []), ...ids])];
        // Refuse instead of dropping old exclusions and unexpectedly restoring copies.
        if (excludedEventIds.length > 10_000) fail('The calendar exclusion limit was reached. No stored events were removed.');
        return { ...current, excludedEventIds, snapshot: current.snapshot ? { ...current.snapshot,
          events: events.filter(item => !removed.has(item.id)), generation: randomBytes(16).toString('hex') } : null };
      });
      return { removedCount, reimportBlocked: true };
    },
    async disconnect() {
      await mutate(current => ({ version: 1, tokenHash: null, tokenExpiresAt: null, snapshot: null,
        ...(Array.isArray(current.excludedEventIds) && current.excludedEventIds.length ? { excludedEventIds: current.excludedEventIds } : {}) }));
      return status();
    },
  };
}
