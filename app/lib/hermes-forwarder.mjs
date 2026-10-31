import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const helper = fileURLToPath(new URL('./hermes_provider_host.py', import.meta.url));
const failure = () => new Error('The host provider could not complete this request. It was not retried.');
const SAFE_REASONS=new Set(['PROVIDER_REQUEST','PROVIDER_IDENTITY','PROVIDER_OPERATION','PROVIDER_FIELDS','PROVIDER_TOOL','PROVIDER_CONTENT','PROVIDER_CONFIGURATION','PROVIDER_PROTOCOL','PROVIDER_MODEL','PROVIDER_STREAM_REQUIRED','PROVIDER_MODEL_SETUP','PROVIDER_AUTH','PROVIDER_UPSTREAM','PROVIDER_RESPONSE','PROVIDER_RESPONSE_HTML','PROVIDER_RESPONSE_TEXT','PROVIDER_DEPENDENCY','PROVIDER_PAYLOAD','PROVIDER_TRANSPORT','PROVIDER_RUNTIME','PROVIDER_UNAVAILABLE']);
for(const value of ['PROVIDER_RESPONSE_JSON','PROVIDER_RESPONSE_ERROR','PROVIDER_RESPONSE_INCOMPLETE','PROVIDER_RESPONSE_TYPE'])SAFE_REASONS.add(value);
for(const value of ['PROVIDER_RESPONSE_EMPTY_TYPE','PROVIDER_RESPONSE_OCTET','PROVIDER_RESPONSE_STREAM_TYPE','PROVIDER_RESPONSE_NDJSON'])SAFE_REASONS.add(value);
SAFE_REASONS.add('PROVIDER_RESPONSE_EMPTY');

/** Host-only adapter: credentials resolve inside the trusted Hermes Python
 * process. This module forwards no bearer/config data to family workers.
 * Constructing it does not inspect credentials or invoke any provider. */
export function createHermesForwarder({ pythonPath, sourceRoot, hermesHome, spawn = nodeSpawn, timeoutMs = 610_000, environment = process.env }) {
  if (![pythonPath, sourceRoot, hermesHome].every(value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value))) throw new Error('Configure absolute host Hermes runtime paths.');
  const bootstrap = `import sys, runpy; sys.path.insert(0, ${JSON.stringify(sourceRoot)}); import hermes_bootstrap; runpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
  return function forward({ profileId, path, method, body, signal }) {
    if (!UUID.test(profileId || '') || !((method === 'GET' && path === '/v1/models' && body === null) || (method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(path) && body && typeof body === 'object' && !Array.isArray(body)))) return Promise.reject(failure());
    if (signal?.aborted) return Promise.reject(failure());
    let input;
    try { input = JSON.stringify({ profileId, path, method, body }); if (Buffer.byteLength(input) > 2_000_000) throw failure(); }
    catch { return Promise.reject(failure()); }
    return new Promise((resolve, reject) => {
      const env = { ...environment, HERMES_HOME: hermesHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' };
      for (const key of Object.keys(env)) if (/^(?:NEMO_MCP_|HERMES_KANBAN_|HERMES_TUI_)/.test(key) || ['HERMES_YOLO_MODE', 'NEMO_HERMES_MODE'].includes(key)) delete env[key];
      let child; let controller; let header = false; let ended = false; let settled = false; let buffer = ''; let bytes = 0;
      const cancel = () => finish(failure());
      const timer = setTimeout(cancel, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      function finish(error) {
        if (settled) return; settled = true; cleanup();
        if (error) { child?.kill(); if (header) controller.error(error); else reject(error); }
        else if (header) { controller.close(); child?.kill(); }
        else reject(failure());
      }
      function frame(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(failure());
        if (value.type === 'error') {
          if (header || !Number.isInteger(value.status) || value.status < 400 || value.status > 599) return finish(failure());
          settled = true; cleanup(); child?.kill();
          // Never relay arbitrary diagnostics emitted by a provider or runtime.
          resolve(Response.json({ error: 'The configured host provider is unavailable.', code: 'HOST_PROVIDER',reason:SAFE_REASONS.has(value.code)?value.code:'PROVIDER_UNAVAILABLE' }, { status: value.status }));
        } else if (value.type === 'headers' && !header && Number.isInteger(value.status) && value.status === 200 && ['application/json', 'text/event-stream'].includes(value.contentType)) {
          header = true;
          const stream = new ReadableStream({ start(value) { controller = value; }, pull() { child?.stdout.resume(); }, cancel() { finish(failure()); } });
          resolve(new Response(stream, { status: 200, headers: { 'Content-Type': value.contentType, 'Cache-Control': 'no-store' } }));
        } else if (value.type === 'chunk' && header && !ended && typeof value.data === 'string' && value.data.length <= 32_768 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
          const chunk = Buffer.from(value.data, 'base64');
          if (chunk.toString('base64') !== value.data || (bytes += chunk.length) > 32_000_000) return finish(failure());
          controller.enqueue(chunk); if (controller.desiredSize <= 0) child.stdout.pause();
        } else if (value.type === 'end' && header && !ended) { ended = true; finish(); }
        else finish(failure());
      }
      try { child = spawn(pythonPath, ['-I', '-B', '-c', bootstrap], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { finish(failure()); return; }
      child.stderr.resume(); child.stdin.on('error', () => finish(failure()));
      child.on('error', () => finish(failure()));
      child.on('close', () => { if (!ended) finish(failure()); });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', part => {
        if (settled) return;
        buffer += part;
        while (!settled && buffer.includes('\n')) {
          const newline = buffer.indexOf('\n'), line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.length > 65_536) return finish(failure());
          try { frame(JSON.parse(line)); } catch { finish(failure()); }
        }
        if (buffer.length > 65_536) finish(failure());
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else child.stdin.end(input);
    });
  };
}
