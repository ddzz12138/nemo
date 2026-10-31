import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDesktopHost, verifyRemoteInstallation } from '../lib/desktop-host.mjs';
import { saveConfig, loadConfig } from '../lib/config.mjs';

const publicOrigin = 'https://host-integration.nemo.example';
const planAccessToken = 'fake-chatgpt-access-token-kept-out-of-setup';
const connectorToken = 'fake-dedicated-connector-credential';
async function fixture(t, { assistantConnected = false, failActivation = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-desktop-test-'));
  const originalSettings = { publicOrigin: 'https://previous.tail-test.ts.net', port: 8787, hermesLauncher: join(dataDir, 'hermes.cmd'), hermesHome: join(dataDir, 'hermes-home'), hermesPython: join(dataDir, 'python.exe'), hermesSource: join(dataDir, 'hermes-source') };
  await saveConfig(dataDir, originalSettings);
  const opened = [], apps = [], tunnelId = randomUUID(); let enrollmentInstallation, activationRejected = false;
  const secretStore = { record: null, async load() { return this.record ? structuredClone(this.record) : null; }, async save(record) { this.record = structuredClone(record); } };
  const connector = { running: false, stops: 0, failStop: false, async available() { return true; }, async start(token) { assert.equal(token, connectorToken); this.running = true; }, async stop() { this.stops++; if (this.failStop) throw new Error('synthetic connector stop failed'); this.running = false; } };
  const cloud = {
    async beginEnrollment({ installationId }) { enrollmentInstallation = installationId; return { enrollmentId: randomUUID(), browserUrl: 'https://accounts.nemo.example/connect?code=synthetic', confirmationCode: '123456', expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async pollEnrollment() { return { status: 'approved', installationId: enrollmentInstallation }; },
    async enable({ installationId }) { return { installationId, publicOrigin, tunnelId, status: 'active', connectorToken }; },
    async retire({ installationId }) { return { installationId, status: 'retired' }; },
  };
  const runtime = { ready: true, bundle: {}, async status() { return { ready: this.ready, installed: this.ready, state: this.ready ? 'ready' : 'not-installed' }; }, async install() { this.ready = true; return this.status(); } };
  let assistant;
  const host = await startDesktopHost({
    dataDir, cloud, connector, secretStore, runtime, openExternal: async url => { opened.push(url); },
    assistantFactory: async ({ onConnected, onConnectionChanging }) => {
      assistant = { connected: assistantConnected, closed: false, actions: [], pause: onConnectionChanging, resume: onConnected, status() { return { provider: 'chatgpt', planUsageEnabled: this.connected, connected: this.connected, phase: this.connected ? 'connected' : 'disconnected' }; }, async credentials() { return this.connected ? { provider: 'chatgpt', accessToken: planAccessToken, model: 'synthetic-model', clientId: 'synthetic-nemo-client' } : null; }, async begin(input = {}) { this.actions.push(input); if(input.action === 'signout') { this.connected = false; await onConnectionChanging(); } else this.connected = true; await onConnected(); return this.status(); }, async retryConnection() { await onConnected(); return this.status(); }, async close() { this.closed = true; } };
      return assistant;
    },
    createApp: async options => {
      if (failActivation && options.publicOrigin === publicOrigin && !activationRejected) { activationRejected = true; throw new Error('synthetic activation failure'); }
      const server = new EventEmitter(); const app = { options, server, closed: false, async close() { this.closed = true; server.listening = false; } };
      server.listen = (port, address, callback) => { assert.equal(port, 8787); assert.equal(address, '127.0.0.1'); server.listening = true; queueMicrotask(callback); return server; };
      apps.push(app); return app;
    },
    verifyPublic: async ({ publicOrigin: expected, installationId, challenge }) => {
      assert.match(challenge, /^[a-f0-9]{48}$/);
      const app = apps.at(-1); return !app.closed && app.options.publicOrigin === expected && app.options.installationId === installationId && app.options.trustedProxy === 'cloudflare';
    },
  });
  const capability = new URLSearchParams(new URL(host.bootstrapUrl).hash.slice(1)).get('setup');
  async function request(path, { method = 'GET', body, authorized = true } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${host.origin}${path}`, { method, headers: { ...(authorized ? { authorization: `Bearer ${capability}` } : {}), ...(method === 'POST' ? { origin: host.origin, 'content-type': 'application/json' } : {}) } }, res => { const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: JSON.parse(text) }); }); });
      req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body || {}) : undefined);
    });
  }
  t.after(async () => { connector.failStop = false; await host.close().catch(() => {}); if (!dataDir.startsWith(join(tmpdir(), 'nemo-desktop-test-'))) throw new Error('Unsafe test cleanup'); await rm(dataDir, { recursive: true, force: true }); });
  const approve = async () => { assert.equal((await request('/api/setup/enroll/start', { method: 'POST' })).status, 200); assert.equal((await request('/api/setup/enroll/poll', { method: 'POST' })).status, 200); };
  return { dataDir, originalSettings, opened, apps, secretStore, connector, cloud, runtime, host, assistant, request, approve, capability };
}

test('desktop parent flow opens approved sign-in and creates a QR only after assistant and exact public app are ready', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/setup/status', { authorized: false })).status, 403);
  await f.request('/api/setup/owner', { method: 'POST', body: { name: 'Robin' } }); await f.approve();
  assert.deepEqual(f.opened, ['https://accounts.nemo.example/connect?code=synthetic']);
  assert.equal(f.opened.some(url => url.includes(f.capability) || url.includes(f.secretStore.record.installationSecret)), false);
  const enabled = await f.request('/api/setup/remote/enable', { method: 'POST' }); assert.equal(enabled.status, 200); assert.equal(enabled.json.connected, true);
  let status = await f.request('/api/setup/status'); assert.equal(status.json.remote.canPair, false); assert.equal(status.json.runtime.connected, false);
  assert.equal((await f.request('/api/setup/invite', { method: 'POST' })).status, 409);
  assert.equal((await f.request('/api/setup/assistant', { method: 'POST' })).status, 200);
  status = await f.request('/api/setup/status'); assert.equal(status.json.remote.canPair, true); assert.equal(status.json.owner.name, 'Robin');
  assert.equal(status.text.includes(planAccessToken), false); assert.equal(status.text.includes(connectorToken), false); assert.equal(status.text.includes(f.capability), false);
  const trusted = f.apps.at(-1).options; assert.equal(trusted.hermesOptions.providerKey, undefined); assert.equal(trusted.hermesOptions.requireChatGPT, true); assert.equal((await trusted.hermesOptions.chatgptSession()).accessToken, planAccessToken); assert.equal(trusted.nativeFactory, null); assert.equal(trusted.publicOrigin, publicOrigin); assert.equal(trusted.trustedProxy, 'cloudflare'); assert.equal(trusted.installationId, f.host.remote.status().installationId);
  const invite = await f.request('/api/setup/invite', { method: 'POST' }); assert.equal(invite.status, 200); assert.match(invite.json.qrDataUrl, /^data:image\/png;base64,/); assert.equal(new URL(invite.json.url).origin, publicOrigin);
  const config = await loadConfig({ dataDir: f.dataDir });
  for (const key of ['port', 'hermesLauncher', 'hermesHome', 'hermesPython', 'hermesSource']) assert.equal(config[key], f.originalSettings[key]);
  assert.equal(config.publicOrigin, publicOrigin); assert.ok(f.apps.slice(0, -1).every(app => app.closed));
});

test('desktop close stops connector, assistant, app, controller and private process marker', async t => {
  const f = await fixture(t, { assistantConnected: true }); await f.approve(); await f.request('/api/setup/remote/enable', { method: 'POST' });
  const marker = JSON.parse(await readFile(join(f.dataDir, 'cli-process.json'), 'utf8')); assert.match(marker.nonce, /^[a-f0-9]{64}$/);
  await f.host.close(); assert.equal(f.connector.running, false); assert.equal(f.assistant.closed, true); assert.ok(f.apps.every(app => app.closed));
  await assert.rejects(readFile(join(f.dataDir, 'cli-process.json')), { code: 'ENOENT' });
  await assert.rejects(f.request('/api/setup/status'));
});

test('a parent can open local chat before phone setup while the invitation stays owner-bound and off the QR path', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 409);
  await f.request('/api/setup/assistant', { method: 'POST' });
  const other = await f.host.profiles.create('Someone else', false);
  const before = Date.now();
  const result = await f.request('/api/setup/local-invite', { method: 'POST', body: { profileId: other.id, publicOrigin: 'https://untrusted.example' } });
  assert.equal(result.status, 200);
  const owner = await f.host.profiles.owner();
  assert.equal(result.json.profile.id, owner.id);
  const link = new URL(result.json.url);
  assert.equal(link.origin, 'http://127.0.0.1:8787'); assert.equal(link.pathname, '/pair.html');
  assert.equal(link.search, ''); assert.equal(Object.hasOwn(result.json, 'qrDataUrl'), false);
  assert.ok(result.json.expiresAt > before && result.json.expiresAt <= Date.now() + 5 * 60_000);
  assert.equal((await f.request('/api/setup/status')).json.remote.canPair, false);
  const code = new URLSearchParams(link.hash.slice(1)).get('invite');
  assert.equal((await f.host.profiles.previewInvite(code)).profile.id, owner.id);
});

test('failed public activation restores prior config and never offers a misleading QR', async t => {
  const f = await fixture(t, { assistantConnected: true, failActivation: true }); await f.approve();
  await f.request('/api/setup/remote/enable', { method: 'POST' });
  const status = await f.request('/api/setup/status'); assert.equal(status.json.remote.canPair, false);
  const config = await loadConfig({ dataDir: f.dataDir }); assert.equal(config.publicOrigin, f.originalSettings.publicOrigin); assert.equal(config.hermesPython, f.originalSettings.hermesPython);
  assert.equal(f.apps.at(-1).options.publicOrigin, f.originalSettings.publicOrigin); assert.equal(f.apps.at(-1).closed, false);
});

test('a component shutdown failure still cleans up the other desktop components and marker', async t => {
  const f = await fixture(t); f.connector.failStop = true;
  await f.host.close().catch(() => {});
  assert.equal(f.assistant.closed, true, 'assistant cleanup must continue after connector error');
  assert.ok(f.apps.every(app => app.closed), 'app cleanup must continue after connector error');
  await assert.rejects(readFile(join(f.dataDir, 'cli-process.json')), { code: 'ENOENT' });
});

test('public identity verification compares installation and challenge with strict no-redirect transport', async () => {
  const installationId = randomUUID(), challenge = 'a'.repeat(48); let request;
  assert.equal(await verifyRemoteInstallation({ publicOrigin, installationId, challenge }, { fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ service: 'nemo', installationId, challenge })); } }), true);
  assert.equal(request.options.redirect, 'error'); assert.equal(new URL(request.url).origin, publicOrigin);
  assert.equal(await verifyRemoteInstallation({ publicOrigin, installationId, challenge }, { fetchImpl: async () => new Response(JSON.stringify({ service: 'nemo', installationId: randomUUID(), challenge })) }), false);
  assert.equal(await verifyRemoteInstallation({ publicOrigin: 'http://example.test', installationId, challenge }, { fetchImpl: async () => { throw new Error('must not fetch'); } }), false);
});

test('desktop requires the selected ChatGPT connection before sign-in and after sign-out without freezing or exposing tokens', async t => {
  const f = await fixture(t);
  const first = f.apps[0].options;
  assert.equal(first.hermesOptions.requireChatGPT, true);
  assert.equal(first.hermesOptions.providerKey, undefined);
  assert.equal(first.nativeFactory, null);
  assert.equal(await first.hermesOptions.chatgptSession(), null);
  await f.request('/api/setup/assistant', { method: 'POST' });
  assert.equal((await first.hermesOptions.chatgptSession()).provider, 'chatgpt');
  await f.request('/api/setup/assistant', { method: 'POST', body: { action: 'acknowledge' } });
  assert.deepEqual(f.assistant.actions.at(-1), { action: 'acknowledge' });
  await f.request('/api/setup/assistant', { method: 'POST', body: { action: 'signout' } });
  assert.equal(await first.hermesOptions.chatgptSession(), null, 'existing providers must observe sign-out immediately');
  const status = await f.request('/api/setup/status');
  assert.equal(status.json.app.assistantConnected, false);
  assert.equal(status.text.includes(planAccessToken), false);
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 409);
});

test('changing ChatGPT accounts closes active app before account network work and leaves setup available', async t => {
  const f = await fixture(t, { assistantConnected: true });
  const originalApp = f.apps.at(-1);
  await f.assistant.pause();
  assert.equal(originalApp.closed, true);
  assert.equal((await f.request('/api/setup/status')).json.app.ready, false);
  assert.equal((await f.request('/api/setup/local-invite', { method: 'POST' })).status, 409);
  await f.assistant.resume();
  assert.equal((await f.request('/api/setup/status')).json.app.ready, true);
  assert.notEqual(f.apps.at(-1), originalApp);
  assert.equal(f.apps.at(-1).options.hermesOptions.requireChatGPT, true);
});
