import { randomUUID, createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prepareNativeHome } from './native-session.mjs';
import { readJson, writeJson } from './profile-store.mjs';
import { OPERATING_LIMITS } from './config.mjs';
import {createActivity,recordActivity,publicActivity,interruptActivity} from './activity.mjs';
import {nativeQuestions,nativeAnswers,nativePlan,answerFingerprint} from './native-interactions.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const revision = profile => `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}`;
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const copy = value => structuredClone(value);
export function stableAction(value) {
  function normalize(item) {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    fail('ACTION_SHAPE', 'The action must contain only JSON data.', 400);
  }
  const encoded = JSON.stringify(normalize(value));
  if (Buffer.byteLength(encoded) > 32_768) fail('ACTION_SIZE', 'The action is too large to review.', 400);
  return encoded;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const actionHash = (profileId, taskId, policy, action) => hash(stableAction({ profileId, taskId, policy, action }));

/** One private native-task journal per authenticated profile. Acquiring it does
 * not dispatch or resume any work. An uncertain previous dispatch stays paused.
 * It is separate from legacy reply runs until native execution is wired. */
export async function createTaskLedger({ dataDir, profileId, getProfile, now = Date.now, limits = OPERATING_LIMITS, onCommit=()=>{} }) {
  if (!UUID.test(profileId || '') || typeof getProfile !== 'function') throw new Error('A trusted task profile resolver is required.');
  const privateDir = dirname(await prepareNativeHome({ dataDir, profileId }));
  const path = join(privateDir, 'native-tasks.json'), lockPath = join(privateDir, 'native-tasks.lock');
  const owner = randomUUID(); let closed = false, chain = Promise.resolve(), lease;
  try { lease = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(lockPath, null);
    if (!previous || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) fail('TASK_STORE_BUSY', 'Task storage needs local recovery before it can be opened.', 503);
    let dead = false;
    try { process.kill(previous.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    if (!dead) fail('TASK_STORE_BUSY', 'This profile already has an active task supervisor.', 503);
    // Recheck the exact dead-owner record; never signal or stop that process.
    if ((await readJson(lockPath, null))?.owner !== previous.owner) fail('TASK_STORE_BUSY', 'Task supervisor changed. Try again.', 503);
    await unlink(lockPath); lease = await open(lockPath, 'wx', 0o600);
  }
  await lease.writeFile(JSON.stringify({ pid: process.pid, owner }));
  let state;
  try {
    state = await readJson(path, { version: 1, profileId, tasks: [] });
    if (state.version !== 1 || state.profileId !== profileId || !Array.isArray(state.tasks)) throw new Error('Private task storage has an unsupported identity or version.');
    for (const task of state.tasks) {
      interruptActivity(task.activity,now());
      if (['running', 'waiting', 'queued'].includes(task.phase)) { task.phase = 'paused'; task.reason = 'reconcile'; task.activeSince = null; task.updatedAt = now(); }
      for (const approval of task.approvals || []) if (['pending', 'approved'].includes(approval.state)) approval.state = 'cancelled';
      if(task.question?.state==='pending')task.question.state='cancelled';
      for (const action of task.actions || []) if (action.state === 'executing') action.state = 'unknown';
      task.subagents = [];
    }
    await writeJson(path, state);
  } catch (error) { await lease.close(); await unlink(lockPath).catch(() => {}); throw error; }

  async function current() {
    const profile = await getProfile(profileId);
    if (!profile || profile.id !== profileId || profile.disabled) fail('TASK_PROFILE', 'This profile is no longer active.', 403);
    return profile;
  }
  function taskFor(id) {
    const task = state.tasks.find(item => item.id === id && item.profileId === profileId);
    if (!task||task.deleted) fail('TASK_NOT_FOUND', 'This task is not available in this profile.', 404);
    return task;
  }
  function assertPolicy(task, profile) { if (task.policy !== revision(profile)) fail('TASK_POLICY_CHANGED', 'Profile permissions changed. This task needs review.', 403); }
  function elapsed(task) { return task.activeMs + (task.activeSince === null ? 0 : Math.max(0, now() - task.activeSince)); }
  function pause(task, reason) { task.activeMs = elapsed(task); task.activeSince = null; task.phase = 'paused'; task.reason = reason; task.updatedAt = now(); }
  function running(task, profile) { assertPolicy(task, profile); if (task.phase !== 'running') fail('TASK_NOT_RUNNING', 'This task is paused or no longer running.'); if (elapsed(task) >= task.budgetMs) return false; return true; }
  function budgetError(task) { pause(task, 'budget'); return { failure: ['TASK_BUDGET', 'The task reached its budget. Extend it to continue.'] }; }
  async function transaction(operation) {
    const next = chain.catch(() => {}).then(async () => {
      if (closed || (await readJson(lockPath, null))?.owner !== owner) fail('TASK_SUPERVISOR', 'The task supervisor is not active.', 503);
      const snapshot = copy(state);
      try {
        const result = await operation(await current());
        await writeJson(path, state);
        try{onCommit();}catch{} // Observers cannot roll back an already committed task.
        if (result?.failure) fail(...result.failure);
        return copy(result);
      } catch (error) {
        // A committed budget pause remains durable even though its caller sees
        // an error; every other failed mutation rolls back in memory.
        if (error.code !== 'TASK_BUDGET') state = snapshot;
        throw error;
      }
    });
    chain = next.then(() => {}, () => {}); return next;
  }
  const api = {
    async create({ requestKey, message, conversationId }) {
      if (!UUID.test(requestKey || '') || typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 32_768) fail('TASK_INPUT', 'Use a stable request ID and a message up to 32 KB.', 400);
      if(conversationId!==undefined&&!UUID.test(conversationId))fail('TASK_INPUT','Choose a private conversation.',400);
      return transaction(profile => {
        const fingerprint = hash(stableAction({ message,...(conversationId?{conversationId}:{}) }));
        const existing = state.tasks.find(task => task.requestKey === requestKey);
        if (existing) { if(existing.deleted)fail('TASK_DELETED','This conversation was deleted. Start a new message.',410);if (existing.fingerprint !== fingerprint) fail('TASK_REQUEST_CHANGED', 'This request ID already belongs to a different message.'); return { task: existing, created: false }; }
        if (state.tasks.length >= 1000) fail('TASK_CAPACITY', 'Task storage is full. Archive it before creating more tasks.', 429);
        const task = { id: randomUUID(), profileId, requestKey, fingerprint, message,...(conversationId?{conversationId}:{}), policy: revision(profile), phase: 'queued', reason: null, createdAt: now(), updatedAt: now(), activeMs: 0, activeSince: null, budgetMs: limits.activeMs, toolLimit: limits.toolCalls, toolCalls: [], subagents: [], approvals: [], actions: [] };
        state.tasks.push(task); return { task, created: true };
      });
    },
    async get(id) { await chain; await current(); return copy(taskFor(id)); },
    async all() {await chain;await current();return copy(state.tasks.filter(task=>!task.deleted));},
    async list() { await chain; await current(); return state.tasks.filter(task=>!task.deleted).slice(-100).reverse().map(task => ({ id: task.id, phase: task.phase, reason: task.reason, title: task.message.slice(0, 100), createdAt: task.createdAt, updatedAt: task.updatedAt, activeMs: elapsed(task), toolCalls: task.toolCalls.length })); },
    start(id) { return transaction(profile => { const task = taskFor(id); assertPolicy(task, profile); if (task.phase !== 'queued') fail('TASK_ALREADY_ADMITTED', 'This task cannot be dispatched again.'); if (elapsed(task) >= task.budgetMs) return budgetError(task); task.phase = 'running'; task.reason = null; task.activeSince = now(); task.updatedAt = now(); return task; }); },
    checkpoint(id) { return transaction(profile => { const task = taskFor(id); if (task.phase !== 'running') return task; assertPolicy(task, profile); if (elapsed(task) >= task.budgetMs) return budgetError(task); task.activeMs = elapsed(task); task.activeSince = now(); task.updatedAt = now(); return task; }); },
    ask(id,questions){return transaction(profile=>{const task=taskFor(id);if(!running(task,profile))return budgetError(task);if(task.question?.state==='pending')fail('QUESTION_PENDING','Answer the current question first.');if(task.question){task.questionHistory||=[];task.questionHistory.push(task.question);task.questionHistory=task.questionHistory.slice(-16);}task.question={id:randomUUID(),questions:nativeQuestions(questions),state:'pending',expiresAt:now()+300000};pause(task,'question');task.phase='waiting';return task.question;});},
    answer(id,questionId,answers,{defer=false}={}){return transaction(profile=>{const task=taskFor(id);assertPolicy(task,profile);const question=[task.question,...(task.questionHistory||[])].find(item=>item?.id===questionId);if(!question)fail('QUESTION_EXPIRED','This question is no longer available.');const clean=nativeAnswers(question.questions,answers),fingerprint=answerFingerprint(clean);if(question.state==='answered'){if(question.fingerprint!==fingerprint)fail('QUESTION_CHANGED','This question already has a different answer.');return{answered:false};}if(question!==task.question||question.state!=='pending'||task.phase!=='waiting'||question.expiresAt<=now())fail('QUESTION_EXPIRED','This question expired.');question.state='answered';question.fingerprint=fingerprint;question.answers=clean;task.phase=defer?'waiting':'running';task.reason=defer?'capacity':null;task.activeSince=defer?null:now();task.updatedAt=now();return{answered:true,answers:clean};});},
    continueAfterAnswer(id,questionId){return transaction(profile=>{const task=taskFor(id);assertPolicy(task,profile);if(task.phase!=='waiting'||task.reason!=='capacity'||task.question?.id!==questionId||task.question.state!=='answered')fail('QUESTION_CHANGED','This answer cannot continue the task.');if(elapsed(task)>=task.budgetMs)return budgetError(task);task.phase='running';task.reason=null;task.activeSince=now();task.updatedAt=now();return{ok:true};});},
    expireQuestion(id){return transaction(profile=>{const task=taskFor(id);assertPolicy(task,profile);if(task.question?.state==='pending'&&task.question.expiresAt<=now()){task.question.state='expired';pause(task,'question-expired');return{expired:true};}return{expired:false};});},
    plan(id,value){return transaction(profile=>{const task=taskFor(id);assertPolicy(task,profile);if(!['running','waiting'].includes(task.phase))fail('TASK_NOT_RUNNING','This task no longer accepts checklist updates.');const plan=nativePlan(value);if(task.plan&&plan.revision<task.plan.revision)return{updated:false};if(task.plan?.revision===plan.revision&&JSON.stringify(task.plan)!==JSON.stringify(plan))fail('PLAN_CHANGED','A checklist revision cannot change its content.');task.plan=plan;task.updatedAt=now();return{updated:true};});},
    recordTool(id, callId, executor = 'root') { return transaction(profile => {
      const task = taskFor(id); if (!running(task, profile)) return budgetError(task);
      if (!UUID.test(callId || '') || (executor !== 'root' && !task.subagents.includes(executor))) fail('TASK_EXECUTOR', 'This tool call does not belong to an active task executor.', 403);
      const previous = task.toolCalls.find(call => call.id === callId);
      if (previous) { if (previous.executor !== executor) fail('TASK_CALL_CHANGED', 'A call ID cannot move between executors.'); return { counted: false }; }
      if (task.toolCalls.length >= task.toolLimit) return budgetError(task);
      task.toolCalls.push({ id: callId, executor }); task.updatedAt = now(); return { counted: true };
    }); },
    addSubagent(id) { return transaction(profile => { const task = taskFor(id); if (!running(task, profile)) return budgetError(task); if (task.subagents.length >= limits.subagents) fail('TASK_SUBAGENTS', 'This task already has its two active subagents.', 429); const executor = randomUUID(); task.subagents.push(executor); return { executor }; }); },
    removeSubagent(id, executor) { return transaction(() => { const task = taskFor(id); task.subagents = task.subagents.filter(value => value !== executor); return { ok: true }; }); },
    requestApproval(id, action, { ttlMs = 300_000, callId = randomUUID(), executor = 'root' } = {}) { return transaction(profile => {
      const task = taskFor(id); if (!running(task, profile)) return budgetError(task);
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000 || !action || !['send', 'publish', 'delete', 'purchase', 'install', 'host-command', 'outside-task'].includes(action.kind) || typeof action.tool !== 'string' || action.tool.length > 120) fail('APPROVAL_ACTION', 'The exact action and tool must be reviewable.', 400);
      if (!UUID.test(callId || '') || (executor !== 'root' && !task.subagents.includes(executor))) fail('TASK_EXECUTOR', 'This action does not belong to an active executor.', 403);
      const existing = task.toolCalls.find(call => call.id === callId);
      if (existing && existing.executor !== executor) fail('TASK_CALL_CHANGED', 'A tool call cannot move between executors.');
      if (!existing) { if (task.toolCalls.length >= task.toolLimit) return budgetError(task); task.toolCalls.push({ id: callId, executor }); }
      const exact = JSON.parse(stableAction(action));
      const approval = { id: randomUUID(), callId, hash: actionHash(profileId, id, task.policy, exact), action: exact, state: 'pending', expiresAt: now() + ttlMs };
      task.approvals.push(approval); pause(task, 'approval'); task.phase = 'waiting'; return approval;
    }); },
    decide(id, approvalId, decision, expectedHash) { return transaction(profile => {
      const task = taskFor(id); assertPolicy(task, profile);
      const approval = task.approvals.find(item => item.id === approvalId);
      if (!approval || approval.state !== 'pending' || task.phase !== 'waiting' || approval.expiresAt <= now()) fail('APPROVAL_EXPIRED', 'This approval is expired or already answered.');
      if (!['once', 'deny'].includes(decision) || expectedHash !== approval.hash) fail('APPROVAL_CHANGED', 'Review the current exact action before answering.', 400);
      approval.state = decision === 'once' ? 'approved' : 'denied'; task.phase = 'paused'; task.reason = decision === 'once' ? 'approval-granted' : 'approval-denied'; task.updatedAt = now(); return approval;
    }); },
    resume(id, { extend = false } = {}) { return transaction(profile => {
      const task = taskFor(id); assertPolicy(task, profile);
      if (task.phase !== 'paused' || task.actions.some(action => action.state === 'unknown')) fail('TASK_RECONCILE', 'Reconcile uncertain actions before resuming this task.');
      if (task.reason === 'budget' && !extend) fail('TASK_EXTENSION', 'Explicitly extend this task’s budget to continue.');
      if (extend) { task.budgetMs += limits.activeMs; task.toolLimit += limits.toolCalls; }
      task.phase = 'queued'; task.reason = null; task.updatedAt = now(); return task;
    }); },
    async executeApproved(id, approvalId, action, execute) {
      if (typeof execute !== 'function') throw new Error('A trusted execution boundary is required.');
      const admitted = await transaction(profile => {
        const task = taskFor(id); if (!running(task, profile)) return budgetError(task);
        const approval = task.approvals.find(item => item.id === approvalId);
        const call = approval && task.toolCalls.find(item => item.id === approval.callId);
        if (!approval || !call || (call.executor !== 'root' && !task.subagents.includes(call.executor)) || approval.state !== 'approved' || approval.expiresAt <= now() || approval.hash !== actionHash(profileId, id, task.policy, action)) fail('APPROVAL_NOT_VALID', 'This exact action is not authorized for execution.', 403);
        approval.state = 'used'; const operation = { id: randomUUID(), approvalId, hash: approval.hash, state: 'executing' }; task.actions.push(operation); return { profileId, taskId: id, operationId: operation.id, action: copy(approval.action) };
      });
      try {
        const result = await execute(admitted);
        await transaction(() => { taskFor(id).actions.find(item => item.id === admitted.operationId).state = 'complete'; return { ok: true }; });
        return result;
      } catch {
        await transaction(() => { const task = taskFor(id); task.actions.find(item => item.id === admitted.operationId).state = 'unknown'; pause(task, 'reconcile'); return { ok: true }; });
        fail('TASK_ACTION_UNCERTAIN', 'The action’s outcome is uncertain. Check it before continuing.');
      }
    },
    reconcile(id, operationId, outcome) { return transaction(profile => { const task = taskFor(id); assertPolicy(task, profile); const operation = task.actions.find(item => item.id === operationId); if (!operation || operation.state !== 'unknown' || !['complete', 'failed'].includes(outcome)) fail('TASK_RECONCILE', 'Choose the observed outcome of this uncertain action.'); operation.state = outcome; return operation; }); },
    bindSession(id, { sessionId, storedSessionId, scopeKey, conversationId }) { return transaction(profile => { const task = taskFor(id); assertPolicy(task, profile); if (task.phase !== 'running' || ![sessionId, storedSessionId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && value !== 'latest') || scopeKey!==undefined&&!/^[a-f0-9]{64}$/.test(scopeKey)||conversationId!==undefined&&(!UUID.test(conversationId)||task.conversationId&&task.conversationId!==conversationId)) fail('TASK_SESSION', 'A private owned native session is required.');if(conversationId)task.conversationId=conversationId; task.nativeSession = { sessionId, storedSessionId,...(scopeKey?{scopeKey}:{}) }; return task.nativeSession; }); },
    async latestSession(scopeKey,{legacyPlain=false}={}) { await chain; await current(); return copy([...state.tasks].reverse().find(task => !task.deleted&&task.nativeSession&&(scopeKey===undefined||task.nativeSession.scopeKey===scopeKey||legacyPlain&&task.nativeSession.scopeKey===undefined&&task.toolCalls.length===0))?.nativeSession || null); },
    forgetConversation(conversationId,storedSessionId){return transaction(()=>{for(const task of state.tasks)if(task.conversationId===conversationId||storedSessionId&&task.nativeSession?.storedSessionId===storedSessionId){if(['queued','running','waiting'].includes(task.phase))fail('RUN_ACTIVE','Stop active replies before deleting this conversation.');task.deleted=true;task.message='';delete task.displayText;delete task.activity;delete task.question;delete task.questionHistory;delete task.plan;task.approvals=[];task.actions=[];task.nativeSession=null;task.subagents=[];}return{ok:true};});},
    forgetLastTurn(conversationId){return transaction(()=>{const task=[...state.tasks].reverse().find(row=>!row.deleted&&row.conversationId===conversationId);if(!task)return{ok:true};if(['queued','running','waiting'].includes(task.phase))fail('RUN_ACTIVE','Stop active replies before undoing this turn.');task.deleted=true;task.message='';delete task.displayText;delete task.activity;delete task.question;delete task.questionHistory;delete task.plan;task.approvals=[];task.actions=[];task.nativeSession=null;task.subagents=[];return{ok:true};});},
    activity(id,event){return transaction(profile=>{const task=taskFor(id);assertPolicy(task,profile);if(task.phase==='cancelled')return{};task.activity||=createActivity(id);recordActivity(task.activity,event,now());return publicActivity(task.activity);});},
    interrupt(id, reason = 'interrupted') { return transaction(() => { const task = taskFor(id); if (['complete','cancelled'].includes(task.phase)||task.phase==='paused'&&['budget','question-expired'].includes(task.reason)) return task; if (!['interrupted','worker','provider','reconcile'].includes(reason)) fail('TASK_REASON','Invalid interruption reason.',400); pause(task, reason); task.subagents=[];if(task.question?.state==='pending')task.question.state='cancelled'; for(const approval of task.approvals)if(['pending','approved'].includes(approval.state))approval.state='cancelled'; return task; }); },
    finish(id, { text } = {}) { return transaction(profile => { const task = taskFor(id); if (!running(task, profile)) return budgetError(task); if (task.actions.some(action => ['executing', 'unknown'].includes(action.state))) fail('TASK_RECONCILE', 'An action still needs reconciliation.'); if(text!==undefined){if(typeof text!=='string'||Buffer.byteLength(text)>200_000)fail('TASK_RESULT','The response is too large.',400);task.displayText=text;} pause(task, null); task.phase = 'complete'; task.subagents = []; return task; }); },
    cancel(id) { return transaction(() => { const task = taskFor(id); if (['complete', 'cancelled'].includes(task.phase)) return task; pause(task, 'cancelled'); task.phase = 'cancelled'; task.subagents = [];if(task.question?.state==='pending')task.question.state='cancelled'; for (const approval of task.approvals) if (['pending', 'approved'].includes(approval.state)) approval.state = 'cancelled'; return task; }); },
    async authorizeProvider(id) { await chain; const profile = await current(); const task = taskFor(id); return task.policy === revision(profile) && task.phase === 'running' && elapsed(task) < task.budgetMs; },
    async close() {
      await chain; if (closed) return; closed = true;
      for (const task of state.tasks) { interruptActivity(task.activity,now());if (['running', 'waiting', 'queued'].includes(task.phase)) pause(task, 'reconcile');if(task.question?.state==='pending')task.question.state='cancelled'; for (const approval of task.approvals) if (['pending', 'approved'].includes(approval.state)) approval.state = 'cancelled'; }
      await writeJson(path, state); await lease.close();
      if ((await readJson(lockPath, null))?.owner === owner) await unlink(lockPath);
    },
  };
  return api;
}
