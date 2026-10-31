import { randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const stamp = profile => `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}`;
const transportNames = new Set(['usb','nfc','ble','internal','hybrid','smart-card','cable']);
const cookieName = 'nemo_passkey_challenge';
const cookieToken = req => (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

/** Credentials live in the private registry; challenges never authorize a profile
 * supplied by a browser. This service performs no model or connector calls. */
export function createPasskeys({ store, publicOrigin = '', now = Date.now, webauthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } }) {
  const pending = new Map(), rates = new Map();
  function originFor(req) {
    let origin;
    if (publicOrigin) origin = new URL(publicOrigin);
    else if (/^localhost(?::\d+)?$/i.test(req.headers.host || '')) origin = new URL(`http://${req.headers.host}`);
    else fail(503, 'PASSKEY_SETUP', 'The host needs to configure Nemo’s private HTTPS address before passkey sign-in.');
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost')) fail(503, 'PASSKEY_SETUP', 'Passkeys need the configured private HTTPS address.');
    if (req.headers.host?.toLowerCase() !== origin.host.toLowerCase() || req.headers.origin !== origin.origin) fail(403, 'PASSKEY_ORIGIN', 'Open Nemo at its configured address to use passkeys.');
    return { origin: origin.origin, rpID: origin.hostname, secure: origin.protocol === 'https:' };
  }
  const cookie = (token, secure, age = 300) => `${cookieName}=${token}; Path=/api/passkeys; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function rate(req) {
    const time = now(); for (const [ip, entry] of rates) if (time - entry.at > 300_000) rates.delete(ip);
    const ip = req.socket.remoteAddress || 'local', entry = rates.get(ip) || { at: time, count: 0 };
    if (entry.count >= 40 || rates.size >= 1024 && !rates.has(ip)) fail(429, 'PASSKEY_RATE_LIMIT', 'Too many passkey attempts. Wait five minutes.');
    entry.count++; rates.set(ip, entry);
  }
  function remember(req, value) {
    for (const [token, entry] of pending) if (entry.expiresAt <= now()) pending.delete(token);
    const old = cookieToken(req); if (old) pending.delete(old);
    if (pending.size >= 256) fail(429, 'PASSKEY_BUSY', 'Passkey sign-in is busy. Try again shortly.');
    const token = randomBytes(32).toString('base64url'); pending.set(token, { ...value, expiresAt: now() + 300_000 });
    return cookie(token, value.secure);
  }
  function consume(req, kind, auth, site) {
    const token = cookieToken(req), entry = pending.get(token); if (token) pending.delete(token);
    if (!entry || entry.kind !== kind || entry.expiresAt <= now() || entry.origin !== site.origin || entry.rpID !== site.rpID || kind === 'registration' && (!auth || entry.profileId !== auth.profile.id || entry.deviceId !== auth.device.id || entry.policy !== stamp(auth.profile))) fail(401, 'PASSKEY_EXPIRED', 'This passkey request expired or changed. Start again.');
    return entry;
  }
  return {
    async handle(req, path, auth, input) {
      if (req.method !== 'POST') fail(405, 'PASSKEY_METHOD', 'Use the passkey controls in Nemo.');
      const site = originFor(req); rate(req);
      if (path.startsWith('/api/passkeys/authentication/') && auth) fail(409, 'ALREADY_PAIRED', 'Sign out before switching to another person.');
      if (path.startsWith('/api/passkeys/registration/') && !auth) fail(401, 'AUTH_REQUIRED', 'Sign in with your personal invitation before adding a passkey.');
      if (path === '/api/passkeys/registration/options') {
        if (Object.keys(input).length) fail(400, 'PASSKEY_INPUT', 'Passkey identity comes from your signed-in profile.');
        const keys = await store.passkeys(auth.profile.id);
        const options = await webauthn.generateRegistrationOptions({ rpName: 'Nemo', rpID: site.rpID, userID: new Uint8Array(Buffer.from(auth.profile.id)), userName: auth.profile.name, userDisplayName: auth.profile.name, attestationType: 'none', timeout: 300_000, supportedAlgorithmIDs: [-7,-257], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: keys.map(key => ({ id: key.id })) });
        return { body: { options }, cookie: remember(req, { ...site, kind: 'registration', profileId: auth.profile.id, deviceId: auth.device.id, policy: stamp(auth.profile), challenge: options.challenge }) };
      }
      if (path === '/api/passkeys/registration/verify') {
        const entry = consume(req, 'registration', auth, site);
        if (Object.keys(input).some(key => !['response','label'].includes(key))) fail(400, 'PASSKEY_INPUT', 'Send the passkey response and its name only.');
        let verified; try { verified = await webauthn.verifyRegistrationResponse({ response: input.response, expectedChallenge: entry.challenge, expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7,-257] }); } catch { fail(401, 'PASSKEY_VERIFY', 'Nemo could not verify that passkey. Try again or use an invitation.'); }
        if (!verified?.verified || !verified.registrationInfo?.userVerified) fail(401, 'PASSKEY_VERIFY', 'Verify your identity with your device to create a passkey.');
        const info = verified.registrationInfo, key = info.credential;
        const saved = await store.addPasskey(auth.profile.id, auth.device.id, entry.policy, { id: key.id, publicKey: Buffer.from(key.publicKey).toString('base64url'), counter: key.counter, rpID: site.rpID, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, transports: (key.transports || []).filter(value => transportNames.has(value)), label: input.label || 'Personal passkey' });
        return { body: { ok: true, passkey: saved }, cookie: cookie('', site.secure, 0) };
      }
      if (path === '/api/passkeys/authentication/options') {
        if (Object.keys(input).length) fail(400, 'PASSKEY_INPUT', 'Choose your personal passkey on the device.');
        const options = await webauthn.generateAuthenticationOptions({ rpID: site.rpID, userVerification: 'required', timeout: 300_000 });
        return { body: { options }, cookie: remember(req, { ...site, kind: 'authentication', challenge: options.challenge }) };
      }
      if (path === '/api/passkeys/authentication/verify') {
        const entry = consume(req, 'authentication', auth, site);
        if (Object.keys(input).some(key => !['response','deviceName'].includes(key))) fail(400, 'PASSKEY_INPUT', 'Choose your personal passkey without overriding its profile.');
        const record = await store.passkey(input.response?.id);
        if (!record || record.key.rpID !== site.rpID || typeof input.response?.response?.userHandle !== 'string' || input.response.response.userHandle !== Buffer.from(record.profile.id).toString('base64url')) fail(401, 'PASSKEY_VERIFY', 'Nemo could not verify this sign-in. Try again or use an invitation.');
        let verified; try { verified = await webauthn.verifyAuthenticationResponse({ response: input.response, expectedChallenge: entry.challenge, expectedOrigin: site.origin, expectedRPID: site.rpID, credential: { id: record.key.id, publicKey: new Uint8Array(Buffer.from(record.key.publicKey, 'base64url')), counter: record.key.counter, transports: record.key.transports }, requireUserVerification: true }); } catch { fail(401, 'PASSKEY_VERIFY', 'Nemo could not verify this sign-in. Try again or use an invitation.'); }
        if (!verified?.verified || !verified.authenticationInfo?.userVerified || verified.authenticationInfo.credentialID !== record.key.id) fail(401, 'PASSKEY_VERIFY', 'Verify your identity with your device to sign in.');
        const result = await store.signInPasskey({ id: record.key.id, rpID: site.rpID, expectedCounter: record.key.counter, expectedPolicy: stamp(record.profile), newCounter: verified.authenticationInfo.newCounter, backedUp: verified.authenticationInfo.credentialBackedUp, deviceName: input.deviceName || 'Passkey browser' });
        return { body: { authenticated: true, profile: result.profile, device: result.device }, sessionToken: result.token, cookie: cookie('', site.secure, 0) };
      }
      fail(404, 'PASSKEY_ROUTE', 'Passkey operation not found.');
    },
    close() { pending.clear(); rates.clear(); },
  };
}
