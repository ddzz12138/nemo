import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/identity.js', import.meta.url), 'utf8');
test('identity shares native Memory availability from existing session reads and clears it on logout',async()=>{
 let reads=0;const window={fetch:async path=>{if(path==='/api/session'){reads++;return Response.json({authenticated:true,profile:{id:'synthetic',name:'Synthetic'},memoryMode:'profile-hermes'});}return Response.json({ok:true});}};
 const document={getElementById:()=>null,querySelectorAll:()=>[],body:{replaceChildren(){}}};
 vm.runInNewContext(source,{window,document,Headers});
 const [first,second]=await Promise.all([window.NemoIdentity.load(),window.NemoIdentity.load()]);
 assert.equal(reads,1);assert.equal(first.memoryMode,'profile-hermes');assert.equal(second.memoryMode,'profile-hermes');assert.equal(window.NemoIdentity.memoryMode,'profile-hermes');
 await window.nemoFetch('/api/logout',{method:'POST'});assert.equal(window.NemoIdentity.memoryMode,'chat-history');assert.equal(window.NemoIdentity.profile,null);
});
test('browser identity pins read/write requests and discards responses from a previous person', async () => {
  const calls = []; let release; let removed = false; let reloaded = false; let listener;
  const alice = { id: 'alice', name: 'Alice' }; const bob = { id: 'bob', name: 'Bob' };
  const window = { location: { reload() { reloaded = true; } }, async fetch(path, options) { calls.push({ path, options }); if (path === '/api/session') return Response.json({ profile: alice }); if (path === '/api/pair') return Response.json({ profile: bob }); return new Promise(resolve => { release = () => resolve(Response.json({ private: 'alice' })); }); } };
  class Channel { addEventListener(type, fn) { listener = fn; } postMessage() {} }
  const label = { textContent: '' };
  vm.runInNewContext(source, { window, document: { getElementById: () => null, querySelectorAll: () => [label], body: { replaceChildren() { removed = true; } } }, BroadcastChannel: Channel, Headers });
  await window.NemoIdentity.load(); assert.equal(label.textContent, 'Alice');
  const pending = window.nemoFetch('/api/history'); await new Promise(done => setImmediate(done)); assert.equal(calls.at(-1).options.headers.get('X-Nemo-Profile'), 'alice');
  await window.nemoFetch('/api/pair', { method: 'POST' }); release(); await assert.rejects(pending, /profile changed/);
  const before = calls.length; await assert.rejects(window.nemoFetch('/api/chat', { method: 'POST', headers: { 'X-Nemo-Profile': 'alice' } }), /profile changed/); assert.equal(calls.length, before);
  listener(); assert.equal(removed, true); assert.equal(reloaded, true);
});
