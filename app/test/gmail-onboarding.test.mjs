import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createGmailClient, GMAIL_SCOPE, installGmailWebClient } from '../lib/gmail.mjs';
import { createNemoServer } from '../lib/personal-gateway.mjs';

const CID = 'fake-web.apps.googleusercontent.com';
const NOW = Date.parse('2026-10-21T09:00:00Z');
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function store(initial = null) { let value = initial; return { get value() { return value; }, set value(next) { value = next; }, async load() { return structuredClone(value); }, async save(next) { value = structuredClone(next); }, async remove() { value = null; } }; }

async function fixture(t) {
  const prefix = fileURLToPath(new URL('./.tmp-gmail-phone-', import.meta.url));
  const dataDir = await mkdtemp(prefix);
  const tokens = store(); const web = store(); const cache = store();
  const calls = [];
  let clock = NOW;
  let blockedProfile;
  let releaseProfile;
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), CID); assert.equal(body.get('client_secret'), 'test-web-secret');
      if (body.get('grant_type') === 'authorization_code') { assert.ok(body.get('code_verifier').length >= 43); assert.equal(body.get('redirect_uri'), `${base}/oauth/gmail/callback`); }
      return response({ access_token: 'test-access', refresh_token: 'test-refresh', scope: GMAIL_SCOPE, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') return response({});
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    if (url.pathname.endsWith('/profile')) { if (blockedProfile) await blockedProfile; return response({ emailAddress: 'synthetic@example.test' }); }
    if (url.pathname.endsWith('/messages')) return response({ messages: [{ id: 'm1' }, { id: 'm2' }], resultSizeEstimate: 2 });
    assert.equal(url.searchParams.get('format'), 'metadata');
    return response({ snippet: '<img src=x onerror=alert(1)> synthetic snippet', payload: { body: { data: 'NEVER_CACHE_BODY' }, headers: [{ name: 'From', value: 'Synthetic <example@example.test>' }, { name: 'Subject', value: 'Synthetic email' }, { name: 'Date', value: '21 Oct 2026' }] } });
  };
  const gmail = await createGmailClient({ dataDir, secretStore: tokens, webClientStore: web, syncStore: cache, now: () => clock, fetchImpl });
  const app = await createNemoServer({ dataDir, gmail, integrations: { gmail }, provider: { status: () => ({ connected: true }), run: async () => ({ text: 'synthetic' }) }, pairingCode: '12345678', now: () => clock, logger: () => {} });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  web.value = { kind: 'web', client_id: CID, client_secret: 'test-web-secret', redirect_uris: [`${base}/oauth/gmail/callback`] };
  let paired = '';
  async function request(path, { body, cookie = paired, method = body ? 'POST' : 'GET', headers = {} } = {}) {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { res, data };
  }
  const pair = await request('/api/pair', { body: { code: '12345678' } }); paired = pair.res.headers.get('set-cookie').split(';')[0];
  t.after(async () => { releaseProfile?.(); await app.close(); const target = resolve(dataDir); assert.equal(dirname(target), dirname(resolve(prefix))); assert.ok(basename(target).startsWith(basename(prefix))); await rm(target, { recursive: true, force: true }); });
  const start = async (mode = 'demand') => {
    const result = await request('/api/gmail/oauth/start', { body: { mode } });
    assert.equal(result.res.status, 200);
    const url = new URL(result.data.authorizationUrl);
    return { result, url, flowCookie: result.res.headers.get('set-cookie').split(';')[0], path: `/oauth/gmail/callback?code=synthetic-code&state=${url.searchParams.get('state')}` };
  };
  return { dataDir, gmail, tokens, web, cache, calls, request, start, get paired() { return paired; }, advance(ms) { clock += ms; }, blockProfile() { blockedProfile = new Promise(resolve => { releaseProfile = resolve; }); }, releaseProfile() { releaseProfile?.(); } };
}

test('phone OAuth uses Google, exact read-only scope and PKCE without exposing web secret', async t => {
  const f = await fixture(t);
  const flow = await f.start();
  assert.equal(flow.url.origin, 'https://accounts.google.com');
  assert.equal(flow.url.searchParams.get('scope'), GMAIL_SCOPE);
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('access_type'), 'offline');
  assert.equal(flow.url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(JSON.stringify(flow.result.data).includes('test-web-secret'), false);
  assert.match(flow.result.res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  // Deliberately omit the Strict pairing cookie on the cross-site callback.
  const completed = await f.request(flow.path, { cookie: flow.flowCookie });
  assert.equal(completed.res.status, 303);
  assert.equal(completed.res.headers.get('location'), '/gmail-connect.html?gmail=connected');
  assert.equal(completed.res.headers.get('location').includes('synthetic-code'), false);
  assert.equal(f.tokens.value.clientType, 'web');
  assert.equal(f.tokens.value.account, 'synthetic@example.test');
  const status = await f.request('/api/gmail/connection');
  assert.equal(status.data.gmail.connected, true);
  assert.equal(status.data.sync.mode, 'demand');
  assert.equal(status.data.sync.count, 0);
  assert.equal(JSON.stringify(status.data).includes('test-access'), false);
  const replay = await f.request(flow.path, { cookie: flow.flowCookie });
  assert.equal(replay.res.status, 403);
});

test('foreign callback cookie, state, origin and duplicate state cannot switch accounts', async t => {
  const f = await fixture(t); const flow = await f.start();
  for (const cookie of ['', 'nemo_gmail_flow=' + 'f'.repeat(64), f.paired]) {
    const result = await f.request(flow.path, { cookie }); assert.equal(result.res.status, 403);
  }
  const duplicate = await f.request(flow.path + '&state=another', { cookie: flow.flowCookie }); assert.equal(duplicate.res.status, 403);
  const foreignOrigin = await f.request(flow.path, { cookie: flow.flowCookie, headers: { 'X-Forwarded-Host': 'foreign.tail123.ts.net' } }); assert.equal(foreignOrigin.res.status, 403);
  const wrongState = await f.request(flow.path.replace(flow.url.searchParams.get('state'), 'x'.repeat(43)), { cookie: flow.flowCookie }); assert.equal(wrongState.res.status, 403);
  assert.equal(f.tokens.value, null); assert.equal(f.calls.length, 0);
  const valid = await f.request(flow.path, { cookie: flow.flowCookie }); assert.equal(valid.res.status, 303);
});

test('denial and expired or unpaired browser never authorize Gmail', async t => {
  const f = await fixture(t);
  let flow = await f.start();
  const denied = await f.request(flow.path.replace('code=synthetic-code', 'error=access_denied'), { cookie: flow.flowCookie });
  assert.match(denied.res.headers.get('location'), /gmail=denied$/); assert.equal(f.tokens.value, null);
  flow = await f.start(); f.advance(300_001);
  const expired = await f.request(flow.path, { cookie: flow.flowCookie }); assert.match(expired.res.headers.get('location'), /gmail=expired$/);
  flow = await f.start(); await f.request('/api/logout', { body: {} });
  const unpaired = await f.request(flow.path, { cookie: flow.flowCookie }); assert.equal(unpaired.res.status, 403); assert.equal(f.tokens.value, null);
});

test('unpair during Google exchange preserves the previous local grant', async t => {
  const f = await fixture(t); const flow = await f.start();
  f.blockProfile();
  const callback = f.request(flow.path, { cookie: flow.flowCookie });
  while (!f.calls.some(item => item.url.pathname.endsWith('/profile'))) await new Promise(resolve => setTimeout(resolve, 5));
  await f.request('/api/logout', { body: {} }); f.releaseProfile();
  const completed = await callback; assert.match(completed.res.headers.get('location'), /gmail=failed$/); assert.equal(f.tokens.value, null);
});

test('a newer sign-in cancels an older in-flight authorization before it can save tokens', async t => {
  const f = await fixture(t); const flow = await f.start();
  f.blockProfile();
  const callback = f.request(flow.path, { cookie: flow.flowCookie });
  while (!f.calls.some(item => item.url.pathname.endsWith('/profile'))) await new Promise(resolve => setTimeout(resolve, 5));
  await f.start(); f.releaseProfile();
  const completed = await callback; assert.match(completed.res.headers.get('location'), /gmail=failed$/); assert.equal(f.tokens.value, null);
});

test('Web grants refresh with the matching Web client and expired cache stops being reused', async t => {
  const f = await fixture(t); const flow = await f.start(); await f.request(flow.path, { cookie: flow.flowCookie });
  await f.gmail.setSyncMode('sync'); await f.gmail.syncNow();
  f.advance(3_601_000);
  const count = f.calls.filter(item => /messages\//.test(item.url.pathname)).length;
  await f.gmail.searchPage({query:'subject:synthetic',limit:2});
  assert.equal(f.calls.filter(item => /messages\//.test(item.url.pathname)).length, count+2);
  assert.ok(f.calls.some(item => item.url.href === 'https://oauth2.googleapis.com/token' && new URLSearchParams(item.options.body).get('grant_type') === 'refresh_token'));
  assert.equal(f.tokens.value.clientType,'web');
});

test('registering a Web client preserves an existing Desktop grant and its connection', async t => {
  const f = await fixture(t);
  const desktopId='fake-desktop.apps.googleusercontent.com';
  await writeFile(join(f.dataDir,'google-client.json'),JSON.stringify({installed:{client_id:desktopId,client_secret:'desktop-secret'}}));
  // The protected Web client exists separately; a Desktop token continues to
  // use the Desktop config until an explicit Google authorization succeeds.
  const original = { version:1,clientId:desktopId,scope:GMAIL_SCOPE,accessToken:'test-access',refreshToken:'test-refresh',expiresAt:NOW+3_600_000,account:'synthetic@example.test' };
  f.tokens.value=original; await f.gmail.reload();
  const next = await f.start();
  await f.request(next.path.replace('code=synthetic-code','error=access_denied'),{cookie:next.flowCookie});
  assert.deepEqual(f.tokens.value,original);
  assert.equal((await f.gmail.reload()).connected,true);
});

test('explicit sync uses bounded metadata, live Gmail matching, visible cache and stop-and-clear', async t => {
  const f = await fixture(t); const flow = await f.start();
  await f.request(flow.path, { cookie: flow.flowCookie });
  const before = f.calls.length;
  await f.gmail.syncIfDue(); assert.equal(f.calls.length, before, 'demand mode must not download messages');
  await f.gmail.setSyncMode('sync'); await f.gmail.syncNow();
  assert.equal(f.cache.value.messages.length, 2);
  assert.equal(JSON.stringify(f.cache.value).includes('NEVER_CACHE_BODY'), false);
  const full = await f.request('/api/gmail/cache'); assert.equal(full.data.messages.length, 2);
  const list = f.calls.find(item => item.url.pathname.endsWith('/messages'));
  assert.equal(list.url.searchParams.get('maxResults'), '50');
  assert.equal(list.url.searchParams.get('q'), 'newer_than:7d -in:trash -in:spam');
  const metadataBefore = f.calls.filter(item => /messages\//.test(item.url.pathname)).length;
  const page = await f.gmail.searchPage({ query: 'from:example@example.test', limit: 2 });
  assert.equal(page.messages.length, 2);
  assert.equal(f.calls.filter(item => /messages\//.test(item.url.pathname)).length, metadataBefore, 'fresh cache should avoid repeated metadata downloads');
  const cleared = await f.request('/api/gmail/cache/clear', { body: {} }); assert.equal(cleared.res.status, 200);
  assert.equal(f.cache.value, null);
  const after = f.calls.length; await f.gmail.syncIfDue(); assert.equal(f.calls.length, after);
  const empty = await f.request('/api/gmail/cache'); assert.deepEqual(empty.data.messages, []);
  assert.equal(empty.data.mode, 'demand');
});

test('Gmail endpoints need pairing, custom JSON headers and valid mode; no implicit AI consent', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/gmail/connection', { cookie: '' })).res.status, 401);
  assert.equal((await f.request('/api/gmail/oauth/start', { body: { mode: 'everything' } })).res.status, 400);
  assert.equal((await f.request('/api/gmail/oauth/start', { body: { mode: 'sync', returnTo: 'https://evil.test' } })).res.status, 400);
  const flow = await f.start(); await f.request(flow.path, { cookie: flow.flowCookie });
  const integrations = await f.request('/api/integrations'); assert.equal(integrations.data.contextConsent, false);
});

test('Web client importer rejects Desktop clients, off-site callbacks and secret endpoint overrides', async t => {
  const prefix = fileURLToPath(new URL('./.tmp-gmail-import-', import.meta.url)); const root = await mkdtemp(prefix);
  t.after(async () => { assert.equal(dirname(resolve(root)), dirname(resolve(prefix))); assert.ok(basename(root).startsWith(basename(prefix))); await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'client.json'); const target = store();
  for (const content of [{ installed: { client_id: CID } }, { web: { client_id: CID, client_secret: 'secret', redirect_uris: ['https://evil.test/oauth/gmail/callback'] } }, { web: { client_id: CID, client_secret: 'secret', redirect_uris: ['https://pc.tail123.ts.net/other'] } }]) {
    await writeFile(path, JSON.stringify(content)); await assert.rejects(installGmailWebClient({ dataDir: root, clientPath: path, store: target }), { code: 'GMAIL_WEB_CONFIG' });
  }
  await writeFile(path, JSON.stringify({ web: { client_id: CID, client_secret: 'secret', redirect_uris: ['https://pc.tail123.ts.net/oauth/gmail/callback'], token_uri: 'https://evil.test/token' } }));
  await installGmailWebClient({ dataDir: root, clientPath: path, store: target }); assert.equal(target.value.client_secret, 'secret'); assert.equal(target.value.token_uri, undefined);
});
