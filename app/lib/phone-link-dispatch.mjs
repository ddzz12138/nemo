import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { linkError, validateRequest } from '../public/phone-link-protocol.js';

/** One-use capabilities never leave this process. Only this gateway's loopback
 * listener is reachable; a peer cannot choose URLs, cookies, headers or profiles. */
export function createPhoneDispatch({ server, now = Date.now }) {
  const pending = new Map(), active = new Set();
  let closed = false;
  return {
    accept(req) {
      const token = req.headers['x-nemo-link-dispatch'];
      if (token === undefined) return null;
      const record = typeof token === 'string' ? pending.get(token) : null;
      if (record) pending.delete(token);
      if (!record || record.expiresAt < now() || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw linkError('LINK_DISPATCH', 'This phone request is invalid or expired.', 403);
      return record;
    },
    async dispatch(input) {
      const value = validateRequest({ id: input.id, issuedAt: input.issuedAt, method: input.method, path: input.path, ...(input.body !== undefined ? { body: input.body } : {}) }, now());
      const address = server.address();
      if (closed || !address || typeof address === 'string' || address.address !== '127.0.0.1') throw linkError('LINK_GATEWAY', 'Nemo is restarting. Reconnect shortly.', 503);
      const token = randomBytes(32).toString('hex');
      pending.set(token, { deviceId: input.deviceId, expiresAt: now() + 10000 });
      return new Promise((resolve, reject) => {
        let response, settled = false;
        const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: value.path, method: value.method,
          headers: { 'X-Nemo-Link-Dispatch': token, 'X-Nemo-Request': '1', 'Content-Type': 'application/json', ...(value.body !== undefined ? { 'Content-Length': Buffer.byteLength(value.body) } : {}) } });
        active.add(req);
        const deadline = setTimeout(() => req.destroy(new Error('Phone request timed out.')), 35000); deadline.unref?.();
        const abort = () => { response?.destroy(); req.destroy(new Error('Phone connection closed.')); };
        input.signal?.addEventListener('abort', abort, { once: true });
        const cleanup = () => { clearTimeout(deadline); pending.delete(token); active.delete(req); input.signal?.removeEventListener('abort', abort); };
        req.once('error', error => { cleanup(); if (!settled) { settled = true; reject(error); } });
        req.once('response', res => {
          response = res;
          res.once('end', cleanup); res.once('close', cleanup); res.once('error', cleanup);
          if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); cleanup(); if (!settled) { settled = true; reject(linkError('LINK_REDIRECT','Open this connection setup on the host.',409)); } return; }
          settled = true;
          resolve({ status: res.statusCode, headers: { 'content-type': res.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' }, body: res, close() { res.destroy(); cleanup(); } });
        });
        if (input.signal?.aborted) return abort();
        req.end(value.body);
      });
    },
    close() { closed = true; pending.clear(); for (const req of active) req.destroy(); active.clear(); },
  };
}
