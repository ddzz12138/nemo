import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRemoteHost } from '../lib/remote-host.mjs';
import { createRemoteCloudClient } from '../lib/remote-host-cloud-client.mjs';
import { createCloudflaredConnector } from '../lib/remote-host-connector.mjs';

const token = 'opaque-connector-token-for-tests';
const publicOrigin = 'https://host-test.nemo.example';
const tunnelId = randomUUID();
const copy = value => value ? structuredClone(value) : value;
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-remote-test-'));
  const secrets = { value: null, async load() { return copy(this.value); }, async save(value) { this.value = copy(value); } };
  const calls = [], connector = { starts: 0, stops: 0, onExit: null, async available() { return true; }, async start(value, { onExit }) { assert.equal(value, token); this.starts++; this.onExit = onExit; }, async stop() { this.stops++; }, crash() { this.onExit(); } };
  let installation;
  const cloud = {
    async beginEnrollment(auth) { calls.push(['enroll', copy(auth)]); installation = auth.installationId; return { enrollmentId: randomUUID(), browserUrl: 'https://accounts.nemo.example/sign-in', confirmationCode: '123456', expiresAt: new Date(Date.now() + 60_000).toISOString(), pollAfterMs: 3000 }; },
    async pollEnrollment() { return { status: 'approved', installationId: installation }; },
    async enable(auth) { calls.push(['enable', copy(auth)]); return { installationId: auth.installationId, status: 'active', publicOrigin, tunnelId, connectorToken: token }; },
    async credentials(auth) { return { installationId: auth.installationId, status: 'active', publicOrigin, tunnelId, connectorToken: token }; },
    async retire(auth) { calls.push(['retire', copy(auth)]); return { installationId: auth.installationId, status: 'retired' }; },
  };
  const args = { dataDir, cloud, secretStore: secrets, connector, activateOrigin: async () => ({ ready: true }), verifyPublic: async () => true, ...options };
  const host = await createRemoteHost(args);
  t.after(async () => { await host.close(); if (!dataDir.startsWith(join(tmpdir(), 'nemo-remote-test-'))) throw new Error('Unsafe test cleanup'); await rm(dataDir, { recursive: true, force: true }); });
  const approve = async () => { await host.beginEnrollment({ displayName: 'Parent' }); await host.pollEnrollment(); };
  return { dataDir, args, host, cloud, connector, secrets, calls, approve };
}

test('parent signs in, enables a verified connection and stops it without plaintext credentials', async t => {
  const f = await fixture(t); await f.approve();
  assert.equal(f.host.status().account.state, 'approved');
  const connected = await f.host.enable(); assert.equal(connected.canPair, true); assert.equal(connected.phase, 'ready');
  const disk = await readFile(join(f.dataDir, 'remote-access.json'), 'utf8');
  assert.equal(disk.includes(token), false); assert.equal(disk.includes(f.secrets.value.installationSecret), false);
  assert.equal(JSON.stringify(connected).includes(token), false);
  const stopped = await f.host.disable(); assert.equal(stopped.canPair, false); assert.equal(stopped.retirementPending, false); assert.equal(f.secrets.value.connectorToken, undefined);
  assert.equal(f.calls.at(-1)[0], 'retire');
  assert.equal((await f.host.enable()).publicOrigin, publicOrigin, 're-enabling retains the address');
});

test('a connector process and assigned address never count as reachable', async t => {
  const f = await fixture(t, { verifyPublic: async () => false }); await f.approve();
  const state = await f.host.enable(); assert.equal(state.phase, 'offline'); assert.equal(state.canPair, false); assert.equal(f.connector.starts, 1);
});

test('application restart must complete before phone pairing', async t => {
  const f = await fixture(t, { activateOrigin: async () => ({ ready: false }) }); await f.approve();
  const state = await f.host.enable(); assert.equal(state.phase, 'connecting'); assert.equal(state.canPair, false); assert.match(state.message, /Restart/);
});

test('a lost enrollment response retains installation identity for retry', async t => {
  const f = await fixture(t); const begin = f.cloud.beginEnrollment; let first = true;
  f.cloud.beginEnrollment = async auth => { const result = await begin(auth); if (first) { first = false; throw new Error('response lost'); } return result; };
  await assert.rejects(f.host.beginEnrollment(), /could not open/);
  const secret = f.secrets.value.installationSecret;
  await f.host.beginEnrollment();
  assert.equal(f.calls[0][1].installationId, f.calls[1][1].installationId); assert.equal(f.secrets.value.installationSecret, secret);
});

test('approval recovery skips a duplicate browser sign-in and expired invitations can restart', async t => {
  const recovered = await fixture(t);
  recovered.cloud.beginEnrollment = async ({ installationId }) => ({ status: 'approved', installationId, browserUrl: null });
  assert.deepEqual(await recovered.host.beginEnrollment(), { state: 'approved' });
  assert.equal(recovered.secrets.value.approved, true); assert.equal((await recovered.host.enable()).canPair, true);
  const expired = await fixture(t); await expired.host.beginEnrollment();
  expired.cloud.pollEnrollment = async () => { throw Object.assign(new Error('expired'), { code: 'ENROLLMENT_EXPIRED' }); };
  assert.deepEqual(await expired.host.pollEnrollment(), { state: 'expired' });
  assert.equal(expired.host.status().account.state, 'signed-out'); assert.equal(expired.secrets.value.enrollmentId, undefined);
  assert.equal((await expired.host.beginEnrollment()).state, 'pending');
});

test('a lost provisioning response retries the same installation without leaking errors', async t => {
  const f = await fixture(t); await f.approve(); const enable = f.cloud.enable; let first = true;
  f.cloud.enable = async auth => { const result = await enable(auth); if (first) { first = false; throw new Error(token); } return result; };
  const failed = await f.host.enable(); assert.equal(failed.canPair, false); assert.equal(JSON.stringify(failed).includes(token), false);
  const retried = await f.host.enable(); assert.equal(retried.canPair, true);
  const calls = f.calls.filter(item => item[0] === 'enable'); assert.equal(calls[0][1].installationId, calls[1][1].installationId);
});

test('restart restores the same installation and uncertain retirement blocks pairing', async t => {
  const f = await fixture(t); await f.approve(); await f.host.enable(); await f.host.close();
  const restored = await createRemoteHost(f.args); t.after(() => restored.close());
  assert.equal((await restored.restore()).canPair, true);
  f.cloud.retire = async () => { throw new Error('offline'); };
  const disabled = await restored.disable(); assert.equal(disabled.retirementPending, true); assert.equal(disabled.canPair, false);
  await assert.rejects(restored.enable(), /still confirming/);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'remote-access.json'), 'utf8')); assert.equal(persisted.wanted, false);
  f.cloud.retire = async ({ installationId }) => ({ installationId, status: 'retired' });
  assert.equal((await restored.disable()).retirementPending, false);
});

test('crashes invalidate readiness immediately and bound restarts', async t => {
  const f = await fixture(t, { retryDelays: [1, 1], readinessIntervalMs: 60_000 }); await f.approve(); await f.host.enable();
  for (let crash = 0; crash < 3; crash++) {
    f.connector.crash(); assert.equal(f.host.status().canPair, false);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(f.connector.starts, 3); assert.equal(f.host.status().phase, 'error');
  await f.host.disable(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.connector.starts, 3);
});

test('a late activation or readiness response cannot resurrect an exited connector', async t => {
  let releaseActivation, activationStarted;
  const started = new Promise(resolve => { activationStarted = resolve; });
  const f = await fixture(t, { retryDelays: [], activateOrigin: () => { activationStarted(); return new Promise(resolve => { releaseActivation = resolve; }); } });
  await f.approve(); const enabling = f.host.enable(); await started; f.connector.crash(); releaseActivation({ ready: true }); await enabling;
  assert.equal(f.host.status().canPair, false); assert.equal(f.host.status().phase, 'error');
  let releaseProbe, probeStarted;
  const probing = new Promise(resolve => { probeStarted = resolve; });
  f.args.activateOrigin = async () => ({ ready: true }); f.args.verifyPublic = () => { probeStarted(); return new Promise(resolve => { releaseProbe = resolve; }); };
  await f.host.close();
  const restored = await createRemoteHost(f.args); t.after(() => restored.close());
  const restoring = restored.restore(); await probing; f.connector.crash(); releaseProbe(true); await restoring;
  assert.equal(restored.status().canPair, false); assert.equal(restored.status().phase, 'error');
});

test('an unconfirmed local stop still retires the remote route and reports uncertainty', async t => {
  const f = await fixture(t); await f.approve(); await f.host.enable();
  const stop = f.connector.stop; f.connector.stop = async () => { throw new Error('cannot confirm stop'); };
  const state = await f.host.disable(); assert.equal(state.localStopPending, true); assert.equal(state.canPair, false); assert.equal(state.phase, 'error');
  assert.equal(f.calls.at(-1)[0], 'retire'); assert.equal(state.retirementPending, false);
  f.connector.stop = stop;
});

test('connector enforces an absolute hash-pinned binary and keeps token out of argv and logs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nemo-remote-test-')); const file = join(dir, 'cloudflared.exe'); await writeFile(file, 'verified fixture');
  t.after(async () => { if (!dir.startsWith(join(tmpdir(), 'nemo-remote-test-'))) throw new Error('Unsafe test cleanup'); await rm(dir, { recursive: true, force: true }); });
  let captured;
  const connector = createCloudflaredConnector({ executablePath: file, sha256: createHash('sha256').update('verified fixture').digest('hex'), spawnImpl: (executable, args, options) => {
    captured = { executable, args, options }; const child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  await connector.start(token); assert.equal(captured.args.join(' ').includes(token), false); assert.equal(captured.options.stdio, 'ignore'); assert.equal(captured.options.env.TUNNEL_TOKEN, token); assert.equal(captured.options.shell, false); await connector.stop();
  await writeFile(file, 'changed'); assert.equal(await connector.available(), false); await assert.rejects(connector.start(token), /reinstall/);
  assert.equal(await createCloudflaredConnector({ executablePath: 'cloudflared', sha256: '0'.repeat(64) }).available(), false);
});

test('cloud HTTP client pins HTTPS origin, refuses redirects and strips raw service errors', async () => {
  assert.throws(() => createRemoteCloudClient({ origin: 'http://example.test' }), /secure/);
  const requests = []; const client = createRemoteCloudClient({ origin: 'https://accounts.nemo.example', fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ error: token }), { status: 500 }); } });
  await assert.rejects(client.enable({ installationId: randomUUID(), installationSecret: 'A'.repeat(43) }), error => !error.message.includes(token));
  assert.equal(requests[0].options.redirect, 'error'); assert.equal(requests[0].options.headers.authorization, `Bearer ${'A'.repeat(43)}`); assert.equal(requests[0].url.includes('A'.repeat(43)), false);
  const phishing = createRemoteCloudClient({ origin: 'https://accounts.nemo.example', fetchImpl: async () => new Response(JSON.stringify({ browserUrl: 'https://attacker.example/login' })) });
  await assert.rejects(phishing.beginEnrollment({ installationId: randomUUID(), installationSecret: 'A'.repeat(43) }), /sign-in page/);
  const expired = createRemoteCloudClient({ origin: 'https://accounts.nemo.example', fetchImpl: async () => new Response('{}', { status: 410 }) });
  await assert.rejects(expired.pollEnrollment({ enrollmentId: randomUUID(), installationSecret: 'A'.repeat(43) }), { code: 'ENROLLMENT_EXPIRED' });
  const installationId = randomUUID();
  const approved = createRemoteCloudClient({ origin: 'https://accounts.nemo.example', fetchImpl: async () => new Response(JSON.stringify({ status: 'approved', installationId, browserUrl: null })) });
  assert.equal((await approved.beginEnrollment({ installationId, installationSecret: 'A'.repeat(43) })).status, 'approved');
});
