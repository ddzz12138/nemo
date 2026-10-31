import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const LOCAL_MODEL = 'nemo-chatgpt-plan';
const MAX_BODY = 2_000_000;
const TOOL_NAMES = new Set(['mcp__nemo__calendar_list', 'mcp__nemo__gmail_search', 'mcp__nemo__memory_search']);
const safeMessages = {
  CHATGPT_USAGE_LIMIT: 'Your ChatGPT usage limit was reached. Review your usage in ChatGPT settings.',
  CHATGPT_SIGN_IN_REQUIRED: 'Reconnect your ChatGPT account in Nemo to continue.',
  CHATGPT_NOT_ELIGIBLE: 'ChatGPT plan usage is not available for this account or workspace.',
  CHATGPT_UNAVAILABLE: 'ChatGPT could not complete this reply. Please try again later.',
};

export function chatgptPlanError(code = 'CHATGPT_UNAVAILABLE') {
  if (!Object.hasOwn(safeMessages, code)) code = 'CHATGPT_UNAVAILABLE';
  return Object.assign(new Error(safeMessages[code]), { code, manageUsageUrl: CHATGPT_USAGE_URL });
}

export function classifyChatGPTFailure(status, code) {
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) return chatgptPlanError('CHATGPT_USAGE_LIMIT');
  if (code === 'subscription_sharing_user_not_eligible') return chatgptPlanError('CHATGPT_NOT_ELIGIBLE');
  if (status === 401 || ['invalid_api_key', 'invalid_token', 'token_expired'].includes(code)) return chatgptPlanError('CHATGPT_SIGN_IN_REQUIRED');
  return chatgptPlanError();
}

function string(value, max = MAX_BODY) {
  if (typeof value !== 'string' || value.length > max) throw chatgptPlanError();
  return value;
}

function contentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return string(value);
  if (!Array.isArray(value) || value.length > 1000) throw chatgptPlanError();
  return value.map(part => {
    if (!part || !['text', 'input_text', 'output_text'].includes(part.type)) throw chatgptPlanError();
    return string(part.text);
  }).join('\n');
}

// Only text and the existing, guarded client-side read tools cross this boundary.
// All provider settings come from a new object, never a spread of Hermes input.
export function toPlanRequest(request, model, allowedTools = []) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 2000) throw chatgptPlanError();
  const permitted = new Set(allowedTools);
  if (permitted.size !== allowedTools.length || allowedTools.some(name => !TOOL_NAMES.has(name))) throw chatgptPlanError();
  const input = [];
  for (const message of request.messages) {
    if (!message || typeof message !== 'object') throw chatgptPlanError();
    const role = message.role;
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: string(message.tool_call_id, 200), output: contentText(message.content) });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw chatgptPlanError();
    const text = contentText(message.content);
    if (text) input.push({ type: 'message', role: role === 'system' ? 'developer' : role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
    if (message.tool_calls !== undefined) {
      if (role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 6) throw chatgptPlanError();
      for (const call of message.tool_calls) {
        if (call?.type !== 'function' || !permitted.has(call.function?.name)) throw chatgptPlanError();
        input.push({ type: 'function_call', call_id: string(call.id, 200), name: call.function.name,
          namespace: 'nemo', arguments: string(call.function.arguments, 4000) });
      }
    }
  }
  if (!input.length) throw chatgptPlanError();
  const result = { model: string(model, 200), input, store: false, stream: true };
  if (request.tools !== undefined && request.tools !== null) {
    if (!Array.isArray(request.tools) || request.tools.length > 3) throw chatgptPlanError();
    const seen = new Set();
    const tools = request.tools.map(tool => {
      const fn = tool?.function;
      if (tool?.type !== 'function' || !fn || !permitted.has(fn.name) || seen.has(fn.name) || !fn.parameters || typeof fn.parameters !== 'object') throw chatgptPlanError();
      seen.add(fn.name);
      return { type: 'function', name: fn.name, description: typeof fn.description === 'string' ? fn.description.slice(0, 20_000) : '', parameters: fn.parameters, strict: false };
    });
    if (tools.length) result.tools = [{ type: 'namespace', name: 'nemo', description: 'The person’s explicitly enabled Nemo read tools.', tools }];
  }
  return result;
}

async function boundedText(response, maximum = MAX_BODY) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximum) throw chatgptPlanError();
    return text;
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw chatgptPlanError(); chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function completedPlanResponse(response) {
  if (!response.ok) {
    let code; try { code = JSON.parse(await boundedText(response, 32_768)).error?.code; } catch {}
    throw classifyChatGPTFailure(response.status, code);
  }
  // The authenticated plan endpoint can omit Content-Type on an SSE response.
  // An explicit different type is still rejected. Missing metadata never makes
  // JSON/HTML, partial deltas or failed streams into a successful completion.
  const mediaType = response.headers.get('content-type');
  if (mediaType && mediaType.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') throw chatgptPlanError();
  const reader = response.body?.getReader(); if (!reader) throw chatgptPlanError();
  const decoder = new TextDecoder(); let pending = '', total = 0, completed = null;
  const outputItems = new Map(), pendingItems = new Map();
  function outputItem(value, done) {
    const index = value.output_index, item = value.item;
    if (!Number.isSafeInteger(index) || index < 0 || index >= 1000 || !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !item.id || item.id.length > 200 || typeof item.type !== 'string'
      || outputItems.has(index) || pendingItems.has(index) && pendingItems.get(index) !== item.id) throw chatgptPlanError();
    if (done) { pendingItems.delete(index); outputItems.set(index, item); }
    else { if (pendingItems.has(index)) throw chatgptPlanError(); pendingItems.set(index, item.id); }
  }
  function event(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value; try { value = JSON.parse(data); } catch { throw chatgptPlanError(); }
    if (completed) throw chatgptPlanError();
    if (value.type === 'response.failed' || value.type === 'error') throw classifyChatGPTFailure(0, value.response?.error?.code || value.error?.code || value.code);
    if (value.type === 'response.incomplete') throw chatgptPlanError();
    if (value.type === 'response.output_item.added') outputItem(value, false);
    if (value.type === 'response.output_item.done') outputItem(value, true);
    if (value.type === 'response.completed') {
      if (value.response?.status !== 'completed' || !Array.isArray(value.response.output)) throw chatgptPlanError();
      completed = value.response;
      // Some plan streams finish with a summary-only response (output: []).
      // Recover complete items, never text deltas or an unfinished tool call.
      // The ordinary tool allowlist is still enforced by toHermesCompletion.
      if (!completed.output.length && outputItems.size) {
        const entries = [...outputItems].sort(([left], [right]) => left - right);
        if (pendingItems.size || entries.some(([index], offset) => index !== offset)) throw chatgptPlanError();
        completed = { ...completed, output: entries.map(([, item]) => item) };
      }
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { pending += decoder.decode(); break; }
      total += value.byteLength; if (total > 8_000_000) throw chatgptPlanError();
      pending += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) { const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length); event(frame); }
      if (pending.length > MAX_BODY) throw chatgptPlanError();
    }
    if (pending.trim()) event(pending);
    if (!completed) throw chatgptPlanError();
    return completed;
  } finally { await reader.cancel().catch(() => {}); }
}

export function toHermesCompletion(response, allowedTools = []) {
  const text = [], calls = [];
  for (const output of response.output) {
    if (output?.type === 'message') {
      if (!Array.isArray(output.content)) throw chatgptPlanError();
      for (const part of output.content) {
        if (part.type === 'output_text') text.push(string(part.text));
        else if (part.type === 'refusal') text.push(string(part.refusal));
      }
    } else if (output?.type === 'function_call') {
      if (!allowedTools.includes(output.name) || output.namespace && output.namespace !== 'nemo' || calls.length >= 6) throw chatgptPlanError();
      calls.push({ id: string(output.call_id, 200), type: 'function', function: { name: output.name, arguments: string(output.arguments, 4000) } });
    } else if (output?.type !== 'reasoning') throw chatgptPlanError();
  }
  if (!text.length && !calls.length) throw chatgptPlanError();
  return { id: 'chatcmpl_nemo_' + randomBytes(12).toString('hex'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: LOCAL_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: text.join('') || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: Number.isSafeInteger(response.usage?.input_tokens) ? response.usage.input_tokens : 0,
      completion_tokens: Number.isSafeInteger(response.usage?.output_tokens) ? response.usage.output_tokens : 0,
      total_tokens: Number.isSafeInteger(response.usage?.total_tokens) ? response.usage.total_tokens : 0 } };
}

/** Per-run adapter. The real OAuth credential never enters Hermes or its child tools. */
export async function createChatGPTPlanBroker({ session, allowedTools = [], fetchImpl = fetch, signal, timeoutMs = 100_000, onFailure = () => {} } = {}) {
  if (session?.provider !== 'chatgpt' || typeof session.accessToken !== 'string' || session.accessToken.length < 16 || session.accessToken.length > 20_000 || /[\r\n\0]/.test(session.accessToken) || typeof session.model !== 'string' || !session.model || /[\r\n\0]/.test(session.model)) throw chatgptPlanError('CHATGPT_SIGN_IN_REQUIRED');
  const capability = randomBytes(32).toString('base64url'), controller = new AbortController();
  const liveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let authority = '', origin = '', failure = null, requests = 0, active = false, closing = false;
  const fail = error => { failure ||= error?.code && Object.hasOwn(safeMessages, error.code) ? error : chatgptPlanError(); onFailure(failure); return failure; };
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const send = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
    const expected = Buffer.from('Bearer ' + capability), actual = Buffer.from(request.headers.authorization || '');
    if (request.headers.host !== authority || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.origin && request.headers.origin !== origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(403, { error: { message: 'Private Nemo assistant connection required.' } });
    if (request.method === 'GET' && request.url === '/v1/models') return send(200, { data: [{ id: LOCAL_MODEL, object: 'model', context_length: 131072 }] });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return send(404, { error: { message: 'This assistant action is unavailable.' } });
    if (closing || failure || active || requests >= 12) return send(503, { error: { message: 'This assistant request is unavailable.' } });
    active = true; requests++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw chatgptPlanError(); chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const body = toPlanRequest(payload, session.model, allowedTools);
      const remote = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.any([liveSignal, AbortSignal.timeout(timeoutMs)]),
        headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
      const completion = toHermesCompletion(await completedPlanResponse(remote), allowedTools);
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const choice = completion.choices[0], message = choice.message;
        const delta = { role: 'assistant', ...(message.content ? { content: message.content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
        response.end('data: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] }) + '\n\ndata: [DONE]\n\n');
      } else send(200, completion);
    } catch (error) {
      const safe = fail(error);
      send(503, { error: { code: safe.code, message: safe.message } });
    } finally { active = false; }
  });
  server.requestTimeout = 110_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`; origin = `http://${authority}`;
  return { baseUrl: origin + '/v1', capability, model: LOCAL_MODEL, get error() { return failure; },
    async close() { if (closing) return; closing = true; controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }, };
}
