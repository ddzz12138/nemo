// Explicit live functional check on synthetic data, never part of npm test/health.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createNemoServer } from '../server.mjs';
import { saveConfig } from '../lib/config.mjs';
import { selectLocalAssistant } from '../lib/desktop-assistant.mjs';

if (!process.argv.includes('--synthetic-live')) throw Error('This check calls the real local model. Use --synthetic-live explicitly.');
const parent = resolve('.work/local-chat-verification'); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(join(parent, 'synthetic-'));
const receipt = { startedAt: new Date().toISOString(), syntheticOnly: true, privateContentRead: false, cloudCredentialsUsed: false, savedProductionSettingsChanged: false };
let app;
try {
  const ps = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(4000), redirect: 'error' }).then(r => r.json());
  if (ps.models?.length) throw Error('Ollama is already resident/in use; leave the current task alone.');
  const home = join(directory, 'assistant-home'); await mkdir(home);
  await saveConfig(directory, { port: 8787, publicOrigin: '', hermesHome: home, hermesPython: resolve('.work/desktop-runtime/hermes/python/python.exe'), hermesSource: resolve('.work/desktop-runtime/hermes/source') });
  await selectLocalAssistant(directory);
  app = await createNemoServer({ dataDir: directory, memoryFactory: null, logger() {} });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '', profileId = '';
  async function request(path, body) {
    const r = await fetch(origin + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'content-type': 'application/json', 'X-Nemo-Request': '1', ...(profileId ? { 'X-Nemo-Profile': profileId } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, headers: r.headers, data: await r.json() };
  }
  const owner = await app.profiles.owner(), invite = await app.profiles.invite(owner.id, 'synthetic local verification');
  const paired = await request('/api/pair', { code: invite.code, deviceName: 'Synthetic local verifier' });
  if (paired.status !== 200) throw Error('Synthetic profile pairing failed.');
  cookie = paired.headers.get('set-cookie').split(';')[0]; profileId = paired.data.profile.id;
  const session = await request('/api/session');
  if (session.data.inference?.provider !== 'ollama' || session.data.planUsage?.enabled) throw Error('The authenticated route is not local-only.');
  const accepted = await request('/api/chat', { message: 'This is a synthetic connection test. Do not use tools or save memories. Reply exactly LOCAL_NEMO_READY.', requestId: randomUUID() });
  if (accepted.status !== 202) throw Error('Nemo did not accept the synthetic chat.');
  let result;
  for (let i = 0; i < 140; i++) { const r = await request('/api/runs/' + accepted.data.runId); if (['completed', 'failed'].includes(r.data.status)) { result = r.data; break; } await new Promise(resolve => setTimeout(resolve, 1000)); }
  if (result?.status !== 'completed' || result.text.trim() !== 'LOCAL_NEMO_READY') throw Error(result?.status === 'failed' ? result.error : 'The local answer did not match the synthetic check.');
  const resident = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(4000), redirect: 'error' }).then(r => r.json());
  Object.assign(receipt, { ok: true, reply: result.text, inference: session.data.inference, context: resident.models?.find(m => m.name === 'gemma4:12b')?.context_length, path: 'Nemo authenticated HTTP chat → guarded Hermes → local broker → Ollama Gemma', activityPresent: !!result.activity });
} catch (error) { Object.assign(receipt, { ok: false, error: error.message }); process.exitCode = 1; }
finally { await app?.close(); receipt.completedAt = new Date().toISOString(); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ...receipt, directory })); }
