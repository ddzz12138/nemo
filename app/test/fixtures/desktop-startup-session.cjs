'use strict';
// Separate Electron processes share only this disposable profile. Providers and
// setup readiness are synthetic; cookies, restart, history and revocation are real.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const http = require('node:http');
const { chatLaunch } = require('../../desktop/chat-contracts.cjs');
const { openDesktopStartup } = require('../../desktop/startup.cjs');
const { PERSONAL_PARTITION, persistPersonalSession } = require('../../desktop/session.cjs');
const directory = path.resolve(process.argv[2]), mode = process.argv[3];
const applicationVersion = process.argv[4] || 'baseline';
if (!/^[a-z0-9.-]{1,50}$/i.test(applicationVersion)) throw new Error('Use a synthetic app version.');
const programDirectory = path.join(directory, 'program', 'app-' + applicationVersion);
mkdirSync(directory, { recursive: true });
mkdirSync(programDirectory, { recursive: true });
app.setPath('userData', path.join(directory, 'electron'));
let host, setup, window, personalStorage;
app.whenReady().then(async () => {
  const { createFamilyServer } = await import('../../lib/family-server.mjs');
  const { defaultDataDir } = await import('../../lib/config.mjs');
  const { createProfileStore } = await import('../../lib/profile-store.mjs');
  const { createSecretStore } = await import('../../lib/secrets.mjs');
  const dataDir = defaultDataDir({ root: programDirectory, env: { LOCALAPPDATA: path.join(directory, 'local') }, platform: 'win32', home: directory });
  let clock = Date.now();
  if (mode === 'expire') {
    const profiles = await createProfileStore({ dataDir }), owner = await profiles.owner();
    clock = Math.max(clock, ...(await profiles.devices(owner.id)).map(item => item.expiresAt)) + 1;
  }
  let providerCalls = 0;
  host = await createFamilyServer({ dataDir, now: () => clock, publicDir: path.resolve(__dirname, '../../public'), memoryFactory: null, logger() {}, provider: { status: () => ({ connected: true }), async run() { providerCalls++; return { text: 'SYNTHETIC_SAVED_REPLY' }; } } });
  await new Promise((done, reject) => { host.server.once('error', reject); host.server.listen(0, '127.0.0.1', done); });
  const origin = 'http://127.0.0.1:' + host.server.address().port;
  setup = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>First-time setup</title><h1>Set up Nemo</h1>'); });
  await new Promise(done => setup.listen(0, '127.0.0.1', done));
  const setupUrl = 'http://127.0.0.1:' + setup.address().port + '/setup/';
  window = new BrowserWindow({ show: false, webPreferences: { partition: PERSONAL_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const session = window.webContents.session;
  personalStorage = persistPersonalSession(session);
  async function request(route, body, profileId) {
    const response = await session.fetch(origin + route, { credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Origin: origin, ...(profileId ? { 'X-Nemo-Profile': profileId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    assert.equal(response.status, route === '/api/chat' ? 202 : 200, route); return response.json();
  }
  const owner = await host.profiles.owner();
  let person = owner;
  if (mode === 'seed-member') person = await host.profiles.create('Synthetic member', false);
  let result = { ok: true, mode, applicationVersion, programDirectory, dataDir, userData: app.getPath('userData') };
  if (mode.startsWith('seed-') || mode === 'logout') {
    await window.loadURL(origin + '/desktop.html');
    const current = await request('/api/session');
    if (current.authenticated) await request('/api/logout', {}, current.profile.id);
    if (mode.startsWith('seed-')) {
      const invite = await host.profiles.invite(person.id);
      await request('/api/pair', { code: invite.code, expectedProfileId: person.id, deviceName: 'Synthetic startup' });
      if (mode === 'seed-owner' || mode === 'seed-upgrade') {
        const run = await request('/api/chat', { requestId: randomUUID(), message: 'SYNTHETIC_SAVED_QUESTION' }, person.id);
        for (let i = 0; i < 100; i++) { if ((await request('/api/runs/' + run.runId, undefined, person.id)).status === 'completed') break; await new Promise(done => setTimeout(done, 10)); }
        assert.ok(JSON.stringify(await request('/api/conversation', undefined, person.id)).includes('SYNTHETIC_SAVED_REPLY'));
      }
      assert.equal((await request('/api/session')).profile.id, person.id);
      if (mode === 'seed-upgrade') {
        const profileDirectory = host.profiles.directory(person.id);
        await createSecretStore({ dataDir, name: 'assistant-provider.dpapi' }).save({ version: 1, synthetic: 'SYNTHETIC_CHATGPT_GRANT' });
        await createSecretStore({ dataDir: profileDirectory }).save({ version: 1, synthetic: 'SYNTHETIC_GMAIL_GRANT' });
        writeFileSync(path.join(dataDir, 'host-setup.json'), JSON.stringify({ version: 1, ownerNameSet: true, completed: true }));
        const hashes = ['assistant-provider.dpapi', path.relative(dataDir, path.join(profileDirectory, 'gmail-tokens.dpapi'))].map(file => ({ file, sha256: createHash('sha256').update(readFileSync(path.join(dataDir, file))).digest('hex') }));
        writeFileSync(path.join(directory, 'account-hashes.json'), JSON.stringify(hashes));
      }
    }
    await personalStorage.flush();
  } else {
    if (mode === 'revoke') for (const device of await host.profiles.devices(owner.id)) await host.profiles.revoke(device.id);
    const before = await request('/api/session');
    const devicesBefore = (await host.profiles.devices(owner.id)).length;
    let newInvitations = 0;
    const status = mode === 'fresh' ? null : { owner: { name: 'Synthetic owner', configured: true }, runtime: { ready: true, connected: true, assistant: { provider: 'chatgpt', connected: true, phase: 'connected', planUsageEnabled: true, planUsageAcknowledged: true } }, app: { ready: true, assistantConnected: true } };
    const page = await openDesktopStartup({ window, appOrigin: origin, setupUrl, status, fetchSession: () => request('/api/session'),
      async openLocal() { newInvitations++; const invite = await host.profiles.invite(owner.id); await window.loadURL(chatLaunch(origin + '/pair.html#invite=' + invite.code).url); },
    });
    assert.equal(window.isVisible(), false, 'The initial document must stay hidden until startup routing finishes.');
    const current = await request('/api/session');
    let savedHistory = false;
    if (current.authenticated) savedHistory = JSON.stringify(await request('/api/conversation', undefined, current.profile.id)).includes('SYNTHETIC_SAVED_REPLY');
    assert.equal(providerCalls, 0, 'Opening Nemo must not resubmit inference.');
    const protectedAccountsPreserved = !existsSync(path.join(directory, 'account-hashes.json')) || JSON.parse(readFileSync(path.join(directory, 'account-hashes.json'))).every(item => createHash('sha256').update(readFileSync(path.join(dataDir, item.file))).digest('hex') === item.sha256);
    let protectedAccountsUnlocked = true;
    if (existsSync(path.join(directory, 'account-hashes.json'))) {
      const assistant = await createSecretStore({ dataDir, name: 'assistant-provider.dpapi' }).load();
      const gmail = await createSecretStore({ dataDir: host.profiles.directory(owner.id) }).load();
      protectedAccountsUnlocked = assistant?.synthetic === 'SYNTHETIC_CHATGPT_GRANT' && gmail?.synthetic === 'SYNTHETIC_GMAIL_GRANT';
      assert.equal(protectedAccountsUnlocked, true, 'An update must unlock the original synthetic connections without reseeding.');
    }
    result = { ...result, before: before.authenticated, page, authenticated: current.authenticated, role: current.profile?.role, savedHistory, newInvitations, newDevices: (await host.profiles.devices(owner.id)).length - devicesBefore, protectedAccountsPreserved, protectedAccountsUnlocked, applicationVersion, programDirectory, dataDir, userData: app.getPath('userData'), synthetic: true };
  }
  writeFileSync(path.join(directory, mode + '.json'), JSON.stringify(result, null, 2));
}).catch(error => { process.exitCode = 1; writeFileSync(path.join(directory, mode + '.json'), JSON.stringify({ ok: false, error: error.message })); }).finally(async () => { await personalStorage?.close(); window?.destroy(); await host?.close(); if (setup) await new Promise(done => setup.close(done)); app.quit(); });
