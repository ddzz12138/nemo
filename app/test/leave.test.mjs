import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLeaveService } from '../lib/leave.mjs';
import { appleMapsDirections } from '../lib/maps-link.mjs';
import { sydneyParts } from '../lib/sydney-time.mjs';
import { chooseJourney, createTfnswClient } from '../lib/tfnsw.mjs';
import { createVapidKeys, decryptPushPayload, encryptPushPayload, validatePushEndpoint } from '../lib/web-push.mjs';
import { canSchedule, setText } from '../public/leave.js';
import { createNemoServer } from '../lib/personal-gateway.mjs';

const CENTRAL = { latitude: -33.8829, longitude: 151.2063 };
const HALL = { latitude: -33.8732, longitude: 151.207 };
const EVENT = { id: 'event-1', title: 'Design review <img src=x onerror=alert(1)>', start: '2026-10-21T07:00:00.000Z', end: '2026-10-21T08:00:00.000Z', allDay: false };

function calendar(events = [EVENT], stale = false) {
  return { status: () => ({ connected: true, windowEnd: '2026-10-28T00:00:00.000Z', lastSyncedAt: '2026-10-21T00:00:00.000Z' }), read: () => ({ events, stale }) };
}
function journey(departure, arrival, { live = false, cancelled = false, name = 'T1' } = {}) {
  return { legs: [{ transportation: { number: name, product: { name: 'Train' } }, origin: { name: 'Central Station', departureTimePlanned: departure, ...(live ? { departureTimeEstimated: departure } : {}), properties: { platform: '16' } }, destination: { name: 'Town Hall Station', arrivalTimePlanned: arrival, ...(live ? { arrivalTimeEstimated: arrival } : {}) }, cancelled }] };
}
async function tempDirectory(t) {
  const prefix = fileURLToPath(new URL('./.tmp-leave-', import.meta.url));
  const path = await mkdtemp(prefix);
  t.after(async () => { const target = resolve(path); assert.equal(dirname(target), dirname(resolve(prefix))); await rm(target, { recursive: true, force: true }); });
  return path;
}

test('Sydney time uses the zone database across daylight saving', () => {
  assert.equal(sydneyParts('2026-01-15T00:00:00.000Z').time, '1100');
  assert.equal(sydneyParts('2026-07-15T00:00:00.000Z').time, '1000');
  const rollover = sydneyParts('2026-10-21T13:30:00.000Z');
  assert.equal(rollover.date, '20261022');
  assert.equal(rollover.time, '0030');
});

test('public-transport planning asks TfNSW for an arrive-by journey and labels timetable data', async () => {
  const calls = [];
  const client = createTfnswClient({ apiKey: 'fixture-key', fetchImpl: async url => { calls.push(new URL(url)); return Response.json({ journeys: [journey('2026-10-21T06:28:00.000Z', '2026-10-21T06:48:00.000Z')] }); } });
  const plan = await client.planArriveBy({ origin: CENTRAL, destination: HALL, arriveBy: Date.parse('2026-10-21T13:30:00.000Z') });
  assert.equal(calls[0].origin, 'https://api.transport.nsw.gov.au');
  assert.equal(calls[0].searchParams.get('depArrMacro'), 'arr');
  assert.equal(calls[0].searchParams.get('itdDate'), '20261022');
  assert.equal(calls[0].searchParams.get('itdTime'), '0030');
  assert.equal(calls[0].searchParams.get('name_origin'), '151.2063:-33.8829:EPSG:4326');
  assert.equal(plan.journeys[0].timing, 'timetable');
  assert.equal(plan.journeys[0].legs[0].platform, '16');
  const live = createTfnswClient({ apiKey: 'fixture-key', fetchImpl: async () => Response.json({ journeys: [journey('2026-10-21T06:28:00.000Z', '2026-10-21T06:48:00.000Z', { live: true })] }) });
  assert.equal((await live.planArriveBy({ origin: CENTRAL, destination: HALL, arriveBy: Date.parse('2026-10-21T07:00:00.000Z') })).journeys[0].timing, 'live');
});

test('journey choice uses the service departure and skips cancelled trips', () => {
  const cancelled = { departureAt: '2026-10-21T06:00:00.000Z', arrivalAt: '2026-10-21T06:20:00.000Z', cancelled: true };
  const earlier = { departureAt: '2026-10-21T06:10:00.000Z', arrivalAt: '2026-10-21T06:40:00.000Z', cancelled: false };
  const later = { departureAt: '2026-10-21T06:30:00.000Z', arrivalAt: '2026-10-21T06:50:00.000Z', cancelled: false };
  const choice = chooseJourney([cancelled, earlier, later], Date.parse('2026-10-21T06:55:00.000Z'));
  assert.equal(choice.ok, true);
  assert.equal(choice.journey.departureAt, later.departureAt);
  assert.equal(chooseJourney([cancelled], Date.now()).ok, false);
});

test('a map link is only an Apple Maps handoff', () => {
  const link = new URL(appleMapsDirections({ origin: CENTRAL, destination: HALL, mode: 'public' }));
  assert.equal(link.hostname, 'maps.apple.com');
  assert.equal(link.searchParams.get('dirflg'), 'r');
  assert.equal(new URL(appleMapsDirections({ origin: CENTRAL, destination: HALL, mode: 'driving' })).searchParams.get('dirflg'), 'd');
  assert.throws(() => appleMapsDirections({ origin: CENTRAL, destination: HALL, mode: 'fly' }));
});

test('push endpoints stay on public push services and payloads round-trip', () => {
  assert.throws(() => validatePushEndpoint('http://127.0.0.1/push'));
  assert.throws(() => validatePushEndpoint('https://127.0.0.1/push'));
  assert.throws(() => validatePushEndpoint('https://10.1.1.1/push'));
  assert.throws(() => validatePushEndpoint('https://desktop.tailtest.ts.net/push'));
  assert.equal(validatePushEndpoint('https://web.push.apple.com/3').hostname, 'web.push.apple.com');
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const subscription = { p256dh: receiver.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  const record = encryptPushPayload(JSON.stringify({ hello: 'trip' }), subscription);
  const plain = decryptPushPayload(record.body, subscription, receiver.getPrivateKey());
  assert.deepEqual(JSON.parse(plain.toString()), { hello: 'trip' });
  assert.equal(typeof createVapidKeys().privatePem, 'string');
});

test('a confirmed Sydney trip schedules one alert and does not invent a second one after restart', async t => {
  const dataDir = await tempDirectory(t);
  const sent = [];
  let clock = Date.parse('2026-10-21T06:00:00.000Z');
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/stop_finder')) return Response.json({ locations: [{ name: 'Central Station', type: 'stop', coord: [CENTRAL.latitude, CENTRAL.longitude] }] });
    return Response.json({ journeys: [journey('2026-10-21T06:20:00.000Z', '2026-10-21T06:40:00.000Z')] });
  };
  const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), fetchImpl, apiKey: 'fixture-key', pushSender: async (_subscription, payload) => { sent.push(payload); return { accepted: true, status: 201, expired: false }; } });
  const found = await service.search('alice', 'Central');
  await service.subscribe('alice', { endpoint: 'https://web.push.apple.com/device', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16), detail: 'itinerary' }, 'https://desktop.example.ts.net');
  const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'public', destinationSearchId: found.places[0].id, originSnapshot: { name: 'Home', ...HALL, accuracy: 12, capturedAt: '2026-10-21T05:50:00.000Z' }, arrivalBufferMinutes: 10 });
  assert.equal(preview.plan.timing, 'timetable');
  assert.equal(preview.plan.leaveAt, '2026-10-21T06:20:00.000Z');
  assert.equal(preview.plan.mapsDoNotCalculateEta, true);
  assert.equal(preview.plan.summary.includes('5:15'), false);
  await assert.rejects(service.schedule('bob', { confirmation: preview.confirmation }), /not on this browser|Review the trip|notifications/);
  const saved = await service.schedule('alice', { confirmation: preview.confirmation });
  assert.equal(saved.reminder.status, 'scheduled');
  await assert.rejects(service.schedule('alice', { confirmation: preview.confirmation }), /Review the trip/);
  clock = Date.parse('2026-10-21T06:21:00.000Z');
  await service.tick();
  await service.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].notification.navigate, 'https://desktop.example.ts.net/leave.html?trip=' + saved.reminder.id);
  const restarted = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), fetchImpl, apiKey: 'fixture-key', pushSender: async () => { sent.push('again'); return { accepted: true, status: 201 }; } });
  await restarted.tick();
  assert.equal(sent.length, 1);
  const opened = await restarted.get('alice', saved.reminder.id, { markOpened: true });
  assert.equal(opened.reminder.status, 'opened');
  assert.equal(JSON.stringify(opened).includes('onerror'), true);
});

test('driving uses the entered duration and a missed wake does not send a leave alert', async t => {
  const dataDir = await tempDirectory(t);
  const sent = [];
  let clock = Date.parse('2026-10-21T05:00:00.000Z');
  const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), apiKey: '', pushSender: async () => { sent.push(1); return { accepted: true, status: 201 }; } });
  await service.subscribe('alice', { endpoint: 'https://web.push.apple.com/device', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }, 'http://127.0.0.1:8787');
  await assert.rejects(service.preview('alice', { eventId: EVENT.id, mode: 'driving', destination: null, originSnapshot: { name: 'Home', ...HALL, capturedAt: '2026-10-21T04:00:00.000Z' } }), /starting point|destination|map link|minutes/);
  const home = await service.savePlace('alice', { name: 'Home', snapshot: { name: 'Home', ...HALL, capturedAt: '2026-10-21T04:00:00.000Z' } });
  const work = await service.savePlace('alice', { name: 'Office', snapshot: { name: 'Office', ...CENTRAL, capturedAt: '2026-10-21T04:00:00.000Z' } });
  const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'driving', originPlaceId: home.place.id, destinationPlaceId: work.place.id, manualDurationMinutes: 30, arrivalBufferMinutes: 10 });
  assert.match(preview.plan.summary, /Using your 30-minute estimate/);
  assert.match(preview.plan.summary, /not a live traffic calculation/);
  assert.equal(preview.plan.leaveAt, '2026-10-21T06:20:00.000Z');
  await service.schedule('alice', { confirmation: preview.confirmation });
  clock = Date.parse('2026-10-21T07:20:00.000Z');
  await service.tick();
  assert.equal(sent.length, 0);
  assert.equal((await service.status('alice')).reminders[0].status, 'missed');
});

test('a refreshed service sends one change alert', async t => {
  const dataDir = await tempDirectory(t);
  const sent = [];
  let clock = Date.parse('2026-10-21T06:00:00.000Z');
  let departure = '2026-10-21T06:20:00.000Z';
  const service = await createLeaveService({
    dataDir, now: () => clock, calendar: calendar(), apiKey: 'fixture-key',
    fetchImpl: async url => new URL(url).pathname.endsWith('/stop_finder') ? Response.json({ locations: [{ name: 'Central Station', type: 'stop', coord: [CENTRAL.latitude, CENTRAL.longitude] }] }) : Response.json({ journeys: [journey(departure, '2026-10-21T06:40:00.000Z', { live: true })] }),
    pushSender: async () => { sent.push(1); return { accepted: true, status: 201 }; },
  });
  await service.subscribe('alice', { endpoint: 'https://web.push.apple.com/device', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16), detail: 'itinerary' }, 'https://desktop.example.ts.net');
  const found = await service.search('alice', 'Central');
  const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'public', destinationSearchId: found.places[0].id, originSnapshot: { name: 'Home', ...HALL, capturedAt: '2026-10-21T05:50:00.000Z' }, arrivalBufferMinutes: 10 });
  await service.schedule('alice', { confirmation: preview.confirmation });
  departure = '2026-10-21T06:28:00.000Z';
  clock = Date.parse('2026-10-21T06:06:00.000Z');
  await service.tick();
  await service.tick();
  assert.equal(sent.length, 1);
  assert.match((await service.get('alice', (await service.status('alice')).reminders[0].id)).plan.summary, /Live/);
});

test('cancellation and logout stop future alerts, and another browser cannot see the trip', async t => {
  const dataDir = await tempDirectory(t);
  const sent = [];
  let clock = Date.parse('2026-10-21T06:30:00.000Z');
  const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), apiKey: '', pushSender: async () => { sent.push(1); return { accepted: true, status: 201 }; } });
  await service.subscribe('alice', { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }, 'http://127.0.0.1:9');
  const home = await service.savePlace('alice', { name: 'Home', snapshot: { ...HALL, name: 'Home', capturedAt: '2026-10-21T04:00:00.000Z' } });
  const work = await service.savePlace('alice', { name: 'Office', snapshot: { ...CENTRAL, name: 'Office', capturedAt: '2026-10-21T04:00:00.000Z' } });
  const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'driving', originPlaceId: home.place.id, destinationPlaceId: work.place.id, manualDurationMinutes: 20, arrivalBufferMinutes: 0 });
  const saved = await service.schedule('alice', { confirmation: preview.confirmation });
  await service.cancel('alice', saved.reminder.id);
  clock = Date.parse('2026-10-21T06:45:00.000Z');
  await service.tick();
  assert.equal(sent.length, 0);
  await assert.rejects(service.get('bob', saved.reminder.id), /not on this browser/);
  await service.revokeOwner('alice');
  assert.equal((await service.status('alice')).places.length, 0);
  assert.equal((await service.status('alice')).reminders[0].status, 'cancelled');
});

test('the leave screen renders untrusted text literally and does not schedule early', async () => {
  const node = { textContent: '' };
  setText(node, EVENT.title);
  assert.equal(node.textContent, EVENT.title);
  assert.equal(canSchedule({ confirmation: 'a'.repeat(64), subscribed: false }), false);
  assert.equal(canSchedule({ confirmation: 'a'.repeat(64), subscribed: true }), true);
  const source = await readFile(fileURLToPath(new URL('../public/leave.js', import.meta.url)), 'utf8');
  const worker = await readFile(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  assert.equal(worker.includes('caches'), false);
  assert.match(source, /does not calculate when to leave/);
});

test('devices share saved places but receive only their own reminders after another device is revoked', async t => {
  const dataDir = await tempDirectory(t); const sent = [];
  let clock = Date.parse('2026-10-21T06:00:00.000Z');
  const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), pushSender: async subscription => { sent.push(subscription.deviceId); return { accepted: true }; } });
  for (const device of ['phone', 'tablet']) await service.subscribe('alice', { endpoint: `https://web.push.apple.com/${device}`, p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }, 'https://desktop.example.ts.net', device);
  const place = await service.savePlace('alice', { name: 'Office', snapshot: { name: 'Office', ...CENTRAL, capturedAt: new Date(clock).toISOString() } });
  for (const device of ['phone', 'tablet']) {
    const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'driving', originSnapshot: { name: 'Home', ...HALL, capturedAt: new Date(clock).toISOString() }, destinationPlaceId: place.place.id, manualDurationMinutes: 20, arrivalBufferMinutes: 0 });
    await service.schedule('alice', { confirmation: preview.confirmation }, device);
  }
  await service.revokeDevice('alice', 'phone');
  assert.equal((await service.status('alice', 'phone')).push.subscribed, false);
  assert.equal((await service.status('alice', 'tablet')).push.subscribed, true);
  assert.equal((await service.status('alice', 'tablet')).places.length, 1);
  clock = Date.parse('2026-10-21T06:41:00.000Z'); await service.tick();
  assert.deepEqual(sent, ['tablet']);
  assert.deepEqual((await service.status('alice', 'tablet')).reminders.map(item => item.status), ['cancelled', 'sent']);
});

test('cancellation and device revocation during a timetable refresh cannot send or revive an alert', async t => {
  for (const action of ['cancel', 'revoke']) await t.test(action, async t => {
    const dataDir = await tempDirectory(t); const sent = []; let refreshing = false;
    const entered = Promise.withResolvers(); const resume = Promise.withResolvers();
    let clock = Date.parse('2026-10-21T06:00:00.000Z');
    const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), apiKey: 'fixture-key',
      fetchImpl: async url => {
        if (new URL(url).pathname.endsWith('/stop_finder')) return Response.json({ locations: [{ name: 'Central', type: 'stop', coord: [CENTRAL.latitude, CENTRAL.longitude] }] });
        if (refreshing) { entered.resolve(); await resume.promise; }
        return Response.json({ journeys: [journey(refreshing ? '2026-10-21T06:28:00.000Z' : '2026-10-21T06:20:00.000Z', '2026-10-21T06:40:00.000Z')] });
      }, pushSender: async () => { sent.push(1); return { accepted: true }; } });
    await service.subscribe('alice', { endpoint: 'https://web.push.apple.com/phone', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }, 'https://desktop.example.ts.net', 'phone');
    const found = await service.search('alice', 'Central');
    const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'public', destinationSearchId: found.places[0].id, originSnapshot: { name: 'Home', ...HALL, capturedAt: new Date(clock).toISOString() } });
    const saved = await service.schedule('alice', { confirmation: preview.confirmation }, 'phone');
    clock = Date.parse('2026-10-21T06:06:00.000Z'); refreshing = true;
    const ticking = service.tick(); await entered.promise;
    const stopped = action === 'cancel' ? service.cancel('alice', saved.reminder.id) : service.revokeDevice('alice', 'phone');
    resume.resolve(); await Promise.all([ticking, stopped]);
    assert.equal(sent.length, 0);
    assert.equal((await service.get('alice', saved.reminder.id)).reminder.status, 'cancelled');
  });
});

test('an expired device cannot receive a scheduled reminder even without an open browser', async t => {
  const dataDir = await tempDirectory(t); const sent = []; let active = true;
  let clock = Date.parse('2026-10-21T06:00:00.000Z');
  const service = await createLeaveService({ dataDir, now: () => clock, calendar: calendar(), isDeviceActive: async id => id === 'phone' && active, pushSender: async () => { sent.push(1); return { accepted: true }; } });
  await service.subscribe('alice', { endpoint: 'https://web.push.apple.com/phone', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }, 'https://desktop.example.ts.net', 'phone');
  const destination = await service.savePlace('alice', { name: 'Office', snapshot: { name: 'Office', ...CENTRAL, capturedAt: new Date(clock).toISOString() } });
  const preview = await service.preview('alice', { eventId: EVENT.id, mode: 'driving', originSnapshot: { name: 'Home', ...HALL, capturedAt: new Date(clock).toISOString() }, destinationPlaceId: destination.place.id, manualDurationMinutes: 20, arrivalBufferMinutes: 0 });
  await service.schedule('alice', { confirmation: preview.confirmation }, 'phone');
  active = false; clock = Date.parse('2026-10-21T06:41:00.000Z'); await service.tick();
  assert.equal(sent.length, 0); assert.equal((await service.status('alice', 'phone')).push.subscribed, false);
  assert.equal((await service.status('alice', 'phone')).reminders[0].status, 'cancelled');
});

test('paired leave routes reject an unauthenticated browser and a private push endpoint', async t => {
  const dataDir = await tempDirectory(t);
  const app = await createNemoServer({ dataDir, publicDir: fileURLToPath(new URL('../public/', import.meta.url)), pairingCode: '12345678', now: () => Date.parse('2026-10-21T00:00:00.000Z'), provider: { status: () => ({ connected: false }) }, integrations: { calendar: calendar(), tfnswKey: '' } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const open = await fetch(`${base}/api/leave`);
  assert.equal(open.status, 401);
  const paired = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: '12345678' }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(`${base}/api/leave/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1', Cookie: cookie }, body: JSON.stringify({ endpoint: 'https://127.0.0.1/push', p256dh: 'a'.repeat(20), auth: 'b'.repeat(16) }) });
  assert.equal(denied.status, 400);
  const page = await fetch(`${base}/leave.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Notify me when to leave/);
});
