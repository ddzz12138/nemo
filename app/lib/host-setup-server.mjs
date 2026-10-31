import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './profile-store.mjs';

// First launch and everyday chat use the same compiled interface. This listener
// remains private: serving its presentation assets does not grant setup access.
// The old HTML address stays as an alias for local CLI links already in use.
const ASSETS = {
  '/desktop.html': ['desktop.html', 'text/html; charset=utf-8'],
  '/host-setup.html': ['desktop.html', 'text/html; charset=utf-8'],
  '/desktop-ui.js': ['desktop-ui.js', 'text/javascript; charset=utf-8'],
  '/desktop-ui.css': ['desktop-ui.css', 'text/css; charset=utf-8'],
  '/identity.js': ['identity.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const forbidden = () => fail(403, 'SETUP_ACCESS', 'Open setup from Nemo on this computer.');
const unavailable = async () => fail(503, 'SETUP_UNAVAILABLE', 'This step is not included in this Nemo release yet.');

/** A separate capability-authenticated listener. Never publish its port. */
export async function createHostSetupServer({ dataDir, profiles, remoteHost, runtimeStatus = async () => ({ ready: false, state: 'not-installed', message: 'Nemo’s assistant is not installed yet.' }), appStatus = async () => ({ ready: false }), runtimeSetup = unavailable, assistantSetup = unavailable, localInvite = unavailable, assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public'), capabilityToken = randomBytes(32).toString('base64url'), qrDataUrl } = {}) {
  if (!profiles || !remoteHost || !dataDir || typeof capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(capabilityToken)) throw new Error('Nemo could not start private setup.');
  if (!qrDataUrl) qrDataUrl = async url => { const { default: QRCode } = await import('qrcode'); return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: 320 }); };
  const ownerMarker = join(dataDir, 'host-setup.json');
  let origin = '', authority = '', mutationChain = Promise.resolve(), closing = false, closePromise;
  const mutate = operation => { const next = mutationChain.catch(() => {}).then(operation); mutationChain = next.then(() => {}, () => {}); return next; };
  const bearerMatches = request => {
    const value = request.headers.authorization;
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
    const token = value.slice(7);
    const bytes = Buffer.from(token), expected = Buffer.from(capabilityToken);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
  function send(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
  async function input(request) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) fail(415, 'SETUP_JSON', 'Nemo setup expects a private app request.');
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 16_384) fail(413, 'SETUP_INPUT', 'This setup request is too large.'); chunks.push(chunk); }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'SETUP_INPUT', 'Nemo could not read this setup request.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'SETUP_INPUT', 'Nemo could not read this setup request.');
    return result;
  }
  async function status() {
    const [owner, list, runtime, app, marker] = await Promise.all([profiles.owner(), profiles.profiles(), runtimeStatus(), appStatus(), readJson(ownerMarker, null)]);
    // A previously paired owner is migration evidence for releases that did not
    // record completion. Provider disconnection must not reset finished setup.
    const setupCompleted = marker?.completed === true || (await profiles.devices(owner.id)).length > 0;
    const remote = remoteHost.status();
    return { setupCompleted, owner: { ...owner, configured: marker?.ownerNameSet === true || owner.name !== 'Owner' }, profiles: list, runtime, app, remote: { ...remote, canPair: remote.canPair === true && runtime.ready === true && runtime.connected !== false && app.ready === true && app.assistantConnected !== false }, enrollment: remote.account?.state === 'pending' ? { ...remote.account } : null };
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (closing) fail(503, 'SETUP_CLOSING', 'Nemo is closing.');
      // Bind+Host prevents remote ingress and DNS rebinding. Capability auth is
      // independently required because a connector also appears as loopback.
      if (request.headers.host !== authority || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) forbidden();
      if (request.headers.origin && request.headers.origin !== origin) forbidden();
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) forbidden();
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.search) forbidden();
      const asset = ASSETS[['/', '/setup', '/setup/'].includes(url.pathname) ? '/desktop.html' : url.pathname];
      if (asset && ['GET', 'HEAD'].includes(request.method)) {
        let bytes; try { bytes = await readFile(join(assetsDir, asset[0])); } catch { fail(503, 'SETUP_ASSETS', 'Nemo setup is missing from this installation. Please reinstall the app.'); }
        response.writeHead(200, { 'content-type': asset[1] }); return response.end(request.method === 'HEAD' ? '' : bytes);
      }
      if (!url.pathname.startsWith('/api/setup/')) fail(404, 'SETUP_NOT_FOUND', 'This setup page was not found.');
      if (!bearerMatches(request)) forbidden();
      if (request.method === 'GET' && url.pathname === '/api/setup/status') return send(response, 200, await status());
      if (request.method !== 'POST') fail(405, 'SETUP_METHOD', 'This setup action is not available.');
      if (request.headers.origin !== origin) forbidden();
      const body = await input(request);
      if (closing) fail(503, 'SETUP_CLOSING', 'Nemo is closing.');
      const value = await mutate(async () => {
        if (url.pathname === '/api/setup/owner') {
          const owner = await profiles.owner();
          const marker = await readJson(ownerMarker, null);
          const renamed = await profiles.rename(owner.id, body.name);
          await writeJson(ownerMarker, { version: 1, ownerNameSet: true, completed: marker?.completed === true });
          return { owner: { ...renamed, configured: true } };
        }
        if (url.pathname === '/api/setup/enroll' || url.pathname === '/api/setup/enroll/start') return remoteHost.beginEnrollment({ displayName: (await profiles.owner()).name });
        if (url.pathname === '/api/setup/enroll/poll') return remoteHost.pollEnrollment();
        if (url.pathname === '/api/setup/remote/enable') return remoteHost.enable();
        if (url.pathname === '/api/setup/remote/disable') return remoteHost.disable();
        if (url.pathname === '/api/setup/runtime' || url.pathname === '/api/setup/runtime/install') return runtimeSetup(body);
        if (url.pathname === '/api/setup/assistant') return assistantSetup(body);
        if (url.pathname === '/api/setup/local-invite') {
          const current = await status();
          const assistant = current.assistant || current.runtime.assistant;
          const confirmation = assistant?.connected === true && (assistant.confirmationRequired === true || assistant.planUsageAcknowledged === false);
          if (!current.app.ready || confirmation || !current.setupCompleted && (!current.runtime.ready || current.runtime.connected === false || current.app.assistantConnected === false)) fail(409, 'ASSISTANT_NOT_READY', 'Finish connecting your assistant before opening chat.');
          const invitation = await localInvite(current.owner.id);
          await writeJson(ownerMarker, { version: 1, ownerNameSet: current.owner.configured, completed: true });
          return invitation;
        }
        if (url.pathname === '/api/setup/invite') {
          const current = await status();
          if (!current.remote.canPair) fail(409, 'PHONE_NOT_READY', 'Finish connecting Nemo before adding your phone.');
          const profileId = body.profileId || current.owner.id;
          const invitation = await profiles.invite(profileId, 'desktop-setup', { ttlMs: 10 * 60_000 });
          const url = `${current.remote.publicOrigin}/pair.html#invite=${encodeURIComponent(invitation.code)}`;
          return { url, expiresAt: invitation.expiresAt, profile: invitation.profile, qrDataUrl: await qrDataUrl(url) };
        }
        fail(404, 'SETUP_NOT_FOUND', 'This setup action was not found.');
      });
      send(response, 200, value);
    } catch (error) {
      if (response.headersSent) return response.end();
      // Never echo raw cloud/process failures or request bodies (model keys,
      // enrollment secrets and invitation codes can otherwise reach logs/UI).
      const code = typeof error?.code === 'string' && /^[A-Z_]{3,50}$/.test(error.code) ? error.code : 'SETUP_FAILED';
      const safe = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
      send(response, safe ? error.status : 503, { error: safe ? error.message : 'Nemo could not finish this step. Please try again.', code });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  authority = `127.0.0.1:${server.address().port}`; origin = `http://${authority}`;
  return { origin, bootstrapUrl: `${origin}/setup/#setup=${capabilityToken}`, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const stopped = new Promise(resolveClose => server.close(resolveClose));
      server.closeIdleConnections();
      await mutationChain;
      server.closeIdleConnections();
      await stopped;
    })();
    return closePromise;
  } };
}
