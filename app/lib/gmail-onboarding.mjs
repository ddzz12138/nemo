import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL = 300_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

// OAuth uses a separate Lax cookie because Nemo's pairing cookie is Strict.
// Neither the state nor this cookie alone can authorize an account change.
export function createGmailOnboarding({ gmail, isAuthorized, beforeAccountChange, commitAccountChange, now = Date.now }) {
  const flows = new Map();
  const attempts = new Map();
  const generations = new Map();
  let epoch = 0;
  function prune() {
    for (const [key, flow] of flows) if (flow.expiresAt <= now()) flows.delete(key);
    for (const [key, times] of attempts) {
      const recent = times.filter(time => now() - time < TTL);
      if (recent.length) attempts.set(key, recent); else attempts.delete(key);
    }
  }
  function cookie(value, secure, age = 300) {
    return `nemo_gmail_flow=${value}; Path=/oauth/gmail/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  return {
    async start({ owner, origin, mode }) {
      if (!['sync', 'demand'].includes(mode)) fail(400, 'GMAIL_SYNC_MODE', 'Choose Sync or Don’t sync.');
      if (!await isAuthorized(owner)) fail(409, 'GMAIL_BUSY', 'Wait for current replies before connecting Gmail.');
      prune();
      const recent = attempts.get(owner) || [];
      if (recent.length >= 5 || flows.size >= 20) fail(429, 'GMAIL_CONNECT_LIMIT', 'Wait a few minutes before starting Google sign-in again.');
      const state = randomBytes(32).toString('base64url');
      const browser = randomBytes(32).toString('hex');
      const verifier = randomBytes(48).toString('base64url');
      const authorization = await gmail.webAuthorization({ origin, state, verifier });
      for (const [key, flow] of flows) if (flow.owner === owner) flows.delete(key);
      const generation = (generations.get(owner) || 0) + 1;
      generations.set(owner, generation);
      flows.set(digest(state), { owner, generation, epoch, browser: digest(browser), verifier, mode, origin, ...authorization, expiresAt: now() + TTL });
      attempts.set(owner, [...recent, now()]);
      return { authorizationUrl: authorization.authorizationUrl, expiresAt: now() + TTL, cookie: cookie(browser, origin.startsWith('https:')) };
    },
    async complete({ params, cookies = '', origin }) {
      const state = params.get('state');
      if (params.getAll('state').length !== 1 || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) fail(403, 'GMAIL_OAUTH_STATE', 'This Google sign-in could not be verified. Return to Nemo and try again.');
      const key = digest(state);
      const flow = flows.get(key);
      const browser = cookies.split(';').map(value => value.trim()).find(value => value.startsWith('nemo_gmail_flow='))?.slice('nemo_gmail_flow='.length);
      if (!flow || typeof browser !== 'string' || !/^[a-f0-9]{64}$/.test(browser) || !equal(digest(browser), flow.browser) || flow.origin !== origin) fail(403, 'GMAIL_OAUTH_STATE', 'Open Google sign-in in the same browser that started it.');
      // Single use, including denials and malformed callbacks.
      flows.delete(key);
      const clearCookie = cookie('', origin.startsWith('https:'), 0);
      const authorized = async () => flow.expiresAt > now() && flow.epoch === epoch && flow.generation === generations.get(flow.owner) && await isAuthorized(flow.owner) && flow.epoch === epoch && flow.generation === generations.get(flow.owner);
      if (flow.expiresAt <= now() || !await authorized()) return { result: 'expired', cookie: clearCookie };
      if (params.has('error')) return { result: params.get('error') === 'access_denied' ? 'denied' : 'failed', cookie: clearCookie };
      const code = params.get('code');
      if (params.getAll('code').length !== 1 || typeof code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(code)) return { result: 'failed', cookie: clearCookie };
      try {
        await gmail.completeWebAuthorization({ code, verifier: flow.verifier, clientId: flow.clientId, redirectUri: flow.redirectUri, mode: flow.mode, stillAuthorized: authorized, beforeAccountChange, commit: commitAccountChange });
        return { result: 'connected', cookie: clearCookie };
      } catch { return { result: 'failed', cookie: clearCookie }; }
    },
    cancelAll() { epoch += 1; flows.clear(); },
    hasState(value) { return typeof value === 'string' && flows.has(digest(value)); },
    cancelOwner(owner) { generations.set(owner, (generations.get(owner) || 0) + 1); for (const [key, flow] of flows) if (flow.owner === owner) flows.delete(key); },
  };
}
