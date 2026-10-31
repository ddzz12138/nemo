import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSecretStore } from './secrets.mjs';
import { projectSelectedNotice } from './gmail-notice.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALLBACK_PATH = '/oauth2/callback';
const CALLBACK_MS = 300_000;

export class GmailError extends Error {
  constructor(code, message) { super(message); this.name = 'GmailError'; this.code = code; }
}
const problem = (code, message) => new GmailError(code, message);
const invalidConfig = () => problem('GMAIL_CONFIG_INVALID', 'Use a Google Desktop app OAuth client JSON file on the PC.');
const storageError = () => problem('GMAIL_STORAGE', 'Gmail credentials could not be unlocked or saved for this Windows user. Reconnect Gmail on the PC.');
const authError = () => problem('GMAIL_AUTH_REQUIRED', 'Reconnect Gmail on the PC to continue.');
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
const safeEqual = (left, right) => { if (typeof left !== 'string' || typeof right !== 'string') return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

function clientConfig(json) {
  const installed = json?.installed;
  if (!installed || typeof installed !== 'object' || Array.isArray(installed) || typeof installed.client_id !== 'string' || !/^[A-Za-z0-9._-]{1,240}\.apps\.googleusercontent\.com$/.test(installed.client_id)) throw invalidConfig();
  if (installed.client_secret !== undefined && (typeof installed.client_secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(installed.client_secret))) throw invalidConfig();
  // Configuration cannot redirect credentials to a user-supplied endpoint.
  return { client_id: installed.client_id, ...(installed.client_secret ? { client_secret: installed.client_secret } : {}) };
}

async function readDesktopConfig(dataDir) {
  let text;
  try {
    const path = join(dataDir, 'google-client.json');
    if ((await stat(path)).size > 65_536) throw invalidConfig();
    text = await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw invalidConfig(); }
  try { return clientConfig(JSON.parse(text)); } catch { throw invalidConfig(); }
}

/** Explicitly import a Desktop OAuth JSON selected by the PC owner. Never scan
 * other applications, browser profiles, environment files, or credential stores.
 */
export async function installGmailDesktopClient({ dataDir, clientPath }) {
  if (typeof clientPath !== 'string' || !clientPath || typeof dataDir !== 'string' || !dataDir) throw invalidConfig();
  let config;
  try {
    if ((await stat(clientPath)).size > 65_536) throw invalidConfig();
    config = clientConfig(JSON.parse(await readFile(clientPath, 'utf8')));
  } catch { throw invalidConfig(); }
  await mkdir(dataDir, { recursive: true });
  const destination = join(dataDir, 'google-client.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify({ installed: config }, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, destination); }
  catch { throw problem('GMAIL_CONFIG_SAVE', 'The Desktop OAuth client could not be saved in Nemo\'s private data directory.'); }
  finally { await unlink(temporary).catch(() => {}); }
  return { configured: true };
}

async function responseText(response) {
  try {
    const parts = []; let size = 0;
    if (response.body) for await (const part of response.body) {
      size += part.length;
      if (size > 262_144) throw new Error();
      parts.push(part);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  } catch { throw problem('GMAIL_RESPONSE', 'Google returned an unreadable or oversized response.'); }
}

// Project only known protocol errors to fixed messages. Never forward Google's
// description, request body, account details, authorization code, or tokens.
function tokenFailure(value, authorizing) {
  if (value?.error === 'invalid_client') return problem('GMAIL_CLIENT_REJECTED', 'Google rejected Nemo’s OAuth client. Update the Google Desktop client configuration on the PC.');
  if (value?.error === 'unauthorized_client') return problem('GMAIL_CLIENT_BLOCKED', 'Google does not allow this OAuth client to connect Gmail. Check the Desktop client and Google project settings.');
  if (!authorizing) return authError();
  if (value?.error === 'invalid_grant') return problem('GMAIL_AUTH_CODE_REJECTED', 'Google rejected the sign-in code (invalid_grant). Start a fresh sign-in in Nemo; finish it in the browser opened by Nemo.');
  if (value?.error === 'redirect_uri_mismatch') return problem('GMAIL_AUTH_REDIRECT', 'Google rejected Nemo’s return address. Use a Google Desktop app client for PC sign-in.');
  if (value?.error === 'invalid_request') return problem('GMAIL_AUTH_REQUEST', 'Google rejected Nemo’s sign-in request (invalid_request). Check the Desktop OAuth configuration on the PC.');
  return problem('GMAIL_AUTH_EXCHANGE', 'Google could not exchange the sign-in code. Start a fresh sign-in in Nemo.');
}

async function google(fetchImpl, url, options = {}, stage = '') {
  // Every caller supplies one of the fixed HTTPS Google endpoints above. Never
  // follow redirects, including redirects returned from a compromised response.
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); }
  catch { throw problem('GMAIL_NETWORK', 'Google could not be reached. Check the PC connection and try again.'); }
  if (!response.ok) {
    if (response.status === 429) throw problem('GMAIL_RATE_LIMIT', 'Google is temporarily limiting requests. Try again shortly.');
    if (url === TOKEN_URL && [400, 401].includes(response.status)) {
      let value = null;
      try { value = JSON.parse(await responseText(response)); } catch { /* Keep malformed error responses private too. */ }
      throw tokenFailure(value, stage === 'authorization');
    }
    if (stage === 'account') {
      if (response.status === 401) throw problem('GMAIL_ACCOUNT_REJECTED', 'Google accepted sign-in but rejected the Gmail account lookup. Start a fresh sign-in with Gmail read-only access.');
      if (response.status === 403) {
        let value = null;
        try { value = JSON.parse(await responseText(response)); } catch { /* No upstream text leaves this module. */ }
        const disabled = (Array.isArray(value?.error?.errors) && value.error.errors.some(entry => entry?.reason === 'accessNotConfigured')) || (Array.isArray(value?.error?.details) && value.error.details.some(entry => entry?.reason === 'SERVICE_DISABLED'));
        if (disabled) throw problem('GMAIL_API_DISABLED', 'Enable the Gmail API in Nemo’s Google Cloud project, then try connecting again.');
        throw problem('GMAIL_ACCOUNT_ACCESS', 'Google blocked Gmail account access. Check the Gmail read-only permission and any Google Workspace restrictions.');
      }
    }
    if (response.status === 401) throw authError();
    throw problem('GMAIL_REQUEST_FAILED', 'Google could not complete this read-only Gmail request. Check Gmail API access on the PC.');
  }
  const text = await responseText(response);
  if (text.length > 262_144) throw problem('GMAIL_RESPONSE', 'Google returned an unexpected response.');
  if (!text && url === REVOKE_URL) return {};
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw problem('GMAIL_RESPONSE', 'Google returned an unexpected response.'); }
}

const formOptions = fields => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const bearer = token => ({ headers: { Authorization: `Bearer ${token}` } });

function scopeAllowed(scope) {
  return typeof scope === 'string' && scope.trim().split(/\s+/).length === 1 && scope.trim() === GMAIL_SCOPE;
}

function tokenRecord(response, config, now, previous = null) {
  // A first grant must attest its actual scope. Only a refresh can inherit the
  // scope from the already validated, protected grant record.
  const scope = response.scope ?? previous?.scope;
  if (!scopeAllowed(scope)) throw problem('GMAIL_SCOPE', 'Gmail access must be limited to the read-only Gmail permission. Reconnect using the Desktop app client.');
  if (!validToken(response.access_token) || !validToken(response.refresh_token ?? previous?.refreshToken) || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 604_800 || (response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer'))) throw problem('GMAIL_TOKEN_RESPONSE', 'Google did not return a usable Gmail connection. Reconnect on the PC.');
  return { version: 1, clientId: config.client_id, scope: GMAIL_SCOPE, accessToken: response.access_token, refreshToken: response.refresh_token ?? previous?.refreshToken, expiresAt: now() + response.expires_in * 1000, ...(previous?.account ? { account: previous.account } : {}), ...(config.kind === 'web' ? { clientType: 'web' } : {}) };
}

function storedRecord(value, config) {
  if (value === null || value === undefined) return null;
  if (value.version !== 1 || value.clientId !== config.client_id || !scopeAllowed(value.scope) || !validToken(value.accessToken) || !validToken(value.refreshToken) || !Number.isFinite(value.expiresAt)) throw storageError();
  if (value.account !== undefined && (typeof value.account !== 'string' || value.account.length > 254 || /[\r\n\0]/.test(value.account))) throw storageError();
  return value;
}

async function fingerprint(dataDir) {
  const values = await Promise.all(['google-client.json', 'google-web-client.dpapi', 'gmail-tokens.dpapi'].map(async name => {
    try { const result = await stat(join(dataDir, name)); return `${result.mtimeMs}:${result.ctimeMs}:${result.size}`; }
    catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  }));
  return values.join('|');
}

/** Personal-PC connection shared by paired devices. The HTTP layer must obtain
 * explicit per-request user opt-in before sending retrieved mail to any AI.
 * Mail is untrusted content, never agent/system instructions. This module only
 * reads Gmail metadata/snippets; it cannot send, modify, or download attachments.
 * secretStore injection: async load(), save(record), remove().
 */
export async function createGmailClient({ dataDir, configDir = dataDir, fetchImpl = fetch, now = Date.now, secretStore, webClientStore, syncStore } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw invalidConfig();
  const store = secretStore || createSecretStore({ dataDir });
  let config = null;
  let tokens = null;
  let failure = null;
  let seenFingerprint;
  let refreshPromise = null;
  const webStore = webClientStore || createSecretStore({ dataDir: configDir, name: 'google-web-client.dpapi' });
  const cacheStore = syncStore || createSecretStore({ dataDir, name: 'gmail-sync.dpapi' });
  let chain = Promise.resolve();
  const serial = action => { const result = chain.then(action, action); chain = result.catch(() => {}); return result; };
  const status = () => ({ configured: !!config, connected: !!config && !!tokens && !failure, ...(tokens?.account && !failure ? { account: tokens.account } : {}) });
  async function reloadState() {
    const current = `${await fingerprint(dataDir)}:${await fingerprint(configDir)}`;
    if (!secretStore && current === seenFingerprint) return status();
    seenFingerprint = current;
    config = null; tokens = null; failure = null;
    try { config = await readDesktopConfig(configDir) || await readGmailWebConfig({ dataDir: configDir, store: webStore }); }
    catch (error) { failure = error; return status(); }
    if (!config) return status();
    try {
      const saved = await store.load();
      if (saved?.clientType === 'web') config = await readGmailWebConfig({ dataDir, store: webStore });
      if (!config) throw storageError();
      tokens = storedRecord(saved, config);
    }
    catch { failure = storageError(); }
    return status();
  }
  async function saveTokens(next) {
    try { await store.save(next); tokens = next; seenFingerprint = await fingerprint(dataDir); }
    catch { tokens = null; failure = storageError(); throw failure; }
  }
  async function access(force = false) {
    if (!config) throw failure || problem('GMAIL_NOT_CONFIGURED', 'Connect Gmail from the Nemo PC first.');
    if (failure) throw failure;
    if (!tokens) throw problem('GMAIL_NOT_CONNECTED', 'Connect Gmail from the Nemo PC first.');
    if (!force && tokens.expiresAt > now() + 60_000) return tokens.accessToken;
    if (!refreshPromise) refreshPromise = (async () => {
      try {
        const response = await google(fetchImpl, TOKEN_URL, formOptions({ client_id: config.client_id, ...(config.client_secret ? { client_secret: config.client_secret } : {}), refresh_token: tokens.refreshToken, grant_type: 'refresh_token', scope: GMAIL_SCOPE }));
        await saveTokens(tokenRecord(response, config, now, tokens));
        return tokens.accessToken;
      } catch (error) {
        if (error.code === 'GMAIL_AUTH_REQUIRED') { tokens = null; await store.remove().catch(() => {}); seenFingerprint = await fingerprint(dataDir); }
        throw error;
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function api(url, options = {}) {
    let token = await access();
    try { return await google(fetchImpl, url, { ...options, ...bearer(token) }); }
    catch (error) {
      if (error.code !== 'GMAIL_AUTH_REQUIRED') throw error;
      token = tokens?.accessToken && tokens.accessToken !== token ? tokens.accessToken : await access(true);
      try { return await google(fetchImpl, url, { ...options, ...bearer(token) }); }
      catch (retryError) {
        if (retryError.code === 'GMAIL_AUTH_REQUIRED') { tokens = null; await store.remove().catch(() => {}); seenFingerprint = await fingerprint(dataDir); }
        throw retryError;
      }
    }
  }
  async function readMessage(id) {
    const url = new URL(`${API_URL}/messages/${id}`);
    url.searchParams.set('format', 'metadata');
    for (const name of ['From', 'Subject', 'Date']) url.searchParams.append('metadataHeaders', name);
    url.searchParams.set('fields', 'id,snippet,payload(headers(name,value))');
    const value = await api(url.href);
    const headers = Array.isArray(value.payload?.headers) ? value.payload.headers : [];
    const clean = (text, length) => typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length) : '';
    const header = name => clean(headers.find(entry => typeof entry?.name === 'string' && entry.name.toLowerCase() === name)?.value, name === 'date' ? 200 : 1000);
    return { id, from: header('from'), subject: header('subject'), date: header('date'), snippet: clean(value.snippet, 2000) };
  }
  async function cacheRead() {
    const value = await cacheStore.load();
    if (!value) return { version: 1, mode: 'demand', messages: [], lastSyncedAt: null };
    if (value.version !== 1 || !['sync', 'demand'].includes(value.mode) || !Array.isArray(value.messages) || value.messages.length > 50 || value.messages.some(item => !item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || ['from','subject','date','snippet'].some(key => typeof item[key] !== 'string' || item[key].length > 2000))) throw problem('GMAIL_SYNC_STORAGE', 'The saved Gmail snippets could not be read. Choose Don’t sync to remove the local cache.');
    return value;
  }
  function cacheCurrent(value) {
    return !!tokens && value.mode === 'sync' && value.clientId === tokens.clientId && value.account === (tokens.account || '') && Number.isFinite(value.syncedAt) && now() - value.syncedAt >= 0 && now() - value.syncedAt < 900_000;
  }
  function syncStatus(value) {
    const sameAccount = !!tokens && value.clientId === tokens.clientId && value.account === (tokens.account || '');
    return { mode: value.mode, count: sameAccount ? value.messages.length : 0, lastSyncedAt: sameAccount ? value.lastSyncedAt : null, stale: !cacheCurrent(value), maximum: 50, windowDays: 7, intervalMinutes: 15 };
  }
  async function refreshCache() {
    const value = await cacheRead();
    if (value.mode !== 'sync') return syncStatus(value);
    // Permission is checked again for every refresh. Fixed bounded query: this
    // cache is neither a complete mailbox nor a GBrain memory ingestion job.
    await access();
    const list = new URL(`${API_URL}/messages`);
    list.searchParams.set('q', 'newer_than:7d -in:trash -in:spam');
    list.searchParams.set('maxResults', '50');
    list.searchParams.set('fields', 'messages(id),nextPageToken');
    const result = await api(list.href);
    if ((result.messages !== undefined && !Array.isArray(result.messages)) || (result.messages?.length || 0) > 50 || result.messages?.some(item => !item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id))) throw problem('GMAIL_RESPONSE', 'Google returned an unexpected sync response.');
    const messages = [];
    const input = result.messages || [];
    for (let i = 0; i < input.length; i += 5) {
      const outcomes = await Promise.allSettled(input.slice(i, i + 5).map(item => readMessage(item.id)));
      const failed = outcomes.find(item => item.status === 'rejected');
      if (failed) throw failed.reason;
      messages.push(...outcomes.map(item => item.value));
    }
    const saved = { version: 1, mode: 'sync', clientId: tokens.clientId, account: tokens.account || '', messages, syncedAt: now(), lastSyncedAt: new Date(now()).toISOString(), hasMore: !!result.nextPageToken };
    await cacheStore.save(saved);
    return syncStatus(saved);
  }
  function searchPage(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(problem('GMAIL_QUERY_INVALID', 'Use a Gmail search query and a message limit.'));
      if (Object.keys(input).some(key => !['query', 'limit', 'pageToken'].includes(key))) return Promise.reject(problem('GMAIL_QUERY_INVALID', 'Unknown Gmail search option.'));
      const { query = 'in:inbox newer_than:7d', limit = 5, pageToken } = input;
      if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\x00-\x1f\x7f]/.test(query)) return Promise.reject(problem('GMAIL_QUERY_INVALID', 'Enter a Gmail search query between 1 and 500 characters.'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) return Promise.reject(problem('GMAIL_LIMIT_INVALID', 'Request between 1 and 10 Gmail messages.'));
      const validPageToken = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
      if (pageToken !== undefined && !validPageToken(pageToken)) return Promise.reject(problem('GMAIL_PAGE_INVALID', 'Use a valid Gmail continuation token.'));
      return serial(async () => {
        await reloadState();
        const listUrl = new URL(`${API_URL}/messages`);
        listUrl.searchParams.set('q', query.trim()); listUrl.searchParams.set('maxResults', String(limit));
        listUrl.searchParams.set('fields', 'messages(id),nextPageToken,resultSizeEstimate');
        if (pageToken !== undefined) listUrl.searchParams.set('pageToken', pageToken);
        const list = await api(listUrl.href);
        if ((list.messages !== undefined && !Array.isArray(list.messages)) || (list.messages?.length || 0) > limit) throw problem('GMAIL_RESPONSE', 'Google returned an unexpected message list.');
        if (list.nextPageToken !== undefined && !validPageToken(list.nextPageToken)) throw problem('GMAIL_RESPONSE', 'Google returned an invalid continuation response.');
        if (list.resultSizeEstimate !== undefined && (!Number.isSafeInteger(list.resultSizeEstimate) || list.resultSizeEstimate < 0)) throw problem('GMAIL_RESPONSE', 'Google returned an invalid result estimate.');
        const messages = list.messages || [];
        if (messages.some(item => !item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id))) throw problem('GMAIL_RESPONSE', 'Google returned an unexpected message identifier.');
        let cached = null;
        try { const value = await cacheRead(); if (cacheCurrent(value)) cached = value; } catch { /* Online search still works if a cache is unavailable. */ }
        const outcomes = await Promise.allSettled(messages.map(async item => {
          const saved = cached?.messages.find(message => message.id === item.id);
          return saved ? { id: saved.id, from: saved.from, subject: saved.subject, date: saved.date, snippet: saved.snippet } : readMessage(item.id);
        }));
        // Keep the operation lock until every metadata request has settled. A
        // disconnect must not race an outstanding refresh that could save tokens.
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        return { messages: outcomes.map(outcome => outcome.value), nextPageToken: list.nextPageToken ?? null,
          hasMore: list.nextPageToken !== undefined, resultSizeEstimate: list.resultSizeEstimate ?? null, query: query.trim(), limit };
      });
  }
  await reloadState();
  function noticeBinding() {
    if (!config || !tokens || failure) throw authError();
    return createHash('sha256').update(JSON.stringify([tokens.clientId, tokens.account || '', tokens.refreshToken])).digest('hex');
  }
  return {
    // Internal workflow operations, never model-selected mailbox IDs or public tokens.
    noticeGrant: () => serial(async () => { await reloadState(); return noticeBinding(); }),
    readSelectedNotice: ({ id, grant, signal } = {}) => serial(async () => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(grant || '')) throw problem('GMAIL_NOTICE_SELECTION', 'Select a notice from this profile’s current Gmail search.');
      await reloadState(); if (!safeEqual(grant, noticeBinding())) throw problem('GMAIL_NOTICE_ACCOUNT', 'Gmail changed. Select the notice again.');
      if (signal?.aborted) throw problem('GMAIL_NOTICE_STOPPED', 'This notice briefing was stopped.');
      const url = new URL(`${API_URL}/messages/${id}`); url.searchParams.set('format', 'full'); url.searchParams.set('fields', 'id,internalDate,payload');
      const response = await api(url.href, { signal });
      await reloadState(); if (!safeEqual(grant, noticeBinding())) throw problem('GMAIL_NOTICE_ACCOUNT', 'Gmail changed before the selected notice was read.');
      return projectSelectedNotice(response, id);
    }),
    status,
    reload: () => serial(reloadState),
    desktopConfiguration: async () => ({ available: !!await readDesktopConfig(configDir) }),
    beginDesktopAuthorization: ({ stillAuthorized, commit, timeoutMs } = {}) => beginGmailConnect({
      dataDir, configDir, fetchImpl, now, timeoutMs, isAuthorized: stillAuthorized,
      // Network work happens outside both locks. The gateway takes its mutation
      // lock first, then this credential lock, just like disconnect and sync.
      saveRecord: (record, clientId) => commit(() => serial(async () => {
        const desktop = await readDesktopConfig(configDir);
        if (!desktop || desktop.client_id !== clientId || !await stillAuthorized()) throw problem('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in changed. Try again in Nemo.');
        await reloadState();
        const previous = await store.load();
        await cacheStore.remove();
        try {
          if (!await stillAuthorized()) throw problem('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in was cancelled.');
          await store.save(record);
          if (!await stillAuthorized()) throw problem('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in was cancelled.');
        } catch (error) {
          // Revocation may arrive while protected storage is writing. Restore
          // the old grant before releasing the lock; never leave the new one.
          try { if (previous) await store.save(previous); else await store.remove(); }
          catch { tokens = null; failure = storageError(); throw failure; }
          await reloadState();
          throw error instanceof GmailError ? error : storageError();
        }
        config = desktop; tokens = record; failure = null; seenFingerprint = undefined;
        return status();
      })),
    }),
    // Preserve the original bounded array-returning adapter for existing local
    // callers. MCP uses searchPage so it can continue beyond the first page.
    search: input => searchPage(input).then(page => page.messages),
    searchPage,
    phoneConfiguration: async origin => {
      const web = await readGmailWebConfig({ dataDir, store: webStore });
      const redirectUri = `${origin}/oauth/gmail/callback`;
      return { available: !!web?.redirect_uris.includes(redirectUri), redirectUri,
        reason: web ? 'redirect_not_registered' : 'web_client_required' };
    },
    webAuthorization: async ({ origin, state, verifier }) => {
      const web = await readGmailWebConfig({ dataDir, store: webStore });
      const redirectUri = `${origin}/oauth/gmail/callback`;
      if (!web?.redirect_uris.includes(redirectUri)) throw problem('GMAIL_WEB_SETUP', 'Phone sign-in needs a Google Web application client with this exact return address. Your existing Gmail connection is unchanged.');
      const url = new URL(AUTH_URL);
      for (const [key, value] of Object.entries({ client_id: web.client_id, redirect_uri: redirectUri, response_type: 'code', scope: GMAIL_SCOPE, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' })) url.searchParams.set(key, value);
      return { authorizationUrl: url.href, clientId: web.client_id, redirectUri };
    },
    completeWebAuthorization: async input => {
      const { code, verifier, clientId, redirectUri, stillAuthorized } = input;
      const web = await readGmailWebConfig({ dataDir, store: webStore });
      if (!web || web.client_id !== clientId || !web.redirect_uris.includes(redirectUri) || !await stillAuthorized()) throw problem('GMAIL_WEB_EXPIRED', 'This Gmail sign-in expired. Open Nemo and try again.');
      const response = await google(fetchImpl, TOKEN_URL, formOptions({ client_id: web.client_id, client_secret: web.client_secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }), 'authorization');
      const next = tokenRecord(response, web, now);
      const profile = await google(fetchImpl, `${API_URL}/profile?fields=emailAddress`, bearer(next.accessToken), 'account');
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw problem('GMAIL_PROFILE', 'Google did not identify the connected account. Try again.');
      next.account = profile.emailAddress;
      if (!await stillAuthorized()) throw problem('GMAIL_WEB_EXPIRED', 'This browser was unpaired during sign-in. Pair it and try again.');
      await input.beforeAccountChange?.();
      if (!await stillAuthorized()) throw problem('GMAIL_WEB_EXPIRED', 'This sign-in changed. Open Nemo and try again.');
      const apply = () => serial(async () => {
        if (!await stillAuthorized()) throw problem('GMAIL_WEB_EXPIRED', 'This sign-in changed. Open Nemo and try again.');
        const previous = await store.load();
        await cacheStore.remove();
        try {
          await store.save(next);
          if (input.mode === 'sync') await cacheStore.save({ version: 1, mode: 'sync', messages: [], lastSyncedAt: null });
          if (!await stillAuthorized()) throw problem('GMAIL_WEB_EXPIRED', 'This sign-in changed. Open Nemo and try again.');
        } catch (error) {
          await cacheStore.remove();
          try { if (previous) await store.save(previous); else await store.remove(); }
          catch { tokens = null; failure = storageError(); throw failure; }
          await reloadState(); throw error;
        }
        config = web; tokens = next; failure = null; seenFingerprint = undefined;
        return status();
      });
      return input.commit ? input.commit(apply) : apply();
    },
    syncStatus: () => serial(async () => { await reloadState(); return syncStatus(await cacheRead()); }),
    setSyncMode: mode => serial(async () => {
      if (!['sync', 'demand'].includes(mode)) throw problem('GMAIL_SYNC_MODE', 'Choose Sync or Don’t sync.');
      await reloadState();
      if (!tokens || failure) throw authError();
      if (mode === 'demand') { await cacheStore.remove(); return syncStatus({ mode: 'demand', messages: [], lastSyncedAt: null }); }
      const previous = await cacheRead();
      await cacheStore.save({ ...previous, version: 1, mode: 'sync' });
      return syncStatus(await cacheRead());
    }),
    syncNow: () => serial(async () => { await reloadState(); return refreshCache(); }),
    syncIfDue: () => serial(async () => { await reloadState(); const value = await cacheRead(); if (value.mode === 'sync' && tokens && !failure && !cacheCurrent(value)) return refreshCache(); return syncStatus(value); }),
    cachedMessages: () => serial(async () => { await reloadState(); const value = await cacheRead(); const current = syncStatus(value); return { ...current, messages: current.count ? value.messages.map(item => ({ id: item.id, from: item.from, subject: item.subject, date: item.date, snippet: item.snippet })) : [] }; }),
    disconnect: () => serial(async () => {
      await reloadState();
      await cacheStore.remove();
      const token = tokens?.refreshToken || tokens?.accessToken;
      const unknownCredentials = !!failure;
      tokens = null;
      let revoked = false;
      try { if (token) { await google(fetchImpl, REVOKE_URL, formOptions({ token })); revoked = true; } }
      catch { revoked = false; }
      finally {
        try { await store.remove(); failure = null; seenFingerprint = await fingerprint(dataDir); }
        catch { failure = storageError(); throw problem('GMAIL_DISCONNECT_FAILED', 'Gmail is disabled in this process, but local credentials could not be removed. Stop Nemo and remove its Gmail connection on the PC.'); }
      }
      return { connected: false, revoked, ...(!revoked && (token || unknownCredentials) ? { warning: 'The local connection was removed. Google revocation could not be confirmed; remove Nemo from your Google account connections if needed.' } : {}) };
    }),
  };
}

/** Begin Desktop OAuth on a random loopback port. The callback is single-use,
 * expires within five minutes, and never exposes tokens to the browser. No
 * browser is opened automatically. completed resolves only after protected save.
 */
export async function beginGmailConnect({ dataDir, configDir = dataDir, fetchImpl = fetch, now = Date.now, secretStore, timeoutMs = CALLBACK_MS, isAuthorized = async () => true, saveRecord } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CALLBACK_MS) throw invalidConfig();
  const config = await readDesktopConfig(configDir);
  if (!config) throw problem('GMAIL_NOT_CONFIGURED', 'This Nemo build does not include its Google connection yet. Gmail is optional.');
  const store = secretStore || createSecretStore({ dataDir });
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const expiresAt = now() + timeoutMs;
  let used = false, settled = false;
  const controller = new AbortController();
  let redirectUri;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  // Attach a handler immediately; CLI/test callers still receive the rejection.
  completed.catch(() => {});
  let timer;
  const stop = () => { clearTimeout(timer); server.closeIdleConnections(); server.close(); };
  const finish = (error, result) => { if (settled) return; settled = true; stop(); if (error) { controller.abort(); rejectCompleted(error); } else resolveCompleted(result); };
  const check = async () => { if (settled || controller.signal.aborted || now() >= expiresAt || !await isAuthorized() || settled || controller.signal.aborted || now() >= expiresAt) throw problem('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in expired or was cancelled. Try again in Nemo.'); };
  const reply = (res, status, text) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); res.end(text); };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') return reply(res, 405, 'Open Gmail sign-in from Nemo.');
    if (req.headers.host !== new URL(redirectUri).host || (req.headers.origin && req.headers.origin !== 'https://accounts.google.com')) return reply(res, 403, 'This callback request is not allowed.');
    let url;
    try { if ((req.url || '').length > 4096 || !req.url.startsWith('/')) throw new Error(); url = new URL(req.url, redirectUri); } catch { return reply(res, 400, 'Invalid authorization callback.'); }
    if (req.url.split('?')[0] !== CALLBACK_PATH || url.pathname !== CALLBACK_PATH) return reply(res, 404, 'Not found.');
    if (used || settled) return reply(res, 409, 'This authorization link has already been used.');
    if (now() >= expiresAt) { used = true; reply(res, 410, 'The authorization link expired. Return to Nemo to try again.'); return finish(problem('GMAIL_AUTH_TIMEOUT', 'Gmail authorization expired. Try again in Nemo.')); }
    if (url.searchParams.getAll('state').length !== 1 || !safeEqual(url.searchParams.get('state'), state)) return reply(res, 403, 'This authorization state is invalid. Open sign-in from Nemo.');
    used = true;
    if (url.searchParams.has('error')) { reply(res, 400, 'Gmail access was not granted. Return to Nemo.'); return finish(problem('GMAIL_AUTH_DENIED', 'Gmail access was not granted. You can try again in Nemo.')); }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || typeof code !== 'string' || !code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) { reply(res, 400, 'The authorization callback did not contain a usable code.'); return finish(problem('GMAIL_AUTH_CODE', 'Google did not return a usable authorization code.')); }
    try {
      await check();
      const response = await google(fetchImpl, TOKEN_URL, { ...formOptions({ client_id: config.client_id, ...(config.client_secret ? { client_secret: config.client_secret } : {}), code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }), signal: controller.signal }, 'authorization');
      await check();
      const record = tokenRecord(response, config, now);
      const profile = await google(fetchImpl, `${API_URL}/profile?fields=emailAddress`, { ...bearer(record.accessToken), signal: controller.signal }, 'account');
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw problem('GMAIL_PROFILE', 'Google did not identify the connected account. Try again.');
      record.account = profile.emailAddress;
      await check();
      if (saveRecord) await saveRecord(record, config.client_id);
      else {
        const previous = await store.load();
        try { await store.save(record); await check(); }
        catch (error) { if (previous) await store.save(previous); else await store.remove(); throw error; }
      }
      reply(res, 200, 'Gmail connected with read-only access. You can close this tab and return to Nemo.');
      finish(null, { configured: true, connected: true, ...(record.account ? { account: record.account } : {}) });
    } catch (error) {
      const failure = error instanceof GmailError ? error : problem('GMAIL_CONNECT_FAILED', 'Gmail could not be connected. Try again in Nemo.');
      // Both the system-browser callback and the initiating Nemo device show
      // the same safe reason. Never print or persist the callback URL or code.
      reply(res, 502, failure.message);
      finish(failure);
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
  timer = setTimeout(() => finish(problem('GMAIL_AUTH_TIMEOUT', 'Gmail authorization expired. Try again in Nemo.')), timeoutMs);
  const authorization = new URL(AUTH_URL);
  for (const [key, value] of Object.entries({ client_id: config.client_id, redirect_uri: redirectUri, response_type: 'code', scope: GMAIL_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' })) authorization.searchParams.set(key, value);
  return { authorizationUrl: authorization.href, redirectUri, expiresAt, completed, async cancel() { finish(problem('GMAIL_AUTH_CANCELLED', 'Gmail authorization was cancelled.')); } };
}

function webClientConfig(json, publicOrigin = '') {
  const web = json?.web;
  if (!web || typeof web !== 'object' || !/^[A-Za-z0-9._-]{1,240}\.apps\.googleusercontent\.com$/.test(web.client_id || '') || !validToken(web.client_secret) || !Array.isArray(web.redirect_uris) || !web.redirect_uris.length || web.redirect_uris.length > 20) throw problem('GMAIL_WEB_CONFIG', 'Use a Google Web application OAuth client JSON with a registered Nemo callback.');
  for (const value of web.redirect_uris) {
    let url;
    try { url = new URL(value); } catch { throw problem('GMAIL_WEB_CONFIG', 'The Google Web client has an invalid redirect address.'); }
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    const approved = url.protocol === 'https:' && (/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/i.test(url.hostname) || url.origin === publicOrigin);
    if ((!local && !approved) || url.username || url.password || url.search || url.hash || url.pathname !== '/oauth/gmail/callback' || url.href !== value) throw problem('GMAIL_WEB_CONFIG', 'Register the exact configured Nemo HTTPS /oauth/gmail/callback address. Localhost is allowed for development only.');
  }
  return { kind: 'web', client_id: web.client_id, client_secret: web.client_secret, redirect_uris: [...new Set(web.redirect_uris)], ...(publicOrigin ? { nemoOrigin: publicOrigin } : {}) };
}

async function readGmailWebConfig({ dataDir, store }) {
  const saved = await store.load();
  return saved ? webClientConfig({ web: saved }, saved.nemoOrigin || '') : null;
}

/** Import only a file explicitly selected by the PC owner. Desktop grants and
 * token files remain untouched. Web client secrets receive DPAPI protection. */
export async function installGmailWebClient({ dataDir, clientPath, store, publicOrigin = '' }) {
  let config;
  try {
    if ((await stat(clientPath)).size > 65_536) throw new Error();
    config = webClientConfig(JSON.parse(await readFile(clientPath, 'utf8')), publicOrigin);
  } catch (error) { if (error instanceof GmailError) throw error; throw problem('GMAIL_WEB_CONFIG', 'The selected Web application client JSON could not be read.'); }
  await (store || createSecretStore({ dataDir, name: 'google-web-client.dpapi' })).save(config);
  return { configured: true, redirectUris: config.redirect_uris };
}
