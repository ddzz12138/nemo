import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createSecretStore } from './secrets.mjs';
import { CHATGPT_AUTH_URL, CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES, boundedJson, chatgptFailure as failure, createChatGPTProtocol, grantedScopes, hasPlanPermission, validClientId, validToken } from './chatgpt-auth-protocol.mjs';

const safeEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const hasGrant = account => !!account?.tokens && validToken(account.tokens.accessToken) && hasPlanPermission(account.tokens.scopes);
const safeLabel = account => `${account.email || account.name || 'ChatGPT account'} · ${account.number}`;
const copy = value => structuredClone(value);
// Account catalogs include lengthy model metadata and instructions. Keep the
// larger bound specific to this endpoint; OAuth/JWKS retain their tighter caps.
const MODEL_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

/** Nemo owns its registration. Credentials are never imported from Codex or another app. */
export async function createAssistantOnboarding({ dataDir, openExternal, onConnected = async () => {}, onConnectionChanging = async () => {}, secretStore = createSecretStore({ dataDir, name: 'assistant-provider.dpapi' }), fetchImpl = globalThis.fetch, timeoutMs = 10 * 60_000, now = Date.now } = {}) {
  if (!dataDir || typeof openExternal !== 'function') throw new Error('Nemo could not prepare ChatGPT sign-in.');
  const lifetime = new AbortController();
  const protocol = createChatGPTProtocol({ fetchImpl, now, signal: lifetime.signal });
  let loaded;
  try { loaded = await secretStore.load(); } catch { throw new Error('Nemo could not unlock its protected ChatGPT connection on this computer.'); }
  const legacy = loaded?.provider === 'openrouter';
  let record = { version: 2, provider: 'chatgpt', hostId: `urn:uuid:${randomUUID()}`, activeAccountId: null, selectedAccountId: null, accounts: [] };
  if (loaded && !legacy) {
    if (loaded.version !== 2 || loaded.provider !== 'chatgpt' || !/^urn:uuid:[a-f0-9-]{36}$/.test(loaded.hostId || '') || !Array.isArray(loaded.accounts) || loaded.accounts.length > 5 || loaded.accounts.some(account => !isId(account.id) || !validClientId(account.clientId) || !Number.isInteger(account.number) || account.number < 1 || account.tokens && (!validToken(account.tokens.idToken) || !Array.isArray(account.tokens.scopes) || !Number.isFinite(account.tokens.expiresAt))) || new Set(loaded.accounts.map(account => account.id)).size !== loaded.accounts.length || new Set(loaded.accounts.map(account => account.clientId)).size !== loaded.accounts.length || [loaded.activeAccountId, loaded.selectedAccountId].some(id => id !== null && !loaded.accounts.some(account => account.id === id))) throw new Error('Nemo could not read its saved ChatGPT connection. Reconnect on this computer.');
    record = loaded;
  }
  let phase = hasGrant(active()) ? 'connected' : legacy ? 'reconnect-required' : 'disconnected';
  let message = hasGrant(active()) ? 'Using your ChatGPT plan.' : legacy ? 'Connect your ChatGPT plan to continue. Your previous OpenRouter connection will not be used.' : 'Connect your existing ChatGPT plan to give your assistant a voice.';
  let pending = null, closed = false, storageError = false, changingConnection = false, beginChain = Promise.resolve(), persistChain = Promise.resolve(), refreshPromise = null, epoch = 0;
  const servers = new Set(), catalogs = new Map();
  function active() { return record.accounts.find(account => account.id === record.activeAccountId); }
  function selected() { return record.accounts.find(account => account.id === record.selectedAccountId) || active(); }
  function status() {
    const account = active(), enabled = hasGrant(account) && !['signing-out', 'connecting'].includes(phase) && !changingConnection && !storageError;
    return { connected: enabled, hasAccount: !!selected()?.subject, phase, message, provider: 'chatgpt', planUsageEnabled: enabled, planUsageAcknowledged: account?.planUsageAcknowledged === true, confirmationRequired: enabled && account?.planUsageAcknowledged !== true,
      activeAccountId: account?.id || null,
      account: account ? { id: account.id, label: safeLabel(account), ...(account.email ? { email: account.email } : {}) } : null,
      accounts: record.accounts.filter(item => item.subject).map(item => ({ id: item.id, label: safeLabel(item), connected: hasGrant(item), selected: item.id === record.activeAccountId })) };
  }
  function save() {
    const value = copy(record);
    if (Buffer.byteLength(JSON.stringify(value)) > 120_000) throw failure('CHATGPT_ACCOUNT_LIMIT', 'Nemo has too many saved ChatGPT connections. Sign out of an older account before adding another.');
    const task = persistChain.catch(() => {}).then(async () => { try { await secretStore.save(value); storageError = false; } catch { storageError = true; throw failure('CHATGPT_STORAGE', 'Nemo could not safely save your ChatGPT connection. Please try again on this computer.', 503); } });
    persistChain = task.then(() => {}, () => {}); return task;
  }
  function ensureOpen() { if (closed) throw failure('ASSISTANT_CLOSED', 'Nemo is closing.'); }
  async function pauseConnection() {
    changingConnection = true;
    const generation = ++epoch;
    try { await onConnectionChanging(); }
    catch { phase = 'error'; message = 'Nemo could not stop the previous ChatGPT connection. Please try again.'; throw failure('CHATGPT_UNAVAILABLE', message, 503); }
    return generation;
  }
  function page(response, statusCode, text) {
    response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nemo ChatGPT sign-in</title><main><h1>${text}</h1><p>Return to the Nemo window. You can close this tab.</p></main></html>`);
  }
  async function stop(attempt) {
    if (!attempt) return;
    clearTimeout(attempt.timer); attempt.controller.abort(); attempt.verifier = ''; attempt.state = ''; attempt.nonce = '';
    if (pending === attempt) pending = null;
    const stopped = new Promise(done => attempt.server.close(done)); attempt.server.closeIdleConnections();
    await stopped; servers.delete(attempt.server);
  }
  function tokenRecord(result, previous, identity, { initial = false } = {}) {
    const scopes = initial ? grantedScopes(result.scope) : result.scope === undefined ? previous.scopes : grantedScopes(result.scope);
    const permission = hasPlanPermission(scopes);
    const refreshToken = !initial && result.refresh_token === undefined ? previous.refreshToken : result.refresh_token;
    if (String(result.token_type || '').toLowerCase() !== 'bearer' && permission || permission && (!validToken(result.access_token) || !validToken(refreshToken) || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 86_400)) throw failure('CHATGPT_AUTH', 'ChatGPT did not return a usable plan connection. Please try again.');
    const earliest = result.earliest_refresh_at === undefined ? 0 : typeof result.earliest_refresh_at === 'number' ? result.earliest_refresh_at * (result.earliest_refresh_at < 1e12 ? 1000 : 1) : Date.parse(result.earliest_refresh_at);
    if (!Number.isFinite(earliest)) throw failure('CHATGPT_AUTH', 'ChatGPT did not return a usable plan connection. Please try again.');
    return { accessToken: validToken(result.access_token) ? result.access_token : null, refreshToken: validToken(refreshToken) ? refreshToken : null, idToken: identity ? result.id_token : previous.idToken, scopes, expiresAt: now() + (permission ? result.expires_in * 1000 : 0), earliestRefreshAt: earliest };
  }
  async function modelFor(account) {
    const token = account.tokens.accessToken, cached = catalogs.get(account.id);
    if (cached?.token === token && cached.until > now()) return cached.model;
    if (cached?.token === token && cached.promise) return cached.promise;
    const promise = (async () => {
      let response, result;
      try { response = await protocol.request(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); result = await boundedJson(response, MODEL_CATALOG_MAX_BYTES); }
      catch { throw failure('CHATGPT_UNAVAILABLE', 'Nemo could not check the models included with your ChatGPT plan. Please try again.', 503); }
      if (!response.ok) throw failure(response.status === 401 ? 'CHATGPT_SIGN_IN_REQUIRED' : response.status === 403 ? 'CHATGPT_NOT_ELIGIBLE' : 'CHATGPT_UNAVAILABLE', response.status === 401 ? 'Please connect your ChatGPT account again.' : response.status === 403 ? 'This account cannot use its ChatGPT plan in Nemo. Check the account in ChatGPT.' : 'Nemo could not check the models included with your ChatGPT plan. Please try again.');
      const models = Array.isArray(result.models) ? result.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(model.slug)) : [];
      const model = models.find(item => item.slug === account.model) || models[0];
      if (!model) throw failure('CHATGPT_NOT_ELIGIBLE', 'No supported model is available through this ChatGPT plan. Check your account in ChatGPT.');
      if (closed || !hasGrant(account) || account.tokens.accessToken !== token) throw failure('CHATGPT_CONNECTION_CHANGED', 'Your ChatGPT connection changed. Please try again.');
      account.model = model.slug;
      catalogs.set(account.id, { token, model: model.slug, until: now() + 5 * 60_000 });
      return model.slug;
    })();
    catalogs.set(account.id, { token, promise, until: 0 });
    try { return await promise; } catch (error) { if (catalogs.get(account.id)?.promise === promise) catalogs.delete(account.id); throw error; }
  }
  async function credentials() {
    ensureOpen();
    if (storageError) throw failure('CHATGPT_UNAVAILABLE', 'Nemo could not safely save your ChatGPT connection. Please reconnect on this computer.', 503);
    const account = active(), generation = epoch;
    if (!hasGrant(account) || phase === 'signing-out' || changingConnection) return null;
    if (account.tokens.expiresAt <= now() + 60_000 && account.tokens.earliestRefreshAt <= now()) {
      if (!refreshPromise) {
        const old = account.tokens;
        refreshPromise = (async () => {
          let result;
          try {
            result = await protocol.tokenRequest({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: old.refreshToken, resource: CHATGPT_RESOURCE });
            const identity = result.id_token === undefined ? null : await protocol.verifyIdentity(result.id_token, { clientId: account.clientId, subject: account.subject });
            const tokens = tokenRecord(result, old, identity);
            if (closed || epoch !== generation || account.tokens !== old) {
              // A rotation already sent before a switch must not lose the new
              // renewable token. Save it only on its original unchanged session;
              // never activate that account or restore a cleared session.
              if (!closed && record.accounts.includes(account) && account.tokens === old) { account.tokens = tokens; catalogs.delete(account.id); await save(); }
              throw failure('CHATGPT_CONNECTION_CHANGED', 'Your ChatGPT connection changed. Please try again.');
            }
            account.tokens = tokens; catalogs.delete(account.id); await save();
            if (!hasGrant(account)) { phase = 'permission-required'; message = 'Allow Nemo to use your ChatGPT plan before chatting.'; }
          } catch (error) {
            if (!closed && epoch === generation) {
              if (error.code === 'CHATGPT_SIGN_IN_REQUIRED') { account.tokens = null; catalogs.delete(account.id); await save(); phase = 'reconnect-required'; }
              else phase = 'error';
              message = error.code?.startsWith('CHATGPT_') ? error.message : 'Nemo could not renew your ChatGPT connection. Please try again.';
            }
            if (error.code === 'CHATGPT_SIGN_IN_REQUIRED') throw error;
            throw failure('CHATGPT_UNAVAILABLE', 'Nemo could not renew your ChatGPT connection. Please try again.', 503);
          }
        })().finally(() => { refreshPromise = null; });
      }
      await refreshPromise;
    }
    if (!hasGrant(account) || generation !== epoch || active() !== account) return null;
    if (account.tokens.expiresAt <= now()) throw failure('CHATGPT_UNAVAILABLE', 'Your ChatGPT connection needs a moment before it can renew. Please try again shortly.', 503);
    let model;
    try { model = await modelFor(account); }
    catch (error) {
      if (!closed && generation === epoch && active() === account) {
        if (error.code === 'CHATGPT_SIGN_IN_REQUIRED') { account.tokens = null; catalogs.delete(account.id); await save(); phase = 'reconnect-required'; }
        else phase = 'error';
        message = error.code?.startsWith('CHATGPT_') ? error.message : 'Nemo could not check your ChatGPT plan. Please try again.';
      }
      throw error;
    }
    if (closed || generation !== epoch || active() !== account) throw failure('CHATGPT_CONNECTION_CHANGED', 'Your ChatGPT connection changed. Please try again.');
    return { provider: 'chatgpt', accessToken: account.tokens.accessToken, model, clientId: account.clientId };
  }
  async function finishStartup() {
    phase = 'connecting'; message = 'Your ChatGPT plan is connected. Getting your assistant ready…';
    try { if (!await credentials()) throw failure('CHATGPT_PERMISSION', 'Allow Nemo to use your ChatGPT plan before chatting.'); await onConnected({ planUsageEnabled: true }); phase = 'connected'; message = 'Using your ChatGPT plan.'; }
    catch (error) { phase = 'error'; message = error.code?.startsWith('CHATGPT_') ? error.message : 'Your ChatGPT account is saved. Choose Finish connecting my assistant to try again.'; }
  }
  async function exchange(code, attempt, issuedClientId) {
    try {
      let account = attempt.accountId && record.accounts.find(item => item.id === attempt.accountId);
      if (!account) {
        if (record.accounts.length >= 5) throw failure('CHATGPT_ACCOUNT_LIMIT', 'Nemo can save up to five ChatGPT accounts on this computer.');
        if (record.accounts.some(item => item.clientId === issuedClientId)) throw failure('CHATGPT_REGISTRATION', 'ChatGPT returned an unexpected account registration. Please try again.');
        account = { id: randomUUID(), clientId: issuedClientId, number: Math.max(0, ...record.accounts.map(item => item.number)) + 1, subject: null, email: '', name: '', tokens: null, model: null, planUsageAcknowledged: false };
        record.accounts.push(account); record.selectedAccountId = account.id; attempt.accountId = account.id;
        await save();
      }
      const result = await protocol.tokenRequest({ grant_type: 'authorization_code', client_id: issuedClientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE }, attempt.controller.signal);
      const identity = await protocol.verifyIdentity(result.id_token, { clientId: issuedClientId, nonce: attempt.nonce, ...(account.subject ? { subject: account.subject } : {}) });
      const tokens = tokenRecord(result, null, identity, { initial: true });
      if (pending !== attempt || attempt.controller.signal.aborted || closed) throw new Error();
      const generation = await pauseConnection();
      if (pending !== attempt || attempt.controller.signal.aborted || closed || epoch !== generation) throw new Error();
      Object.assign(account, identity, { tokens });
      record.activeAccountId = account.id; record.selectedAccountId = account.id; catalogs.delete(account.id); await save(); changingConnection = false;
      if (!hasGrant(account)) { phase = 'permission-required'; message = 'You are signed in. Allow Nemo to use your ChatGPT plan before chatting.'; await onConnected().catch(() => {}); return true; }
      await finishStartup(); return true;
    } catch (error) {
      if (pending === attempt && !closed) { phase = 'error'; message = error.code?.startsWith('CHATGPT_') ? error.message : 'Nemo could not finish ChatGPT sign-in. Please try again.'; }
      return false;
    }
  }
  async function beginInternal(input = {}) {
    ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'accountId', 'newAccount'].includes(key)) || input.newAccount !== undefined && typeof input.newAccount !== 'boolean') throw failure('CHATGPT_ACTION', 'Choose one of the ChatGPT account actions shown in Nemo.');
    const action = input.action || (input.newAccount ? 'new' : 'connect');
    if (action === 'acknowledge') return acknowledgeInternal();
    if (action === 'signout') return signOutInternal();
    if (action === 'select') return selectInternal(input.accountId);
    if (!['connect', 'new'].includes(action)) throw failure('CHATGPT_ACTION', 'Choose one of the ChatGPT account actions shown in Nemo.');
    if (pending?.used) throw failure('ASSISTANT_CONNECTING', 'Nemo is finishing your sign-in. Please wait.');
    await stop(pending);
    const account = action === 'new' ? null : input.accountId ? record.accounts.find(item => item.id === input.accountId) : selected();
    if (input.accountId && !account) throw failure('CHATGPT_ACCOUNT', 'Choose a saved ChatGPT account shown in Nemo.');
    if (!account && record.accounts.length >= 5) throw failure('CHATGPT_ACCOUNT_LIMIT', 'Nemo can save up to five ChatGPT accounts on this computer.');
    await save();
    const attempt = { verifier: randomBytes(48).toString('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), controller: new AbortController(), used: false, timer: null, server: null, authority: '', origin: '', redirectUri: '', accountId: account?.id || null, clientId: account?.clientId || null };
    const server = http.createServer(async (request, response) => {
      if (request.headers.host !== attempt.authority || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.method !== 'GET' || request.headers.origin && request.headers.origin !== CHATGPT_ISSUER) return page(response, 403, 'Open ChatGPT sign-in from Nemo.');
      let url; try { url = new URL(request.url, attempt.origin); } catch { return page(response, 400, 'This sign-in link is invalid.'); }
      if (url.origin !== attempt.origin) return page(response, 403, 'Open ChatGPT sign-in from Nemo.');
      if (url.pathname === '/auth/done' && attempt.used && !url.search) return page(response, 200, hasGrant(active()) ? 'Your ChatGPT plan is connected.' : 'Return to Nemo to finish connecting your ChatGPT plan.');
      if (url.pathname !== '/auth/callback' || attempt.used || pending !== attempt) return page(response, 404, 'This sign-in invitation is no longer available.');
      if (['state', 'code', 'client_id', 'error', 'scope'].some(key => url.searchParams.getAll(key).length > 1) || !safeEqual(url.searchParams.get('state'), attempt.state)) return page(response, 403, 'This sign-in invitation could not be confirmed.');
      if (url.searchParams.has('error')) {
        attempt.used = true; clearTimeout(attempt.timer); phase = 'permission-required'; message = 'ChatGPT sign-in was not completed. Continue with ChatGPT when you are ready.';
      } else {
        const code = url.searchParams.get('code'), suppliedClient = url.searchParams.get('client_id'), issued = suppliedClient || attempt.clientId;
        if (!code || code.length > 4096 || /[\r\n\0]/.test(code) || !validClientId(issued) || attempt.clientId && suppliedClient && suppliedClient !== attempt.clientId) return page(response, 400, 'ChatGPT registration could not be confirmed. Please try again in Nemo.');
        attempt.used = true; clearTimeout(attempt.timer); phase = 'connecting'; message = 'Finishing your ChatGPT sign-in…';
        await exchange(code, attempt, issued);
      }
      attempt.verifier = ''; attempt.state = ''; attempt.nonce = '';
      if (pending === attempt) pending = null;
      if (!response.destroyed) { response.writeHead(303, { location: '/auth/done', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); }
      attempt.timer = setTimeout(() => void stop(attempt).catch(() => {}), 30_000); attempt.timer.unref?.();
    });
    attempt.server = server; server.requestTimeout = 25_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    attempt.authority = `127.0.0.1:${server.address().port}`; attempt.origin = `http://${attempt.authority}`; attempt.redirectUri = `${attempt.origin}/auth/callback`; pending = attempt; servers.add(server);
    attempt.timer = setTimeout(() => { if (pending === attempt) { phase = 'expired'; message = 'Your sign-in invitation expired. Choose Continue with ChatGPT to try again.'; } void stop(attempt).catch(() => {}); }, timeoutMs); attempt.timer.unref?.();
    const auth = new URL(CHATGPT_AUTH_URL);
    for (const [key, value] of Object.entries({ client_id: account?.clientId || 'dynamic_agent_client', ext_agent_host_id: record.hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: CHATGPT_SCOPES, resource: CHATGPT_RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') })) auth.searchParams.set(key, value);
    if (!account) auth.searchParams.set('agent_name_hint', 'Nemo');
    if (account?.tokens?.idToken) auth.searchParams.set('id_token_hint', account.tokens.idToken);
    if (account?.email) auth.searchParams.set('login_hint', account.email);
    if (account?.subject && !hasGrant(account)) auth.searchParams.set('prompt', 'consent');
    phase = 'waiting'; message = 'Finish connecting your ChatGPT plan in your browser, then come back to Nemo.';
    try { await openExternal(auth.href); }
    catch { phase = 'error'; message = 'Nemo could not open ChatGPT sign-in. Please try again.'; await stop(attempt); throw failure('ASSISTANT_BROWSER', message, 503); }
    return status();
  }
  async function acknowledgeInternal() {
    ensureOpen(); const account = active();
    if (!hasGrant(account)) throw failure('CHATGPT_ACCOUNT', 'Connect your ChatGPT plan first.');
    account.planUsageAcknowledged = true; await save(); return status();
  }
  async function signOutInternal() {
    ensureOpen(); phase = 'signing-out'; message = 'Signing out of ChatGPT…'; pending?.controller.abort();
    const generation = await pauseConnection(); await stop(pending); await refreshPromise?.catch(() => {});
    if (closed || epoch !== generation) throw failure('CHATGPT_CONNECTION_CHANGED', 'Your ChatGPT connection changed. Please try again.');
    const account = active();
    if (!account) { changingConnection = false; phase = 'disconnected'; message = 'You are signed out of ChatGPT on this computer.'; await onConnected().catch(() => {}); return status(); }
    const refreshToken = account.tokens?.refreshToken; let revoked = !refreshToken;
    try {
      const metadata = await protocol.metadata();
      if (refreshToken && metadata.revocation_endpoint) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await protocol.request(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) }, 5_000);
            await response.body?.cancel().catch(() => {});
            if (response.status === 200) { revoked = true; break; }
            if (response.status < 500) break;
          } catch { /* One bounded retry, then report remote uncertainty. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch { /* Local sign-out remains available when discovery is offline. */ }
    account.tokens = null; catalogs.delete(account.id); record.selectedAccountId = account.id; record.activeAccountId = null; await save(); changingConnection = false;
    phase = 'disconnected'; message = revoked ? 'You are signed out of ChatGPT on this computer.' : 'You are signed out here. Remote sign-out was not confirmed; you can disconnect Nemo in ChatGPT settings.';
    await onConnected().catch(() => {}); return status();
  }
  async function selectInternal(id) {
    ensureOpen(); if (!isId(id)) throw failure('CHATGPT_ACCOUNT', 'Choose a saved ChatGPT account shown in Nemo.');
    const account = record.accounts.find(item => item.id === id && item.subject);
    if (!account) throw failure('CHATGPT_ACCOUNT', 'Choose a saved ChatGPT account shown in Nemo.');
    phase = 'connecting'; message = 'Connecting the selected ChatGPT account…'; pending?.controller.abort();
    const generation = await pauseConnection(); await stop(pending);
    if (closed || epoch !== generation) throw failure('CHATGPT_CONNECTION_CHANGED', 'Your ChatGPT connection changed. Please try again.');
    record.selectedAccountId = id;
    if (!hasGrant(account)) { await save(); return beginInternal({ accountId: id }); }
    record.activeAccountId = id; await save(); changingConnection = false; await finishStartup(); return status();
  }
  function enqueue(operation) { const next = beginChain.catch(() => {}).then(operation); beginChain = next.then(() => {}, () => {}); return next; }
  async function reportInferenceFailure(code) {
    if (closed || !['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_NOT_ELIGIBLE', 'CHATGPT_USAGE_LIMIT', 'CHATGPT_UNAVAILABLE'].includes(code)) return status();
    const account = active();
    if (!hasGrant(account) || changingConnection) return status();
    if (code === 'CHATGPT_SIGN_IN_REQUIRED') {
      account.tokens.expiresAt = 0; account.tokens.earliestRefreshAt = 0; catalogs.delete(account.id);
      phase = 'error'; message = 'Your ChatGPT account is saved. Choose Finish connecting my assistant to renew the connection.';
      await save();
    } else if (code === 'CHATGPT_NOT_ELIGIBLE') {
      phase = 'error'; message = 'This account cannot use its ChatGPT plan in Nemo. Check your account in ChatGPT or choose another saved account.';
    } else if (code === 'CHATGPT_USAGE_LIMIT') {
      phase = 'usage-limit'; message = 'Your ChatGPT usage limit was reached. Review your plan or this app’s limit in ChatGPT settings.';
    } else {
      phase = 'error'; message = 'ChatGPT is temporarily unavailable. Your account is saved; please try again later.';
    }
    return status();
  }
  return {
    status, credentials, reportInferenceFailure,
    begin(input) { return enqueue(() => beginInternal(input)); },
    acknowledgePlanUsage() { return enqueue(acknowledgeInternal); },
    signOut() { return enqueue(signOutInternal); },
    selectAccount(id) { return enqueue(() => selectInternal(id)); },
    retryConnection() { return enqueue(async () => { ensureOpen(); if (!hasGrant(active())) throw failure('ASSISTANT_ACCOUNT', 'Connect your ChatGPT plan first.'); await finishStartup(); return status(); }); },
    async close() {
      if (closed) return;
      closed = true; epoch++; lifetime.abort(); pending?.controller.abort();
      for (const server of servers) server.closeAllConnections();
      await beginChain; await refreshPromise?.catch(() => {}); await stop(pending); await persistChain;
      for (const server of servers) { const stopped = new Promise(done => server.close(done)); server.closeAllConnections(); await stopped; } servers.clear();
    },
  };
}
