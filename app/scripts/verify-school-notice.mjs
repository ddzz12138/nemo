// Explicit real-model check on synthetic mail; never run from health or npm test.
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createNemoServer } from '../server.mjs';
import { saveConfig } from '../lib/config.mjs';
import { selectLocalAssistant } from '../lib/desktop-assistant.mjs';
import { createGmailClient, GMAIL_SCOPE } from '../lib/gmail.mjs';

if (!process.argv.includes('--synthetic-live')) throw Error('This invokes real local Gemma. Pass --synthetic-live explicitly.');
const parent = resolve('.work/school-verification'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'synthetic-')), clientId = '1234-synthetic.apps.googleusercontent.com';
const text = 'Year 9\nReturn the excursion consent form by 5 November 2026.\nBring your PE hat on 9 November 2026.\nThis is labelled synthetic school mail for a local functional test.';
const headers = [{ name: 'Subject', value: 'Synthetic Year 9 excursion' }, { name: 'From', value: 'School <school@example.test>' }, { name: 'Date', value: '31 October 2026' }];
const receipt = { startedAt: new Date().toISOString(), syntheticOnly: true, realMailRead: false, cloudModelUsed: false, accountApiCalls: 0 };
let app;
try {
  await writeFile(join(directory, 'google-client.json'), JSON.stringify({ installed: { client_id: clientId } }));
  const home = join(directory, 'assistant-home'); await mkdir(home);
  await saveConfig(directory, { hermesHome: home, hermesPython: resolve('.work/desktop-runtime/hermes/python/python.exe'), hermesSource: resolve('.work/desktop-runtime/hermes/source') });
  await selectLocalAssistant(directory);
  app = await createNemoServer({ dataDir: directory, memoryFactory: null, logger() {}, async integrationsForProfile(_profile, { dataDir }) {
    const tokens = { version: 1, clientId, accessToken: 'synthetic-only', refreshToken: 'synthetic-only', expiresAt: Date.now() + 3600000, scope: GMAIL_SCOPE };
    const gmail = await createGmailClient({ dataDir, configDir: directory, secretStore: { load: async () => tokens }, fetchImpl: async url => {
      const parsed = new URL(url); if (parsed.origin !== 'https://gmail.googleapis.com') throw Error('Unexpected fixture endpoint');
      if (parsed.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'notice1' }] });
      return Response.json({ id: 'notice1', snippet: 'Synthetic notice preview.', internalDate: String(Date.now()), payload: { headers, mimeType: 'text/plain', body: parsed.searchParams.get('format') === 'full' ? { data: Buffer.from(text).toString('base64url') } : {} } });
    } }); return { gmail };
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const origin = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '', profileId = '';
  async function request(path, body) { const r = await fetch(origin + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000), headers: { ...(cookie ? { Cookie: cookie, 'X-Nemo-Profile': profileId } : {}), ...(body ? { 'content-type': 'application/json', 'X-Nemo-Request': '1' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, headers: r.headers, data: await r.json() }; }
  const owner = await app.profiles.owner(), invite = await app.profiles.invite(owner.id), paired = await request('/api/pair', { code: invite.code, deviceName: 'Synthetic school verifier' });
  cookie = paired.headers.get('set-cookie').split(';')[0]; profileId = paired.data.profile.id;
  const search = await request('/api/gmail/notices/search', { query: 'subject:excursion' });
  const accepted = await request('/api/chat', { message: 'Brief my selected school notice.', requestId: randomUUID(), workflow: { name: 'school_briefing.v1', selection: search.data.messages[0].selection, bodyConsent: true, year: 9 } });
  if (accepted.status !== 202) throw Error('The selected-notice task was not accepted.');
  let result;
  for (let i = 0; i < 145; i++) { result = (await request('/api/runs/' + accepted.data.runId)).data; if (['completed','failed'].includes(result.status)) break; await new Promise(r => setTimeout(r, 1000)); }
  if (result.status !== 'completed') throw Error(result.error || 'Local school briefing did not finish.');
  if (!result.text.includes('2026-11-05') || !result.text.includes('2026-11-09') || !result.text.includes('consent form') || !result.text.includes('PE hat') || !result.text.includes('N1:p2') || !result.text.includes('N1:p3')) throw Error('The generated briefing missed an independently expected action, date or citation.');
  if ((await readdir(app.profiles.directory(owner.id))).some(name => name.startsWith('.notice-runtime-'))) throw Error('The temporary source transcript was not removed.');
  Object.assign(receipt, { ok: true, text: result.text, activity: result.activity, path: 'Authenticated Nemo task → synthetic Gmail adapter → real guarded Hermes/Gemma extraction → evidence/date validator', sourceTranscriptRemoved: true });
} catch (error) { Object.assign(receipt, { ok: false, error: error.message }); process.exitCode = 1; }
finally { await app?.close(); receipt.completedAt = new Date().toISOString(); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ok: receipt.ok, error: receipt.error, directory, syntheticOnly: true, sourceTranscriptRemoved: receipt.sourceTranscriptRemoved })); }
