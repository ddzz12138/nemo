// Explicit, local-only visual QA. The native bridge and providers are simulated;
// profile ownership, personal invitations, cookies and application APIs are real.
// Never import this fixture from a production entry point.
import http from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFamilyServer } from '../../lib/family-server.mjs';
import { createCalendarStore } from '../../lib/calendar.mjs';
import { createHostSetupServer } from '../../lib/host-setup-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { ACTIONS, setupRequest } = createRequire(import.meta.url)('../../desktop/contracts.cjs');
const BOOT_PATHS = new Set(['/setup/', '/setup', '/host-setup.html']);
const EXTRA_ACTIONS = new Set(['openLocal', 'manageUsage', 'loginGet', 'loginSet']);
const securityHeaders = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const bridge = `(() => {
  'use strict';
  async function call(action, input = {}, profileId) {
    const response = await fetch('/__preview/setup/' + encodeURIComponent(action), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type':'application/json','X-Nemo-Request':'1'},
      body: JSON.stringify({input, profileId, documentPath: location.pathname}),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'The synthetic preview could not complete this action.'), {code:value.code,status:response.status});
    if (action === 'openLocal') { location.assign(value.destination); return {opened:true,profile:value.profile}; }
    return value;
  }
  window.nemoDesktop = Object.freeze({
    request: (action,input = {},profileId) => call(action,input,profileId),
    getStartAtLogin: profileId => call('loginGet',{},profileId),
    setStartAtLogin: (enabled,profileId) => call('loginSet',{enabled:enabled === true},profileId),
  });
  async function gmail(action, profileId) {
    const response = await fetch('/api/gmail/desktop/' + action, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1', 'X-Nemo-Profile': profileId }, body: '{}' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Synthetic Gmail action failed.');
    return { opened: true, synthetic: true };
  }
  window.nemoShell = Object.freeze({connectGmail: id => gmail('start', id), cancelGmail: id => gmail('cancel', id)});
})();`;
const css = '.fixture-status{flex:none;padding:8px 16px;background:#fff1e5;color:#84401c;border-bottom:1px solid #ead5c3;font:12px/1.5 system-ui;text-align:center}.fixture-status strong{font-weight:600}';
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const json = (res, status, value) => { res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

/** directory is an optional parent directory; every run gets a fresh child. */
export async function startUnifiedPreview({ directory } = {}) {
  const parent = resolve(directory || join(root, '.work/unified-desktop'));
  await mkdir(parent, { recursive: true });
  const runDir = await mkdtemp(join(parent, 'synthetic-'));
  const dataDir = join(runDir, 'data'), publicDir = join(runDir, 'public');
  await cp(join(root, 'public'), publicDir, { recursive: true });
  const html = await readFile(join(publicDir, 'desktop.html'), 'utf8');
  await writeFile(join(publicDir, 'desktop.html'), html
    .replace('<head>', '<head><script src="/__preview/bridge.js" defer></script><link rel="stylesheet" href="/__preview/preview.css">')
    .replace('<body>', '<body><aside class="fixture-status" role="note"><strong>Synthetic desktop preview</strong> · Simulated setup, ChatGPT and Windows settings · Fictional data</aside>'));

  let installed = false, connected = false, activeAccountId = '', startAtLogin = false, bootstrapOpen = true, assistantProvider = 'chatgpt';
  let origin = '', appOrigin = '', capability = '', closing;
  const accounts = [], calls = [], providerCalls = [];
  const assistantStatus = () => {
    if (assistantProvider === 'local') return { provider: 'ollama', localOnly: true, connected, phase: connected ? 'connected' : 'unavailable', message: 'Synthetic local Gemma is available.', planUsageEnabled: false, planUsageAcknowledged: true, confirmationRequired: false };
    const account = accounts.find(value => value.id === activeAccountId);
    return { provider: 'chatgpt', connected, planUsageEnabled: connected,
      phase: connected ? 'connected' : 'disconnected', activeAccountId: connected ? activeAccountId : '',
      confirmationRequired: connected && account?.acknowledged !== true,
      planUsageAcknowledged: connected && account?.acknowledged === true,
      account: connected && account ? { id: account.id, label: account.label } : null,
      accounts: accounts.map(value => ({ id: value.id, label: value.label, selected: connected && value.id === activeAccountId, connected: connected && value.id === activeAccountId })),
    };
  };
  const provider = {
    status: () => ({ connected: installed && connected, verified: installed && connected, inferenceProvider: assistantProvider === 'local' ? 'ollama' : 'chatgpt', planUsageEnabled: assistantProvider === 'chatgpt' && installed && connected, model: 'Synthetic preview' }),
    async run(input) {
      providerCalls.push({ profileId: input.profileId });
      await delay(350, undefined, { signal: input.signal });
      const text = 'Here’s a simple plan for Saturday:\n\n**Morning**\n- Take a walk together.\n- Choose somewhere for lunch.\n\n**Afternoon**\nLeave room for whatever everyone feels like doing.\n\nThis is a simulated reply for the desktop preview.';
      for (const part of text.match(/[\s\S]{1,40}/g) || []) { input.onText?.(part); await delay(35, undefined, { signal: input.signal }); }
      return { text };
    },
  };
  const app = await createFamilyServer({ dataDir, publicDir, ownerName: 'Owner', memoryFactory: null, provider, logger() {},
    async integrationsForProfile(_profile, { dataDir: personalDirectory }) {
      let gmailConnected = false;
      return { calendar: await createCalendarStore({ dataDir: personalDirectory }),
        gmail: {
          async status() { return { connected: gmailConnected, configured: true, ...(gmailConnected ? { account: 'synthetic@example.test' } : {}) }; },
          async desktopConfiguration() { return { available: true }; },
          async syncStatus() { return { mode: 'demand', count: 0 }; },
          async phoneConfiguration() { return { available: false, redirectUri: '', reason: 'This preview uses simulated desktop Google sign-in.' }; },
          async disconnect() { gmailConnected = false; return { connected: false }; },
          async beginDesktopAuthorization({ stillAuthorized, commit }) {
            let timer, reject;
            const completed = new Promise((resolve, fail) => {
              reject = fail;
              timer = setTimeout(() => { void commit(async () => { if (!await stillAuthorized()) throw new Error('Synthetic sign-in cancelled.'); gmailConnected = true; }).then(resolve, fail); }, 6000);
            });
            completed.catch(() => {});
            return { authorizationUrl: 'https://accounts.google.com/synthetic-preview', completed, async cancel() { clearTimeout(timer); reject(new Error('Synthetic sign-in cancelled.')); } };
          },
          async close() {},
        },
        gbrain: new Proxy({}, { get() { throw new Error('The synthetic fixture must not access a real Memory service.'); } }),
      };
    },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  appOrigin = 'http://127.0.0.1:' + app.server.address().port;
  const remoteHost = {
    status: () => ({ phase: 'not-configured', available: false, canPair: false, connected: false, publicOrigin: '', account: { state: 'signed-out' }, message: 'External phone access is not connected in this local synthetic preview.' }),
    async beginEnrollment() { fail(503, 'PREVIEW_ONLY', 'This preview does not connect a remote account.'); },
    async pollEnrollment() { return { state: 'signed-out' }; },
    async enable() { fail(503, 'PREVIEW_ONLY', 'External phone access is not connected in this preview.'); },
    async disable() { return this.status(); },
  };
  const setup = await createHostSetupServer({ dataDir, profiles: app.profiles, remoteHost, assetsDir: publicDir,
    runtimeStatus: async () => ({ ready: installed, installed, available: true, connected, state: installed ? 'ready' : 'not-installed', assistant: assistantStatus() }),
    appStatus: async () => ({ ready: true, assistantConnected: connected, origin }),
    runtimeSetup: async input => { if (Object.keys(input).length) fail(400, 'PREVIEW_INPUT', 'Use the displayed prepare button.'); installed = true; return { ready: true, synthetic: true }; },
    assistantSetup: async input => {
      if (!installed) fail(409, 'PREVIEW_INPUT', 'Prepare the synthetic assistant first.');
      if (Object.keys(input).some(key => !['provider', 'action', 'accountId', 'retry'].includes(key))) fail(400, 'PREVIEW_INPUT', 'Use the displayed synthetic account action.');
      if (input.provider === 'local') { assistantProvider = 'local'; connected = true; return assistantStatus(); }
      if (input.provider === 'chatgpt') assistantProvider = 'chatgpt';
      const action = input.action;
      if (action === 'acknowledge') { const account = accounts.find(value => value.id === activeAccountId); if (!connected || !account) fail(409, 'PREVIEW_INPUT', 'Connect the synthetic account first.'); account.acknowledged = true; }
      else if (action === 'signout') connected = false;
      else if (action === 'select') { if (!accounts.some(account => account.id === input.accountId)) fail(404, 'PREVIEW_INPUT', 'Synthetic account not found.'); activeAccountId = input.accountId; connected = true; }
      else if (!action || action === 'new') {
        if (!activeAccountId || action === 'new') { const index = accounts.length + 1; activeAccountId = 'synthetic-account-' + index; accounts.push({ id: activeAccountId, label: index === 1 ? 'demo@synthetic.invalid' : `demo${index}@synthetic.invalid`, acknowledged: false }); }
        connected = true;
      } else fail(400, 'PREVIEW_INPUT', 'Synthetic account action not found.');
      return { connected, synthetic: true };
    },
    localInvite: async profileId => { const invitation = await app.profiles.invite(profileId, 'synthetic-desktop', { ttlMs: 300_000 }); return { url: origin + '/pair.html#invite=' + invitation.code, profile: invitation.profile, expiresAt: invitation.expiresAt }; },
  });
  capability = new URLSearchParams(new URL(setup.bootstrapUrl).hash.slice(1)).get('setup');
  async function privateRequest(action, input = {}) { return setupRequest({ origin: setup.origin, token: capability, action, input }); }
  async function currentSession(req) {
    const response = await fetch(appOrigin + '/api/session', { headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {}, cache: 'no-store', redirect: 'error' });
    if (!response.ok) fail(403, 'PREVIEW_ACCESS', 'Open your personal synthetic profile first.');
    return response.json();
  }
  async function readInput(req) {
    if (req.headers['x-nemo-request'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(403, 'PREVIEW_ACCESS', 'Use the preview’s named app controls.');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16_384) fail(413, 'PREVIEW_INPUT', 'Preview action is too large.'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'PREVIEW_INPUT', 'Preview action is unreadable.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['input', 'profileId', 'documentPath'].includes(key)) || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) fail(400, 'PREVIEW_INPUT', 'Use a named preview action.');
    return value;
  }
  const proxy = http.createServer(async (req, res) => {
    Object.entries(securityHeaders).forEach(([key, value]) => res.setHeader(key, value));
    try {
      if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) fail(403, 'PREVIEW_ACCESS', 'Use this local synthetic preview.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) fail(403, 'PREVIEW_ACCESS', 'Use this preview origin.');
      if (url.pathname === '/__preview/bridge.js' || url.pathname === '/__preview/preview.css') {
        if (!['GET', 'HEAD'].includes(req.method) || url.search) fail(404, 'PREVIEW_ROUTE', 'Preview asset not found.');
        const javascript = url.pathname.endsWith('.js'); res.writeHead(200, { 'content-type': javascript ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); return res.end(req.method === 'HEAD' ? '' : javascript ? bridge : css);
      }
      if (url.pathname.startsWith('/__preview/setup/')) {
        const action = url.pathname.slice('/__preview/setup/'.length);
        if (req.method !== 'POST' || url.search || !Object.hasOwn(ACTIONS, action) && !EXTRA_ACTIONS.has(action) || action === 'localInvite') fail(404, 'PREVIEW_ROUTE', 'Preview action not found.');
        const value = await readInput(req), boot = BOOT_PATHS.has(value.documentPath);
        if (!boot && value.documentPath !== '/desktop.html') fail(403, 'PREVIEW_ACCESS', 'Use the synthetic desktop document.');
        if (!boot || !bootstrapOpen) { const session = await currentSession(req); if (!session.authenticated || session.profile?.role !== 'owner' || session.profile.id !== value.profileId) fail(403, 'PREVIEW_ACCESS', 'The signed-in family owner manages this PC.'); }
        calls.push(action);
        if (action === 'loginGet') return json(res, 200, startAtLogin);
        if (action === 'loginSet') { if (Object.keys(value.input).length !== 1 || typeof value.input.enabled !== 'boolean') fail(400, 'PREVIEW_INPUT', 'Choose the simulated startup setting.'); startAtLogin = value.input.enabled; return json(res, 200, startAtLogin); }
        if (action === 'manageUsage') return json(res, 200, { opened: true, synthetic: true });
        if (action === 'openLocal') {
          if (Object.keys(value.input).length) fail(400, 'PREVIEW_INPUT', 'Use Continue as shown in the preview.');
          const result = await privateRequest('localInvite'); const target = new URL(result.url); target.pathname = '/desktop.html'; bootstrapOpen = false;
          return json(res, 200, { opened: true, destination: target.href, profile: result.profile });
        }
        return json(res, 200, await privateRequest(action, value.input));
      }
      if (url.pathname.startsWith('/__preview/') || url.pathname.startsWith('/api/setup/')) fail(404, 'PREVIEW_ROUTE', 'This preview route is not available.');
      const targetOrigin = BOOT_PATHS.has(url.pathname) ? setup.origin : appOrigin;
      const headers = {};
      for (const name of ['accept', 'content-type', 'x-nemo-request', 'x-nemo-profile', 'cookie']) if (req.headers[name]) headers[name] = req.headers[name];
      if (req.headers.origin) headers.origin = targetOrigin;
      if (req.headers['sec-fetch-site']) headers['sec-fetch-site'] = 'same-origin';
      const body = !['GET', 'HEAD'].includes(req.method) ? req : undefined;
      const upstream = await fetch(targetOrigin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(120_000), ...(body ? { body, duplex: 'half' } : {}) });
      const responseHeaders = {};
      for (const name of ['content-type', 'cache-control', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'content-security-policy']) if (upstream.headers.has(name)) responseHeaders[name] = upstream.headers.get(name);
      const cookies = upstream.headers.getSetCookie?.() || (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      if (upstream.headers.has('location')) { const location = new URL(upstream.headers.get('location'), targetOrigin); responseHeaders.location = [setup.origin, appOrigin].includes(location.origin) ? origin + location.pathname + location.search + location.hash : location.href; }
      res.writeHead(upstream.status, responseHeaders); return res.end(req.method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 503, { code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'PREVIEW_FAILED', error: error.status && error.status < 500 ? error.message : 'The synthetic preview could not finish this action.' });
    }
  });
  proxy.requestTimeout = 15_000; proxy.headersTimeout = 10_000;
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  origin = 'http://127.0.0.1:' + proxy.address().port;
  const entry = origin + '/setup/';
  async function close() {
    if (closing) return closing;
    closing = (async () => { capability = ''; const stopped = new Promise(done => proxy.close(done)); proxy.closeIdleConnections(); await stopped; await setup.close(); await app.close(); })();
    return closing;
  }
  return { entry, origin, app, setup, proxy, directory: runDir, dataDir, publicDir, calls, providerCalls, synthetic: true, close,
    state: () => ({ installed, connected, startAtLogin, bootstrapOpen, acknowledgement: assistantStatus().planUsageAcknowledged, synthetic: true, realModelCalled: false }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startUnifiedPreview();
  const record = { origin: fixture.origin, entry: fixture.entry, interface: fixture.origin + '/desktop.html', dataDir: fixture.directory, synthetic: true, realModelCalled: false };
  await writeFile(join(root, '.work/unified-desktop/active.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void fixture.close().then(() => process.exit(0), () => process.exit(1)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
