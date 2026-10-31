import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { PERSONAL_PARTITION, persistPersonalSession, readPersonalSession } = createRequire(import.meta.url)('../desktop/session.cjs');
const { openDesktopStartup } = createRequire(import.meta.url)('../desktop/startup.cjs');

test('the personal partition stays stable and sign-in/sign-out cookie changes are flushed without rewriting their expiry', async () => {
  assert.equal(PERSONAL_PARTITION, 'persist:nemo-personal-chat');
  const cookies = new EventEmitter(); let writes = 0;
  cookies.flushStore = async () => { writes++; };
  const storage = persistPersonalSession({ cookies });
  const cookie = Object.freeze({ name: 'nemo_session', domain: '127.0.0.1', expirationDate: 123456789 });
  cookies.emit('changed', {}, { name: 'other', domain: '127.0.0.1' });
  cookies.emit('changed', {}, { ...cookie, domain: 'google.com' });
  await new Promise(done => setImmediate(done)); assert.equal(writes, 0);
  cookies.emit('changed', {}, cookie, 'explicit', false);
  cookies.emit('changed', {}, cookie, 'expired', true);
  await storage.close(); assert.equal(writes, 3); assert.equal(cookie.expirationDate, 123456789);
  cookies.emit('changed', {}, cookie); await new Promise(done => setImmediate(done)); assert.equal(writes, 3);
});

test('a failed cookie flush is retryable and graceful shutdown still drains the persistence queue', async () => {
  const cookies = new EventEmitter(); let writes = 0;
  cookies.flushStore = async () => { if (++writes === 1) throw new Error('Synthetic write failure'); };
  const storage = persistPersonalSession({ cookies });
  await assert.rejects(storage.flush()); await storage.close(); assert.equal(writes, 2);
});

test('session restoration uses authenticated local requests and distinguishes signed-out sessions from a server outage', async () => {
  const origin = 'http://127.0.0.1:8787', calls = [];
  let response = Response.json({ authenticated: true, profile: { id: 'existing-person' } });
  const session = { async fetch(url, options) { calls.push({ url, options }); return response; } };
  assert.equal((await readPersonalSession(session, origin)).profile.id, 'existing-person');
  assert.equal(calls[0].url, origin + '/api/session'); assert.equal(calls[0].options.credentials, 'include'); assert.equal(calls[0].options.redirect, 'error');
  response = new Response('unavailable', { status: 503 }); await assert.rejects(readPersonalSession(session, origin), /restore your sign-in/);
  response = Response.json({}); await assert.rejects(readPersonalSession(session, origin), /confirm your saved sign-in/);
  response = new Response('', { status: 401 }); assert.deepEqual(await readPersonalSession(session, origin), { authenticated: false });
  for (const bad of ['https://evil.test', 'http://127.0.0.1:8787/path', 'http://person@127.0.0.1:8787']) await assert.rejects(readPersonalSession(session, bad));
});

test('temporary session failures cannot start onboarding or mint another profile invitation', async () => {
  const origin = 'http://127.0.0.1:8787', setupUrl = 'http://127.0.0.1:45555/setup/', opened = [];
  const session = { fetch: async () => new Response('', { status: 503 }) };
  await assert.rejects(openDesktopStartup({ window: { loadURL: async url => opened.push(url) }, appOrigin: origin, setupUrl,
    status: { setupCompleted: true, app: { ready: true } }, fetchSession: () => readPersonalSession(session, origin), openLocal: async () => assert.fail('An outage cannot create a new sign-in.') }), /restore your sign-in/);
  assert.deepEqual(opened, [setupUrl]);
});
