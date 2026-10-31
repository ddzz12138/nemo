import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canOpenPersonalSpace } from '../public/desktop-setup.mjs';
const require = createRequire(import.meta.url);
const { createHostAccessAction } = require('../desktop/host-access.cjs');
const origin = 'http://127.0.0.1:8787', setupUrl = 'http://127.0.0.1:45555/setup/';

function harness(fetchSession = async () => ({ authenticated: false })) {
  const mainFrame = { url: origin + '/desktop.html' }, loads = [];
  const window = { isDestroyed: () => false, webContents: { mainFrame }, loadURL: async url => loads.push(url) };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  const act = createHostAccessAction({ getWindow: () => window, getOrigin: () => origin, getSetupUrl: () => setupUrl, fetchSession });
  return { window, event, act, loads };
}

test('native host recovery opens existing setup without exposing credentials or switching an authenticated member', async () => {
  const signedOut = harness();
  assert.deepEqual(await signedOut.act(signedOut.event), { opened: true });
  assert.deepEqual(signedOut.loads, [setupUrl]);
  for (const role of ['owner', 'member']) {
    const signedIn = harness(async () => ({ authenticated: true, profile: { id: role, role } }));
    await signedIn.act(signedIn.event);
    assert.deepEqual(signedIn.loads, [origin + '/desktop.html#settings']);
  }
});

test('host recovery rejects other windows, subframes, supplied identities and navigation races', async () => {
  const h = harness();
  await assert.rejects(h.act({ ...h.event, sender: {} }));
  await assert.rejects(h.act({ ...h.event, senderFrame: { url: origin + '/desktop.html' } }));
  await assert.rejects(h.act(h.event, { profileId: 'owner' }));
  h.event.senderFrame.url = 'https://other.example/desktop.html';
  await assert.rejects(h.act(h.event));
  assert.deepEqual(h.loads, []);
  const raced = harness(async () => { raced.event.senderFrame.url = origin + '/different.html'; return { authenticated: false }; });
  await assert.rejects(raced.act(raced.event)); assert.deepEqual(raced.loads, []);
  for (const fetchSession of [async () => null, async () => { throw new Error('Synthetic outage'); }]) {
    const failed = harness(fetchSession); await assert.rejects(failed.act(failed.event)); assert.deepEqual(failed.loads, []);
  }
});

test('completed host setup can reopen saved data while the assistant is disconnected', () => {
  const value = { setupCompleted: true, app: { ready: true }, runtime: { ready: true, assistant: { connected: false, planUsageAcknowledged: false } } };
  assert.equal(canOpenPersonalSpace(value), true);
  value.runtime.assistant.connected = true; assert.equal(canOpenPersonalSpace(value), false);
  value.runtime.assistant.planUsageAcknowledged = true; assert.equal(canOpenPersonalSpace(value), true);
  value.app.ready = false; assert.equal(canOpenPersonalSpace(value), false);
  assert.equal(canOpenPersonalSpace(null), false);
});

let electron; try { electron = require('electron'); } catch {}
test('real native host recovery survives a lost invitation and restores saved chat without account setup', { skip: typeof electron !== 'string', timeout: 60_000 }, async t => {
  const parent = resolve('.work'), directory = await mkdtemp(join(parent, 'host-access-'));
  t.after(async () => { assert.equal(dirname(directory), parent); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron, [fileURLToPath(new URL('./fixtures/desktop-host-access.cjs', import.meta.url)), directory], { windowsHide: true, env, timeout: 50_000 });
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(result, { ok: true, recoveredAfterReload: true, savedChatRestored: true, noAccountSetup: true, memberPreserved: true, browserStillNeedsInvite: true });
});
