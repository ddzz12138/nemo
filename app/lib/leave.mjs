import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appleMapsDirections } from './maps-link.mjs';
import { assertNswCoordinate, chooseJourney, createTfnswClient, TransitError } from './tfnsw.mjs';
import { formatSydney } from './sydney-time.mjs';
import { createPushSender, createVapidKeys, PushError, validatePushEndpoint } from './web-push.mjs';

const DAY = 86_400_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class LeaveError extends Error {
  constructor(status, message, code = 'LEAVE') { super(message); this.status = status; this.code = code; }
}

export async function createLeaveService({ dataDir, now = () => Date.now(), calendar, fetchImpl, apiKey = '', pushSender, isDeviceActive = async () => true } = {}) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'leave.json');
  const vapidPath = join(dataDir, 'vapid.json');
  let state = { version: 1, places: [], subscriptions: [], reminders: [] };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.places) || !Array.isArray(saved.subscriptions) || !Array.isArray(saved.reminders)) throw new Error('invalid');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw new LeaveError(503, 'Saved trip reminders could not be read.', 'LEAVE_STORE'); }
  let vapid = null;
  try { vapid = JSON.parse(await readFile(vapidPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') vapid = null; }
  if (!vapid?.publicKey || !vapid?.privatePem) {
    vapid = createVapidKeys();
    await writeFile(vapidPath, JSON.stringify(vapid), { mode: 0o600 });
  }
  const transit = createTfnswClient({ apiKey, fetchImpl, now });
  const send = pushSender || createPushSender({ privatePem: vapid.privatePem, publicKey: vapid.publicKey, fetchImpl, now });
  const searches = new Map();
  const previews = new Map();
  let chain = Promise.resolve();
  const exclusive = operation => {
    const next = chain.catch(() => {}).then(operation);
    chain = next;
    return next;
  };
  async function persist() {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path);
  }
  function ownerPlaces(owner) { return state.places.filter(place => place.owner === owner).map(publicPlace); }
  function ownerReminders(owner) { return state.reminders.filter(item => item.owner === owner).map(publicReminder); }
  function subscriptionFor(owner, deviceId = owner) { return state.subscriptions.find(item => item.owner === owner && (item.deviceId || item.owner) === deviceId && !item.revoked) || null; }

  async function upcomingEvents() {
    await calendar.reload?.();
    const status = calendar.status();
    const start = new Date(now() - DAY).toISOString();
    const end = status.windowEnd || new Date(now() + 7 * DAY).toISOString();
    let page;
    try { page = calendar.read({ limit: 200, start, end }); }
    catch { page = { events: [], stale: true }; }
    const events = (page.events || []).map(event => ({ id: event.id, title: event.title, start: event.start, end: event.end, allDay: !!event.allDay }));
    return { events, stale: !!page.stale, syncedAt: status.lastSyncedAt || null, connected: !!status.connected };
  }

  function placeFrom(owner, input, label) {
    if (input[`${label}PlaceId`]) {
      const place = state.places.find(item => item.owner === owner && item.id === input[`${label}PlaceId`]);
      if (!place) throw new LeaveError(404, 'That saved place is no longer available.', 'PLACE_NOT_FOUND');
      return { ...publicPlace(place), placeId: place.id, source: 'saved' };
    }
    if (input[`${label}SearchId`]) {
      const found = searches.get(input[`${label}SearchId`]);
      if (!found || found.owner !== owner || found.expiresAt <= now()) throw new LeaveError(409, 'That place search expired. Search again.', 'PLACE_EXPIRED');
      return { name: found.name, latitude: found.latitude, longitude: found.longitude, source: 'search', capturedAt: new Date(found.capturedAt).toISOString() };
    }
    if (label === 'origin' && input.originSnapshot) return snapshot(input.originSnapshot);
    throw new LeaveError(400, `Confirm a ${label === 'origin' ? 'starting point' : 'destination'} before planning the trip.`, 'PLACE_REQUIRED');
  }

  async function buildPlan(draft) {
    const arriveBy = Date.parse(draft.eventStart) - draft.arrivalBufferMinutes * 60_000;
    const mapsUrl = appleMapsDirections({ origin: draft.origin, destination: draft.destination, mode: draft.mode });
    if (draft.mode === 'driving') {
      if (!Number.isInteger(draft.manualDurationMinutes)) throw new LeaveError(400, 'Enter how many minutes you expect the drive to take. A map link does not calculate this.', 'MANUAL_DURATION');
      const leaveAt = arriveBy - (draft.manualDurationMinutes + draft.accessBufferMinutes) * 60_000;
      return planBody(draft, { leaveAt, arriveAt: arriveBy, timing: 'manual', provider: 'Your estimate', mapsUrl, legs: [], summary: `Using your ${draft.manualDurationMinutes}-minute estimate. This is not a live traffic calculation.` });
    }
    let result;
    try { result = await transit.planArriveBy({ origin: draft.origin, destination: draft.destination, arriveBy }); }
    catch (error) { if (error instanceof TransitError) throw new LeaveError(error.status, error.message, error.code); throw error; }
    const choice = chooseJourney(result.journeys, arriveBy);
    if (!choice.ok && choice.reason === 'no-route') throw new LeaveError(404, 'Transport for NSW returned no public-transport journey for this trip. No train times were invented.', 'NO_ROUTE');
    const journey = choice.journey;
    const timing = journey.timing === 'live' ? 'live' : 'timetable';
    const summary = choice.ok
      ? `${timing === 'live' ? 'Live' : 'Timetable'} plan from Transport for NSW. Leave ${formatSydney(journey.departureAt)}.`
      : `No service arrives by ${formatSydney(arriveBy)}. The earliest returned journey arrives ${formatSydney(journey.arrivalAt)}.`;
    if (!choice.ok) throw new LeaveError(409, summary, 'TOO_LATE');
    return planBody(draft, { leaveAt: Date.parse(journey.departureAt), arriveAt: Date.parse(journey.arrivalAt), timing, provider: 'Transport for NSW', fetchedAt: result.fetchedAt, mapsUrl, legs: journey.legs, summary });
  }

  return {
    async status(owner, deviceId = owner) {
      const calendarStatus = await upcomingEvents();
      const subscription = subscriptionFor(owner, deviceId);
      return { ok: true, tfnsw: { configured: transit.configured }, push: { publicKey: vapid.publicKey, subscribed: !!subscription, detail: subscription?.detail || 'minimal' }, calendar: calendarStatus, places: ownerPlaces(owner), reminders: ownerReminders(owner) };
    },
    async search(owner, query) {
      let places;
      try { places = await transit.search(query); }
      catch (error) { if (error instanceof TransitError) throw new LeaveError(error.status, error.message, error.code); throw error; }
      return { ok: true, places: places.map(place => {
        const id = randomUUID();
        searches.set(id, { ...place, owner, capturedAt: now(), expiresAt: now() + 10 * 60_000 });
        return { id, name: place.name, kind: place.kind, latitude: place.latitude, longitude: place.longitude };
      }) };
    },
    async savePlace(owner, input) {
      const name = requiredText(input.name, 80, 'Place name');
      const point = input.searchId ? placeFrom(owner, { destinationSearchId: input.searchId }, 'destination') : snapshot(input.snapshot);
      return exclusive(async () => {
        if (state.places.filter(place => place.owner === owner).length >= 20) throw new LeaveError(429, 'Remove a saved place before adding another.', 'PLACE_LIMIT');
        const place = { id: randomUUID(), owner, name, latitude: point.latitude, longitude: point.longitude, kind: 'saved', capturedAt: new Date(now()).toISOString(), source: point.source };
        state.places.push(place);
        await persist();
        return { ok: true, place: publicPlace(place) };
      });
    },
    async deletePlace(owner, id) {
      const before = state.places.length;
      state.places = state.places.filter(place => !(place.owner === owner && place.id === id));
      if (state.places.length === before) throw new LeaveError(404, 'That saved place is no longer available.', 'PLACE_NOT_FOUND');
      for (const reminder of state.reminders) if (reminder.owner === owner && reminder.status === 'scheduled' && [reminder.origin.placeId, reminder.destination.placeId].includes(id)) reminder.status = 'cancelled';
      await exclusive(persist);
      return { ok: true, removed: true };
    },
    async preview(owner, input) {
      const draft = await draftFrom(owner, { ...input, origin: placeFrom(owner, input, 'origin'), destination: placeFrom(owner, input, 'destination') }, upcomingEvents);
      const plan = await buildPlan(draft);
      const token = randomBytes(32).toString('hex');
      previews.set(token, { owner, expiresAt: now() + 10 * 60_000, draft, plan });
      return { ok: true, confirmation: token, expiresAt: now() + 10 * 60_000, plan: publicPlan(plan), mapsDoNotCalculateEta: true };
    },
    async schedule(owner, input, deviceId = owner) {
      return exclusive(async () => {
        const subscription = subscriptionFor(owner, deviceId);
        if (!subscription) throw new LeaveError(409, 'Enable notifications from the Nemo Home Screen icon before setting a reminder. Pressing the button is not the same as a delivered alert.', 'PUSH_REQUIRED');
        const preview = previews.get(input.confirmation);
        if (!preview || preview.owner !== owner || preview.expiresAt <= now()) throw new LeaveError(409, 'Review the trip again before setting the reminder.', 'LEAVE_CONFIRMATION');
        previews.delete(input.confirmation);
        const current = await draftFrom(owner, preview.draft, upcomingEvents);
        if (digest(current) !== digest(preview.draft)) throw new LeaveError(409, 'The event or place changed. Review the trip again.', 'LEAVE_CHANGED');
        const reminder = { id: randomUUID(), owner, subscriptionId: subscription.id, generation: 1, status: 'scheduled', createdAt: new Date(now()).toISOString(), ...current, plan: preview.plan, leaveSent: false, headsUpSent: false, providerCalls: preview.plan.provider === 'Transport for NSW' ? 1 : 0, claim: null };
        state.reminders.push(reminder);
        await persist();
        return { ok: true, reminder: publicReminder(reminder) };
      });
    },
    async get(owner, id, { markOpened = false } = {}) {
      const reminder = state.reminders.find(item => item.owner === owner && item.id === id);
      if (!reminder) throw new LeaveError(404, 'That reminder is not on this browser.', 'LEAVE_NOT_FOUND');
      if (markOpened && reminder.status === 'sent') reminder.status = 'opened';
      if (markOpened) await exclusive(persist);
      return { ok: true, reminder: publicReminder(reminder), plan: publicPlan(reminder.plan) };
    },
    async cancel(owner, id) {
      const reminder = state.reminders.find(item => item.owner === owner && item.id === id);
      if (!reminder) throw new LeaveError(404, 'That reminder is not on this browser.', 'LEAVE_NOT_FOUND');
      reminder.status = 'cancelled';
      reminder.generation += 1;
      await exclusive(persist);
      return { ok: true, reminder: publicReminder(reminder) };
    },
    async subscribe(owner, input, origin, deviceId = owner) {
      const endpoint = validatePushEndpoint(input.endpoint).toString();
      const p256dh = requiredText(input.p256dh, 200, 'Subscription');
      const auth = requiredText(input.auth, 80, 'Subscription');
      const detail = input.detail === 'itinerary' ? 'itinerary' : 'minimal';
      const previous = state.subscriptions.find(item => item.owner === owner && (item.deviceId || item.owner) === deviceId);
      state.subscriptions = state.subscriptions.filter(item => !(item.owner === owner && ((item.deviceId || item.owner) === deviceId || item.endpoint === endpoint)));
      const subscription = { id: previous?.id || randomUUID(), owner, deviceId, endpoint, p256dh, auth, detail, origin, revoked: false, createdAt: new Date(now()).toISOString() };
      state.subscriptions.push(subscription);
      await exclusive(persist);
      return { ok: true, subscribed: true, detail };
    },
    async unsubscribe(owner, deviceId) {
      const revoked = new Set();
      for (const item of state.subscriptions) if (item.owner === owner && (!deviceId || (item.deviceId || item.owner) === deviceId)) { item.revoked = true; revoked.add(item.id); }
      for (const reminder of state.reminders) if (reminder.owner === owner && revoked.has(reminder.subscriptionId) && reminder.status === 'scheduled') { reminder.status = 'cancelled'; reminder.generation += 1; }
      await exclusive(persist);
      return { ok: true, subscribed: false };
    },
    async revokeOwner(owner) {
      state.places = state.places.filter(place => place.owner !== owner);
      await this.unsubscribe(owner);
    },
    async revokeDevice(owner, deviceId) { return this.unsubscribe(owner, deviceId); },
    async disableOwner(owner) { return this.unsubscribe(owner); },
    async tick() {
      return exclusive(async () => {
        for (const reminder of state.reminders) if (reminder.status === 'scheduled') await advance(reminder);
        await persist();
      });
    },
  };

  async function advance(reminder) {
    const generation = reminder.generation;
    const active = () => reminder.status === 'scheduled' && reminder.generation === generation;
    if (!active()) return;
    const eventStart = Date.parse(reminder.eventStart);
    if (now() > eventStart + 15 * 60_000) { reminder.status = 'missed'; return; }
    if (reminder.mode === 'public' && transit.configured && reminder.providerCalls < 8 && now() >= reminder.plan.leaveAt - 20 * 60_000 && now() - Date.parse(reminder.plan.fetchedAt || 0) > 5 * 60_000) {
      try {
        const refreshed = await buildPlan(reminder);
        if (!active()) return;
        reminder.providerCalls += 1;
        const shift = Math.abs(refreshed.leaveAt - reminder.plan.leaveAt);
        reminder.plan = refreshed;
        if (shift >= 3 * 60_000 && !reminder.changeSent) { await deliver(reminder, 'change'); reminder.changeSent = true; }
      } catch { reminder.plan.stale = true; }
    }
    if (!active()) return;
    if (!reminder.headsUpSent && reminder.headsUpMinutes > 0 && now() >= reminder.plan.leaveAt - reminder.headsUpMinutes * 60_000) await deliver(reminder, 'heads-up');
    if (!active()) return;
    if (!reminder.leaveSent && now() >= reminder.plan.leaveAt && now() < eventStart) await deliver(reminder, 'leave');
    else if (!reminder.leaveSent && now() >= eventStart) reminder.status = 'missed';
  }

  async function deliver(reminder, kind) {
    if (reminder.status !== 'scheduled') return;
    const generation = reminder.generation;
    const claimKey = `${kind}:${reminder.generation}`;
    if (reminder.claim?.key === claimKey && reminder.claim.done) return;
    if (reminder.claim?.key === claimKey && now() - reminder.claim.at < 120_000) return;
    reminder.claim = { key: claimKey, at: now(), done: false };
    await persist();
    if (reminder.status !== 'scheduled' || reminder.generation !== generation) return;
    const subscription = state.subscriptions.find(item => item.id === reminder.subscriptionId && !item.revoked);
    if (!subscription) { reminder.status = 'failed'; reminder.failure = 'The notification subscription is no longer active.'; reminder.claim.done = true; return; }
    const authorized = await isDeviceActive(subscription.deviceId || subscription.owner);
    if (reminder.status !== 'scheduled' || reminder.generation !== generation || subscription.revoked) return;
    if (!authorized) { subscription.revoked = true; reminder.status = 'cancelled'; reminder.generation += 1; reminder.claim.done = true; return; }
    const minimal = subscription.detail !== 'itinerary';
    const payload = {
      web_push: 8030,
      notification: {
        title: minimal ? 'Time to leave' : `Leave ${formatSydney(reminder.plan.leaveAt)}`,
        body: minimal ? 'Open Nemo for your trip.' : reminder.plan.summary.slice(0, 180),
        navigate: `${subscription.origin}/leave.html?trip=${reminder.id}`,
      },
    };
    try {
      const result = await send(subscription, payload);
      if (reminder.status !== 'scheduled' || reminder.generation !== generation || subscription.revoked) return;
      reminder.claim.done = true;
      reminder.pushState = result.accepted ? 'provider-accepted' : 'failed';
      if (result.expired) { subscription.revoked = true; reminder.status = 'failed'; reminder.failure = 'The phone notification subscription expired. Enable notifications again.'; return; }
      if (!result.accepted) { reminder.status = 'failed'; reminder.failure = 'The push service did not accept the alert. This does not mean the phone showed it.'; return; }
      if (kind === 'heads-up') reminder.headsUpSent = true;
      if (kind === 'leave') { reminder.leaveSent = true; reminder.status = 'sent'; }
    } catch {
      if (reminder.status !== 'scheduled' || reminder.generation !== generation || subscription.revoked) return;
      reminder.claim.done = true;
      reminder.status = 'failed';
      reminder.failure = 'The alert could not be sent. The trip plan is still saved.';
    }
  }
}

async function draftFrom(owner, input, upcomingEvents) {
  const calendar = await upcomingEvents();
  const event = calendar.events.find(item => item.id === input.eventId);
  if (!event && !input.eventStart) throw new LeaveError(404, 'That event is not in the current phone snapshot. A missing event in a partial sync is not proof it was cancelled.', 'EVENT_NOT_IN_SNAPSHOT');
  if (calendar.stale && input.acknowledgeStale !== true) throw new LeaveError(409, 'The phone calendar snapshot is stale. Refresh the shortcut, or confirm you still want to use it.', 'CALENDAR_STALE');
  const eventStart = input.eventStart || event?.start;
  if (!eventStart || !Number.isFinite(Date.parse(eventStart))) throw new LeaveError(400, 'Choose the time you need to arrive.', 'EVENT_TIME');
  if (event?.allDay && !input.eventStart) throw new LeaveError(400, 'An all-day event needs the time you need to be there.', 'ALL_DAY');
  const mode = input.mode === 'driving' ? 'driving' : input.mode === 'public' ? 'public' : null;
  if (!mode) throw new LeaveError(400, 'Choose driving or public transport.', 'MODE');
  const arrivalBufferMinutes = integer(input.arrivalBufferMinutes, 10, 0, 120, 'Arrival buffer');
  const accessBufferMinutes = integer(input.accessBufferMinutes, 0, 0, 60, 'Extra buffer');
  const headsUpMinutes = integer(input.headsUpMinutes, 0, 0, 120, 'Heads-up');
  const manualDurationMinutes = input.manualDurationMinutes == null ? null : integer(input.manualDurationMinutes, 0, 1, 180, 'Driving estimate');
  return {
    eventId: event?.id || null, eventTitle: event?.title || 'Selected event', eventStart, eventEnd: event?.end || null,
    allDay: !!event?.allDay, snapshotStale: !!calendar.stale, acknowledgeStale: input.acknowledgeStale === true, owner, mode, arrivalBufferMinutes, accessBufferMinutes, headsUpMinutes, manualDurationMinutes,
    origin: input.origin || null, destination: input.destination || null,
  };
}

function planBody(draft, plan) {
  return { ...plan, eventTitle: draft.eventTitle, eventStart: draft.eventStart, origin: draft.origin, destination: draft.destination, mode: draft.mode, arrivalBufferMinutes: draft.arrivalBufferMinutes, mapsDoNotCalculateEta: true };
}

function publicPlan(plan) {
  return { summary: plan.summary, timing: plan.timing, provider: plan.provider, fetchedAt: plan.fetchedAt || null, leaveAt: new Date(plan.leaveAt).toISOString(), arriveAt: new Date(plan.arriveAt).toISOString(), legs: plan.legs || [], mapsUrl: plan.mapsUrl, mapsDoNotCalculateEta: true, origin: plan.origin, destination: plan.destination, mode: plan.mode, eventTitle: plan.eventTitle, eventStart: plan.eventStart };
}

function publicReminder(reminder) {
  return { id: reminder.id, status: reminder.status, eventTitle: reminder.eventTitle, eventStart: reminder.eventStart, mode: reminder.mode, leaveAt: new Date(reminder.plan.leaveAt).toISOString(), timing: reminder.plan.timing, failure: reminder.failure || null, pushState: reminder.pushState || null };
}

function publicPlace(place) {
  return { id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude, capturedAt: place.capturedAt || null, source: place.source };
}

function snapshot(input) {
  if (!input || typeof input !== 'object') throw new LeaveError(400, 'Use a current location snapshot or a saved place.', 'PLACE_REQUIRED');
  const point = assertNswCoordinate(Number(input.latitude), Number(input.longitude));
  const latitude = point.latitude;
  const longitude = point.longitude;
  const capturedAt = Date.parse(input.capturedAt || '');
  if (!Number.isFinite(capturedAt)) throw new LeaveError(400, 'The location snapshot needs the time it was taken.', 'PLACE_REQUIRED');
  return { name: requiredText(input.name || 'Location snapshot', 80, 'Place'), latitude, longitude, source: 'device', capturedAt: new Date(capturedAt).toISOString(), accuracy: Number.isFinite(Number(input.accuracy)) ? Math.round(Number(input.accuracy)) : null };
}

function requiredText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new LeaveError(400, `${label} must be text of at most ${maximum} characters.`, 'LEAVE_FIELD');
  return value.trim();
}

function integer(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new LeaveError(400, `${label} is outside the allowed range.`, 'LEAVE_FIELD');
  return value;
}

export async function handleLeaveRequest(service, { method, path, url, owner, deviceId, input, origin }) {
  try {
    if (method === 'GET' && path === '/api/leave') return { status: 200, body: await service.status(owner, deviceId) };
    if (method === 'GET' && path === '/api/leave/search') return { status: 200, body: await service.search(owner, url.searchParams.get('q') || '') };
    if (method === 'GET' && path === '/api/leave/trip') return { status: 200, body: await service.get(owner, url.searchParams.get('id') || '', { markOpened: true }) };
    if (method === 'POST' && path === '/api/leave/places') return { status: 200, body: await service.savePlace(owner, input) };
    if (method === 'POST' && path === '/api/leave/places/delete') return { status: 200, body: await service.deletePlace(owner, input.id) };
    if (method === 'POST' && path === '/api/leave/preview') return { status: 200, body: await service.preview(owner, input) };
    if (method === 'POST' && path === '/api/leave/schedule') return { status: 200, body: await service.schedule(owner, input, deviceId) };
    if (method === 'POST' && path === '/api/leave/cancel') return { status: 200, body: await service.cancel(owner, input.id) };
    if (method === 'POST' && path === '/api/leave/push/subscribe') return { status: 200, body: await service.subscribe(owner, input, origin, deviceId) };
    if (method === 'POST' && path === '/api/leave/push/unsubscribe') return { status: 200, body: await service.unsubscribe(owner, deviceId) };
    return null;
  } catch (error) {
    if (error instanceof LeaveError || error instanceof PushError || error instanceof TransitError) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}
