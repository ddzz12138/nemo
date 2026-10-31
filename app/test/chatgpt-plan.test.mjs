import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { toPlanRequest, toHermesCompletion, completedPlanResponse, createChatGPTPlanBroker } from '../lib/chatgpt-plan-broker.mjs';
import { createHermesProvider } from '../lib/hermes.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';
import { verifyHermesBundle } from '../lib/hermes-bundle.mjs';

const tool = 'mcp__nemo__calendar_list';
const session = { provider: 'chatgpt', accessToken: 'synthetic-oauth-token-not-a-provider-key', model: 'synthetic-plan-model', clientId: 'oaiapp_synthetic' };
const completed = (output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic plan reply.' }] }]) => ({ id: 'resp_synthetic', status: 'completed', output, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } });
const sse = values => new Response(values.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const reply = () => sse([{ type: 'response.output_text.delta', delta: 'Partial text must not imply success.' }, { type: 'response.completed', response: completed() }]);
const summaryReply = () => new Response(sse([
  { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_synthetic', type: 'message', content: [] } },
  { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_synthetic', ...completed().output[0] } },
  { type: 'response.completed', response: completed([]) },
]).body);

test('plan request preserves text history and approved tool results while discarding paid route/settings fields', () => {
  const request = toPlanRequest({ model: 'untrusted-paid-model', messages: [
    { role: 'system', content: 'Trusted instruction' },
    { role: 'user', content: 'Read my calendar' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: '{"limit":1}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"events":[]}' },
  ], tools: [{ type: 'function', function: { name: tool, description: 'Read events', parameters: { type: 'object' } } }],
  temperature: 1, max_tokens: 100, max_output_tokens: 100, previous_response_id: 'remote-history', store: true, stream: false,
  base_url: 'https://openrouter.ai/api/v1', api_key: 'never-forward' }, session.model, [tool]);
  assert.equal(request.model, session.model); assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.equal(request.input[0].role, 'developer'); assert.equal(request.input[2].namespace, 'nemo');
  assert.equal(request.input[3].type, 'function_call_output'); assert.equal(request.input[3].call_id, 'call_1');
  assert.equal(request.tools[0].type, 'namespace'); assert.equal(request.tools[0].tools[0].name, tool);
  assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'store', 'stream', 'tools']);
  assert.doesNotMatch(JSON.stringify(request), /openrouter|never-forward|remote-history/);
  for (const messages of [[{ role: 'user', content: [{ type: 'image_url', image_url: 'file:///private' }] }], [{ role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'terminal', arguments: '{}' } }] }]]) {
    assert.throws(() => toPlanRequest({ messages }, session.model, [tool]));
  }
  assert.throws(() => toPlanRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }, session.model));
});

test('only completed Responses streams produce Hermes replies; partial/failed/incomplete streams never succeed', async () => {
  assert.equal((await completedPlanResponse(reply())).status, 'completed');
  for (const values of [[], [{ type: 'response.output_text.delta', delta: 'Incomplete' }], [{ type: 'response.incomplete', response: completed() }]]) {
    await assert.rejects(completedPlanResponse(sse(values)), error => error.code === 'CHATGPT_UNAVAILABLE');
  }
  await assert.rejects(completedPlanResponse(sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: session.accessToken } } }])), error => error.code === 'CHATGPT_USAGE_LIMIT' && !error.message.includes(session.accessToken));
  await assert.rejects(completedPlanResponse(Response.json({ output: completed().output })), error => error.code === 'CHATGPT_UNAVAILABLE');
  await assert.rejects(completedPlanResponse(Response.json({ error: { code: 'subscription_sharing_user_not_eligible', message: 'private diagnostic' } }, { status: 403 })), error => error.code === 'CHATGPT_NOT_ELIGIBLE' && !error.message.includes('private diagnostic'));
});

test('summary-only completion retains finished streamed output in index order', async () => {
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished streamed answer.' }] };
  const result = await completedPlanResponse(sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', delta: 'A partial delta is not the final answer.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed([]) },
  ]));
  assert.equal(toHermesCompletion(result).choices[0].message.content, 'Finished streamed answer.');
  const reasoning = { id: 'rs_synthetic', type: 'reasoning' };
  const ordered = await completedPlanResponse(sse([
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: completed([]) },
  ]));
  assert.deepEqual(ordered.output, [reasoning, item]);
});

test('missing SSE content-type is accepted only with a successful structured completion', async () => {
  const noType = values => new Response(sse(values).body);
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Headerless streamed answer.' }] };
  const events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: completed([]) }];
  const response = noType(events); assert.equal(response.headers.get('content-type'), null);
  assert.equal(toHermesCompletion(await completedPlanResponse(response)).choices[0].message.content, 'Headerless streamed answer.');
  for (const body of ['{"output":[]}', '<html>Service unavailable</html>', 'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n']) {
    const bytes = new TextEncoder().encode(body);
    await assert.rejects(completedPlanResponse(new Response(bytes)), error => error.code === 'CHATGPT_UNAVAILABLE');
  }
  for (const type of ['application/json', 'text/html']) await assert.rejects(completedPlanResponse(new Response(sse(events).body, { headers: { 'content-type': type } })), error => error.code === 'CHATGPT_UNAVAILABLE');
});

test('stream recovery rejects unfinished, duplicate, changed or missing output items', async () => {
  const item = { id: 'msg_synthetic', type: 'message', content: [{ type: 'output_text', text: 'Must not accept incomplete output.' }] };
  const done = { type: 'response.output_item.done', output_index: 0, item };
  const finish = { type: 'response.completed', response: completed([]) };
  for (const events of [
    [done], [done, { type: 'response.incomplete' }], [done, { type: 'response.failed' }],
    [done, done, finish], [{ ...done, output_index: 1 }, finish],
    [{ ...done, output_index: -1 }, finish], [{ ...done, output_index: 0.5 }, finish],
    [{ type: 'response.output_item.added', output_index: 0, item }, { ...done, item: { ...item, id: 'different' } }, finish],
    [done, { type: 'response.output_item.added', output_index: 1, item: { ...item, id: 'unfinished' } }, finish],
  ]) await assert.rejects(completedPlanResponse(sse(events)), error => error.code === 'CHATGPT_UNAVAILABLE');
});

test('recovered streamed tools still require the exact name and namespace permission', async () => {
  const item = { id: 'fc_synthetic', type: 'function_call', namespace: 'nemo', name: tool, call_id: 'call_1', arguments: '{"limit":1}' };
  const recover = value => completedPlanResponse(sse([{ type: 'response.output_item.done', output_index: 0, item: value }, { type: 'response.completed', response: completed([]) }]));
  assert.equal(toHermesCompletion(await recover(item), [tool]).choices[0].message.tool_calls[0].function.name, tool);
  for (const value of [{ ...item, name: 'terminal' }, { ...item, namespace: 'external' }]) {
    const response = await recover(value);
    assert.throws(() => toHermesCompletion(response, [tool]));
  }
  assert.throws(() => toHermesCompletion({ output: [item] }, []));
});

test('Responses tool calls retain exact guarded names and identifiers', () => {
  const call = { type: 'function_call', namespace: 'nemo', name: tool, call_id: 'call_1', arguments: '{"limit":1}' };
  const result = toHermesCompletion(completed([call]), [tool]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.choices[0].message.tool_calls[0].function.name, tool);
  assert.equal(result.choices[0].message.tool_calls[0].id, 'call_1');
  assert.throws(() => toHermesCompletion(completed([{ ...call, name: 'terminal' }]), [tool]));
  assert.throws(() => toHermesCompletion(completed([{ ...call, namespace: 'external' }]), [tool]));
});

test('private broker authorizes exact loopback route, sends only official endpoint OAuth request and has no paid fallback', async t => {
  const calls = [];
  const broker = await createChatGPTPlanBroker({ session, fetchImpl: async (url, options) => { calls.push({ url, options }); return reply(); } });
  t.after(() => broker.close());
  const input = { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_MESSAGE' }], model: 'wrong-model' };
  const send = (path = '/chat/completions', key = broker.capability, extra = {}) => fetch(broker.baseUrl + path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  assert.equal((await send('/chat/completions', 'bad-key')).status, 403);
  assert.equal((await send('/chat/completions', broker.capability, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send('/responses')).status, 404); assert.equal(calls.length, 0);
  const response = await send(); assert.equal(response.status, 200); const output = await response.json();
  assert.equal(output.choices[0].message.content, 'Synthetic plan reply.');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + session.accessToken);
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(JSON.parse(calls[0].options.body).model, session.model);
  assert.doesNotMatch(JSON.stringify(output), new RegExp(session.accessToken));
  const models = await fetch(broker.baseUrl + '/models', { headers: { authorization: 'Bearer ' + broker.capability } });
  assert.equal(models.status, 200); assert.equal(calls.length, 1);
});

test('usage limits stop the broker permanently for this run and redact all provider diagnostics', async t => {
  let requests = 0, failures = 0;
  const broker = await createChatGPTPlanBroker({ session, onFailure() { failures++; }, fetchImpl: async () => { requests++; return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE_ACCOUNT_DETAIL' } }, { status: 429 }); } });
  t.after(() => broker.close());
  const send = () => fetch(broker.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + broker.capability, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
  const response = await send(); const body = await response.text(); assert.equal(response.status, 503);
  assert.doesNotMatch(body, /PRIVATE_ACCOUNT_DETAIL/); assert.equal(broker.error.code, 'CHATGPT_USAGE_LIMIT');
  await send(); assert.equal(requests, 1); assert.equal(failures, 1);
});

test('required ChatGPT route rejects another provider key and missing plan before starting Hermes', async () => {
  assert.throws(() => createHermesProvider({ requireChatGPT: true, providerKey: 'synthetic-other-provider-key', chatgptSession: async () => session }));
  const agent = createHermesProvider({ requireChatGPT: true, chatgptSession: async () => null, chatgptStatus: () => ({ connected: false }) });
  assert.equal(agent.status().inferenceProvider, 'chatgpt'); assert.equal(agent.status().planUsageEnabled, false);
  // ResolveRuntime may inspect configured metadata; no model/provider request is made.
  await assert.rejects(agent.run({ message: 'Hello' }), error => error.code === 'CHATGPT_SIGN_IN_REQUIRED');
});

test('required-plan failure reports only a safe code for saved-account recovery and preserves the original error', async () => {
  const observed = [];
  const failure = Object.assign(new Error('Reconnect your ChatGPT account in Nemo to continue.'), { code: 'CHATGPT_SIGN_IN_REQUIRED', privateDiagnostic: 'never-observe-this' });
  const agent = createHermesProvider({ requireChatGPT: true, chatgptSession: async () => { throw failure; },
    onChatGPTFailure(code) { observed.push(code); throw new Error('A failed state observer must not escape'); } });
  await assert.rejects(agent.run({ message: 'Hello' }), error => error === failure);
  assert.deepEqual(observed, ['CHATGPT_SIGN_IN_REQUIRED']);
  const invalid = createHermesProvider({ requireChatGPT: true, chatgptSession: async () => { throw Object.assign(new Error('synthetic internal failure'), { code: 'UNTRUSTED_CODE' }); }, onChatGPTFailure: code => observed.push(code) });
  await assert.rejects(invalid.run({ message: 'Hello' }));
  assert.deepEqual(observed, ['CHATGPT_SIGN_IN_REQUIRED']);
});

const runtimeRoot = resolve('.work/desktop-runtime');
const python = join(runtimeRoot, 'hermes', 'python', 'python.exe');
const source = join(runtimeRoot, 'hermes', 'source');
test('actual bundled Hermes answers through the plan adapter with synthetic OAuth only', { skip: !existsSync(python), timeout: 70_000 }, async t => {
  const scratch = await mkdtemp(resolve('test/.tmp-chatgpt-runtime-'));
  t.after(async () => {
    const parent = resolve('test'); assert.equal(dirname(scratch), parent); assert.ok(relative(parent, scratch).startsWith('.tmp-chatgpt-runtime-'));
    // Windows may briefly retain child-process directory handles after exit.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const home = join(scratch, 'assistant-home'); await mkdir(home);
  const registry = await createProfileStore({ dataDir: scratch }); const owner = await registry.owner();
  // Even a configured paid fallback must be unable to bypass the local adapter.
  await writeFile(join(home, 'config.yaml'), 'fallback_providers:\n  - provider: openrouter\n    model: paid-fallback-must-not-run\n');
  const requests = [];
  const agent = createHermesProvider({ hermesPython: python, hermesSource: source, hermesHome: home, cwd: scratch, dataDir: registry.directory(owner.id), family: true, profileId: owner.id,
    requireChatGPT: true, chatgptSession: async () => session, chatgptStatus: () => ({ connected: true, planUsageEnabled: true }),
    chatgptFetch: async (url, options) => { requests.push({ url, options }); return summaryReply(); }, timeoutMs: 50_000 });
  const result = await agent.run({ message: 'Synthetic adapter verification. Reply once.', signal: AbortSignal.timeout(55_000) });
  assert.equal(result.text, 'Synthetic plan reply.'); assert.equal(result.model, session.model);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(requests[0].options.body).store, false);
  assert.doesNotMatch(requests[0].options.body, new RegExp(session.accessToken));
  assert.equal(agent.status().verified, true);
  const second = await agent.run({ message: 'Resume the same synthetic conversation.', sessionId: result.sessionId, signal: AbortSignal.timeout(55_000) });
  assert.equal(second.text, 'Synthetic plan reply.'); assert.equal(second.sessionId, result.sessionId);
  assert.equal(requests.length, 2);
  const resumed = JSON.parse(requests[1].options.body);
  assert.ok(resumed.input.some(item => item.content?.some(part => part.text === 'Synthetic adapter verification. Reply once.')));
  assert.ok(resumed.input.some(item => item.role === 'assistant' && item.content?.some(part => part.text === 'Synthetic plan reply.')));
  assert.equal(resumed.previous_response_id, undefined);
});

test('actual bundled Hermes executes its exact calendar read through namespaced plan tools and MCP', { skip: !existsSync(python), timeout: 70_000 }, async t => {
  const scratch = await mkdtemp(resolve('test/.tmp-chatgpt-mcp-'));
  t.after(async () => { const parent = resolve('test'); assert.equal(dirname(scratch), parent); assert.ok(relative(parent, scratch).startsWith('.tmp-chatgpt-mcp-')); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const profiles = await createProfileStore({ dataDir: scratch }); const profile = await profiles.owner();
  const dataDir = profiles.directory(profile.id), home = join(scratch, 'assistant-home'); await mkdir(home);
  const calendar = await createCalendarStore({ dataDir }); const token = await calendar.issueToken(); const now = Date.now();
  await calendar.importSnapshot({ events: [{ title: 'SYNTHETIC_PLAN_CALENDAR_EVENT', start: new Date(now + 3600_000).toISOString(), end: new Date(now + 7200_000).toISOString() }] }, token);
  const requests = [];
  const agent = createHermesProvider({ hermesPython: python, hermesSource: source, hermesHome: home, cwd: scratch, dataDir,
    family: true, profileId: profile.id, nodeExecutable: join(runtimeRoot, 'node', 'node.exe'), requireChatGPT: true,
    chatgptSession: async () => session, chatgptStatus: () => ({ connected: true, planUsageEnabled: true }), timeoutMs: 55_000,
    chatgptFetch: async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(url, 'https://api.openai.com/v1/responses');
      if (requests.length === 1) {
        assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].tools[0].name, tool);
        return sse([{ type: 'response.completed', response: completed([{ type: 'function_call', call_id: 'calendar_call_1', namespace: 'nemo', name: tool, arguments: '{"limit":1}' }]) }]);
      }
      assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'calendar_call_1' && item.output.includes('SYNTHETIC_PLAN_CALENDAR_EVENT')));
      return reply();
    } });
  const result = await agent.run({ message: 'Read one synthetic calendar event.', useIntegrations: true, allowedConnectionTools: ['calendar_list'], permissionRevision: '0:0:false', signal: AbortSignal.timeout(60_000) });
  assert.equal(result.text, 'Synthetic plan reply.'); assert.equal(result.toolCalls, 1); assert.equal(requests.length, 2);
});

test('bundled assistant inventory stays intact after real plan replies, history resume and tool execution', { skip: !existsSync(python), timeout: 40_000 }, async () => {
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'manifest.json'), 'utf8')).hermes;
  const result = await verifyHermesBundle({ root: runtimeRoot, manifest });
  assert.equal(result.verified, true);
  assert.ok(result.extras.includes('mcp'));
});
