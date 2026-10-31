import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { RemoteCloudStore } from './remote-cloud-store.mjs';
import { CloudflareRemoteProvider, RemoteCloudError } from './remote-cloud-provider.mjs';
import { GoogleRemoteIdentity, remoteHash, remoteSecret } from './remote-cloud-auth.mjs';

const idPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const safeEqual = (first, second) => typeof first === 'string' && typeof second === 'string' && first.length === second.length && timingSafeEqual(Buffer.from(first), Buffer.from(second));
const fail = (code, message, status = 400) => { throw new RemoteCloudError(code, message, status); };
const authError = () => fail('unauthorized', 'Please return to Nemo and sign in again.', 401);
const iso = value => new Date(value).toISOString();
const escaped = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function remoteCloudConfigFromEnv(env = process.env) {
  const required = ['NEMO_REMOTE_ORIGIN', 'NEMO_REMOTE_DATA_FILE', 'NEMO_REMOTE_GOOGLE_CLIENT_ID', 'NEMO_REMOTE_GOOGLE_CLIENT_SECRET', 'NEMO_REMOTE_CF_ACCOUNT_ID', 'NEMO_REMOTE_CF_ZONE_ID', 'NEMO_REMOTE_CF_API_TOKEN', 'NEMO_REMOTE_DOMAIN'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Nemo remote access is not configured. Operator must set: ${missing.join(', ')}. No remote service has been started.`);
  const originUrl = new URL(env.NEMO_REMOTE_ORIGIN);
  if (originUrl.protocol !== 'https:' || originUrl.pathname !== '/' || originUrl.search || originUrl.hash || originUrl.username || originUrl.password) throw new Error('NEMO_REMOTE_ORIGIN must be the exact HTTPS origin of this hosted service.');
  const allowedEmails = (env.NEMO_REMOTE_ALLOWED_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowedEmails.length && env.NEMO_REMOTE_PUBLIC_SIGNUP !== '1') throw new Error('Set NEMO_REMOTE_ALLOWED_EMAILS for the pilot, or explicitly opt in to public signup with NEMO_REMOTE_PUBLIC_SIGNUP=1 after setting up edge abuse controls.');
  const port = Number(env.NEMO_REMOTE_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NEMO_REMOTE_PORT must be a valid TCP port.');
  return {
    origin: originUrl.origin, dataFile: resolve(env.NEMO_REMOTE_DATA_FILE), host: env.NEMO_REMOTE_BIND || '127.0.0.1', port,
    allowedEmails, publicSignup: env.NEMO_REMOTE_PUBLIC_SIGNUP === '1',
    google: { clientId: env.NEMO_REMOTE_GOOGLE_CLIENT_ID, clientSecret: env.NEMO_REMOTE_GOOGLE_CLIENT_SECRET, redirectUri: `${originUrl.origin}/auth/google/callback` },
    cloudflare: { accountId: env.NEMO_REMOTE_CF_ACCOUNT_ID, zoneId: env.NEMO_REMOTE_CF_ZONE_ID, apiToken: env.NEMO_REMOTE_CF_API_TOKEN, domain: env.NEMO_REMOTE_DOMAIN.trim().toLowerCase() },
  };
}

function publicInstallation(record) {
  return { installationId: record.installationId, status: record.status, publicOrigin: `https://${record.hostname}`, tunnelId: record.tunnelId || null, updatedAt: record.updatedAt, ...(record.lastError ? { error: { code: record.lastError, message: record.status === 'retiring' ? 'Remote access is off on this computer. Nemo is still confirming that the online connection has been removed.' : 'Nemo could not finish the secure connection. Please try again.' } } : {}) };
}

export class RemoteCloudService {
  #locks = new Map();
  constructor({ store, provider, identity, origin, domain, now = Date.now, allowedEmails = [], publicSignup = false, maxInstallationsPerOwner = 3, maxInstallations = 1000, maxPendingEnrollments = 1000, maxEnrollmentRecords = 10000 }) {
    if (!store || !provider || !identity || !origin?.startsWith('https://') || !domain) throw new Error('The remote service requires durable storage, a real provisioning adapter, verified identity, an HTTPS origin and an owned domain.');
    Object.assign(this, { store, provider, identity, origin, domain, now, allowedEmails, publicSignup, maxInstallationsPerOwner, maxInstallations, maxPendingEnrollments, maxEnrollmentRecords });
  }
  async rateLimit(key, { maximum = 60, windowMs = 60000 } = {}) {
    await this.store.transaction(state => {
      const now = this.now();
      // Keep only live windows, so anonymous requests cannot grow storage indefinitely.
      for (const [id, item] of Object.entries(state.limits)) if (item.until <= now) delete state.limits[id];
      const id = remoteHash(key);
      const item = state.limits[id] || { count: 0, until: now + windowMs };
      if (item.count >= maximum) fail('too_many_requests', 'Please wait a moment, then try again.', 429);
      item.count++; state.limits[id] = item;
    });
  }
  async beginEnrollment({ installationId, installationSecret, displayName = 'My computer' }) {
    if (!idPattern.test(installationId || '') || !/^[a-z\d_-]{43,128}$/i.test(installationSecret || '') || Buffer.from(installationSecret, 'base64url').length < 32) fail('invalid_installation', 'Nemo needs a new secure installation identity. Please restart setup.');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) fail('invalid_name', 'Please give this computer a short, readable name.');
    const now = this.now(), hash = remoteHash(installationSecret);
    const enrollment = await this.store.transaction(state => {
      const installation = state.installations[installationId];
      if (installation && !safeEqual(installation.secretHash, hash)) authError();
      const prior = Object.values(state.enrollments).find(item => item.installationId === installationId);
      // The first credential reserves the identity even after expiry; a new computer gets a new UUID.
      if (prior && !safeEqual(prior.secretHash, hash)) authError();
      if (prior && (prior.status === 'approved' || prior.expiresAt > now)) return prior;
      if (!prior && Object.keys(state.enrollments).length >= this.maxEnrollmentRecords) fail('service_capacity', 'Nemo setup is busy. Please try again a little later.', 503);
      const pending = Object.values(state.enrollments).filter(item => item.status === 'pending' && item.expiresAt > now);
      if (pending.length >= this.maxPendingEnrollments) fail('service_capacity', 'Nemo setup is busy. Please try again a little later.', 503);
      if (prior) delete state.enrollments[prior.enrollmentId];
      const item = { enrollmentId: randomUUID(), browserCode: remoteSecret(), installationId, secretHash: hash, displayName: displayName.trim(), confirmationCode: String(randomInt(100000, 1000000)), status: installation ? 'approved' : 'pending', createdAt: now, expiresAt: now + 15 * 60000 };
      state.enrollments[item.enrollmentId] = item;
      return item;
    });
    return this.enrollmentResponse(enrollment);
  }
  enrollmentResponse(enrollment) {
    return { enrollmentId: enrollment.enrollmentId, installationId: enrollment.installationId, status: enrollment.status, browserUrl: enrollment.status === 'pending' ? `${this.origin}/connect?code=${encodeURIComponent(enrollment.browserCode)}` : null, confirmationCode: enrollment.confirmationCode, expiresAt: iso(enrollment.expiresAt), pollAfterMs: 3000 };
  }
  async pollEnrollment(enrollmentId, secret) {
    const item = await this.store.read(state => state.enrollments[enrollmentId]);
    if (!item || !safeEqual(item.secretHash, remoteHash(secret))) authError();
    if (item.status !== 'approved' && item.expiresAt <= this.now()) fail('enrollment_expired', 'Sign-in took a little too long. Please start sign-in again in Nemo.', 410);
    const { browserUrl, ...response } = this.enrollmentResponse(item);
    return response;
  }
  async enrollmentByCode(code) {
    if (typeof code !== 'string' || !/^[a-z\d_-]{43}$/i.test(code)) fail('enrollment_expired', 'This setup link has expired. Please open Nemo on your computer and start again.', 410);
    const item = await this.store.read(state => Object.values(state.enrollments).find(enrollment => safeEqual(enrollment.browserCode, code)));
    if (!item || item.expiresAt <= this.now() || item.status !== 'pending') fail('enrollment_expired', 'This setup link has expired or was already used. Please return to Nemo on your computer.', 410);
    return item;
  }
  async startSignIn(browserCode) {
    const enrollment = await this.enrollmentByCode(browserCode);
    const stateCode = remoteSecret(), browserBinding = remoteSecret(), nonce = remoteSecret(), verifier = remoteSecret();
    const authorizationUrl = await this.identity.authorizationUrl({ state: stateCode, nonce, verifier });
    await this.store.transaction(state => {
      for (const [key, item] of Object.entries(state.oauth)) if (item.expiresAt <= this.now()) delete state.oauth[key];
      state.oauth[remoteHash(stateCode)] = { enrollmentId: enrollment.enrollmentId, bindingHash: remoteHash(browserBinding), nonce, verifier, expiresAt: this.now() + 10 * 60000 };
    });
    return { authorizationUrl, browserBinding };
  }
  async finishSignIn({ state: stateCode, browserBinding, code }) {
    if (typeof stateCode !== 'string' || !browserBinding) authError();
    const pending = await this.store.transaction(state => {
      const key = remoteHash(stateCode), item = state.oauth[key];
      if (!item || item.expiresAt <= this.now() || !safeEqual(item.bindingHash, remoteHash(browserBinding))) authError();
      delete state.oauth[key]; // OAuth codes/state are never replayable after exchange begins.
      return item;
    });
    const owner = await this.identity.exchange({ code, nonce: pending.nonce, verifier: pending.verifier });
    if (!owner?.ownerId || typeof owner.ownerId !== 'string' || owner.ownerId.length > 300) authError();
    if (!this.publicSignup && (!owner.email || !this.allowedEmails.includes(owner.email.toLowerCase()))) fail('signup_not_enabled', 'This Nemo preview is available to invited families. Please contact the person who invited you.', 403);
    const sessionToken = remoteSecret(), csrf = remoteSecret();
    await this.store.transaction(state => {
      for (const [key, item] of Object.entries(state.sessions)) if (item.expiresAt <= this.now()) delete state.sessions[key];
      state.sessions[remoteHash(sessionToken)] = { ownerId: owner.ownerId, email: owner.email || null, enrollmentId: pending.enrollmentId, csrfHash: remoteHash(csrf), expiresAt: this.now() + 60 * 60000 };
    });
    // CSRF is in a separate readable cookie; it is checked against the server-side session hash.
    return { sessionToken, csrf, enrollmentId: pending.enrollmentId };
  }
  async browserSession(token) {
    const session = await this.store.read(state => state.sessions[remoteHash(token)]);
    if (!session || session.expiresAt <= this.now()) authError();
    return session;
  }
  async confirmation(enrollmentId, sessionToken) {
    const session = await this.browserSession(sessionToken);
    if (session.enrollmentId !== enrollmentId) authError();
    const item = await this.store.read(state => state.enrollments[enrollmentId]);
    if (!item || item.expiresAt <= this.now()) fail('enrollment_expired', 'This setup link has expired. Please return to Nemo and start again.', 410);
    if (item.status === 'approved' && item.ownerId !== session.ownerId) authError();
    return { enrollment: item, session };
  }
  async approveEnrollment(enrollmentId, sessionToken, csrf) {
    const { session } = await this.confirmation(enrollmentId, sessionToken);
    if (!safeEqual(session.csrfHash, remoteHash(csrf))) authError();
    return this.store.transaction(state => {
      const item = state.enrollments[enrollmentId];
      if (!item || item.expiresAt <= this.now()) fail('enrollment_expired', 'Please return to Nemo and start sign-in again.', 410);
      const existing = state.installations[item.installationId];
      if (existing && (existing.ownerId !== session.ownerId || existing.secretHash !== item.secretHash)) authError();
      if (item.status === 'approved' && item.ownerId !== session.ownerId) authError();
      if (!existing) {
        const installations = Object.values(state.installations);
        if (installations.filter(record => record.status !== 'retired' && record.ownerId === session.ownerId).length >= this.maxInstallationsPerOwner) fail('computer_limit', 'Your family already has the maximum number of connected computers. Remove an old computer before adding another.', 409);
        if (installations.filter(record => record.status !== 'retired').length >= this.maxInstallations) fail('service_capacity', 'Nemo setup is busy. Please try again a little later.', 503);
        const daily = installations.filter(record => record.ownerId === session.ownerId && record.createdAt > this.now() - 86400000);
        if (daily.length >= 10) fail('computer_limit', 'Too many computers were added today. Please try again tomorrow.', 429);
        const time = iso(this.now());
        state.installations[item.installationId] = { installationId: item.installationId, ownerId: session.ownerId, secretHash: item.secretHash, displayName: item.displayName, hostname: `host-${randomBytes(16).toString('hex')}.${this.domain}`, tunnelName: `nemo-${randomUUID()}`, tunnelId: null, dnsId: null, status: 'reserved', createdAt: this.now(), updatedAt: time };
      }
      item.status = 'approved'; item.ownerId = session.ownerId;
      return { installationId: item.installationId, status: 'approved' };
    });
  }
  async installation(installationId, secret) {
    if (!idPattern.test(installationId || '') || typeof secret !== 'string' || secret.length > 128) authError();
    const item = await this.store.read(state => state.installations[installationId]);
    if (!item || !safeEqual(item.secretHash, remoteHash(secret))) authError();
    return item;
  }
  async getInstallation(installationId, secret) { return publicInstallation(await this.installation(installationId, secret)); }
  async locked(installationId, callback) {
    const previous = this.#locks.get(installationId) || Promise.resolve();
    const task = previous.catch(() => {}).then(callback);
    this.#locks.set(installationId, task);
    try { return await task; } finally { if (this.#locks.get(installationId) === task) this.#locks.delete(installationId); }
  }
  async checkpoint(installationId, operationId, phase, fields = {}) {
    return this.store.transaction(state => {
      const item = state.installations[installationId];
      Object.assign(item, fields, { updatedAt: iso(this.now()) });
      Object.assign(state.operations[operationId], { phase, updatedAt: iso(this.now()) });
      return item;
    });
  }
  async operation(installationId, kind) {
    return this.store.transaction(state => {
      const item = state.installations[installationId];
      const prior = item.operationId && state.operations[item.operationId];
      if (prior && prior.kind === kind && prior.status !== 'complete') {
        prior.status = 'running'; prior.attempts++; prior.updatedAt = iso(this.now()); item.lastError = null;
        return prior.operationId;
      }
      if (kind === 'enable' && Object.values(state.operations).filter(operation => operation.ownerId === item.ownerId && operation.kind === 'enable' && Date.parse(operation.createdAt) > this.now() - 86400000).length >= 10) fail('connection_limit', 'Remote access was set up too many times today. Please try again tomorrow.', 429);
      if (kind === 'enable' && item.status === 'retired') {
        const installations = Object.values(state.installations).filter(record => record.status !== 'retired');
        if (installations.filter(record => record.ownerId === item.ownerId).length >= this.maxInstallationsPerOwner) fail('computer_limit', 'Your family already has the maximum number of connected computers. Turn off an old connection before reconnecting this one.', 409);
        if (installations.length >= this.maxInstallations) fail('service_capacity', 'Nemo setup is busy. Please try again a little later.', 503);
        // Reserve capacity in the same transaction, including concurrent reconnects.
        item.status = 'provisioning'; item.tunnelId = null; item.dnsId = null; item.tunnelName = `nemo-${randomUUID()}`;
      }
      const operationId = randomUUID(), time = iso(this.now());
      state.operations[operationId] = { operationId, installationId, ownerId: item.ownerId, kind, phase: 'reserved', status: 'running', attempts: 1, createdAt: time, updatedAt: time };
      item.operationId = operationId; item.lastError = null;
      return operationId;
    });
  }
  async operationFailure(installationId, operationId, kind, error) {
    await this.store.transaction(state => {
      const code = error instanceof RemoteCloudError ? error.code : 'service_unavailable';
      Object.assign(state.operations[operationId], { status: 'error', error: code, updatedAt: iso(this.now()) });
      Object.assign(state.installations[installationId], { status: kind === 'retire' ? 'retiring' : 'error', lastError: code, updatedAt: iso(this.now()) });
    });
    if (error instanceof RemoteCloudError) throw error;
    throw new RemoteCloudError('service_unavailable', 'Nemo could not finish the secure connection. Please try again.');
  }
  async complete(installationId, operationId, status) {
    return this.store.transaction(state => {
      Object.assign(state.operations[operationId], { status: 'complete', phase: 'complete', updatedAt: iso(this.now()) });
      const item = state.installations[installationId];
      Object.assign(item, { status, lastError: null, updatedAt: iso(this.now()) });
      return publicInstallation(item);
    });
  }
  async enable(installationId, secret) {
    await this.installation(installationId, secret);
    return this.locked(installationId, async () => {
      let record = await this.installation(installationId, secret);
      if (record.status === 'retiring') fail('retirement_pending', 'Nemo is still removing the previous connection. Please finish turning it off before reconnecting.', 409);
      if (record.status === 'active') return { ...publicInstallation(record), connectorToken: await this.provider.getToken(record) };
      const operationId = await this.operation(installationId, 'enable');
      try {
        if (record.status === 'retired') record = await this.checkpoint(installationId, operationId, 'reserved', { tunnelId: null, dnsId: null });
        record = await this.checkpoint(installationId, operationId, 'tunnel_creating', { status: 'provisioning' });
        const tunnelId = await this.provider.ensureTunnel(record);
        record = await this.checkpoint(installationId, operationId, 'tunnel_created', { tunnelId });
        await this.provider.configure(record);
        await this.checkpoint(installationId, operationId, 'ingress_configured');
        const dnsId = await this.provider.ensureDns(record);
        record = await this.checkpoint(installationId, operationId, 'dns_created', { dnsId });
        const connectorToken = await this.provider.getToken(record);
        return { ...await this.complete(installationId, operationId, 'active'), connectorToken };
      } catch (error) { return this.operationFailure(installationId, operationId, 'enable', error); }
    });
  }
  async credentials(installationId, secret) {
    await this.installation(installationId, secret);
    return this.locked(installationId, async () => {
      const record = await this.installation(installationId, secret);
      if (record.status !== 'active') fail('connection_not_ready', 'Please enable remote access in Nemo first.', 409);
      return { ...publicInstallation(record), connectorToken: await this.provider.getToken(record) };
    });
  }
  async retire(installationId, secret) {
    await this.installation(installationId, secret);
    return this.locked(installationId, async () => {
      const record = await this.installation(installationId, secret);
      if (record.status === 'retired') return publicInstallation(record);
      const operationId = await this.operation(installationId, 'retire');
      try {
        await this.checkpoint(installationId, operationId, 'retiring', { status: 'retiring' });
        await this.provider.retire(record, phase => this.checkpoint(installationId, operationId, phase));
        return await this.complete(installationId, operationId, 'retired');
      } catch (error) { return this.operationFailure(installationId, operationId, 'retire', error); }
    });
  }
}

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map(value => value.trim().split(/=(.*)/s)).filter(parts => parts.length >= 2).map(([name, value]) => [name, value]));
}
const cookie = (name, value, { age = 3600, httpOnly = true } = {}) => `${name}=${value}; Path=/; Secure; SameSite=Lax; Max-Age=${age}${httpOnly ? '; HttpOnly' : ''}`;
const bearer = request => /^Bearer ([a-z\d_-]{43,128})$/i.exec(request.headers.authorization || '')?.[1] || '';
async function body(request, form = false) {
  const type = (request.headers['content-type'] || '').split(';')[0].trim();
  if (type !== (form ? 'application/x-www-form-urlencoded' : 'application/json')) fail('invalid_content_type', 'Nemo could not read this request.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8192) fail('request_too_large', 'This request is too large.', 413); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); const value = form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail('invalid_request', 'Nemo could not read this request.'); }
}
const page = (title, content) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaped(title)} · Nemo</title><style>body{font:18px/1.6 system-ui,sans-serif;background:#f5f7fa;color:#172b35;margin:0;padding:8vh 24px}main{max-width:500px;margin:auto;background:white;border-radius:24px;padding:32px;box-shadow:0 8px 40px #172b3510}h1{font-size:28px;line-height:1.2}a,button{display:inline-block;background:#15725a;color:white;border:0;border-radius:12px;padding:14px 20px;font:inherit;text-decoration:none;cursor:pointer}small{color:#52636e}.code{font-size:36px;letter-spacing:.2em;font-weight:700}</style><main><small>Nemo · Connect your computer</small><h1>${escaped(title)}</h1>${content}</main></html>`;

export function createRemoteCloudServer({ config, store, provider, identity, service, now = Date.now, onError = () => {} } = {}) {
  config ||= remoteCloudConfigFromEnv();
  store ||= new RemoteCloudStore(config.dataFile);
  provider ||= new CloudflareRemoteProvider(config.cloudflare);
  identity ||= new GoogleRemoteIdentity(config.google);
  service ||= new RemoteCloudService({ store, provider, identity, origin: config.origin, domain: config.cloudflare.domain, allowedEmails: config.allowedEmails, publicSignup: config.publicSignup, now });
  const server = createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' };
    let url;
    const json = (status, value) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    const html = (status, value) => { response.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); response.end(value); };
    const redirect = (location, setCookie) => { response.writeHead(303, { ...headers, Location: location, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) }); response.end(); };
    try {
      url = new URL(request.url, config.origin);
      if (url.origin !== config.origin || request.url.startsWith('//')) fail('invalid_request', 'Invalid request.');
      if (request.headers.origin && request.headers.origin !== config.origin) fail('origin_forbidden', 'Please return to Nemo to continue.', 403);
      const address = request.socket.remoteAddress || 'unknown'; // Never trust client-controlled forwarding headers.
      if (url.pathname === '/health' && request.method === 'GET') return json(200, { service: 'nemo-remote', status: 'ok' });
      if (url.pathname === '/v1/enrollments' && request.method === 'POST') {
        await service.rateLimit(`enroll:${address}`, { maximum: 20, windowMs: 15 * 60000 });
        const input = await body(request);
        if (Object.keys(input).some(key => !['installationId', 'installationSecret', 'displayName'].includes(key))) fail('invalid_request', 'Nemo could not read this request.');
        return json(200, await service.beginEnrollment(input));
      }
      const poll = /^\/v1\/enrollments\/([a-f\d-]{36})\/poll$/i.exec(url.pathname);
      if (poll && request.method === 'POST') {
        await service.rateLimit(`poll:${address}`, { maximum: 120 });
        await body(request);
        return json(200, await service.pollEnrollment(poll[1], bearer(request)));
      }
      const install = /^\/v1\/installations\/([a-f\d-]{36})(?:\/(enable|credentials|retire))?$/i.exec(url.pathname);
      if (install) {
        await service.rateLimit(`installation:${address}`, { maximum: 120 });
        if (!install[2] && request.method === 'GET') return json(200, await service.getInstallation(install[1], bearer(request)));
        if (install[2] && request.method === 'POST') {
          const input = await body(request);
          if (Object.keys(input).length) fail('invalid_request', 'The secure connection uses only Nemo’s fixed local address.');
          return json(200, await service[install[2]](install[1], bearer(request)));
        }
      }
      if (url.pathname === '/connect' && request.method === 'GET') {
        const item = await service.enrollmentByCode(url.searchParams.get('code'));
        return html(200, page('Connect Nemo on your computer', `<p>You’re setting up <strong>${escaped(item.displayName)}</strong>. Sign in, then confirm the code shown in Nemo.</p><a href="/auth/google?code=${escaped(item.browserCode)}">Continue with Google</a><p><small>Your conversations and model account stay on your computer.</small></p>`));
      }
      if (url.pathname === '/auth/google' && request.method === 'GET') {
        await service.rateLimit(`signin:${address}`, { maximum: 20, windowMs: 15 * 60000 });
        const result = await service.startSignIn(url.searchParams.get('code'));
        return redirect(result.authorizationUrl, cookie('__Host-nemo_signin', result.browserBinding, { age: 600 }));
      }
      if (url.pathname === '/auth/google/callback' && request.method === 'GET') {
        const result = await service.finishSignIn({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), browserBinding: cookies(request)['__Host-nemo_signin'] });
        return redirect(`/connect/${result.enrollmentId}`, [cookie('__Host-nemo_session', result.sessionToken), cookie('__Host-nemo_csrf', result.csrf, { httpOnly: false }), cookie('__Host-nemo_signin', '', { age: 0 })]);
      }
      const confirm = /^\/connect\/([a-f\d-]{36})$/i.exec(url.pathname);
      if (confirm && request.method === 'GET') {
        const jar = cookies(request), { enrollment, session } = await service.confirmation(confirm[1], jar['__Host-nemo_session']);
        if (enrollment.status === 'approved') return html(200, page('You’re connected', '<p>Return to Nemo on your computer to finish enabling remote access.</p><p>You can close this page.</p>'));
        return html(200, page('Is this your computer?', `<p>Check that <strong>${escaped(enrollment.displayName)}</strong> shows this code in Nemo:</p><p class="code">${escaped(enrollment.confirmationCode)}</p><p>Connect this computer to ${escaped(session.email || 'your Google account')} only if the code matches.</p><form method="post" action="/connect/${confirm[1]}"><input type="hidden" name="csrf" value="${escaped(jar['__Host-nemo_csrf'] || '')}"><button type="submit">Connect this computer</button></form><p><small>Connecting registers this computer. Phone access still needs an invitation from Nemo.</small></p>`));
      }
      if (confirm && request.method === 'POST') {
        if (request.headers.origin !== config.origin) fail('origin_forbidden', 'Please return to Nemo to continue.', 403);
        const input = await body(request, true);
        await service.approveEnrollment(confirm[1], cookies(request)['__Host-nemo_session'], input.csrf);
        return redirect(`/connect/${confirm[1]}`);
      }
      return json(404, { error: { code: 'not_found', message: 'This Nemo setup page could not be found.' } });
    } catch (error) {
      const safe = error instanceof RemoteCloudError ? error : new RemoteCloudError('service_unavailable', 'Nemo setup is temporarily unavailable. Please try again.');
      onError({ code: safe.code, status: safe.status }); // Never give loggers URLs, tokens, bodies, or provider errors.
      if (url?.pathname.startsWith('/v1/') || url?.pathname === '/health') return json(safe.status, { error: { code: safe.code, message: safe.message } });
      return html(safe.status, page('Let’s try that again', `<p>${escaped(safe.message)}</p><p>You can close this page and return to Nemo.</p>`));
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  return { server, service, store };
}
