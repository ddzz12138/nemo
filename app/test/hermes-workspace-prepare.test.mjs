import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createProfileStore } from '../lib/profile-store.mjs';
import { prepareHermesWorkspace } from '../lib/hermes-memory.mjs';
import { prepareHermesWorkspaceTools } from '../lib/hermes-workspace-prepare.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nemo-hermes-prepare-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = await createProfileStore({ dataDir }), profile = await store.owner();
  const home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: store.directory(profile.id) });
  return { profile, dataDir, home, pythonPath: resolve('synthetic-python.exe'), sourceRoot: resolve('vendor/hermes-source'), verifyRuntime: async () => ({ supported: true }) };
}

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { process.nextTick(() => child.emit('close', 1)); return true; } });
  return child;
}

test('preparing full Hermes tools requires the active host owner and their canonical home', async t => {
  const options = await setup(t); let called = false;
  const spawn = () => { called = true; throw new Error('Unexpected spawn'); };
  for (const profile of [{ ...options.profile, childMode: true }, { ...options.profile, role: 'member' }, { ...options.profile, disabled: true }]) await assert.rejects(prepareHermesWorkspaceTools({ ...options, profile, spawn }), /host owner/);
  await assert.rejects(prepareHermesWorkspaceTools({ ...options, home: options.dataDir, spawn }), /does not belong/);
  await assert.rejects(prepareHermesWorkspaceTools({ ...options, verifyRuntime: async () => ({ supported: false }), spawn }), /compatibility/);
  assert.equal(called, false);
});

test('tool preparation preserves stock package identities and exposes only safe progress and real readiness', async t => {
  const options = await setup(t), child = fakeChild(), progress = [];
  const configBefore = await readFile(join(options.home, 'config.yaml'), 'utf8');
  const result = await prepareHermesWorkspaceTools({ ...options, onProgress: row => progress.push(row), environment: { PATH: 'synthetic-path', OPENAI_API_KEY: 'NEVER_INHERIT', HERMES_RUNTIME_DIR: 'foreign-store', HERMES_HOME: 'foreign-home' }, spawn(command, args, launch) {
    assert.equal(command, options.pythonPath); assert.equal(launch.env.HERMES_HOME, toNamespacedPath(options.home));
    assert.equal(launch.env.OPENAI_API_KEY, undefined); assert.equal(launch.env.HERMES_RUNTIME_DIR, undefined);
    assert.equal(launch.shell, false); assert.equal(launch.windowsHide, true);
    assert.match(args.at(-1), /install_owner_process_boundary/); assert.match(args.at(-1), /hermes_workspace_prepare/);
    process.nextTick(() => {
      child.stdout.write(JSON.stringify({ type: 'progress', package: 'chromium', stage: 'download', done: 12, total: 100, label: 'PRIVATE_DOWNLOAD_URL', path: 'PRIVATE_PATH' }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'result', browser: true, computer: false }) + '\n');
      child.emit('close', 0);
    });
    return child;
  } });
  assert.deepEqual(progress, [{ package: 'chromium', stage: 'download', done: 12, total: 100 }]);
  assert.equal(result.ok, false); assert.equal(result.tools.browser.available, true); assert.equal(result.tools.computer.available, false);
  assert.equal(await readFile(join(options.home, 'config.yaml'), 'utf8'), configBefore);
});

test('invalid preparation output cancels its owned child and cannot become successful readiness', async t => {
  const ready = JSON.stringify({ type: 'result', browser: true, computer: true }) + '\n';
  for (const [name, frame] of [['malformed output', 'not-json\n'], ['duplicate result', ready + ready], ['oversized output', 'x'.repeat(70_000)]]) {
    await t.test(name, async t => {
      const options = await setup(t), child = fakeChild(), writes = [];
      let closed = false;
      child.stdin.on('data', chunk => {
        writes.push(String(chunk));
        setImmediate(() => { closed = true; child.emit('close', 1); });
      });
      const pending = prepareHermesWorkspaceTools({ ...options, spawn() {
        process.nextTick(() => child.stdout.write(frame)); return child;
      } });
      await assert.rejects(pending, /could not prepare/);
      assert.equal(closed, true, 'failure must wait for the owned process to close');
      assert.deepEqual(writes, ['{"cancel":true}\n']);
    });
  }
});

test('tool preparation cancellation sends native pause then confirms owned process closure', { timeout: 5000 }, async t => {
  const options = await setup(t), child = fakeChild(), aborter = new AbortController(), writes = [];
  child.stdin.on('data', row => writes.push(String(row)));
  const pending = prepareHermesWorkspaceTools({ ...options, signal: aborter.signal, spawn() { process.nextTick(() => aborter.abort()); return child; } });
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(writes, ['{"cancel":true}\n']);
});

test('tool preparation cannot report a successful stop without actual child close', { timeout: 5000 }, async t => {
  const options = await setup(t), child = fakeChild(), aborter = new AbortController();
  child.kill = () => false;
  const pending = prepareHermesWorkspaceTools({ ...options, signal: aborter.signal, spawn() { process.nextTick(() => aborter.abort()); return child; } });
  await assert.rejects(pending, error => error.stopUnconfirmed === true && /could not confirm/.test(error.message));
});

test('pinned upstream Windows packages retain checksum-bound artifacts and native implementations', async () => {
  const lock = JSON.parse(await readFile(resolve('vendor/hermes-source/pm/lock.json'), 'utf8'));
  for (const name of ['chromium', 'agent-browser', 'cua-driver']) {
    const row = lock.packages[name], artifact = row.artifacts['win32-x64'] || row.artifacts.any;
    assert.ok(row.version); assert.match(artifact.sha256, /^[a-f0-9]{64}$/); assert.match(artifact.url, /^https:\/\//);
  }
  assert.match(lock.packages['cua-driver'].artifacts['win32-x64'].url, /windows-x86_64/);
});

const runtime = resolve('.work/desktop-runtime'), python = join(runtime, 'hermes/python/python.exe'), source = join(runtime, 'hermes/source');
test('actual pinned PM graph prepares only the three fixed native packages with explicit consent', { skip: !existsSync(python), timeout: 15_000 }, async t => {
  const options = await setup(t), helper = fileURLToPath(new URL('../lib/hermes_workspace_prepare.py', import.meta.url));
  const script = `import sys,runpy,json,threading,types;sys.path.insert(0,${JSON.stringify(source)});import hermes_bootstrap;m=runpy.run_path(${JSON.stringify(helper)});calls=[];events=[];fake=types.SimpleNamespace(ensure=lambda name,**kw:(calls.append({'name':name,'explicit':kw.get('explicit'),'pause':isinstance(kw.get('pause_event'),threading.Event)}),kw['progress']('verify',0,0,'PRIVATE_LABEL')));m['prepare_packages'](fake,events.append,threading.Event());print(json.dumps({'calls':calls,'events':events}))`;
  const env = { HERMES_HOME: options.home, HOME: options.home, USERPROFILE: options.home, LOCALAPPDATA: join(options.home, 'localappdata'), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
  const child = spawn(python, ['-I', '-B', '-c', script], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', row => { output += row; }); child.stderr.on('data', row => { errors += row; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, errors);
  const result = JSON.parse(output.trim());
  assert.deepEqual(result.calls, ['chromium', 'agent-browser', 'cua-driver'].map(name => ({ name, explicit: true, pause: true })));
  assert.equal(result.events.length, 9); assert.equal(JSON.stringify(result.events).includes('PRIVATE_LABEL'), false);
});
