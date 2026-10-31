import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { RemoteCloudStore } from '../lib/remote-cloud-store.mjs';
import { CloudflareRemoteProvider, NEMO_TUNNEL_ORIGIN } from '../lib/remote-cloud-provider.mjs';
import { GoogleRemoteIdentity, remoteSecret } from '../lib/remote-cloud-auth.mjs';
import { RemoteCloudService, createRemoteCloudServer, remoteCloudConfigFromEnv } from '../lib/remote-cloud-service.mjs';
import { startRemoteService } from '../remote-service.mjs';
import { createRemoteCloudClient } from '../lib/remote-host-cloud-client.mjs';

const domain = 'family.example';
const operatorToken = 'operator-secret-must-never-reach-a-desktop';
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32);

/** Stateful simulated control plane: can lose a successful response, exactly like a network failure. */
function fakeCloudflare() {
  const state = { tunnels: new Map(), dns: new Map(), configurations: new Map(), calls: [], connectorTokens: new Map(), fail: null };
  state.fetch = async (rawUrl, request = {}) => {
    assert.equal(request.headers.Authorization, `Bearer ${operatorToken}`);
    const url = new URL(rawUrl), path = url.pathname.replace('/client/v4', ''), method = request.method || 'GET';
    const input = request.body ? JSON.parse(request.body) : undefined;
    state.calls.push({ path, method, input });
    if (state.fail?.before && state.fail.match({ path, method, input })) { state.fail = null; throw new Error('provider raw diagnostic with operator-secret'); }
    let result;
    const tunnelBase = `/accounts/${accountId}/cfd_tunnel`, dnsBase = `/zones/${zoneId}/dns_records`;
    if (path === tunnelBase && method === 'GET') result = [...state.tunnels.values()].filter(item => !item.deleted_at && item.name === url.searchParams.get('name'));
    else if (path === tunnelBase && method === 'POST') {
      assert.equal(input.config_src, 'cloudflare');
      assert.equal([...state.tunnels.values()].filter(item => !item.deleted_at && item.name === input.name).length, 0, 'recovery must not duplicate tunnels');
      result = { id: randomUUID(), name: input.name, config_src: 'cloudflare' };
      state.tunnels.set(result.id, result); state.connectorTokens.set(result.id, `installation-connector-${randomUUID()}`);
    } else if (path.startsWith(`${tunnelBase}/`)) {
      const [id, action] = path.slice(tunnelBase.length + 1).split('/');
      if (!state.tunnels.has(id) || state.tunnels.get(id).deleted_at) return new Response(JSON.stringify({ success: false }), { status: 404 });
      if (action === 'configurations' && method === 'PUT') { state.configurations.set(id, input.config); result = {}; }
      else if (action === 'token' && method === 'GET') result = state.connectorTokens.get(id);
      else if (action === 'connections' && method === 'DELETE') result = {};
      else if (!action && method === 'DELETE') { state.tunnels.get(id).deleted_at = new Date().toISOString(); result = {}; }
      else assert.fail(`Unexpected tunnel operation ${method} ${path}`);
    } else if (path === dnsBase && method === 'GET') result = [...state.dns.values()].filter(item => item.name === url.searchParams.get('name'));
    else if (path === dnsBase && method === 'POST') { result = { ...input, id: randomUUID() }; state.dns.set(result.id, result); }
    else if (path.startsWith(`${dnsBase}/`) && method === 'DELETE') { state.dns.delete(path.slice(dnsBase.length + 1)); result = {}; }
    else assert.fail(`Unexpected provider operation ${method} ${path}`);
    if (state.fail && state.fail.match({ path, method, input })) { state.fail = null; throw new Error('response lost after successful write'); }
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  return state;
}

function fakeIdentity() {
  return {
    authorizationUrl: async ({ state }) => `https://accounts.google.com/signin?state=${encodeURIComponent(state)}`,
    exchange: async ({ code }) => ({ ownerId: `google:${code}`, email: `${code}@example.com` }),
  };
}

function fixture({ store = new RemoteCloudStore(), cloud = fakeCloudflare(), now = () => Date.now() } = {}) {
  const provider = new CloudflareRemoteProvider({ accountId, zoneId, apiToken: operatorToken, domain, fetchImpl: cloud.fetch });
  const identity = fakeIdentity();
  const service = new RemoteCloudService({ store, provider, identity, origin: 'https://setup.example', domain, publicSignup: true, now });
  return { service, store, cloud, provider, identity };
}

async function ownerSession(service, enrollment, owner = 'parent') {
  const start = await service.startSignIn(new URL(enrollment.browserUrl).searchParams.get('code'));
  return service.finishSignIn({ state: new URL(start.authorizationUrl).searchParams.get('state'), browserBinding: start.browserBinding, code: owner });
}
async function approved(f, owner = 'parent') {
  const installationId = randomUUID(), installationSecret = remoteSecret();
  const enrollment = await f.service.beginEnrollment({ installationId, installationSecret, displayName: 'Family computer' });
  const session = await ownerSession(f.service, enrollment, owner);
  await f.service.approveEnrollment(enrollment.enrollmentId, session.sessionToken, session.csrf);
  return { installationId, installationSecret, enrollment, session };
}

test('a parent signs in, confirms their own computer, and gets only their connector credential', async () => {
  const f = fixture(), computer = await approved(f);
  const result = await f.service.enable(computer.installationId, computer.installationSecret);
  assert.equal(result.status, 'active');
  assert.match(result.publicOrigin, /^https:\/\/host-[a-f\d]{32}\.family\.example$/);
  assert.equal(result.connectorToken, f.cloud.connectorTokens.get(result.tunnelId));
  assert.deepEqual(f.cloud.configurations.get(result.tunnelId), { ingress: [{ hostname: new URL(result.publicOrigin).hostname, service: NEMO_TUNNEL_ORIGIN, originRequest: {} }, { service: 'http_status:404' }] });
  const safe = await f.service.getInstallation(computer.installationId, computer.installationSecret);
  assert.equal(safe.connectorToken, undefined);
  assert.equal(safe.ownerId, undefined);
  const saved = await f.store.read(state => state);
  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes(operatorToken));
  assert.ok(!serialized.includes(computer.installationSecret));
  assert.ok(!serialized.includes(result.connectorToken), 'connector credentials are fetched only when needed, never stored');
});

test('installation credentials and browser approvals cannot cross owners or replay OAuth state', async () => {
  const f = fixture(), first = await approved(f, 'alice'), second = await approved(f, 'bob');
  await assert.rejects(f.service.getInstallation(first.installationId, second.installationSecret), error => error.code === 'unauthorized');
  await assert.rejects(f.service.enable(first.installationId, second.installationSecret), error => error.code === 'unauthorized');
  await assert.rejects(f.service.retire(first.installationId, second.installationSecret), error => error.code === 'unauthorized');
  await assert.rejects(f.service.beginEnrollment({ installationId: first.installationId, installationSecret: second.installationSecret }), error => error.code === 'unauthorized');
  await assert.rejects(f.service.approveEnrollment(first.enrollment.enrollmentId, second.session.sessionToken, second.session.csrf), error => error.code === 'unauthorized');
  await assert.rejects(f.service.approveEnrollment(first.enrollment.enrollmentId, first.session.sessionToken, second.session.csrf), error => error.code === 'unauthorized');
  const pending = await f.service.beginEnrollment({ installationId: randomUUID(), installationSecret: remoteSecret() });
  const start = await f.service.startSignIn(new URL(pending.browserUrl).searchParams.get('code'));
  const callback = { state: new URL(start.authorizationUrl).searchParams.get('state'), browserBinding: start.browserBinding, code: 'alice' };
  await assert.rejects(f.service.finishSignIn({ ...callback, browserBinding: remoteSecret() }), error => error.code === 'unauthorized');
  await f.service.finishSignIn(callback);
  await assert.rejects(f.service.finishSignIn(callback), error => error.code === 'unauthorized');
  assert.equal(f.cloud.calls.length, 0, 'sign-in and unauthorized calls never provision cloud resources');
});

test('two owners signing into one pending link cannot change the first approved owner', async () => {
  const f = fixture(), installationId = randomUUID(), installationSecret = remoteSecret();
  const enrollment = await f.service.beginEnrollment({ installationId, installationSecret });
  const alice = await ownerSession(f.service, enrollment, 'alice');
  const bob = await ownerSession(f.service, enrollment, 'bob');
  await f.service.approveEnrollment(enrollment.enrollmentId, alice.sessionToken, alice.csrf);
  await assert.rejects(f.service.approveEnrollment(enrollment.enrollmentId, bob.sessionToken, bob.csrf), error => error.code === 'unauthorized');
  assert.equal(await f.store.read(state => state.installations[installationId].ownerId), 'google:alice');
});

test('a lost create-tunnel response recovers after a service restart without changing hostname or creating another tunnel', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nemo-cloud-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'remote.json');
  const f = fixture({ store: new RemoteCloudStore(path) }), computer = await approved(f);
  const before = await f.service.getInstallation(computer.installationId, computer.installationSecret);
  f.cloud.fail = { match: ({ method, path: url }) => method === 'POST' && url.endsWith('/cfd_tunnel') };
  await assert.rejects(f.service.enable(computer.installationId, computer.installationSecret), error => error.code === 'cloudflare_unavailable');
  assert.equal(f.cloud.tunnels.size, 1);
  const restored = fixture({ store: new RemoteCloudStore(path), cloud: f.cloud });
  const result = await restored.service.enable(computer.installationId, computer.installationSecret);
  assert.equal(result.publicOrigin, before.publicOrigin);
  assert.equal(result.status, 'active');
  assert.equal(f.cloud.tunnels.size, 1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const operations = Object.values(saved.operations);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].attempts, 2);
  assert.equal(operations[0].status, 'complete');
});

test('a lost DNS-write response and simultaneous retries converge on one record and one tunnel', async () => {
  const f = fixture(), computer = await approved(f);
  f.cloud.fail = { match: ({ method, path }) => method === 'POST' && path.endsWith('/dns_records') };
  await assert.rejects(f.service.enable(computer.installationId, computer.installationSecret));
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.enable(computer.installationId, computer.installationSecret)));
  assert.equal(new Set(results.map(item => item.publicOrigin)).size, 1);
  assert.equal(f.cloud.tunnels.size, 1);
  assert.equal(f.cloud.dns.size, 1);
  assert.equal(await f.store.read(state => Object.keys(state.operations).length), 1);
});

test('unexpected DNS is never overwritten and provider internals are not public', async () => {
  const f = fixture(), computer = await approved(f);
  const record = await f.store.read(state => state.installations[computer.installationId]);
  f.cloud.dns.set('foreign', { id: 'foreign', name: record.hostname, type: 'A', content: '192.0.2.1', proxied: true });
  await assert.rejects(f.service.enable(computer.installationId, computer.installationSecret), error => error.code === 'dns_conflict');
  assert.equal(f.cloud.dns.get('foreign').content, '192.0.2.1');
  const safe = await f.service.getInstallation(computer.installationId, computer.installationSecret);
  assert.equal(safe.error.code, 'dns_conflict');
  assert.ok(!JSON.stringify(safe).includes('192.0.2.1'));
});

test('retirement stays pending on partial failure, denies new enable, and recovers before stable-host reconnection', async () => {
  const f = fixture(), computer = await approved(f);
  const enabled = await f.service.enable(computer.installationId, computer.installationSecret);
  f.cloud.fail = { before: true, match: ({ method, path }) => method === 'DELETE' && path.endsWith('/connections') };
  await assert.rejects(f.service.retire(computer.installationId, computer.installationSecret));
  assert.equal((await f.service.getInstallation(computer.installationId, computer.installationSecret)).status, 'retiring');
  assert.equal(f.cloud.dns.size, 0);
  assert.deepEqual(f.cloud.configurations.get(enabled.tunnelId), { ingress: [{ service: 'http_status:404' }] });
  await assert.rejects(f.service.enable(computer.installationId, computer.installationSecret), error => error.code === 'retirement_pending');
  assert.equal((await f.service.retire(computer.installationId, computer.installationSecret)).status, 'retired');
  assert.ok(f.cloud.tunnels.get(enabled.tunnelId).deleted_at);
  const reenabled = await f.service.enable(computer.installationId, computer.installationSecret);
  assert.equal(reenabled.publicOrigin, enabled.publicOrigin);
  assert.notEqual(reenabled.tunnelId, enabled.tunnelId);
  assert.notEqual(reenabled.connectorToken, enabled.connectorToken);
});

test('expired setup can restart with its original credential, cannot be taken over, and never provisions', async () => {
  let time = Date.now();
  const f = fixture({ now: () => time }), installationId = randomUUID(), installationSecret = remoteSecret();
  const first = await f.service.beginEnrollment({ installationId, installationSecret });
  assert.deepEqual(await f.service.beginEnrollment({ installationId, installationSecret }), first);
  time += 16 * 60000;
  await assert.rejects(f.service.pollEnrollment(first.enrollmentId, installationSecret), error => error.code === 'enrollment_expired');
  await assert.rejects(f.service.beginEnrollment({ installationId, installationSecret: remoteSecret() }), error => error.code === 'unauthorized');
  const second = await f.service.beginEnrollment({ installationId, installationSecret });
  assert.notEqual(second.enrollmentId, first.enrollmentId);
  assert.equal(f.cloud.calls.length, 0);
});

test('pilot owner allowlist and per-owner computer quotas are enforced before provisioning', async () => {
  const f = fixture();
  f.service.publicSignup = false; f.service.allowedEmails = ['parent@example.com']; f.service.maxInstallationsPerOwner = 1;
  await approved(f, 'parent');
  await assert.rejects(approved(f, 'outsider'), error => error.code === 'signup_not_enabled');
  await assert.rejects(approved(f, 'parent'), error => error.code === 'computer_limit');
  assert.equal(f.cloud.calls.length, 0);
});

test('retired installations cannot bypass the family computer quota by reconnecting', async () => {
  const f = fixture(); f.service.maxInstallationsPerOwner = 1;
  const first = await approved(f, 'parent');
  await f.service.enable(first.installationId, first.installationSecret);
  await f.service.retire(first.installationId, first.installationSecret);
  await approved(f, 'parent');
  await assert.rejects(f.service.enable(first.installationId, first.installationSecret), error => error.code === 'computer_limit');
  assert.equal((await f.service.getInstallation(first.installationId, first.installationSecret)).status, 'retired');
});

test('Google identity checks signature, exact audience, expiry, nonce, and authorized presenter', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const adapter = new GoogleRemoteIdentity({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://setup.example/auth/google/callback', now: () => now, fetchImpl: async url => new Response(JSON.stringify(url.includes('openid-configuration') ? { issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs' } : { keys: [jwk] })) });
  const claims = { iss: 'https://accounts.google.com', aud: 'client', sub: '12345', nonce: 'expected', exp: seconds + 3600, iat: seconds, email: 'Parent@Example.com', email_verified: true };
  const jwt = (overrides = {}, key = privateKey, algorithm = 'RS256') => {
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'key-1' })).toString('base64url'), payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url');
    return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
  };
  assert.deepEqual(await adapter.verifyIdToken(jwt(), 'expected'), { ownerId: 'google:12345', email: 'parent@example.com' });
  for (const overrides of [{ aud: 'another-client' }, { iss: 'https://attacker.example' }, { exp: seconds - 1 }, { nonce: 'replayed' }, { iat: seconds + 120 }, { azp: 'another-client' }, { aud: ['client', 'another-client'] }]) await assert.rejects(adapter.verifyIdToken(jwt(overrides), 'expected'), error => error.code === 'sign_in_failed');
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(adapter.verifyIdToken(jwt({}, otherKey), 'expected'));
  await assert.rejects(adapter.verifyIdToken(jwt({}, privateKey, 'none'), 'expected'));
});

test('HTTP contract blocks foreign origins, client-chosen routes, unauthenticated credentials, and secret leakage', async t => {
  const f = fixture(), computer = await approved(f);
  const config = { origin: 'https://setup.example', cloudflare: { domain }, publicSignup: true };
  const logged = [];
  const { server } = createRemoteCloudServer({ config, store: f.store, provider: f.provider, identity: f.identity, service: f.service, onError: item => logged.push(item) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, body = {}, secret = computer.installationSecret, extraHeaders = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...extraHeaders }, body: JSON.stringify(body) });
  const route = `/v1/installations/${computer.installationId}`;
  assert.equal((await api(`${route}/enable`, {}, computer.installationSecret, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await api(`${route}/enable`, { origin: 'http://127.0.0.1:22' })).status, 400);
  assert.equal((await api(`${route}/credentials`, {}, remoteSecret())).status, 401);
  const result = await api(`${route}/enable`);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control'), /no-store/);
  const payload = await result.json();
  assert.ok(payload.connectorToken);
  assert.ok(!JSON.stringify(payload).includes(operatorToken));
  const statusResponse = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${computer.installationSecret}` } });
  assert.equal((await statusResponse.json()).connectorToken, undefined);
  assert.ok(logged.every(item => Object.keys(item).sort().join(',') === 'code,status'));
  assert.ok(!JSON.stringify(logged).includes(computer.installationSecret));
});

test('missing operator settings fail closed without revealing configured secrets', () => {
  assert.throws(() => remoteCloudConfigFromEnv({}), /NEMO_REMOTE_GOOGLE_CLIENT_ID/);
  const env = { NEMO_REMOTE_ORIGIN: 'https://setup.example', NEMO_REMOTE_DATA_FILE: 'state.json', NEMO_REMOTE_GOOGLE_CLIENT_ID: 'client', NEMO_REMOTE_GOOGLE_CLIENT_SECRET: 'secret', NEMO_REMOTE_CF_ACCOUNT_ID: accountId, NEMO_REMOTE_CF_ZONE_ID: zoneId, NEMO_REMOTE_CF_API_TOKEN: operatorToken, NEMO_REMOTE_DOMAIN: domain };
  assert.throws(() => remoteCloudConfigFromEnv(env), /NEMO_REMOTE_ALLOWED_EMAILS/);
  assert.throws(() => remoteCloudConfigFromEnv({ ...env, NEMO_REMOTE_PUBLIC_SIGNUP: '1', NEMO_REMOTE_ORIGIN: 'http://setup.example' }), /HTTPS/);
  assert.equal(remoteCloudConfigFromEnv({ ...env, NEMO_REMOTE_ALLOWED_EMAILS: 'Parent@Example.com' }).allowedEmails[0], 'parent@example.com');
});

test('browser setup requires its bound login and an explicit same-origin CSRF-protected confirmation', async t => {
  const f = fixture();
  const { server } = createRemoteCloudServer({ config: { origin: 'https://setup.example', cloudflare: { domain } }, store: f.store, provider: f.provider, identity: f.identity, service: f.service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const installationId = randomUUID(), installationSecret = remoteSecret();
  const enrolled = await fetch(`${base}/v1/enrollments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installationId, installationSecret, displayName: '<Family computer>' }) });
  const enrollment = await enrolled.json();
  assert.ok(!enrollment.browserUrl.includes(installationSecret));
  const landing = await fetch(`${base}${new URL(enrollment.browserUrl).pathname}${new URL(enrollment.browserUrl).search}`);
  const landingHtml = await landing.text();
  assert.ok(landingHtml.includes('&lt;Family computer&gt;'));
  const start = await fetch(`${base}/auth/google?code=${new URL(enrollment.browserUrl).searchParams.get('code')}`, { redirect: 'manual' });
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  assert.match(start.headers.getSetCookie()[0], /Secure; SameSite=Lax; Max-Age=600; HttpOnly/);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = `/auth/google/callback?state=${encodeURIComponent(state)}&code=parent`;
  assert.equal((await fetch(`${base}${callback}`, { redirect: 'manual' })).status, 401);
  const signedIn = await fetch(`${base}${callback}`, { redirect: 'manual', headers: { Cookie: binding } });
  assert.equal(signedIn.status, 303);
  const jar = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await f.service.pollEnrollment(enrollment.enrollmentId, installationSecret)).status, 'pending');
  const path = signedIn.headers.get('location');
  const confirmation = await fetch(`${base}${path}`, { headers: { Cookie: jar } });
  const confirmationHtml = await confirmation.text();
  assert.ok(confirmationHtml.includes(enrollment.confirmationCode));
  const csrf = /name="csrf" value="([a-z\d_-]+)"/i.exec(confirmationHtml)[1];
  const confirm = (token, origin = 'https://setup.example') => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: jar, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token }) });
  assert.equal((await confirm(csrf, 'https://attacker.example')).status, 403);
  assert.equal((await confirm(remoteSecret())).status, 401);
  assert.equal((await confirm(csrf)).status, 303);
  assert.equal((await f.service.pollEnrollment(enrollment.enrollmentId, installationSecret)).status, 'approved');
  assert.equal(f.cloud.calls.length, 0, 'the parent still chooses Enable in the desktop before cloud provisioning');
  assert.equal((await fetch(`${base}${callback}`, { redirect: 'manual', headers: { Cookie: binding } })).status, 401, 'callback replay fails');
});

test('corrupt persistent state never falls back to a new ownership database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nemo-cloud-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  await writeFile(path, JSON.stringify({ version: 1, installations: { privateOwner: 'must-stay-private' } }));
  const store = new RemoteCloudStore(path);
  await assert.rejects(store.read(state => state), /Invalid remote service database/);
  await assert.rejects(store.transaction(state => { state.installations = {}; }), /Invalid remote service database/);
  assert.ok((await readFile(path, 'utf8')).includes('must-stay-private'));
  await writeFile(path, '{ private-session-secret');
  await assert.rejects(new RemoteCloudStore(path).read(state => state), error => error.message.includes('Invalid remote service database') && !error.message.includes('private-session-secret'));
});

test('service startup excludes a second writer and cleans up its lock after invalid configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nemo-cloud-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { origin: 'https://setup.example', dataFile: join(directory, 'state.json'), host: '127.0.0.1', port: 0, allowedEmails: ['parent@example.com'], cloudflare: { accountId, zoneId, apiToken: operatorToken, domain }, google: { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://setup.example/auth/google/callback' } };
  const instance = await startRemoteService(config);
  try { await assert.rejects(startRemoteService(config), /database is locked/); }
  finally { await instance.close(); }
  await assert.rejects(readFile(`${config.dataFile}.lock`), error => error.code === 'ENOENT');
  await assert.rejects(startRemoteService({ ...config, cloudflare: { ...config.cloudflare, accountId: 'invalid' } }), /Cloudflare remote access needs/);
  await assert.rejects(readFile(`${config.dataFile}.lock`), error => error.code === 'ENOENT');
});

test('the desktop cloud client speaks the real hosted HTTP contract through enrollment and reconnect', async t => {
  const f = fixture();
  const { server } = createRemoteCloudServer({ config: { origin: 'https://setup.example', cloudflare: { domain } }, store: f.store, provider: f.provider, identity: f.identity, service: f.service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createRemoteCloudClient({ origin: 'https://setup.example', fetchImpl: (url, request) => { const parsed = new URL(url); assert.equal(parsed.origin, 'https://setup.example'); return fetch(`${base}${parsed.pathname}${parsed.search}`, request); } });
  const identity = { installationId: randomUUID(), installationSecret: remoteSecret(), displayName: 'Family computer' };
  const enrollment = await client.beginEnrollment(identity);
  assert.equal(enrollment.status, 'pending');
  assert.equal((await client.pollEnrollment({ enrollmentId: enrollment.enrollmentId, installationSecret: identity.installationSecret })).status, 'pending');
  const session = await ownerSession(f.service, enrollment);
  await f.service.approveEnrollment(enrollment.enrollmentId, session.sessionToken, session.csrf);
  assert.equal((await client.pollEnrollment({ enrollmentId: enrollment.enrollmentId, installationSecret: identity.installationSecret })).status, 'approved');
  const recovered = await client.beginEnrollment(identity);
  assert.equal(recovered.status, 'approved', 'a lost desktop poll response resumes without asking the parent to sign in again');
  assert.equal(recovered.browserUrl, null);
  const enabled = await client.enable(identity);
  assert.equal(enabled.status, 'active');
  assert.equal((await client.credentials(identity)).connectorToken, enabled.connectorToken);
  assert.equal((await client.get(identity)).connectorToken, undefined);
  assert.equal((await client.retire(identity)).status, 'retired');
  const connectedAgain = await client.enable(identity);
  assert.equal(connectedAgain.publicOrigin, enabled.publicOrigin);
  assert.notEqual(connectedAgain.tunnelId, enabled.tunnelId);
  const pendingSecret = remoteSecret();
  const pending = await client.beginEnrollment({ installationId: randomUUID(), installationSecret: pendingSecret });
  f.service.now = () => Date.now() + 16 * 60000;
  await assert.rejects(client.pollEnrollment({ enrollmentId: pending.enrollmentId, installationSecret: pendingSecret }), error => error.code === 'ENROLLMENT_EXPIRED');
});
