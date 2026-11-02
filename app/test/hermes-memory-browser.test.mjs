import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';

let chromium;
try { ({ chromium } = createRequire(process.env.NEMO_TEST_BROWSER_PACKAGE || import.meta.url)('playwright')); } catch {}
const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic parent', role: 'owner' };
const conversationId = '22222222-2222-4222-8222-222222222222';
const note = { id: 'hermes:user:' + 'a'.repeat(64), revision: 'r1', title: 'Answer style', text: 'You prefer concise answers.', target: 'user', category: 'preferences', status: 'active', sourceLabel: 'Hermes memory' };

// A frontend-only contract fixture. Native persistence and profile ownership
// are tested through the real bridge/HTTP backend separately.
async function fixture(t) {
  const state = { items: [note], partial: false, failRead: false, calls: [], preview: null };
  const publicRoot = resolve('public');
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const board = () => ({ ok: true, kind: 'hermes-builtin', automatic: true, connected: true, items: state.items,
    summary: { segments: state.items.map(item => ({ id: item.id, revision: item.revision, text: item.text })), sourceCount: state.items.length, totalCount: state.items.length }, learning: { enabled: true, processing: 'hermes' }, references: { gmail: [] } });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = raw ? JSON.parse(raw) : null;
        state.calls.push({ path: url.pathname, input, profile: req.headers['x-nemo-profile'] });
        if (url.pathname === '/api/session') return json(res, { authenticated: true, connected: true, profile, memoryMode: 'profile-hermes', planUsage: { provider: 'chatgpt', enabled: true } });
        if (url.pathname === '/api/conversation') return json(res, { conversationId, messages: [] });
        if (url.pathname === '/api/history') return json(res, { conversations: [] });
        if (url.pathname.startsWith('/api/memory/')) {
          assert.equal(req.headers['x-nemo-profile'], profile.id);
          if (url.pathname === '/api/memory/board') return state.failRead ? json(res, { error: 'Synthetic store read failed.' }, 503) : json(res, board());
          if (url.pathname === '/api/memory/fact') return json(res, { ok: true, item: { ...state.items.find(item => item.id === url.searchParams.get('id')), content: state.items.find(item => item.id === url.searchParams.get('id'))?.text } });
          if (['/api/memory/clear/preview', '/api/memory/delete/preview'].includes(url.pathname)) {
            state.preview = input;
            return json(res, { ok: true, confirmation: 'c'.repeat(64), expiresAt: Date.now() + 120000, summary: url.pathname.includes('/clear/') ? 'Clear both saved memory stores?' : 'Forget this saved detail?', residuals: ['Conversation history remains.', 'Nemo continues learning afterward.'] });
          }
          if (url.pathname === '/api/memory/delete') {
            if (state.partial) return json(res, { ok: false, receipt: { state: 'partial', message: 'One memory store could not be cleared.' } });
            state.items = state.preview?.id ? state.items.filter(item => item.id !== state.preview.id) : [];
            return json(res, { ok: true, receipt: { state: 'complete', message: 'Saved memories cleared.' } });
          }
          if (url.pathname === '/api/memory/edit') {
            state.items = state.items.map(item => item.id === input.id ? { ...item, text: input.content, revision: 'r2' } : item);
            return json(res, { ok: true });
          }
        }
        return json(res, { error: 'Unexpected frontend test route.' }, 404);
      }
      const path = resolve(publicRoot, '.' + url.pathname), contained = relative(publicRoot, path);
      if (!contained || contained.startsWith('..') || isAbsolute(contained)) return json(res, { error: 'Not found' }, 404);
      const content = await readFile(path), types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(content);
    } catch (error) { json(res, { error: error.message }, 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  browser = await chromium.launch({ headless: true, channel: process.env.NEMO_TEST_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  async function screenshot(name) {
    if (!process.env.NEMO_BROWSER_EVIDENCE_DIR) return;
    const directory = resolve(process.env.NEMO_BROWSER_EVIDENCE_DIR); await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, name + '.png'), fullPage: true });
  }
  return { state, base, page, errors, screenshot };
}

test('native browser Memory is automatic, uses plain search and keeps clear failures explicit', { skip: !chromium, timeout: 45000 }, async t => {
  const f = await fixture(t), { page } = f;
  await page.goto(f.base + '/memory.html');
  await page.getByRole('button', { name: 'Edit memory: ' + note.text, exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Enable local memory|Stop using/ }).count(), 0);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  assert.equal(await page.locator('#nemoMenu').getByRole('link', { name: 'Memory', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Find a memory' }).fill('concise');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  assert.equal(f.state.calls.some(call => /mirror|semantic|learning|enable/.test(call.path)), false);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'browser Memory overflow at ' + width);
    if ([320,1440].includes(width)) await f.screenshot('native-browser-memory-' + width);
  }
  await page.getByRole('button', { name: 'Memory settings', exact: true }).click();
  assert.equal(await page.locator('#memory-settings').getByText('Relevant notes are sent with ChatGPT requests.', { exact: false }).count(), 1);
  await page.locator('#memory-clear').click(); await page.locator('#memory-preview').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(f.state.calls.filter(call => call.path === '/api/memory/delete').length, 0);
  f.state.partial = true;
  await page.locator('#memory-clear').click(); await page.locator('#memory-confirm-delete').click();
  await page.locator('#memory-message').filter({ hasText: 'Some memories may remain.' }).waitFor();
  assert.equal(f.state.items.length, 1);
  assert.deepEqual(f.errors, []);
});

test('native browser read errors recover without showing engine setup or an Off control', { skip: !chromium, timeout: 30000 }, async t => {
  const f = await fixture(t), { page } = f; f.state.failRead = true;
  await page.goto(f.base + '/memory.html');
  await page.getByText('Your memories could not be read.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Memory settings', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#memory-enable').count(), 0);
  f.state.failRead = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Edit memory: ' + note.text, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Memory settings', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('#memory-message').isHidden(), true);
  assert.deepEqual(f.errors, []);
});

test('compiled desktop Memory exposes native Forget/Clear without Off or local-engine setup', { skip: !chromium, timeout: 45000 }, async t => {
  const f = await fixture(t), { page } = f;
  await page.goto(f.base + '/desktop.html#memory');
  await page.getByRole('heading', { name: 'A little more you.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View memory: Answer style', exact: true }).waitFor();
  assert.equal(await page.locator('.desktop-memory').getByRole('checkbox').count(), 0);
  assert.equal(await page.getByText('Memory is automatic. Nemo keeps useful details as you chat.', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('.desktop-memory-item small').textContent(), 'About you · Saved detail');
  assert.equal(await page.getByRole('button', { name: 'Enable local Memory', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'View memory: Answer style', exact: true }).click();
  assert.equal(await page.getByLabel('Memory', { exact: true }).inputValue(), note.text);
  await page.getByRole('button', { name: 'Forget memory', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Memory', { exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(f.state.calls.filter(call => call.path === '/api/memory/delete').length, 0);
  await page.getByRole('button', { name: 'Close memory editor', exact: true }).click();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 760) await page.waitForFunction(() => !document.querySelector('.desktop-main')?.inert && document.querySelector('#desktop-sidebar').getBoundingClientRect().right <= 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop Memory overflow at ' + width);
    if ([320,1440].includes(width)) await f.screenshot('native-desktop-memory-' + width);
  }
  f.state.partial = true;
  await page.getByRole('button', { name: 'Clear memories', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear memories', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Some memories may remain.' }).waitFor();
  f.state.partial = false;
  await page.locator('.memory-list-actions').getByRole('button', { name: 'Clear memories', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear memories', exact: true }).click();
  await page.getByText('Saved memories cleared.', { exact: true }).waitFor();
  assert.equal(f.state.items.length, 0);
  assert.equal(await page.getByText('Memory is automatic. Nemo keeps useful details as you chat.', { exact: true }).isVisible(), true);
  assert.deepEqual(f.errors, []);
});
