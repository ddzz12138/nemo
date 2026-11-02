import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHermesWorkspace } from './hermes-memory.mjs';
import { verifyNativeRuntime } from './native-compatibility.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_FRAME = 16_000_000;
const METHODS = new Set(['ping', 'gateway.capabilities', 'client.capabilities', 'session.create', 'session.resume', 'session.list', 'session.history', 'session.status', 'session.usage', 'session.interrupt', 'session.close', 'prompt.submit', 'tools.list', 'tools.show', 'toolsets.list', 'skills.manage', 'skills.reload']);
const QUESTIONS = new Set(['approval', 'clarify', 'secret', 'sudo']);
const unavailable = () => new Error('Hermes workspace is unavailable. Check the assistant on this computer.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Internal host-owner transport for the unmodified Hermes gateway. The host
 * service authenticates each UI operation; browser requests never choose RPC
 * methods, runtime settings, a profile home, or tool implementations. */
export class HermesWorkspaceClient extends EventEmitter {
  constructor({ input, output, requestTimeoutMs = 30_000 }) {
    super();
    this.input = input; this.output = output; this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map(); this.questions = new Map(); this.sessions = new Set();
    this.closed = false; this.buffer = ''; this.ready = null;
    this.onData = chunk => {
      this.buffer += chunk;
      while (!this.closed && this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n');
        if (end > MAX_FRAME) return this.close();
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) this.receive(line);
      }
      if (this.buffer.length > MAX_FRAME) this.close();
    };
    this.onEnd = () => this.close();
    output.setEncoding?.('utf8'); output.on('data', this.onData);
    output.on('end', this.onEnd); output.on('close', this.onEnd);
    input.on('error', this.onEnd); output.on('error', this.onEnd);
  }
  send(value) {
    if (this.closed) throw unavailable();
    const line = JSON.stringify(value);
    if (line.length > MAX_FRAME) throw new Error('This Hermes request is too large.');
    this.input.write(line + '\n');
  }
  request(method, params = {}) {
    if (!METHODS.has(method) || !object(params) || Object.keys(params).some(key => key.startsWith('_') || ['profileId', 'home', 'cwd', 'cwd_explicit', 'provider', 'model', 'base_url', 'api_key', 'api_mode', 'auth_user_id', 'workdir'].includes(key))
      || params.profile !== undefined && params.profile !== 'default') return Promise.reject(new Error('This Hermes workspace operation is not exposed by Nemo.'));
    if (params.session_id !== undefined && (typeof params.session_id !== 'string' || !SESSION.test(params.session_id) || params.session_id === 'latest')) return Promise.reject(new Error('Choose a private Hermes conversation.'));
    if (method === 'prompt.submit' && (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 100_000 || !this.sessions.has(params.session_id))) return Promise.reject(new Error('Write a message in the current Hermes conversation.'));
    if (method === 'skills.manage' && (params.action !== 'list' || Object.keys(params).some(key => !['profile', 'action'].includes(key)))) return Promise.reject(new Error('Use Hermes in chat to manage skills.'));
    if (method === 'session.create' && params.source !== undefined && params.source !== 'tui') return Promise.reject(new Error('The Hermes workspace source is supplied by Nemo.'));
    if (this.closed || this.pending.size >= 32) return Promise.reject(unavailable());
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Hermes did not answer in time. The operation was not repeated.')); }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolveRequest, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params: { ...params, ...(/^(?:session\.|prompt\.|skills\.)/.test(method) ? { profile: 'default' } : {}), ...(method === 'session.create' ? { source: 'tui' } : {}) } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(line) {
    let frame;
    try { frame = JSON.parse(line); if (!object(frame) || frame.jsonrpc !== '2.0') throw unavailable(); }
    catch { return this.close(); }
    if (!frame.method) {
      const pending = this.pending.get(frame.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) return pending.reject(Object.assign(unavailable(), { rpcCode: Number.isInteger(frame.error.code) ? frame.error.code : null }));
      if (['session.create', 'session.resume'].includes(pending.method)) {
        const id = frame.result?.session_id;
        if (typeof id !== 'string' || !SESSION.test(id)) return pending.reject(unavailable());
        this.sessions.add(id);
      }
      pending.resolve(frame.result); return;
    }
    if (frame.method === 'event') {
      if (!object(frame.params) || typeof frame.params.type !== 'string' || frame.params.type.length > 120 || frame.params.payload !== undefined && !object(frame.params.payload)) return this.close();
      // Native payload-less lifecycle events (message.start, etc.) omit this key.
      // Normalize the empty envelope, retaining all upstream event content.
      frame.params = { ...frame.params, payload: frame.params.payload || {} };
      if (frame.params.type === 'gateway.ready') {
        const epoch = frame.params.payload.replay_epoch;
        if (typeof epoch !== 'string' || !epoch || epoch.length > 200 || this.ready) return this.close();
        this.ready = { connected: true, upstream: true, mode: 'host-owner', replayEpoch: epoch };
        this.emit('ready', this.ready);
      }
      if (frame.params.type === 'request.cancel') this.questions.delete(frame.params.payload.id || frame.params.payload.request_id);
      this.emit('event', frame.params); return;
    }
    if (typeof frame.id !== 'string' || frame.id.length > 200 || !QUESTIONS.has(frame.method) || !object(frame.params) || !this.sessions.has(frame.params.session_id) || this.questions.size >= 16) {
      if (frame.id !== undefined) this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'This interactive request is not supported by Nemo.' } });
      return;
    }
    if (this.questions.has(frame.id)) return;
    this.questions.set(frame.id, { method: frame.method, params: frame.params });
    this.emit('request', { id: frame.id, method: frame.method, params: frame.params });
  }
  answer(id, result) {
    const question = this.questions.get(id);
    if (!question || !object(result)) throw new Error('This Hermes question is expired or already answered.');
    if (question.method === 'approval') {
      const offered = Array.isArray(question.params.choices) ? question.params.choices : ['once', 'deny'];
      if (!['once', 'session', 'always', 'deny'].includes(result.choice) || !offered.includes(result.choice) || Object.keys(result).some(key => key !== 'choice' && key !== 'all') || result.all !== undefined && typeof result.all !== 'boolean') throw new Error('Choose one of Hermes’s offered approval options.');
    } else if (question.method === 'clarify') {
      const qids = new Set((question.params.questions || []).map(item => item.qid));
      if (!object(result.answers) || Object.keys(result).some(key => key !== 'answers') || Object.entries(result.answers).some(([key, value]) => !qids.has(key) || value !== null && (typeof value !== 'string' || value.length > 8000))) throw new Error('Answer the displayed Hermes questions.');
    } else if (Object.keys(result).some(key => key !== 'value') || typeof result.value !== 'string' || result.value.length > 16_000) throw new Error('Enter a value for the displayed Hermes prompt.');
    this.send({ jsonrpc: '2.0', id, result }); this.questions.delete(id);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.buffer = '';
    this.output.off('data', this.onData); this.output.off('end', this.onEnd); this.output.off('close', this.onEnd);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(unavailable()); }
    this.pending.clear(); this.questions.clear(); this.sessions.clear(); this.emit('disconnected');
  }
}

/** Native full tools are local host-owner access, not a family isolation mode.
 * Stock Hermes code, schemas, dependency gates and approval behavior are kept. */
export async function startHermesWorkspaceWorker({ profile, dataDir, pythonPath, sourceRoot, home, brokerUrl, brokerGrant, model, spawn = nodeSpawn, environment = process.env, verifyRuntime = verifyNativeRuntime, signal, startupTimeoutMs = 30_000 }) {
  if (!profile || profile.role !== 'owner' || profile.childMode === true || profile.disabled || !UUID.test(profile.id || '') || ![dataDir, pythonPath, sourceRoot, home].every(path => typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path))
      || !/^[A-Za-z0-9_-]{32,128}$/.test(brokerGrant || '') || typeof model !== 'string' || !model || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error('Only the authenticated host owner can open this Hermes workspace.');
  let broker;
  try { broker = new URL(brokerUrl); } catch { throw unavailable(); }
  if (broker.protocol !== 'http:' || broker.hostname !== '127.0.0.1' || !broker.port || Number(broker.port) < 1024 || broker.pathname !== '/v1' || broker.search || broker.hash || broker.username || broker.password) throw new Error('A private ChatGPT broker is required.');
  const root = await realpath(dataDir);
  const registry = JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8'));
  if (registry.version !== 2 || !registry.profiles?.some(row => row.id === profile.id && row.role === 'owner' && !row.disabled && row.childMode !== true)) throw new Error('The host owner is no longer available.');
  const expectedHome = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: join(root, 'profiles', profile.id) });
  if (!samePath(resolve(await realpath(home)), resolve(expectedHome))) throw new Error('The Hermes workspace does not belong to this person.');
  const compatibility = await verifyRuntime({ sourceRoot });
  if (compatibility?.supported !== true) throw new Error('This Hermes runtime needs compatibility review.');
  const workspace = join(home, 'workspace'), temporary = join(home, 'scratch');
  await mkdir(workspace, { recursive: true }); await mkdir(temporary, { recursive: true });
  // Use Hermes's supported managed-scope overlay, never rewrite the owner's
  // config or monkey-patch its resume handler. A forced process stop must also
  // restore history without automatically resubmitting an uncertain action.
  if (signal?.aborted) throw new Error('Hermes workspace startup was cancelled.');
  const policy = await mkdtemp(join(temporary, 'nemo-workspace-policy-'));
  const clearPolicy = async () => {
    if (dirname(policy) !== temporary || !basename(policy).startsWith('nemo-workspace-policy-')) throw unavailable();
    const info = await lstat(policy).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    await unlink(join(policy, 'config.yaml')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(policy); // Remove only our known file and empty directory; never recurse.
  };
  try { await writeFile(join(policy, 'config.yaml'), 'desktop:\n  auto_continue:\n    enabled: false\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { await clearPolicy(); throw error; }
  const env = {};
  for (const [key, value] of Object.entries(environment)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'LANG', 'LC_ALL'].includes(key.toUpperCase())) env[key] = value;
  const privateHome = toNamespacedPath(home), privateTemporary = toNamespacedPath(temporary);
  Object.assign(env, { HOME: privateHome, USERPROFILE: privateHome, APPDATA: join(privateHome, 'appdata'), LOCALAPPDATA: join(privateHome, 'localappdata'), XDG_CACHE_HOME: join(privateHome, 'cache'), HERMES_HOME: privateHome, TMP: privateTemporary, TEMP: privateTemporary, TMPDIR: privateTemporary, NEMO_WORKSPACE_PROFILE: profile.id, NEMO_WORKSPACE_ROOT: toNamespacedPath(root),
    HERMES_MODEL: model, HERMES_INFERENCE_MODEL: model, HERMES_INFERENCE_PROVIDER: 'custom', HERMES_TUI_PROVIDER: 'custom', CUSTOM_BASE_URL: brokerUrl, OPENAI_BASE_URL: brokerUrl, OPENAI_API_KEY: brokerGrant,
    HERMES_MANAGED_DIR: toNamespacedPath(policy),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', NO_PROXY: '127.0.0.1' });
  const helper = fileURLToPath(new URL('./hermes_workspace_worker.py', import.meta.url));
  const bootstrap = `import sys, runpy; sys.path.insert(0, ${JSON.stringify(sourceRoot)}); import hermes_bootstrap; runpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
  if (signal?.aborted) { await clearPolicy(); throw new Error('Hermes workspace startup was cancelled.'); }
  let child;
  try { child = spawn(pythonPath, ['-I', '-B', '-c', bootstrap], { cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { await clearPolicy(); throw unavailable(); }
  const stopped = new Promise(resolveStopped => child.once('close', resolveStopped));
  const client = new HermesWorkspaceClient({ input: child.stdin, output: child.stdout });
  let closing = false, closeOperation = null;
  const terminate = () => {
    try {
      if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
      else child.kill();
    } catch {} // Only a confirmed close can release the host's stop fence.
  };
  child.stderr.resume(); child.once('error', () => client.close()); child.once('close', () => client.close()); client.once('disconnected', () => { if (!closing) terminate(); });
  const abort = () => client.close(); signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { client.close(); reject(new Error('Hermes workspace startup timed out.')); }, startupTimeoutMs);
      client.once('ready', () => { clearTimeout(timer); resolveReady(); });
      client.once('disconnected', () => { clearTimeout(timer); reject(unavailable()); });
      if (signal?.aborted) abort();
    });
    await client.request('client.capabilities', { server_requests: true });
    return { profileId: profile.id, home, client, readiness: client.ready, async close() {
      if (closeOperation) return closeOperation;
      closeOperation = (async () => {
        closing = true; signal?.removeEventListener('abort', abort);
        if (!client.closed) {
          const sessions = [...client.sessions];
          await Promise.race([Promise.allSettled(sessions.map(session_id => client.request('session.interrupt', { session_id }))), pause(1500)]);
          await Promise.race([Promise.allSettled(sessions.map(session_id => client.request('session.close', { session_id }))), pause(1500)]);
          client.close();
        }
        child.stdin.end();
        let confirmed = await Promise.race([stopped.then(() => true), pause(3000).then(() => false)]);
        if (!confirmed) {
          // Windows uses the launcher's kernel Job Object: killing its owning
          // process also kills inherited descendants, without PID enumeration.
          terminate();
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          confirmed = await Promise.race([stopped.then(() => true), pause(1000).then(() => false)]);
        }
        if (!confirmed) throw Object.assign(new Error('Hermes could not confirm that its workspace stopped. Check this computer before continuing.'), { stopUnconfirmed: true });
        await clearPolicy();
      })();
      try { await closeOperation; }
      catch (error) { closeOperation = null; throw error; }
    } };
  } catch (error) {
    closing = true; signal?.removeEventListener('abort', abort); client.close();
    const cleanup = async () => {
      terminate();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (!await Promise.race([stopped.then(() => true), pause(1000).then(() => false)])) {
        throw Object.assign(new Error('Hermes could not confirm that its workspace stopped. Check this computer before continuing.'), { stopUnconfirmed: true, close: cleanup });
      }
      await clearPolicy();
    };
    await cleanup();
    throw error;
  }
}
