import crypto from 'node:crypto';

const ALLOWED_HOST = /(^|\.)push\.apple\.com$|^fcm\.googleapis\.com$|^updates\.push\.services\.mozilla\.com$|(^|\.)notify\.windows\.com$/;

export class PushError extends Error {
  constructor(status, message, code = 'PUSH') { super(message); this.status = status; this.code = code; }
}

export function validatePushEndpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new PushError(400, 'That notification subscription is not valid.', 'PUSH_ENDPOINT'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOST.test(host)) {
    throw new PushError(400, 'Notifications can only be sent to a recognised push service.', 'PUSH_ENDPOINT');
  }
  return url;
}

export function createVapidKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const uncompressed = Buffer.concat([Buffer.from([0x04]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]);
  return { publicKey: uncompressed.toString('base64url'), privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function encryptPushPayload(payload, subscription) {
  const userPublic = Buffer.from(subscription.p256dh, 'base64url');
  const auth = Buffer.from(subscription.auth, 'base64url');
  if (userPublic.length !== 65 || auth.length < 16) throw new PushError(400, 'The notification subscription is incomplete.', 'PUSH_SUBSCRIPTION');
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const salt = crypto.randomBytes(16);
  const shared = local.computeSecret(userPublic);
  const localPublic = local.getPublicKey();
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, localPublic]), 32);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return { body: Buffer.concat([salt, recordSize, Buffer.from([localPublic.length]), localPublic, body]), localPublic };
}

export function decryptPushPayload(record, subscription, receiverPrivate) {
  const salt = record.subarray(0, 16);
  const idLength = record[20];
  const senderPublic = record.subarray(21, 21 + idLength);
  const encrypted = record.subarray(21 + idLength);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const shared = ecdh.computeSecret(senderPublic);
  const userPublic = Buffer.from(subscription.p256dh, 'base64url');
  const auth = Buffer.from(subscription.auth, 'base64url');
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, senderPublic]), 32);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
  if (plain.at(-1) !== 2) throw new Error('Push padding was rejected.');
  return plain.subarray(0, -1);
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

export function vapidAuthorization({ endpoint, privatePem, publicKey, subject = 'mailto:notifications@nemo.invalid', now = Date.now() }) {
  const audience = new URL(endpoint).origin;
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privatePem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${publicKey}`;
}

const base64url = value => Buffer.from(value).toString('base64url');

export function createPushSender({ privatePem, publicKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  return async function send(subscription, payload) {
    const endpoint = validatePushEndpoint(subscription.endpoint);
    const encrypted = encryptPushPayload(JSON.stringify(payload), subscription);
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error',
      headers: {
        Authorization: vapidAuthorization({ endpoint: endpoint.toString(), privatePem, publicKey, now: now() }),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '120', Urgency: 'high',
      },
      body: encrypted.body,
    });
    return { accepted: response.status === 201 || response.status === 200, status: response.status, expired: response.status === 404 || response.status === 410 };
  };
}
