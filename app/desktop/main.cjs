'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell, utilityProcess } = require('electron');
const path = require('node:path');
const { mkdir, writeFile, readFile, appendFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { parseBootstrap, utilityLaunchOptions, allowedExternal, registrationOriginForLaunch, setupRequest, openLocalSpace, loginItemOptions, CHATGPT_USAGE_URL } = require('./contracts.cjs');
const { chatLaunch, chatNavigation, authorizeDesktopSetup } = require('./chat-contracts.cjs');
const { openDesktopStartup } = require('./startup.cjs');
const { createDesktopGmailAction } = require('./gmail.cjs');
const { PERSONAL_PARTITION, persistPersonalSession, readPersonalSession } = require('./session.cjs');
const { openDesktopSettings, createHostAccessAction } = require('./host-access.cjs');

let window, chatOrigin, background, setup, tray, personalStorage, quitting = false;
let serviceOrigin = process.env.NEMO_REGISTRATION_URL || '';
const smoke = process.env.NEMO_DESKTOP_SMOKE === '1';
const smokeInstallRuntime = smoke && process.env.NEMO_DESKTOP_SMOKE_INSTALL_RUNTIME === '1';
const smokeDirectory = process.env.NEMO_DESKTOP_DATA_DIR || '';
const smokeValid = smoke && path.isAbsolute(smokeDirectory);
const smokeResult = smokeValid ? path.join(smokeDirectory,'desktop-smoke-result.json') : '';
const startupEvent = require('electron-squirrel-startup');
if (startupEvent || (smoke&&!smokeValid) || (!smoke&&!app.requestSingleInstanceLock())) app.quit();
else {
  app.on('second-instance', () => { if(window){window.show();if(window.isMinimized())window.restore();window.focus();} });
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => { /* The host keeps serving the phone until Quit Nemo. */ });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    const cookiesSaved = Promise.resolve(personalStorage?.close()).catch(() => {});
    background?.postMessage({ type: 'shutdown' });
    const timer = setTimeout(() => { background?.kill(); app.quit(); }, 5_000);
    const finish = () => { void Promise.resolve(cookiesSaved).catch(() => {}).then(() => { clearTimeout(timer); app.quit(); }); };
    background?.once('exit', finish);
    if (!background) finish();
  });
  app.whenReady().then(start).catch(async () => { if(smoke)await saveSmoke({ready:false,message:'Nemo could not complete its desktop startup check.'});else dialog.showErrorBox('Nemo could not start', 'Close Nemo and open it again. Your saved chats stay on this computer.'); app.quit(); });
}

async function saveSmoke(result) { if(!smokeResult)return;try{await mkdir(smokeDirectory,{recursive:true});await writeFile(smokeResult,JSON.stringify(result,null,2)+'\n',{mode:0o600});}catch{} }
async function smokeStage(stage) { if(!smokeResult)return;try{await appendFile(path.join(smokeDirectory,'desktop-smoke-stages.log'),stage+'\n',{mode:0o600});}catch{} }

async function personalSession() {
  if(!chatOrigin||!window||window.isDestroyed())return null;
  return readPersonalSession(window.webContents.session, chatOrigin);
}
async function fromSetupOrOwner(event,profileId) {
  return authorizeDesktopSetup({event,window,setupUrl:setup?.pageUrl,appOrigin:chatOrigin,profileId,fetchSession:personalSession});
}

async function start() {
  if(smoke)await saveSmoke({ready:false,stage:'starting'});
  const { defaultDataDir } = await import('../lib/config.mjs');
  const dataDir = process.env.NEMO_DESKTOP_DATA_DIR || defaultDataDir();
  if (!path.isAbsolute(dataDir)) throw new Error('Nemo needs its saved private data location.');
  serviceOrigin = await registrationOriginForLaunch({resourcesPath:process.resourcesPath,appPath:app.getAppPath(),environment:process.env,development:!app.isPackaged});
  const launch = utilityLaunchOptions({ appPath: app.getAppPath(), dataDir, resourcesPath: process.resourcesPath, environment: {...process.env,NEMO_REGISTRATION_URL:serviceOrigin} });
  background = utilityProcess.fork(launch.modulePath, launch.args, launch.options);
  setup = await new Promise((resolve, reject) => {
    // A cold Windows start verifies the complete bundled assistant inventory.
    // Allow the real parent flow at least as long as first-run smoke checks.
    const timer = setTimeout(() => reject(new Error('Nemo took too long to open.')), smoke ? 120_000 : 180_000);
    background.on('message', async message => {
      if (message?.type === 'ready') { clearTimeout(timer); if(smoke)await saveSmoke({ready:false,stage:'backend-ready'}); try { resolve(parseBootstrap(message.bootstrapUrl)); } catch (error) { reject(error); } }
      if (message?.type === 'failed') { clearTimeout(timer); reject(new Error('Nemo could not start.')); }
      if (message?.type === 'assistant-connected' && !smoke && window) {
        window.show(); if (window.isMinimized()) window.restore(); window.focus();
      }
      if (message?.type === 'open-external') {
        let ok = false;
        if (allowedExternal(message.url, serviceOrigin, !app.isPackaged)) {
          try { await shell.openExternal(message.url); ok = true; } catch {}
        }
        background.postMessage({ type: 'external-result', requestId: message.requestId, ok });
      }
    });
    background.once('exit', () => { clearTimeout(timer); reject(new Error('Nemo stopped while opening.')); });
  });
  const state=await setupRequest({...setup,action:'status'});
  chatOrigin=state.app?.origin;
  // Keep one sandboxed renderer. The private setup listener still has its own
  // origin and capability; app-origin management requires a live owner session.
  ipcMain.handle('nemo:setup', async (event, action, input, profileId) => {
    await fromSetupOrOwner(event,profileId);
    if(smoke&&['status','runtime'].includes(action))await smokeStage(action+'-start');
    if(action==='manageUsage') {
      if(input&&Object.keys(input).length)throw new Error('Use the Manage usage button shown in Nemo.');
      await shell.openExternal(CHATGPT_USAGE_URL);
      return {opened:true};
    }
    if(action==='openLocal') {
      if(input&&Object.keys(input).length)throw new Error('Use the local chat button shown in Nemo.');
      const current=await personalSession();
      if(current?.authenticated&&current.profile?.id===state.owner?.id){await window.loadURL(chatOrigin+'/desktop.html');return {opened:true,profile:current.profile};}
      return openLocalSpace({...setup,openWindow:async invitation=>{const launch=chatLaunch(invitation);if(launch.origin!==chatOrigin)throw new Error('Reopen Nemo to reconnect.');await window.loadURL(launch.url);}});
    }
    if(action==='localInvite')throw new Error('Use the local chat button shown in Nemo.');
    const result = await setupRequest({ ...setup, action, input });
    if(smoke&&['status','runtime'].includes(action))await smokeStage(action+'-complete');
    return result;
  });
  const loginOptions=loginItemOptions({platform:process.platform,packaged:app.isPackaged,execPath:process.execPath,exists:existsSync});
  ipcMain.handle('nemo:start-at-login', async(event, enabled,profileId) => { await fromSetupOrOwner(event,profileId); app.setLoginItemSettings({ ...loginOptions,openAtLogin: enabled === true }); return app.getLoginItemSettings(loginOptions).openAtLogin; });
  ipcMain.handle('nemo:get-start-at-login', async(event,profileId) => { await fromSetupOrOwner(event,profileId); return app.getLoginItemSettings(loginOptions).openAtLogin; });
  ipcMain.handle('nemo:chat-gmail', createDesktopGmailAction({ getWindow:()=>window, getOrigin:()=>chatOrigin, fetchSession:personalSession, openExternal:url=>shell.openExternal(url) }));
  ipcMain.handle('nemo:host-access', createHostAccessAction({ getWindow:()=>window, getOrigin:()=>chatOrigin, getSetupUrl:()=>setup.pageUrl, fetchSession:personalSession }));
  window = new BrowserWindow({
    title: 'Nemo', width: 1160, height: 820, minWidth: 560, minHeight: 620, backgroundColor: '#ffffff', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition:PERSONAL_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: true },
  });
  personalStorage = persistPersonalSession(window.webContents.session);
  if(smoke)await saveSmoke({ready:false,stage:'window-created'});
  window.webContents.setWindowOpenHandler(({url}) => {if(url===CHATGPT_USAGE_URL||url===chatOrigin+'/vendor/ollama-LICENSE.txt')void shell.openExternal(url).catch(()=>{});return {action:'deny'};});
  const showNemo=()=>{window.show();if(window.isMinimized())window.restore();window.focus();};
  const showSettings=async()=>{await openDesktopSettings({window,appOrigin:chatOrigin,setupUrl:setup.pageUrl,fetchSession:personalSession});showNemo();};
  const settingsFailed=()=>{showNemo();dialog.showErrorBox('Nemo could not open Settings','Your sign-in could not be checked. Try Settings again, or quit and reopen Nemo. Your saved chats and connected accounts are kept.');};
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Nemo',submenu:[{label:'Settings',click:()=>void showSettings().catch(settingsFailed)},{type:'separator'},{label:'Quit Nemo',click:()=>app.quit()}]},{role:'editMenu'}]));
  window.webContents.on('will-navigate', (event, target) => {
    const here=window.webContents.getURL();
    if(here===setup.pageUrl&&target===setup.pageUrl)return;
    if(here.startsWith(chatOrigin+'/')&&chatNavigation(target,chatOrigin))return;
    event.preventDefault();
    for(const [legacy,section] of [['/family.html','family'],['/memory.html','memory']])if(target===chatOrigin+legacy)void window.loadURL(chatOrigin+'/desktop.html#'+section);
  });
  window.webContents.on('did-navigate',(_event,target)=>{if(target===chatOrigin+'/')void window.loadURL(chatOrigin+'/desktop.html');});
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.on('will-download',event=>event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  // A tiny monochrome tray icon works without a runtime-generated bitmap file.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) { const p = (y * 16 + x) * 4; pixels[p] = 32; pixels[p + 1] = 33; pixels[p + 2] = 29; pixels[p + 3] = 255; }
  if(!smoke) {
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 }));
    tray.setToolTip('Nemo is running — your computer needs to stay awake');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Nemo', click:showNemo },{label:'Settings',click:()=>void showSettings().catch(settingsFailed)},{ type: 'separator' }, { label: 'Quit Nemo', click: () => app.quit() }]));
    tray.on('click',showNemo);
  }
  if(smoke)await window.loadURL(setup.pageUrl);
  else {
    await openDesktopStartup({window,appOrigin:chatOrigin,setupUrl:setup.pageUrl,status:state,fetchSession:personalSession,
      openLocal:()=>openLocalSpace({...setup,openWindow:async invitation=>{const launch=chatLaunch(invitation);if(launch.origin!==chatOrigin)throw new Error('Reopen Nemo to reconnect.');await window.loadURL(launch.url);}}),
    });
    // Do not flash the invitation/setup document while restoring a saved chat.
    window.show();
  }
  if(smoke)await saveSmoke({ready:false,stage:'setup-loaded'});
  background.on('exit', () => { if (!quitting&&!smoke) { window?.show(); dialog.showErrorBox('Nemo needs to reopen', 'The assistant stopped. Quit Nemo from its menu and open it again. Your chats are saved.'); } });
  if(smoke) {
    const result=await window.webContents.executeJavaScript(`(async()=>{
      if(typeof window.nemoDesktop?.request!=='function')throw new Error('Preload unavailable');
      let status=await window.nemoDesktop.request('status');
      const installRuntime=${smokeInstallRuntime};
      if(installRuntime&&status.runtime?.ready!==true){await window.nemoDesktop.request('runtime');status=await window.nemoDesktop.request('status');}
      await new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const check=()=>{if(document.getElementById('setup-name'))return resolve();if(Date.now()>deadline)return reject(new Error('Setup unavailable'));setTimeout(check,25);};check();});
      return {ready:!!status.owner?.id&&(!installRuntime||status.runtime?.ready===true),preload:true,unifiedWindow:true,nameForm:!!document.getElementById('setup-name'),heading:document.querySelector('.setup-intro h2').innerText.replace(/\\s+/g,' ').trim(),...(installRuntime?{runtimeReady:status.runtime?.ready===true}:{})};
    })()`);
    if(smokeInstallRuntime) {
      const settings=JSON.parse(await readFile(path.join(dataDir,'nemo.json'),'utf8'));
      const relative=typeof settings.hermesPython==='string'?path.relative(path.join(process.resourcesPath,'desktop-runtime'),settings.hermesPython):'..';
      result.runtimePythonIsBundled=!!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
      result.ready=result.ready&&result.runtimePythonIsBundled;
    }
    await saveSmoke(result);app.quit();
  }
}
