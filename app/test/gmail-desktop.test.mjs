import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createGmailClient, beginGmailConnect, GMAIL_SCOPE } from '../lib/gmail.mjs';
import { createGmailDesktopOnboarding, isLocalGmailRequest } from '../lib/gmail-desktop.mjs';
import { ensureGmailPublisherClient, publisherClient } from '../lib/gmail-publisher.mjs';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
import { createProfileMemory } from '../lib/profile-memory.mjs';
const { gmailAuthorization, authorizeDesktopProfile } = createRequire(import.meta.url)('../desktop/chat-contracts.cjs');
const CID = 'synthetic-desktop.apps.googleusercontent.com';
const json = value => Response.json(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function store(initial = null) { let value = initial; return { get value() { return value; }, async load() { return structuredClone(value); }, async save(next) { value = structuredClone(next); }, async remove() { value = null; } }; }
async function directory(t) {
  const root = await mkdtemp(resolve('.work/gmail-desktop-test-'));
  t.after(async () => { assert.equal(dirname(root), resolve('.work')); assert.ok(root.startsWith(resolve('.work/gmail-desktop-test-'))); await rm(root, { recursive: true, force: true }); });
  return root;
}
function callback(value, code = 'synthetic-code') {
  const authorization = new URL(value.authorizationUrl), url = new URL(authorization.searchParams.get('redirect_uri'));
  url.searchParams.set('state', authorization.searchParams.get('state')); url.searchParams.set('code', code);
  return url;
}

test('publisher packaging contains only a public Desktop client ID and preserves existing operator configuration', async t => {
  const root = await directory(t), path = join(root, 'publisher.json'), dataDir = join(root, 'data');
  const value = { version: 1, clientId: CID };
  assert.throws(() => publisherClient({ ...value, client_secret: 'NEVER_SHIP' }));
  assert.throws(() => publisherClient({ version: 1, clientId: 'not-a-client' }));
  await writeFile(path, JSON.stringify(value));
  await ensureGmailPublisherClient({ dataDir, publisherPath: path });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'google-client.json'))), { installed: { client_id: CID } });
  const existing = '{"installed":{"client_id":"operator.apps.googleusercontent.com","client_secret":"PRIVATE_OPERATOR_CONFIGURATION"}}';
  await writeFile(join(dataDir, 'google-client.json'), existing);
  await ensureGmailPublisherClient({ dataDir, publisherPath: path });
  assert.equal(await readFile(join(dataDir, 'google-client.json'), 'utf8'), existing);
  assert.deepEqual(await ensureGmailPublisherClient({ dataDir, publisherPath: join(root, 'missing') }), { available: false });
});

test('native Gmail permits a current member’s own profile, rejects stale identities and restricts browser targets', async () => {
  const origin = 'http://127.0.0.1:8787', frame = { url: origin + '/desktop.html' }, contents = { mainFrame: frame };
  const options = { event: { sender: contents, senderFrame: frame }, window: { webContents: contents, isDestroyed: () => false }, appOrigin: origin, profileId: 'member', fetchSession: async () => ({ authenticated: true, profile: { id: 'member', role: 'member' } }) };
  await authorizeDesktopProfile(options);
  await assert.rejects(authorizeDesktopProfile({ ...options, profileId: 'owner' }), /profile changed/);
  await assert.rejects(authorizeDesktopProfile({ ...options, fetchSession: async () => ({ authenticated: false }) }));
  await assert.rejects(authorizeDesktopProfile({ ...options, fetchSession: async () => { frame.url = origin + '/pair.html'; return { authenticated: true, profile: { id: 'member' } }; } }));
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ scope: GMAIL_SCOPE, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'b'.repeat(43), redirect_uri: 'http://127.0.0.1:54321/oauth2/callback' })) url.searchParams.set(key, value);
  assert.equal(gmailAuthorization(url.href), url.href);
  for (const target of [url.href.replace('accounts.google.com', 'evil.test'), url.href.replace('S256', 'plain'), url.href.replace('127.0.0.1', 'evil.test'), url.href.replace('gmail.readonly', 'gmail.modify')]) assert.throws(() => gmailAuthorization(target));
});

test('desktop sign-in rejects tunnel hosts, forwarding headers and phone transports', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8787' } };
  assert.equal(isLocalGmailRequest(req), true);
  for (const headers of [{ host: 'nemo.example.test' }, { ...req.headers, 'x-forwarded-host': 'nemo.example.test' }, { ...req.headers, 'cf-connecting-ip': '127.0.0.1' }]) assert.equal(isLocalGmailRequest({ ...req, headers }), false);
  assert.equal(isLocalGmailRequest({ ...req, nemoPhoneLink: true }), false);
  assert.equal(isLocalGmailRequest({ ...req, socket: { remoteAddress: '192.168.1.1' } }), false);
});

test('cancellation during Google exchange aborts transport and never stores a late grant', async t => {
  const root = await directory(t), started = deferred(), release = deferred(), credentials = store();
  await writeFile(join(root, 'google-client.json'), JSON.stringify({ installed: { client_id: CID } }));
  let signal, calls = 0;
  const flow = await beginGmailConnect({ dataDir: root, secretStore: credentials, fetchImpl: async (_, options) => {
    calls++; signal = options.signal; started.resolve(); await release.promise;
    return json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope: GMAIL_SCOPE });
  } });
  t.after(async () => { release.resolve(); await flow.cancel(); });
  const request = fetch(callback(flow)); await started.promise; await flow.cancel();
  assert.equal(signal.aborted, true);
  await assert.rejects(flow.completed, error => error.code === 'GMAIL_AUTH_CANCELLED');
  release.resolve(); assert.equal((await request).status, 502);
  assert.equal(credentials.value, null); assert.equal(calls, 1);
});

test('desktop commit rolls back when the device is revoked during protected save and leaves other profiles untouched', async t => {
  const root = await directory(t), dataDir = join(root, 'profile'); await mkdir(dataDir);
  await writeFile(join(root, 'google-client.json'), JSON.stringify({ installed: { client_id: CID } }));
  const prior = { version: 1, clientId: CID, scope: GMAIL_SCOPE, accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000, account: 'old@example.test' };
  const credentials = store(prior), other = store({ private: 'OTHER_PROFILE' }), cache = store({ version: 1, mode: 'sync', messages: [], lastSyncedAt: null });
  let authorized = true;
  const save = credentials.save.bind(credentials);
  credentials.save = async next => { await save(next); if (next.account === 'new@example.test') authorized = false; };
  const gmail = await createGmailClient({ dataDir, configDir: root, secretStore: credentials, syncStore: cache, fetchImpl: async url => String(url).includes('/token') ? json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: GMAIL_SCOPE }) : json({ emailAddress: 'new@example.test' }) });
  const flow = await gmail.beginDesktopAuthorization({ stillAuthorized: async () => authorized, commit: operation => operation() });
  t.after(() => flow.cancel());
  assert.equal((await fetch(callback(flow))).status, 502);
  await assert.rejects(flow.completed, error => error.code === 'GMAIL_AUTH_CANCELLED');
  assert.deepEqual(credentials.value, prior); assert.deepEqual(other.value, { private: 'OTHER_PROFILE' });
  assert.equal(cache.value, null);
});

test('desktop sign-in attempt limits, single pending flow and device-specific cancellation', async () => {
  const flows = [];
  const manager = createGmailDesktopOnboarding({ gmail: { async beginDesktopAuthorization() { const done = deferred(); const connection = { authorizationUrl: 'synthetic', completed: done.promise, async cancel() { done.resolve(); } }; flows.push(connection); return connection; } }, isAuthorized: async () => true, commit: operation => operation() });
  await manager.start('device-a');
  assert.deepEqual(manager.status('device-b'), { phase: 'idle' });
  manager.cancel('device-b'); assert.equal(manager.status('device-a').phase, 'waiting');
  await assert.rejects(manager.start('device-b'), error => error.code === 'GMAIL_SIGNIN_ACTIVE');
  manager.cancel('device-a');
  for (let i = 0; i < 4; i++) { await manager.start('device-a'); manager.cancel('device-a'); }
  await assert.rejects(manager.start('device-a'), error => error.code === 'GMAIL_RATE_LIMIT');
  manager.close(); await assert.rejects(manager.start('device-b'));
  assert.equal(flows.length, 5);
});

async function familyFixture(t, { memoryFactory = null } = {}) {
  const root = await directory(t), stores = new Map(), clients = new Map(), calls = [], blocked = new Map();
  await writeFile(join(root, 'google-client.json'), JSON.stringify({ installed: { client_id: CID } }));
  const app = await createFamilyServer({ dataDir: root, publicDir: resolve('public'), ownerName: 'Dan', memoryFactory, nativeFactory: null, logger() {}, provider: { status: () => ({ connected: true }), async run() { return { text: 'synthetic' }; } }, async integrationsForProfile(profile, { dataDir, configDir }) {
    const tokens = store(), cache = store(); stores.set(profile.id, tokens);
    let authorization;
    const gmail = await createGmailClient({ dataDir, configDir, secretStore: tokens, syncStore: cache, fetchImpl: async (url, options) => {
      calls.push({ id: profile.id, url: String(url) });
      if (String(url).endsWith('/token')) {
        const fields = new URLSearchParams(options.body); assert.equal(fields.get('client_secret'), null);
        assert.equal(fields.get('client_id'), CID);
        assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(fields.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        return json({ access_token: `access-${profile.id}`, refresh_token: `refresh-${profile.id}`, expires_in: 3600, scope: GMAIL_SCOPE });
      }
      if (String(url).includes('/profile?')) { const pending = blocked.get(profile.id); pending?.started.resolve(); if (pending) await pending.release.promise; return json({ emailAddress: `${profile.name.toLowerCase()}@example.test` }); }
      if (String(url).endsWith('/revoke')) return json({});
      throw new Error('Unexpected synthetic Google request');
    } });
    const begin = gmail.beginDesktopAuthorization;
    gmail.beginDesktopAuthorization = async input => { const result = await begin(input); authorization = new URL(result.authorizationUrl); return result; };
    clients.set(profile.id, gmail);
    return { gmail, calendar: await createCalendarStore({ dataDir }) };
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { for (const value of blocked.values()) value.release.resolve(); await app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function pair(profile) {
    const invitation = await app.profiles.invite(profile.id);
    const response = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invitation.code, expectedProfileId: profile.id, deviceName: 'Synthetic PC' }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return async (path, input, headers = {}) => {
      const res = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Nemo-Profile': profile.id, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: res.status, data: await res.json() };
    };
  }
  const owner = await app.profiles.owner(), member = await app.profiles.create('Alex');
  return { app, owner, member, pair, stores, calls, clients, block(id) { const value = { started: deferred(), release: deferred() }; blocked.set(id, value); return value; } };
}

test('production profile Memory allows first Gmail connections and disconnect before Memory setup', async t => {
  const f = await familyFixture(t, { memoryFactory: createProfileMemory });
  const a = await f.pair(f.owner), b = await f.pair(f.member);
  for (const request of [a, b]) {
    const started = await request('/api/gmail/desktop/start', {}); assert.equal(started.status, 200);
    const returned = await fetch(callback(started.data)); assert.equal(returned.status, 200);
    const connection = await request('/api/gmail/connection');
    assert.equal(connection.data.gmail.connected, true); assert.equal(connection.data.desktop.phase, 'connected');
    const memory = await request('/api/memory/mirror');
    assert.equal(memory.data.engine.connected, false); assert.equal(memory.data.sources.gmail, false);
    assert.equal((await request('/api/integrations')).data.contextConsent, false);
  }
  const other = structuredClone(f.stores.get(f.member.id).value);
  assert.equal((await a('/api/gmail/disconnect', {})).status, 200);
  assert.equal(f.stores.get(f.owner.id).value, null); assert.deepEqual(f.stores.get(f.member.id).value, other);
});

test('unavailable existing Gmail memories block account replacement with a safe actionable reason', async t => {
  let marker;
  const f = await familyFixture(t, { memoryFactory: async options => {
    marker = join(options.profileDataDir, 'memory-mirror.json');
    await writeFile(marker, JSON.stringify({ version: 1, sources: { gmail: true, calendar: false }, counts: { gmail: 1, calendar: 0 }, excluded: [], fingerprints: {} }));
    return createProfileMemory(options);
  } });
  const a = await f.pair(f.owner), started = await a('/api/gmail/desktop/start', {});
  const previous = await readFile(marker, 'utf8');
  const returned = await fetch(callback(started.data)), text = await returned.text();
  assert.equal(returned.status, 502); assert.match(text, /previous Gmail memory copies/);
  const connection = await a('/api/gmail/connection');
  assert.equal(connection.data.desktop.phase, 'error'); assert.equal(connection.data.desktop.message, text);
  assert.equal(f.stores.get(f.owner.id).value, null); assert.equal(await readFile(marker, 'utf8'), previous);
});

test('real family HTTP connects two private desktop grants without Web OAuth, invites or automatic tool consent', async t => {
  const f = await familyFixture(t), a = await f.pair(f.owner), b = await f.pair(f.member);
  for (const [profile, request] of [[f.owner, a], [f.member, b]]) {
    const connection = await request('/api/gmail/connection');
    assert.equal(connection.data.desktop.available, true); assert.equal(connection.data.phone.available, false);
    const flow = await request('/api/gmail/desktop/start', {}); assert.equal(flow.status, 200);
    assert.equal((await fetch(callback(flow.data))).status, 200);
    assert.equal((await request('/api/gmail/connection')).data.gmail.account, `${profile.name.toLowerCase()}@example.test`);
    assert.equal((await request('/api/integrations')).data.contextConsent, false);
  }
  assert.notEqual(f.stores.get(f.owner.id).value.refreshToken, f.stores.get(f.member.id).value.refreshToken);
  assert.equal((await a('/api/gmail/desktop/start', { profileId: f.member.id })).status, 400);
  assert.equal((await a('/api/gmail/desktop/start', {}, { 'X-Nemo-Profile': f.member.id })).status, 409);
  assert.equal((await a('/api/gmail/desktop/start', {}, { 'X-Forwarded-Host': 'nemo.example.test' })).status, 403);
  assert.equal((await a('/api/gmail/disconnect', {})).status, 200);
  assert.equal(f.stores.get(f.owner.id).value, null);
  assert.equal((await b('/api/gmail/connection')).data.gmail.account, 'alex@example.test');
});

for (const action of ['cancel', 'logout', 'disconnect']) test(`a ${action} during Google account lookup cannot commit after returning to Nemo`, async t => {
  const f = await familyFixture(t), a = await f.pair(f.owner), b = await f.pair(f.owner), blocked = f.block(f.owner.id);
  const started = await a('/api/gmail/desktop/start', {}); assert.equal(started.status, 200);
  assert.equal((await b('/api/gmail/connection')).data.desktop.phase, 'idle');
  const pending = fetch(callback(started.data)); await blocked.started.promise;
  if (action === 'cancel') { await b('/api/gmail/desktop/cancel', {}); assert.equal((await a('/api/gmail/connection')).data.desktop.phase, 'waiting'); }
  const path = action === 'cancel' ? '/api/gmail/desktop/cancel' : action === 'logout' ? '/api/logout' : '/api/gmail/disconnect';
  assert.equal((await a(path, {})).status, 200);
  blocked.release.resolve(); assert.equal((await pending).status, 502);
  assert.equal(f.stores.get(f.owner.id).value, null);
});
