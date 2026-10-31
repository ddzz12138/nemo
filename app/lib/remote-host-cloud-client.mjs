const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** This origin is operator configuration, never a URL supplied by a phone. */
export function createRemoteCloudClient({ origin, fetchImpl = globalThis.fetch, timeoutMs = 15_000, operationTimeoutMs = 90_000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw new Error('Nemo sign-in is not configured for this release.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Nemo sign-in needs a secure service address.');
  const id = value => { if (!UUID.test(value || '')) throw new Error('This Nemo installation needs to be registered again.'); return value; };
  const controller = new AbortController();
  async function request(path, { secret, body, method = 'POST', operation = false } = {}) {
    if (secret !== undefined && (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(secret))) throw new Error('Nemo could not unlock its sign-in.');
    let response;
    try {
      response = await fetchImpl(`${base.origin}${path}`, { method, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(operation ? operationTimeoutMs : timeoutMs)]), headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const error = new Error(response.status === 410 ? 'This sign-in invitation expired. Choose Sign in to Nemo again.' : [401, 403].includes(response.status) ? 'Please sign in to Nemo again.' : response.status === 429 ? 'Nemo is busy. Please try again shortly.' : 'Nemo could not reach its sign-in service. Please try again.');
        error.code = response.status === 410 ? 'ENROLLMENT_EXPIRED' : [401, 403].includes(response.status) ? 'SIGN_IN_REQUIRED' : 'CLOUD_UNAVAILABLE';
        throw error;
      }
      const text = await boundedText(response, 65_536);
      const result = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch (error) {
      if (['SIGN_IN_REQUIRED', 'CLOUD_UNAVAILABLE', 'ENROLLMENT_EXPIRED'].includes(error?.code)) throw error;
      throw Object.assign(new Error('Nemo could not reach its sign-in service. Check your internet connection and try again.'), { code: 'CLOUD_UNAVAILABLE' });
    }
  }
  return {
    async beginEnrollment({ installationId, installationSecret, displayName }) {
      const result = await request('/v1/enrollments', { body: { installationId: id(installationId), installationSecret, ...(displayName ? { displayName } : {}) } });
      if (result.status === 'approved' && result.installationId === installationId && result.browserUrl == null) return result;
      let browser; try { browser = new URL(result.browserUrl); } catch {}
      if (!browser || browser.origin !== base.origin || browser.username || browser.password || browser.hash) throw new Error('Nemo could not open its sign-in page. Please try again.');
      return result;
    },
    pollEnrollment({ enrollmentId, installationSecret }) { return request(`/v1/enrollments/${id(enrollmentId)}/poll`, { secret: installationSecret, body: {} }); },
    enable({ installationId, installationSecret }) { return request(`/v1/installations/${id(installationId)}/enable`, { secret: installationSecret, body: {}, operation: true }); },
    credentials({ installationId, installationSecret }) { return request(`/v1/installations/${id(installationId)}/credentials`, { secret: installationSecret, body: {} }); },
    get({ installationId, installationSecret }) { return request(`/v1/installations/${id(installationId)}`, { secret: installationSecret, method: 'GET' }); },
    retire({ installationId, installationSecret }) { return request(`/v1/installations/${id(installationId)}/retire`, { secret: installationSecret, body: {}, operation: true }); },
    close() { controller.abort(); },
  };
}

export async function boundedText(response, maximum) {
  const declared = Number(response.headers?.get('content-length'));
  if (declared > maximum) throw new Error('Response too large.');
  if (!response.body?.getReader) { const value = await response.text(); if (Buffer.byteLength(value) > maximum) throw new Error('Response too large.'); return value; }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) throw new Error('Response too large.'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
