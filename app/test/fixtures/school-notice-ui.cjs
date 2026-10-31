// Owns its synthetic browser session; never opens the user's app or inbox.
const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.argv[2]; if (!path.isAbsolute(directory || '')) throw Error('A fixture directory is required.');
// Keep this owned screenshot fixture independent of the user's GPU workload.
app.disableHardwareAcceleration();
app.setPath('userData', path.join(directory, 'browser'));
let server, window, reads = 0, calls = 0;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function evaluate(source) { return window.webContents.executeJavaScript(source); }
async function wait(source) { for (let i = 0; i < 250; i++) { if (await evaluate(source)) return; await pause(40); } throw Error('Synthetic notice UI did not reach its expected state.'); }
async function click(label) { await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)throw Error('Expected enabled button');e.click();})()`); }
async function type(id, value) { await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
app.whenReady().then(async () => {
  const { createNemoServer } = await import('../../server.mjs'), { once } = await import('node:events');
  server = await createNemoServer({ dataDir: path.join(directory, 'data'), nativeFactory: null, memoryFactory: null, logger() {},
    provider: { status: () => ({ connected: true, inferenceProvider: 'ollama' }), async run(input) { calls++; assert.equal(input.useIntegrations, false); return { text: JSON.stringify({ actions: [{ paragraph: 'p2', action: 'Return the consent form', quote: 'Return the consent form by 5 November 2026.', dateText: '5 November 2026' }] }) }; } },
    async integrationsForProfile() { return { gmail: { status: () => ({ connected: true }), noticeGrant: async () => 'synthetic-grant',
      searchPage: async ({ query }) => { await pause(180); return { messages: query === 'empty' ? [] : [{ id: 'one', subject: 'Year 9 excursion — a longer synthetic subject to check narrow phone layouts', from: 'School <school@example.test>', date: '31 October 2026', snippet: '<img src=x onerror=alert(1)> A preview with text only.' }], hasMore: true }; },
      readSelectedNotice: async () => { reads++; return { subject: 'Synthetic school notice', from: 'School', text: 'Year 9\nReturn the consent form by 5 November 2026.', bodyComplete: true, attachments: true, linkedPages: false }; },
    } }; },
  });
  server.server.listen(0, '127.0.0.1'); await once(server.server, 'listening'); const origin = 'http://127.0.0.1:' + server.server.address().port;
  window = new BrowserWindow({ width: 320, height: 1000, frame: false, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  const owner = await server.profiles.owner(), invite = await server.profiles.invite(owner.id);
  const paired = await window.webContents.session.fetch(origin + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invite.code, deviceName: 'Synthetic renderer' }) }); assert.equal(paired.status, 200);
  await window.loadURL(origin + '/desktop.html'); await wait("!!document.querySelector('#desktop-message')");
  await type('desktop-message', 'Keep my unfinished chat draft.');
  await evaluate("location.hash='school'"); await wait("!!document.querySelector('#notice-query')");
  await type('notice-query', 'empty'); await click('Find notices'); await wait("document.body.textContent.includes('No matching notice')");
  await type('notice-query', 'school'); await click('Find notices'); await wait("!!document.querySelector('.notice-option input')");
  assert.equal(await evaluate("document.querySelector('.notice-results img')===null"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent==='Brief selected notice').disabled"), true);
  await evaluate("document.querySelector('.notice-option input').click()");
  assert.equal(reads, 0); assert.equal(calls, 0);
  await evaluate("document.querySelector('.notice-consent input').click()");
  const widths = [320, 768, 1024, 1440];
  for (const width of widths) {
    window.setContentSize(width, 1000); await pause(300);
    const geometry = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,boxes:[...document.querySelectorAll('.notice-page,.notice-search-row,.notice-option,.notice-confirm')].map(e=>{const r=e.getBoundingClientRect();return {right:r.right,scroll:e.scrollWidth,client:e.clientWidth}})})");
    assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry)); assert.ok(geometry.boxes.every(box => box.right <= geometry.width + 1 && box.scroll <= box.client + 1), JSON.stringify(geometry));
    await writeFile(path.join(directory, `notice-${width}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await click('Brief selected notice'); await wait("document.body.textContent.includes('2026-11-05')&&!!document.querySelector('.notice-activity')");
  await wait("[...document.querySelectorAll('.message-assistant')].some(e=>e.innerText.includes('2026-11-05')&&e.innerText.includes('N1:p2'))");
  assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(await evaluate("document.body.textContent.includes('Attachments were not opened')"), true);
  assert.equal(await evaluate("document.querySelector('#desktop-message').value"), 'Keep my unfinished chat draft.');
  await pause(400);
  await writeFile(path.join(directory, 'conversation-dom.txt'), await evaluate("document.querySelector('.message-list').innerText"));
  await writeFile(path.join(directory, 'briefing.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: true, widths, reads, localExtractions: calls, liveSourcesUsed: false, consentRequired: true, activityVisible: true }));
}).catch(async error => { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }).finally(async () => { window?.destroy(); await server?.close(); app.quit(); });
