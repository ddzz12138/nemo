import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createHostSetupServer } from '../lib/host-setup-server.mjs';
import { setupState } from '../public/desktop-setup.mjs';

function rawPost(url, headers, body = '{}') {
  return new Promise((resolveResult, reject) => {
    const request = httpRequest(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolveResult({ status: response.statusCode, json: () => JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('local chat works without cloud configuration but its owner invitation cannot be minted through public ingress', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-parent-review-'));
  const app = await createFamilyServer({ dataDir, publicDir: resolve('public'), publicOrigin: 'https://host-family.example', trustedProxy: 'cloudflare', logger() {}, provider: { status: () => ({ connected: true }), async run() { return { text: 'Private synthetic reply.' }; } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const appOrigin = `http://127.0.0.1:${app.server.address().port}`;
  const owner = await app.profiles.owner(), other = await app.profiles.create('Other adult', false);
  const remoteHost = { status: () => ({ available: false, phase: 'not-configured', canPair: false, account: { state: 'signed-out' }, message: 'Phone access is not available in this release yet.' }) };
  const setup = await createHostSetupServer({ dataDir, profiles: app.profiles, remoteHost,
    runtimeStatus: async () => ({ ready: true, connected: true }), appStatus: async () => ({ ready: true, assistantConnected: true, origin: appOrigin }),
    localInvite: async profileId => { const result = await app.profiles.invite(profileId, 'desktop-local', { ttlMs: 300000 }); return { profile: result.profile, expiresAt: result.expiresAt, url: `${appOrigin}/pair.html#invite=${result.code}` }; },
  });
  t.after(async () => { await setup.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const token = new URLSearchParams(new URL(setup.bootstrapUrl).hash.slice(1)).get('setup');
  const headers = { Authorization: `Bearer ${token}`, Origin: setup.origin, 'Content-Type': 'application/json' };
  const request = (extra = {}, input = {}) => fetch(`${setup.origin}/api/setup/local-invite`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  assert.equal((await request({ Authorization: '' })).status, 403);
  assert.equal((await request({ Origin: 'https://host-family.example' })).status, 403);
  assert.equal((await rawPost(`${setup.origin}/api/setup/local-invite`, { ...headers, Host: 'host-family.example' })).status, 403);
  const local = await request({}, { profileId: other.id });
  assert.equal(local.status, 200);
  const invitation = await local.json();
  assert.equal(invitation.profile.id, owner.id, 'the caller never chooses whose private space is opened');
  const url = new URL(invitation.url), code = new URLSearchParams(url.hash.slice(1)).get('invite');
  assert.equal(url.origin, appOrigin); assert.equal(url.pathname, '/pair.html'); assert.equal(url.search, '');
  assert.equal((await app.profiles.previewInvite(code)).profile.id, owner.id);
  const remoteAdmin = await rawPost(`${appOrigin}/api/setup/local-invite`, { Authorization: `Bearer ${token}`, Host: 'host-family.example', Origin: 'https://host-family.example', 'CF-Connecting-IP': '203.0.113.10', 'X-Nemo-Request': '1', 'Content-Type': 'application/json' });
  assert.equal(remoteAdmin.status, 401, 'a setup capability has no authority on the published chat listener');
  await assert.rejects(app.profiles.redeem(code, 'Wrong profile attempt', other.id), error => error.code === 'PAIR_CHANGED');
  const paired = await app.profiles.redeem(code, 'Personal computer browser', owner.id);
  assert.equal(paired.profile.id, owner.id);
  await assert.rejects(app.profiles.redeem(code, 'Replay browser', owner.id), error => error.code === 'PAIR_INVALID');
  assert.equal((await app.profiles.devices(other.id)).length, 0);
});

test('a saved ChatGPT account cannot finish unified setup until its failed app restart recovers', () => {
  const message = 'Your account is saved. Reopen Nemo to finish connecting your assistant.';
  const status = { owner: { id: 'owner', name: 'Parent', configured: true }, runtime: { ready: true, connected: true, assistant: { provider: 'chatgpt', planUsageEnabled: true, connected: true, phase: 'error', message, confirmationRequired: true, planUsageAcknowledged: false, account: { id: 'saved-account', label: 'Saved ChatGPT account' } } }, app: { ready: false, assistantConnected: true }, remote: { available: false, phase: 'not-configured', canPair: false, account: { state: 'signed-out' } } };
  assert.equal(setupState(status), 'assistant', 'retained credentials are not proof of a working assistant');
  status.runtime.assistant.phase = 'connected';
  assert.equal(setupState(status), 'assistant', 'the application must also have restarted successfully');
  status.app.ready = true;
  assert.equal(setupState(status), 'ready');
  status.runtime.assistant.planUsageEnabled = false;
  assert.equal(setupState(status), 'assistant', 'ChatGPT plan readiness remains required');
});
