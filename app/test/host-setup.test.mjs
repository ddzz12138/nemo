import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createHostSetupServer } from '../lib/host-setup-server.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-setup-test-'));
  const assetsDir = join(dataDir, 'assets'); await mkdir(assetsDir);
  await Promise.all(Object.entries({
    'desktop.html': '<!doctype html><title>Nemo</title><script src="/desktop-ui.js" defer></script><div id="nemo-desktop"></div>',
    'desktop-ui.js': '/* compiled Nemo interface */',
    'desktop-ui.css': 'body{margin:0}',
    'identity.js': '/* profile identity guard */',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  }).map(([file, contents]) => writeFile(join(assetsDir, file), contents)));
  const profiles = await createProfileStore({ dataDir });
  const remote = { phase: 'ready', publicOrigin: 'https://host-test.nemo.example', connected: true, canPair: true, account: { state: 'approved' } };
  const calls = [];
  const remoteHost = { status: () => ({ ...remote }), async beginEnrollment() { calls.push('enroll'); return { state: 'pending', browserUrl: 'https://accounts.nemo.example/connect', confirmationCode: '123456' }; }, async pollEnrollment() { return { state: 'approved' }; }, async enable() { calls.push('enable'); return { ...remote }; }, async disable() { calls.push('disable'); remote.canPair = false; return { ...remote }; } };
  const server = await createHostSetupServer({ dataDir, profiles, remoteHost, assetsDir, runtimeStatus: async () => ({ ready: true }), appStatus: async () => ({ ready: true }), qrDataUrl: async url => `data:image/png;base64,${Buffer.from(url).toString('base64')}`, ...options });
  const capability = new URLSearchParams(new URL(server.bootstrapUrl).hash.slice(1)).get('setup');
  t.after(async () => { await server.close(); if (!dataDir.startsWith(join(tmpdir(), 'nemo-setup-test-'))) throw new Error('Unsafe test cleanup'); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, authorized = true, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${server.origin}${path}`, { method, headers: { ...(authorized ? { authorization: `Bearer ${capability}` } : {}), ...(method === 'POST' ? { origin: server.origin, 'content-type': 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json, headers: res.headers }); });
      }); req.on('error', reject); req.end(body === undefined ? method === 'POST' ? '{}' : undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  return { dataDir, profiles, remote, calls, server, request, capability };
}

test('private setup uses a random ephemeral loopback capability and protects all admin APIs', async t => {
  const f = await fixture(t);
  assert.match(f.server.origin, /^http:\/\/127\.0\.0\.1:\d+$/); assert.ok(f.capability.length >= 43);
  const page = await f.request('/setup/', { authorized: false }); assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['referrer-policy'], 'no-referrer'); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await f.request('/api/setup/status', { authorized: false })).status, 403);
  assert.equal((await f.request('/api/setup/status', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await f.request('/api/setup/status', { headers: { authorization: `Bearer ${'é'.repeat(43)}` } })).status, 403);
  assert.equal((await f.request(`/api/setup/status?setup=${f.capability}`, { authorized: false })).status, 403);
  const status = await f.request('/api/setup/status'); assert.equal(status.status, 200); assert.equal(status.json.owner.configured, false);
});

test('finished setup survives provider disconnection and reopening the setup server', async t => {
  let connected = true;
  const f = await fixture(t, { runtimeStatus: async () => ({ ready: true, connected }), appStatus: async () => ({ ready: true, assistantConnected: connected }), localInvite: async () => ({ synthetic: true }) });
  assert.equal((await f.request('/api/setup/status')).json.setupCompleted, false);
  await f.request('/api/setup/owner', { method: 'POST', body: { name: 'Asha' } });
  assert.equal((await f.request('/api/setup/status')).json.setupCompleted, false, 'Naming the owner alone does not finish setup.');
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 200);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'host-setup.json'), 'utf8')).completed, true);
  connected = false;
  assert.equal((await f.request('/api/setup/status')).json.setupCompleted, true);
  await f.request('/api/setup/owner', { method: 'POST', body: { name: 'Renamed owner' } });
  assert.equal((await f.request('/api/setup/status')).json.setupCompleted, true, 'Renaming does not erase completion.');
  const reopened = await createHostSetupServer({ dataDir: f.dataDir, profiles: f.profiles, remoteHost: { status: () => ({}) } });
  t.after(() => reopened.close());
  const token = new URLSearchParams(new URL(reopened.bootstrapUrl).hash.slice(1)).get('setup');
  const response = await fetch(reopened.origin + '/api/setup/status', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal((await response.json()).setupCompleted, true);
});

test('older paired installations are recognized without connecting accounts or changing their saved devices', async t => {
  const f = await fixture(t, { runtimeStatus: async () => ({ ready: true, connected: false }), appStatus: async () => ({ ready: true, assistantConnected: false }) });
  const owner = await f.profiles.owner(), invite = await f.profiles.invite(owner.id);
  await f.profiles.redeem(invite.code);
  const before = await readFile(join(f.dataDir, 'profiles.json'), 'utf8');
  assert.equal((await f.request('/api/setup/status')).json.setupCompleted, true);
  assert.equal(await readFile(join(f.dataDir, 'profiles.json'), 'utf8'), before);
});

test('a finished installation can confirm its desktop profile to read saved chat while ChatGPT is disconnected', async t => {
  let confirmation = false, invites = 0;
  const f = await fixture(t, { runtimeStatus: async () => ({ ready: true, connected: false, assistant: { connected: confirmation, confirmationRequired: confirmation } }), appStatus: async () => ({ ready: true, assistantConnected: false }), localInvite: async () => { invites++; return { synthetic: true }; } });
  const owner = await f.profiles.owner(), invite = await f.profiles.invite(owner.id);
  await f.profiles.redeem(invite.code);
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 200);
  assert.equal(invites, 1);
  confirmation = true;
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 409, 'A newly connected plan still requires acknowledgement.');
  assert.equal(invites, 1);
});

test('first launch serves the actual shared interface without putting its setup capability in assets', async t => {
  const f = await fixture(t, { assetsDir: resolve('public') });
  for (const path of ['/setup/', '/setup', '/', '/host-setup.html', '/desktop.html']) {
    const page = await f.request(path, { authorized: false });
    assert.equal(page.status, 200, path);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.text, /id="nemo-desktop"/);
    assert.match(page.text, /src="\/desktop-ui\.js"/);
    assert.doesNotMatch(page.text, /host-setup\.(?:js|css)|id="nameStep"/);
    assert.equal(page.text.includes(f.capability), false);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['cache-control'], 'no-store');
  }
  for (const [path, type] of [
    ['/desktop-ui.js', /^text\/javascript/],
    ['/desktop-ui.css', /^text\/css/],
    ['/identity.js', /^text\/javascript/],
    ['/icon.svg', /^image\/svg\+xml/],
  ]) {
    const asset = await f.request(path, { authorized: false });
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers['content-type'], type);
    assert.ok(asset.text.length > 0, path);
    assert.equal(asset.text.includes(f.capability), false, path);
    const head = await f.request(path, { method: 'HEAD', authorized: false });
    assert.equal(head.status, 200, path);
    assert.equal(head.text, '');
  }
  for (const path of ['/host-setup.js', '/host-setup.css', '/profiles.json', '/host-setup.json', '/api/session', '/api/conversation']) {
    assert.equal((await f.request(path, { authorized: false })).status, 404, path);
  }
  assert.equal((await f.request('/api/setup/status', { authorized: false })).status, 403);
  assert.equal((await f.request('/api/setup/runtime', { method: 'POST', authorized: false })).status, 403);
  assert.equal((await f.request('/desktop-ui.js', { authorized: false, headers: { origin: 'https://attacker.example' } })).status, 403);
});

test('spoofed Host, public proxies, external origins and cross-site requests cannot administer a local connector', async t => {
  const f = await fixture(t);
  for (const headers of [{ host: 'host-test.nemo.example' }, { host: `localhost:${new URL(f.server.origin).port}` }, { origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.request('/api/setup/status', { headers })).status, 403);
  }
  assert.equal((await f.request('/api/setup/remote/enable', { method: 'POST', authorized: false, headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'host-test.nemo.example' } })).status, 403);
  assert.equal((await f.request('/api/setup/remote/enable', { method: 'POST', headers: { origin: '' } })).status, 403);
  assert.equal((await f.request('/api/setup/remote/enable', { method: 'POST', headers: { origin: 'null' } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('owner name is saved once through the local wizard and an actual expiring invitation becomes a fragment QR', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: { name: 'Sam' } })).status, 200);
  const state = await f.request('/api/setup/status'); assert.equal(state.json.owner.name, 'Sam'); assert.equal(state.json.owner.configured, true);
  const invitation = await f.request('/api/setup/invite', { method: 'POST', body: { profileId: state.json.owner.id } });
  assert.equal(invitation.status, 200); assert.equal(invitation.json.profile.name, 'Sam');
  const url = new URL(invitation.json.url); assert.equal(url.origin, f.remote.publicOrigin); assert.equal(url.search, ''); assert.match(url.hash, /^#invite=/); assert.match(invitation.json.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(invitation.json.expiresAt <= Date.now() + 10 * 60_000);
  const code = new URLSearchParams(url.hash.slice(1)).get('invite'); assert.ok(code);
  assert.equal((await readFile(join(f.dataDir, 'profiles.json'), 'utf8')).includes(code), false);
  assert.equal((await f.profiles.redeem(code)).profile.id, state.json.owner.id);
  await assert.rejects(f.profiles.redeem(code), /already used/);
});

test('a phone invitation stays unavailable until assistant and application are ready', async t => {
  const f = await fixture(t, { runtimeStatus: async () => ({ ready: false, state: 'missing' }) });
  assert.equal((await f.request('/api/setup/status')).json.remote.canPair, false);
  const response = await f.request('/api/setup/invite', { method: 'POST' }); assert.equal(response.status, 409); assert.equal(response.json.code, 'PHONE_NOT_READY');
  const disconnected = await fixture(t, { runtimeStatus: async () => ({ ready: true, connected: false }) });
  assert.equal((await disconnected.request('/api/setup/status')).json.remote.canPair, false);
  assert.equal((await disconnected.request('/api/setup/invite', { method: 'POST' })).status, 409);
});

test('local wizard actions delegate without exposing process or provider errors', async t => {
  let runtimeCalls = 0, assistantKey;
  const f = await fixture(t, { runtimeSetup: async () => { runtimeCalls++; return { ready: true }; }, assistantSetup: async input => { assistantKey = input.apiKey; throw new Error(`raw provider error ${input.apiKey}`); } });
  assert.equal((await f.request('/api/setup/enroll/start', { method: 'POST' })).json.confirmationCode, '123456');
  assert.equal((await f.request('/api/setup/enroll/poll', { method: 'POST' })).json.state, 'approved');
  assert.equal((await f.request('/api/setup/runtime/install', { method: 'POST' })).status, 200); assert.equal(runtimeCalls, 1);
  const response = await f.request('/api/setup/assistant', { method: 'POST', body: { apiKey: 'sensitive-model-key' } });
  assert.equal(assistantKey, 'sensitive-model-key'); assert.equal(response.status, 503); assert.equal(response.text.includes(assistantKey), false);
  assert.equal((await f.request('/api/setup/remote/enable', { method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/setup/remote/disable', { method: 'POST' })).status, 200);
  assert.deepEqual(f.calls, ['enroll', 'enable', 'disable']);
});

test('private setup rejects unsupported content types, oversized and malformed bodies', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: '[]' })).status, 400);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: { name: 'a'.repeat(17_000) } })).status, 413);
  assert.equal((await f.request('/api/setup/owner', { method: 'POST', body: { name: '' } })).status, 400);
});

test('closing private setup stops accepting new actions before waiting for an existing action', async t => {
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { runtimeSetup: async () => { started(); await new Promise(resolve => { release = resolve; }); return { ready: true }; } });
  const installing = f.request('/api/setup/runtime/install', { method: 'POST' }); await running;
  const closing = f.server.close();
  await assert.rejects(f.request('/api/setup/owner', { method: 'POST', body: { name: 'Should not save' } }));
  release(); assert.equal((await installing).status, 200); await closing;
  assert.equal((await f.profiles.owner()).name, 'Owner');
});
