import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { projectSelectedNotice } from '../lib/gmail-notice.mjs';
import { createSchoolNoticeWorkflow, explicitNoticeDate, noticePrompt, validateNoticeExtraction } from '../lib/school-notice.mjs';
import { toLocalRequest, LOCAL_MODEL_ALIAS } from '../lib/local-ollama.mjs';
import { createNemoServer } from '../server.mjs';

const NOW = Date.parse('2026-10-31T03:00:00Z');
const notice = (id = 'one', who = 'A') => ({ id, subject: 'Year 9 excursion', from: 'School <school@example.test>', date: '31 October 2026',
  text: `Year 9\nReturn the ${who} consent form by 5 November 2026.\nBring your ${who} hat on 9 November 2026.\nPRIVATE_UNNEEDED_PARAGRAPH_${who}`,
  bodyComplete: true, truncated: false, attachments: false, linkedPages: false });
function extraction(source) {
  const paragraphs = noticePrompt(source, 9).paragraphs;
  return JSON.stringify({ actions: paragraphs.filter(p => /Return the|Bring your/.test(p.text)).map(p => ({ paragraph: p.id,
    action: p.text.split(/ by | on /)[0], quote: p.text, dateText: p.text.match(/\d+ November 2026/)[0] })) });
}
async function directory(t) { const root = await mkdtemp(resolve('test/.tmp-school-')); t.after(async () => { assert.equal(dirname(root), resolve('test')); assert.ok(root.startsWith(resolve('test/.tmp-school-'))); await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }); return root; }
const payload = (text, mimeType = 'text/plain') => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });

test('notice reader handles MIME alternatives and inert HTML without opening links or attachments', () => {
  const message = { id: 'one', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Selected notice' }], parts: [
    { mimeType: 'multipart/alternative', parts: [payload('Return the form by 5 November 2026.'), payload('<p>Return the form.</p><a href="https://school.example">Details</a>', 'text/html')] },
    { filename: 'private.pdf', mimeType: 'application/pdf', body: { attachmentId: 'not-fetched' } },
  ] } };
  const source = projectSelectedNotice(message, 'one'); assert.equal(source.text, 'Return the form by 5 November 2026.'); assert.equal(source.attachments, true); assert.equal(source.linkedPages, true);
  const html = projectSelectedNotice({ id: 'html', payload: payload('<style>HIDDEN</style><p>Bring &amp; return.</p><script>SECRET_JS</script><p hidden>HIDDEN</p><p>Keep this.</p><img src="https://tracking.invalid/pixel">', 'text/html') }, 'html');
  assert.match(html.text, /Bring & return/); assert.match(html.text, /Keep this/); assert.doesNotMatch(html.text, /SECRET_JS|HIDDEN|tracking/);
  assert.throws(() => projectSelectedNotice(message, 'foreign'), /different/);
});
test('unsupported, oversized and truncated notices never claim complete source coverage', () => {
  const unsupported = projectSelectedNotice({ id: 'one', payload: payload('anything', 'application/octet-stream') }, 'one'); assert.equal(unsupported.bodyComplete, false);
  const long = projectSelectedNotice({ id: 'one', payload: payload('a'.repeat(14000)) }, 'one'); assert.equal(long.truncated, true); assert.equal(long.bodyComplete, false); assert.equal(long.text.length, 12000);
});
test('dates are code-resolved calendar dates; missing years, invalid dates and weekday conflicts stay uncertain', () => {
  assert.equal(explicitNoticeDate('5 November 2026'), '2026-11-05'); assert.equal(explicitNoticeDate('05/11/2026'), '2026-11-05');
  assert.equal(explicitNoticeDate('2026-11-05'), '2026-11-05');
  for (const value of ['tomorrow', 'Friday', '5 November', '31/02/2026', 'Friday 5 November 2026', '5 or 6 November 2026']) assert.equal(explicitNoticeDate(value), null, value);
});
test('model output must quote the selected passage; hallucinated actions, wrong years and ambiguous dates are withheld', () => {
  const source = notice(), packet = noticePrompt(source, 9), result = validateNoticeExtraction(extraction(source), packet, source, 9);
  assert.equal(result.actions.length, 2); assert.equal(result.actions[0].date, '2026-11-05'); assert.equal(result.actions[0].citation, 'N1:p2');
  const bad = JSON.parse(extraction(source)); bad.actions[0].action = 'Pay $500'; assert.throws(() => validateNoticeExtraction(JSON.stringify(bad), packet, source, 9), { code: 'NOTICE_EVIDENCE' });
  const mixed = { ...source, text: 'Year 8\nReturn the form by 5 November 2026.\nYear 9\nBring your hat on 9 November 2026.' };
  const checked = validateNoticeExtraction(extraction(mixed), noticePrompt(mixed, 9), mixed, 9); assert.equal(checked.actions.length, 1); assert.match(checked.actions[0].action, /hat/);
  const ambiguous = { ...source, text: 'Year 9\nReturn the form by Friday.' }, response = { actions: [{ paragraph: 'p2', action: 'Return the form', quote: 'Return the form by Friday.', dateText: 'Friday' }] };
  const uncertain = validateNoticeExtraction(JSON.stringify(response), noticePrompt(ambiguous, 9), ambiguous, 9); assert.equal(uncertain.actions[0].date, null); assert.ok(uncertain.warnings.length);
});
test('the extraction format is host-pinned and cannot grant tools or choose a different model', () => {
  const body = { model: LOCAL_MODEL_ALIAS, messages: [{ role: 'user', content: 'Synthetic extraction' }], stream: false, format: 'untrusted' };
  const native = toLocalRequest(body, [], 'school-notice-v1'); assert.equal(native.format.additionalProperties, false); assert.equal(native.model, 'gemma4:12b');
  assert.throws(() => toLocalRequest(body, ['mcp__nemo__gmail_search'], 'school-notice-v1')); assert.throws(() => toLocalRequest(body, [], 'arbitrary'));
});

async function family(t, { infer, providerType = 'ollama' } = {}) {
  const root = await directory(t), calls = [], reads = [], grants = new Map(); let clock = NOW;
  const provider = { status: () => ({ connected: true, inferenceProvider: providerType }), async run(input) {
    calls.push(input); assert.equal(input.useIntegrations, false); assert.equal(input.sessionId, null); assert.equal(input.workflowOutput, 'school-notice-v1');
    if (infer) return infer(input);
    const packet = JSON.parse(input.message.split('\nNOTICE_EVIDENCE_JSON\n')[1].split('\nEND_NOTICE_EVIDENCE_JSON')[0]);
    const source = { ...notice(), text: packet.paragraphs.map(p => p.text).join('\n') }; return { text: extraction(source) };
  } };
  const options = { dataDir: root, provider, memoryFactory: null, now: () => clock, logger() {}, async integrationsForProfile(profile) {
    grants.set(profile.id, grants.get(profile.id) || 'grant-' + profile.id);
    return { gmail: { status: () => ({ configured: true, connected: true }), noticeGrant: async () => grants.get(profile.id),
      searchPage: async () => ({ messages: [{ id: 'one', subject: 'Year 9 excursion', from: 'School', date: '31 October 2026', snippet: 'Preview only' }], hasMore: true }),
      readSelectedNotice: async ({ id, grant }) => { assert.equal(grant, grants.get(profile.id)); reads.push(profile.id); return notice(id, profile.id); },
    } };
  } };
  let app = await createNemoServer(options), base;
  async function listen() { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = 'http://127.0.0.1:' + app.server.address().port; } await listen();
  t.after(() => app.close());
  async function request(path, person, input) {
    const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(person ? { Cookie: person.cookie, 'X-Nemo-Profile': person.profile.id } : {}), ...(input !== undefined ? { 'content-type': 'application/json', 'X-Nemo-Request': '1' } : {}) }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }); return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function pair(profile) { const invite = await app.profiles.invite(profile.id), result = await request('/api/pair', null, { code: invite.code, deviceName: 'Synthetic test' }); assert.equal(result.status, 200); return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0] }; }
  const owner = await pair(await app.profiles.owner());
  async function search(person = owner) { const result = await request('/api/gmail/notices/search', person, { query: 'subject:excursion' }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.messages[0].selection; }
  async function submit(person, selection, requestId = randomUUID(), extra = {}) { return request('/api/chat', person, { message: 'Brief my selected school notice.', requestId, workflow: { name: 'school_briefing.v1', selection, bodyConsent: true, year: 9 }, ...extra }); }
  async function finish(person, id) { for (let i = 0; i < 200; i++) { const r = await request('/api/runs/' + id, person); if (['completed','failed'].includes(r.data.status)) return r.data; await new Promise(r => setTimeout(r, 5)); } assert.fail('Workflow timed out'); }
  return { root, owner, pair, request, search, submit, finish, calls, reads, grants, get app() { return app; }, setClock: value => { clock = value; }, async restart() { await app.close(); app = await createNemoServer(options); await listen(); } };
}
test('selected-notice task is local, durable, cited, private and idempotent across reconnects', async t => {
  const f = await family(t), handle = await f.search(), key = randomUUID(), accepted = await f.submit(f.owner, handle, key);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data)); const run = await f.finish(f.owner, accepted.data.runId);
  assert.equal(run.status, 'completed', run.error); assert.match(run.text, /N1:p2/); assert.match(run.text, /2026-11-05/); assert.match(run.text, /not a weekly/);
  assert.doesNotMatch(run.text, /PRIVATE_UNNEEDED_PARAGRAPH/); assert.equal(f.calls.length, 1); assert.equal(f.reads.length, 1);
  assert.ok(run.activity.entries.some(entry => /Quotations and dates checked/.test(entry.label)));
  const repeat = await f.submit(f.owner, handle, key); assert.equal(repeat.data.runId, run.id); assert.equal(f.calls.length, 1);
  assert.equal((await f.submit(f.owner, handle, key, { workflow: { name: 'school_briefing.v1', selection: handle, bodyConsent: true, year: 8 } })).status, 409);
  const state = await readFile(join(f.root, 'profiles', f.owner.profile.id, 'state.json'), 'utf8'); assert.doesNotMatch(state, /PRIVATE_UNNEEDED_PARAGRAPH/);
  await f.restart(); assert.equal((await f.request('/api/runs/' + run.id, f.owner)).data.status, 'completed'); assert.equal(f.calls.length, 1);
});
test('foreign selections/results, forged identities, missing source consent and child tool bypasses fail', async t => {
  const f = await family(t), other = await f.pair(await f.app.profiles.create('Other adult')), child = await f.pair(await f.app.profiles.create('Child', true));
  const handle = await f.search(); assert.equal((await f.submit(other, handle)).status, 409);
  assert.equal((await f.submit(f.owner, handle, randomUUID(), { workflow: { name: 'school_briefing.v1', selection: handle, bodyConsent: false } })).status, 400);
  assert.equal((await f.submit(f.owner, handle, randomUUID(), { workflow: { name: 'school_briefing.v1', selection: handle, bodyConsent: true, profileId: other.profile.id } })).status, 400);
  assert.equal((await f.request('/api/gmail/notices/search', child, { query: 'school' })).status, 403);
  const own = await f.submit(f.owner, handle); await f.finish(f.owner, own.data.runId); assert.equal((await f.request('/api/runs/' + own.data.runId, other)).status, 404);
});
test('expired selections and changed Gmail accounts cannot read a new account using an old selection', async t => {
  const f = await family(t), handle = await f.search(); f.grants.set(f.owner.profile.id, 'new-account');
  const accepted = await f.submit(f.owner, handle); const result = await f.finish(f.owner, accepted.data.runId); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 0);
  const fresh = await f.search(); f.setClock(NOW + 600001); assert.equal((await f.submit(f.owner, fresh)).status, 409);
});
test('school workflow cannot use a cloud provider or commit unchecked model output', async t => {
  const cloud = await family(t, { providerType: 'chatgpt' }); assert.equal((await cloud.request('/api/gmail/notices/search', cloud.owner, { query: 'school' })).status, 409); assert.equal(cloud.reads.length, 0);
  const f = await family(t, { infer: async () => ({ text: '{"actions":[{"paragraph":"p2","action":"Invented task","quote":"Made up","dateText":null}]}' }) });
  const accepted = await f.submit(f.owner, await f.search()), result = await f.finish(f.owner, accepted.data.runId); assert.equal(result.status, 'failed'); assert.equal(result.text, '');
});
test('revoking Gmail during extraction or changing its grant before commit discards the result', async t => {
  let release, started; const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await family(t, { infer: async () => { started(); await gate; return { text: '{"actions":[]}' }; } });
  const child = await f.pair(await f.app.profiles.create('Synthetic pupil', true));
  assert.equal((await f.request('/api/profiles/' + child.profile.id + '/capabilities', f.owner, { capability: 'gmail', enabled: true })).status, 200);
  const accepted = await f.submit(child, await f.search(child)); await ready;
  assert.equal((await f.request('/api/profiles/' + child.profile.id + '/capabilities', f.owner, { capability: 'gmail', enabled: false })).status, 200); release();
  const cancelled = await f.finish(child, accepted.data.runId); assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.text, '');
  let changed;
  const second = await family(t, { infer: async () => { changed.grants.set(changed.owner.profile.id, 'changed-after-extraction'); return { text: '{"actions":[]}' }; } }); changed = second;
  const acceptedSecond = await second.submit(second.owner, await second.search()), result = await second.finish(second.owner, acceptedSecond.data.runId); assert.equal(result.status, 'failed'); assert.equal(result.text, '');
});
test('a revised deadline is never silently resolved to the earlier quoted date', () => {
  const source = { ...notice(), text: 'Year 9\nReturn the consent form by 5 November 2026.\nCorrection: the date has changed to 9 November 2026.' };
  const output = { actions: [{ paragraph: 'p2', action: 'Return the consent form', quote: 'Return the consent form by 5 November 2026.', dateText: '5 November 2026' }] };
  const result = validateNoticeExtraction(JSON.stringify(output), noticePrompt(source, 9), source, 9); assert.equal(result.actions[0].date, null); assert.ok(result.warnings.length);
});
test('multiple years ask for clarification and another year is not presented as the user’s task', async () => {
  const source = { ...notice(), text: 'Year 8\nReturn form A.\nYear 9\nReturn form B.' }, gmail = { noticeGrant: async () => 'binding', searchPage: async () => ({ messages: [{ id: 'one', subject: 'School', from: 'School', date: '', snippet: '' }], hasMore: false }), readSelectedNotice: async () => source };
  const workflow = createSchoolNoticeWorkflow({ gmail }), selected = (await workflow.search('school')).messages[0].selection;
  const result = await workflow.run({ name: 'school_briefing.v1', selection: selected, bodyConsent: true }, { authorize: async () => {}, infer: () => assert.fail('No model call needed for missing year'), activity() {} });
  assert.match(result.text, /Select your year/); assert.equal(result.receipt.actionCount, 0);
});
