import http from 'node:http';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHermesProvider } from './hermes.mjs';
import { createSchoolNoticeWorkflow, noticeArguments, SchoolNoticeError } from './school-notice.mjs';
import { createCalendarStore } from './calendar.mjs';
import { createGmailClient, GmailError } from './gmail.mjs';
import { createGmailOnboarding } from './gmail-onboarding.mjs';
import { createGmailDesktopOnboarding, isLocalGmailRequest } from './gmail-desktop.mjs';
import { buildToolConnectionPrompt, stringifyConnectionData,connectionTools,createConnectionToolRunner } from './connections.mjs';
import { createLeaveService, handleLeaveRequest } from './leave.mjs';
import { GbrainError, createConfiguredGbrainClient } from './gbrain.mjs';
import { MemoryError, createMemoryController } from './memory.mjs';
import { createMemoryMirror } from './memory-mirror.mjs';
import { canUseCapability, connectionToolNames,policyRevision } from './family-policy.mjs';
import { createActivity, recordActivity, publicActivity, interruptActivity } from './activity.mjs';
import { publicChatGPTError, publicPlanUsage } from './provider-errors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_MS = 24 * 60 * 60 * 1000;
const CONSENT_VERSION = 3;
const consentActive = session => session.contextConsent === true && session.consentVersion === CONSENT_VERSION;
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

class RequestError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createNemoServer({ dataDir = join(ROOT, '.nemo'), publicDir = join(ROOT, 'public'), provider, pairingCode, now = () => Date.now(), logger = console.log, integrations, profile, validateDevice, resolveProfile, onCalendarToken, memoryFactory, resources,publicOrigin = '',onConnectionsChanged=()=>{},nativeBusy=()=>false } = {}) {
  await mkdir(dataDir, { recursive: true });
  provider ||= createHermesProvider({ cwd: ROOT, dataDir, family: !!profile });
  const calendar = integrations?.calendar || await createCalendarStore({ dataDir, now });
  let leave;
  try {
    let tfnswKey = integrations?.tfnswKey || process.env.NEMO_TFNSW_API_KEY || '';
    if (!tfnswKey) { try { tfnswKey = (await readFile(join(profile?.configDir || dataDir, 'tfnsw-api-key.txt'), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') tfnswKey = ''; } }
    leave = integrations?.leave || await createLeaveService({ dataDir, now, calendar, fetchImpl: integrations?.tfnswFetch, apiKey: tfnswKey, ...(profile ? { isDeviceActive: validateDevice } : {}) });
  } catch { leave = { async status() { throw Object.assign(new Error('Trip reminders are unavailable.'), { status: 503, code: 'LEAVE_STORE' }); }, async revokeOwner() {} }; }
  const gmail = integrations?.gmail || await createGmailClient({ dataDir, configDir: profile?.configDir || dataDir, now });
  const schoolNotice = createSchoolNoticeWorkflow({ gmail, now });
  const statePath = join(dataDir, 'state.json');
  const pairingPath = join(dataDir, 'pairing-code.txt');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Nemo state could not be read. Preserve .nemo/state.json and inspect it before restarting.');
    state = { version: 1, pairingHash: '', sessions: {}, runs: {} };
  }
  if (state.version !== 1 || !state.sessions || !state.runs) throw new Error('Unsupported Nemo state.');
  let code = pairingCode;
  if (profile && !state.sessions[profile.id]) state.sessions[profile.id] = { conversationId: randomUUID(), expiresAt: Number.MAX_SAFE_INTEGER, messages: [], requestIds: {}, activeRunId: null, hermesSessionId: null, contextConsent: false, consentVersion: 0 };
  if (!profile && !code) { try { code = (await readFile(pairingPath, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (!/^\d{8}$/.test(code || '')) code = String(randomInt(10_000_000, 100_000_000));
  state.pairingHash = hash(code);
  if (!profile) await writeFile(pairingPath, `${code}\n`, { mode: 0o600 });
  let saveChain = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(state);
    saveChain = saveChain.catch(() => {}).then(async () => {
      const tmp = `${statePath}.tmp`;
      for (let attempt = 0; ; attempt++) {
        try { await writeFile(tmp, snapshot, { mode: 0o600 }); await rename(tmp, statePath); return; }
        catch (error) {
          // Windows scanners can briefly lock a newly written file. Retry only
          // transient access/lock failures, and preserve genuine disk errors.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
    });
    return saveChain;
  }
  for (const run of Object.values(state.runs)) if (['queued', 'running'].includes(run.status)) {
    run.status = 'failed'; run.text = ''; run.error = 'The PC restarted before this reply completed. Send a new message to try again.'; run.finishedAt = now();
  }
  for (const session of Object.values(state.sessions)) session.activeRunId = null;
  // Activity survives reconnects, but work is never silently replayed on restart.
  for (const run of Object.values(state.runs)) {
    interruptActivity(run.activity, now());
    const message=state.sessions[run.owner]?.messages.find(item=>item.id===run.assistantMessageId || item.id===run.userMessageId&&item.activity);
    if(message&&run.activity)message.activity=publicActivity(run.activity);
  }
  if (profile) {
    const session = state.sessions[profile.id];
    if ((session.childModeRevision || 0) !== (profile.childModeRevision || 0) || (session.childMode === true) !== (profile.childMode === true)) session.hermesSessionId = null;
    session.childModeRevision = profile.childModeRevision || 0; session.childMode = profile.childMode === true;
  }
  await save();
  function assertIdle() {
    if (Object.values(state.sessions).some(item => item.activeRunId)||nativeBusy()) throw new MemoryError(409, 'Wait for the current reply before changing memory.', 'RUN_ACTIVE');
  }
  function getChat(owner) {
    const session = state.sessions[owner];
    const messages = session?.messages || [];
    const runs = Object.values(state.runs).filter(run => run.owner === owner);
    const content = messages.map(message => `${message.role}: ${message.text}`).join('\n').slice(0, 32_000);
    return {
      count: messages.length, content,
      revision: hash(JSON.stringify({ messages: messages.map(message => [message.id, message.text]), runs: runs.map(run => [run.id, run.status, run.message]), session: session?.hermesSessionId || null })),
      createdAt: messages[0]?.createdAt || null, updatedAt: messages.at(-1)?.createdAt || null,
    };
  }
  async function clearChat(owner) {
    const session = state.sessions[owner];
    if (!session) return;
    const requests = new Set(Object.values(session.requestIds || {}));
    session.messages = [];
    session.requestIds = {};
    session.hermesSessionId = null;
    if (session.activeRunId) session.activeRunId = null;
    for (const [id, run] of Object.entries(state.runs)) if (run.owner === owner && (!profile || run.conversationId === session.conversationId || requests.has(id))) delete state.runs[id];
    await save();
  }
  let memory = { async list() { throw new MemoryError(503, 'Memory is not available.', 'MEMORY_UNAVAILABLE'); }, async get() { throw new MemoryError(503, 'Memory is not available.', 'MEMORY_UNAVAILABLE'); }, async save() { throw new MemoryError(503, 'Memory is not available.', 'MEMORY_UNAVAILABLE'); }, async preview() { throw new MemoryError(503, 'Memory is not available.', 'MEMORY_UNAVAILABLE'); }, async remove() { throw new MemoryError(503, 'Memory is not available.', 'MEMORY_UNAVAILABLE'); } };
  const memoryConfirmations=new Map();
  let gbrain = null; let engine = { connected: false }; let memoryConnection;
  let mirror = { status: () => ({ sources: { gmail: false, calendar: false }, configured: false }), async clear() {}, async sync() {}, async syncAll() {}, async configure() {} };
  if (!profile || memoryFactory) try {
    if (profile) {
      memoryConnection = await memoryFactory({ profileId: profile.id, profileDataDir: dataDir, configDir: profile.configDir, calendar, gmail, getChat, clearChat, assertIdle, now, logger,resources });
      ({ gbrain, mirror, engine } = memoryConnection); memory = memoryConnection.controller;
    } else {
      gbrain = integrations?.gbrain || await createConfiguredGbrainClient({ nemoDataDir: dataDir });
      mirror = await createMemoryMirror({ dataDir, gbrain, gmail, calendar, now });
      engine = await gbrain.status();
      memory = createMemoryController({ calendar, gbrain, getChat, clearChat, assertIdle, mirror, now });
    }
  } catch (error) { event('memory_unavailable', { name: error.name }); }
  let gate = Promise.resolve();
  function turn(operation) {
    const run = gate.catch(() => {}).then(operation);
    gate = run.then(() => {}, () => {});
    return run;
  }
  let mirrorTask = null;
  function beginMirrorSync(source) {
    if (profile && (!canUseCapability(profile,'memory') || !canUseCapability(profile,'gmail'))) return;
    if (mirrorTask || Object.values(state.sessions).some(item => item.activeRunId)) return;
    mirrorTask = turn(async () => { assertIdle(); if (source && source !== 'all') return mirror.sync(source); await mirror.syncAll(); if (!source && engine?.embedding === 'local-ollama') await gbrain?.indexPending?.(); }).catch(() => event('memory_mirror_failed', { code: 'MEMORY_MIRROR' })).finally(() => { mirrorTask = null; });
  }
  async function changeConnections(){if(profile){const session=state.sessions[profile.id];session.connectionRevision=(session.connectionRevision||0)+1;await save();onConnectionsChanged();}}
  async function prepareGmailAccountChange(){
    assertIdle();
    try{await mirror.clear('gmail');}catch{throw new GmailError('GMAIL_MEMORY_CLEANUP','Nemo could not clear previous Gmail memory copies. Restore local Memory access and clear those copies before changing Google accounts.');}
    await changeConnections();
  }
  const gmailOnboarding = createGmailOnboarding({ gmail, now, commitAccountChange: operation => turn(async () => { await prepareGmailAccountChange(); return operation(); }), isAuthorized: owner => profile ? !state.sessions[profile.id].activeRunId && validateDevice(owner) : !!state.sessions[owner] && state.sessions[owner].expiresAt > now() && !Object.values(state.sessions).some(item => item.activeRunId) });
  const desktopGmail = createGmailDesktopOnboarding({ gmail, now,
    isAuthorized: async owner => {
      if (closing || Object.values(state.sessions).some(item => item.activeRunId) || nativeBusy()) return false;
      if (!profile) return !!state.sessions[owner] && state.sessions[owner].expiresAt > now();
      const current = resolveProfile ? await resolveProfile() : profile;
      return !!current && !current.disabled && canUseCapability(current, 'gmail') && await validateDevice(owner);
    },
    commit: operation => turn(async () => {
      await prepareGmailAccountChange();
      const result = await operation();
      for (const item of Object.values(state.sessions)) item.hermesSessionId = null;
      await save(); return result;
    }),
  });
  let gmailSyncTask = null;
  function beginGmailSync(due = false) {
    if (profile && !canUseCapability(profile,'gmail')) return;
    if (!gmailSyncTask && gmail.syncNow) {
      gmailSyncTask = Promise.resolve().then(() => due ? gmail.syncIfDue() : gmail.syncNow()).then(async () => { if (mirror.status().sources.gmail) await turn(async () => { assertIdle(); await mirror.sync('gmail'); }); }).catch(error => event('gmail_sync_failed', { code: error instanceof GmailError ? error.code : 'GMAIL_SYNC' })).finally(() => { gmailSyncTask = null; });
    }
  }
  const attempts = new Map();
  const chatRates = new Map();
  let calendarImports = [];
  const queue = [];
  let active = 0;
  let closing = false;
  const controllers = new Set();
  const draining=new Set();
  const policyChanged = 'Child mode settings changed. Send your message again to continue.';
  async function refreshProfile() {
    if (!profile || !resolveProfile) return;
    return turn(async () => {
      const current = await resolveProfile();
      if (!current || current.disabled) throw new RequestError(403, 'This profile is unavailable.', 'PROFILE_DISABLED');
      const changed = (profile.childModeRevision || 0) !== (current.childModeRevision || 0) || (profile.policyRevision || 0) !== (current.policyRevision || 0) || (profile.childMode === true) !== (current.childMode === true);
      Object.assign(profile, current);
      if (!changed) return;
      memoryConfirmations.clear();
      if (!canUseCapability(profile,'memory')) await memoryConnection?.curation?.configure?.(profile.id,{enabled:false});
      if (!canUseCapability(profile,'gmail')) { gmailOnboarding.cancelAll(); desktopGmail.cancel(); }
      for (const controller of controllers) controller.abort();
      queue.length = 0;
      for (const run of Object.values(state.runs)) if (['queued', 'running'].includes(run.status)) {
        run.status = 'failed'; run.text = ''; run.error = policyChanged; run.finishedAt = now();
        interruptActivity(run.activity,now());
      }
      const session = state.sessions[profile.id];
      session.hermesSessionId = null; session.activeRunId = null;
      session.childModeRevision = profile.childModeRevision || 0; session.childMode = profile.childMode === true;
      await save();
    });
  }
  function event(type, extra = {}) { logger(JSON.stringify({ time: new Date(now()).toISOString(), event: type, ...extra })); }
  function cleanExpiredSessions() {
    for (const [owner, session] of Object.entries(state.sessions)) if (session.expiresAt < now() && !session.activeRunId) {
      delete state.sessions[owner];
      for (const [id, run] of Object.entries(state.runs)) if (run.owner === owner) delete state.runs[id];
    }
  }
  const settlingRuns=new Set();
  const publicRun = run => ({ id: run.id, status:run.status==='completed'&&settlingRuns.has(run.id)?'running':run.status, text: run.text, ...(run.activity?{activity:publicActivity(run.activity)}:{}), ...(run.error ? publicChatGPTError(run.errorCode) || { error: run.error } : {}), createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), source: 'Hermes on this PC' });
  const taskSummaries = owner => Object.values(state.runs).filter(run=>run.owner===owner).sort((a,b)=>b.createdAt-a.createdAt).slice(0,50).map(run=>{const visible=publicRun(run);return{id:run.id,title:run.message.slice(0,160),status:visible.status,createdAt:run.createdAt,activity:visible.activity,canStop:['queued','running'].includes(visible.status)};});
  function activityEvent(run, value) {
    if(state.runs[run.id]!==run)return;
    if(!recordActivity(run.activity,value,now()))return;
    const message=state.sessions[run.owner]?.messages.find(item=>item.id===run.assistantMessageId || run.status==='failed'&&item.id===run.userMessageId);
    if(message)message.activity=publicActivity(run.activity);
    void save().catch(()=>event('activity_write_failed'));
  }
  function drain(){const work=drainOnce();draining.add(work);void work.finally(()=>draining.delete(work)).catch(()=>event('run_shutdown_failed'));return work;}
  async function drainOnce() {
    if (active >= 1 || !queue.length || closing) return;
    const { owner, runId } = queue.shift();
    const session = state.sessions[owner];
    const run = state.runs[runId];
    if (!session || !run || run.status !== 'queued') return void drain();
    active++;
    settlingRuns.add(runId);
    const controller = new AbortController(); controllers.add(controller);
    controller.runId = runId;
    run.status = 'running';
    recordActivity(run.activity,{kind:'run',state:'running'},now());
    const revision = run.childModeRevision || 0;
    const currentPolicy = () => !controller.signal.aborted && run.status === 'running' && (!profile || revision === (profile.childModeRevision || 0));
    try {
      await refreshProfile();
      if (!currentPolicy()) throw new Error(policyChanged);
      await save();
      event('run_started', { runId });
      if (run.useIntegrations && !consentActive(session)) throw new Error('Connection consent changed. Send a new question after checking Connections.');
      const history = session.messages.filter(item => item.id !== run.userMessageId);
      const question = profile ? `SIGNED_IN_PERSON_JSON\n${stringifyConnectionData({ name: profile.name })}\nEND_SIGNED_IN_PERSON_JSON\n\n${run.message}` : run.message;
      const plain = profile && !session.hermesSessionId
        ? `Continue this person's conversation. Earlier messages below are quoted context; answer the current question.\nCHAT_HISTORY_JSON\n${stringifyConnectionData(history.slice(-8).map(item => ({ role: item.role, text: item.text.slice(0, 2000) })))}\nEND_CHAT_HISTORY_JSON\n\n${question}` : question;
      const message = run.useIntegrations ? buildToolConnectionPrompt({ message: question, history, now, memoryEnabled: !profile || !!memoryFactory }) : plain;
      let result;
      if (run.workflow) {
        const authorize = async () => {
          await refreshProfile();
          if (!currentPolicy() || !profile || !canUseCapability(profile, 'gmail') || run.workflowPolicy !== `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}`
              || !await validateDevice(run.deviceId)) throw new Error('This profile, device or Gmail permission changed. Select the notice again.');
          if (provider.status().inferenceProvider !== 'ollama') throw new Error('School briefings require local Gemma. No cloud model was used.');
        };
        const checked = await schoolNotice.run(run.workflow, { authorize, signal: controller.signal,
          activity: (name, state) => activityEvent(run, { kind: 'tool', name, state, key: name }),
          infer: input => provider.run({ ...input, childMode: profile.childMode === true, childModeRevision: revision, policyRevision: profile.policyRevision || 0,
            useIntegrations: false, sessionId: null, signal: controller.signal, onText() {}, onActivity: value => { if (currentPolicy()) activityEvent(run, value); } }) });
        result = checked; run.workflowReceipt = checked.receipt;
      } else result = await provider.run({ message, childMode: profile?.childMode === true, childModeRevision: revision, policyRevision:profile?.policyRevision||0, useIntegrations: !!run.useIntegrations, sessionId: run.useIntegrations ? null : session.hermesSessionId, signal: controller.signal, onActivity: value => {if(currentPolicy())activityEvent(run,value);}, onText: text => { if (currentPolicy()) { activityEvent(run,{kind:'answer',state:'running'}); run.text = (run.text + text).slice(0, 200_000); } } });
      await refreshProfile();
      if (!currentPolicy()) throw new Error(policyChanged);
      if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.trim() === '(empty)') throw new Error('The agent returned no text.');
      run.text = result.text.slice(0, 200_000); run.status = 'completed'; run.finishedAt = now();
      // Never resume a provider session containing previously imported private
      // source material after a later request turns connections off.
      session.hermesSessionId = run.useIntegrations || run.workflow ? null : result.sessionId || session.hermesSessionId;
      recordActivity(run.activity,{kind:'run',state:'completed'},now());
      run.assistantMessageId=randomUUID();
      session.messages.push({ id: run.assistantMessageId, role: 'assistant', text: run.text, createdAt: run.finishedAt, activity:publicActivity(run.activity) });
      event('run_completed', { runId, durationMs: run.finishedAt - run.createdAt });
    } catch (error) {
      const recovery = publicChatGPTError(error);
      run.status = 'failed'; run.text = ''; run.error = recovery?.error || error.message || 'The agent could not reply.'; run.finishedAt = now();
      if (recovery) run.errorCode = recovery.errorCode;
      activityEvent(run,{kind:'run',state:'failed'});
      event('run_failed', { runId });
    } finally {
      if (session.activeRunId === runId) session.activeRunId = null;
      controllers.delete(controller); active--;
      if(run.status==='completed') {
        if(!run.workflow&&memoryConnection?.curation&&(!profile||canUseCapability(profile,'memory')))memoryConnection.curation.capture({id:run.userMessageId,text:run.message,onActivity:value=>activityEvent(run,value)});
        else activityEvent(run,{kind:'memory',phase:'skipped'});
      }
      await save().catch(() => {event('state_write_failed');if(run.status==='completed'){run.status='failed';run.text='';run.error='The reply could not be saved. Check PC storage before trying again.';session.messages=session.messages.filter(message=>message.id!==run.assistantMessageId);}});
      settlingRuns.delete(runId);
      void drain();
    }
  }
  function json(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); }
  function authenticated(req) {
    if (profile) return { owner: profile.id, session: state.sessions[profile.id] };
    const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('nemo_session='))?.slice('nemo_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const owner = hash(token); const session = state.sessions[owner];
    return session && session.expiresAt > now() ? { owner, session } : null;
  }
  async function body(req, { native = false, limit = 32_768 } = {}) {
    if (native && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(403, 'Calendar sync requires Content-Type: application/json and a JSON events array.', 'REQUEST_HEADERS');
    if ((!native && req.headers['x-nemo-request'] !== '1') || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(403, 'Use the Nemo app to send this request.', 'REQUEST_HEADERS');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new RequestError(413, 'Message is too large.', 'TOO_LARGE'); chunks.push(chunk); }
    if (profile && !native && !await validateDevice(req.nemoDeviceId)) throw new RequestError(401, 'This device is no longer paired.', 'AUTH_REQUIRED');
    if(profile)await refreshProfile();
    assertToolPermission(new URL(req.url,'http://localhost').pathname);
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      if (profile && (Object.hasOwn(parsed, 'profileId') || Object.hasOwn(parsed, 'owner'))) throw new RequestError(400, 'Identity is supplied by your signed-in device.', 'PROFILE_INPUT');
      const path=new URL(req.url,'http://localhost').pathname;
      if(profile&&path.startsWith('/api/memory')&&!canUseCapability(profile,'gmail')){
        const ids=[parsed.id,...(Array.isArray(parsed.ids)?parsed.ids:[])];
        if(ids.some(id=>typeof id==='string'&&id.startsWith('gbrain:nemo-notes/gmail/'))||path==='/api/memory/clear/preview'&&parsed.scope!=='notes')throw new RequestError(403,'Only personal notes are enabled for this profile.','TOOL_PERMISSION');
      }
      return parsed;
    }
    catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(400, 'Request must contain valid JSON.', 'INVALID_JSON'); }
  }
  function assertToolPermission(path){
    const capability=path.startsWith('/api/gmail')?'gmail':path.startsWith('/api/calendar')?'calendar':path.startsWith('/api/memory')?'memory':path.startsWith('/api/leave')?'reminders':null;
    if(profile&&capability&&!canUseCapability(profile,capability))throw new RequestError(403,'Your family owner can enable this tool in Family.','TOOL_PERMISSION');
  }
  function cookie(req, token, age) { const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; return `nemo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`; }
  async function calendarEndpoint(host) {
    if (publicOrigin.startsWith('https://')) return `${publicOrigin}/api/calendar/import`;
    if (/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net(?::443)?$/i.test(host)) return `https://${host}/api/calendar/import`;
    let configured = process.env.NEMO_PRIVATE_URL;
    if (!configured) {
      try { configured = JSON.parse(await readFile(join(profile?.configDir || dataDir, 'connection.json'), 'utf8')).privateUrl; }
      catch (error) { if (error.code !== 'ENOENT') event('private_url_unavailable'); }
    }
    try {
      const url = new URL(configured);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || !/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net(?::443)?$/i.test(url.host)) return '';
      return `${url.origin}/api/calendar/import`;
    } catch { return ''; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      // The gateway binds only loopback. Tailscale Serve provides the approved private hostname.
      if ((!publicOrigin || host.toLowerCase() !== new URL(publicOrigin).host.toLowerCase()) && !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host) && !/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net(?::443)?$/i.test(host)) throw new RequestError(403, 'Unrecognized host.', 'HOST');
      // Google navigates here from another site. The separate Lax cookie,
      // one-use state, exact origin and still-paired owner verify this callback;
      // Nemo's Strict pairing cookie is never weakened for OAuth.
      const callback = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && callback.pathname === '/oauth/gmail/callback') {
        let result;
        try { result = await gmailOnboarding.complete({ params: callback.searchParams, cookies: req.headers.cookie || '', origin: appOrigin(req) }); }
        catch {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Nemo</title><h1>Let’s restart Google sign-in</h1><p>The sign-in expired or returned to a different browser. No account was changed by this callback.</p><p>If Google opened Safari from your Home Screen app, open Nemo in Safari, pair that browser, and start again there.</p><a href="/gmail-connect.html?gmail=browser">Return to Gmail setup in Nemo</a>');
        }
        if (result.result === 'connected') {
          for (const item of Object.values(state.sessions)) item.hermesSessionId = null;
          await save(); beginGmailSync();
        }
        res.writeHead(303, { Location: `/gmail-connect.html?gmail=${result.result}`, 'Set-Cookie': result.cookie });
        return res.end();
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost;
        try { originHost = new URL(origin).host; } catch { throw new RequestError(403, 'Invalid request origin.', 'ORIGIN'); }
        const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        if (originHost !== host && originHost !== forwardedHost) throw new RequestError(403, 'Request must come from this Nemo app.', 'ORIGIN');
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if(profile)await refreshProfile();
      assertToolPermission(path);
      if(profile&&path.startsWith('/api/memory')&&!canUseCapability(profile,'gmail')){
        if((url.searchParams.get('id')||'').startsWith('gbrain:nemo-notes/gmail/'))throw new RequestError(403,'Gmail references are not enabled for this profile.','TOOL_PERMISSION');
        if(path==='/api/memory'){
          if(url.searchParams.has('kind')&&!['all','note'].includes(url.searchParams.get('kind')))throw new RequestError(403,'Only personal notes are enabled for this profile.','TOOL_PERMISSION');
          url.searchParams.set('kind','note');
        }
      }
      const auth = authenticated(req);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, service: 'nemo' });
      if (req.method === 'POST' && path === '/api/calendar/import') {
        const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
        if (!calendar.validToken(token)) throw new RequestError(401, 'Calendar upload credential is invalid or expired. Create a new one in Connections.', 'CALENDAR_AUTH');
        calendarImports = calendarImports.filter(time => now() - time < 60_000);
        if (calendarImports.length >= 10) throw new RequestError(429, 'Calendar sync is limited to ten uploads per minute.', 'CALENDAR_RATE_LIMIT');
        const input = await body(req, { native: true, limit: 131_072 });
        try { calendarImports.push(now()); const result = await calendar.importSnapshot(input, token); beginMirrorSync('calendar'); return json(res, 200, { ok: true, calendar: result }); }
        catch (error) { if (error.status) throw new RequestError(error.status, error.message, 'CALENDAR_IMPORT'); throw error; }
      }
      if (req.method === 'GET' && path === '/api/session') {
        const status = provider.status();
        return json(res, 200, { authenticated: !!auth, provider: 'Hermes', connected: !!status.connected, ...(auth ? { model: status.model || '', mode: status.mode || 'chat-only', connectionMode: 'readonly-mcp', ...publicPlanUsage(status) } : {}) });
      }
      if (req.method === 'POST' && path === '/api/pair') {
        const input = await body(req);
        const ip = req.socket.remoteAddress || 'local';
        const attempt = attempts.get(ip);
        if (attempt && attempt.until > now() && attempt.count >= 8) throw new RequestError(429, 'Too many pairing attempts. Wait five minutes and try again.', 'PAIR_RATE_LIMIT');
        if (typeof input.code !== 'string' || !safeEqual(hash(input.code), state.pairingHash)) {
          const current = attempt && attempt.until > now() ? attempt : { count: 0, until: now() + 300_000 };
          current.count++; attempts.set(ip, current);
          throw new RequestError(401, 'That pairing code is incorrect. Check the Nemo terminal on your PC.', 'PAIR_INVALID');
        }
        cleanExpiredSessions();
        if (Object.keys(state.sessions).length >= 20) throw new RequestError(429, 'This demo has reached its paired-browser limit.', 'SESSION_LIMIT');
        const token = randomBytes(32).toString('hex'); const owner = hash(token);
        state.sessions[owner] = { conversationId: randomUUID(), expiresAt: now() + SESSION_MS, messages: [], requestIds: {}, activeRunId: null, hermesSessionId: null };
        try { await save(); } catch (error) { delete state.sessions[owner]; throw error; }
        event('browser_paired');
        return json(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(req, token, SESSION_MS / 1000) });
      }
      if (path.startsWith('/api/')) {
        if (!auth) throw new RequestError(401, 'Pair this browser with your PC to continue.', 'AUTH_REQUIRED');
        const { owner, session } = auth;
        if (path.startsWith('/api/gmail/')) {
          if (req.method === 'GET' && path === '/api/gmail/connection') {
            await gmail.reload?.();
            return json(res, 200, { gmail: await gmail.status(), desktop: isLocalGmailRequest(req) ? { ...await gmail.desktopConfiguration?.(), ...desktopGmail.status(profile ? req.nemoDeviceId : owner) } : { available: false }, phone: req.nemoPhoneLink ? { available: false, redirectUri: '', reason: 'Your connected Gmail works over this phone connection. Connect or change Google accounts in Nemo on the host; the existing HTTPS sign-in route remains available.' } : await gmail.phoneConfiguration(appOrigin(req)), sync: await gmail.syncStatus(), syncing: !!gmailSyncTask });
          }
          if (req.method === 'POST' && ['/api/gmail/desktop/start', '/api/gmail/desktop/cancel'].includes(path)) {
            if (!isLocalGmailRequest(req)) throw new RequestError(403, 'Connect Gmail in the Nemo app on this PC.', 'GMAIL_DESKTOP_ONLY');
            const input = await body(req);
            if (Object.keys(input).length) throw new RequestError(400, 'No additional fields are needed.', 'GMAIL_INPUT');
            const device = profile ? req.nemoDeviceId : owner;
            if (path.endsWith('/cancel')) { desktopGmail.cancel(device); return json(res, 200, { ok: true }); }
            if (!gmail.beginDesktopAuthorization) throw new RequestError(503, 'Desktop Gmail sign-in is not available in this build.', 'GMAIL_NOT_CONFIGURED');
            const result = await turn(async () => { gmailOnboarding.cancelAll(); return desktopGmail.start(device); });
            return json(res, 200, result);
          }
          if (req.method === 'GET' && path === '/api/gmail/cache') return json(res, 200, await gmail.cachedMessages());
          if (req.method === 'POST' && path === '/api/gmail/oauth/start') {
            if(req.nemoPhoneLink) throw new RequestError(409,'Connect or change this profile’s Google account in Nemo on the host. Existing connected Gmail remains available on your phone.','LINK_GMAIL_ONBOARDING');
            const input = await body(req);
            if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'mode')) throw new RequestError(400, 'Choose only a Gmail connection type.', 'GMAIL_INPUT');
            const flow = await turn(async () => { desktopGmail.cancel(); return gmailOnboarding.start({ owner: profile ? req.nemoDeviceId : owner, origin: appOrigin(req), mode: input.mode }); });
            return json(res, 200, { authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt }, { 'Set-Cookie': flow.cookie });
          }
          if (req.method === 'POST' && ['/api/gmail/mode', '/api/gmail/cache/clear', '/api/gmail/sync'].includes(path)) {
            const input = await body(req);
            const result = await turn(async () => {
              assertIdle();
              if (path === '/api/gmail/mode') {
                if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'mode')) throw new RequestError(400, 'Choose only a Gmail connection type.', 'GMAIL_INPUT');
                if (input.mode === 'demand') await mirror.clear('gmail');
                return gmail.setSyncMode(input.mode);
              }
              if (Object.keys(input).length) throw new RequestError(400, 'No additional fields are needed.', 'GMAIL_INPUT');
              if (path === '/api/gmail/cache/clear') { await mirror.clear('gmail'); return gmail.setSyncMode('demand'); }
              return gmail.syncStatus();
            });
            if (result.mode === 'sync') beginGmailSync();
            return json(res, 200, { ok: true, sync: result, syncing: !!gmailSyncTask });
          }
        }
        if (req.method === 'GET' && path === '/api/integrations') {
          const gmailAllowed=!profile||canUseCapability(profile,'gmail'),calendarAllowed=!profile||canUseCapability(profile,'calendar');
          if(gmailAllowed)await gmail.reload?.();
          return json(res, 200, { calendar: calendarAllowed?calendar.status():{connected:false,restricted:true}, gmail:gmailAllowed?await gmail.status():{connected:false,configured:false,restricted:true}, contextConsent: consentActive(session), consentRenewalRequired: session.contextConsent === true && session.consentVersion !== CONSENT_VERSION,permissions:profile?connectionToolNames(profile,{memoryEnabled:!!memoryFactory}):undefined });
        }
        if (req.method === 'POST' && path === '/api/integrations/consent') {
          const input = await body(req);
          if (typeof input.enabled !== 'boolean') throw new RequestError(400, 'Choose whether to use connections.', 'INVALID_CONSENT');
          if(input.enabled&&profile&&!connectionToolNames(profile,{memoryEnabled:!!memoryFactory}).length)throw new RequestError(403,'Your family owner needs to enable a connected tool before you can share it with Nemo.','TOOL_PERMISSION');
          if (session.activeRunId) throw new RequestError(409, 'Wait for the current reply before changing connection consent.', 'RUN_ACTIVE');
          await turn(async () => {
            if (session.activeRunId) throw new RequestError(409, 'Wait for the current reply before changing connection consent.', 'RUN_ACTIVE');
            const previous = { contextConsent: session.contextConsent, consentVersion: session.consentVersion, hermesSessionId: session.hermesSessionId };
            session.contextConsent = input.enabled;
            session.consentVersion = input.enabled ? CONSENT_VERSION : 0;
            session.hermesSessionId = null;
            try { await save(); } catch (error) { Object.assign(session, previous); throw error; }
            await changeConnections();
          });
          return json(res, 200, { contextConsent: consentActive(session), consentRenewalRequired: false });
        }
        if (req.method === 'POST' && path === '/api/calendar/token') {
          await body(req);
          const token = await calendar.issueToken();
          if (profile) await onCalendarToken(token);
          // Never put capability credentials in a URL. Use the currently approved
          // private hostname so Shortcuts works away from home through Tailscale.
          const endpoint = await calendarEndpoint(host);
          return json(res, 200, { token, endpoint, shortcutName: 'Nemo Sync Calendar', ...(!endpoint ? { setupRequired: true, notice: 'The private phone URL is not configured. Open Nemo through its private Tailscale HTTPS URL and replace this token to copy the phone endpoint. Never use localhost on the iPhone.' } : {}) });
        }
        if (req.method === 'POST' && ['/api/calendar/disconnect', '/api/gmail/disconnect'].includes(path)) {
          await body(req);
          if (Object.values(state.sessions).some(item => item.activeRunId)) throw new RequestError(409, 'Wait for current replies before disconnecting a shared connection.', 'RUN_ACTIVE');
          if (path === '/api/gmail/disconnect') { gmailOnboarding.cancelAll(); desktopGmail.cancel(); }
          const result = await turn(async () => { assertIdle(); if (path === '/api/gmail/disconnect') { gmailOnboarding.cancelAll(); desktopGmail.cancel(); } await mirror.clear(path.includes('/calendar/') ? 'calendar' : 'gmail'); return path.includes('/calendar/') ? calendar.disconnect() : gmail.disconnect(); });
          for (const item of Object.values(state.sessions)) item.hermesSessionId = null;
          await save();
          await changeConnections();
          return json(res, 200, { ok: true, ...result });
        }
        if (req.method === 'POST' && path === '/api/logout') {
          await body(req);
          if (session.activeRunId) throw new RequestError(409, 'Wait for the current reply before disconnecting.', 'RUN_ACTIVE');
          gmailOnboarding.cancelOwner(owner);
          desktopGmail.cancel(owner);
          delete state.sessions[owner]; await save(); await leave.revokeOwner?.(owner);
          return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
        }
        if(path==='/api/memory/board'&&req.method==='GET'){
          if(!memoryConnection?.curation)throw new RequestError(503,'Personal memory is not available.','MEMORY_UNAVAILABLE');
          const board=await memoryConnection.curation.board(owner);if(profile&&!canUseCapability(profile,'gmail'))board.references={gmail:[]};return json(res,200,board);
        }
        if(path==='/api/memory/fact'&&req.method==='GET'){
          if(!memoryConnection?.curation)throw new RequestError(503,'Personal memory is not available.','MEMORY_UNAVAILABLE');
          return json(res,200,await memoryConnection.curation.details(owner,url.searchParams.get('id')||''));
        }
        if(path==='/api/memory/learning'&&req.method==='POST'){
          if(!memoryConnection?.curation)throw new RequestError(503,'Personal memory is not available.','MEMORY_UNAVAILABLE');
          const input=await body(req);return json(res,200,await turn(()=>memoryConnection.curation.configure(owner,input)));
        }
        if(path==='/api/memory/correct'&&req.method==='POST'){
          if(!memoryConnection?.curation)throw new RequestError(503,'Personal memory is not available.','MEMORY_UNAVAILABLE');
          const input=await body(req);return json(res,200,await turn(()=>memoryConnection.curation.correct(owner,input)));
        }
        if (path === '/api/memory/enable' && req.method === 'POST') {
          const input = await body(req); if (Object.keys(input).length) throw new RequestError(400, 'No extra setup fields are needed.', 'MEMORY_QUERY');
          if (!memoryConnection?.enable) throw new RequestError(503, 'Profile memory setup is not available.', 'MEMORY_UNAVAILABLE');
          const result = await turn(async () => { assertIdle(); return memoryConnection.enable(); });
          return json(res, 202, result);
        }
        if (path === '/api/memory/mirror' && req.method === 'GET') return json(res, 200, { ok: true, ...mirror.status(), syncing: !!mirrorTask, engine, ...memoryConnection?.status?.() });
        if (path === '/api/memory/mirror' && req.method === 'POST') {
          const input = await body(req);
          if(input.gmail&&profile&&!canUseCapability(profile,'gmail'))throw new RequestError(403,'Your family owner needs to enable Gmail before copying its references.','TOOL_PERMISSION');
          if (Object.keys(input).length !== 2 || typeof input.gmail !== 'boolean' || input.calendar!==false) throw new RequestError(400, 'Choose the Gmail reference setting. Calendar stays separate.', 'MEMORY_QUERY');
          await turn(async () => { assertIdle(); await mirror.configure(input); }); beginMirrorSync();
          return json(res, 202, { ok: true, ...mirror.status(), syncing: !!mirrorTask });
        }
        if (path === '/api/memory/mirror/sync' && req.method === 'POST') { const input = await body(req); if (Object.keys(input).length) throw new RequestError(400, 'Use the Memory refresh control.', 'MEMORY_QUERY'); beginMirrorSync(); return json(res, 202, { ok: true, syncing: !!mirrorTask }); }
        if (path === '/api/memory/semantic' && req.method === 'GET') {
          const source = url.searchParams.get('source') || 'notes'; const query = url.searchParams.get('query') || '';
          if(source!=='notes'&&profile&&!canUseCapability(profile,'gmail'))throw new RequestError(403,'Gmail references are not enabled for this profile.','TOOL_PERMISSION');
          if (!['notes', 'gmail', 'all'].includes(source) || !query.trim() || query.length > 500) throw new RequestError(400, 'Enter a memory question and choose a source.', 'MEMORY_QUERY');
          if (!gbrain) throw new RequestError(503, 'Memory is not connected.', 'MEMORY_UNAVAILABLE');
          return json(res, 200, { ok: true, ...await gbrain.search({ query, source, limit: 10 }), processing: 'local', model: 'nomic-embed-text' });
        }
        if (path.startsWith('/api/memory')) {
          try {
            const input=req.method==='GET'?null:await body(req);
            if(profile&&path==='/api/memory/delete'&&!memoryConfirmations.has(input?.confirmation))throw new RequestError(409,'Preview this deletion again after profile settings change.','MEMORY_CONFIRMATION');
            const outcome = await memoryResult(memory, turn, { method: req.method, path, url, owner, input });
            if(profile&&outcome?.body?.confirmation){memoryConfirmations.set(outcome.body.confirmation,true);while(memoryConfirmations.size>100)memoryConfirmations.delete(memoryConfirmations.keys().next().value);}
            if(path==='/api/memory/delete')memoryConfirmations.delete(input?.confirmation);
            if (outcome) return json(res, outcome.status, outcome.body);
          } catch (error) {
            if (error instanceof MemoryError || error instanceof GbrainError) throw new RequestError(error.status || 503, error.message, error.code || 'MEMORY');
            throw error;
          }
        }
        if (path.startsWith('/api/leave')) {
          const handled = await handleLeaveRequest(leave, { method: req.method, path, url, owner, deviceId: req.nemoDeviceId, input: req.method === 'GET' ? null : await body(req), origin: appOrigin(req) });
          if (handled) return json(res, handled.status, handled.body);
        }
        if (req.method === 'GET' && path === '/api/tasks') return json(res, 200, { tasks: taskSummaries(owner), nativeBackgroundReady:false });
        const stopTask = /^\/api\/tasks\/([a-f0-9-]{36})\/stop$/i.exec(path);
        if (req.method === 'POST' && stopTask) {
          await body(req);
          const run=state.runs[stopTask[1]];
          if (!run || run.owner !== owner) throw new RequestError(404,'Task not found.','TASK_NOT_FOUND');
          if (['queued','running'].includes(run.status)) {
            await turn(async () => {
              for (const controller of controllers) if (controller.runId === run.id) controller.abort();
              run.status='failed'; run.text=''; run.error='You stopped this task.'; run.finishedAt=now();
              interruptActivity(run.activity,now());
              if (session.activeRunId === run.id) session.activeRunId=null;
              await save();
            });
          }
          return json(res,200,{ok:true,id:run.id,status:run.status});
        }
        if (req.method === 'POST' && path === '/api/gmail/notices/search') {
          const input = await body(req);
          if (!profile || Object.keys(input).some(key => key !== 'query')) throw new RequestError(400, 'Search notices from your signed-in profile.', 'NOTICE_INPUT');
          if (provider.status().inferenceProvider !== 'ollama') throw new RequestError(409, 'Choose local Gemma before using school briefings.', 'NOTICE_LOCAL_ONLY');
          const found = await schoolNotice.search(input.query);
          await refreshProfile(); assertToolPermission(path);
          if (!await validateDevice(req.nemoDeviceId)) throw new RequestError(401, 'This device is no longer signed in.', 'AUTH_REQUIRED');
          return json(res, 200, found);
        }
        if (req.method === 'GET' && path === '/api/conversation') return json(res, 200, { conversationId: session.conversationId, messages: session.messages, ...(session.activeRunId ? { activeRunId: session.activeRunId } : {}) });
        if (req.method === 'POST' && path === '/api/chat') {
          const input = await body(req);
          const workflow = input.workflow === undefined ? null : noticeArguments(input.workflow);
          const currentConversation = () => {
            if (input.conversationId !== undefined && input.conversationId !== session.conversationId) throw new RequestError(409, 'This chat changed. Reopen it from your conversation history before sending.', 'CONVERSATION_CHANGED');
          };
          currentConversation();
          if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8_000 || input.message.includes('\0')) throw new RequestError(400, 'Enter a message between 1 and 8,000 characters.', 'INVALID_MESSAGE');
          if (typeof input.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)) throw new RequestError(400, 'A valid request identifier is required.', 'INVALID_REQUEST_ID');
          if (input.useIntegrations !== undefined && typeof input.useIntegrations !== 'boolean') throw new RequestError(400, 'useIntegrations must be a boolean.', 'INVALID_CONNECTIONS');
          const previousId = session.requestIds[input.requestId];
          if (previousId) {
            const previous = state.runs[previousId];
            if (!previous || previous.message !== input.message.trim() || JSON.stringify(previous.workflow || null) !== JSON.stringify(workflow)) throw new RequestError(409, 'This request identifier was used for a different message or notice.', 'REQUEST_ID_CONFLICT');
            return json(res, 202, { runId: previousId, conversationId: session.conversationId });
          }
          if (profile && archives.some(item => item.requestIds?.[input.requestId])) throw new RequestError(409, 'This message belongs to another chat. Open it from your conversation history.', 'CONVERSATION_CHANGED');
          if (session.activeRunId) throw new RequestError(409, 'Wait for the current reply before sending another message.', 'RUN_ACTIVE');
          if (input.useIntegrations && !consentActive(session)) throw new RequestError(403, session.contextConsent === true ? 'Review Connections and allow calendar, email, and saved notes before including private data.' : 'Enable connection consent in Connections before including private data.', session.contextConsent === true ? 'CONSENT_RENEWAL' : 'CONTEXT_CONSENT');
          const providerStatus = provider.status();
          if (workflow) {
            if (!profile || !canUseCapability(profile, 'gmail')) throw new RequestError(403, 'Gmail needs to be enabled for this profile.', 'TOOL_PERMISSION');
            if (providerStatus.inferenceProvider !== 'ollama') throw new RequestError(409, 'This briefing runs only with local Gemma. No ChatGPT connection is needed.', 'NOTICE_LOCAL_ONLY');
            schoolNotice.validate(workflow);
          }
          if (!providerStatus.connected) {
            const recovery = providerStatus.inferenceProvider === 'chatgpt' ? publicChatGPTError('CHATGPT_SIGN_IN_REQUIRED') : null;
            throw new RequestError(recovery ? 409 : 503, recovery?.error || 'Hermes is not configured on this PC.', recovery?.errorCode || 'PROVIDER_UNAVAILABLE');
          }
          if (!profile && Object.keys(session.requestIds).length >= 100) throw new RequestError(429, 'This demo conversation has reached its message limit. Re-pair to start a new conversation.', 'MESSAGE_LIMIT');
          if (queue.length >= 10) throw new RequestError(429, 'The PC is busy. Please try again shortly.', 'QUEUE_FULL');
          const rates = (chatRates.get(owner) || []).filter(t => now() - t < 60_000);
          if (rates.length >= 10) throw new RequestError(429, 'Please wait before sending more messages.', 'CHAT_RATE_LIMIT');
          rates.push(now()); chatRates.set(owner, rates);
          const id = randomUUID();
          await turn(async () => {
            currentConversation();
            if (session.activeRunId) { rates.pop(); throw new RequestError(409, 'Wait for the current reply before sending another message.', 'RUN_ACTIVE'); }
            // Settings are authoritative, including for older clients that send
            // a per-message flag. Snapshot the grant when accepting this run.
            state.runs[id] = { id, owner, conversationId: session.conversationId, deviceId: req.nemoDeviceId, childModeRevision: profile?.childModeRevision || 0, status: 'queued', message: input.message.trim(), useIntegrations: workflow ? false : consentActive(session), text: '', createdAt: now(), activity:createActivity(id),
              ...(workflow ? { workflow, workflowPolicy: `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}` } : {}) };
            session.requestIds[input.requestId] = id; session.activeRunId = id;
            const acceptedMessage = { id: randomUUID(), role: 'user', text: input.message.trim(), createdAt: now() };
            state.runs[id].userMessageId = acceptedMessage.id;
            session.messages.push(acceptedMessage);
            try { await save(); }
            catch (error) {
              delete state.runs[id]; delete session.requestIds[input.requestId]; session.activeRunId = null;
              session.messages = session.messages.filter(message => message.id !== acceptedMessage.id);
              throw error;
            }
          });
          queue.push({ owner, runId: id });
          json(res, 202, { runId: id, conversationId: session.conversationId });
          void drain(); return;
        }
        const match = path.match(/^\/api\/runs\/([a-f0-9-]{36})$/i);
        if (req.method === 'GET' && match) {
          const run = state.runs[match[1]];
          if (!run || run.owner !== owner) throw new RequestError(404, 'Reply not found in this conversation.', 'RUN_NOT_FOUND');
          return json(res, 200, publicRun(run));
        }
        throw new RequestError(404, 'Endpoint not found.', 'NOT_FOUND');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, 'Method not allowed.', 'METHOD');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw new RequestError(400, 'Invalid path.', 'PATH'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part.startsWith('.'))) throw new RequestError(404, 'Not found.', 'NOT_FOUND');
      const file = resolve(publicDir, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (file !== resolve(publicDir) && !file.startsWith(resolve(publicDir) + sep)) throw new RequestError(404, 'Not found.', 'NOT_FOUND');
      try {
        if (!(await stat(file)).isFile()) throw new Error();
        const content = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { throw new RequestError(404, 'Not found.', 'NOT_FOUND'); }
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof SchoolNoticeError) error = new RequestError(error.status, error.message, error.code);
      if (error instanceof GmailError) error = new RequestError(error.code === 'GMAIL_SYNC_MODE' ? 400 : 503, error.message, error.code);
      if(error instanceof MemoryError||error instanceof GbrainError)error=new RequestError(error.status||503,error.message,error.code||'MEMORY');
      if (!(error instanceof RequestError)) event('request_failed', { name: error.name, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
      json(res, error.status || 500, { error: error instanceof RequestError ? error.message : 'The PC could not complete this request. Please try again.', ...(error.code && error instanceof RequestError ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
  const leaveTimer = setInterval(() => { if(!profile||canUseCapability(profile,'reminders'))void leave.tick?.().catch(error => event('leave_tick_failed', { name: error.name })); }, 30_000);
  leaveTimer.unref?.();
  const gmailTimer = setInterval(() => beginGmailSync(true), 60_000);
  gmailTimer.unref?.();
  const mirrorTimer = setInterval(() => { if (Object.values(mirror.status().sources).some(Boolean)) beginMirrorSync('all'); }, 60_000); mirrorTimer.unref?.();
  // Keep the active chat and its archive in one atomic state snapshot. Import
  // the legacy archive once; retain that file as a migration backup only.
  let archives = [];
  if (profile) {
    archives = state.archivedConversations ?? await readFile(join(dataDir, 'history-archive.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!Array.isArray(archives) || archives.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.messages))) throw new Error('Saved conversations could not be read. Preserve the profile data before repairing it.');
    state.archivedConversations = archives; await save();
  }
  async function saveArchives(next) {
    const previous = archives;
    archives = next; state.archivedConversations = next;
    try { await save(); } catch (error) { archives = previous; state.archivedConversations = previous; throw error; }
  }
  function assertConversationIdle() {
    if (state.sessions[profile.id].activeRunId || [...settlingRuns].some(id => state.runs[id]?.owner === profile.id) || nativeBusy()) throw Object.assign(new Error('Wait for Nemo’s reply before changing chats.'), { status: 409, code: 'RUN_ACTIVE' });
  }
  return {
    server, pairingCode: code, calendar,
    async tasks(){if(!profile)throw new Error('Family task summaries require a trusted profile.');await refreshProfile();return taskSummaries(profile.id);},
    async capabilityReadiness() { const mail = await gmail.status(); return { chat: provider.status().verified === true, gmail: mail.connected === true, calendar: calendar.status().connected === true, memory: engine.connected === true }; },
    hasOAuthState: value => gmailOnboarding.hasState(value),
    updateName: value => { if (profile) profile.name = value; },
    refreshProfile,
    async nativeConnections(){
      await refreshProfile();
      if(!profile)throw new Error('Native connections require a private profile.');
      function selection(){const session=state.sessions[profile.id],names=consentActive(session)?connectionToolNames(profile,{memoryEnabled:!!memoryFactory}):[];return{names,key:hash(JSON.stringify({profile:profile.id,policy:policyRevision(profile),revision:session.connectionRevision||0,names}))};}
      const selected=selection(),runner=createConnectionToolRunner({calendar,gmail,gbrain},{now});
      async function authorized(name,args){await refreshProfile();return !closing&&selected.key===selection().key&&selected.names.includes(name)&&!(name==='memory_search'&&['gmail','all'].includes(args.source)&&!canUseCapability(profile,'gmail'));}
      return{key:selected.key,tools:connectionTools.filter(tool=>selected.names.includes(tool.name)),
        async execute(name,args){if(!await authorized(name,args))throw new RequestError(403,'Connections permission changed.','NATIVE_CONSENT');const result=await runner(name,args);if(!await authorized(name,args))throw new RequestError(403,'Connections permission changed.','NATIVE_CONSENT');return result;}
      };
    },
    async captureNativeMemory({id,text,onActivity}){await refreshProfile();if(memoryConnection?.curation&&canUseCapability(profile,'memory'))memoryConnection.curation.capture({id,text,onActivity});else onActivity?.({kind:'memory',phase:'disabled'});},
    async reviewMemory(){
      if(!memoryConnection?.curation?.board)throw Object.assign(new Error('Personal Memory is not connected for this profile.'),{status:503,code:'MEMORY_UNAVAILABLE'});
      const board=await memoryConnection.curation.board(profile.id),items=board.items.filter(item=>item.status==='active'&&!item.id.startsWith('gbrain:nemo-notes/gmail/')&&!item.id.startsWith('gbrain:nemo-notes/calendar/'));
      const ids=new Set(items.map(item=>item.id)),segments=board.summary.segments.filter(segment=>ids.has(segment.id));return{connected:board.connected,items,hasMore:board.hasMore,summary:{segments,sourceCount:segments.length,totalCount:items.length,truncated:board.hasMore===true}};
    },
    async history(id) {
      const current = state.sessions[profile.id];
      const all = [{ id: current.conversationId, messages: current.messages, active: true }, ...archives];
      if (id) { const item = all.find(item => item.id === id); if (!item) throw Object.assign(new Error('Conversation not found.'), { status: 404, code: 'HISTORY_NOT_FOUND' }); return item; }
      return all.map(item => ({ id: item.id, active: !!item.active, count: item.messages.length,contentHash:hash(JSON.stringify(item.messages.filter(row=>['user','assistant'].includes(row.role)).map(row=>[row.role,row.text]))), title: item.messages.find(message => message.role === 'user')?.text.slice(0, 100) || 'Your conversation', updatedAt: item.messages.at(-1)?.createdAt || null }));
    },
    async changeConversation({ fromConversationId, conversationId }, deviceId) {
      await refreshProfile();
      return turn(async () => {
        if (!await validateDevice(deviceId)) throw Object.assign(new Error('Sign in again to change chats.'), { status: 401, code: 'AUTH_REQUIRED' });
        const current = state.sessions[profile.id];
        if (fromConversationId !== current.conversationId) throw Object.assign(new Error('The current chat changed on another device. Refresh to continue.'), { status: 409, code: 'CONVERSATION_CHANGED' });
        assertConversationIdle();
        const selected = conversationId ? archives.find(item => item.id === conversationId) : null;
        if (conversationId && conversationId !== current.conversationId && !selected) throw Object.assign(new Error('Conversation not found.'), { status: 404, code: 'HISTORY_NOT_FOUND' });
        if (conversationId === current.conversationId || !conversationId && !current.messages.length) return { conversationId: current.conversationId, messages: current.messages };
        const previous = { conversationId: current.conversationId, messages: current.messages, requestIds: current.requestIds, hermesSessionId: current.hermesSessionId };
        const next = archives.filter(item => item.id !== conversationId && item.id !== current.conversationId);
        if (current.messages.length) next.push({ id: current.conversationId, messages: current.messages, requestIds: current.requestIds });
        current.conversationId = selected?.id || randomUUID();
        current.messages = selected?.messages || []; current.requestIds = selected?.requestIds || {};
        // Reconstruct from this chat's messages. An old Hermes session may
        // contain source context whose permission has since been revoked.
        current.hermesSessionId = null;
        try { await saveArchives(next); } catch (error) { Object.assign(current, previous); throw error; }
        return { conversationId: current.conversationId, messages: current.messages };
      });
    },
    async exportHistoryForNative(){
      if(state.sessions[profile.id]?.activeRunId)throw Object.assign(new Error('Wait for the main chat reply before importing History.'),{status:409,code:'RUN_ACTIVE'});
      const current=state.sessions[profile.id],runs=Object.values(state.runs).filter(run=>run.owner===profile.id);
      return[{id:current.conversationId,messages:structuredClone(current.messages),connected:runs.some(run=>run.useIntegrations===true)},...archives.map(item=>({id:item.id,messages:structuredClone(item.messages),connected:true}))];
    },
    async retireHistory(id,expectedContentHash){return turn(async()=>{
      const current=state.sessions[profile.id],item=id===current.conversationId?current:archives.find(item=>item.id===id);
      if(!item)return{ok:true};
      if(current.activeRunId)throw Object.assign(new Error('Wait for the main chat reply before deleting History.'),{status:409,code:'RUN_ACTIVE'});
      // The imported snapshot cannot authorize deleting newer main-chat turns.
      const visible=item.messages.filter(row=>['user','assistant'].includes(row.role)).map(row=>[row.role,row.text]);
      if(visible.length&&hash(JSON.stringify(visible))!==expectedContentHash)throw Object.assign(new Error('The original conversation changed after import. Delete it separately from History.'),{status:409,code:'HISTORY_CHANGED'});
      if(id===current.conversationId){await clearChat(profile.id);current.conversationId=randomUUID();await save();}
      else{await saveArchives(archives.filter(row=>row.id!==id));}return{ok:true};
    });},
    async clearHistory(id) { return turn(async () => {
      const current = state.sessions[profile.id];
      if (current.activeRunId) throw Object.assign(new Error('Wait for the current reply before clearing history.'), { status: 409, code: 'RUN_ACTIVE' });
      if (id === current.conversationId) await clearChat(profile.id);
      else { if (!archives.some(item => item.id === id)) throw Object.assign(new Error('Conversation not found.'), { status: 404 }); await saveArchives(archives.filter(item => item.id !== id)); }
    }); },
    async revokeDevice(id) { gmailOnboarding.cancelOwner(id); desktopGmail.cancel(id); for (const controller of controllers) if (state.runs[controller.runId]?.deviceId === id) controller.abort(); await leave.revokeDevice?.(profile.id, id); },
    async disable() { gmailOnboarding.cancelAll(); desktopGmail.cancel(); await leave.disableOwner?.(profile.id); },
    async close() { closing = true; clearInterval(leaveTimer); clearInterval(gmailTimer); clearInterval(mirrorTimer); gmailOnboarding.cancelAll(); desktopGmail.close(); for (const controller of controllers) controller.abort(); await Promise.allSettled([...draining]);await gmailSyncTask; await mirrorTask; await gate; await memoryConnection?.close?.(); server.closeIdleConnections(); await new Promise(resolveClose => server.close(resolveClose)); await saveChain; }
  };
}

async function memoryResult(memory, turn, { method, path, url, owner, input }) {
  const run = operation => turn(operation);
  if (method === 'GET' && path === '/api/memory') return { status: 200, body: await memory.list(owner, url.searchParams) };
  if (method === 'GET' && path === '/api/memory/item') return { status: 200, body: await memory.get(owner, url.searchParams.get('id') || '') };
  if (method === 'POST' && path === '/api/memory/notes') return { status: 200, body: await run(() => memory.save(owner, input, false)) };
  if (method === 'POST' && path === '/api/memory/edit') return { status: 200, body: await run(() => memory.save(owner, input, true)) };
  if (method === 'POST' && path === '/api/memory/delete/preview') return { status: 200, body: await run(() => memory.preview(owner, input, false)) };
  if (method === 'POST' && path === '/api/memory/clear/preview') return { status: 200, body: await run(() => memory.preview(owner, input, true)) };
  if (method === 'POST' && path === '/api/memory/delete') return { status: 200, body: await run(() => memory.remove(owner, input)) };
  return null;
}

function appOrigin(req) {
  if (req.nemoPublicOrigin) return req.nemoPublicOrigin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || /\.ts\.net(?::443)?$/i.test(host);
  return `${secure ? 'https' : 'http'}://${host}`;
}
