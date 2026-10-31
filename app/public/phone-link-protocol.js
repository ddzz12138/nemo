// Shared wire validation and Web Crypto. No account or profile authority lives here.
export const LINK_VERSION = 1;
export const LINK_APP_ID = 'org.nemo.phone.v1';
export const LINK_DEFAULT_RELAYS = Object.freeze(['wss://nos.lol', 'wss://relay.agentry.com']);
export const LINK_MAX_BODY = 32768;
export const LINK_MAX_RESPONSE = 16 * 1024 * 1024;
export const LINK_REQUEST_AGE = 120000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const secret = /^[a-f0-9]{64}$/;
export function linkError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
export function publicKey(value) {
  if (!value || value.kty !== 'EC' || value.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(value.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(value.y || '') || value.d !== undefined) throw linkError('LINK_KEY', 'This phone key is invalid.');
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}
export const keyId = key => JSON.stringify(publicKey(key));
export function relayUrls(input) {
  if (!Array.isArray(input) || !input.length || input.length > 3) throw linkError('LINK_RELAYS', 'Choose one to three discovery servers.');
  return [...new Set(input.map(value => {
    let url; try { url = new URL(value); } catch {}
    if (!url || url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw linkError('LINK_RELAYS', 'Discovery servers must use secure WebSocket addresses.');
    return url.origin;
  }))];
}
export function linkDescriptor(input) {
  if (!input || input.v !== 1 || !uuid.test(input.id || '') || !secret.test(input.room || '') || !secret.test(input.password || '')) throw linkError('LINK_INVITATION', 'This phone invitation is invalid.');
  return { v: 1, id: input.id, room: input.room, password: input.password, hostKey: publicKey(input.hostKey), relays: relayUrls(input.relays) };
}
export function channelBinding(connection, host = false) {
  function fingerprint(sdp) {
    const values=[...String(sdp||'').matchAll(/^a=fingerprint:sha-256\s+([A-Fa-f0-9:]+)\s*$/gm)].map(match=>match[1].replaceAll(':','').toLowerCase());
    if(!values.length||values.some(value=>!/^[a-f0-9]{64}$/.test(value))||new Set(values).size!==1)throw linkError('LINK_CHANNEL','This encrypted connection could not be verified.',401);
    return values[0];
  }
  const local=fingerprint(connection?.localDescription?.sdp),remote=fingerprint(connection?.remoteDescription?.sdp);
  return host?{hostFingerprint:local,clientFingerprint:remote}:{hostFingerprint:remote,clientFingerprint:local};
}
export function transcript({ id, clientPeer, hostPeer, nonce, challenge, clientKey, hostFingerprint, clientFingerprint }) {
  if (!uuid.test(id || '') || !/^[A-Za-z0-9_-]{8,128}$/.test(clientPeer || '') || !/^[A-Za-z0-9_-]{8,128}$/.test(hostPeer || '') || !secret.test(nonce || '') || !secret.test(challenge || '') || !secret.test(hostFingerprint||'') || !secret.test(clientFingerprint||'')) throw linkError('LINK_PROOF', 'This connection check expired.');
  return JSON.stringify(['nemo-phone-auth-v1', id, clientPeer, hostPeer, nonce, challenge, keyId(clientKey),hostFingerprint,clientFingerprint]);
}
export function encode64(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function decode64(value, maximum = 65536) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(maximum * 4 / 3) + 4) throw linkError('LINK_ENCODING', 'Nemo received an invalid connection message.');
  let text; try { text = atob(value.replaceAll('-','+').replaceAll('_','/')); } catch { throw linkError('LINK_ENCODING', 'Nemo received an invalid connection message.'); }
  if (text.length > maximum) throw linkError('LINK_ENCODING', 'Nemo received an oversized connection message.');
  return Uint8Array.from(text, c => c.charCodeAt(0));
}
export async function signProof(crypto, privateKey, value) {
  return encode64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(value))));
}
export async function verifyProof(crypto, jwk, signature, value) {
  try {
    const key = await crypto.subtle.importKey('jwk', publicKey(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode64(signature, 64), new TextEncoder().encode(value));
  } catch { return false; }
}
export function validateRequest(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id','method','path','body','issuedAt','expectedProfile'].includes(key)) || !uuid.test(input.id || '') || !['GET','POST','HEAD'].includes(input.method) || !Number.isSafeInteger(input.issuedAt) || Math.abs(now - input.issuedAt) > LINK_REQUEST_AGE || input.expectedProfile !== undefined && !uuid.test(input.expectedProfile)) throw linkError('LINK_REQUEST', 'This request expired. Reconnect before continuing.');
  if (typeof input.path !== 'string' || input.path.length > 4096 || !input.path.startsWith('/api/') || /[\\\0\r\n]/.test(input.path)) throw linkError('LINK_ROUTE', 'This operation is unavailable over the phone connection.', 403);
  const url = new URL(input.path, 'https://nemo.invalid');
  if (url.origin !== 'https://nemo.invalid' || url.hash || /%|\/\/|\.\./.test(input.path.split('?')[0])) throw linkError('LINK_ROUTE', 'This operation is unavailable over the phone connection.', 403);
  const allowed = /^\/api\/(pair|session|capabilities|conversation|conversations|chat|runs|tasks|history|integrations|connections|consent|gmail|calendar|memory|native|leave|profiles|devices|family|logout)(?:\/|$)/.test(url.pathname);
  if (!allowed || url.pathname === '/api/calendar/import' || url.pathname.startsWith('/api/passkeys')) throw linkError('LINK_ROUTE', 'Use Nemo on the host for this operation.', 403);
  if (input.method !== 'POST' && input.body !== undefined) throw linkError('LINK_REQUEST', 'This request has an unexpected body.');
  if (input.body !== undefined && (typeof input.body !== 'string' || new TextEncoder().encode(input.body).length > LINK_MAX_BODY)) throw linkError('LINK_SIZE', 'This request is too large.', 413);
  if (input.method === 'POST') { let value; try { value = JSON.parse(input.body || '{}'); } catch {} if (!value || typeof value !== 'object' || Array.isArray(value)) throw linkError('LINK_REQUEST', 'Use the Nemo app to send this request.'); }
  return { ...input, path: url.pathname + url.search };
}
