import { createPublicKey, verify } from 'node:crypto';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_AUTH_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const chatgptFailure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
export const validClientId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value) && value !== 'dynamic_agent_client';
export const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !/[\s\x00-\x1f\x7f]/.test(value);
export const grantedScopes = value => typeof value === 'string' && value.length <= 4096 ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
export const hasPlanPermission = value => Array.isArray(value) && ['chatgpt.tokens.use.direct', 'resource.invoke'].every(scope => value.includes(scope));

export async function boundedJson(response, maximum = 262_144) {
  const reader = response.body?.getReader();
  if (!reader) { const value = await response.text(); if (Buffer.byteLength(value) > maximum) throw new Error('Response too large.'); return JSON.parse(value); }
  const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) throw new Error('Response too large.'); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Fixed OpenAI trust root. Remote metadata cannot select another origin. */
export function createChatGPTProtocol({ fetchImpl = fetch, now = Date.now, signal } = {}) {
  let metadataPromise, keys, keysUntil = 0;
  const request = (url, options = {}, timeout = 20_000) => fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), ...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeout)]) });
  async function metadata() {
    metadataPromise ||= (async () => {
      const response = await request(`${CHATGPT_ISSUER}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error('Discovery unavailable.');
      const value = await boundedJson(response);
      if (value.issuer !== CHATGPT_ISSUER || value.authorization_endpoint !== CHATGPT_AUTH_URL || value.token_endpoint !== CHATGPT_TOKEN_URL || value.jwks_uri !== `${CHATGPT_ISSUER}/.well-known/jwks.json`) throw new Error('Unexpected OpenAI configuration.');
      if (value.revocation_endpoint !== undefined) { const url = new URL(value.revocation_endpoint); if (url.origin !== CHATGPT_ISSUER || url.username || url.password || url.search || url.hash || url.pathname === '/') throw new Error('Unexpected revocation endpoint.'); }
      return value;
    })().catch(error => { metadataPromise = null; throw error; });
    return metadataPromise;
  }
  async function verifyIdentity(token, { clientId, nonce, subject } = {}) {
    try {
      if (!validToken(token) || !validClientId(clientId)) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url')), claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (!header || !claims || Array.isArray(header) || Array.isArray(claims) || !['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 || header.crit) throw new Error();
      const configuration = await metadata();
      if (!keys || keysUntil <= now() || !keys.some(key => key.kid === header.kid)) {
        const response = await request(configuration.jwks_uri); if (!response.ok) throw new Error();
        const jwks = await boundedJson(response); if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 100) throw new Error();
        keys = jwks.keys; keysUntil = now() + 5 * 60_000;
      }
      const matches = keys.filter(key => key.kid === header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg) && (!key.key_ops || Array.isArray(key.key_ops) && key.key_ops.includes('verify')) && (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
      if (matches.length !== 1) throw new Error();
      const key = createPublicKey({ key: matches[0], format: 'jwk' });
      if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
      if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'))) throw new Error();
      const seconds = now() / 1000, audience = claims.aud === clientId || Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.includes(clientId) && (claims.aud.length === 1 || claims.azp === clientId);
      if (claims.iss !== CHATGPT_ISSUER || !audience || claims.azp && claims.azp !== clientId || !Number.isInteger(claims.exp) || claims.exp <= seconds - 5 || !Number.isInteger(claims.iat) || claims.iat > seconds + 5 || claims.exp <= claims.iat || claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 5) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || /[\x00-\x1f\x7f]/.test(claims.sub) || nonce !== undefined && claims.nonce !== nonce || subject !== undefined && claims.sub !== subject) throw new Error();
      const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : '';
      return { subject: claims.sub, email: claims.email_verified === false ? '' : text(claims.email), name: text(claims.name), issuer: CHATGPT_ISSUER };
    } catch { throw chatgptFailure('CHATGPT_IDENTITY', 'Nemo could not verify this ChatGPT sign-in. Please try again.'); }
  }
  async function tokenRequest(fields, requestSignal) {
    let response, result;
    try { response = await request(CHATGPT_TOKEN_URL, { method: 'POST', signal: requestSignal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields) }); result = await boundedJson(response, 110_000); }
    catch { throw chatgptFailure('CHATGPT_UNAVAILABLE', 'ChatGPT could not be reached. Your saved connection is still on this computer.', 503); }
    if (!response.ok) throw chatgptFailure(result?.error === 'invalid_grant' ? 'CHATGPT_SIGN_IN_REQUIRED' : 'CHATGPT_AUTH', result?.error === 'invalid_grant' ? 'Please connect your ChatGPT account again.' : 'ChatGPT could not complete sign-in. Please try again.');
    return result;
  }
  return { request, metadata, verifyIdentity, tokenRequest };
}
