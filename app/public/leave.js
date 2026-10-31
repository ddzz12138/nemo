export function setText(node, value) { node.textContent = value == null ? '' : String(value); }

export function canSchedule({ confirmation, subscribed }) { return typeof confirmation === 'string' && confirmation.length === 64 && subscribed === true; }

const api = (path, options = {}) => window.nemoFetch(path, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}) }, ...options });

export function createLeaveApp(document, fetchImpl = api) {
  const state = { mode: 'public', destination: null, origin: null, event: null, confirmation: null, subscribed: false, plan: null };
  const status = document.getElementById('status');
  const planner = document.getElementById('planner');
  const previewCard = document.getElementById('previewCard');

  function say(message, kind = '') { setText(status, message); status.dataset.kind = kind; }
  function button(label, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    setText(node, label);
    node.addEventListener('click', onClick);
    return node;
  }
  async function read(path, options) {
    const response = await fetchImpl(path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The trip could not be updated.');
    return body;
  }
  function chosen(node, place, captured) {
    setText(node, place ? `${place.name} · ${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}${captured ? ` · captured ${captured}` : ''}` : 'Not confirmed yet.');
  }
  function results(container, places, pick) {
    container.replaceChildren();
    for (const place of places) container.append(button(place.name, () => pick(place)));
  }
  async function search(query, container, pick) {
    const body = await read(`/api/leave/search?q=${encodeURIComponent(query)}`);
    results(container, body.places, pick);
    if (!body.places.length) say('No matching NSW place was returned.', 'error');
  }
  function renderPlan(plan) {
    previewCard.hidden = false;
    previewCard.replaceChildren();
    const title = document.createElement('h2');
    setText(title, 'Review this trip');
    const summary = document.createElement('p');
    setText(summary, plan.summary);
    const timing = document.createElement('p');
    setText(timing, plan.timing === 'live' ? 'Times include a live Transport for NSW estimate.' : plan.timing === 'timetable' ? 'Timetable only. Live departure times were not in this response.' : 'Using your driving estimate. This is not a live traffic calculation.');
    previewCard.append(title, summary, timing);
    for (const leg of plan.legs || []) {
      const row = document.createElement('p');
      row.className = 'leg';
      setText(row, `${leg.name}: ${leg.from} to ${leg.to}${leg.platform ? `, platform ${leg.platform}` : ''}. ${leg.timing === 'live' ? 'Live' : 'Timetable'}.`);
      previewCard.append(row);
    }
    const maps = document.createElement('a');
    maps.href = plan.mapsUrl;
    maps.target = '_blank';
    maps.rel = 'noopener noreferrer';
    setText(maps, 'Open Maps');
    const note = document.createElement('p');
    setText(note, 'Open Maps launches directions after you tap it. The link itself does not calculate when to leave.');
    const confirm = button('Set this reminder', async () => {
      if (!canSchedule(state)) { say('Enable notifications and preview the trip before setting a reminder.', 'error'); return; }
      const saved = await read('/api/leave/schedule', { method: 'POST', body: JSON.stringify({ confirmation: state.confirmation }) });
      say(`Reminder set. Status: ${saved.reminder.status}. A push acceptance is not proof the phone displayed it.`);
      state.confirmation = null;
    });
    previewCard.append(maps, note, confirm);
  }
  async function load() {
    const body = await read('/api/leave');
    state.subscribed = body.push.subscribed === true;
    setText(document.getElementById('pushNote'), body.push.subscribed
      ? 'Notifications are subscribed for this browser. Delivery still depends on the phone, Focus, and this PC being awake.'
      : 'Add Nemo to the iPhone Home Screen, open it from its icon, then enable notifications. A Safari tab is not enough, and this button alone does not mean alerts are on.');
    const list = document.getElementById('eventList');
    list.replaceChildren();
    if (!body.calendar.events.length) setText(list, body.calendar.connected ? 'No events in the current snapshot.' : 'Calendar is not synced on this PC.');
    for (const event of body.calendar.events) {
      list.append(button(`${event.title} · ${event.start}`, () => {
        state.event = event;
        planner.hidden = false;
        setText(document.getElementById('eventSummary'), event.allDay ? `${event.title} is all day. Enter the time you need to arrive in the preview step.` : event.title);
      }));
    }
    const saved = document.getElementById('savedPlaces');
    saved.replaceChildren();
    for (const place of body.places) saved.append(button(`Use saved ${place.name}`, () => { state.origin = { placeId: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }; chosen(document.getElementById('originChosen'), state.origin, place.capturedAt); }));
    const reminders = document.getElementById('reminderList');
    reminders.replaceChildren();
    if (!body.reminders.length) setText(reminders, 'No reminders on this browser.');
    for (const reminder of body.reminders) reminders.append(button(`${reminder.eventTitle} · ${reminder.status}`, () => { location.href = `/leave.html?trip=${encodeURIComponent(reminder.id)}`; }));
    const trip = new URL(location.href).searchParams.get('trip');
    if (trip) {
      const opened = await read(`/api/leave/trip?id=${encodeURIComponent(trip)}`);
      renderPlan(opened.plan);
    }
  }
  document.getElementById('modePublic').addEventListener('click', () => { state.mode = 'public'; document.getElementById('driveField').hidden = true; document.getElementById('driveNote').hidden = true; });
  document.getElementById('modeDriving').addEventListener('click', () => { state.mode = 'driving'; document.getElementById('driveField').hidden = false; document.getElementById('driveNote').hidden = false; });
  document.getElementById('destinationQuery').addEventListener('change', async () => { await search(document.getElementById('destinationQuery').value, document.getElementById('destinationResults'), place => { state.destination = { searchId: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }; chosen(document.getElementById('destinationChosen'), state.destination); }); });
  document.getElementById('searchOrigin').addEventListener('click', async () => { await search(document.getElementById('originQuery').value, document.getElementById('originResults'), place => { state.origin = { searchId: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }; chosen(document.getElementById('originChosen'), state.origin); }); });
  document.getElementById('useLocation').addEventListener('click', () => {
    if (!navigator.geolocation) { say('This browser cannot provide a location snapshot.', 'error'); return; }
    navigator.geolocation.getCurrentPosition(position => {
      state.origin = { snapshot: { name: 'Location snapshot', latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, capturedAt: new Date(position.timestamp).toISOString() } };
      chosen(document.getElementById('originChosen'), state.origin.snapshot, state.origin.snapshot.capturedAt);
    }, () => say('Location permission was denied. Choose a saved place instead.', 'error'), { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 });
  });
  document.getElementById('enablePush').addEventListener('click', async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission === 'denied') { say('Notifications are unavailable or denied. Open Nemo from the Home Screen icon and allow alerts there.', 'error'); return; }
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { say('Notification permission was not granted.', 'error'); return; }
      const status = await read('/api/leave');
      const padded = status.push.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const key = Uint8Array.from(atob(padded + '='.repeat((4 - padded.length % 4) % 4)), char => char.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = subscription.toJSON();
      await read('/api/leave/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, detail: document.getElementById('detail').value }) });
      state.subscribed = true;
      say('This browser is subscribed. That does not prove an alert has been delivered.');
    } catch (error) { say(error.message, 'error'); }
  });
  document.getElementById('preview').addEventListener('click', async () => {
    try {
      const body = { eventId: state.event?.id, mode: state.mode, arrivalBufferMinutes: Number(document.getElementById('buffer').value), acknowledgeStale: true };
      if (state.destination?.searchId) body.destinationSearchId = state.destination.searchId;
      if (state.destination?.placeId) body.destinationPlaceId = state.destination.placeId;
      if (state.origin?.searchId) body.originSearchId = state.origin.searchId;
      if (state.origin?.placeId) body.originPlaceId = state.origin.placeId;
      if (state.origin?.snapshot) body.originSnapshot = state.origin.snapshot;
      if (state.mode === 'driving') body.manualDurationMinutes = Number(document.getElementById('driveMinutes').value);
      if (document.getElementById('arriveAt').value) body.eventStart = new Date(document.getElementById('arriveAt').value).toISOString();
      const preview = await read('/api/leave/preview', { method: 'POST', body: JSON.stringify(body) });
      state.confirmation = preview.confirmation;
      state.plan = preview.plan;
      renderPlan(preview.plan);
    } catch (error) { say(error.message, 'error'); }
  });
  return { load: () => load().catch(error => say(error.message === 'Failed to fetch' ? 'Nemo is offline.' : error.message, 'error')), state };
}

if (typeof window !== 'undefined') {
  const app = createLeaveApp(document);
  window.createLeaveApp = createLeaveApp;
  app.load();
}
