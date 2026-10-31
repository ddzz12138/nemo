import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskLedger } from '../lib/task-ledger.mjs';

async function fixture(t, limits = { activeMs: 600_000, toolCalls: 64, subagents: 2 }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-task-journal-')); const profile = { id: randomUUID(), policyRevision: 0 }; let time = 1000;
  const options = { dataDir, profileId: profile.id, getProfile: id => id === profile.id ? profile : null, now: () => time, limits };
  let ledger = await createTaskLedger(options);
  t.after(async () => { await ledger.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { get ledger() { return ledger; }, profile, dataDir, tick(ms) { time += ms; }, async reopen() { await ledger.close(); ledger = await createTaskLedger(options); return ledger; }, options,
    async task() { const { task } = await ledger.create({ requestKey: randomUUID(), message: 'Synthetic task' }); return task.id; } };
}

test('task admission is durable and idempotent; IDs and private state cannot move across profiles', async t => {
  const f = await fixture(t), requestKey = randomUUID();
  const first = await f.ledger.create({ requestKey, message: 'Synthetic private A' }); assert.equal(first.created, true);
  assert.equal((await f.ledger.create({ requestKey, message: 'Synthetic private A' })).created, false);
  await assert.rejects(f.ledger.create({ requestKey, message: 'Different payload' }), { code: 'TASK_REQUEST_CHANGED' });
  await f.ledger.start(first.task.id); await assert.rejects(f.ledger.start(first.task.id), { code: 'TASK_ALREADY_ADMITTED' });
  const stored = JSON.parse(await readFile(join(f.dataDir, 'profiles', f.profile.id, 'native-tasks.json')));
  assert.equal(stored.tasks[0].phase, 'running');
  await assert.rejects(createTaskLedger(f.options), { code: 'TASK_STORE_BUSY' });
  const b = await fixture(t); await assert.rejects(b.ledger.get(first.task.id), { code: 'TASK_NOT_FOUND' });
  await f.reopen(); assert.equal((await f.ledger.get(first.task.id)).phase, 'paused'); assert.equal((await f.ledger.get(first.task.id)).reason, 'reconcile');
  await assert.rejects(f.ledger.start(first.task.id), { code: 'TASK_ALREADY_ADMITTED' });
  assert.equal((await f.ledger.create({ requestKey, message: 'Synthetic private A' })).task.id, first.task.id);
});

test('human waiting does not consume active time; calls and subagents share the parent budget', async t => {
  const f = await fixture(t, { activeMs: 100, toolCalls: 3, subagents: 2 }), id = await f.task(); await f.ledger.start(id); f.tick(20);
  const child = await f.ledger.addSubagent(id); await f.ledger.addSubagent(id); await assert.rejects(f.ledger.addSubagent(id), { code: 'TASK_SUBAGENTS' });
  const callId = randomUUID(); assert.equal((await f.ledger.recordTool(id, callId, child.executor)).counted, true);
  assert.equal((await f.ledger.recordTool(id, callId, child.executor)).counted, false);
  const action = { kind: 'send', tool: 'synthetic_send', arguments: { recipient: 'fixture@example.test', body: 'Synthetic' } };
  const approval = await f.ledger.requestApproval(id, action); f.tick(50_000);
  assert.equal((await f.ledger.get(id)).activeMs, 20); assert.equal(await f.ledger.authorizeProvider(id), false);
  await f.ledger.decide(id, approval.id, 'once', approval.hash); await f.ledger.resume(id); await f.ledger.start(id);
  assert.equal(await f.ledger.authorizeProvider(id), true);
  await f.ledger.recordTool(id, randomUUID()); await assert.rejects(f.ledger.recordTool(id, randomUUID()), { code: 'TASK_BUDGET' });
  assert.equal((await f.ledger.get(id)).reason, 'budget');
  await assert.rejects(f.ledger.resume(id), { code: 'TASK_EXTENSION' }); await f.ledger.resume(id, { extend: true }); await f.ledger.start(id);
  assert.equal((await f.ledger.get(id)).toolLimit, 6);
  f.tick(181); await assert.rejects(f.ledger.checkpoint(id), { code: 'TASK_BUDGET' });
});

test('approval is exact, expiring, one-shot and invalidated by changed profile policy', async t => {
  const f = await fixture(t), id = await f.task(); await f.ledger.start(id);
  const action = { kind: 'delete', tool: 'synthetic_delete', arguments: { path: 'own-synthetic.txt' } };
  const approval = await f.ledger.requestApproval(id, action);
  await assert.rejects(f.ledger.decide(id, approval.id, 'always', approval.hash), { code: 'APPROVAL_CHANGED' });
  await assert.rejects(f.ledger.decide(id, approval.id, 'once', 'wrong'), { code: 'APPROVAL_CHANGED' });
  await f.ledger.decide(id, approval.id, 'once', approval.hash);
  await assert.rejects(f.ledger.decide(id, approval.id, 'once', approval.hash), { code: 'APPROVAL_EXPIRED' });
  await f.ledger.resume(id); await f.ledger.start(id); let calls = 0;
  await assert.rejects(f.ledger.executeApproved(id, approval.id, { ...action, arguments: { path: 'different.txt' } }, () => ++calls), { code: 'APPROVAL_NOT_VALID' });
  await f.ledger.executeApproved(id, approval.id, action, async identity => { assert.equal(identity.profileId, f.profile.id);assert.deepEqual(identity.action,action);identity.action.arguments.path='mutated-after-dispatch.txt';calls++; });
  assert.equal((await f.ledger.get(id)).approvals[0].action.arguments.path,'own-synthetic.txt');
  await assert.rejects(f.ledger.executeApproved(id, approval.id, action, () => ++calls), { code: 'APPROVAL_NOT_VALID' }); assert.equal(calls, 1);
  const next = await f.ledger.requestApproval(id, action, { ttlMs: 1000 }); f.tick(1001);
  await assert.rejects(f.ledger.decide(id, next.id, 'once', next.hash), { code: 'APPROVAL_EXPIRED' });
  f.profile.policyRevision++;
  await assert.rejects(f.ledger.decide(id, next.id, 'once', next.hash), { code: 'TASK_POLICY_CHANGED' }); assert.equal(await f.ledger.authorizeProvider(id), false);
});

test('uncertain external outcomes pause and cannot replay a consumed approval after recovery', async t => {
  const f = await fixture(t), id = await f.task(); await f.ledger.start(id);
  const action = { kind: 'publish', tool: 'synthetic_publish', arguments: { title: 'Fixture only' } };
  const approval = await f.ledger.requestApproval(id, action); await f.ledger.decide(id, approval.id, 'once', approval.hash); await f.ledger.resume(id); await f.ledger.start(id);
  let calls = 0;
  await assert.rejects(f.ledger.executeApproved(id, approval.id, action, () => { calls++; throw new Error('Synthetic lost result'); }), { code: 'TASK_ACTION_UNCERTAIN' });
  await f.reopen(); const task = await f.ledger.get(id); assert.equal(task.actions[0].state, 'unknown'); assert.equal(calls, 1);
  await assert.rejects(f.ledger.resume(id), { code: 'TASK_RECONCILE' });
  await f.ledger.reconcile(id, task.actions[0].id, 'complete'); await f.ledger.resume(id); await f.ledger.start(id);
  await assert.rejects(f.ledger.executeApproved(id, approval.id, action, () => ++calls), { code: 'APPROVAL_NOT_VALID' }); assert.equal(calls, 1);
  await f.ledger.finish(id); assert.equal((await f.ledger.get(id)).phase, 'complete');
});
