import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createDesktopApi, activityLabel, createViewGate } from '../public/desktop-api.mjs';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
const require = createRequire(import.meta.url);
const { chatLaunch, chatNavigation, gmailAuthorization, chatSender, authorizeDesktopSetup, authorizeDesktopProfile } = require('../desktop/chat-contracts.cjs');
const { ignore } = require('../desktop/packaging.cjs');
const person = { id: randomUUID(), name: 'Synthetic adult' };

test('desktop sends use the displayed profile and preserve the request id without model or tool overrides', async () => {
  const calls = [], id = randomUUID();
  const api = createDesktopApi({ getProfile: () => person, fetchImpl: async (path, options) => { calls.push({ path, options }); return Response.json({ runId: id }); } });
  await api.send('Hello', id); await api.send('Hello', id);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'Hello', requestId: id });
  assert.equal(calls[0].options.headers['X-Nemo-Profile'], person.id);
  assert.equal(calls[0].options.headers['X-Nemo-Request'], '1');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, calls[1].options.body);
});
test('anonymous and external desktop requests cannot dispatch private actions', async () => {
  let calls = 0;
  const api = createDesktopApi({ getProfile: () => null, fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(api.conversation(), /personal|profile/);
  for (const path of ['https://evil.test/api/chat', '//evil.test/api/chat', '/api/chat?profileId=another', '/api/\\evil']) await assert.rejects(api.request(path), /Nemo action/);
  assert.equal(calls, 0);
});
test('late desktop responses are discarded after identity changes, including during JSON decoding', async () => {
  let active = person, epoch = 0, release;
  const api = createDesktopApi({ getProfile: () => active, getEpoch: () => epoch, fetchImpl: async () => ({ ok: true, json: () => new Promise(done => { release = done; }) }) });
  const pending = api.conversation(); await new Promise(done => setImmediate(done));
  active = { id: randomUUID(), name: 'Different person' }; epoch++;
  release({ messages: [{ text: 'PRIVATE_FIRST_PERSON' }] });
  await assert.rejects(pending, error => error.code === 'PROFILE_CHANGED');
});

test('successful logout can clear its identity while retaining the old-profile mutation header',async()=>{
  let epoch=0;const calls=[];
  const api=createDesktopApi({getProfile:()=>person,getEpoch:()=>epoch,fetchImpl:async(path,options)=>{calls.push({path,options});epoch++;return Response.json({ok:true,ignored:'No private payload may be returned.'});}});
  assert.deepEqual(await api.request('/api/logout',{}),{ok:true});
  assert.equal(calls[0].options.headers['X-Nemo-Profile'],person.id);
});
test('chat windows cannot navigate to setup or external content; IPC requires their exact main frame', () => {
  const origin = 'http://127.0.0.1:8787', launch = chatLaunch(origin + '/pair.html#invite=ABCD-EFGH-JKLM-NPQR');
  assert.equal(launch.origin, origin);
  assert.equal(launch.url, origin + '/desktop.html#invite=ABCD-EFGH-JKLM-NPQR');
  assert.equal(chatNavigation(origin + '/desktop.html', origin), true);
  assert.equal(chatNavigation(origin + '/memory.html', origin), false);
  for (const value of [origin + '/host-setup.html', origin + '/api/setup/status', 'https://evil.test/desktop.html', origin + '/desktop.html?redirect=other', 'javascript:alert(1)']) assert.equal(chatNavigation(value, origin), false);
  assert.throws(() => chatLaunch('http://127.0.0.1:8787/host-setup.html#setup=secret'));
  const frame = { url: origin + '/desktop.html' }, contents = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  assert.doesNotThrow(() => chatSender({ sender: contents, senderFrame: frame }, window, origin));
  assert.throws(() => chatSender({ sender: contents, senderFrame: { url: frame.url } }, window, origin));
  frame.url = origin + '/pair.html'; assert.throws(() => chatSender({ sender: contents, senderFrame: frame }, window, origin));
});
test('build dependencies are excluded while the compiled UI, licences and isolated preload ship', () => {
  assert.equal(ignore('/desktop/interface/node_modules/react/index.js'), true);
  assert.equal(ignore('/desktop/interface/upstream/SidebarLayout.tsx'), true);
  for (const file of ['/public/desktop.html','/public/desktop-ui.js','/public/desktop-api.mjs','/public/vendor/ollama-LICENSE.txt','/desktop/preload.cjs']) assert.equal(ignore(file), false);
});

test('shared desktop setup IPC checks current owner identity and rechecks navigation after authentication', async () => {
  const appOrigin='http://127.0.0.1:8787',setupUrl='http://127.0.0.1:45555/setup/';
  const frame={url:appOrigin+'/desktop.html'},contents={mainFrame:frame},window={isDestroyed:()=>false,webContents:contents};
  const owner={authenticated:true,profile:{id:person.id,role:'owner'}},event={sender:contents,senderFrame:frame};
  const options={event,window,setupUrl,appOrigin,profileId:person.id,fetchSession:async()=>owner};
  await assert.doesNotReject(authorizeDesktopSetup(options));
  for(const session of [{authenticated:false},{authenticated:true,profile:{id:person.id,role:'member'}},{authenticated:true,profile:{id:randomUUID(),role:'owner'}}])await assert.rejects(authorizeDesktopSetup({...options,fetchSession:async()=>session}),/owner/);
  await assert.rejects(authorizeDesktopSetup({...options,profileId:undefined}),/profile/);
  await assert.rejects(authorizeDesktopSetup({...options,event:{sender:contents,senderFrame:{url:frame.url}}}),/desktop/);
  await assert.rejects(authorizeDesktopSetup({...options,fetchSession:async()=>{frame.url=appOrigin+'/memory.html';return owner;}}),/desktop/);
  frame.url=setupUrl;await assert.doesNotReject(authorizeDesktopSetup({...options,profileId:undefined,fetchSession:async()=>{throw new Error('Bootstrap must not rely on a personal session.');}}));
});

test('Memory detail queries remain bounded, private and restricted to one fact identifier', async () => {
  const calls=[],api=createDesktopApi({getProfile:()=>person,fetchImpl:async(path,options)=>{calls.push({path,options});return Response.json({});}});
  await api.request('/api/memory/fact?id=memory%2Fsynthetic');
  assert.equal(calls[0].options.headers['X-Nemo-Profile'],person.id);
  for(const path of ['/api/memory/fact?id=','/api/memory/fact?id=a&id=b','/api/memory/fact?id=a&profileId=b','/api/memory/fact?id=white%20space','/api/chat?profileId=b'])await assert.rejects(api.request(path),/Nemo action/);
  assert.equal(calls.length,1);
});
test('activity labels come from real Nemo status entries', () => {
  assert.equal(activityLabel({ entries: [{ state: 'completed', label: 'Done' }, { state: 'running', label: 'Checking your calendar…' }] }), 'Checking your calendar…');
  assert.equal(activityLabel({ summary: 'Starting Hermes…' }), 'Starting Hermes…');
});
test('a send or later refresh invalidates an older snapshot for the same profile', async () => {
  const gate = createViewGate(); let release, rendered = 'empty';
  const oldRead = gate.begin();
  const delayed = new Promise(done => { release = done; }).then(value => { if (gate.current(oldRead)) rendered = value; });
  const send = gate.begin(); rendered = 'accepted task';
  release('stale empty history'); await delayed;
  assert.equal(rendered, 'accepted task'); assert.equal(gate.current(send), true);
  const latest = gate.begin(); assert.equal(gate.current(send), false); assert.equal(gate.current(latest), true);
});
test('the fork serves under the existing security policy and real two-profile HTTP keeps conversations and run IDs private', async t => {
  const root = await mkdtemp(resolve('.work/nemo-interface-test-'));
  let app;
  t.after(async () => { await app?.close(); assert.equal(dirname(root), resolve('.work')); assert.ok(root.startsWith(resolve('.work/nemo-interface-test-'))); await rm(root, { recursive: true, force: true }); });
  const calls = [];
  app = await createFamilyServer({ dataDir: root, publicDir: resolve('public'), ownerName: 'Synthetic owner', memoryFactory: null, logger() {}, provider: { status: () => ({ connected: true, inferenceProvider: 'chatgpt', planUsageEnabled: true }), async run(input) { calls.push(input); return { text: 'SYNTHETIC_REPLY_' + input.profileId }; } }, async integrationsForProfile(profile, { dataDir }) { return { calendar: await createCalendarStore({ dataDir }), gmail: { async status() { return { connected: false, configured: false }; }, async syncStatus() { return { mode: 'demand', count: 0 }; }, async close() {} }, gbrain: new Proxy({}, { get() { throw new Error('No real memory service may be used by this test.'); } }) }; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/desktop.html','/desktop-ui.js','/desktop-ui.css','/desktop-api.mjs','/vendor/ollama-LICENSE.txt','/vendor/react-LICENSE.txt']) { const response = await fetch(base + path); assert.equal(response.status, 200, path); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/); }
  const anonymous = createDesktopApi({ getProfile: () => null, fetchImpl: (path, options) => fetch(base + path, options) }); assert.equal((await anonymous.session()).authenticated, false);
  async function pair(profile) { const invitation = await app.profiles.invite(profile.id); const response = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify({ code: invitation.code, expectedProfileId: profile.id, deviceName: 'Synthetic desktop' }) }); assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0]; return createDesktopApi({ getProfile: () => profile, fetchImpl: (path, options) => fetch(base + path, { ...options, headers: { ...options.headers, Cookie: cookie } }) }); }
  const owner = await app.profiles.owner(), other = await app.profiles.create('Synthetic member'); const a = await pair(owner), b = await pair(other);
  const id = randomUUID(), accepted = await a.send('OWNER_PRIVATE_QUESTION', id);
  let result; for (let i = 0; i < 100; i++) { result = await a.run(accepted.runId); if (result.status === 'completed') break; await new Promise(done => setTimeout(done, 10)); }
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 1);
  await a.send('OWNER_PRIVATE_QUESTION', id); assert.equal(calls.length, 1);
  assert.match(JSON.stringify(await a.conversation()), /OWNER_PRIVATE_QUESTION/);
  assert.doesNotMatch(JSON.stringify(await b.conversation()), /OWNER_PRIVATE_QUESTION|SYNTHETIC_REPLY/);
  await assert.rejects(b.run(accepted.runId), error => error.status === 404);
  const browserInvite = await b.request('/api/profiles/' + other.id + '/invites', {}), preview = await anonymous.request('/api/pair/preview', { code: browserInvite.code }); assert.equal(preview.profile.id, other.id);
  const html = await readFile(resolve('public/desktop.html'), 'utf8'); assert.doesNotMatch(html, /https:\/\/.*(?:script|stylesheet)/);
});
