self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const note = payload.notification || {};
  const title = typeof note.title === 'string' ? note.title.slice(0, 80) : 'Time to leave';
  const body = typeof note.body === 'string' ? note.body.slice(0, 180) : 'Open Nemo for your trip.';
  const target = typeof note.navigate === 'string' ? note.navigate : '/leave.html';
  event.waitUntil(self.registration.showNotification(title, { body, data: { url: target } }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = '/leave.html';
  try {
    const url = new URL(event.notification.data?.url || '/leave.html', self.location.origin);
    if (url.origin === self.location.origin) target = `${url.pathname}${url.search}`;
  } catch { target = '/leave.html'; }
  event.waitUntil(self.clients.openWindow(target));
});
