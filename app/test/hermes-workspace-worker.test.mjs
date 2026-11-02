import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createProfileStore } from '../lib/profile-store.mjs';
import { prepareHermesWorkspace } from '../lib/hermes-memory.mjs';
import { HermesWorkspaceClient, startHermesWorkspaceWorker } from '../lib/hermes-workspace-worker.mjs';
import { createChatGPTPlanBroker } from '../lib/chatgpt-plan-broker.mjs';
import { createHermesWorkspace } from '../lib/hermes-workspace.mjs';

function transport(t) {
  const input = new PassThrough(), output = new PassThrough();
  const client = new HermesWorkspaceClient({ input, output, requestTimeoutMs: 5000 });
  const calls = []; input.on('data', value => calls.push(JSON.parse(String(value))));
  const emit = value => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  t.after(() => client.close());
  return { client, calls, emit, raw: value => output.write(value) };
}

test('full Hermes transport keeps native tool events and exact offered approval choices', async t => {
  const { client, calls, emit } = transport(t);
  const pending = client.request('session.create', {});
  assert.equal(calls[0].params.source, 'tui'); assert.equal(calls[0].params.profile, 'default');
  emit({ id: calls[0].id, result: { session_id: 'private_owner_session', stored_session_id: 'owner_stored_session' } });
  await pending;
  const start = once(client, 'event');
  emit({ method: 'event', params: { type: 'message.start', session_id: 'private_owner_session' } });
  assert.deepEqual((await start)[0].payload, {});
  const event = once(client, 'event');
  emit({ method: 'event', params: { type: 'subagent.start', session_id: 'private_owner_session', payload: { child_session_id: 'child1', goal: 'Synthetic task' } } });
  assert.equal((await event)[0].type, 'subagent.start');
  const question = once(client, 'request');
  emit({ id: 'srq-synthetic', method: 'approval', params: { session_id: 'private_owner_session', command: 'synthetic-command', choices: ['once', 'session', 'deny'] } });
  assert.equal((await question)[0].method, 'approval');
  assert.throws(() => client.answer('srq-synthetic', { choice: 'always' }));
  client.answer('srq-synthetic', { choice: 'session' });
  assert.equal(calls.at(-1).result.choice, 'session');
  assert.throws(() => client.answer('srq-synthetic', { choice: 'once' }), /expired/);
  await assert.rejects(client.request('shell.exec', { command: 'echo unsafe-direct-method' }));
  await assert.rejects(client.request('session.create', { profile: 'another-person' }));
  await assert.rejects(client.request('skills.manage', { action: 'install', name: 'unrequested' }));
});

test('full Hermes transport rejects wrong-session questions and clears native cancellations', async t => {
  const { client, calls, emit } = transport(t);
  emit({ id: 'srq-foreign', method: 'secret', params: { session_id: 'foreign', env_var: 'SYNTHETIC_KEY', prompt: 'Synthetic prompt' } });
  assert.equal(calls.at(-1).error.code, -32601); assert.equal(client.questions.size, 0);
  const created = client.request('session.create');
  emit({ id: calls.at(-1).id, result: { session_id: 'own' } }); await created;
  emit({ id: 'srq-own', method: 'secret', params: { session_id: 'own', env_var: 'SYNTHETIC_KEY', prompt: 'Synthetic prompt' } });
  assert.equal(client.questions.size, 1);
  emit({ method: 'event', params: { type: 'request.cancel', payload: { id: 'srq-own' } } });
  assert.equal(client.questions.size, 0); assert.throws(() => client.answer('srq-own', { value: 'late' }));
});

test('invalid or oversized native frames close the transport and reject pending work without retry', async t => {
  for (const [name, frame] of [['invalid JSON', 'not-json\n'], ['invalid protocol', '{"jsonrpc":"1.0","method":"event"}\n'], ['oversized frame', 'x'.repeat(17_000_000)]]) {
    await t.test(name, async t => {
      const { client, calls, raw } = transport(t), pending = client.request('ping');
      const rejected = assert.rejects(pending, /unavailable/);
      raw(frame); await rejected;
      assert.equal(client.closed, true); assert.equal(client.pending.size, 0);
      assert.equal(client.questions.size, 0); assert.equal(client.sessions.size, 0);
      await assert.rejects(client.request('ping'), /unavailable/);
      assert.equal(calls.length, 1, 'uncertain native requests must never be repeated');
    });
  }
});

test('a timed-out native request is not repeated and its late response cannot settle the next request', async t => {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  input.on('data', value => calls.push(JSON.parse(String(value))));
  const client = new HermesWorkspaceClient({ input, output, requestTimeoutMs: 5 });
  t.after(() => client.close());
  await assert.rejects(client.request('ping'), /did not answer in time/);
  assert.equal(calls.length, 1); assert.equal(client.pending.size, 0);
  const next = client.request('ping');
  output.write(JSON.stringify({ jsonrpc: '2.0', id: calls[0].id, result: { unexpected: 'late' } }) + '\n');
  assert.equal(client.pending.size, 1, 'late result belongs only to the expired request');
  output.write(JSON.stringify({ jsonrpc: '2.0', id: calls[1].id, result: { pong: true } }) + '\n');
  assert.deepEqual(await next, { pong: true }); assert.equal(calls.length, 2);
});

test('full Hermes worker rejects children, members and foreign memory homes before spawning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = await createProfileStore({ dataDir: root }); const owner = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: owner.id, profileDataDir: profiles.directory(owner.id) });
  let spawns = 0;
  const options = { dataDir: root, profile: owner, home, pythonPath: resolve('synthetic-python.exe'), sourceRoot: resolve('vendor/hermes-source'), brokerUrl: 'http://127.0.0.1:12345/v1', brokerGrant: 'a'.repeat(64), model: 'synthetic-model', spawn() { spawns++; throw new Error('Unexpected spawn'); } };
  await assert.rejects(startHermesWorkspaceWorker({ ...options, profile: { ...owner, childMode: true } }), /host owner/);
  await assert.rejects(startHermesWorkspaceWorker({ ...options, profile: { ...owner, role: 'member' } }), /host owner/);
  await assert.rejects(startHermesWorkspaceWorker({ ...options, home: root }), /does not belong/);
  assert.equal(spawns, 0);
});

test('failed or cancelled native launch removes only its generated recovery policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-policy-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
  const config = await readFile(join(home, 'config.yaml'), 'utf8');
  const options = { profile, dataDir: root, home, pythonPath: resolve('synthetic-python.exe'), sourceRoot: resolve('synthetic-source'),
    model: 'synthetic', brokerUrl: 'http://127.0.0.1:12345/v1', brokerGrant: 'c'.repeat(64), verifyRuntime: async () => ({ supported: true }) };
  let policy;
  await assert.rejects(startHermesWorkspaceWorker({ ...options, spawn(_python, _args, settings) {
    policy = settings.env.HERMES_MANAGED_DIR; throw new Error('Synthetic synchronous spawn failure');
  } }), /unavailable/);
  assert.ok(policy); assert.equal(existsSync(policy), false);
  assert.deepEqual(await readdir(join(home, 'scratch')), []);
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(startHermesWorkspaceWorker({ ...options, signal: aborter.signal }), /cancelled/);
  assert.deepEqual(await readdir(join(home, 'scratch')), []);
  assert.equal(await readFile(join(home, 'config.yaml'), 'utf8'), config);
});

test('owner worker stop remains uncertain until child closure is confirmed and can be retried', { timeout: 12_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-stop-'));
  const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return false; } });
  child.stdin.on('data', raw => {
    const frame = JSON.parse(String(raw));
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }) + '\n');
  });
  t.after(async () => { child.emit('close', 0); await rm(root, { recursive: true, force: true }); });
  const worker = await startHermesWorkspaceWorker({ profile, dataDir: root, home, pythonPath: resolve('synthetic-python.exe'), sourceRoot: resolve('synthetic-source'), model: 'synthetic', brokerUrl: 'http://127.0.0.1:12345/v1', brokerGrant: 'c'.repeat(64), verifyRuntime: async () => ({ supported: true }), spawn() {
    process.nextTick(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'synthetic-stop' } } }) + '\n'));
    return child;
  } });
  await assert.rejects(worker.close(), /could not confirm/);
  child.emit('close', 0);
  await worker.close();
});

test('workspace startup cancellation retains an uncertain-stop fence and a cleanup retry', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-start-stop-'));
  const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
  const child = new EventEmitter(), aborter = new AbortController();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return false; } });
  t.after(async () => { child.emit('close', 0); await rm(root, { recursive: true, force: true }); });
  let failure;
  await assert.rejects(startHermesWorkspaceWorker({ profile, dataDir: root, home, pythonPath: resolve('synthetic-python.exe'), sourceRoot: resolve('synthetic-source'), model: 'synthetic', brokerUrl: 'http://127.0.0.1:12345/v1', brokerGrant: 'c'.repeat(64), signal: aborter.signal, verifyRuntime: async () => ({ supported: true }), spawn() { process.nextTick(() => aborter.abort()); return child; } }), error => {
    failure = error; return error.stopUnconfirmed === true && typeof error.close === 'function';
  });
  child.emit('close', 0); await failure.close();
});

const runtime = resolve('.work/desktop-runtime');
const python = join(runtime, 'hermes/python/python.exe'), source = join(runtime, 'hermes/source');

test('Windows owner job terminates its known descendant after a forced worker exit', { skip: process.platform !== 'win32' || !existsSync(python), timeout: 15_000 }, async t => {
  const helper = fileURLToPath(new URL('../lib/hermes_workspace_worker.py', import.meta.url));
  const script = `import runpy, subprocess, sys, json, time; m=runpy.run_path(${JSON.stringify(helper)}); m['install_owner_process_boundary'](); child=subprocess.Popen([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(60)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print(json.dumps({'childPid':child.pid}),flush=True); time.sleep(60)`;
  const worker = spawn(python, ['-I', '-B', '-c', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let childPid;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  t.after(() => { worker.kill(); if (childPid && alive(childPid)) process.kill(childPid); });
  worker.stderr.resume();
  const first = await Promise.race([once(worker.stdout, 'data'), once(worker, 'exit').then(() => { throw new Error('Owner job startup failed.'); })]);
  childPid = JSON.parse(String(first[0]).trim()).childPid;
  assert.ok(Number.isInteger(childPid) && childPid > 0 && alive(childPid));
  const stopped = once(worker, 'close'); worker.kill(); await stopped;
  const deadline = Date.now() + 2000;
  while (alive(childPid) && Date.now() < deadline) await pause(25);
  assert.equal(alive(childPid), false, 'Windows must terminate the inherited child without an orphan');
});

test('actual unchanged Hermes gateway exposes native skills and tools in the owner memory workspace', { skip: !existsSync(python), timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-runtime-'));
  let worker, server;
  t.after(async () => {
    await worker?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
  const originalConfig = await readFile(join(home, 'config.yaml'), 'utf8');
  server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic-workspace-model', object: 'model' }] })); return; }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  worker = await startHermesWorkspaceWorker({ profile, dataDir: root, pythonPath: python, sourceRoot: source, home, brokerUrl: `http://127.0.0.1:${server.address().port}/v1`, brokerGrant: 'b'.repeat(64), model: 'synthetic-workspace-model' });
  assert.equal(worker.readiness.upstream, true);
  const listing = await worker.client.request('tools.list');
  const nativeNames = listing.toolsets.flatMap(row => row.tools || []);
  for (const name of ['skills_list', 'skill_view', 'skill_manage', 'terminal', 'delegate_task', 'memory']) assert.ok(nativeNames.includes(name), name);
  const skills = await worker.client.request('skills.manage', { action: 'list' });
  assert.ok(Object.values(skills.skills || {}).flat().length > 0, 'stock Hermes seeded its own bundled skills');
  assert.equal(await readFile(join(home, 'config.yaml'), 'utf8'), originalConfig, 'worker must not overwrite managed Hermes configuration');
});

test('actual Hermes Stop and forced exit reopen saved conversations without replaying interrupted turns', { skip: !existsSync(python), timeout: 120_000 }, async t => {
  for (const mode of ['Stop', 'forced exit']) await t.test(mode, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-no-replay-'));
    let service, child, rpc, created, resumed, releaseBlocked;
    let calls = 0, toolCompleted = false;
    const reachedBlocked = new Promise(done => { releaseBlocked = done; });
    const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
    const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
    // An owner's existing setting must remain unchanged, while Nemo's launch
    // policy prevents upstream crash recovery from resubmitting an action.
    const config = (await readFile(join(home, 'config.yaml'), 'utf8')) + '\ndesktop:\n  auto_continue:\n    enabled: true\nonboarding:\n  seen:\n    profile_build_offered: true\n';
    await writeFile(join(home, 'config.yaml'), config);
    const response = output => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-stopped-turn', status: 'completed', output, usage: {} } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    service = await createHermesWorkspace({ dataDir: root, profileId: profile.id, getProfile: id => profiles.profile(id),
      pythonPath: python, sourceRoot: source, chatgptSession: async () => ({ provider: 'chatgpt', accessToken: 'synthetic-stop-subscription', model: 'synthetic-workspace-model' }),
      createBroker: options => createChatGPTPlanBroker({ ...options, fetchImpl: async (_url, options) => {
        calls++;
        if (calls === 1) return response([{ type: 'function_call', namespace: 'nemo', name: 'terminal', call_id: 'synthetic_stop_once', arguments: JSON.stringify({ command: 'echo SYNTHETIC_STOP_TOOL_ONCE' }) }]);
        const body = JSON.parse(options.body), previous = body.input.filter(row => row.type === 'function_call_output').at(-1);
        if (calls === 2) {
          toolCompleted = JSON.stringify(previous).includes('SYNTHETIC_STOP_TOOL_ONCE');
          releaseBlocked();
          return await new Promise((resolveResponse, reject) => {
            const abort = () => reject(new Error('Synthetic in-flight response stopped'));
            if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
          });
        }
        const title = JSON.stringify(body.input.filter(row => row.type === 'message' && row.role === 'developer')).includes('You name chat sessions.');
        if (title) assert.equal(body.tools, undefined, 'native title generation cannot run a tool action');
        return response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: title ? '{"title":"Synthetic stopped task"}' : 'SYNTHETIC_UNEXPECTED_REPLAY' }] }]);
      } }),
      startWorker: async options => {
        const worker = await startHermesWorkspaceWorker({ ...options, spawn(...args) { child = spawn(...args); return child; } });
        rpc = worker.client;
        const request = rpc.request.bind(rpc);
        rpc.request = async (method, params) => {
          const result = await request(method, params);
          if (method === 'session.create') created = result;
          if (method === 'session.resume') resumed = result;
          return result;
        };
        return worker;
      },
    });
    t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
    await service.start();
    await service.prompt({ message: 'Run the harmless terminal check exactly once, then wait for a reply.' });
    let timeout;
    try { await Promise.race([reachedBlocked, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The actual native tool did not reach its blocked synthetic response.')), 35_000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(toolCompleted, true, 'the real native terminal action completed before interruption');
    const stored = created.stored_session_id || created.session_id, markerPath = join(home, 'desktop', 'interrupted_turns.json');
    assert.equal(JSON.parse(await readFile(markerPath, 'utf8'))[stored].prompt.includes('harmless terminal'), true, 'a real active turn created its durable recovery marker');
    if (mode === 'forced exit') {
      const stopped = once(child, 'close'); child.kill(); await stopped;
      const deadline = Date.now() + 8000;
      while (service.isBusy() && Date.now() < deadline) await pause(20);
      assert.equal(service.isBusy(), false, 'the owned process has actually stopped');
      assert.ok(JSON.parse(await readFile(markerPath, 'utf8'))[stored], 'forced process death leaves the real upstream crash marker');
    } else {
      await service.stop();
      const markers = await readFile(markerPath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
      assert.equal(markers[stored], undefined, 'native interrupt retires the marker before transport teardown');
    }
    const stoppedCalls = calls;
    const reopened = await service.start();
    assert.equal(reopened.phase, 'ready'); assert.ok(resumed, 'the native gateway resumed the saved conversation');
    assert.equal(resumed.auto_continue, undefined, 'resume must not schedule a synthetic or real action automatically');
    await rpc.request('session.status', { session_id: resumed.session_id });
    assert.equal(calls, stoppedCalls, 'reopening must issue no new inference request or repeated tool task');
    assert.equal(await readFile(join(home, 'config.yaml'), 'utf8'), config, 'launch policy must preserve owner configuration');
  });
});

test('actual unchanged Hermes executes skills, terminal and a subagent through the ChatGPT broker', { skip: !existsSync(python), timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-workspace-execution-'));
  let worker, broker;
  t.after(async () => { await worker?.close(); await broker?.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  const profiles = await createProfileStore({ dataDir: root }), profile = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: profiles.directory(profile.id) });
  let step = 0, childRequests = 0;
  const completedTools = [], visibleEvents = [], seenOutputs = new Set();
  const response = output => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-native-workspace', status: 'completed', output, usage: {} } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const answer = text => response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
  broker = await createChatGPTPlanBroker({ session: { provider: 'chatgpt', accessToken: 'synthetic-workspace-subscription', model: 'synthetic-workspace-model' }, nativeTools: true, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    const users = body.input.filter(row => row.type === 'message' && row.role === 'user').map(row => row.content?.map(part => part.text || '').join('') || '');
    if (users.at(-1)?.startsWith('SYNTHETIC_CHILD_GOAL')) { childRequests++; return answer('SYNTHETIC_CHILD_DONE'); }
    const previous = body.input.filter(row => row.type === 'function_call_output').at(-1);
    if (previous && !seenOutputs.has(previous.call_id)) {
      seenOutputs.add(previous.call_id);
      const raw = typeof previous.output === 'string' ? previous.output : JSON.stringify(previous.output);
      completedTools.push({ step: step - 1, raw });
      if (step === 1) assert.match(raw, /systematic-debugging/);
      if (step === 2) assert.match(raw, /success/);
      if (step === 3) assert.match(raw, /SYNTHETIC_NATIVE_TERMINAL_OK/);
      if (step === 4) assert.match(raw, /"status"\s*:\s*"dispatched"/);
    }
    const actions = [
      ['skills_list', {}],
      ['skill_view', { name: 'software-development/systematic-debugging' }],
      ['terminal', { command: 'echo SYNTHETIC_NATIVE_TERMINAL_OK' }],
      ['delegate_task', { tasks: [{ goal: 'SYNTHETIC_CHILD_GOAL: Reply SYNTHETIC_CHILD_DONE without using tools.' }], max_iterations: 3 }],
    ];
    if (step >= actions.length) return answer('SYNTHETIC_WORKSPACE_ALL_DONE');
    const [name, args] = actions[step++];
    const allowed = body.tools?.flatMap(namespace => namespace.tools || []).map(tool => tool.name) || [];
    assert.ok(allowed.includes(name), name + ' must be offered by unchanged Hermes');
    return response([{ type: 'function_call', namespace: 'nemo', name, call_id: 'synthetic_upstream_' + step, arguments: JSON.stringify(args) }]);
  } });
  worker = await startHermesWorkspaceWorker({ profile, dataDir: root, pythonPath: python, sourceRoot: source, home, brokerUrl: broker.baseUrl, brokerGrant: broker.capability, model: broker.model });
  const created = await worker.client.request('session.create', { close_on_disconnect: true });
  let completions = 0;
  const done = new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic native tool execution did not finish (step ${step}, child requests ${childRequests}, events ${visibleEvents.map(event => event.type).join(',')}).`)), 85_000);
    worker.client.once('disconnected', () => { clearTimeout(timer); reject(new Error('Synthetic native Hermes disconnected before completion.')); });
    worker.client.on('event', event => {
      visibleEvents.push(event);
      if (event.type === 'error') { clearTimeout(timer); reject(new Error('Hermes reported a native tool execution error.')); }
      if (event.type === 'message.complete' && event.session_id === created.session_id && event.payload.text?.includes('SYNTHETIC_WORKSPACE_ALL_DONE')) {
        completions++;
        // Top-level delegation is deliberately asynchronous in this pinned
        // Hermes. Its native completion re-enters the parent after that first
        // turn; wait for the second parent completion, keeping this behavior.
        if (completions >= 2 && childRequests > 0) { clearTimeout(timer); resolveDone(); }
      }
    });
  });
  done.catch(() => {});
  await worker.client.request('prompt.submit', { session_id: created.session_id, text: 'Run the synthetic native tool integration checks.' });
  await done;
  assert.equal(step, 4); assert.equal(completedTools.length, 4); assert.equal(childRequests, 1, completedTools.find(item => item.step === 3)?.raw.slice(0, 3000));
  assert.ok(visibleEvents.some(event => event.type === 'tool.start' && event.payload.name === 'terminal'));
  const shown = await worker.client.request('tools.show', { session_id: created.session_id });
  const available = shown.sections.flatMap(section => section.tools.map(tool => tool.name));
  for (const name of ['skills_list', 'skill_view', 'terminal', 'delegate_task']) assert.ok(available.includes(name), name);
  // Browser/computer entries are whatever the upstream dependency checks admit;
  // unlike tools.list, this is a real available-tool snapshot for this session.
  assert.ok(shown.total === available.length);
  t.diagnostic(`Native dependency gates: browser=${available.includes('browser_navigate')}, computer=${available.includes('computer_use')}. This reports actual availability, not an installed-tool claim.`);
});
