import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNemoServer } from '../lib/personal-gateway.mjs';

test('memory routes stay on the paired browser and hide the other conversation', async t => {
  const prefix = fileURLToPath(new URL('./.tmp-memory-http-', import.meta.url));
  const dataDir = await mkdtemp(prefix);
  t.after(async () => {
    const target = resolve(dataDir);
    assert.equal(dirname(target), dirname(resolve(prefix)));
    assert.ok(basename(target).startsWith(basename(prefix)));
    await rm(target, { recursive: true, force: true });
  });
  const app = await createNemoServer({
    dataDir, publicDir: fileURLToPath(new URL('../public/', import.meta.url)), pairingCode: '12345678',
    now: () => Date.parse('2026-10-21T01:00:00.000Z'),
    provider: { status: () => ({ connected: true, model: 'mock' }), async run() { return { text: 'Mock reply', sessionId: 'provider-session' }; } },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', cookie, body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const page = await fetch(base + '/memory.html');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<script type="module" src="\/memory\.js"><\/script>/);
  assert.match(html, /id="memory-root"/);
  assert.equal(html.includes('innerHTML'), false);
  assert.equal((await request('/api/memory')).status, 401);
  const alice = (await request('/api/pair', { method: 'POST', body: { code: '12345678' } })).cookie;
  const bob = (await request('/api/pair', { method: 'POST', body: { code: '12345678' } })).cookie;
  const sent = await request('/api/chat', { method: 'POST', cookie: alice, body: { message: 'ALPHA_ONLY_TRANSCRIPT', requestId: randomUUID() } });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const deadline = Date.now() + 4000;
  let finished;
  do {
    finished = await request(`/api/runs/${sent.data.runId}`, { cookie: alice });
    if (['completed', 'failed'].includes(finished.data.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(finished.data.status, 'completed');
  const own = await request('/api/memory/item?id=nemo:chat', { cookie: alice });
  const other = await request('/api/memory', { cookie: bob });
  assert.equal(own.status, 200);
  assert.equal(own.data.item.content.includes('ALPHA_ONLY_TRANSCRIPT'), true);
  assert.equal(JSON.stringify(other.data).includes('ALPHA_ONLY_TRANSCRIPT'), false);
  const detail = await request('/api/memory/item?id=nemo:chat', { cookie: bob });
  assert.equal(detail.status, 404);
  const listed = await request('/api/memory', { cookie: alice });
  assert.equal(listed.data.ok, true);
  assert.equal(listed.data.stores.find(store => store.id === 'gbrain').connected, false);
  assert.match(listed.data.stores.find(store => store.id === 'gmail').description, /Searched live/);
});
