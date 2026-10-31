import { GmailError } from './gmail.mjs';

/** A profile's desktop sign-in, bound to the initiating authenticated device.
 * Only native main receives the Google URL. Status never contains credentials,
 * callback URLs, state, or another device's progress. */
export function createGmailDesktopOnboarding({ gmail, isAuthorized, commit, now = Date.now }) {
  let flow = null, starting = false, closed = false;
  const attempts = new Map();
  const error = (code, message) => new GmailError(code, message);
  function cancel(owner) {
    if (!flow || owner && flow.owner !== owner) return;
    flow.valid = false;
    flow.phase = 'cancelled'; flow.message = 'Gmail sign-in cancelled.';
    void flow.connection?.cancel();
  }
  return {
    status(owner) {
      if (!flow || flow.owner !== owner) return { phase: 'idle' };
      return { phase: flow.phase, ...(flow.message ? { message: flow.message } : {}) };
    },
    async start(owner) {
      if (closed || !owner || !await isAuthorized(owner)) throw error('GMAIL_AUTH_CANCELLED', 'Sign in to your personal profile and try again.');
      if (starting || flow?.valid) throw error('GMAIL_SIGNIN_ACTIVE', 'A Gmail sign-in is already open for this profile. Finish or cancel it first.');
      const recent = (attempts.get(owner) || []).filter(time => time > now() - 300_000);
      if (recent.length >= 5) throw error('GMAIL_RATE_LIMIT', 'Too many Gmail sign-in attempts. Try again in five minutes.');
      if (attempts.size >= 100) for (const [id, times] of attempts) if (times.at(-1) <= now() - 300_000) attempts.delete(id);
      if (attempts.size >= 100 && !attempts.has(owner)) throw error('GMAIL_RATE_LIMIT', 'Try Gmail sign-in again in five minutes.');
      attempts.set(owner, [...recent, now()]); starting = true;
      const current = { owner, valid: true, phase: 'waiting', expiresAt: now() + 300_000 };
      flow = current;
      const currentFlow = () => !closed && current.valid && flow === current && now() < current.expiresAt;
      const stillAuthorized = async () => currentFlow() && await isAuthorized(owner) && currentFlow();
      try {
        current.connection = await gmail.beginDesktopAuthorization({ stillAuthorized, commit: operation => commit(async () => {
          if (!await stillAuthorized()) throw error('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in was cancelled.');
          return operation();
        }) });
        if (!await stillAuthorized()) { await current.connection.cancel(); throw error('GMAIL_AUTH_CANCELLED', 'This Gmail sign-in was cancelled.'); }
        current.connection.completed.then(() => { if (flow === current && current.valid) { current.phase = 'connected'; current.valid = false; current.message = 'Gmail connected with read-only access.'; } }, failure => {
          if (flow !== current || !current.valid) return;
          current.valid = false; current.phase = failure.code === 'GMAIL_AUTH_CANCELLED' ? 'cancelled' : 'error';
          current.message = failure instanceof GmailError ? failure.message : 'Gmail could not be connected. Try again.';
        });
        return { authorizationUrl: current.connection.authorizationUrl, expiresAt: current.expiresAt };
      } catch (failure) { current.valid = false; current.phase = 'error'; current.message = failure instanceof GmailError ? failure.message : 'Gmail sign-in could not be opened. Try again.'; throw failure; }
      finally { starting = false; }
    },
    cancel,
    close() { closed = true; cancel(); },
  };
}

// A tunnel can arrive on a loopback socket too. Desktop-only routes require an
// actual local Host and reject every forwarding/phone transport indication.
export function isLocalGmailRequest(req) {
  if (req.nemoPhoneLink || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (Object.keys(req.headers).some(key => /^(?:forwarded|x-forwarded-|cf-|x-real-ip)/i.test(key))) return false;
  return /^(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(req.headers.host || '');
}
