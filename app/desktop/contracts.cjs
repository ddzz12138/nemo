'use strict';
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const ACTIONS = Object.freeze({
  status: ['GET', '/api/setup/status'],
  owner: ['POST', '/api/setup/owner'],
  runtime: ['POST', '/api/setup/runtime'],
  assistant: ['POST', '/api/setup/assistant'],
  enroll: ['POST', '/api/setup/enroll'],
  enrollment: ['POST', '/api/setup/enroll/poll'],
  enable: ['POST', '/api/setup/remote/enable'],
  disable: ['POST', '/api/setup/remote/disable'],
  invite: ['POST', '/api/setup/invite'],
  localInvite: ['POST', '/api/setup/local-invite'],
});

function parseBootstrap(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || !['/setup/', '/host-setup.html'].includes(url.pathname)) throw new Error('Nemo returned an invalid setup address.');
  const token = new URLSearchParams(url.hash.slice(1)).get('setup');
  if (!token || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error('Nemo could not confirm this setup window.');
  return { origin: url.origin, token, pageUrl: url.origin + url.pathname };
}

function utilityLaunchOptions({ appPath, dataDir, resourcesPath, environment = {} }) {
  if (!path.isAbsolute(appPath) || !path.isAbsolute(dataDir) || !path.isAbsolute(resourcesPath)) throw new Error('Desktop locations must be absolute.');
  return {
    modulePath: path.join(appPath, 'desktop', 'host-process.mjs'),
    args: [],
    options: {
      cwd: appPath,
      // Electron utilityProcess supplies Node itself. No node.exe lookup or Electron-as-Node mode.
      env: { ...environment, NEMO_DESKTOP_DATA_DIR: dataDir, NEMO_DESKTOP_RESOURCES_PATH: resourcesPath },
      stdio: 'ignore',
      serviceName: 'Nemo background assistant',
    },
  };
}

function allowedExternal(value, serviceOrigin, development = false) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.origin === 'https://auth.openai.com') return url.pathname === '/api/accounts/authorize';
    if (url.origin === 'https://chatgpt.com') return url.href === CHATGPT_USAGE_URL;
    const configured = new URL(serviceOrigin);
    if (url.username || url.password || url.origin !== configured.origin) return false;
    return url.protocol === 'https:' || (development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  } catch { return false; }
}

async function registrationOriginForLaunch({resourcesPath,appPath,environment={},development=false}) {
  let value=environment.NEMO_REGISTRATION_URL||'';
  if(!value) {
    for(const manifestPath of [path.join(resourcesPath,'desktop-runtime','manifest.json'),path.join(appPath,'.work','desktop-runtime','manifest.json')]) {
      let text;
      try {text=await readFile(manifestPath,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(Buffer.byteLength(text)>262_144)throw new Error('Nemo release settings are invalid.');
      const manifest=JSON.parse(text);value=manifest.registrationOrigin||'';
      if(value)break;
    }
  }
  if(!value)return '';
  const url=new URL(value);
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||development&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('Nemo release sign-in is not configured.');
  return url.origin;
}

async function setupRequest({ origin, token, action, input = {}, fetchImpl = fetch }) {
  const route = typeof action==='string' && Object.hasOwn(ACTIONS,action) ? ACTIONS[action] : null;
  if (!route || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 16_384) throw new Error('Choose one of the setup actions shown in Nemo.');
  const response = await fetchImpl(origin + route[1], {
    method: route[0], redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json', 'X-Nemo-Request': '1' },
    ...(route[0] === 'POST' ? { body: JSON.stringify(input) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : 'Nemo could not finish this step. Try again.');
    error.code = result.code;
    throw error;
  }
  return result;
}

function localInvitationUrl(result, appOrigin, ownerId) {
  const expected = new URL(appOrigin), url = new URL(result?.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if(expected.protocol!=='http:'||expected.hostname!=='127.0.0.1'||!expected.port||expected.pathname!=='/'||expected.username||expected.password||expected.search||expected.hash||url.origin!==expected.origin||url.username||url.password||url.pathname!=='/pair.html'||url.search||[...fragment.keys()].length!==1||fragment.getAll('invite').length!==1||!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(fragment.get('invite')||'')||!ownerId||result.profile?.id!==ownerId) throw new Error('Nemo could not confirm your space on this computer. Try again.');
  return url.href;
}

function loginItemOptions({platform,packaged,execPath,exists}) {
  if(platform!=='win32'||!packaged||!/^app-/i.test(path.basename(path.dirname(execPath))))return {};
  const stub=path.resolve(path.dirname(execPath),'..',path.basename(execPath));
  return exists(stub)?{path:stub,args:[]}:{};
}

async function openLocalSpace({origin,token,openWindow,fetchImpl=fetch}) {
  // The renderer chooses an action, never an address, port, profile or token.
  const status = await setupRequest({origin,token,action:'status',fetchImpl});
  const invitation = await setupRequest({origin,token,action:'localInvite',fetchImpl});
  const url = localInvitationUrl(invitation,status.app?.origin,status.owner?.id);
  try { await openWindow(url); }
  catch { throw new Error('Nemo could not open your space. Try again in this app.'); }
  return {opened:true,profile:{id:invitation.profile.id,name:invitation.profile.name}};
}

module.exports = { CHATGPT_USAGE_URL, ACTIONS, parseBootstrap, utilityLaunchOptions, allowedExternal, registrationOriginForLaunch, setupRequest, localInvitationUrl, openLocalSpace, loginItemOptions };
