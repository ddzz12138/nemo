import http from 'node:http';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { createProfileStore, DEVICE_MS, publicProfile } from './profile-store.mjs';
import { createNemoServer as createPersonalGateway } from './personal-gateway.mjs';
import { createHermesProvider } from './hermes.mjs';
import { capabilitySnapshot } from './capabilities.mjs';
import { validatePublicOrigin } from './config.mjs';
import { createExecutionSlots } from './execution-slots.mjs';
import { createPasskeys } from './passkeys.mjs';
import { canUseCapability, connectionToolNames, mayReviewChild, policyRevision } from './family-policy.mjs';
import { readNativeReview } from './native-chat.mjs';
import {serveNativeStream} from './native-stream.mjs';
import { publicPlanUsage } from './provider-errors.mjs';
import { createPhoneDispatch } from './phone-link-dispatch.mjs';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
export async function createFamilyServer({ dataDir, publicDir, provider, integrationsForProfile, memoryFactory, publicOrigin = '', hermesOptions = {}, nativeFactory, phoneLinkFactory, phoneLinkOptions = {}, now = Date.now, logger = console.log, ownerName = 'Owner', installationId = '', trustedProxy = '' }) {
  publicOrigin = validatePublicOrigin(publicOrigin);
  if (installationId && !/^[a-f0-9-]{36}$/.test(installationId)) throw new Error('Invalid installation identity.');
  if (!['', 'cloudflare'].includes(trustedProxy)) throw new Error('Unsupported Nemo proxy configuration.');
  const store = await createProfileStore({ dataDir, now, ownerName });
  const passkeys = createPasskeys({ store, publicOrigin, now });
  const resources=createExecutionSlots();let native=null;
  try{native=await nativeFactory?.({dataDir,getProfile:id=>store.profile(id),isDeviceActive:(deviceId,profileId)=>store.deviceActive(deviceId,profileId),connectionsForProfile:async id=>(await context(await store.profile(id))).nativeConnections(),legacyHistoryForProfile:async id=>(await context(await store.profile(id))).exportHistoryForNative(),deleteLegacyHistory:async(id,conversationId,messages)=>(await context(await store.profile(id))).retireHistory(conversationId,messages),onReply:async input=>(await context(await store.profile(input.profileId))).captureNativeMemory(input),resources,now})||null;}catch{logger(JSON.stringify({event:'native_preview_unavailable'}));}
  const statusProvider = provider || createHermesProvider({ ...hermesOptions, dataDir });
  const contexts = new Map(); const pendingContexts = new Map(); const attempts = new Map();
  let workerActive = false; let closing = false;let closingTask;
  const jobs = [],eventStreams=new Set();
  function next() {
    if (workerActive || closing || !jobs.length) return;
    const job = jobs.shift(); job.input.signal?.removeEventListener('abort', job.cancel);
    if (job.input.signal?.aborted) { job.reject(new Error('Request stopped.')); return next(); }
    workerActive = true;
    Promise.resolve().then(async () => {
      const current = await store.profile(job.input.profileId);
      if (!current || current.disabled || (current.childModeRevision || 0) !== job.input.childModeRevision || (current.childMode === true) !== job.input.childMode || job.input.signal?.aborted) throw new Error('Profile settings changed. Send your message again.');
      const release=await resources.acquire({kind:'cloud',signal:job.input.signal});
      try{const latest=await store.profile(job.input.profileId);if(!latest||latest.disabled||(latest.childModeRevision||0)!==job.input.childModeRevision||(latest.childMode===true)!==job.input.childMode||(latest.policyRevision||0)!==(job.input.policyRevision||0)||job.input.signal?.aborted)throw new Error('Profile settings changed. Send your message again.');const allowedConnectionTools=connectionToolNames(latest,{memoryEnabled:!!memoryFactory});if(job.input.useIntegrations&&!allowedConnectionTools.length)fail(403,'TOOL_PERMISSION','Your family owner needs to enable a connected tool for this profile.');return await job.provider.run({...job.input,allowedConnectionTools,permissionRevision:policyRevision(latest)});}finally{release();}
    }).then(job.resolve, job.reject).finally(() => { workerActive = false; next(); });
  }
  function queuedRun(agent, input) {
    if (closing || input.signal?.aborted) return Promise.reject(new Error('Request stopped.'));
    if (jobs.length >= 10) return Promise.reject(new Error('The PC is busy. Try again shortly.'));
    return new Promise((resolveJob, reject) => {
      const job = { provider: agent, input, resolve: resolveJob, reject, cancel() { const index = jobs.indexOf(job); if (index >= 0) { jobs.splice(index, 1); reject(new Error('Request stopped.')); } } };
      jobs.push(job); input.signal?.addEventListener('abort', job.cancel, { once: true }); next();
    });
  }
  async function context(profile) {
    if (contexts.has(profile.id)) { const app = contexts.get(profile.id); await app.refreshProfile(); return app; }
    if (pendingContexts.has(profile.id)) return pendingContexts.get(profile.id);
    const pending = (async () => {
      const directory = store.directory(profile.id);
      const integrations = await integrationsForProfile?.(profile, { dataDir: directory, configDir: dataDir });
      const agent = provider || createHermesProvider({ ...hermesOptions, dataDir: directory, family: true, memoryEnabled: !!memoryFactory, profileId: profile.id });
      const app = await createPersonalGateway({ dataDir: directory, publicDir, now, logger,
        profile: { ...profile, configDir: dataDir }, memoryFactory, publicOrigin,resources,
        validateDevice: id => store.deviceActive(id, profile.id),
        resolveProfile: () => store.profile(profile.id),
        onCalendarToken: token => store.recordCalendarToken(profile.id, token),
        onConnectionsChanged:()=>{void native?.invalidate(profile.id).catch(()=>logger(JSON.stringify({event:'native_context_invalidated'})));},nativeBusy:()=>native?.isBusy(profile.id)===true,
        provider: { status: () => agent.status(), run: input => queuedRun(agent, { ...input, profileId: profile.id }) }, integrations });
      if ((await store.profile(profile.id))?.disabled) { await app.close(); fail(403, 'PROFILE_DISABLED', 'This profile is disabled.'); }
      await app.refreshProfile(); contexts.set(profile.id, app); return app;
    })();
    pendingContexts.set(profile.id, pending);
    try { return await pending; } finally { pendingContexts.delete(profile.id); }
  }
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
  async function body(req) {
    if (req.headers['x-nemo-request'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(403, 'REQUEST_HEADERS', 'Use the Nemo app to send this request.');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 32_768) fail(413, 'TOO_LARGE', 'Request is too large.'); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); }
    catch { fail(400, 'INVALID_JSON', 'Request must contain valid JSON.'); }
    if (req.nemoDeviceId && !await store.deviceActive(req.nemoDeviceId, req.headers['x-nemo-profile'])) fail(401, 'AUTH_REQUIRED', 'This device was signed out. Pair it again to continue.');
    return input;
  }
  const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const externalHttps = req => publicOrigin.startsWith('https://') && String(req.headers.host || '').toLowerCase() === new URL(publicOrigin).host.toLowerCase();
  const cookie = (req, token, age = DEVICE_MS / 1000) => `nemo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${externalHttps(req) || (loopback(req) && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}`;
  function pairingKey(req) {
    const external = publicOrigin && String(req.headers.host).toLowerCase() === new URL(publicOrigin).host.toLowerCase();
    if (trustedProxy === 'cloudflare' && external) {
      const address = req.headers['cf-connecting-ip'];
      if (!loopback(req) || typeof address !== 'string' || !isIP(address)) fail(403, 'PROXY', 'Use your saved Nemo address to connect.');
      return `cloudflare:${address}`;
    }
    return req.socket.remoteAddress || 'local';
  }
  function checkPairing(req) {
    const at = now();
    for (const [key, entries] of attempts) if (!entries.some(time => at - time < 300_000)) attempts.delete(key);
    const key = pairingKey(req), recent = (attempts.get(key) || []).filter(time => at - time < 300_000);
    if (recent.length >= 8 || (!attempts.has(key) && attempts.size >= 2048)) fail(429, 'PAIR_RATE_LIMIT', 'Too many pairing attempts. Wait five minutes.');
    return { key, recent };
  }
  const isOwner = auth => { if (auth.profile.role !== 'owner') fail(403, 'OWNER_REQUIRED', 'Only the owner can manage the family.'); };
  const canManage = (auth, id) => { if (auth.profile.id !== id) isOwner(auth); };
  async function revokeDevice(device) {
    await store.revoke(device.id);
    await contexts.get(device.profileId)?.revokeDevice(device.id);
    await native?.cancelDevice(device.profileId,device.id);
  }
  const server = http.createServer(async (req, res) => {
    req.nemoPublicOrigin = publicOrigin;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) fail(503, 'CLOSING', 'Nemo is restarting.');
      const host = req.headers.host || '';
      if ((!publicOrigin || host.toLowerCase() !== new URL(publicOrigin).host.toLowerCase()) && !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) fail(403, 'HOST', 'Unrecognized host.');
      const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
      if (req.method === 'GET' && path === '/oauth/gmail/callback') {
        for (const app of contexts.values()) if (app.hasOAuthState(url.searchParams.get('state'))) return app.server.emit('request', req, res);
        fail(403, 'GMAIL_OAUTH_STATE', 'This Google sign-in expired. Return to Nemo and try again.');
      }
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin).origin; } catch { fail(403, 'ORIGIN', 'Invalid request origin.'); }
        const expected = publicOrigin && host.toLowerCase() === new URL(publicOrigin).host.toLowerCase() ? publicOrigin : `http://${host}`;
        if (origin !== expected) fail(403, 'ORIGIN', 'Request must come from this Nemo app.');
      }
      if (req.method === 'GET' && path === '/.well-known/nemo-host' && installationId) {
        const challenge = url.searchParams.get('challenge');
        if (!/^[a-f0-9]{32,128}$/.test(challenge || '')) fail(400, 'CHALLENGE', 'This connection check expired.');
        return json(res, 200, { service: 'nemo', installationId, challenge });
      }
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, service: 'nemo', profiles: true });
      const token = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('nemo_session='))?.slice(13);
      const linked = phoneDispatch.accept(req);
      const auth = linked ? await store.authenticateDevice(linked.deviceId) : await store.authenticate(token);
      if (linked) {
        if (!auth) fail(401, 'AUTH_REQUIRED', 'This phone was signed out. Ask for a new invitation.');
        req.headers['x-nemo-profile'] = auth.profile.id;
        req.nemoPhoneLink = true;
      }
      if (req.method === 'GET' && path === '/api/session') {
        const status = statusProvider.status();
        return json(res, 200, { authenticated: !!auth, provider: 'Hermes', connected: !!status.connected, ...(auth ? { profile: publicProfile(auth.profile), device: { id: auth.device.id, name: auth.device.name, expiresAt: auth.device.expiresAt }, model: status.model || '', connectionMode: 'readonly-mcp', memoryMode: memoryFactory ? 'profile-gbrain' : 'chat-history', ...publicPlanUsage(status) } : {}) });
      }
      if (req.method === 'POST' && ['/api/pair', '/api/pair/preview'].includes(path)) {
        if (auth && path === '/api/pair') fail(409, 'ALREADY_PAIRED', 'Sign out before pairing a different profile.');
        const input = await body(req); const { key, recent } = checkPairing(req);
        let result;
        try { result = path === '/api/pair/preview' ? await store.previewInvite(input.code) : await store.redeem(input.code, input.deviceName || 'Personal browser', input.expectedProfileId); }
        catch (error) { attempts.set(key, [...recent, now()]); throw error; }
        if (path === '/api/pair/preview') return json(res, 200, result);
        attempts.delete(key);
        return json(res, 200, { authenticated: true, profile: result.profile, device: result.device }, { 'Set-Cookie': cookie(req, result.token) });
      }
      if (path.startsWith('/api/passkeys/authentication/')) {
        const result = await passkeys.handle(req, path, auth, await body(req));
        return json(res, 200, result.body, { 'Set-Cookie': [result.cookie, ...(result.sessionToken ? [cookie(req, result.sessionToken)] : [])] });
      }
      if (req.method === 'POST' && path === '/api/calendar/import') {
        const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
        const profile = await store.calendarProfile(bearer);
        if (!profile) fail(401, 'CALENDAR_AUTH', 'Calendar upload credential is invalid or expired.');
        if (!canUseCapability(profile,'calendar')) fail(403,'TOOL_PERMISSION','The family owner needs to enable Calendar for this profile.');
        return (await context(profile)).server.emit('request', req, res);
      }
      if (path.startsWith('/api/')) {
        if (!auth) fail(401, 'AUTH_REQUIRED', 'Pair this device with your personal invitation to continue.');
        if ((req.headers['x-nemo-profile'] && req.headers['x-nemo-profile'] !== auth.profile.id) || (!['GET', 'HEAD'].includes(req.method) && !req.headers['x-nemo-profile'])) fail(409, 'PROFILE_CHANGED', 'The signed-in profile changed. Reload Nemo before continuing.');
        req.nemoDeviceId = auth.device.id;
        if (path.startsWith('/api/phone-link/')) {
          if (!phoneLink) fail(503, 'LINK_UNAVAILABLE', 'Built-in phone access is unavailable in this installation.');
          isOwner(auth);
          if (req.nemoPhoneLink) fail(403, 'LINK_LOCAL_SETUP', 'Change phone connection settings on the host.');
          if (req.method === 'GET' && path === '/api/phone-link/status') return json(res, 200, phoneLink.status());
          if (req.method !== 'POST') fail(405, 'METHOD', 'Use the phone connection controls.');
          const input = await body(req);
          if (path === '/api/phone-link/configure') return json(res, 200, await phoneLink.configure(input));
          if (path === '/api/phone-link/enable' || path === '/api/phone-link/disable') {
            if (Object.keys(input).length) fail(400, 'LINK_INPUT', 'Use the phone connection controls.');
            return json(res, 200, await phoneLink[path.endsWith('/enable') ? 'enable' : 'disable']());
          }
          if (path === '/api/phone-link/invitations') {
            if (Object.keys(input).some(key => key !== 'profileId') || typeof input.profileId !== 'string') fail(400, 'LINK_INPUT', 'Choose a family profile.');
            const invitation = await phoneLink.invite(input.profileId);
            const { default: QRCode } = await import('qrcode');
            return json(res, 201, { ...invitation, qrDataUrl: await QRCode.toDataURL(invitation.url, { errorCorrectionLevel: 'M', margin: 4, width: 320 }) });
          }
          fail(404, 'NOT_FOUND', 'Phone connection control not found.');
        }
        if (req.method === 'GET' && path === '/api/family/review-log') return json(res,200,{events:await store.parentalReviewLog(auth.profile.id)});
        const reviewRoute=/^\/api\/family\/review\/([a-f0-9-]{36})\/(history|memory)(?:\/(main|native)\/([a-f0-9-]{36}))?$/.exec(path);
        if(reviewRoute){
          isOwner(auth);if(req.method!=='GET'||!req.headers['x-nemo-profile'])fail(403,'PARENTAL_REVIEW','Use the read-only family review screen.');
          const [,childId,kind,source,conversationId]=reviewRoute,child=await store.profile(childId);
          if(!mayReviewChild(auth.profile,child))fail(403,'PARENTAL_REVIEW','Visible review is not enabled for this child profile.');
          if(kind==='memory'&&conversationId)fail(404,'PARENTAL_REVIEW','Review view not found.');
          const childApp=await context(child),revision=policyRevision(child);
          const data=kind==='memory'?await childApp.reviewMemory():conversationId?source==='native'?await readNativeReview({dataDir,profileId:childId,id:conversationId}):await childApp.history(conversationId):{conversations:[...(await childApp.history()).slice(0,100).map(item=>({...item,source:'main'})),...(await readNativeReview({dataDir,profileId:childId})).conversations]};
          await store.recordParentalReview(auth.profile.id,childId,kind,revision);
          if(!await store.deviceActive(auth.device.id,auth.profile.id))fail(401,'AUTH_REQUIRED','This device was signed out.');
          return json(res,200,{...data,review:{readOnly:true,child:{id:child.id,name:child.name},kind}});
        }
        if (path.startsWith('/api/passkeys/registration/')) {
          const result = await passkeys.handle(req, path, auth, await body(req));
          return json(res, 200, result.body, { 'Set-Cookie': result.cookie });
        }
        if (path === '/api/passkeys' && req.method === 'GET') return json(res, 200, { passkeys: await store.passkeys(auth.profile.id), configured: !!publicOrigin || /^localhost(?::\d+)?$/.test(host) });
        if (path === '/api/passkeys/remove' && req.method === 'POST') {
          const input = await body(req); if (Object.keys(input).length !== 1 || typeof input.id !== 'string') fail(400, 'PASSKEY_INPUT', 'Choose one of your own passkeys.');
          const result = await store.revokePasskey(auth.profile.id, input.id);
          for (const device of result.revokedDevices) await revokeDevice(device);
          const signedOut = result.revokedDevices.some(device => device.id === auth.device.id);
          return json(res, 200, { ok: true, signedOut }, signedOut ? { 'Set-Cookie': cookie(req, '', 0) } : {});
        }
        if(path.startsWith('/api/native/')){
          if(req.method==='GET'&&path==='/api/native/status')return json(res,200,native?native.status(auth.profile.id):{available:false,verified:false,preview:true,tools:0});
          if(!native)fail(503,'NATIVE_SETUP','The host has not enabled the chat preview. Continue in the main chat.');
          if(req.method==='GET'&&path==='/api/native/events'){
            if(!req.headers['x-nemo-profile'])fail(409,'PROFILE_CHANGED','Reload Nemo to confirm the profile for live updates.');
            if(!native.changes)fail(503,'NATIVE_EVENTS','Live updates are unavailable. Read saved tasks instead.');
            if(eventStreams.size>=64||[...eventStreams].filter(controller=>controller.deviceId===auth.device.id).length>=4)fail(429,'NATIVE_STREAM_LIMIT','Close another live Nemo tab before reconnecting. Saved tasks remain available.');
            const controller=new AbortController();controller.deviceId=auth.device.id;eventStreams.add(controller);
            try{return await serveNativeStream({req,res,after:url.searchParams.get('after')||req.headers['last-event-id'],signal:controller.signal,authorize:()=>!closing&&store.deviceActive(auth.device.id,auth.profile.id),readChanges:after=>native.changes(auth.profile.id,after)});}finally{eventStreams.delete(controller);}
          }
          if(req.method==='GET'&&path==='/api/native/tasks')return json(res,200,await native.list(auth.profile.id));
          if(req.method==='POST'&&path==='/api/native/tasks'){const input=await body(req);if(Object.keys(input).some(key=>!['requestKey','message','conversationId'].includes(key)))fail(400,'NATIVE_INPUT','Send only the message, conversation and request ID.');return json(res,202,await native.submit(auth.profile.id,{...input,deviceId:auth.device.id}));}
          if(req.method==='GET'&&path==='/api/native/history')return json(res,200,await native.history(auth.profile.id,{query:url.searchParams.get('query')||''}));
          if(req.method==='POST'&&path==='/api/native/history/import'){const input=await body(req);if(Object.keys(input).length)fail(400,'NATIVE_INPUT','Use the History import control.');return json(res,200,await native.migrateHistory(auth.profile.id));}
          if(req.method==='POST'&&path==='/api/native/conversations'){const input=await body(req);if(Object.keys(input).length)fail(400,'NATIVE_INPUT','Use New conversation.');return json(res,201,await native.newConversation(auth.profile.id));}
          const conversationRoute=/^\/api\/native\/conversations\/([a-f0-9-]{36})(?:\/(rename|delete-preview|delete|undo-preview|undo|branch|usage))?$/.exec(path);
          if(conversationRoute){const [,id,action]=conversationRoute;if(req.method==='GET'&&!action)return json(res,200,await native.conversation(auth.profile.id,id));if(req.method==='GET'&&action==='usage')return json(res,200,await native.usage(auth.profile.id,id));if(req.method==='POST'&&action){const input=await body(req),keys={rename:['title','revision'],'delete-preview':[],delete:['token','revision'],'undo-preview':[],undo:['token','revision'],branch:['requestKey','revision']}[action];if(!keys||Object.keys(input).some(key=>!keys.includes(key)))fail(400,'NATIVE_INPUT','Use the displayed conversation control.');const handler={rename:'renameConversation','delete-preview':'deleteConversationPreview',delete:'deleteConversation','undo-preview':'undoConversationPreview',undo:'undoConversation',branch:'branchConversation'}[action];return json(res,200,await native[handler](auth.profile.id,id,input));}}
          const taskRoute=/^\/api\/native\/tasks\/([a-f0-9-]{36})(\/(?:stop|extend|answer))?$/.exec(path);
          if(taskRoute&&req.method==='GET'&&!taskRoute[2])return json(res,200,await native.get(auth.profile.id,taskRoute[1]));
          if(taskRoute&&req.method==='POST'&&taskRoute[2]){const input=await body(req);if(taskRoute[2]==='/answer'){if(Object.keys(input).some(key=>!['questionId','answers'].includes(key)))fail(400,'NATIVE_INPUT','Answer only the displayed questions.');return json(res,200,await native.answer(auth.profile.id,taskRoute[1],{...input,deviceId:auth.device.id}));}if(Object.keys(input).length)fail(400,'NATIVE_INPUT','Use the displayed task control.');return json(res,200,taskRoute[2]==='/extend'?await native.extend(auth.profile.id,taskRoute[1],{deviceId:auth.device.id}):await native.stop(auth.profile.id,taskRoute[1]));}
          fail(404,'NATIVE_ROUTE','Preview operation not found.');
        }
        if (req.method === 'GET' && path === '/api/capabilities') return json(res, 200, capabilitySnapshot({ profile: auth.profile, provider: statusProvider.status(), readiness: {...await (await context(auth.profile)).capabilityReadiness(),native:native?.status(auth.profile.id)} }));
        if (path.startsWith('/api/memory') && !req.headers['x-nemo-profile']) fail(409, 'PROFILE_CHANGED', 'Reload Memory to confirm your signed-in profile.');
        if (req.method === 'GET' && path === '/api/profiles') { isOwner(auth); return json(res, 200, { profiles: await store.profiles() }); }
        if (req.method === 'POST' && path === '/api/profiles') { isOwner(auth); const input = await body(req); return json(res, 201, { profile: await store.create(input.name, input.childMode === undefined ? false : input.childMode) }); }
        const profileRoute = /^\/api\/profiles\/([a-f0-9-]{36})\/(rename|disabled|invites|devices|child-mode|classification|capabilities|parental-review)$/.exec(path);
        if (profileRoute) {
          const [, id, action] = profileRoute; canManage(auth, id);
          if (req.method === 'GET' && action === 'devices') return json(res, 200, { devices: await store.devices(id), currentDeviceId: auth.device.id });
          if (req.method === 'POST') {
            const input = await body(req);
            if(action==='capabilities'||action==='parental-review'){
              isOwner(auth);if(action==='capabilities'&&(Object.keys(input).length!==2||!Object.hasOwn(input,'capability')||!Object.hasOwn(input,'enabled'))||action==='parental-review'&&(Object.keys(input).length!==1||!Object.hasOwn(input,'enabled')))fail(400,'PROFILE_INPUT','Use the displayed family permission controls.');
              const profile=action==='capabilities'?await store.setCapability(id,input.capability,input.enabled):await store.setParentalReview(id,input.enabled);
              await contexts.get(id)?.refreshProfile();await native?.invalidate(id);return json(res,200,{profile});
            }
            if (action === 'classification') {
              isOwner(auth);
              if (Object.keys(input).length !== 1) fail(400, 'PROFILE_INPUT', 'Choose Adult or Child.');
              const profile = await store.classify(id, input.classification);
              await contexts.get(id)?.refreshProfile();
              await native?.invalidate(id);
              return json(res, 200, { profile: publicProfile(profile) });
            }
            if (action === 'child-mode') {
              isOwner(auth);
              if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') fail(400, 'PROFILE_INPUT', 'Choose whether to enable Child mode.');
              const profile = await store.setChildMode(id, input.enabled);
              await contexts.get(id)?.refreshProfile();
              await native?.invalidate(id);
              return json(res, 200, { profile: publicProfile(profile) });
            }
            if (action === 'invites') return json(res, 201, await store.invite(id, auth.device.id));
            if (action === 'rename') { const profile = await store.rename(id, input.name); contexts.get(id)?.updateName(profile.name); return json(res, 200, { profile }); }
            if (action === 'disabled') {
              isOwner(auth); if (typeof input.disabled !== 'boolean') fail(400, 'PROFILE_INPUT', 'Choose whether to disable this profile.');
              const profile = await store.disable(id, input.disabled);
              if(input.disabled)await native?.invalidate(id);
              if (input.disabled) { const app = contexts.get(id); if (app) { await app.disable(); await app.close(); contexts.delete(id); } }
              return json(res, 200, { profile });
            }
          }
        }
        if (req.method === 'GET' && path === '/api/devices') return json(res, 200, { devices: await store.devices(auth.profile.id), currentDeviceId: auth.device.id });
        const deviceRoute = /^\/api\/devices\/([a-f0-9-]{36})\/revoke$/.exec(path);
        if (req.method === 'POST' && deviceRoute) {
          await body(req); let device;
          const profiles = auth.profile.role === 'owner' ? await store.profiles() : [auth.profile];
          for (const profile of profiles) device ||= (await store.devices(profile.id)).find(item => item.id === deviceRoute[1]);
          if (!device) fail(404, 'DEVICE_NOT_FOUND', 'Device not found.');
          await revokeDevice(device); return json(res, 200, { ok: true }, device.id === auth.device.id ? { 'Set-Cookie': cookie(req, '', 0) } : {});
        }
        if (req.method === 'POST' && path === '/api/logout') { await body(req); await revokeDevice(auth.device); return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); }
        const capability=path.startsWith('/api/gmail')?'gmail':path.startsWith('/api/calendar')?'calendar':path.startsWith('/api/memory')?'memory':path.startsWith('/api/leave')?'reminders':null;
        if(capability&&!canUseCapability(auth.profile,capability))fail(403,'TOOL_PERMISSION','Your family owner can enable this tool in Family.');
        if (path.startsWith('/api/memory') && !memoryFactory) fail(410, 'MEMORY_DEFERRED', 'Saved memory is not connected. Your private conversations are available in History.');
        const app = await context(auth.profile);
        if(req.method==='GET'&&path==='/api/tasks'){
          const main=(await app.tasks()).map(task=>({...task,source:'main'}));let nativeTasks=[],nativeTasksAvailable=!!native?.list,notice=null;
          if(nativeTasksAvailable)try{nativeTasks=(await native.list(auth.profile.id)).tasks.map(task=>({id:task.id,source:'native',conversationId:task.conversationId,title:task.message.slice(0,160),status:task.phase==='complete'?'completed':task.phase,phase:task.phase,reason:task.reason,createdAt:task.createdAt,activity:task.activity,canStop:['queued','running','waiting'].includes(task.phase),canExtend:task.phase==='paused'&&task.reason==='budget',...(task.question?{question:task.question}:{}),...(task.questionHistory?{questionHistory:task.questionHistory}:{}),...(task.plan?{plan:task.plan}:{})}));}catch{nativeTasksAvailable=false;notice='Some tasks could not be loaded. Reconnect before retrying work.';logger(JSON.stringify({event:'native_tasks_unavailable'}));}
          if(!await store.deviceActive(auth.device.id,auth.profile.id))fail(401,'AUTH_REQUIRED','This device was signed out.');
          return json(res,200,{tasks:[...main,...nativeTasks].sort((a,b)=>b.createdAt-a.createdAt).slice(0,70),nativeTasksAvailable,nativeBackgroundReady:false,...(notice?{notice}:{})});
        }
        if (req.method === 'POST' && ['/api/conversations/new', '/api/conversations/open'].includes(path)) {
          const input = await body(req), opening = path.endsWith('/open');
          const keys = opening ? ['fromConversationId', 'conversationId'] : ['fromConversationId'];
          const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
          if (Object.keys(input).length !== keys.length || keys.some(key => !uuid(input[key])) || Object.keys(input).some(key => !keys.includes(key))) fail(400, 'CONVERSATION_INPUT', 'Choose a chat from your Nemo sidebar.');
          return json(res, 200, await app.changeConversation(input, auth.device.id));
        }
        if (req.method === 'GET' && path === '/api/history') {
          const main=await app.history(),nativeHistory=native?.history?await native.history(auth.profile.id,{query:url.searchParams.get('query')||''}):{conversations:[]},query=url.searchParams.get('query')||'';
          if(query.length>300)fail(400,'HISTORY_SEARCH','Search with up to 300 characters.');const legacy=[];
          for(const item of main){if(nativeHistory.conversations.some(row=>row.status!=='deleting'&&row.legacyId===item.id&&row.legacyContentHash===item.contentHash))continue;const haystack=query?JSON.stringify((await app.history(item.id)).messages).toLocaleLowerCase():'';if(!query||query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word=>haystack.includes(word)))legacy.push({...item,source:'main'});}
          return json(res,200,{conversations:[...legacy,...nativeHistory.conversations].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),nativeHistory:!!native?.history,disclosure:'Saved Memory and private backups are managed separately from active chat history.'});
        }
        const historyRoute = /^\/api\/history\/([a-f0-9-]{36})(\/clear)?$/.exec(path);
        if (historyRoute) {
          if (req.method === 'GET' && !historyRoute[2]) return json(res, 200, await app.history(historyRoute[1]));
          if (req.method === 'POST' && historyRoute[2]) { await body(req); await app.clearHistory(historyRoute[1]); return json(res, 200, { ok: true }); }
        }
        return app.server.emit('request', req, res);
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD', 'Method not allowed.');
      // Keep the Memory destination stable even before its engine is available.
      // The page can explain setup; silently redirecting to History looks broken.
      let decoded; try { decoded = decodeURIComponent(path); } catch { fail(400, 'PATH', 'Invalid path.'); }
      const file = resolve(publicDir, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (!file.startsWith(resolve(publicDir) + sep)) fail(404, 'NOT_FOUND', 'Not found.');
      try { if (!(await stat(file)).isFile()) throw new Error(); const content = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content); }
      catch { fail(404, 'NOT_FOUND', 'Not found.'); }
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!error.status) logger(JSON.stringify({ event: 'request_failed', name: error.name }));
      json(res, error.status || 500, { error: error.status ? error.message : 'The PC could not complete this request. Try again.', code: error.code || 'REQUEST_FAILED' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
  const phoneDispatch = createPhoneDispatch({ server, now });
  const phoneLink = phoneLinkFactory ? await phoneLinkFactory({ dataDir, profiles: store, dispatch: input => phoneDispatch.dispatch(input), now, ...phoneLinkOptions }) : null;
  // Start private services for enabled profiles so their scheduled jobs survive
  // logout and work without an open browser.
  for (const profile of await store.profiles()) if (!profile.disabled) { try { await context(profile); } catch (error) { logger(JSON.stringify({ event: 'profile_unavailable', profileId: profile.id, name: error.name })); } }
  return { server, profiles: store, phoneLink,
    close() { if(closingTask)return closingTask;closing = true;for(const controller of eventStreams)controller.abort();passkeys.close();phoneDispatch.close(); for (const job of jobs.splice(0)) job.reject(new Error('Nemo is restarting.'));closingTask=(async()=>{const results=await Promise.allSettled([phoneLink?.close(),native?.close(),...[...contexts.values()].map(app=>app.close())]);resources.close();server.closeIdleConnections();await new Promise(done=>server.close(done));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;})();return closingTask; },
  };
}
