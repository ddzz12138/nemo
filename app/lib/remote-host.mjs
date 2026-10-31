import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './profile-store.mjs';
import { createSecretStore } from './secrets.mjs';
import { createCloudflaredConnector } from './remote-host-connector.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const secureOrigin = input => {
  let url; try { url = new URL(input); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw fail('REMOTE_ADDRESS', 'Nemo received an invalid remote address. Please try again.');
  return url.origin;
};
const unavailable = 'Remote access is not available in this Nemo release yet. Your chats stay on this computer.';

/** The state file contains no credentials. All installation secrets use the OS store. */
export async function createRemoteHost({ dataDir, cloud, secretStore = createSecretStore({ dataDir, name: 'remote-access.dpapi' }), connector = createCloudflaredConnector(), verifyPublic = async () => false, activateOrigin = async () => ({ ready: false }), now = Date.now, retryDelays = [1000, 2000, 4000, 8000], readinessIntervalMs = 30_000 } = {}) {
  if (!dataDir) throw new Error('Nemo needs its private data folder.');
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'remote-access.json');
  const saved = await readJson(path, null);
  if (saved && (saved.version !== 1 || !UUID.test(saved.installationId || ''))) throw new Error('Nemo could not read its remote connection. Preserve the private installation folder.');
  let record = saved || { version: 1, installationId: randomUUID(), wanted: false, publicOrigin: '', tunnelId: '', retirementPending: false };
  let protectedRecord = await secretStore.load();
  if (protectedRecord && (protectedRecord.installationId !== record.installationId || !/^[A-Za-z0-9_-]{43,256}$/.test(protectedRecord.installationSecret || ''))) throw new Error('Nemo could not unlock this installation. Reconnect on the computer where it was installed.');
  let phase = 'disabled', message = 'Use Nemo on your phone without setting up a VPN.', connected = false, applicationReady = false, localStopPending = false;
  let account = { state: protectedRecord?.approved ? 'approved' : 'signed-out' };
  let chain = Promise.resolve(), timer = null, closed = false, alive = false, restarts = 0, generation = 0;
  const bundled = await connector.available();
  if (!cloud || !bundled) { phase = 'not-configured'; message = unavailable; }
  else if (record.wanted) { phase = 'offline'; message = 'Reconnecting Nemo to your phone.'; }
  const persist = () => writeJson(path, { version: 1, installationId: record.installationId, wanted: !!record.wanted, publicOrigin: record.publicOrigin || '', tunnelId: record.tunnelId || '', retirementPending: !!record.retirementPending });
  const exclusive = action => { const next = chain.catch(() => {}).then(() => { if (closed) throw fail('HOST_CLOSED', 'Nemo is closing.'); return action(); }); chain = next.then(() => {}, () => {}); return next; };
  const cancelTimer = () => { clearTimeout(timer); timer = null; };
  const status = () => ({ phase, connected, canPair: connected && applicationReady && record.wanted && !record.retirementPending && !localStopPending, message, publicOrigin: record.publicOrigin || '', installationId: record.installationId, available: !!cloud && bundled, retirementPending: !!record.retirementPending, localStopPending, account: { ...account } });
  const schedule = (action, delay) => { cancelTimer(); if (!closed && record.wanted) { timer = setTimeout(() => { timer = null; exclusive(action).catch(() => {}); }, delay); timer.unref?.(); } };
  const requireReady = () => { if (!cloud || !bundled) throw fail('REMOTE_NOT_INCLUDED', unavailable, 503); };
  async function identity() {
    if (!protectedRecord) {
      // Persist identity before sending it. A lost cloud response must never
      // create another installation or lose proof of possession on restart.
      await persist();
      const proposed = { version: 1, installationId: record.installationId, installationSecret: randomBytes(32).toString('base64url'), approved: false };
      await secretStore.save(proposed); protectedRecord = proposed;
    }
    return { installationId: record.installationId, installationSecret: protectedRecord.installationSecret };
  }
  async function health() {
    if (closed || !alive || !record.wanted || !applicationReady) return;
    const probeGeneration = generation;
    let verified = false;
    try { verified = (await verifyPublic({ publicOrigin: record.publicOrigin, installationId: record.installationId, challenge: randomBytes(24).toString('hex') })) === true; } catch {}
    if (closed || probeGeneration !== generation || !record.wanted || !alive) return;
    connected = verified;
    phase = verified ? 'ready' : 'offline';
    message = verified ? 'Nemo is ready for your phone. Keep this computer awake and online.' : 'Your phone cannot reach Nemo yet. Check this computer’s internet connection; Nemo will try again.';
    schedule(health, readinessIntervalMs);
  }
  function crashed() {
    // Invalidate immediately; a previously displayed QR must not remain offered
    // as a newly verified connection after this process exits.
    generation++; alive = false; connected = false; cancelTimer();
    if (closed || !record.wanted) return;
    phase = 'offline'; message = 'Nemo lost its phone connection and is reconnecting.';
    if (restarts >= retryDelays.length) { phase = 'error'; message = 'Nemo could not reconnect. Choose Enable remote access to try again.'; return; }
    const delay = retryDelays[restarts++];
    schedule(startConnector, delay);
  }
  async function startConnector() {
    if (!record.wanted || closed) return;
    const attempt = ++generation;
    phase = 'connecting'; connected = false; message = 'Connecting Nemo to your phone.';
    try {
      if (!protectedRecord?.connectorToken) {
        const result = await cloud.credentials(await identity());
        acceptConnection(result);
        protectedRecord.connectorToken = result.connectorToken;
        await secretStore.save(protectedRecord); await persist();
      }
      await connector.start(protectedRecord.connectorToken, { onExit: () => { if (attempt === generation) crashed(); } });
      if (attempt !== generation || closed || !record.wanted) return;
      alive = true;
      const active = await activateOrigin(record.publicOrigin, { installationId: record.installationId });
      if (attempt !== generation || closed || !record.wanted || !alive) return;
      applicationReady = active === true || active?.ready === true;
      if (!applicationReady) { phase = 'connecting'; message = 'Nemo has saved your phone connection. Restart the app to finish connecting.'; return; }
      await health();
    } catch (error) {
      if (attempt !== generation || closed || !record.wanted) return;
      await connector.stop().catch(() => {}); alive = false; connected = false;
      if (error?.code === 'SIGN_IN_REQUIRED') { account = { state: 'signed-out' }; phase = 'signed-out'; message = 'Please sign in to Nemo again to reconnect your phone.'; return; }
      crashed();
    }
  }
  function acceptConnection(result) {
    if (result?.installationId !== record.installationId || result.status !== 'active' || !UUID.test(result.tunnelId || '') || typeof result.connectorToken !== 'string' || result.connectorToken.length < 16 || result.connectorToken.length > 32_768 || /[\r\n\0]/.test(result.connectorToken)) throw fail('REMOTE_RESPONSE', 'Nemo could not finish setting up its phone connection. Please try again.');
    const origin = secureOrigin(result.publicOrigin);
    if (record.publicOrigin && record.publicOrigin !== origin) throw fail('REMOTE_CHANGED', 'Nemo received a different phone address. Your existing connection has been preserved.');
    record.publicOrigin = origin; record.tunnelId = result.tunnelId;
  }
  async function enableInternal() {
    requireReady();
    if (!protectedRecord?.approved) throw fail('SIGN_IN_REQUIRED', 'Sign in to Nemo before connecting your phone.');
    if (record.retirementPending) throw fail('RETIREMENT_PENDING', 'Nemo is still confirming that remote access was switched off. Try switching it off again before reconnecting.');
    generation++; cancelTimer(); await connector.stop(); localStopPending = false; alive = false; connected = false; restarts = 0;
    record.wanted = true; await persist();
    phase = 'connecting'; message = 'Setting up a secure connection for your phone.';
    try {
      const result = await cloud.enable(await identity());
      acceptConnection(result);
      protectedRecord.connectorToken = result.connectorToken;
      await secretStore.save(protectedRecord); await persist();
      await startConnector();
    } catch (error) {
      connected = false; phase = error?.code === 'SIGN_IN_REQUIRED' ? 'signed-out' : 'error';
      message = error?.code === 'SIGN_IN_REQUIRED' ? 'Please sign in to Nemo again.' : 'Nemo could not finish connecting. Check your internet connection and try again; your chats are safe.';
    }
    return status();
  }
  const api = {
    status,
    async beginEnrollment({ displayName } = {}) { return exclusive(async () => {
      requireReady(); const auth = await identity();
      let result; try { result = await cloud.beginEnrollment({ ...auth, displayName }); } catch { throw fail('ENROLLMENT_UNAVAILABLE', 'Nemo could not open sign-in. Check your internet connection and try again.', 503); }
      if (result?.status === 'approved' && result.installationId === record.installationId) {
        const approved = { ...protectedRecord, approved: true }; delete approved.enrollmentId;
        await secretStore.save(approved); protectedRecord = approved;
        account = { state: 'approved' }; phase = 'disabled'; message = 'You are signed in. Enable remote access to connect your phone.';
        return { ...account };
      }
      let browser; try { browser = new URL(result.browserUrl); } catch {}
      if (!UUID.test(result?.enrollmentId || '') || browser?.protocol !== 'https:' || browser.username || browser.password || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now() || !/^\d{6}$/.test(result.confirmationCode || '')) throw fail('ENROLLMENT_RESPONSE', 'Nemo could not open sign-in. Please try again.');
      protectedRecord.enrollmentId = result.enrollmentId;
      await secretStore.save(protectedRecord);
      account = { state: 'pending', browserUrl: browser.href, expiresAt: result.expiresAt, confirmationCode: result.confirmationCode, pollAfterMs: Math.min(30_000, Math.max(3000, Number(result.pollAfterMs) || 3000)) };
      phase = 'awaiting-sign-in'; message = 'Finish signing in in your browser, then return to Nemo.';
      return { ...account };
    }); },
    async pollEnrollment() { return exclusive(async () => {
      requireReady(); if (!protectedRecord?.enrollmentId) throw fail('ENROLLMENT_REQUIRED', 'Choose Sign in to Nemo first.');
      let result; try { result = await cloud.pollEnrollment({ enrollmentId: protectedRecord.enrollmentId, installationSecret: protectedRecord.installationSecret }); } catch (error) {
        if (error?.code === 'ENROLLMENT_EXPIRED') result = { status: 'expired' };
        else throw fail('ENROLLMENT_UNAVAILABLE', 'Nemo could not check sign-in. Please try again.', 503);
      }
      if (result.status === 'expired') {
        const expired = { ...protectedRecord }; delete expired.enrollmentId;
        await secretStore.save(expired); protectedRecord = expired;
        account = { state: 'signed-out' }; phase = 'signed-out'; message = 'This sign-in invitation expired. Choose Sign in to Nemo again.';
        return { state: 'expired' };
      }
      if (result.status === 'approved' && result.installationId === record.installationId) {
        protectedRecord.approved = true; delete protectedRecord.enrollmentId; await secretStore.save(protectedRecord);
        account = { state: 'approved' }; phase = 'disabled'; message = 'You are signed in. Enable remote access to connect your phone.';
      } else if (result.status !== 'pending') throw fail('ENROLLMENT_EXPIRED', 'This sign-in has expired. Choose Sign in to Nemo again.');
      return { ...account };
    }); },
    async enable() { return exclusive(enableInternal); },
    async disable() { return exclusive(async () => {
      generation++; cancelTimer(); record.wanted = false; connected = false; applicationReady = false;
      // Block restart and persist intention before waiting on the network.
      record.retirementPending = !!protectedRecord?.approved;
      await persist();
      try { await connector.stop(); localStopPending = false; } catch { localStopPending = true; }
      alive = false;
      phase = 'disabled'; message = 'Remote access is off. Your chats remain on this computer.';
      if (protectedRecord?.approved && cloud) {
        try {
          const result = await cloud.retire(await identity());
          if (result.status !== 'retired' || result.installationId !== record.installationId) throw new Error();
          record.retirementPending = false; delete protectedRecord.connectorToken; await secretStore.save(protectedRecord);
        } catch { message = 'This computer has stopped remote access. Nemo could not confirm removal of the remote connection; choose Turn off again when you are online.'; }
      }
      if (localStopPending) { phase = 'error'; message = 'Nemo could not confirm that this computer’s phone connection stopped. Close Nemo and try again. Your chats remain saved.'; }
      await persist(); return status();
    }); },
    async restore() { return exclusive(async () => { if (record.retirementPending) { phase = 'disabled'; message = 'Remote access is stopped on this computer. Reconnect to the internet and choose Turn off to confirm removal.'; return status(); } if (record.wanted && cloud && bundled) return enableInternal(); return status(); }); },
    async close() { closed = true; generation++; cancelTimer(); cloud?.close?.(); await chain; cancelTimer(); connected = false; alive = false; await connector.stop(); },
  };
  return api;
}
