import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { THINKING_WORDS } from './activity.mjs';
import {INTERACTION_TOOLS,nativePlan} from './native-interactions.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const METHODS = new Set(['client.capabilities','gateway.capabilities','ping','session.create','session.resume','session.list','session.history','session.status','session.usage','session.interrupt','session.close','nemo.history.targets','nemo.history.delete','session.undo','session.compress','session.branch','session.events.since','prompt.submit','session.steer']);
const GLOBAL = new Set(['client.capabilities','gateway.capabilities','ping','session.create','session.list']);

export async function prepareNativeHome({ dataDir, profileId }) {
  if (!UUID.test(profileId || '') || !isAbsolute(dataDir)) throw new Error('A trusted profile and absolute data directory are required.');
  const root = resolve(dataDir); const profile = join(root, 'profiles', profileId); const home = join(profile, 'hermes');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(root);
  for (const path of [join(root, 'profiles'), profile, home]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Native profiles cannot use linked directories.');
    const child = relative(actualRoot, await realpath(path));
    if (isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) throw new Error('Native profile escaped its private directory.');
  }
  return home;
}

/** Internal adapter only. It must not be connected to an unisolated, full-tool
 * worker. The public app does not enable it until provider and tool boundaries
 * are verified. Transport is injected to keep protocol tests inference-free. */
export class NativeSessionClient extends EventEmitter {
  constructor({ profileId, input, output, requestTimeoutMs = 15_000, requireChatGuard = false, learningPolicy = 'standard-v1',expectedTools=[] }) {
    super();
    if (!UUID.test(profileId || '')) throw new Error('A trusted profile is required.');
    this.profileId = profileId; this.input = input; this.pending = new Map(); this.sessions = new Set(); this.questions = new Map(); this.epoch = null; this.closed = false; this.requestTimeoutMs = requestTimeoutMs;
    if(!Array.isArray(expectedTools)||new Set(expectedTools).size!==expectedTools.length||expectedTools.some(name=>!['mcp__nemo__calendar_list','mcp__nemo__gmail_search','mcp__nemo__memory_search',...INTERACTION_TOOLS].includes(name)))throw new Error('A fixed managed tool set is required.');
    this.expectedTools=[...expectedTools];this.output = output; this.buffer = ''; this.requireChatGuard = requireChatGuard; this.guardVerified = false; this.learningPolicy = learningPolicy;
    output.setEncoding?.('utf8');
    this.onData = part => {
      this.buffer += part;
      while (!this.closed && this.buffer.includes('\n')) { const newline = this.buffer.indexOf('\n'); if (newline > 2_000_000) return this.close(); const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); this.receive(line); }
      if (this.buffer.length > 2_000_000) this.close();
    };
    this.onEnd = () => this.close(); output.on('data', this.onData); output.on('end', this.onEnd); output.on('close', this.onEnd);
    input.on('error', () => this.close()); output.on('error', () => this.close());
  }
  send(value) { if (this.closed) throw new Error('Native worker is disconnected.'); this.input.write(JSON.stringify(value) + '\n'); }
  registerStoredSession({ profileId, sessionId }) {
    // The coordinator supplies this mapping from this profile's private journal,
    // never from a browser/model argument or a shared legacy history index.
    if (profileId !== this.profileId || typeof sessionId !== 'string' || sessionId === 'latest' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('The persisted session mapping does not belong to this profile.');
    this.sessions.add(sessionId);
  }
  request(method, params = {}) {
    if (!METHODS.has(method) || !params || Array.isArray(params) || typeof params !== 'object') return Promise.reject(new Error('This native operation is not exposed by Nemo.'));
    if (Object.keys(params).some(key => key.startsWith('_') || ['profile','profileId','profile_name','owner','home','cwd','provider','model','api_key','base_url','api_mode','user_id','auth_user_id','workdir','cwd_explicit','room_plumbing','follow_profile_config'].includes(key))) return Promise.reject(new Error('Native identity and runtime settings are supplied by Nemo.'));
    if (!GLOBAL.has(method) && !this.sessions.has(params.session_id)) return Promise.reject(new Error('This session does not belong to this profile worker.'));
    if (params.parent_session_id && !this.sessions.has(params.parent_session_id)) return Promise.reject(new Error('This parent session is not owned.'));
    if(params.messages!==undefined&&(!['session.create'].includes(method)||!Array.isArray(params.messages)||params.messages.some(row=>!row||!['user','assistant'].includes(row.role)||Object.keys(row).some(key=>!['role','content'].includes(key))||typeof row.content!=='string')))return Promise.reject(new Error('Only visible user and assistant messages can be imported.'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Native worker request queue is full.'));
    const id = randomUUID();
    return new Promise((resolveRequest,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native response timed out; work was not resubmitted.')); }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolveRequest, reject, timer });
      try { this.send({ jsonrpc:'2.0', id, method, params: /^(?:session\.|prompt\.|nemo\.history\.)/.test(method) ? { ...params, profile:'default' } : { ...params } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(line) {
    if (this.closed) return;
    let frame;
    try { if (line.length > 2_000_000) throw new Error(); frame = JSON.parse(line); if (!frame || frame.jsonrpc !== '2.0') throw new Error(); }
    catch { this.close(); return; }
    if (!frame.method) {
      const pending = this.pending.get(frame.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) return pending.reject(Object.assign(new Error('Hermes refused this operation. Check compatibility and permissions.'),{rpcCode:Number.isInteger(frame.error.code)?frame.error.code:null,...(/^[A-Za-z]{1,40}Error$/.test(frame.error.data?.kind||'')?{rpcKind:frame.error.data.kind}:{})}));
      if (['session.create','session.resume','session.branch'].includes(pending.method)) {
        const id = frame.result?.session_id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return pending.reject(new Error('Hermes returned an invalid session identifier.'));
        const stored = frame.result.stored_session_id;
        if (stored !== undefined && (typeof stored !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(stored))) return pending.reject(new Error('Hermes returned an invalid stored session identifier.'));
        this.sessions.add(id);
        if (stored) this.sessions.add(stored);
      }
      pending.resolve(frame.result); return;
    }
    if (frame.method === 'event') {
      const { type, payload = {}, session_id, seq } = frame.params || {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return this.close();
      if (type === 'nemo.guard') {
        if (!payload || payload.version !== 3 || payload.stage !== 'startup' || payload.isolated !== true || !Array.isArray(payload.tools) || payload.tools.length!==this.expectedTools.length||new Set(payload.tools).size!==payload.tools.length||payload.tools.some(name=>!this.expectedTools.includes(name)) || payload.learningPolicy !== this.learningPolicy) return this.close();
        this.guardVerified = true; this.emit('policy', { profileId: this.profileId, mode: this.expectedTools.length?'managed-reads':'chat-only' }); return;
      }
      if (type === 'nemo.guard_error') return this.close();
      if(type==='nemo.interaction'){
        if(!this.guardVerified||!INTERACTION_TOOLS.includes(payload.name)||!this.expectedTools.includes(payload.name)||!UUID.test(payload.callId||'')||!['completed','failed'].includes(payload.state)||Object.keys(payload).some(key=>!['callId','name','state'].includes(key)))return this.close();this.emit('interaction',{profileId:this.profileId,name:payload.name,callId:payload.callId,state:payload.state});return;
      }
      if (type === 'nemo.status') {
        if (!this.guardVerified || !['thinking','idle'].includes(payload.phase) || (payload.phase === 'thinking' ? ![...THINKING_WORDS,'working'].includes(payload.verb) : payload.verb !== null)) return this.close();
        this.emit('status', { profileId: this.profileId, phase: payload.phase, verb: payload.verb }); return;
      }
      if (type === 'gateway.ready') {
        if (typeof payload.replay_epoch !== 'string') return this.close();
        if (this.epoch && this.epoch !== payload.replay_epoch) return this.close();
        this.epoch = payload.replay_epoch; this.emit('ready', { epoch:this.epoch }); return;
      }
      const session = session_id || payload.session_id;
      if (!session || !this.sessions.has(session)) return;
      if(this.requireChatGuard&&type.startsWith('tool.')){if(!this.guardVerified||!this.expectedTools.length||typeof payload.name==='string'&&!this.expectedTools.includes(payload.name))return this.close();return;} // Broker activity is the authoritative safe tool projection.
      if (this.requireChatGuard && ['message.delta', 'message.interim', 'message.complete'].includes(type) && !this.guardVerified) return this.close();
      if (type === 'reasoning.delta') return; // Waiting labels are separate from private reasoning.
      if(type==='todo.updated'){if(!this.guardVerified||!this.expectedTools.includes('todo_list'))return this.close();try{this.emit('activity',{profileId:this.profileId,sessionId:session,type,payload:nativePlan(payload),sequence:seq});}catch{this.close();}return;}
      if (type === 'request.cancel') this.questions.delete(payload.id || payload.request_id);
      const visible = type === 'message.complete' ? Object.fromEntries(Object.entries(payload).filter(([key]) => !['reasoning','rendered'].includes(key))) : payload;
      this.emit('activity', { profileId:this.profileId, sessionId:session, type, payload:visible, sequence:seq }); return;
    }
    const session = frame.params?.session_id;
    if (!['clarify','approval'].includes(frame.method) || !this.sessions.has(session) || typeof frame.id !== 'string' || frame.id.length > 200 || this.questions.size >= 16) {
      if (frame.id !== undefined) this.send({ jsonrpc:'2.0', id:frame.id, error:{ code:-32601, message:'This interactive operation is not exposed by Nemo.' } });
      return;
    }
    if (this.questions.has(frame.id)) return;
    this.questions.set(frame.id, { method:frame.method, params:frame.params });
    this.emit('question', { profileId:this.profileId, id:frame.id, method:frame.method, params:frame.params });
  }
  answer(id, result) {
    const request = this.questions.get(id);
    if (!request) throw new Error('This request is expired or already answered.');
    if (request.method === 'approval' && (!result || Object.keys(result).some(key => key !== 'choice') || !['once','deny'].includes(result.choice))) throw new Error('Only this exact action may be approved once or denied.');
    if (request.method === 'clarify') {
      if (!result || Object.keys(result).some(key => key !== 'answers') || !result.answers || Array.isArray(result.answers)) throw new Error('Answer the displayed questions.');
      const allowed = new Set((request.params.questions || []).map(question => question.qid));
      if (Object.entries(result.answers).some(([key,value]) => !allowed.has(key) || (value !== null && (typeof value !== 'string' || value.length > 8000)))) throw new Error('Answer only the displayed questions.');
    }
    this.send({ jsonrpc:'2.0', id, result }); this.questions.delete(id);
  }
  close() {
    if (this.closed) return; this.closed = true; this.output.off('data', this.onData); this.output.off('end', this.onEnd); this.output.off('close', this.onEnd); this.buffer = '';
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native worker disconnected. The operation was not automatically repeated.')); }
    this.pending.clear(); this.questions.clear(); this.sessions.clear(); this.emit('disconnected');
  }
}
