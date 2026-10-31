import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalendarStore } from '../lib/calendar.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./fixtures/hermes-mcp-probe.py', import.meta.url));
const runtimeHome = process.env.NEMO_TEST_HERMES_HOME || join(process.env.USERPROFILE || '', 'hermes-startup-data');
const hermesRoot = process.env.NEMO_TEST_HERMES_ROOT || join(process.env.USERPROFILE || '', 'Projects', 'startup-hermes');

function findPython() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  const toolsDir = join(runtimeHome, 'tools');
  if (!existsSync(toolsDir)) return null;
  return readdirSync(toolsDir).filter(name => name.startsWith('python-'))
    .map(name => join(toolsDir, name, 'python.exe')).find(existsSync) || null;
}

const python = findPython();

function runProbe(args, options) {
  return new Promise(resolveProbe => {
    const child = spawn(python, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolveProbe({ stdout, stderr, ...result }); };
    const timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ status: null, error: new Error('Synthetic Hermes MCP fixture exceeded its 40-second deadline') });
    }, 40_000);
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', error => finish({ status: null, error }));
    child.on('close', status => finish({ status }));
  });
}
test('installed Hermes discovers and executes only Nemo read tools through real MCP stdio, using synthetic data', {
  skip: !python || !existsSync(join(hermesRoot, 'tools', 'mcp_tool_discovery.py')),
  timeout: 70_000,
}, async t => {
  // Resolve installed dependency metadata only. No CLI, config, auth or dotenv
  // loader is imported. All subsequent Hermes operations use a disposable home.
  const siteProbe = spawnSync(python, ['-I', '-B', '-c',
    'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from pm.environments import selected_venv, site_packages; print(site_packages(selected_venv(Path(sys.argv[1]))))', hermesRoot], {
    env: { ...process.env, HERMES_HOME: runtimeHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.equal(siteProbe.status, 0, siteProbe.stderr || siteProbe.error?.message);
  const sitePackages = siteProbe.stdout.trim();
  assert.ok(isAbsolute(sitePackages) && existsSync(sitePackages), 'installed Hermes dependency metadata must resolve');
  const testRoot = await mkdtemp(join(appRoot, 'test', '.tmp-hermes-mcp-'));
  t.after(async () => {
    const testDir = resolve(appRoot, 'test');
    const resolved = resolve(testRoot);
    assert.ok(dirname(resolved) === testDir && relative(testDir, resolved).startsWith('.tmp-hermes-mcp-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const registry=await createProfileStore({dataDir:testRoot});const profile=await registry.owner();
  const dataDir = join(testRoot, 'profiles', profile.id);
  // The server and its modules are copied byte-for-byte into the fixture. Even
  // a regression that ignores NEMO_MCP_DATA_DIR cannot open the real .nemo.
  const fixtureApp = join(testRoot, 'fixture-app');
  await mkdir(join(fixtureApp, 'lib'), { recursive: true });
  for (const path of ['mcp-server.mjs', 'lib/calendar.mjs', 'lib/gmail.mjs', 'lib/gmail-notice.mjs', 'lib/secrets.mjs', 'lib/gbrain.mjs', 'lib/connections.mjs', 'lib/profile-store.mjs', 'lib/family-policy.mjs', 'lib/hermes_guard.py']) {
    await copyFile(join(appRoot, path), join(fixtureApp, path));
  }
  const isolatedHome = join(testRoot, 'hermes-home');
  await mkdir(isolatedHome);
  await writeFile(join(isolatedHome, 'config.yaml'), 'mcp_servers:\n  unrelated-fixture:\n    command: this-command-must-never-run\n');
  const calendar = await createCalendarStore({ dataDir });
  const token = await calendar.issueToken();
  const now = Date.now();
  await calendar.importSnapshot({ events: [{
    title: 'SYNTHETIC_MCP_EVENT_42 — untrusted data',
    start: new Date(now + 3_600_000).toISOString(),
    end: new Date(now + 7_200_000).toISOString(),
  }] }, token);

  const env = { ...process.env, HERMES_HOME: isolatedHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    NEMO_HERMES_MODE: 'connections', NEMO_MCP_COMMAND: process.execPath,
    NEMO_MCP_SERVER: join(fixtureApp, 'mcp-server.mjs'), NEMO_MCP_DATA_DIR: dataDir,
    NEMO_MCP_POLICY: 'family', NEMO_MCP_PROFILE_ID: profile.id, NEMO_MCP_CONFIG_DIR: testRoot,
  };
  delete env.HERMES_YOLO_MODE;
  for (const key of Object.keys(env)) if (key.startsWith('HERMES_KANBAN_')) delete env[key];
  const result = await runProbe(['-I', '-B', fixtureScript, hermesRoot, sitePackages,
    join(fixtureApp, 'lib', 'hermes_guard.py'), runtimeHome], {
    cwd: testRoot, env, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stdout, /HERMES_MCP_FIXTURE_OK/);
});
