import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createFamilyServer } from '../lib/family-server.mjs';

async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'nemo-phone-pair-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('phone preview is non-consuming, short lived, and confirmed profile is checked atomically', async t => {
  let time = Date.now();
  const store = await createProfileStore({ dataDir: await directory(t), now: () => time });
  const owner = await store.owner(), child = await store.create('Alex', true);
  await store.setParentalReview(child.id, true);
  const invitation = await store.invite(child.id, 'desktop-setup', { ttlMs: 600_000 });
  assert.equal(invitation.expiresAt - time, 600_000);
  const preview = await store.previewInvite(invitation.code);
  assert.equal(preview.profile.name, 'Alex'); assert.equal(preview.profile.parentalReview, true);
  assert.equal((await store.previewInvite(invitation.code)).profile.id, child.id);
  await assert.rejects(store.redeem(invitation.code, 'Phone', owner.id), error => error.code === 'PAIR_CHANGED');
  const result = await store.redeem(invitation.code, 'Phone', child.id);
  assert.equal(result.profile.id, child.id);
  await assert.rejects(store.previewInvite(invitation.code), error => error.code === 'PAIR_INVALID');
  const expired = await store.invite(owner.id, 'desktop-setup', { ttlMs: 60_000 });
  time += 60_001;
  await assert.rejects(store.redeem(expired.code), error => error.code === 'PAIR_INVALID');
});

async function fixture(t, options = {}) {
  const app = await createFamilyServer({ dataDir: await directory(t), publicDir: fileURLToPath(new URL('../public', import.meta.url)), provider: { status: () => ({ connected: true }), run: async () => { throw new Error('Pairing must not run inference.'); } }, logger() {}, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    // Node fetch reserves Host; use a real HTTP client to exercise ingress guards.
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers }, res => { const bytes = []; res.on('data', value => bytes.push(value)); res.on('end', () => resolve(new Response(Buffer.concat(bytes), { status: res.statusCode, headers: res.headers }))); });
      req.once('error', reject); req.end(body);
    });
  }
  return { app, base, get: (path, headers) => request(path, { headers }), async post(path, body, headers = {}) { const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1', ...headers }, body: JSON.stringify(body) }); return { response, data: await response.json() }; } };
}

test('HTTP phone page cannot consume invitations on scan; preview/confirm requires matching person', async t => {
  const f = await fixture(t), owner = await f.app.profiles.owner(), invitation = await f.app.profiles.invite(owner.id);
  assert.equal((await fetch(f.base + '/pair.html')).status, 200);
  const preview = await f.post('/api/pair/preview', { code: invitation.code });
  assert.equal(preview.response.status, 200); assert.equal(preview.data.profile.id, owner.id);
  assert.equal((await f.post('/api/pair', { code: invitation.code, expectedProfileId: 'wrong' })).response.status, 409);
  const confirmed = await f.post('/api/pair', { code: invitation.code, expectedProfileId: owner.id });
  assert.equal(confirmed.response.status, 200); assert.match(confirmed.response.headers.get('set-cookie'), /HttpOnly/);
  const other = await f.app.profiles.create('Sam', false), otherInvite = await f.app.profiles.invite(other.id);
  const cookie = confirmed.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.post('/api/pair/preview', { code: otherInvite.code }, { cookie })).data.profile.id, other.id);
  assert.equal((await f.post('/api/pair', { code: otherInvite.code, expectedProfileId: other.id }, { cookie })).response.status, 409);
  assert.equal((await f.app.profiles.previewInvite(otherInvite.code)).profile.id, other.id);
  assert.equal((await f.post('/api/pair', { code: invitation.code, expectedProfileId: owner.id })).response.status, 401);
});

test('public ingress accepts only exact configured origin and verifies a non-private installation proof', async t => {
  const installationId = 'a1ac957b-7061-4f41-baf0-0a07d3658ea0';
  const f = await fixture(t, { publicOrigin: 'https://host-abc.example.test', installationId, trustedProxy: 'cloudflare' });
  const host = { host: 'host-abc.example.test' }, challenge = 'a'.repeat(48);
  const proof = await f.get(`/.well-known/nemo-host?challenge=${challenge}`, host);
  assert.deepEqual(await proof.json(), { service: 'nemo', installationId, challenge });
  const spoof = await f.post('/api/pair/preview', { code: 'INVALID' }, { ...host, origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'cf-connecting-ip': '203.0.113.1' });
  assert.equal(spoof.response.status, 403);
  assert.equal((await f.get('/api/health', { host: 'other.tailnet.ts.net' })).status, 403);
  for (let n = 0; n < 8; n++) await f.post('/api/pair/preview', { code: 'INVALID' }, { ...host, 'cf-connecting-ip': '203.0.113.1' });
  assert.equal((await f.post('/api/pair/preview', { code: 'INVALID' }, { ...host, 'cf-connecting-ip': '203.0.113.1' })).response.status, 429);
  assert.equal((await f.post('/api/pair/preview', { code: 'INVALID' }, { ...host, 'cf-connecting-ip': '203.0.113.2' })).response.status, 401);
});
