/** All Cloudflare control-plane credentials stay in this process. */
export class RemoteCloudError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}

export const NEMO_TUNNEL_ORIGIN = 'http://127.0.0.1:8787';
const endpoint = 'https://api.cloudflare.com/client/v4';
const segment = value => encodeURIComponent(value);

export class CloudflareRemoteProvider {
  constructor({ accountId, zoneId, apiToken, domain, fetchImpl = fetch }) {
    if (![accountId, zoneId].every(value => /^[a-f\d]{32}$/i.test(value || '')) || !apiToken || !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}$/.test(domain || '')) throw new Error('Cloudflare remote access needs a valid account ID, zone ID, API token, and owned domain.');
    Object.assign(this, { accountId, zoneId, apiToken, domain, fetchImpl });
  }
  async request(method, path, body, { allow404 = false } = {}) {
    let response, data;
    try {
      response = await this.fetchImpl(`${endpoint}${path}`, {
        method, headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (allow404 && response.status === 404) return null;
      data = await response.json();
    } catch { throw new RemoteCloudError('cloudflare_unavailable', 'The secure connection service is temporarily unavailable. Please try again.'); }
    if (!response.ok || data.success !== true) {
      const code = response.status === 401 || response.status === 403 ? 'cloudflare_configuration' : 'cloudflare_unavailable';
      throw new RemoteCloudError(code, code === 'cloudflare_configuration' ? 'Remote access needs attention from the Nemo service operator.' : 'The secure connection could not be updated. Please try again.');
    }
    return data.result;
  }
  tunnelPath(id = '') { return `/accounts/${this.accountId}/cfd_tunnel${id ? `/${segment(id)}` : ''}`; }
  dnsPath(id = '') { return `/zones/${this.zoneId}/dns_records${id ? `/${segment(id)}` : ''}`; }
  assertRecord(record) {
    if (!new RegExp(`^host-[a-f\\d]{32}\\.${this.domain.replaceAll('.', '\\.')}$`).test(record.hostname) || !/^nemo-[a-f\d-]{36}$/.test(record.tunnelName)) throw new RemoteCloudError('invalid_remote_record', 'The installation record needs operator attention.', 409);
  }
  async findTunnel(record) {
    this.assertRecord(record);
    const found = await this.request('GET', `${this.tunnelPath()}?name=${segment(record.tunnelName)}&is_deleted=false`);
    if (!Array.isArray(found)) throw new RemoteCloudError('cloudflare_response', 'The secure connection service returned an unexpected response.');
    const matching = found.filter(item => item.name === record.tunnelName && !item.deleted_at);
    if (matching.length > 1) throw new RemoteCloudError('tunnel_conflict', 'This connection needs attention from the Nemo service operator.', 409);
    if (!matching.length) return null;
    const tunnel = matching[0];
    if (tunnel.config_src !== 'cloudflare') throw new RemoteCloudError('tunnel_conflict', 'This connection needs attention from the Nemo service operator.', 409);
    return tunnel;
  }
  async ensureTunnel(record) {
    const existing = await this.findTunnel(record);
    if (existing) return existing.id;
    const created = await this.request('POST', this.tunnelPath(), { name: record.tunnelName, config_src: 'cloudflare' });
    if (!created?.id) throw new RemoteCloudError('cloudflare_response', 'The secure connection service returned an unexpected response.');
    return created.id;
  }
  async configure(record, { deny = false } = {}) {
    this.assertRecord(record);
    await this.request('PUT', `${this.tunnelPath(record.tunnelId)}/configurations`, { config: { ingress: [
      ...(deny ? [] : [{ hostname: record.hostname, service: NEMO_TUNNEL_ORIGIN, originRequest: {} }]),
      { service: 'http_status:404' },
    ] } });
  }
  async findDns(record) {
    this.assertRecord(record);
    const found = await this.request('GET', `${this.dnsPath()}?name=${segment(record.hostname)}`);
    if (!Array.isArray(found)) throw new RemoteCloudError('cloudflare_response', 'The secure connection service returned an unexpected response.');
    const matching = found.filter(item => item.name === record.hostname);
    if (matching.length > 1) throw new RemoteCloudError('dns_conflict', 'This connection needs attention from the Nemo service operator.', 409);
    const current = matching[0];
    if (current && (current.type !== 'CNAME' || current.content !== `${record.tunnelId}.cfargotunnel.com` || current.proxied !== true)) throw new RemoteCloudError('dns_conflict', 'The reserved address has an unexpected DNS record. The Nemo service operator must resolve it.', 409);
    return current || null;
  }
  async ensureDns(record) {
    const current = await this.findDns(record);
    if (current) return current.id;
    const created = await this.request('POST', this.dnsPath(), { type: 'CNAME', name: record.hostname, content: `${record.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });
    if (!created?.id) throw new RemoteCloudError('cloudflare_response', 'The secure connection service returned an unexpected response.');
    return created.id;
  }
  async getToken(record) {
    this.assertRecord(record);
    const token = await this.request('GET', `${this.tunnelPath(record.tunnelId)}/token`);
    if (typeof token !== 'string' || token.length < 20) throw new RemoteCloudError('cloudflare_response', 'The secure connection service returned an unexpected response.');
    return token;
  }
  async retire(record, checkpoint = async () => {}) {
    this.assertRecord(record);
    // Reconcile by the immutable reserved name after a crash between create and checkpoint.
    const tunnel = await this.findTunnel(record);
    if (tunnel && record.tunnelId && tunnel.id !== record.tunnelId) throw new RemoteCloudError('tunnel_conflict', 'This connection needs attention from the Nemo service operator.', 409);
    const current = { ...record, tunnelId: tunnel?.id || record.tunnelId };
    if (tunnel) {
      await this.configure(current, { deny: true });
      await checkpoint('ingress_disabled');
    }
    if (current.tunnelId) {
      const dns = await this.findDns(current);
      if (dns) await this.request('DELETE', this.dnsPath(dns.id), undefined, { allow404: true });
      await checkpoint('dns_removed');
    }
    if (tunnel) {
      // Cleaning connections alone is not revocation. Disable ingress first, then delete the tunnel.
      await this.request('DELETE', `${this.tunnelPath(current.tunnelId)}/connections`, undefined, { allow404: true });
      await checkpoint('connections_removed');
      await this.request('DELETE', this.tunnelPath(current.tunnelId), undefined, { allow404: true });
    }
    await checkpoint('tunnel_removed');
  }
}
