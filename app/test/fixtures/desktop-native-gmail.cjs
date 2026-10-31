'use strict';
// Real Electron IPC, preload, cookies, profile guards and loopback callbacks.
// Google responses and browser opening are synthetic; no real account is used.
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createDesktopGmailAction } = require('../../desktop/gmail.cjs');
const root = path.resolve(__dirname, '../../.work/gmail-desktop');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(path.join(root, 'native-'));
app.setPath('userData', path.join(directory, 'electron'));
let server, window;
app.whenReady().then(async () => {
  const { createFamilyServer } = await import('../../lib/family-server.mjs');
  const { createGmailClient, GMAIL_SCOPE } = await import('../../lib/gmail.mjs');
  const { createCalendarStore } = await import('../../lib/calendar.mjs');
  const dataDir = path.join(directory, 'data'); mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, 'google-client.json'), JSON.stringify({ installed: { client_id: 'synthetic-native.apps.googleusercontent.com' } }));
  server = await createFamilyServer({ dataDir, publicDir: path.resolve(__dirname, '../../public'), memoryFactory: null, logger() {}, provider: { status: () => ({ connected: false }) }, async integrationsForProfile(profile, { dataDir, configDir }) {
    const gmail = await createGmailClient({ dataDir, configDir, fetchImpl: async url => String(url).endsWith('/token') ? Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope: GMAIL_SCOPE, expires_in: 3600 }) : Response.json({ emailAddress: `${profile.name.toLowerCase().replaceAll(' ', '.')}@example.test` }) });
    return { gmail, calendar: await createCalendarStore({ dataDir }) };
  } });
  await new Promise((done, reject) => { server.server.once('error', reject); server.server.listen(0, '127.0.0.1', done); });
  const origin = 'http://127.0.0.1:' + server.server.address().port;
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../../desktop/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL(origin + '/desktop.html');
  const session = window.webContents.session;
  async function request(route, body, profileId) {
    const response = await session.fetch(origin + route, { credentials: 'include', cache: 'no-store', headers: { Origin: origin, ...(profileId ? { 'X-Nemo-Profile': profileId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, route); return response.json();
  }
  let opened = 0, browserFails = false;
  ipcMain.handle('nemo:chat-gmail', createDesktopGmailAction({ getWindow: () => window, getOrigin: () => origin, fetchSession: () => request('/api/session'), async openExternal(value) {
    if (browserFails) throw new Error('Synthetic system browser failed.');
    opened++; const authorization = new URL(value), callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'synthetic');
    assert.equal((await fetch(callback)).status, 200);
  } }));
  const owner = await server.profiles.owner(), member = await server.profiles.create('Synthetic member');
  async function pair(profile) { const invite = await server.profiles.invite(profile.id); await request('/api/pair', { code: invite.code, expectedProfileId: profile.id, deviceName: 'Synthetic native session' }); }
  await pair(member);
  assert.equal((await request('/api/gmail/connection', undefined, member.id)).desktop.available, true);
  assert.deepEqual(await window.webContents.executeJavaScript(`window.nemoShell.connectGmail(${JSON.stringify(member.id)})`), { opened: true });
  const connection = await request('/api/gmail/connection', undefined, member.id);
  assert.equal(connection.gmail.account, 'synthetic.member@example.test'); assert.equal(connection.phone.available, false);
  assert.equal((await request('/api/integrations', undefined, member.id)).contextConsent, false);
  await assert.rejects(window.webContents.executeJavaScript(`window.nemoShell.connectGmail(${JSON.stringify(owner.id)})`), /profile changed/);
  await request('/api/gmail/disconnect', {}, member.id);
  browserFails = true;
  await assert.rejects(window.webContents.executeJavaScript(`window.nemoShell.connectGmail(${JSON.stringify(member.id)})`), /browser failed/);
  assert.equal((await request('/api/gmail/connection', undefined, member.id)).desktop.phase, 'cancelled');
  await request('/api/logout', {}, member.id);
  await assert.rejects(window.webContents.executeJavaScript(`window.nemoShell.connectGmail(${JSON.stringify(member.id)})`), /profile changed/);
  assert.equal(opened, 1);
  writeFileSync(path.join(root, 'native-result.json'), JSON.stringify({ ok: true, realElectronIPC: true, sandboxedPreload: true, memberOwnGmail: true, noWebClientRequired: true, staleProfileRejected: true, signedOutRejected: true, browserFailureCancelled: true, windowsProtectedStorage: process.platform === 'win32', consentUnchanged: true, syntheticGoogle: true, realGoogleAccountUsed: false }, null, 2) + '\n');
}).catch(error => { process.exitCode = 1; writeFileSync(path.join(root, 'native-result.json'), JSON.stringify({ ok: false, error: error.message }, null, 2) + '\n'); }).finally(async () => { window?.destroy(); await server?.close(); app.quit(); });
