import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalOllamaBroker, createLocalInferenceQueue, toLocalRequest, fromLocalResponse, checkLocalOllama, LOCAL_MODEL_ALIAS, LOCAL_OLLAMA } from '../lib/local-ollama.mjs';
import { createHermesProvider } from '../lib/hermes.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
const python = resolve('.work/desktop-runtime/hermes/python/python.exe');

test('Hermes notice extraction uses the fixed schema and removes its temporary source transcript', { skip: !existsSync(python), timeout: 70000 }, async t => {
  const scratch = await directory(t), home = join(scratch, 'normal-hermes-home'); await mkdir(home);
  const profiles = await createProfileStore({ dataDir: scratch }), owner = await profiles.owner(), dataDir = profiles.directory(owner.id); let request; const stages = [];
  const agent = createHermesProvider({ hermesPython: python, hermesSource: resolve('.work/desktop-runtime/hermes/source'), hermesHome: home, cwd: scratch, dataDir, family: true, profileId: owner.id, localModel: LOCAL_OLLAMA,
    localFetch: async (url, options) => {
      stages.push(url.endsWith('/api/chat') ? 'model-request' : 'metadata');
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:12b', digest: 'synthetic' }] });
      if (url.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' }, model_info: { 'general.architecture': 'gemma4' } });
      request = JSON.parse(options.body); return Response.json({ ...answer(), message: { role: 'assistant', content: '{"actions":[]}' } });
    } });
  let result;
  try { result = await agent.run({ message: 'SYNTHETIC_NOTICE_SOURCE_PRIVATE', workflowOutput: 'school-notice-v1', onPolicyError: value => stages.push(value.reason), onActivity: value => stages.push(value.kind), signal: AbortSignal.timeout(60000) }); }
  catch (error) { error.message += ' Static stages: ' + JSON.stringify(stages); throw error; }
  assert.equal(result.text, '{"actions":[]}'); assert.equal(request.format.additionalProperties, false); assert.equal(request.tools, undefined);
  assert.deepEqual(await readdir(home), []); assert.ok(!(await readdir(dataDir)).some(name => name.startsWith('.notice-runtime-')));
  await assert.rejects(agent.run({ message: 'No inherited conversation', workflowOutput: 'school-notice-v1', sessionId: 'old-session' }), /fresh local Gemma/);
});

const body = () => ({ model: LOCAL_MODEL_ALIAS, messages: [{ role: 'user', content: 'Synthetic local connection test.' }], stream: false });
const answer = () => ({ model: 'gemma4:12b', done: true, done_reason: 'stop', message: { role: 'assistant', content: 'LOCAL_OK' }, prompt_eval_count: 10, eval_count: 3 });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'nemo-local-'));
  t.after(async () => { assert.ok(path.startsWith(join(tmpdir(), 'nemo-local-'))); await rm(path, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }); return path;
}

test('local projection pins model/context and discards caller inference settings', () => {
  const request = toLocalRequest({ ...body(), options: { num_ctx: 262144 }, temperature: 2, extra_body: { model: 'cloud' } });
  assert.equal(request.model, 'gemma4:12b'); assert.equal(request.options.num_ctx, 65536); assert.equal(request.options.temperature, 0); assert.equal(request.think, false);
  for (const changed of [{ model: 'cloud' }, { stream: true }, { base_url: 'https://cloud.example' }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'private' }] }] }, { tools: [{ type: 'function', function: { name: 'terminal', parameters: {} } }] }]) assert.throws(() => toLocalRequest({ ...body(), ...changed }), /local model returned/);
});

test('local tools preserve pairing and deny unapproved tool results or malformed calls', () => {
  const name = 'mcp__nemo__gmail_search';
  const request = toLocalRequest({ ...body(), messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'one', type: 'function', function: { name, arguments: '{"query":"school"}' } }] }, { role: 'tool', tool_call_id: 'one', content: '{"messages":[]}' }] }, [name]);
  assert.equal(request.messages[1].tool_name, name); assert.deepEqual(request.messages[0].tool_calls[0].function.arguments, { query: 'school' });
  assert.throws(() => toLocalRequest({ ...body(), messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'secret' }] }), /unsupported/);
  assert.throws(() => fromLocalResponse({ ...answer(), message: { role: 'assistant', tool_calls: [{ function: { name: 'terminal', arguments: {} } }] } }), /unsupported/);
});

test('local completion requires the pinned model and a complete, nonempty answer', () => {
  assert.equal(fromLocalResponse(answer()).choices[0].message.content, 'LOCAL_OK');
  for (const change of [{ done: false }, { model: 'different-model' }, { message: { role: 'assistant', content: '' } }]) assert.throws(() => fromLocalResponse({ ...answer(), ...change }), /unsupported/);
  assert.throws(() => fromLocalResponse({ ...answer(), done_reason: 'length' }), /output limit/);
});

test('metadata checks never generate text and identify missing models without downloads', async () => {
  const seen = [];
  assert.equal((await checkLocalOllama({ fetchImpl: async (url, options) => { seen.push({ url, options }); return Response.json({ models: [] }); } })).code, 'LOCAL_MODEL_MISSING');
  assert.equal(seen.length, 1); assert.equal(seen[0].url, LOCAL_OLLAMA.origin + '/api/tags'); assert.equal(seen[0].options.redirect, 'error'); assert.equal(seen[0].options.body, undefined);
  assert.equal((await checkLocalOllama({ fetchImpl: async () => { throw new Error('private diagnostic'); } })).code, 'LOCAL_UNAVAILABLE');
});

test('a remote model or unverified model format cannot satisfy local readiness', async () => {
  const fetchImpl = async url => Response.json(url.endsWith('/api/tags') ? { models: [{ name: 'gemma4:12b', digest: 'synthetic', remote_host: 'https://remote.invalid' }] } : { details: { format: 'gguf' }, model_info: { 'general.architecture': 'gemma4' } });
  assert.equal((await checkLocalOllama({ fetchImpl })).code, 'LOCAL_MODEL_REMOTE');
});

test('gateway authenticates requests and forwards only to local Ollama', async t => {
  const seen = [];
  const broker = await createLocalOllamaBroker({ fetchImpl: async (url, options) => { seen.push({ url, options, body: JSON.parse(options.body) }); return Response.json(answer()); } });
  t.after(() => broker.close());
  const headers = { authorization: 'Bearer ' + broker.capability, 'content-type': 'application/json' };
  assert.equal((await fetch(broker.baseUrl + '/models')).status, 403);
  assert.equal((await fetch(broker.baseUrl + '/models', { headers: { ...headers, origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(broker.baseUrl + '/models', { headers })).status, 200);
  const r = await fetch(broker.baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body()) });
  assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, 'LOCAL_OK');
  assert.equal(seen.length, 1); assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/chat'); assert.equal(seen[0].options.redirect, 'error'); assert.deepEqual(seen[0].options.headers, { 'content-type': 'application/json' });
  assert.equal(seen[0].body.model, 'gemma4:12b'); assert.equal(seen[0].body.options.num_ctx, 65536);
});

test('local failure is safe and never tries a fallback endpoint', async t => {
  const seen = []; const broker = await createLocalOllamaBroker({ fetchImpl: async url => { seen.push(url); throw new Error('private API key diagnostic'); } }); t.after(() => broker.close());
  const r = await fetch(broker.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + broker.capability, 'content-type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(r.status, 502); const text = await r.text(); assert.match(text, /No cloud model was used/); assert.ok(!text.includes('API key')); assert.deepEqual(seen, ['http://127.0.0.1:11434/api/chat']); assert.equal(broker.error.code, 'LOCAL_UNAVAILABLE');
  const retry = await fetch(broker.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + broker.capability, 'content-type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(retry.status, 503); assert.equal(seen.length, 1);
});

test('real bundled Hermes retains exact read-tool execution through local Ollama transport', { skip: !existsSync(python), timeout: 70000 }, async t => {
  const scratch = await directory(t), home = join(scratch, 'hermes-home'); await mkdir(home);
  const profiles = await createProfileStore({ dataDir: scratch }), owner = await profiles.owner(), dataDir = profiles.directory(owner.id);
  const calendar = await createCalendarStore({ dataDir }), token = await calendar.issueToken(), now = Date.now();
  await calendar.importSnapshot({ events: [{ title: 'SYNTHETIC_LOCAL_CALENDAR_EVENT', start: new Date(now + 3600000).toISOString(), end: new Date(now + 7200000).toISOString() }] }, token);
  const name = 'mcp__nemo__calendar_list'; let calls = 0;
  const agent = createHermesProvider({ hermesPython: python, hermesSource: resolve('.work/desktop-runtime/hermes/source'), hermesHome: home, cwd: scratch, dataDir, family: true, profileId: owner.id, nodeExecutable: resolve('.work/desktop-runtime/node/node.exe'), localModel: LOCAL_OLLAMA, timeoutMs: 55000,
    localFetch: async (url, options) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:12b', digest: 'synthetic' }] });
      if (url.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' }, model_info: { 'general.architecture': 'gemma4' } });
      const request = JSON.parse(options.body); calls++;
      if (calls === 1) return Response.json({ ...answer(), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: { limit: 1 } } }] } });
      assert.ok(request.messages.some(m => m.role === 'tool' && m.tool_name === name && m.content.includes('SYNTHETIC_LOCAL_CALENDAR_EVENT')));
      return Response.json(answer());
    } });
  const result = await agent.run({ message: 'Read one synthetic calendar event.', useIntegrations: true, allowedConnectionTools: ['calendar_list'], permissionRevision: '0:0:false', signal: AbortSignal.timeout(60000) });
  assert.equal(result.text, 'LOCAL_OK'); assert.equal(result.toolCalls, 1); assert.equal(calls, 2);
});

test('shared local admission serializes inference and cancels queued work', async () => {
  const queue = createLocalInferenceQueue(); let release; const seen = [];
  const first = queue.run(async () => { seen.push('first'); await new Promise(resolve => { release = resolve; }); });
  const abort = new AbortController(); const second = queue.run(async () => seen.push('cancelled'), abort.signal); const cancelled = assert.rejects(second);
  const third = queue.run(async () => seen.push('third')); abort.abort(); release(); await Promise.all([first, cancelled, third]); assert.deepEqual(seen, ['first', 'third']);
});

test('local family chat supports Memory and the full desktop connection policy', { skip: !existsSync(python), timeout: 90000 }, async t => {
  const scratch = await directory(t), home = join(scratch, 'hermes-home'); await mkdir(home);
  const profiles = await createProfileStore({ dataDir: scratch }), owner = await profiles.owner();
  const diagnostics = [];
  const agent = createHermesProvider({ hermesPython: python, hermesSource: resolve('.work/desktop-runtime/hermes/source'), hermesHome: home, cwd: scratch,
    dataDir: profiles.directory(owner.id), family: true, profileId: owner.id, memoryEnabled: true,
    nodeExecutable: resolve('.work/desktop-runtime/node/node.exe'), localModel: LOCAL_OLLAMA, timeoutMs: 40000,
    localFetch: async url => Response.json(url.endsWith('/api/tags') ? { models: [{ name: 'gemma4:12b', digest: 'synthetic' }] }
      : url.endsWith('/api/show') ? { details: { format: 'gguf' }, model_info: { 'general.architecture': 'gemma4' } } : answer()) });
  for (const useIntegrations of [false, true]) {
    let result;
    try { result = await agent.run({ message: 'Synthetic local desktop policy verification. Reply without using tools.', useIntegrations,
      allowedConnectionTools: ['calendar_list', 'gmail_search', 'memory_search'], permissionRevision: '0:0:false',
      onPolicyError: value => diagnostics.push(value), signal: AbortSignal.timeout(42000) }); }
    catch (error) { error.message += ' Static policy diagnostics: ' + JSON.stringify(diagnostics); throw error; }
    assert.equal(result.text, 'LOCAL_OK'); assert.equal(result.toolCalls, 0); assert.deepEqual(diagnostics, []);
  }
});

test('real bundled Hermes uses the pinned local adapter and resumes private history without cloud credentials', { skip: !existsSync(python), timeout: 70000 }, async t => {
  const scratch = await directory(t), home = join(scratch, 'hermes-home'); await mkdir(home);
  await writeFile(join(home, 'config.yaml'), 'fallback_providers:\n  - provider: openrouter\n    model: forbidden-cloud-fallback\n');
  const profiles = await createProfileStore({ dataDir: scratch }), owner = await profiles.owner(), requests = [], policy = [];
  const agent = createHermesProvider({ hermesPython: python, hermesSource: resolve('.work/desktop-runtime/hermes/source'), hermesHome: home, cwd: scratch, dataDir: profiles.directory(owner.id), family: true, profileId: owner.id,
    localModel: LOCAL_OLLAMA, timeoutMs: 50000, chatgptSession: async () => { throw Error('Cloud credentials must not be opened'); },
    localFetch: async (url, options) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:12b', digest: 'synthetic' }] });
      if (url.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' }, model_info: { 'general.architecture': 'gemma4' } });
      requests.push({ url, body: JSON.parse(options.body) }); return Response.json(answer());
    } });
  const result = await agent.run({ message: 'Synthetic local adapter verification.', onPolicyError: event => policy.push(event), signal: AbortSignal.timeout(55000) });
  assert.equal(result.text, 'LOCAL_OK'); assert.equal(result.model, 'gemma4:12b'); assert.equal(result.toolCalls, 0); assert.equal(requests.length, 1); assert.deepEqual(policy, []);
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat'); assert.equal(requests[0].body.options.num_ctx, 65536); assert.equal(agent.status().verified, true);
  const resumed = await agent.run({ message: 'Resume only this private synthetic chat.', sessionId: result.sessionId, signal: AbortSignal.timeout(55000) });
  assert.equal(resumed.text, 'LOCAL_OK'); assert.equal(resumed.sessionId, result.sessionId); assert.equal(requests.length, 2);
  assert.ok(requests[1].body.messages.some(m => m.content === 'Synthetic local adapter verification.')); assert.ok(requests[1].body.messages.some(m => m.role === 'assistant' && m.content === 'LOCAL_OK'));
});
