import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { RemoteCloudError } from './remote-cloud-provider.mjs';

export const remoteSecret = () => randomBytes(32).toString('base64url');
export const remoteHash = value => createHash('sha256').update(String(value)).digest('hex');
const invalid = () => new RemoteCloudError('sign_in_failed', 'Sign-in could not be verified. Please return to Nemo and try again.', 401);

/** The only production identity adapter. Test adapters must be injected explicitly in code. */
export class GoogleRemoteIdentity {
  #metadata;
  #keys;
  #keysUntil = 0;
  constructor({ clientId, clientSecret, redirectUri, fetchImpl = fetch, now = Date.now }) {
    if (!clientId || !clientSecret || !redirectUri?.startsWith('https://')) throw new Error('Google sign-in needs NEMO_REMOTE_GOOGLE_CLIENT_ID, NEMO_REMOTE_GOOGLE_CLIENT_SECRET and an HTTPS service origin.');
    Object.assign(this, { clientId, clientSecret, redirectUri, fetchImpl, now });
  }
  async request(url, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw invalid();
      return await response.json();
    } catch { throw invalid(); }
  }
  async metadata() {
    if (!this.#metadata) {
      const data = await this.request('https://accounts.google.com/.well-known/openid-configuration');
      const trusted = (url, hosts) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && hosts.includes(parsed.hostname); } catch { return false; } };
      if (data.issuer !== 'https://accounts.google.com' || !trusted(data.authorization_endpoint, ['accounts.google.com']) || !trusted(data.token_endpoint, ['oauth2.googleapis.com']) || !trusted(data.jwks_uri, ['www.googleapis.com', 'oauth2.googleapis.com'])) throw invalid();
      this.#metadata = data;
    }
    return this.#metadata;
  }
  async authorizationUrl({ state, nonce, verifier }) {
    const metadata = await this.metadata();
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' })) url.searchParams.set(key, value);
    return url.href;
  }
  async verifyIdToken(token, nonce) {
    try {
      if (typeof token !== 'string' || token.length > 20000) throw invalid();
      const parts = token.split('.');
      if (parts.length !== 3) throw invalid();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();
      const metadata = await this.metadata();
      if (!this.#keys || this.#keysUntil <= this.now() || !this.#keys.some(key => key.kid === header.kid)) {
        const data = await this.request(metadata.jwks_uri);
        if (!Array.isArray(data.keys)) throw invalid();
        this.#keys = data.keys; this.#keysUntil = this.now() + 300000;
      }
      const key = this.#keys.find(item => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256'));
      if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw invalid();
      const seconds = this.now() / 1000;
      const audience = claims.aud === this.clientId || (Array.isArray(claims.aud) && claims.aud.includes(this.clientId) && claims.azp === this.clientId);
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !audience || (claims.azp && claims.azp !== this.clientId) || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.exp <= claims.iat || (claims.nbf && claims.nbf > seconds + 60) || typeof claims.sub !== 'string' || !/^[a-z\d_-]{1,255}$/i.test(claims.sub) || claims.nonce !== nonce) throw invalid();
      return { ownerId: `google:${claims.sub}`, email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email.toLowerCase() : null };
    } catch { throw invalid(); }
  }
  async exchange({ code, nonce, verifier }) {
    const metadata = await this.metadata();
    if (typeof code !== 'string' || code.length > 4000) throw invalid();
    const tokens = await this.request(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
    return this.verifyIdToken(tokens.id_token, nonce);
  }
}
