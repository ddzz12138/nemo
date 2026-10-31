import { randomBytes, randomUUID, webcrypto, createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson, publicProfile } from './profile-store.mjs';
import { createSecretStore } from './secrets.mjs';
import { validatePublicOrigin } from './config.mjs';
import { createHostMailbox } from './phone-link-mailbox.mjs';
import { phoneAppOrigin } from '../public/phone-link-setup.js';
import { LINK_APP_ID, LINK_DEFAULT_RELAYS, LINK_MAX_RESPONSE, LINK_REQUEST_AGE, relayUrls, publicKey, keyId, linkDescriptor, channelBinding, transcript, signProof, verifyProof, encode64, validateRequest, linkError } from '../public/phone-link-protocol.js';

const fail = (code, text, status = 409) => { throw linkError(code, text, status); };
const envelope = error => ({ error: { code: error.code || 'LINK_UNAVAILABLE', message: error.status ? error.message : 'The phone connection could not finish this request.', status: error.status || 503 } });
const nonces = () => randomBytes(32).toString('hex');
const defaultSettings = () => ({ version: 1, enabled: false, appOrigin: '', relays: [...LINK_DEFAULT_RELAYS] });

export function validateTurn(input) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['urls','sharedSecret'].includes(key)) || !Array.isArray(input.urls) || !input.urls.length || input.urls.length > 3 || typeof input.sharedSecret !== 'string' || input.sharedSecret.length < 32 || input.sharedSecret.length > 512 || /[\0\r\n]/.test(input.sharedSecret)) fail('LINK_TURN', 'Enter a TURN REST shared secret and one to three relay addresses.', 400);
  for (const url of input.urls) if (typeof url !== 'string' || !/^turns?:[a-z0-9.-]+:\d{2,5}\?transport=(udp|tcp)$/i.test(url) || Number(url.match(/:(\d+)\?/)[1]) > 65535) fail('LINK_TURN', 'Use turn:host:port?transport=udp or turns:host:port?transport=tcp.', 400);
  return { urls: [...new Set(input.urls)], sharedSecret: input.sharedSecret };
}
export function turnGrant(turn, id, now, ttl = 600) {
  if (!turn) return { expiresAt: now + ttl * 1000, iceServers: [] };
  const expires = Math.floor(now / 1000) + ttl;
  const username = `${expires}:nemo-${id}`;
  return { expiresAt: expires * 1000, iceServers: [{ urls: turn.urls, username, credential: createHmac('sha1', turn.sharedSecret).update(username).digest('base64') }] };
}

/** Private transport controller. Disabled installations create no discovery sockets. */
export async function verifyPhoneFrontend(origin, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(origin + '/phone-app.json', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(7000) });
    if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) return false;
    let text = ''; for await (const chunk of response.body) { text += new TextDecoder().decode(chunk); if (text.length > 2048) return false; }
    const value = JSON.parse(text); return value.service === 'nemo-phone-app' && value.protocol === 1 && value.static === true;
  } catch { return false; }
}
export async function createPhoneLink({ dataDir, profiles, dispatch, now = Date.now, secretStore = createSecretStore({ dataDir, name: 'phone-link.dpapi' }), runtimeFactory, mailboxFactory, verifyFrontend = verifyPhoneFrontend } = {}) {
  const settingsPath = join(dataDir, 'phone-link.json');
  let settings = await readJson(settingsPath, defaultSettings());
  if (settings?.version !== 1 || typeof settings.enabled !== 'boolean') throw new Error('Preserve phone-link.json before repairing phone access.');
  settings = { ...settings, appOrigin: validatePublicOrigin(settings.appOrigin), relays: relayUrls(settings.relays) };
  let protectedState, hostSigningKey, runtime, mailbox, closed = false, chain = Promise.resolve(), startupError = false;
  const rooms = new Map(), requests = new Set();
  let sweepTimer, refreshTimer, maintaining;
  const serial = operation => { const task = chain.catch(() => {}).then(operation); chain = task.catch(() => {}); return task; };
  async function unlock() {
    if (protectedState) return;
    const saved = await secretStore.load();
    if (saved && (saved.version !== 1 || !Array.isArray(saved.links))) throw new Error('The protected phone connection is unavailable.');
    let candidate = saved;
    if (!candidate) {
      const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
      candidate = { version: 1, hostPrivateKey: await webcrypto.subtle.exportKey('jwk', pair.privateKey), hostPublicKey: publicKey(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), links: [], turn: null };
      await secretStore.save(candidate);
    }
    const signingKey = await webcrypto.subtle.importKey('jwk', candidate.hostPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    protectedState = candidate; hostSigningKey = signingKey;
  }
  const persist = () => secretStore.save(protectedState);
  async function active(record) {
    if (!settings.enabled || closed) return false;
    if (record.deviceId) return !!await profiles.deviceActive(record.deviceId, record.profileId);
    if (record.expiresAt <= now()) return false;
    try { return (await profiles.previewInvite(record.code)).profile.id === record.profileId; } catch { return false; }
  }
  async function getRuntime() {
    if (!runtime) runtime = runtimeFactory ? await runtimeFactory() : await (async () => {
      const [{ joinRoom, selfId }, { RTCPeerConnection }] = await Promise.all([import('@trystero-p2p/nostr'), import('werift')]);
      return { selfId, joinRoom: (config, id, callbacks) => joinRoom({ ...config, rtcPolyfill: RTCPeerConnection }, id, callbacks) };
    })();
    return runtime;
  }
  async function openRoom(record) {
    if (rooms.has(record.id) || !await active(record)) return;
    const wire = await getRuntime();
    if (closed || !settings.enabled || rooms.has(record.id)) return;
    const grants = turnGrant(protectedState.turn, record.id, now());
    const room = wire.joinRoom({ appId: LINK_APP_ID, password: record.password,
      ...(grants.iceServers.length ? { turnConfig: grants.iceServers } : {}),
      relayConfig: { urls: settings.relays, manualReconnection: true, warnOnRelayFailure: false } }, record.room,
      { onJoinError() { startupError = true; } });
    const peers = new Map(), controllers = new Set();
    const binding = peerId => JSON.stringify(channelBinding(room.getPeers()[peerId],true));
    const chunks = room.makeAction('nemo-chunk', { kind: 'request' });
    const entry = { room, peers, controllers, record, grantExpiresAt: grants.expiresAt };
    rooms.set(record.id, entry);
    room.onPeerLeave = peerId => {
      peers.delete(peerId);
      for (const controller of controllers) if (controller.peerId === peerId) controller.abort();
    };
    room.makeAction('nemo-auth', { kind: 'request', onRequest: async (input, { peerId }) => {
      try {
        if (!await active(record)) fail('LINK_REVOKED', 'This invitation or phone access has expired.', 401);
        if (input?.kind === 'hello') {
          if (peers.size >= 4 && !peers.has(peerId)) fail('LINK_BUSY', 'Close another Nemo tab before connecting.', 429);
          const key = publicKey(input.clientKey);
          if (record.clientKey && keyId(record.clientKey) !== keyId(key)) fail('LINK_DEVICE', 'This invitation has already connected another device.', 401);
          const challenge = nonces();
          const certificates=channelBinding(room.getPeers()[peerId],true);
          const value = transcript({ id: record.id, clientPeer: peerId, hostPeer: wire.selfId, nonce: input.nonce, challenge, clientKey: key,...certificates });
          peers.set(peerId, { key, value, binding:JSON.stringify(certificates), challenge, expiresAt: now() + 15000, authenticated: false });
          return { challenge, signature: await signProof(webcrypto, hostSigningKey, value), serverTime: now() };
        }
        const peer = peers.get(peerId);
        if (input?.kind !== 'prove' || !peer || peer.expiresAt < now() || peer.used) fail('LINK_PROOF', 'This connection check expired.', 401);
        peer.used = true;
        if(binding(peerId)!==peer.binding)fail('LINK_CHANNEL','This encrypted connection changed. Reconnect before continuing.',401);
        if (record.clientKey && keyId(record.clientKey) !== keyId(peer.key)) fail('LINK_DEVICE', 'This invitation has already connected another device.', 401);
        if (!await verifyProof(webcrypto, peer.key, input.signature, peer.value)) fail('LINK_PROOF', 'This device could not be verified.', 401);
        peer.authenticated = true;
        startupError = false;
        return { authenticated: true, paired: !!record.deviceId, serverTime: now() };
      } catch (error) { return envelope(error); }
    } });
    room.makeAction('nemo-cancel', { onMessage: (input, { peerId }) => {
      for (const controller of controllers) if (controller.peerId === peerId && controller.requestId === input?.id) controller.abort();
    } });
    room.makeAction('nemo-http', { kind: 'request', onRequest: async (input, { peerId }) => {
      try {
        const peer = peers.get(peerId);
        if (!peer?.authenticated || !await active(record)) fail('LINK_AUTH', 'Reconnect this phone before continuing.', 401);
        if(binding(peerId)!==peer.binding)fail('LINK_CHANNEL','This encrypted connection changed. Reconnect before continuing.',401);
        if (record.clientKey && keyId(record.clientKey) !== keyId(peer.key)) fail('LINK_DEVICE', 'This invitation has already connected another device.', 401);
        const request = validateRequest(input, now());
        if (request.path.split('?')[0] === '/api/pair/preview' && request.method === 'POST' && !record.deviceId) {
          const parsed = JSON.parse(request.body || '{}');
          if (parsed.code !== record.code) fail('PAIR_INVALID', 'Use the invitation shown on the host.', 401);
          return { status: 200, body: JSON.stringify(await profiles.previewInvite(record.code)), headers: { 'content-type': 'application/json' } };
        }
        if (request.path === '/api/pair' && request.method === 'POST' && !record.deviceId) {
          return await serial(async () => {
            if (record.deviceId || !await active(record)) fail('PAIR_INVALID', 'This invitation has already been used.', 401);
            const parsed = JSON.parse(request.body || '{}');
            if (parsed.code !== record.code || parsed.expectedProfileId !== record.profileId) fail('PAIR_CHANGED', 'Confirm the person shown in your invitation.', 409);
            const result = await profiles.redeem(record.code, parsed.deviceName || 'Personal phone', record.profileId);
            record.deviceId = result.device.id; record.clientKey = peer.key; delete record.code;
            try { await persist(); } catch (error) { await profiles.revoke(result.device.id); throw error; }
            return { status: 200, body: JSON.stringify({ authenticated: true, profile: result.profile, device: result.device }), headers: { 'content-type': 'application/json' } };
          });
        }
        if (!record.deviceId) {
          if (request.method === 'GET' && request.path === '/api/session') return { status: 200, body: '{"authenticated":false}', headers: { 'content-type': 'application/json' } };
          fail('LINK_AUTH', 'Confirm your personal invitation before continuing.', 401);
        }
        const auth = await profiles.authenticateDevice(record.deviceId);
        if (!auth || auth.profile.id !== record.profileId) fail('LINK_REVOKED', 'This phone was signed out. Ask for a new invitation.', 401);
        if (request.expectedProfile && request.expectedProfile !== auth.profile.id) fail('PROFILE_CHANGED', 'The signed-in profile changed. Reload Nemo.', 409);
        if (controllers.size >= 12 || requests.size >= 64) fail('LINK_BUSY', 'Nemo has too many open requests. Try again shortly.', 429);
        if (request.method === 'POST') await serial(async () => {
          const digest = createHash('sha256').update(JSON.stringify([request.method,request.path,request.body])).digest('hex');
          record.receipts = (record.receipts || []).filter(item => now() - item.at < LINK_REQUEST_AGE * 2);
          if (record.receipts.some(item => item.id === request.id)) fail('LINK_RECONCILE', 'This action may already have completed. Refresh its saved result before trying again.', 409);
          if (record.receipts.length >= 40) fail('LINK_BUSY', 'Wait a moment before sending more actions.', 429);
          record.receipts.push({ id: request.id, digest, at: now() });
          await persist();
        });
        const controller = new AbortController(); controller.peerId = peerId; controller.requestId = request.id;
        controllers.add(controller); requests.add(controller);
        let response;
        try { response = await dispatch({ ...request, deviceId: record.deviceId, signal: controller.signal }); }
        catch (error) { controllers.delete(controller); requests.delete(controller); throw error; }
        if (request.path === '/api/logout' && response.status === 200) {
          response.close?.(); controllers.delete(controller); requests.delete(controller);
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
        }
        void (async () => {
          let sequence = 0, total = 0;
          try {
            for await (const buffer of response.body) {
              for (let at = 0; at < buffer.length; at += 16384) {
                if (controller.signal.aborted || !await active(record) || binding(peerId)!==peer.binding) throw new Error('Connection closed.');
                const part = buffer.subarray(at, at + 16384); total += part.length;
                if (total > LINK_MAX_RESPONSE) throw new Error('Response is too large.');
                const ack = await chunks.request({ id: request.id, seq: sequence++, data: encode64(part) }, { target: peerId, timeoutMs: 15000 });
                if (ack?.ok !== true) throw new Error('Phone stopped receiving.');
              }
            }
            await chunks.request({ id: request.id, seq: sequence, end: true }, { target: peerId, timeoutMs: 5000 });
          } catch {
            controller.abort();
            await chunks.request({ id: request.id, seq: sequence, error: 'Connection interrupted. Read the saved result before retrying an action.' }, { target: peerId, timeoutMs: 1000 }).catch(() => {});
          } finally { controllers.delete(controller); requests.delete(controller); response.close?.(); }
        })();
        return { status: response.status, headers: response.headers, stream: true };
      } catch (error) { return envelope(error); }
    } });
  }
  function stopRoom(id) {
    const entry = rooms.get(id); if (!entry) return;
    for (const controller of entry.controllers) controller.abort();
    entry.room.leave(); rooms.delete(id);
  }
  async function maintainRooms() {
    if (!settings.enabled || closed) return;
    for (const record of protectedState.links) {
      if (!await active(record)) stopRoom(record.id);
      else {
        const entry = rooms.get(record.id);
        if (entry && protectedState.turn && entry.grantExpiresAt - now() < 90000) stopRoom(record.id);
        await openRoom(record);
      }
    }
  }
  async function maintain() {
    if (maintaining) return maintaining;
    const task = maintainRooms(); maintaining = task;
    try { await task; } finally { if (maintaining === task) maintaining = null; }
  }
  async function start() {
    await unlock(); await getRuntime();
    mailbox = await (mailboxFactory || createHostMailbox)({ settings, links: () => protectedState.links, active, hostSigningKey, hostPublicKey: protectedState.hostPublicKey, grant: id => turnGrant(protectedState.turn, id, now()), now });
    await maintain();
    sweepTimer = setInterval(() => void maintain().catch(() => { startupError = true; }), 15000); sweepTimer.unref?.();
  }
  const api = {
    status() { const stable=settings.appOrigin?phoneAppOrigin(settings.appOrigin):'',needsAddressUpdate=!!stable&&stable!==settings.appOrigin;return { enabled: settings.enabled, appOrigin: settings.appOrigin, suggestedAppOrigin:needsAddressUpdate?stable:'',needsAddressUpdate,relays: [...settings.relays], relayConfigured: protectedState ? !!protectedState.turn : settings.relayConfigured === true,
      state: !settings.enabled ? 'disabled' : startupError ? 'degraded' : rooms.size ? 'listening' : 'ready-for-invitation',
      connectedDevices: [...rooms.values()].filter(entry => entry.record.deviceId && [...entry.peers.values()].some(peer => peer.authenticated)).length,
      message: !settings.enabled ? 'Phone access is off.' : startupError ? 'Discovery or the connection needs attention. Your saved work stays on the host.' : needsAddressUpdate ? 'Update the phone app address so new invitations receive interface updates. Existing phone access is preserved.' : 'Keep the host awake. Direct connections depend on the network; relay fallback requires setup.' }; },
    async configure(input) { return serial(async () => {
      if (!input || Object.keys(input).some(key => !['appOrigin','relays','turn'].includes(key))) fail('LINK_CONFIG', 'Use the phone connection setup controls.', 400);
      if (settings.enabled && Object.keys(input).some(key => key !== 'appOrigin')) fail('LINK_RUNNING', 'Turn phone access off before changing discovery or relay settings.');
      let origin;
      try { origin = phoneAppOrigin(input.appOrigin || ''); } catch (error) { fail('LINK_ORIGIN', error.message, 400); }
      if (!origin) fail('LINK_ORIGIN', 'Set the HTTPS address serving the Nemo phone app.', 400);
      if (settings.enabled) {
        if (origin !== settings.appOrigin && !await verifyFrontend(origin)) fail('LINK_FRONTEND', 'The updated phone address did not pass its Nemo readiness check. Your current connection is preserved.');
        const next = { ...settings, appOrigin: origin };
        await writeJson(settingsPath, next); settings = next; return api.status();
      }
      const next = { version: 1, enabled: false, appOrigin: origin, relays: relayUrls(input.relays || settings.relays), relayConfigured: protectedState ? !!protectedState.turn : settings.relayConfigured === true };
      if (Object.hasOwn(input,'turn')) {
        const turn = validateTurn(input.turn); await unlock(); const previous = protectedState.turn; protectedState.turn = turn;
        try { await persist(); } catch (error) { protectedState.turn = previous; throw error; }
        next.relayConfigured = !!turn;
      }
      await writeJson(settingsPath, next); settings = next; return api.status();
    }); },
    async enable() { return serial(async () => {
      if (closed) fail('LINK_CLOSED', 'Nemo is closing.');
      if (!settings.appOrigin) fail('LINK_SETUP', 'Configure the phone app HTTPS address first.');
      if (settings.enabled) return api.status();
      if (!await verifyFrontend(settings.appOrigin)) fail('LINK_FRONTEND', 'Serve the exported Nemo phone app at this HTTPS address first. Its phone-app.json readiness check did not pass.');
      await unlock(); settings.enabled = true;
      try { await start(); await writeJson(settingsPath, settings); }
      catch (error) { settings.enabled = false; for (const id of rooms.keys()) stopRoom(id); clearInterval(sweepTimer); await mailbox?.close(); mailbox = null; throw error; }
      return api.status();
    }); },
    async disable() { return serial(async () => {
      settings.enabled = false; clearInterval(sweepTimer); clearInterval(refreshTimer);
      for (const id of rooms.keys()) stopRoom(id); await mailbox?.close(); mailbox = null;
      await writeJson(settingsPath, settings); return api.status();
    }); },
    async invite(profileId) { return serial(async () => {
      if (!settings.enabled || closed) fail('LINK_DISABLED', 'Enable phone access before creating an invitation.');
      const invitation = await profiles.invite(profileId, 'phone-link', { ttlMs: 600000 });
      const kept = [];
      for (const record of protectedState.links) { if (await active(record)) kept.push(record); else stopRoom(record.id); }
      protectedState.links = kept;
      if (protectedState.links.length >= 64) fail('LINK_LIMIT', 'Remove an old phone connection before adding another.', 429);
      const record = { id: randomUUID(), profileId, code: invitation.code, room: nonces(), password: nonces(), expiresAt: invitation.expiresAt };
      protectedState.links.push(record); await persist();
      await openRoom(record); await mailbox?.refresh?.();
      const descriptor = { ...linkDescriptor({ v: 1, ...record, hostKey: protectedState.hostPublicKey, relays: settings.relays }), invite: invitation.code };
      const fragment = Buffer.from(JSON.stringify(descriptor)).toString('base64url');
      return { url: `${settings.appOrigin}/pair.html#phone=${fragment}`, expiresAt: invitation.expiresAt, profile: invitation.profile };
    }); },
    async close() { closed = true; clearInterval(sweepTimer); clearInterval(refreshTimer); for (const id of rooms.keys()) stopRoom(id); await chain; await maintaining; clearInterval(sweepTimer);for(const id of rooms.keys())stopRoom(id); await mailbox?.close(); },
  };
  if (settings.enabled) {
    // Address changes require the owner's explicit setup action. Starting the
    // host must preserve its selected deployment, keys and existing devices.
    try { await start(); } catch { startupError = true; }
  }
  return api;
}
