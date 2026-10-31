// Owned synthetic UI test. Never opens a user's Electron session or cloud sign-in.
const { app, BrowserWindow } = require('electron');
const { writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.argv[2];
if (!path.isAbsolute(directory || '')) throw Error('A private test directory is required.');
app.setPath('userData', path.join(directory, 'browser'));
let fixture, window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source) { return window.webContents.executeJavaScript(source); }
async function waitFor(source) { for (let i = 0; i < 200; i++) { if (await evaluate(source)) return; await pause(50); } throw Error('Synthetic subscription setup did not reach its expected UI state.'); }
async function click(text) { await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw Error('Expected enabled button'); button.click(); })()`); }
app.whenReady().then(async () => {
  const { startUnifiedPreview } = await import('./desktop-unified-preview.mjs');
  fixture = await startUnifiedPreview({ directory });
  window = new BrowserWindow({ width: 320, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(fixture.entry);
  await waitFor("!!document.querySelector('#setup-name')");
  await evaluate("(() => { const input=document.querySelector('#setup-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Synthetic Parent'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await click('Continue');
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Continue with ChatGPT'&&!b.disabled)");
  assert.equal(await evaluate("document.body.textContent.includes('Local Gemma')"), false);
  await click('Continue with ChatGPT');
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Got it'&&!b.disabled)");
  await click('Got it');
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Continue as Synthetic Parent'&&!b.disabled)");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"ChatGPT plan usage\"]')"), false);
  assert.equal(await evaluate("document.body.textContent.includes('Relevant conversation context is sent to ChatGPT for replies.')"), true);
  const screens = [];
  for (const width of [320, 768, 1440]) {
    window.setContentSize(width, 950); await pause(400);
    const dimensions = await evaluate("({viewport:innerWidth,content:document.documentElement.scrollWidth,boxes:['.desktop-main','.onboarding-content','.setup-intro','.connection-row'].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {selector:s,width:r.width,right:r.right,client:e.clientWidth,scroll:e.scrollWidth}})})");
    await writeFile(path.join(directory, `layout-${width}.json`), JSON.stringify(dimensions));
    assert.ok(dimensions.content <= dimensions.viewport + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.boxes.every(box => box.right <= dimensions.viewport + 1 && box.scroll <= box.client + 1), JSON.stringify(dimensions));
    const image = await window.webContents.capturePage(), file = path.join(directory, `chatgpt-provider-${width}.png`);
    await writeFile(file, image.toPNG()); screens.push(file);
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: true, localSelected: false, requiresChatGPTAcknowledgement: true, responsiveWidths: [320, 768, 1440], screenshots: screens }, null, 2));
}).catch(async () => {
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: 'Synthetic ChatGPT-only UI verification failed.' })); process.exitCode = 1;
}).finally(async () => { window?.destroy(); await fixture?.close(); app.quit(); });
