import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createGmailClient, beginGmailConnect, installGmailDesktopClient, GMAIL_SCOPE } from '../lib/gmail.mjs';

const NOW = 1_000_000;
const CLIENT_ID = '1234567890-nemo-test.apps.googleusercontent.com';
const CONFIG = { installed: { client_id: CLIENT_ID, client_secret: 'desktop-client-secret', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' } };
const record = (extra = {}) => ({ version: 1, clientId: CLIENT_ID, scope: GMAIL_SCOPE, accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: NOW + 3_600_000, account: 'owner@example.test', ...extra });
const response = (json, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });

test('selected body reading is read-only, bounded and bound to the current Gmail grant', async t => {
  const calls = [];
  const f = await fixture(t, { stored: record(), fetchImpl: async input => {
    const url = new URL(input); calls.push(url);
    assert.equal(url.pathname, '/gmail/v1/users/me/messages/notice-1'); assert.equal(url.searchParams.get('format'), 'full');
    return response({ id: 'notice-1', payload: { mimeType: 'text/plain', body: { data: Buffer.from('Return the form by 5 November 2026.').toString('base64url') }, headers: [{ name: 'Subject', value: 'School' }] } });
  } });
  const client = await f.client(), grant = await client.noticeGrant();
  const source = await client.readSelectedNotice({ id: 'notice-1', grant }); assert.match(source.text, /Return the form/); assert.equal(source.bodyComplete, true); assert.equal(f.secretStore.saves, 0);
  f.secretStore.value = record({ refreshToken: 'another-grant', account: 'other@example.test' });
  await assert.rejects(client.readSelectedNotice({ id: 'notice-1', grant }), { code: 'GMAIL_NOTICE_ACCOUNT' }); assert.equal(calls.length, 1);
  await assert.rejects(client.readSelectedNotice({ id: '../foreign', grant }), { code: 'GMAIL_NOTICE_SELECTION' });
});

function memoryStore(initial = null) {
  let value = initial;
  return { loads: 0, saves: 0, removes: 0, get value() { return value; }, set value(next) { value = next; }, async load() { this.loads++; return value && structuredClone(value); }, async save(next) { this.saves++; value = structuredClone(next); }, async remove() { this.removes++; value = null; } };
}

async function fixture(t, { configured = true, stored = null, fetchImpl = async () => assert.fail('Unexpected network request') } = {}) {
  const prefix = fileURLToPath(new URL('./.tmp-gmail-', import.meta.url));
  const root = await mkdtemp(prefix);
  const dataDir = join(root, '.nemo');
  await mkdir(dataDir);
  if (configured) await writeFile(join(dataDir, 'google-client.json'), JSON.stringify(CONFIG));
  const secretStore = memoryStore(stored);
  const connections = [];
  t.after(async () => {
    for (const connection of connections) await connection.cancel();
    const absolute = resolve(root);
    assert.equal(dirname(absolute), dirname(resolve(prefix)));
    assert.ok(basename(absolute).startsWith(basename(prefix)) && basename(absolute).length > basename(prefix).length);
    await rm(absolute, { recursive: true, force: true });
  });
  return { dataDir, root, secretStore, async client(options = {}) { return createGmailClient({ dataDir, fetchImpl, secretStore, now: () => NOW, ...options }); }, async connect(options = {}) { const connection = await beginGmailConnect({ dataDir, fetchImpl, secretStore, now: () => NOW, ...options }); connections.push(connection); return connection; } };
}

test('unconfigured, disconnected, and corrupt credentials report honest status without network access', async t => {
  const f = await fixture(t, { configured: false });
  let client = await f.client();
  assert.deepEqual(client.status(), { configured: false, connected: false });
  assert.equal(f.secretStore.loads, 0);
  await assert.rejects(client.search(), { code: 'GMAIL_NOT_CONFIGURED' });
  await writeFile(join(f.dataDir, 'google-client.json'), JSON.stringify(CONFIG));
  assert.deepEqual(await client.reload(), { configured: true, connected: false });
  await assert.rejects(client.search(), { code: 'GMAIL_NOT_CONNECTED' });
  f.secretStore.value = { accessToken: 'unusable-record' };
  assert.deepEqual(await client.reload(), { configured: true, connected: false });
  await assert.rejects(client.search(), { code: 'GMAIL_STORAGE' });
});

test('read-only search requests metadata only and returns no body or attachment content', async t => {
  const calls = [];
  const f = await fixture(t, { stored: record(), fetchImpl: async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer test-access-token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('q'), 'in:inbox newer_than:7d');
      assert.equal(url.searchParams.get('maxResults'), '5');
      return response({ messages: [{ id: 'mail-1' }] });
    }
    assert.equal(url.searchParams.get('format'), 'metadata');
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);
    assert.equal(url.searchParams.get('fields'), 'id,snippet,payload(headers(name,value))');
    return response({ id: 'mail-1', snippet: 'A short preview', payload: { body: { data: 'SECRET_FULL_BODY' }, parts: [{ filename: 'SECRET_ATTACHMENT' }], headers: [{ name: 'From', value: 'Alice <alice@example.test>' }, { name: 'Subject', value: 'Demo update' }, { name: 'Date', value: 'Tue, 20 Oct 2026 10:00:00 +1100' }] } });
  } });
  const client = await f.client();
  assert.deepEqual(client.status(), { configured: true, connected: true, account: 'owner@example.test' });
  const messages = await client.search();
  assert.deepEqual(messages, [{ id: 'mail-1', from: 'Alice <alice@example.test>', subject: 'Demo update', date: 'Tue, 20 Oct 2026 10:00:00 +1100', snippet: 'A short preview' }]);
  assert.equal(JSON.stringify(messages).includes('SECRET'), false);
  assert.equal(calls.length, 2);
});

test('search validates untrusted inputs before any network request', async t => {
  const f = await fixture(t, { stored: record() });
  const client = await f.client();
  for (const input of [null, [], { query: '' }, { query: '\nfrom:someone' }, { query: '\0' }, { query: 'x'.repeat(501) }, { query: 42 }]) await assert.rejects(client.search(input), { code: 'GMAIL_QUERY_INVALID' });
  for (const limit of [0, -1, 11, 1.5, '5', NaN]) await assert.rejects(client.search({ limit }), { code: 'GMAIL_LIMIT_INVALID' });
  await assert.rejects(client.search({ query: 'flight', unexpected: true }), { code: 'GMAIL_QUERY_INVALID' });
  for (const pageToken of ['', 'has space', 'x\n', '\0', 'x'.repeat(4097), null, [], 7]) await assert.rejects(client.searchPage({ pageToken }), { code: 'GMAIL_PAGE_INVALID' });
});

test('paged search reaches the eleventh match with the same query and exposes only bounded metadata', async t => {
  const lists = [];
  const metadata = [];
  const query = 'from:airline@example.test subject:flight';
  const f = await fixture(t, { stored: record(), fetchImpl: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer test-access-token');
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/messages')) {
      lists.push(url);
      assert.equal(url.searchParams.get('q'), query);
      assert.equal(url.searchParams.get('maxResults'), '10');
      assert.equal(url.searchParams.get('fields'), 'messages(id),nextPageToken,resultSizeEstimate');
      if (!url.searchParams.has('pageToken')) return response({ messages: Array.from({ length: 10 }, (_, i) => ({ id: `mail-${i + 1}` })), nextPageToken: 'fixture-page-2+/=', resultSizeEstimate: 11 });
      assert.equal(url.searchParams.get('pageToken'), 'fixture-page-2+/=');
      return response({ messages: [{ id: 'mail-11' }], resultSizeEstimate: 11 });
    }
    metadata.push(url.pathname.split('/').at(-1));
    assert.equal(url.searchParams.get('format'), 'metadata');
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);
    return response({ snippet: 'Matched flight snippet', payload: { headers: [{ name: 'Subject', value: 'Flight confirmation' }], body: { data: 'SECRET_BODY' }, parts: [{ filename: 'SECRET_ATTACHMENT' }] } });
  } });
  const client = await f.client();
  const first = await client.searchPage({ query: ` ${query} `, limit: 10 });
  assert.equal(first.messages.length, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextPageToken, 'fixture-page-2+/=');
  assert.equal(first.resultSizeEstimate, 11);
  assert.equal(first.query, query);
  assert.equal(first.limit, 10);
  const second = await client.searchPage({ query: first.query, limit: first.limit, pageToken: first.nextPageToken });
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].id, 'mail-11');
  assert.equal(second.hasMore, false);
  assert.equal(second.nextPageToken, null);
  assert.equal(lists.length, 2);
  assert.equal(metadata.length, 11);
  assert.ok(!JSON.stringify([first, second]).includes('SECRET'));
  assert.ok(!JSON.stringify([first, second]).includes('test-access-token'));
});

test('pagination preserves empty-page continuation and treats total estimates as optional estimates', async t => {
  let list = { nextPageToken: 'empty-page-continue', resultSizeEstimate: 0 };
  const f = await fixture(t, { stored: record(), fetchImpl: async input => {
    assert.ok(new URL(input).pathname.endsWith('/messages'), 'Empty pages must not trigger metadata requests');
    return response(list);
  } });
  const client = await f.client();
  const first = await client.searchPage({ query: 'flight', limit: 1 });
  assert.deepEqual(first.messages, []);
  assert.equal(first.hasMore, true, 'Presence of a continuation controls pagination, not the approximate estimate');
  assert.equal(first.nextPageToken, 'empty-page-continue');
  assert.equal(first.resultSizeEstimate, 0);
  list = {};
  const last = await client.searchPage({ query: 'flight', limit: 1, pageToken: first.nextPageToken });
  assert.equal(last.hasMore, false);
  assert.equal(last.resultSizeEstimate, null);
});

test('malformed pagination or oversized message pages fail without truncation, metadata fetches, or upstream details', async t => {
  let list;
  let calls = 0;
  const f = await fixture(t, { stored: record(), fetchImpl: async input => {
    calls++;
    assert.ok(new URL(input).pathname.endsWith('/messages'), 'Invalid list responses must be rejected before any metadata fetch');
    return response(list);
  } });
  const client = await f.client();
  const cases = [
    { messages: [{ id: 'mail-1' }, { id: 'mail-2' }] },
    { messages: 'SECRET_LIST' },
    { messages: [{ id: 'SECRET\nINVALID_ID' }] },
    ...['', null, 42, 'SECRET\nTOKEN', `SECRET${'x'.repeat(4097)}`].map(nextPageToken => ({ nextPageToken })),
    ...[-1, 1.5, 'SECRET_ESTIMATE', Number.MAX_SAFE_INTEGER + 1, null].map(resultSizeEstimate => ({ resultSizeEstimate })),
  ];
  for (const value of cases) {
    list = value;
    await assert.rejects(client.searchPage({ query: 'flight', limit: 1 }), error => error.code === 'GMAIL_RESPONSE' && !error.message.includes('SECRET'));
  }
  assert.equal(calls, cases.length);
});

test('expired access tokens refresh only at Google and preserve the encrypted-record contract', async t => {
  const calls = [];
  const f = await fixture(t, { stored: record({ expiresAt: NOW - 1 }), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.method, 'POST');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'test-refresh-token');
      assert.equal(form.get('scope'), GMAIL_SCOPE);
      assert.equal(form.get('client_id'), CLIENT_ID);
      return response({ access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer', scope: GMAIL_SCOPE });
    }
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-token');
    return response({ messages: [] });
  } });
  const client = await f.client();
  assert.deepEqual(await client.search(), []);
  assert.equal(calls.length, 2);
  assert.equal(f.secretStore.saves, 1);
  assert.equal(f.secretStore.value.refreshToken, 'test-refresh-token');
  assert.equal(f.secretStore.value.accessToken, 'fresh-access-token');
  assert.equal(f.secretStore.value.account, 'owner@example.test');
  assert.equal(f.secretStore.value.expiresAt, NOW + 3_600_000);
});

test('refresh rejects revoked grants and never exposes upstream token diagnostics', async t => {
  const f = await fixture(t, { stored: record({ expiresAt: NOW - 1 }), fetchImpl: async () => response({ error: 'invalid_grant', error_description: 'SECRET_REFRESH_TOKEN diagnostic' }, 400) });
  const client = await f.client();
  await assert.rejects(client.search(), error => error.code === 'GMAIL_AUTH_REQUIRED' && !error.message.includes('SECRET'));
  assert.equal(client.status().connected, false);
  assert.equal(f.secretStore.value, null);
});

test('refresh refuses broader scopes and network failures remain sanitized', async t => {
  const f = await fixture(t, { stored: record({ expiresAt: NOW - 1 }), fetchImpl: async () => response({ access_token: 'fresh', expires_in: 3600, scope: `${GMAIL_SCOPE} https://mail.google.com/` }) });
  let client = await f.client();
  await assert.rejects(client.search(), { code: 'GMAIL_SCOPE' });
  assert.equal(f.secretStore.saves, 0);
  client = await f.client({ fetchImpl: async () => { throw new Error('SECRET_ACCESS_TOKEN in provider diagnostics'); } });
  await assert.rejects(client.search(), error => error.code === 'GMAIL_NETWORK' && !error.message.includes('SECRET'));
});

test('disconnect revokes at the fixed endpoint and removes local credentials even while offline', async t => {
  const calls = [];
  const f = await fixture(t, { stored: record(), fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('', { status: 200 }); } });
  let client = await f.client();
  assert.deepEqual(await client.disconnect(), { connected: false, revoked: true });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(calls[0].options.body).get('token'), 'test-refresh-token');
  assert.equal(calls[0].url.includes('test-refresh-token'), false);
  assert.equal(f.secretStore.value, null);
  assert.equal(client.status().connected, false);
  f.secretStore.value = record();
  client = await f.client({ fetchImpl: async () => { throw new Error('Offline SECRET'); } });
  const disconnected = await client.disconnect();
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.revoked, false);
  assert.match(disconnected.warning, /revocation could not be confirmed/);
  assert.equal(f.secretStore.value, null);
  assert.equal(client.status().connected, false);
});

test('reload discovers a connection created by the PC CLI without restarting Nemo', async t => {
  const f = await fixture(t);
  const client = await f.client();
  assert.equal(client.status().connected, false);
  f.secretStore.value = record();
  assert.equal((await client.reload()).connected, true);
  f.secretStore.value = null;
  assert.equal((await client.reload()).connected, false);
});

test('disconnect removes unreadable local credentials without claiming Google revocation succeeded', async t => {
  const f = await fixture(t);
  f.secretStore.load = async () => { throw new Error('SECRET_DPAPI_DIAGNOSTIC'); };
  const client = await f.client();
  assert.equal(client.status().connected, false);
  const result = await client.disconnect();
  assert.equal(result.revoked, false);
  assert.match(result.warning, /revocation could not be confirmed/);
  assert.equal(result.warning.includes('SECRET'), false);
  assert.equal(f.secretStore.removes, 1);
});

test('only an explicitly selected Desktop OAuth file can be imported', async t => {
  const f = await fixture(t, { configured: false });
  const selected = join(f.root, 'desktop.json');
  await writeFile(selected, JSON.stringify({ web: CONFIG.installed }));
  await assert.rejects(installGmailDesktopClient({ dataDir: f.dataDir, clientPath: selected }), { code: 'GMAIL_CONFIG_INVALID' });
  await writeFile(selected, JSON.stringify(CONFIG));
  assert.deepEqual(await installGmailDesktopClient({ dataDir: f.dataDir, clientPath: selected }), { configured: true });
  const installed = JSON.parse(await readFile(join(f.dataDir, 'google-client.json'), 'utf8'));
  assert.deepEqual(installed, { installed: { client_id: CLIENT_ID, client_secret: 'desktop-client-secret' } });
});

async function rawCallback(url, headers, path) {
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(url, { headers, ...(path ? { path } : {}) }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

test('Desktop OAuth enforces PKCE, callback checks, one-time state and protected token storage', async t => {
  let releaseToken;
  let markStarted;
  const tokenStarted = new Promise(resolveStarted => { markStarted = resolveStarted; });
  const tokenGate = new Promise(resolveToken => { releaseToken = resolveToken; });
  const calls = [];
  let authorization;
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get('grant_type'), 'authorization_code');
      assert.equal(fields.get('client_secret'), 'desktop-client-secret');
      assert.equal(fields.get('code'), 'fake-authorization-code');
      assert.equal(fields.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      const verifier = fields.get('code_verifier');
      assert.ok(verifier.length >= 43 && verifier.length <= 128);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
      markStarted();
      await tokenGate;
      return response({ access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600, token_type: 'Bearer', scope: GMAIL_SCOPE });
    }
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress');
    assert.equal(options.headers.Authorization, 'Bearer oauth-access');
    return response({ emailAddress: 'connected@example.test' });
  } });
  t.after(() => releaseToken());
  const flow = await f.connect();
  authorization = new URL(flow.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('scope'), GMAIL_SCOPE);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('include_granted_scopes'), 'false');
  const callback = new URL(flow.redirectUri);
  assert.equal(callback.hostname, '127.0.0.1');
  assert.ok(Number(callback.port) > 0);
  assert.equal(callback.pathname, '/oauth2/callback');
  const state = authorization.searchParams.get('state');
  assert.ok(state.length >= 43);
  assert.equal((await fetch(new URL('/wrong', callback))).status, 404);
  assert.equal(await rawCallback(callback, {}, '/oauth2/./callback'), 404);
  assert.equal((await fetch(callback, { method: 'POST' })).status, 405);
  assert.equal(await rawCallback(callback, { Host: 'attacker.example' }), 403);
  assert.equal((await fetch(callback, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  callback.searchParams.set('state', '世'.repeat(state.length));
  assert.equal((await fetch(callback)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal(f.secretStore.saves, 0);
  callback.searchParams.set('state', state); callback.searchParams.set('code', 'fake-authorization-code');
  const firstCallback = fetch(callback);
  await tokenStarted;
  assert.equal((await fetch(callback)).status, 409);
  releaseToken();
  assert.equal((await firstCallback).status, 200);
  assert.deepEqual(await flow.completed, { configured: true, connected: true, account: 'connected@example.test' });
  assert.equal(f.secretStore.saves, 1);
  assert.equal(f.secretStore.value.scope, GMAIL_SCOPE);
  assert.equal(f.secretStore.value.refreshToken, 'oauth-refresh');
  assert.equal(JSON.stringify(f.secretStore.value).includes(state), false);
});

for (const [upstream, expected] of [
  ['invalid_client', 'GMAIL_CLIENT_REJECTED'],
  ['unauthorized_client', 'GMAIL_CLIENT_BLOCKED'],
  ['invalid_grant', 'GMAIL_AUTH_CODE_REJECTED'],
  ['invalid_request', 'GMAIL_AUTH_REQUEST'],
  ['redirect_uri_mismatch', 'GMAIL_AUTH_REDIRECT'],
  ['PRIVATE_UPSTREAM_ERROR', 'GMAIL_AUTH_EXCHANGE'],
]) test(`OAuth reports a safe ${upstream} reason without replacing the previous grant`, async t => {
  const previous = record();
  const f = await fixture(t, { stored: previous, fetchImpl: async () => response({ error: upstream, error_description: 'PRIVATE_DESCRIPTION fake-authorization-code SECRET_TOKEN owner@example.test' }, upstream === 'invalid_client' ? 401 : 400) });
  const flow = await f.connect(), url = new URL(flow.redirectUri);
  url.searchParams.set('state', new URL(flow.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', 'fake-authorization-code');
  const callback = await fetch(url), text = await callback.text();
  assert.equal(callback.status, 502);
  await assert.rejects(flow.completed, error => {
    assert.equal(error.code, expected);
    assert.equal(error.message, text);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|SECRET_|owner@example|fake-authorization-code/);
    return true;
  });
  assert.doesNotMatch(text, /PRIVATE_|SECRET_|owner@example|fake-authorization-code/);
  assert.deepEqual(f.secretStore.value, previous); assert.equal(f.secretStore.saves, 0); assert.equal(f.secretStore.removes, 0);
});

for (const [label, body] of [['malformed', 'PRIVATE_NOT_JSON'], ['oversized', 'PRIVATE'.repeat(40000)]]) test(`OAuth bounds ${label} Google errors and provides a safe fallback`, async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response(body, { status: 400 }) });
  const flow = await f.connect(), url = new URL(flow.redirectUri);
  url.searchParams.set('state', new URL(flow.authorizationUrl).searchParams.get('state')); url.searchParams.set('code', 'fake-code');
  const callback = await fetch(url);
  assert.equal(callback.status, 502); assert.doesNotMatch(await callback.text(), /PRIVATE/);
  await assert.rejects(flow.completed, { code: 'GMAIL_AUTH_EXCHANGE' });
  assert.equal(f.secretStore.saves, 0);
});

for (const [status, body, expected] of [
  [401, { error: { message: 'PRIVATE_ACCESS_TOKEN' } }, 'GMAIL_ACCOUNT_REJECTED'],
  [403, { error: { errors: [{ reason: 'accessNotConfigured', message: 'PRIVATE_PROJECT_ID' }] } }, 'GMAIL_API_DISABLED'],
  [403, { error: { details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'PRIVATE_PROJECT_ID' } }] } }, 'GMAIL_API_DISABLED'],
  [403, { error: { errors: [{ reason: 'forbidden', message: 'PRIVATE_ACCOUNT' }] } }, 'GMAIL_ACCOUNT_ACCESS'],
]) test(`OAuth distinguishes account lookup ${expected} from the code exchange`, async t => {
  let calls = 0;
  const previous = record();
  const f = await fixture(t, { stored: previous, fetchImpl: async url => {
    calls++;
    if (url === 'https://oauth2.googleapis.com/token') return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: GMAIL_SCOPE });
    return response(body, status);
  } });
  const flow = await f.connect(), url = new URL(flow.redirectUri);
  url.searchParams.set('state', new URL(flow.authorizationUrl).searchParams.get('state')); url.searchParams.set('code', 'fake-code');
  const callback = await fetch(url), text = await callback.text();
  assert.equal(callback.status, 502); assert.doesNotMatch(text, /PRIVATE|new-access|new-refresh/);
  await assert.rejects(flow.completed, error => error.code === expected && error.message === text);
  assert.equal(calls, 2); assert.deepEqual(f.secretStore.value, previous); assert.equal(f.secretStore.saves, 0);
});

test('a rejected OAuth client during refresh preserves the grant for configuration repair', async t => {
  const previous = record({ expiresAt: NOW - 1 });
  const f = await fixture(t, { stored: previous, fetchImpl: async () => response({ error: 'invalid_client', error_description: 'PRIVATE_CONFIG' }, 401) });
  const client = await f.client();
  await assert.rejects(client.search(), { code: 'GMAIL_CLIENT_REJECTED' });
  assert.deepEqual(f.secretStore.value, previous); assert.equal(f.secretStore.removes, 0);
});

test('OAuth denial and expiration never exchange or store credentials', async t => {
  const f = await fixture(t);
  const denied = await f.connect();
  let url = new URL(denied.redirectUri);
  url.searchParams.set('state', new URL(denied.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(url)).status, 400);
  await assert.rejects(denied.completed, { code: 'GMAIL_AUTH_DENIED' });
  let now = NOW;
  const expired = await f.connect({ now: () => now });
  now += 300_000;
  url = new URL(expired.redirectUri);
  url.searchParams.set('state', new URL(expired.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', 'expired');
  assert.equal((await fetch(url)).status, 410);
  await assert.rejects(expired.completed, { code: 'GMAIL_AUTH_TIMEOUT' });
  assert.equal(f.secretStore.saves, 0);
});

test('OAuth refuses overbroad grants before any credentials are stored', async t => {
  const f = await fixture(t, { fetchImpl: async () => response({ access_token: 'bad-scope-access', refresh_token: 'bad-scope-refresh', expires_in: 3600, scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send` }) });
  const flow = await f.connect();
  const url = new URL(flow.redirectUri);
  url.searchParams.set('state', new URL(flow.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', 'fake-code');
  assert.equal((await fetch(url)).status, 502);
  await assert.rejects(flow.completed, { code: 'GMAIL_SCOPE' });
  assert.equal(f.secretStore.saves, 0);
});
