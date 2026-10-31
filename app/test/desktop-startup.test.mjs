import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { openDesktopStartup } = require('../desktop/startup.cjs');
const appOrigin = 'http://127.0.0.1:8787', setupUrl = 'http://127.0.0.1:45555/setup/';
const ready = () => ({ owner: { name: 'Asha', configured: true }, runtime: { ready: true, connected: true, assistant: { provider: 'chatgpt', connected: true, phase: 'connected', planUsageEnabled: true, planUsageAcknowledged: true } }, app: { ready: true, assistantConnected: true, origin: appOrigin } });

test('cold startup establishes the app document before validating a saved personal session', async () => {
  for (const role of ['owner', 'member']) {
    const calls = [];
    const page = await openDesktopStartup({ appOrigin, setupUrl, status: ready(), window: { async loadURL(url) { calls.push(url); } },
      async fetchSession() { assert.deepEqual(calls, [setupUrl]); return { authenticated: true, profile: { id: role, role } }; },
      async openLocal() { assert.fail('A saved person must not receive a new owner invitation.'); },
    });
    assert.equal(page, 'chat');
    assert.deepEqual(calls, [setupUrl, appOrigin + '/desktop.html']);
  }
});

test('completed browser-era setup offers desktop profile confirmation without repeating setup or signing in automatically', async () => {
  const calls = [];
  assert.equal(await openDesktopStartup({ appOrigin, setupUrl, status: ready(), window: { async loadURL(url) { calls.push(url); } },
    async fetchSession() { return { authenticated: false }; }, async openLocal() { calls.push('confirm-person'); },
  }), 'pairing');
  assert.deepEqual(calls, [setupUrl, 'confirm-person']);
});

test('first-time, incomplete and unacknowledged setups retain onboarding', async () => {
  const cases = [null, { owner: { name: 'Owner', configured: false }, runtime: { ready: false }, app: { ready: true } }];
  for (const change of [value => { value.runtime.ready = false; }, value => { value.runtime.assistant.connected = false; }, value => { value.runtime.assistant.confirmationRequired = true; }, value => { value.runtime.assistant.planUsageAcknowledged = false; }]) {
    const value = ready(); change(value); cases.push(value);
  }
  for (const status of cases) {
    const calls = [];
    assert.equal(await openDesktopStartup({ appOrigin, setupUrl, status, window: { async loadURL(url) { calls.push(url); } },
      async fetchSession() { return { authenticated: false }; }, async openLocal() { assert.fail('Incomplete setup must not create an invitation.'); },
    }), 'setup');
    assert.deepEqual(calls, [setupUrl]);
  }
});

test('a returning signed-in user can open saved chat even when the assistant needs reconnecting', async () => {
  const status = ready(); status.runtime.assistant.connected = false;
  const calls = [];
  assert.equal(await openDesktopStartup({ appOrigin, setupUrl, status, window: { async loadURL(url) { calls.push(url); } }, fetchSession: async () => ({ authenticated: true }) }), 'chat');
  assert.deepEqual(calls, [setupUrl, appOrigin + '/desktop.html']);
});

test('finished setup is retained across provider disconnection without granting a signed-out device private access', async () => {
  const status = ready(); status.setupCompleted = true; status.runtime.assistant = { provider: 'chatgpt', connected: false, phase: 'disconnected', planUsageAcknowledged: false }; status.runtime.connected = false; status.app.assistantConnected = false;
  const calls = [];
  const options = { appOrigin, setupUrl, status, window: { async loadURL(url) { calls.push(url); } }, fetchSession: async () => ({ authenticated: false }), openLocal: async () => calls.push('confirm-person') };
  assert.equal(await openDesktopStartup(options), 'pairing');
  assert.deepEqual(calls, [setupUrl, 'confirm-person']);
  status.runtime.assistant = { provider: 'chatgpt', connected: true, phase: 'connected', confirmationRequired: true };
  assert.equal(await openDesktopStartup(options), 'setup');
  assert.equal(calls.at(-1), setupUrl);
});

let electron;
try { electron = require('electron'); } catch {}
test('real Electron cold restarts restore owner/member chat and saved history; sign-out, revocation and fresh installs stay gated', { skip: typeof electron !== 'string', timeout: 120_000 }, async t => {
  const parent = resolve('.work'), directory = await mkdtemp(join(parent, 'startup-regression-'));
  t.after(async () => { assert.equal(dirname(directory), parent); assert.ok(directory.startsWith(join(parent, 'startup-regression-'))); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const fixture = fileURLToPath(new URL('./fixtures/desktop-startup-session.cjs', import.meta.url));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  async function phase(mode, home = directory) {
    await promisify(execFile)(electron, [fixture, home, mode], { windowsHide: true, env: environment, timeout: 20_000 });
    const result = JSON.parse(await readFile(join(home, mode + '.json'), 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  }
  await phase('seed-owner');
  const owner = await phase('restore');
  assert.equal(owner.page, 'chat'); assert.equal(owner.role, 'owner'); assert.equal(owner.savedHistory, true); assert.equal(owner.newInvitations, 0);
  await phase('seed-member');
  const member = await phase('restore');
  assert.equal(member.page, 'chat'); assert.equal(member.role, 'member'); assert.equal(member.newInvitations, 0);
  await phase('logout');
  const signedOut = await phase('restore');
  assert.equal(signedOut.page, 'pairing'); assert.equal(signedOut.authenticated, false); assert.equal(signedOut.newDevices, 0);
  await phase('seed-owner');
  const revoked = await phase('revoke');
  assert.equal(revoked.page, 'pairing'); assert.equal(revoked.authenticated, false); assert.equal(revoked.newDevices, 0);
  const fresh = await phase('fresh', join(directory, 'fresh'));
  assert.equal(fresh.page, 'setup'); assert.equal(fresh.authenticated, false); assert.equal(fresh.newInvitations, 0);
});

test('a Windows version-folder upgrade retains sign-in, chat and protected accounts; expired sign-in never repeats account setup', { skip: typeof electron !== 'string' || process.platform !== 'win32', timeout: 120_000 }, async t => {
  const parent = resolve('.work'), directory = await mkdtemp(join(parent, 'upgrade-regression-'));
  t.after(async () => { assert.equal(dirname(directory), parent); assert.ok(directory.startsWith(join(parent, 'upgrade-regression-'))); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const fixture = fileURLToPath(new URL('./fixtures/desktop-startup-session.cjs', import.meta.url));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  async function phase(mode, version) {
    await promisify(execFile)(electron, [fixture, directory, mode, version], { windowsHide: true, env: environment, timeout: 30_000 });
    const value = JSON.parse(await readFile(join(directory, mode + '.json'), 'utf8'));
    assert.equal(value.ok, true, JSON.stringify(value)); return value;
  }
  const original = await phase('seed-upgrade', '0.3.0-alpha.13');
  const upgraded = await phase('restore', '0.3.0-alpha.14');
  assert.notEqual(original.programDirectory, upgraded.programDirectory);
  assert.equal(original.dataDir, upgraded.dataDir); assert.equal(original.userData, upgraded.userData);
  assert.equal(upgraded.page, 'chat'); assert.equal(upgraded.authenticated, true); assert.equal(upgraded.savedHistory, true);
  assert.equal(upgraded.newInvitations, 0); assert.equal(upgraded.newDevices, 0); assert.equal(upgraded.protectedAccountsPreserved, true);
  assert.equal(upgraded.protectedAccountsUnlocked, true);
  const expired = await phase('expire', '0.3.0-alpha.15');
  assert.equal(expired.page, 'pairing'); assert.equal(expired.authenticated, false); assert.equal(expired.newDevices, 0);
  assert.equal(expired.protectedAccountsPreserved, true);
  assert.equal(expired.protectedAccountsUnlocked, true);
});
