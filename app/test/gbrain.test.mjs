import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GbrainError, createConfiguredGbrainClient, createGbrainClient } from '../lib/gbrain.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const BUN = process.env.NEMO_TEST_BUN || "";
const SOURCE = process.env.NEMO_TEST_GBRAIN_SOURCE || "";
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OTHER_REQUEST = '22222222-2222-4222-8222-222222222222';

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    let body = '';
    stdin.write = chunk => { body += String(chunk); return true; };
    stdin.end = chunk => {
      if (chunk) body += String(chunk);
      const call = { command, args: [...args], options, input: body, child };
      calls.push(call);
      queueMicrotask(() => {
        if (child.killed) return;
        let result = {};
        try { result = handler(JSON.parse(body), call) || {}; }
        catch (error) { child.emit('error', error); return; }
        if (result.hang) return;
        if (result.stdout) stdout.emit('data', result.stdout);
        if (result.stderr) stderr.emit('data', result.stderr);
        child.emit('close', result.exitCode ?? 0);
      });
    };
    stdout.setEncoding = () => stdout;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.emit('close', null);
    };
    return child;
  };
  return { spawn, calls };
}

async function makeHome() {
  const root = await mkdtemp(join(here, '.tmp-gbrain-'));
  const dataDir = resolve(root, 'home');
  const sourceRoot = resolve(root, 'source');
  const runtimePath = resolve(root, 'bun.exe');
  await mkdir(join(dataDir, '.gbrain'), { recursive: true });
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await writeFile(runtimePath, '');
  await writeFile(join(sourceRoot, 'src', 'cli.ts'), 'export {}\n');
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  const databasePath = resolve(dataDir, '.gbrain', 'brain.pglite');
  await writeFile(join(dataDir, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_disabled: true,
    database_path: databasePath,
    memory: { auto_writeback: 'off' },
  }));
  return { root, dataDir, sourceRoot, runtimePath, databasePath };
}

async function removeHome(root) {
  if (!root) return;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function clientFor(home, handler, timeoutMs = 1000) {
  const fake = fakeSpawn(handler);
  const client = createGbrainClient({ ...home, spawn: fake.spawn, timeoutMs });
  return { client, calls: fake.calls };
}

function argsOf(call) {
  return JSON.parse(call.input).args;
}

function fixedArgv(call, forbidden = []) {
  assert.deepEqual(call.args.slice(0, 2), ['--no-env-file', '--eval']);
  assert.equal(call.args.length, 3);
  assert.equal(call.options.shell, false);
  assert.equal(call.command.endsWith('bun.exe') || call.command.endsWith('bun'), true);
  const visible = JSON.stringify({ args: call.args, shell: call.options.shell, envKeys: Object.keys(call.options.env) });
  for (const secret of forbidden) assert.equal(visible.includes(secret), false);
}

function runSetup(dataDir, extra = []) {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('../scripts/setup-gbrain.ps1', import.meta.url));
  return new Promise((resolvePromise, reject) => {
    const child = realSpawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra, '-DataDir', dataDir], {
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

test('rejects relative paths, parent segments, and a non-bun runtime', () => {
  const absolute = 'C:\\gbrain-runtime\\home';
  for (const input of [
    { runtimePath: 'bun.exe', sourceRoot: absolute, dataDir: absolute },
    { runtimePath: join(absolute, 'bun.exe'), sourceRoot: `${absolute}\\..\\src`, dataDir: absolute },
    { runtimePath: join(absolute, 'node.exe'), sourceRoot: absolute, dataDir: absolute },
  ]) {
    assert.throws(() => createGbrainClient(input), error => {
      assert.ok(error instanceof GbrainError);
      assert.equal(error.code, 'GBRAIN_CONFIG');
      assert.equal(error.message.includes(absolute), false);
      assert.equal(error.message.includes('..'), false);
      return true;
    });
  }
});

test('keeps user text out of the process argv and strips provider secrets', async () => {
  const home = await makeHome();
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-sentinel-secret';
  const evil = '$(calc) && del C:\\Windows "quoted" `whoami`';
  try {
    const { client, calls } = clientFor(home, payload => {
      const args = payload.args;
      if (args[0] === 'put') return { stdout: JSON.stringify({ state: 'committed' }) };
      if (args[0] === 'get') return { stdout: JSON.stringify({ slug: args[1], title: 'Safe', revision: 'rev-1', content: 'body' }) };
      if (args[0] === 'search') return { stdout: JSON.stringify([{ slug: 'nemo-notes/safe', title: 'Safe', chunk_text: 'body' }]) };
      return { stdout: 'null', exitCode: 1 };
    });
    await client.save({ slug: 'nemo-notes/safe', title: 'Safe title', content: evil, requestId: REQUEST });
    await client.search({ query: `${evil} xylophone` });
    assert.ok(calls.length >= 2);
    for (const call of calls) fixedArgv(call, [evil, 'sk-sentinel-secret', 'OPENAI_API_KEY']);
    assert.equal(callEnv(calls[0], 'OPENAI_API_KEY'), undefined);
    assert.equal(JSON.stringify(calls[0].options.env).includes('sk-sentinel-secret'), false);
    assert.equal(argsOf(calls[0]).some(arg => arg.includes(evil)), true);
    assert.equal(calls.every(call => call.options.shell === false), true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await removeHome(home.root);
  }
});

function callEnv(call, name) {
  return call.options.env[name];
}

test('disconnected config stays disconnected and does not echo the file', async () => {
  const home = await makeHome();
  const nemo = resolve(home.root, 'nemo');
  await mkdir(nemo, { recursive: true });
  const secret = 'sk-sentinel-secret';
  const leak = 'SENTINEL_PRIVATE_PATH';
  try {
    const missing = await createConfiguredGbrainClient({ nemoDataDir: nemo, command: 'calc.exe', query: secret });
    assert.equal((await missing.status()).connected, false);
    assert.equal((await missing.status()).automaticCapture, false);
    assert.equal((await missing.status()).paidProcessing, false);
    await assert.rejects(() => missing.search({ query: 'notes' }), error => error instanceof GbrainError && error.code === 'GBRAIN_NOT_CONNECTED' && !error.message.includes(secret) && !error.message.includes('calc'));

    await writeFile(join(nemo, 'gbrain-runtime.json'), `{ "runtimePath": "${leak}", "token": "${secret}"`);
    const broken = await createConfiguredGbrainClient({ nemoDataDir: nemo });
    await assert.rejects(() => broken.list(), error => error instanceof GbrainError && error.code === 'GBRAIN_NOT_CONNECTED' && !error.message.includes(secret) && !error.message.includes(leak));

    await writeFile(join(nemo, 'gbrain-runtime.json'), JSON.stringify({
      runtimePath: home.runtimePath, sourceRoot: home.sourceRoot, dataDir: home.dataDir, command: 'calc.exe',
    }));
    const extra = await createConfiguredGbrainClient({ nemoDataDir: nemo });
    assert.equal((await extra.status()).connected, false);
    assert.equal((await extra.status()).reason, 'not_configured');
  } finally {
    await removeHome(home.root);
  }
});

test('sanitizes config, filesystem, and upstream failures', async () => {
  const home = await makeHome();
  const secret = 'sk-sentinel-secret';
  const leak = 'SENTINEL_PRIVATE_PATH';
  try {
    await writeFile(join(home.dataDir, '.gbrain', 'config.json'), `{ "openai_api_key": "${secret}", "database_path": "${leak}"`);
    const broken = createGbrainClient(home);
    await assert.rejects(() => broken.list(), error => error instanceof GbrainError && error.code === 'GBRAIN_NOT_CONNECTED' && !error.message.includes(secret) && !error.message.includes(leak) && error.code !== 'ENOENT');

    await writeFile(join(home.dataDir, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', embedding_disabled: true, database_path: home.databasePath, memory: { auto_writeback: 'off' },
    }));
    const throwing = createGbrainClient({
      ...home,
      spawn() { throw new Error(`spawn ${leak} ${secret} SELECT secret FROM pages`); },
    });
    await assert.rejects(() => throwing.get('nemo-notes/a'), error => error instanceof GbrainError && !error.message.includes(secret) && !error.message.includes(leak) && !/select/i.test(error.message));

    const { client } = clientFor(home, () => ({
      stdout: JSON.stringify({ error: 'revision_conflict', code: 'revision_conflict', message: `changed at ${leak}`, detail: `SELECT secret FROM pages WHERE token='${secret}'` }),
      stderr: `Error at ${leak}\n${secret}\n`,
      exitCode: 1,
    }));
    await assert.rejects(() => client.forget('nemo-notes/a', { requestId: REQUEST, expectedRevision: 'rev-old' }), error => {
      assert.equal(error.code, 'GBRAIN_CONFLICT');
      assert.equal(error.status, 409);
      assert.equal(error.message.includes(leak), false);
      assert.equal(error.message.includes(secret), false);
      assert.equal(/select/i.test(error.message), false);
      return true;
    });
  } finally {
    await removeHome(home.root);
  }
});

test('projects chunk text as a bounded excerpt and hides forgotten rows from search', async () => {
  const home = await makeHome();
  const chunk = `chunk-start ${'x'.repeat(2000)} chunk-end`;
  try {
    const { client } = clientFor(home, payload => {
      const args = payload.args;
      if (args[0] === 'search') {
        return { stdout: JSON.stringify([
          { slug: 'nemo-notes/live', title: 'Live title', snippet: 'short snippet', chunk_text: chunk },
          { slug: 'nemo-notes/snippet-only', title: 'Snippet title', snippet: 'snippet text only', chunk_text: '   ' },
          { slug: 'nemo-notes/gone', title: 'Gone', chunk_text: 'forgotten text', deleted_at: '2026-01-01T00:00:00Z' },
          { slug: 'nemo-notes/title-only', title: 'rev-looking-title' },
        ]) };
      }
      if (args[0] === 'list') {
        return { stdout: JSON.stringify([
          { slug: 'nemo-notes/live', title: 'Live title', compiled_truth: 'listed body' },
          { slug: 'nemo-notes/gone', title: 'Gone', deleted_at: '2026-01-01T00:00:00Z', compiled_truth: 'hidden body' },
        ]) };
      }
      if (args[0] === 'get') {
        const slug = args[1];
        if (slug.endsWith('hashed')) return { stdout: JSON.stringify({ slug, title: 'Title text', content_hash: 'abc123def', content: 'hashed body' }) };
        if (slug.endsWith('plain')) return { stdout: JSON.stringify({ slug, title: 'rev-looking-title', content: 'plain body' }) };
        return { stdout: JSON.stringify({ slug, title: 'Not A Revision', revision: '11111111-1111-4111-8111-111111111111', content: '---\ntitle: "Not A Revision"\n---\n\nHello body\n' }) };
      }
      return { stdout: 'null', exitCode: 1 };
    });
    const found = await client.search({ query: 'chunk-start', limit: 10 });
    assert.equal(found.items.some(item => item.slug === 'nemo-notes/gone'), false);
    const live = found.items.find(item => item.slug === 'nemo-notes/live');
    assert.equal(live.status, 'active');
    assert.equal(live.summary.startsWith('chunk-start'), true);
    assert.equal(live.excerpt, live.summary);
    assert.ok(live.summary.length <= 1200);
    assert.equal(live.summary.includes('short snippet'), false);
    const snippetOnly = found.items.find(item => item.slug === 'nemo-notes/snippet-only');
    assert.equal(snippetOnly.summary, 'snippet text only');
    const titleOnly = found.items.find(item => item.slug === 'nemo-notes/title-only');
    assert.equal(titleOnly.summary, '');
    assert.equal(titleOnly.revision, undefined);

    const listed = await client.list({ limit: 10 });
    assert.equal(listed.items.find(item => item.slug === 'nemo-notes/gone').status, 'forgotten');
    assert.equal(listed.items.find(item => item.slug === 'nemo-notes/live').status, 'active');

    const page = await client.get('nemo-notes/full');
    assert.match(page.content, /Hello body/);
    assert.equal(page.revision, '11111111-1111-4111-8111-111111111111');
    assert.notEqual(page.revision, page.title);
    const hashed = await client.get('nemo-notes/hashed');
    assert.equal(hashed.revision, 'abc123def');
    assert.match(hashed.content, /hashed body/);
    const plain = await client.get('nemo-notes/plain');
    assert.equal(plain.revision, undefined);
    assert.equal(plain.content.includes('plain body'), true);
  } finally {
    await removeHome(home.root);
  }
});

test('incomplete purge receipts do not claim success', async () => {
  const home = await makeHome();
  try {
    for (const completion of ['committed', 'incomplete']) {
      const { client } = clientFor(home, () => ({
        stdout: JSON.stringify({
          state: 'committed',
          status: 'purged',
          content: 'SECRET_NOTE_BODY',
          summary: 'Removed successfully',
          receipt: {
            completion,
            summary: 'Removed from live stores',
            stores: [
              { store: 'pages', status: 'deleted', removed: 1 },
              { store: 'content_chunks', status: 'incomplete', remaining: 2, items: ['SECRET_NOTE_BODY'] },
              { store: 'page_versions', status: 'retained_inactive', remaining: 1 },
              { store: 'source_prose', status: 'unverified' },
              { store: 'git_history', status: 'out_of_reach' },
            ],
            residuals: [{ store: 'database_physical', status: 'out_of_reach', detail: 'SECRET_NOTE_BODY' }],
          },
        }),
        exitCode: completion === 'committed' ? 10 : 75,
      }));
      const result = await client.remove('nemo-notes/page', { confirm: true, requestId: randomUUID(), expectedRevision: 'rev-1' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'incomplete');
      assert.equal(result.physicalErasure, false);
      assert.equal(result.receipt.physicalErasure, false);
      assert.equal(result.receipt.completion, completion);
      assert.equal(/^removed\b/i.test(result.message), false);
      assert.equal(/\bremoved\b/i.test(result.message), false);
      assert.equal(/success/i.test(result.message), false);
      assert.ok(result.receipt.deleted.includes('pages'));
      assert.ok(result.receipt.retained.includes('content_chunks'));
      assert.ok(result.receipt.retained.includes('page_versions'));
      assert.ok(result.receipt.unverified.includes('source_prose'));
      assert.ok(result.receipt.outOfReach.includes('git_history'));
      assert.ok(result.receipt.outOfReach.includes('database_physical'));
      assert.equal(JSON.stringify(result).includes('SECRET_NOTE_BODY'), false);
    }
  } finally {
    await removeHome(home.root);
  }
});

test('forwards expectedRevision and does not delete a newer page on conflict', async () => {
  const home = await makeHome();
  try {
    const { client, calls } = clientFor(home, payload => {
      const args = payload.args;
      if (args[0] === 'get') return { stdout: JSON.stringify({ slug: args[1], title: 'T', revision: 'newer-revision', content: 'current' }) };
      if (args.includes('--purge')) return { stdout: JSON.stringify({ state: 'committed', receipt: { completion: 'complete', stores: [], residuals: [] } }) };
      return { stdout: JSON.stringify({ state: 'committed' }) };
    });
    const forgotten = await client.forget('nemo-notes/page', { requestId: REQUEST, expectedRevision: 'older-revision' });
    assert.equal(forgotten.ok, true);
    assert.equal(forgotten.status, 'forgotten');
    assert.equal(forgotten.recoverable, true);
    assert.equal(forgotten.recoveryHours, undefined);
    assert.match(forgotten.message, /hidden from recall/i);
    assert.match(forgotten.message, /until you purge/i);
    assert.doesNotMatch(forgotten.message, /72/);
    assert.equal(calls.some(call => argsOf(call)[0] === 'get'), false);
    const deleteArgs = argsOf(calls[0]);
    assert.equal(deleteArgs.includes('--expected-revision'), true);
    assert.equal(deleteArgs.includes('older-revision'), true);
    assert.equal(deleteArgs.includes('newer-revision'), false);
    assert.equal(deleteArgs.includes('--purge'), false);

    const conflicted = clientFor(home, () => ({
      stdout: JSON.stringify({ error: 'revision_conflict', code: 'revision_conflict', message: 'newer page' }),
      exitCode: 1,
    }));
    await assert.rejects(
      () => conflicted.client.remove('nemo-notes/page', { confirm: true, requestId: OTHER_REQUEST, expectedRevision: 'older-revision' }),
      error => error instanceof GbrainError && error.code === 'GBRAIN_CONFLICT' && error.status === 409,
    );
    await assert.rejects(
      () => client.save({ title: 'Other', content: 'nope', slug: 'inbox/nope' }),
      error => error.code === 'GBRAIN_ARGUMENT',
    );
  } finally {
    await removeHome(home.root);
  }
});

test('replays a completed purge for the same request id and reports a different id as missing', async () => {
  const home = await makeHome();
  try {
    let gets = 0;
    const { client, calls } = clientFor(home, payload => {
      const args = payload.args;
      if (args[0] === 'get') {
        gets += 1;
        return { stdout: JSON.stringify({ error: 'page_not_found', code: 'page_not_found', message: 'SENTINEL_PRIVATE_PATH' }), exitCode: 1 };
      }
      return {
        stdout: JSON.stringify({
          state: 'committed',
          content: 'SECRET_NOTE_BODY',
          receipt: {
            completion: 'complete',
            stores: [{ store: 'pages', status: 'deleted', removed: 1 }],
            residuals: [{ store: 'git_history', status: 'out_of_reach' }],
          },
        }),
      };
    });
    const first = await client.remove('nemo-notes/page', { confirm: true, requestId: REQUEST, expectedRevision: 'rev-1' });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'purged');
    assert.equal(first.receipt.completion, 'complete');
    assert.equal(first.physicalErasure, false);
    assert.equal(first.receipt.physicalErasure, false);
    assert.equal(JSON.stringify(first).includes('SECRET_NOTE_BODY'), false);
    const beforeReplay = calls.length;
    const replay = await client.remove('nemo-notes/page', { confirm: true, requestId: REQUEST, expectedRevision: 'rev-1' });
    assert.deepEqual(replay, first);
    assert.equal(calls.length, beforeReplay);
    assert.equal(gets, 0);
    await assert.rejects(
      () => client.remove('nemo-notes/page', { confirm: true, requestId: OTHER_REQUEST }),
      error => error instanceof GbrainError && error.code === 'GBRAIN_NOT_FOUND' && error.status === 404 && !error.message.includes('SENTINEL_PRIVATE_PATH'),
    );
    const raw = await readFile(join(home.dataDir, '.gbrain', 'nemo-receipts.json'), 'utf8');
    assert.equal(raw.includes('SECRET_NOTE_BODY'), false);
    assert.equal(raw.includes(REQUEST), true);
    const info = await stat(join(home.dataDir, '.gbrain', 'nemo-receipts.json'));
    assert.ok(info.size > 0);
  } finally {
    await removeHome(home.root);
  }
});

test('times out a hung command and reports a live lock as busy', async () => {
  const home = await makeHome();
  try {
    const hung = clientFor(home, () => ({ hang: true }), 80);
    await assert.rejects(() => hung.client.list({ limit: 1 }), error => error instanceof GbrainError && error.code === 'GBRAIN_TIMEOUT');
    assert.equal(hung.calls[0].child.killed, true);

    await writeFile(join(home.dataDir, '.gbrain', 'nemo-engine.lock'), JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }));
    const busy = clientFor(home, () => ({ stdout: '[]' }), 180);
    await assert.rejects(() => busy.client.search({ query: 'notes' }), error => error instanceof GbrainError && error.code === 'GBRAIN_BUSY' && error.status === 503);
    assert.equal(existsSync(join(home.dataDir, '.gbrain', 'nemo-engine.lock')), true);
    assert.equal(busy.calls.length, 0);

    await writeFile(join(home.dataDir, '.gbrain', 'nemo-engine.lock'), JSON.stringify({ pid: 2147483000, token: 'dead', at: Date.now() - 5000 }));
    const recovered = clientFor(home, () => ({ stdout: JSON.stringify([{ slug: 'nemo-notes/live', title: 'Live', chunk_text: 'recovered text' }]) }), 1000);
    const found = await recovered.client.search({ query: 'recovered' });
    assert.equal(found.items[0].summary, 'recovered text');
    assert.equal(existsSync(join(home.dataDir, '.gbrain', 'nemo-engine.lock')), false);
  } finally {
    await removeHome(home.root);
  }
});

test('status reports the checked local settings without claiming search or deletion', async () => {
  const home = await makeHome();
  try {
    const { client } = clientFor(home, () => ({ stdout: '[]' }));
    const status = await client.status();
    assert.equal(status.connected, true);
    assert.equal(status.available, true);
    assert.equal(status.engine, 'pglite');
    assert.equal(status.embedding, 'disabled');
    assert.equal(status.writeback, 'off');
    assert.equal(status.version, '9.9.9-test');
    assert.equal(status.automaticCapture, false);
    assert.equal(status.paidProcessing, false);
    assert.equal(status.searchMode, undefined);
    assert.equal(status.searchWorks, undefined);
    assert.equal(status.deletionWorks, undefined);
  } finally {
    await removeHome(home.root);
  }
});

test('setup refuses a missing data directory argument and an existing brain', async () => {
  const home = await makeHome();
  const secret = 'sk-should-not-print';
  try {
    await writeFile(join(home.dataDir, '.gbrain', 'config.json'), JSON.stringify({ token: secret }));
    const missing = await runSetup('');
    assert.equal(missing.code, 2);
    const refused = await runSetup(home.dataDir);
    assert.equal(refused.code, 1);
    assert.equal(`${refused.stdout}\n${refused.stderr}`.includes(secret), false);
    const still = await readFile(join(home.dataDir, '.gbrain', 'config.json'), 'utf8');
    assert.equal(still.includes(secret), true);
  } finally {
    await removeHome(home.root);
  }
});

test('synthetic keyless brain round trip', { skip: existsSync(BUN) && existsSync(join(SOURCE, 'src', 'cli.ts')) ? false : 'pinned Bun runtime or GBrain source is not available', timeout: 360_000 }, async () => {
  const root = await mkdtemp(join(here, '.tmp-gbrain-live-'));
  const dataDir = join(root, 'home');
  const token = 'xylophonequartz99';
  try {
    const setup = await runSetup(dataDir);
    assert.equal(setup.code, 0, 'setup failed');
    const again = await runSetup(dataDir);
    assert.notEqual(again.code, 0);
    const client = createGbrainClient({ runtimePath: BUN, sourceRoot: SOURCE, dataDir, timeoutMs: 90_000 });
    const status = await client.status();
    assert.equal(status.connected, true);
    assert.equal(status.engine, 'pglite');
    assert.equal(status.embedding, 'disabled');
    assert.equal(status.writeback, 'off');
    assert.equal(status.automaticCapture, false);
    assert.equal(status.paidProcessing, false);
    assert.equal(status.searchWorks, undefined);
    assert.equal(status.deletionWorks, undefined);

    const created = await client.save({ title: 'Synthetic', content: `Remember ${token} for the adapter test.`, slug: 'nemo-notes/synthetic', requestId: REQUEST });
    assert.equal(created.slug, 'nemo-notes/synthetic');
    assert.match(created.content, new RegExp(token));
    assert.equal(typeof created.revision, 'string');
    assert.notEqual(created.revision, 'Synthetic');
    const fetched = await client.get(created.slug);
    assert.match(fetched.content, new RegExp(token));
    assert.equal(fetched.revision, created.revision);

    let found = await client.search({ query: token, limit: 5 });
    for (let attempt = 0; attempt < 3 && !found.items.some(item => item.slug === created.slug); attempt += 1) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
      found = await client.search({ query: token, limit: 5 });
    }
    const hit = found.items.find(item => item.slug === created.slug);
    assert.ok(hit);
    assert.equal(hit.status, 'active');
    assert.match(hit.summary, new RegExp(token));
    assert.ok(hit.summary.length > 0 && hit.summary.length <= 1200);

    const edited = await client.save({
      title: 'Synthetic',
      content: `Edited ${token} after the first save.`,
      slug: created.slug,
      expectedRevision: created.revision,
      requestId: OTHER_REQUEST,
    });
    assert.equal(typeof edited.revision, 'string');
    assert.notEqual(edited.revision, created.revision);
    await assert.rejects(
      () => client.save({ title: 'Synthetic', content: `Stale ${token} must not land.`, slug: created.slug, expectedRevision: created.revision, requestId: randomUUID() }),
      error => error instanceof GbrainError && error.code === 'GBRAIN_CONFLICT' && error.status === 409,
    );

    const current = await client.get(created.slug);
    const forgetId = randomUUID();
    const forgotten = await client.forget(created.slug, { requestId: forgetId, expectedRevision: current.revision });
    assert.equal(forgotten.status, 'forgotten');
    assert.equal(forgotten.recoverable, true);
    assert.equal(forgotten.recoveryHours, undefined);
    assert.match(forgotten.message, /hidden from recall/i);
    assert.match(forgotten.message, /purge/i);
    assert.doesNotMatch(forgotten.message, /72/);
    const listed = await client.list({ limit: 20 });
    assert.equal(listed.items.find(item => item.slug === created.slug)?.status, 'forgotten');
    const searched = await client.search({ query: token, limit: 10 });
    assert.equal(searched.items.some(item => item.slug === created.slug), false);

    const forgottenPage = await client.get(created.slug);
    assert.equal(forgottenPage.status, 'forgotten');
    assert.equal(typeof forgottenPage.revision, 'string');
    const purgeId = randomUUID();
    const purged = await client.remove(created.slug, { confirm: true, requestId: purgeId, expectedRevision: forgottenPage.revision });
    assert.equal(purged.ok, true);
    assert.equal(purged.status, 'purged');
    assert.equal(purged.receipt.completion, 'complete');
    assert.equal(purged.physicalErasure, false);
    assert.equal(purged.receipt.physicalErasure, false);
    assert.equal(JSON.stringify(purged).includes(token), false);
    const replay = await client.remove(created.slug, { confirm: true, requestId: purgeId });
    assert.deepEqual(replay, purged);
    await assert.rejects(() => client.get(created.slug), error => error.code === 'GBRAIN_NOT_FOUND');
    await assert.rejects(
      () => client.remove(created.slug, { confirm: true, requestId: randomUUID() }),
      error => error.code === 'GBRAIN_NOT_FOUND' && error.status === 404,
    );
    const receiptRaw = await readFile(join(dataDir, '.gbrain', 'nemo-receipts.json'), 'utf8');
    assert.equal(receiptRaw.includes(token), false);
  } finally {
    await removeHome(root);
  }
});
