import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/chat-viewport.js', import.meta.url), 'utf8');
function fixture({ visual = true } = {}) {
  const events = () => {
    const listeners = new Map();
    return { addEventListener(type, callback) { listeners.set(type, callback); }, fire(type) { listeners.get(type)?.(); } };
  };
  const properties = new Map();
  const document = { ...events(), documentElement: { clientHeight: 844, style: { setProperty(key, value) { properties.set(key, value); } } }, body: { dataset: {} }, activeElement: { tagName: 'BODY' } };
  const frames = [];
  const viewport = { ...events(), height: 844, offsetTop: 0, scale: 1 };
  const window = { ...events(), innerHeight: 844, innerWidth: 390, requestAnimationFrame(callback) { frames.push(callback); return frames.length; }, ...(visual ? { visualViewport: viewport } : {}) };
  let resized = 0;
  vm.runInNewContext(source, { window, document });
  window.createNemoViewport({ onResize() { resized++; } });
  return { window, document, viewport, properties, flush() { while (frames.length) frames.shift()(); }, get resized() { return resized; } };
}

test('the composer follows both keyboard resize and Safari viewport panning, then restores after dismissal', () => {
  const f = fixture();
  f.document.activeElement = { tagName: 'TEXTAREA' };
  f.viewport.height = 430;
  f.viewport.offsetTop = 86;
  f.viewport.fire('resize');
  f.flush();
  assert.equal(f.properties.get('--viewport-height'), '430px');
  assert.equal(f.properties.get('--viewport-top'), '86px');
  assert.equal(f.document.body.dataset.keyboardOpen, 'true');
  f.viewport.offsetTop = 120;
  f.viewport.fire('scroll');
  f.flush();
  assert.equal(f.properties.get('--viewport-top'), '120px');
  f.viewport.height = 844;
  f.viewport.offsetTop = 0;
  f.viewport.fire('resize');
  f.flush();
  assert.equal(f.document.body.dataset.keyboardOpen, 'false');
  assert.equal(f.properties.get('--viewport-height'), '844px');
  assert.equal(f.properties.get('--viewport-top'), '0px');
});

test('browser chrome changes and pinch zoom are not treated as an onscreen keyboard', () => {
  const f = fixture();
  f.document.activeElement = { tagName: 'TEXTAREA' };
  f.viewport.height = 780;
  f.viewport.fire('resize');
  f.flush();
  assert.equal(f.document.body.dataset.keyboardOpen, 'false');
  f.viewport.height = 350;
  f.viewport.scale = 2;
  f.viewport.fire('resize');
  f.flush();
  assert.equal(f.document.body.dataset.keyboardOpen, 'false');
  assert.equal(f.properties.get('--viewport-height'), '780px');
});

test('resize bursts share one frame, focus changes resync, and rotation resets the height baseline', () => {
  const f = fixture();
  f.viewport.fire('resize');
  f.viewport.fire('scroll');
  f.window.fire('resize');
  f.flush();
  assert.equal(f.resized, 2);
  f.document.activeElement = { tagName: 'TEXTAREA' };
  f.window.innerWidth = 844;
  f.window.innerHeight = f.document.documentElement.clientHeight = f.viewport.height = 390;
  f.document.fire('focusin');
  f.flush();
  assert.equal(f.document.body.dataset.keyboardOpen, 'false');
  assert.equal(f.properties.get('--viewport-height'), '390px');
});

test('browsers without VisualViewport still fit the available window', () => {
  const f = fixture({ visual: false });
  f.window.innerHeight = 600;
  f.window.fire('resize');
  f.flush();
  assert.equal(f.properties.get('--viewport-height'), '600px');
  assert.equal(f.properties.get('--viewport-top'), '0px');
});
