'use strict';
// Isolated Electron + real HTTP/IPC/renderer; no real grants or family data.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeFileSync, mkdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { chatSender, chatLaunch, authorizeDesktopSetup } = require('../../desktop/chat-contracts.cjs');
const { parseBootstrap, setupRequest, openLocalSpace } = require('../../desktop/contracts.cjs');
const { createHostAccessAction } = require('../../desktop/host-access.cjs');
const { readPersonalSession } = require('../../desktop/session.cjs');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'electron'));
let host, setup, window, browser;
app.whenReady().then(async () => {
  const { createFamilyServer } = await import('../../lib/family-server.mjs');
  const { createHostSetupServer } = await import('../../lib/host-setup-server.mjs');
  const { createProfileStore } = await import('../../lib/profile-store.mjs');
  const dataDir = path.join(directory, 'data'); let setupMutations = 0, providerCalls = 0;
  const profiles = await createProfileStore({ dataDir, ownerName: 'Synthetic owner' }), existingOwner = await profiles.owner(), personalDirectory = profiles.directory(existingOwner.id);
  mkdirSync(personalDirectory, { recursive: true });
  writeFileSync(path.join(personalDirectory, 'state.json'), JSON.stringify({ version: 1, sessions: { [existingOwner.id]: { conversationId: randomUUID(), expiresAt: Number.MAX_SAFE_INTEGER, messages: [{ id: randomUUID(), role: 'user', text: 'SYNTHETIC_EXISTING_CHAT', createdAt: Date.now() }], requestIds: {}, activeRunId: null } }, runs: {} }));
  host = await createFamilyServer({ dataDir, ownerName: 'Synthetic owner', publicDir: path.resolve('public'), memoryFactory: null, logger() {}, provider: { status: () => ({ connected: false }), run: async () => { providerCalls++; return { text: 'unused' }; } } });
  await new Promise(done => host.server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + host.server.address().port, owner = await host.profiles.owner();
  writeFileSync(path.join(dataDir, 'host-setup.json'), JSON.stringify({ version: 1, ownerNameSet: true, completed: true }));
  setup = await createHostSetupServer({ dataDir, profiles: host.profiles, assetsDir: path.resolve('public'),
    remoteHost: { status: () => ({ canPair: false }) },
    runtimeStatus: async () => ({ ready: true, connected: false, assistant: { connected: false, provider: 'chatgpt', phase: 'disconnected', planUsageAcknowledged: false } }),
    appStatus: async () => ({ ready: true, assistantConnected: false, origin }),
    runtimeSetup: async () => { setupMutations++; throw new Error('Setup must not repeat'); }, assistantSetup: async () => { setupMutations++; throw new Error('Account setup must not repeat'); },
    localInvite: async id => { const invite = await host.profiles.invite(id); return { url: origin + '/pair.html#invite=' + invite.code, profile: invite.profile, expiresAt: invite.expiresAt }; },
  });
  const bootstrap = parseBootstrap(setup.bootstrapUrl);
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('desktop/preload.cjs'), partition: 'persist:synthetic-host', contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const fetchSession = () => readPersonalSession(window.webContents.session, origin);
  ipcMain.handle('nemo:host-access', createHostAccessAction({ getWindow: () => window, getOrigin: () => origin, getSetupUrl: () => bootstrap.pageUrl, fetchSession }));
  ipcMain.handle('nemo:get-start-at-login', () => false);
  ipcMain.handle('nemo:setup', async (event, action, input, profileId) => {
    await authorizeDesktopSetup({ event, window, appOrigin: origin, setupUrl: bootstrap.pageUrl, profileId, fetchSession });
    if (action === 'openLocal') return openLocalSpace({ ...bootstrap, openWindow: url => window.loadURL(chatLaunch(url).url) });
    return setupRequest({ ...bootstrap, action, input });
  });
  const waitFor = async expression => { for (let i = 0; i < 150; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(done => setTimeout(done, 25)); } throw new Error('Synthetic renderer did not reach: ' + expression); };
  const button = text => `Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)})`;
  const click = text => window.webContents.executeJavaScript(`${button(text)}.click(); undefined;`);
  await window.loadURL(origin + '/desktop.html');
  await waitFor(`!!${button('Continue on this PC')}`);
  const before = (await host.profiles.devices(owner.id)).length;
  await click('Continue on this PC');
  await waitFor(`!!${button('Continue as Synthetic owner')}`);
  await click('Continue as Synthetic owner');
  await waitFor(`!!${button('Open Synthetic owner’s space')}`);
  assert.equal((await fetchSession()).authenticated, false);
  assert.equal((await host.profiles.devices(owner.id)).length, before);
  // Invitation fragments are deliberately cleared; a reload must have a way back.
  assert.equal(new URL(window.webContents.getURL()).hash, '');
  window.reload();
  await waitFor(`!!${button('Continue on this PC')}`);
  await click('Continue on this PC'); await waitFor(`!!${button('Continue as Synthetic owner')}`);
  await click('Continue as Synthetic owner'); await waitFor(`!!${button('Open Synthetic owner’s space')}`);
  await click('Open Synthetic owner’s space');
  await waitFor('document.body.innerText.includes("SYNTHETIC_EXISTING_CHAT")');
  assert.equal((await fetchSession()).profile.id, owner.id);
  const member = await host.profiles.create('Synthetic member', false), invite = await host.profiles.invite(member.id);
  await window.webContents.executeJavaScript(`(async()=>{await window.nemoFetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},body:'{}'});await window.nemoFetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},body:${JSON.stringify(JSON.stringify({ code: invite.code, expectedProfileId: member.id, deviceName: 'Synthetic member' }))}});})()`);
  await window.loadURL(origin + '/desktop.html'); await waitFor('document.body.innerText.includes("Hello, Synthetic member.")');
  await window.webContents.executeJavaScript('window.nemoShell.openHost(); undefined;');
  await waitFor('document.body.innerText.includes("Settings") && !document.body.innerText.includes("Continue as Synthetic owner")');
  assert.equal(new URL(window.webContents.getURL()).origin, origin); assert.equal((await fetchSession()).profile.id, member.id);
  browser = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await browser.loadURL(origin + '/desktop.html');
  for (let i = 0; i < 100; i++) { if (await browser.webContents.executeJavaScript('document.body.innerText.includes("Join your family’s Nemo")')) break; await new Promise(done => setTimeout(done, 25)); }
  assert.equal(await browser.webContents.executeJavaScript('document.body.innerText.includes("Join your family’s Nemo") && !document.body.innerText.includes("Continue on this PC")'), true);
  assert.equal(setupMutations, 0); assert.equal(providerCalls, 0);
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ ok: true, recoveredAfterReload: true, savedChatRestored: true, noAccountSetup: true, memberPreserved: true, browserStillNeedsInvite: true }));
}).catch(error => { process.exitCode = 1; writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: error.message })); }).finally(async () => { browser?.destroy(); window?.destroy(); await setup?.close(); await host?.close(); app.quit(); });
