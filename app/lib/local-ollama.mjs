import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { NOTICE_OUTPUT, NOTICE_EXTRACTION_SCHEMA } from './school-notice-schema.mjs';

export const LOCAL_OLLAMA = Object.freeze({ origin: 'http://127.0.0.1:11434', model: 'gemma4:12b', context: 65536 });
export const LOCAL_MODEL_ALIAS = 'nemo-local-gemma4';
const TOOL_NAMES = new Set(['mcp__nemo__calendar_list', 'mcp__nemo__gmail_search', 'mcp__nemo__memory_search']);
const messages = {
  LOCAL_UNAVAILABLE: 'Open Ollama on this PC, then check the local assistant again. No cloud model was used.',
  LOCAL_MODEL_MISSING: 'Install gemma4:12b in Ollama on this PC, then check again. Nemo will not download it automatically.',
  LOCAL_MODEL_REMOTE: 'Nemo needs the local GGUF gemma4:12b model in Ollama. A remote model cannot be used in local mode.',
  LOCAL_PROTOCOL: 'The local model returned an unsupported response. No cloud model was used.',
  LOCAL_OUTPUT_LIMIT: 'The local reply reached its output limit. Try a shorter request. No cloud model was used.',
  LOCAL_BUSY: 'The local assistant is busy. Wait for the current task, then try again.',
};
export const localError = (code = 'LOCAL_UNAVAILABLE') => Object.assign(new Error(messages[code] || messages.LOCAL_UNAVAILABLE), { code: Object.hasOwn(messages, code) ? code : 'LOCAL_UNAVAILABLE', status: 503 });
async function json(response, maximum = 2_000_000) {
  const parts = []; let size = 0;
  for await (const part of response.body || []) { size += part.length; if (size > maximum) throw localError('LOCAL_PROTOCOL'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw localError('LOCAL_PROTOCOL'); }
}

// Discovery never generates text, loads a model or calls a cloud provider.
export async function checkLocalOllama({ fetchImpl = fetch, signal } = {}) {
  try {
    const response = await fetchImpl(LOCAL_OLLAMA.origin + '/api/tags', { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw localError();
    const data = await json(response);
    const model = data.models?.find(item => item.name === LOCAL_OLLAMA.model && typeof item.digest === 'string');
    if (!model) return { connected: false, code: 'LOCAL_MODEL_MISSING', message: messages.LOCAL_MODEL_MISSING };
    const shown = await fetchImpl(LOCAL_OLLAMA.origin + '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: LOCAL_OLLAMA.model }), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
    if (!shown.ok) throw localError();
    const details = await json(shown);
    if (model.remote_host || model.remote_model || details.remote_host || details.remote_model || details.details?.format !== 'gguf' || details.model_info?.['general.architecture'] !== 'gemma4') return { connected: false, code: 'LOCAL_MODEL_REMOTE', message: messages.LOCAL_MODEL_REMOTE };
    return { connected: true, model: LOCAL_OLLAMA.model, digest: model.digest };
  } catch { return { connected: false, code: 'LOCAL_UNAVAILABLE', message: messages.LOCAL_UNAVAILABLE }; }
}

export function createLocalInferenceQueue({ maximumPending = 8 } = {}) {
  const pending = []; let active = false;
  async function drain() {
    if (active || !pending.length) return;
    const item = pending.shift(); item.signal?.removeEventListener('abort', item.cancel);
    if (item.signal?.aborted) { item.reject(localError()); void drain(); return; }
    active = true;
    try { item.resolve(await item.work()); } catch (error) { item.reject(error); }
    finally { active = false; void drain(); }
  }
  return { run(work, signal) {
    if (signal?.aborted) return Promise.reject(localError());
    if (pending.length >= maximumPending) return Promise.reject(localError('LOCAL_BUSY'));
    return new Promise((resolve, reject) => {
      const item = { work, signal, resolve, reject, cancel() { const index = pending.indexOf(item); if (index >= 0) { pending.splice(index, 1); reject(localError()); } } };
      signal?.addEventListener('abort', item.cancel, { once: true }); pending.push(item); void drain();
    });
  } };
}
const sharedQueue = createLocalInferenceQueue();
const text = (value, maximum = 2_000_000) => { if (typeof value !== 'string' || value.length > maximum) throw localError('LOCAL_PROTOCOL'); return value; };

export function toLocalRequest(body, allowedTools = [], structuredOutput = null) {
  if (structuredOutput !== null && (structuredOutput !== NOTICE_OUTPUT || allowedTools.length)) throw localError('LOCAL_PROTOCOL');
  if (!body || body.model !== LOCAL_MODEL_ALIAS || body.stream === true || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000 || body.functions || body.function_call || ['base_url', 'api_key', 'profileId', 'authorization'].some(k => Object.hasOwn(body, k))) throw localError('LOCAL_PROTOCOL');
  if (new Set(allowedTools).size !== allowedTools.length || allowedTools.some(name => !TOOL_NAMES.has(name))) throw localError('LOCAL_PROTOCOL');
  const allowed = new Set(allowedTools), calls = new Map();
  const nativeMessages = body.messages.map(message => {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw localError('LOCAL_PROTOCOL');
    let content = message.content;
    if (Array.isArray(content)) content = content.map(part => { if (!part || !['text', 'input_text', 'output_text'].includes(part.type)) throw localError('LOCAL_PROTOCOL'); return text(part.text); }).join('\n');
    const result = { role: message.role === 'developer' ? 'system' : message.role, content: content == null ? '' : text(content) };
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 6) throw localError('LOCAL_PROTOCOL');
      result.tool_calls = message.tool_calls.map(call => {
        if (call?.type !== 'function' || typeof call.id !== 'string' || calls.has(call.id) || !allowed.has(call.function?.name)) throw localError('LOCAL_PROTOCOL');
        let args; try { args = JSON.parse(text(call.function.arguments, 4000)); } catch { throw localError('LOCAL_PROTOCOL'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw localError('LOCAL_PROTOCOL');
        calls.set(call.id, call.function.name); return { function: { name: call.function.name, arguments: args } };
      });
    }
    if (message.role === 'tool') { result.tool_name = calls.get(message.tool_call_id); if (!result.tool_name) throw localError('LOCAL_PROTOCOL'); }
    return result;
  });
  let tools;
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > 3) throw localError('LOCAL_PROTOCOL');
    const seen = new Set(); tools = body.tools.map(tool => {
      const fn = tool?.function;
      if (tool?.type !== 'function' || !fn || !allowed.has(fn.name) || seen.has(fn.name) || !fn.parameters || typeof fn.parameters !== 'object') throw localError('LOCAL_PROTOCOL');
      seen.add(fn.name); return { type: 'function', function: { name: fn.name, description: typeof fn.description === 'string' ? fn.description.slice(0, 20000) : '', parameters: fn.parameters } };
    });
  }
  return { model: LOCAL_OLLAMA.model, messages: nativeMessages, ...(tools?.length ? { tools } : {}), ...(structuredOutput ? { format: NOTICE_EXTRACTION_SCHEMA } : {}), stream: false, think: false,
    options: { num_ctx: LOCAL_OLLAMA.context, num_predict: 2048, temperature: 0 }, keep_alive: '5m' };
}

export function fromLocalResponse(data, allowedTools = []) {
  if (data?.done !== true || data.model !== LOCAL_OLLAMA.model || data.message?.role !== 'assistant') throw localError('LOCAL_PROTOCOL');
  if (data.done_reason === 'length') throw localError('LOCAL_OUTPUT_LIMIT');
  const content = text(data.message.content || ''), allowed = new Set(allowedTools);
  if (data.message.tool_calls !== undefined && (!Array.isArray(data.message.tool_calls) || data.message.tool_calls.length > 6)) throw localError('LOCAL_PROTOCOL');
  const calls = (data.message.tool_calls || []).map(call => {
    const fn = call?.function;
    if (!allowed.has(fn?.name) || !fn.arguments || typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)) throw localError('LOCAL_PROTOCOL');
    const args = JSON.stringify(fn.arguments); if (args.length > 4000) throw localError('LOCAL_PROTOCOL');
    return { id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name: fn.name, arguments: args } };
  });
  if (!content.trim() && !calls.length) throw localError('LOCAL_PROTOCOL');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const prompt = count(data.prompt_eval_count), completion = count(data.eval_count);
  return { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: LOCAL_MODEL_ALIAS,
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: count(data.prompt_eval_cached_count) } } };
}

/** Per-worker capability gateway; it can forward only to the pinned local model.
 * It shares admission control, never messages or credentials, with other workers. */
export async function createLocalOllamaBroker({ allowedTools = [], fetchImpl = fetch, signal, queue = sharedQueue, structuredOutput = null } = {}) {
  if (structuredOutput !== null && (structuredOutput !== NOTICE_OUTPUT || allowedTools.length)) throw localError('LOCAL_PROTOCOL');
  if (!Array.isArray(allowedTools) || new Set(allowedTools).size !== allowedTools.length || allowedTools.some(name => !TOOL_NAMES.has(name))) throw localError('LOCAL_PROTOCOL');
  const capability = randomBytes(32).toString('base64url'), lifetime = new AbortController(); let failure = null, rounds = 0;
  const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); } };
    try {
      const actual = Buffer.from(request.headers.authorization || ''), expected = Buffer.from('Bearer ' + capability);
      if (request.headers.host !== authority || request.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(403, { error: { message: 'Private local assistant connection required.' } });
      if (failure) return send(503, { error: { message: failure.message, code: failure.code } });
      if (request.method === 'GET' && request.url === '/v1/models') return send(200, { object: 'list', data: [{ id: LOCAL_MODEL_ALIAS, object: 'model', context_length: LOCAL_OLLAMA.context }] });
      if (request.method === 'GET' && request.url === '/props') return send(200, { default_generation_settings: { n_ctx: LOCAL_OLLAMA.context } });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return send(404, { error: { message: 'Unsupported local assistant operation.' } });
      const parts = []; let size = 0;
      for await (const part of request) { size += part.length; if (size > 2_000_000) throw localError('LOCAL_PROTOCOL'); parts.push(part); }
      let body; try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw localError('LOCAL_PROTOCOL'); }
      const native = toLocalRequest(body, allowedTools, structuredOutput);
      if (++rounds > 8) throw localError('LOCAL_OUTPUT_LIMIT');
      const controller = new AbortController(); response.once('close', () => controller.abort());
      const requestSignal = AbortSignal.any([combined, controller.signal, AbortSignal.timeout(115000)]);
      const result = await queue.run(async () => {
        let upstream;
        try { upstream = await fetchImpl(LOCAL_OLLAMA.origin + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: requestSignal, body: JSON.stringify(native) }); } catch { throw localError(); }
        if (!upstream.ok) throw localError();
        return fromLocalResponse(await json(upstream), allowedTools);
      }, requestSignal);
      send(200, result);
    } catch (error) { failure = Object.hasOwn(messages, error?.code) ? error : localError('LOCAL_PROTOCOL'); send(502, { error: { message: failure.message, code: failure.code } }); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 10000; server.maxHeadersCount = 24;
  let authority;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = '127.0.0.1:' + server.address().port;
  return { model: LOCAL_MODEL_ALIAS, baseUrl: 'http://' + authority + '/v1', capability, get error() { return failure; },
    async close() { lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
