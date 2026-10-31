import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { APP_ROOT } from '../lib/config.mjs';
import { startNativeChatWorker } from '../lib/native-worker.mjs';

const sourceRoot = process.env.NEMO_TEST_HERMES_SOURCE, pythonPath = process.env.NEMO_TEST_HERMES_PYTHON;
const apiMode=process.env.NEMO_TEST_NATIVE_MODE||'chat_completions';
if(!['chat_completions','codex_responses'].includes(apiMode))throw new Error('Unsupported synthetic protocol.');
if (!sourceRoot || !pythonPath) throw new Error('Set explicit test runtime paths. This diagnostic never reads host credentials/config.');
const work = join(APP_ROOT, '.work'); await mkdir(work, { recursive: true });
const dataDir = await mkdtemp(join(work, 'native-protocol-'));
const profiles = [0, 1].map(() => ({ id: randomUUID(), role: 'member', classification: 'adult' }));
const tokens = profiles.map(() => randomBytes(32).toString('hex'));
const facts = ['SYNTHETIC_FAVORITE_COLOR_AMBER', 'SYNTHETIC_FAVORITE_COLOR_BLUE'];
const calls = [], workers = [],createdSessions=[]; let unintended = 0, rejectedMetadata = 0;
const optionalMetadata = new Set(['GET /api/v1/models','GET /api/tags','GET /v1/props','GET /props','GET /version','POST /api/show']);
const diagnostics = [];
const server = http.createServer(async (req, res) => {
  const index = tokens.indexOf((req.headers.authorization || '').replace('Bearer ', ''));
  if (index < 0) { if (req.url === '/v1/models' && req.method === 'GET') rejectedMetadata++; else { unintended++; diagnostics.push({ rejectedPath: req.url, method: req.method }); } res.writeHead(403); res.end(); return; }
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'nemo-synthetic', object: 'model' }] })); return; }
  if (req.url !== (apiMode==='codex_responses'?'/v1/responses':'/v1/chat/completions') || req.method !== 'POST') { if (optionalMetadata.has(`${req.method} ${req.url}`)) rejectedMetadata++; else unintended++; diagnostics.push({ rejectedPath: req.url, method: req.method, authenticated: true }); res.writeHead(404); res.end(); return; }
  let body = ''; for await (const part of req) body += part;
  const request = JSON.parse(body); calls.push({ profile: index, request });
  const content = `Verified ${facts[index]}.`;
  const common = { id: 'chatcmpl-synthetic', created: 1, model: 'nemo-synthetic' };
  if(apiMode==='codex_responses'){
    const message={id:'msg_synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:content,annotations:[]}]};
    const response={id:'resp_synthetic',object:'response',created_at:1,status:'completed',model:'nemo-synthetic',output:[message],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
    emit('response.created',{response:{...response,status:'in_progress',output:[]}});
    emit('response.output_item.added',{output_index:0,item:{...message,status:'in_progress',content:[]}});
    emit('response.content_part.added',{item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
    emit('response.output_text.delta',{item_id:message.id,output_index:0,content_index:0,delta:content});
    emit('response.output_text.done',{item_id:message.id,output_index:0,content_index:0,text:content});
    emit('response.output_item.done',{output_index:0,item:message});emit('response.completed',{response});res.end();return;
  }
  if (request.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const brokerUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (let i = 0; i < 2; i++) {
    workers.push(await startNativeChatWorker({ dataDir, profile: profiles[i], pythonPath, sourceRoot, brokerUrl, brokerGrant: tokens[i], model: 'nemo-synthetic', apiMode, spawn(...args) {
      const child = spawn(...args); child.stderr.on('data', part => { if (diagnostics.length < 200) diagnostics.push({ profile: i, stderr: String(part) }); });
      child.stdout.on('data', part => { if (diagnostics.length < 200) diagnostics.push({ profile: i, frames: String(part) }); }); return child;
    } }));
  }
  const results = await Promise.all(workers.map(async (worker, index) => {
    await worker.client.request('client.capabilities', { server_requests: true });
    const created = await worker.client.request('session.create', { idempotency_key: randomUUID() });
    createdSessions[index]=created;
    const completion = new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic native turn did not complete.')), 45_000);
      worker.client.on('activity', event => { if (event.sessionId === created.session_id && event.type === 'message.complete') { clearTimeout(timer); resolveResult(event.payload); } });
      worker.client.once('disconnected', () => { clearTimeout(timer); reject(new Error('Native worker disconnected before completing the synthetic turn.')); });
    });
    completion.catch(() => {});
    const admitted = await worker.client.request('prompt.submit', { session_id: created.session_id, text: `User message:\nRemember only this synthetic fact: ${facts[index]}. Reply with it once.` });
    if (admitted.status !== 'streaming') throw new Error('Unexpected native admission state.');
    const result = await completion;
    if (result.status !== 'complete' || !result.text?.includes(facts[index]) || result.text.includes(facts[1 - index]) || !worker.client.guardVerified) throw new Error('Native profile reply/proof did not match.');
    return { complete: true, guarded: true };
  }));
  for(let index=0;index<2;index++){
    await workers[index].close();
    const worker=await startNativeChatWorker({dataDir,profile:profiles[index],pythonPath,sourceRoot,brokerUrl,brokerGrant:tokens[index],model:'nemo-synthetic',apiMode});workers[index]=worker;
    await worker.client.request('client.capabilities',{server_requests:true});
    worker.client.registerStoredSession({profileId:profiles[index].id,sessionId:createdSessions[index].stored_session_id});
    const resumed=await worker.client.request('session.resume',{session_id:createdSessions[index].stored_session_id});
    const completion=new Promise((resolveResult,reject)=>{const timer=setTimeout(()=>reject(new Error('Resumed native fixture did not complete.')),45_000);worker.client.on('activity',event=>{if(event.sessionId===resumed.session_id&&event.type==='message.complete'){clearTimeout(timer);resolveResult(event.payload);}});});completion.catch(()=>{});
    await worker.client.request('prompt.submit',{session_id:resumed.session_id,text:'User message:\nRepeat the synthetic fact from earlier in this private conversation.'});
    const result=await completion;if(result.status!=='complete'||!result.text?.includes(facts[index]))throw new Error('Resumed native fixture did not preserve its reply.');
    if(!JSON.stringify(calls.filter(call=>call.profile===index).at(-1)?.request).includes(facts[index]))throw new Error('Resumed native history was missing from the provider input.');
  }
  for (let index = 0; index < 2; index++) {
    const own = calls.filter(call => call.profile === index);
    if (!own.length || own.some(call => JSON.stringify(call.request).includes(facts[1 - index]) || (call.request.tools || []).length)) throw new Error('Native provider context crossed profiles or enabled tools.');
  }
  if (unintended) throw new Error('Native worker attempted an unapproved broker operation.');
  const result = { ok: true, twoNativeProfiles: results.length, separateHomes: workers[0].home !== workers[1].home,privateHistoryResumed:true, realHermesEngine: true, provider: 'synthetic-loopback-only',apiMode, realModelCalls: 0, connectedAccountReads: 0, toolCount: 0, rejectedOptionalMetadata: rejectedMetadata };
  await writeFile(join(work, `native-protocol-${apiMode}-result.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(workers.map(worker=>worker.close()));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(dataDir, 'synthetic-diagnostics.json'), JSON.stringify({ calls: calls.length, unintended, diagnostics }, null, 2));
  // Private fixture homes are retained for local failure diagnosis. No owner
  // home or connection files were read, copied or migrated.
}
