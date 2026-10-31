import { sydneyParts } from './sydney-time.mjs';

const ENDPOINT = 'https://api.transport.nsw.gov.au/v1/tp/';
const NSW = { south: -37.6, north: -28, west: 140.9, east: 153.7 };

export class TransitError extends Error {
  constructor(status, message, code = 'TRANSIT') { super(message); this.status = status; this.code = code; }
}

export function assertNswCoordinate(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < NSW.south || latitude > NSW.north || longitude < NSW.west || longitude > NSW.east) {
    throw new TransitError(400, 'Choose a place in New South Wales. This trip planner does not cover locations outside NSW.', 'PLACE_OUTSIDE_NSW');
  }
  return { latitude: round(latitude), longitude: round(longitude) };
}

const round = value => Math.round(value * 1e6) / 1e6;

export function createTfnswClient({ apiKey = '', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const configured = typeof apiKey === 'string' && apiKey.trim().length >= 8 && apiKey.trim().length <= 200 && !/[\s\r\n]/.test(apiKey);
  async function call(method, params) {
    if (!configured) throw new TransitError(503, 'Sydney trip planning is not configured on this PC.', 'TFNSW_NOT_CONFIGURED');
    const url = new URL(method, ENDPOINT);
    url.search = new URLSearchParams({ outputFormat: 'rapidJSON', coordOutputFormat: 'EPSG:4326', ...params }).toString();
    if (url.origin !== 'https://api.transport.nsw.gov.au' || !url.pathname.startsWith('/v1/tp/')) throw new TransitError(500, 'Trip planner request was rejected.');
    let response;
    try { response = await fetchImpl(url, { headers: { Authorization: `apikey ${apiKey.trim()}` }, redirect: 'error', signal: AbortSignal.timeout(12_000) }); }
    catch { throw new TransitError(503, 'Transport for NSW could not be reached. Your saved reminder was not changed.', 'TFNSW_NETWORK'); }
    if (response.status === 429) throw new TransitError(429, 'Transport for NSW is limiting requests. Try again shortly.', 'TFNSW_RATE_LIMIT');
    if (!response.ok) throw new TransitError(502, 'Transport for NSW could not plan this trip.', 'TFNSW_REQUEST');
    let body;
    try { body = await response.json(); }
    catch { throw new TransitError(502, 'Transport for NSW returned an unreadable plan.', 'TFNSW_RESPONSE'); }
    return body;
  }
  return {
    configured,
    async search(query) {
      const name = cleanQuery(query);
      const body = await call('stop_finder', { type_sf: 'any', name_sf: name, TfNSWSF: 'true' });
      const locations = Array.isArray(body?.locations) ? body.locations : [];
      return locations.slice(0, 8).map(projectPlace).filter(Boolean);
    },
    async planArriveBy({ origin, destination, arriveBy }) {
      const from = assertNswCoordinate(origin.latitude, origin.longitude);
      const to = assertNswCoordinate(destination.latitude, destination.longitude);
      const when = sydneyParts(arriveBy);
      const body = await call('trip', {
        depArrMacro: 'arr', itdDate: when.date, itdTime: when.time, TfNSWTR: 'true', calcNumberOfTrips: '4',
        type_origin: 'coord', name_origin: `${from.longitude}:${from.latitude}:EPSG:4326`,
        type_destination: 'coord', name_destination: `${to.longitude}:${to.latitude}:EPSG:4326`,
      });
      const journeys = (Array.isArray(body?.journeys) ? body.journeys : []).slice(0, 6).map(normalizeJourney).filter(Boolean);
      return { journeys, fetchedAt: new Date(now()).toISOString(), provider: 'Transport for NSW' };
    },
  };
}

function cleanQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 80 || /[\x00-\x1f\x7f]/.test(query)) throw new TransitError(400, 'Enter a place or station name.', 'PLACE_QUERY');
  return query.trim();
}

function coordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const first = Number(value[0]);
  const second = Number(value[1]);
  const latitude = Math.abs(first) <= 90 ? first : second;
  const longitude = Math.abs(first) <= 90 ? second : first;
  try { return assertNswCoordinate(latitude, longitude); }
  catch { return null; }
}

function projectPlace(location) {
  const point = coordinate(location?.coord);
  const name = text(location?.name || location?.disassembledName, 160);
  if (!point || !name) return null;
  return { name, ...point, kind: location?.type === 'stop' ? 'stop' : 'place' };
}

function normalizeJourney(journey) {
  const legs = (Array.isArray(journey?.legs) ? journey.legs : []).slice(0, 12).map(normalizeLeg).filter(Boolean);
  if (!legs.length) return null;
  const cancelled = legs.some(leg => leg.cancelled);
  const live = legs.some(leg => leg.timing === 'live');
  return {
    departureAt: legs[0].departureAt, arrivalAt: legs.at(-1).arrivalAt,
    timing: live ? 'live' : 'timetable', cancelled, legs,
  };
}

function normalizeLeg(leg) {
  const origin = leg?.origin || {};
  const destination = leg?.destination || {};
  const departureAt = firstTime(origin.departureTimeEstimated, origin.departureTimePlanned, leg.departureTimeEstimated, leg.departureTimePlanned);
  const arrivalAt = firstTime(destination.arrivalTimeEstimated, destination.arrivalTimePlanned, leg.arrivalTimeEstimated, leg.arrivalTimePlanned);
  if (!departureAt || !arrivalAt) return null;
  const estimated = origin.departureTimeEstimated || destination.arrivalTimeEstimated || leg.isRealtimeControlled === true;
  const modeName = text(leg?.transportation?.product?.name || leg?.transportation?.description || leg?.transportation?.name, 40);
  const route = text(leg?.transportation?.disassembledName || leg?.transportation?.number || leg?.transportation?.name, 40);
  const cancelled = leg?.cancelled === true || leg?.properties?.cancelled === true || /cancel/i.test(String(leg?.hints?.[0]?.content || ''));
  const walking = !route || /walk|foot/i.test(`${modeName} ${route}`);
  return {
    mode: walking ? 'walk' : 'transit',
    name: walking ? 'Walk' : (route || modeName || 'Service'),
    from: text(origin.name || origin.disassembledName, 120),
    to: text(destination.name || destination.disassembledName, 120),
    departureAt, arrivalAt,
    platform: text(origin.properties?.platform || origin.platformName, 20) || null,
    timing: estimated ? 'live' : 'timetable',
    cancelled,
  };
}

function firstTime(...values) {
  return values.find(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) || null;
}

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit) : '';
}

export function chooseJourney(journeys, arriveBy) {
  const ready = (Array.isArray(journeys) ? journeys : []).filter(item => item && !item.cancelled && Number.isFinite(Date.parse(item.arrivalAt)) && Number.isFinite(Date.parse(item.departureAt)));
  const onTime = ready.filter(item => Date.parse(item.arrivalAt) <= arriveBy).sort((a, b) => Date.parse(b.departureAt) - Date.parse(a.departureAt));
  if (onTime.length) return { ok: true, journey: onTime[0] };
  const earliest = ready.sort((a, b) => Date.parse(a.arrivalAt) - Date.parse(b.arrivalAt))[0];
  if (!earliest) return { ok: false, reason: 'no-route' };
  return { ok: false, reason: 'too-late', journey: earliest };
}
