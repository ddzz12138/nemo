import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { defaultDataDir, loadConfig, saveConfig, validatePublicOrigin } from '../lib/config.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
import { capabilitySnapshot } from '../lib/capabilities.mjs';
import { createSecretStore } from '../lib/secrets.mjs';
import { createProcessControl, stopManagedProcess } from '../lib/managed-process.mjs';

async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'nemo-foundation-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('portable data locations preserve legacy pairings and honor absolute overrides', () => {
  const root = resolve('fixture'); const home = resolve('test-home');
  assert.equal(defaultDataDir({ root, home, platform: 'darwin', env: {}, exists: () => true }), join(root, '.nemo'));
  assert.equal(defaultDataDir({ root, home, platform: 'darwin', env: {}, exists: () => false }), join(home, 'Library', 'Application Support', 'Nemo'));
  assert.equal(defaultDataDir({ root, home, platform: 'win32', env: {}, exists: () => false }), join(home, 'AppData', 'Local', 'NemoData'));
  const local=join(home,'AppData','Local');
  assert.equal(defaultDataDir({root,home,platform:'win32',env:{LOCALAPPDATA:local},exists:()=>false}),join(local,'NemoData'));
  assert.throws(() => defaultDataDir({ env: { NEMO_DATA_DIR: '../other' } }), /absolute/);
  assert.throws(() => defaultDataDir({ root, home, platform: 'linux', env: {}, exists: () => false }), /Windows and macOS/);
});

test('Windows private data is outside the Squirrel installation replacement boundary',()=>{
  const home=resolve('synthetic-user'),local=join(home,'AppData','Local'),installation=join(local,'Nemo');
  const data=defaultDataDir({root:join(installation,'app-synthetic','resources','app'),home,platform:'win32',env:{LOCALAPPDATA:local},exists:()=>false});
  const fromInstallation=relative(installation,data);
  assert.ok(fromInstallation.startsWith('..')||isAbsolute(fromInstallation));
  assert.notEqual(data,installation);
});

test('configuration never accepts credentials or non-origin URLs', async t => {
  const dataDir = await temporary(t);
  await saveConfig(dataDir, { port: 8989, publicOrigin: 'https://nemo.example.test' });
  const config = await loadConfig({ dataDir, env: {} });
  assert.equal(config.port, 8989); assert.equal(config.telemetry, false); assert.equal(config.publicOrigin, 'https://nemo.example.test');
  for (const value of ['http://example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?secret=x', 'file:///x']) assert.throws(() => validatePublicOrigin(value));
  await assert.rejects(saveConfig(dataDir, { googleSecret: 'never-write-this' }), /Unsupported/);
  assert.ok(!(await readFile(join(dataDir, 'nemo.json'), 'utf8')).includes('never-write-this'));
});

test('legacy members remain unclassified until an explicit owner classification', async t => {
  const dataDir = await temporary(t); const store = await createProfileStore({ dataDir });
  const member = await store.create('Synthetic adult');
  assert.equal(member.classification, 'unclassified');
  const before = capabilitySnapshot({ profile: member });
  assert.equal(before.capabilities.find(tool => tool.id === 'terminal').state, 'disabled');
  const adult = await store.classify(member.id, 'adult');
  assert.equal(adult.childMode, false); assert.equal(adult.policyRevision, 1);
  assert.equal(capabilitySnapshot({ profile: adult }).capabilities.find(tool => tool.id === 'terminal').state, 'needs_setup');
  const child = await store.classify(member.id, 'child');
  assert.equal(child.childMode, true); assert.equal(child.policyRevision, 2);
  await assert.rejects(store.classify(member.id, 'owner'), /Adult or Child/);
  await assert.rejects(store.classify((await store.owner()).id, 'adult'), /owner/);
});

test('capability discovery needs verified local readiness and never returns account details', () => {
  const profile = { id: 'fixture', role: 'owner' };
  let snapshot = capabilitySnapshot({ profile, provider: { connected: true, token: 'SECRET', account: 'PRIVATE' } });
  assert.equal(snapshot.capabilities.find(tool => tool.id === 'chat').state, 'needs_setup');
  assert.equal(capabilitySnapshot({ profile, provider: { connected: true }, readiness: { chat: true } }).capabilities.find(tool => tool.id === 'chat').state, 'ready');
  assert.equal(snapshot.capabilities.find(tool => tool.id === 'memory').state, 'needs_setup');
  snapshot = capabilitySnapshot({ profile, readiness: { memory: true, gmail: true } });
  assert.equal(snapshot.capabilities.find(tool => tool.id === 'memory').state, 'ready');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.throws(() => capabilitySnapshot(), /trusted profile/);
});

function mockKeychain() {
  const values = new Map(), calls = [];
  const command = async (args, input = '') => {
    calls.push({ args, input });
    const fields = args[0] === '-i' ? input.trim().split(' ') : args;
    const id = fields[fields.indexOf('-a') + 1] + ':' + fields[fields.indexOf('-s') + 1];
    if (args[0] === '-i') {
      assert.ok(Buffer.byteLength(input) < 4096, 'macOS security interactive line limit');
      assert.ok(!fields.includes('-U'), 'existing wrapping keys must never be overwritten');
      if (values.has(id)) return { code: 1, stdout: '', stderr: 'duplicate' };
      values.set(id, fields.at(-1)); return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'delete-generic-password') { const found = values.delete(id); return { code: found ? 0 : 44, stdout: '', stderr: '' }; }
    return values.has(id) ? { code: 0, stdout: values.get(id), stderr: '' } : { code: 44, stdout: '', stderr: '' };
  };
  return { command, calls, values };
}

test('macOS Keychain records never put secrets into argv or the encrypted file', async t => {
  const dataDir = await temporary(t); const { command, calls, values } = mockKeychain();
  const store = createSecretStore({ dataDir, platform: 'darwin', keychainCommand: command });
  assert.equal(await store.load(), null);
  await store.save({ refresh_token: 'SYNTHETIC_PRIVATE_TOKEN' });
  assert.deepEqual(await store.load(), { refresh_token: 'SYNTHETIC_PRIVATE_TOKEN' });
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes('SYNTHETIC_PRIVATE_TOKEN')));
  assert.ok(calls.every(call => [...values.values()].every(value => !JSON.stringify(call.args).includes(value))));
  assert.ok(!(await readFile(join(dataDir, 'gmail-tokens.dpapi'), 'utf8')).includes('SYNTHETIC_PRIVATE_TOKEN'));
  const other = createSecretStore({ dataDir: join(dataDir, 'other-profile'), platform: 'darwin', keychainCommand: command });
  await other.save({ refresh_token: 'SECOND' });
  assert.notDeepEqual(calls.find(call => call.args[0] === 'find-generic-password').args, calls.filter(call => call.args[0] === 'find-generic-password').at(-1).args);
  await store.remove(); assert.equal(await store.load(), null);
  assert.equal(values.size, 1, 'removing one profile preserves the other wrapping key');
});

test('macOS encrypts large caches locally, rejects tampering, and reuses a stable Keychain key', async t => {
  const dataDir = await temporary(t), { command, values } = mockKeychain();
  const store = createSecretStore({ dataDir, name: 'gmail-sync.dpapi', platform: 'darwin', keychainCommand: command });
  const record = { snippets: Array.from({ length: 50 }, (_, id) => ({ id, snippet: 'SYNTHETIC '.repeat(80) })) };
  await store.save(record); assert.deepEqual(await store.load(), record);
  const firstKey = [...values.values()][0];
  await Promise.all([store.save({ revision: 2 }), store.save({ revision: 3 })]);
  assert.deepEqual(await store.load(), { revision: 3 }); assert.equal([...values.values()][0], firstKey);
  const path = join(dataDir, 'gmail-sync.dpapi'); const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.tag = Buffer.alloc(16).toString('base64'); await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(store.load(), /unlock/);
});

test('macOS unavailable Keychain never writes a plaintext fallback', async t => {
  const dataDir = await temporary(t);
  const store = createSecretStore({ dataDir, platform: 'darwin', keychainCommand: async () => ({ code: 44, stdout: '', stderr: '' }) });
  await assert.rejects(store.save({ token: 'PRIVATE' }), /save/);
  await assert.rejects(readFile(join(dataDir, 'gmail-tokens.dpapi')), { code: 'ENOENT' });
});

test('macOS refuses legacy ciphertext instead of silently using plaintext', async t => {
  const dataDir = await temporary(t);
  await writeFile(join(dataDir, 'gmail-tokens.dpapi'), 'WINDOWS-CIPHERTEXT');
  const store = createSecretStore({ dataDir, platform: 'darwin', keychainCommand: async () => { throw new Error('must not be called'); } });
  await assert.rejects(store.load(), /another operating system/);
});

test('managed stop addresses this CLI by a one-time control secret, never by PID', async t => {
  const dataDir = await temporary(t); let stops = 0;
  const control = await createProcessControl({ dataDir, onStop: () => stops++ });
  t.after(() => control.close());
  const marker = JSON.parse(await readFile(join(dataDir, 'cli-process.json')));
  assert.equal(marker.childPid, undefined);
  await writeFile(join(dataDir, 'cli-process.json'), JSON.stringify({ ...marker, nonce: '0'.repeat(64) }));
  await assert.rejects(stopManagedProcess(dataDir), /authorize/); assert.equal(stops, 0);
  await writeFile(join(dataDir, 'cli-process.json'), JSON.stringify(marker));
  const raw = value => new Promise((resolve, reject) => {
    const socket = net.connect(marker.port, '127.0.0.1'); let output = '';
    socket.on('connect', () => socket.end(JSON.stringify(value) + '\n')); socket.on('data', chunk => output += chunk);
    socket.on('end', () => resolve(output)); socket.on('error', reject);
  });
  for (const value of [null, [], { command: 'stop', nonce: 'é'.repeat(64) }]) assert.equal((await raw(value)).trim(), 'denied');
  await stopManagedProcess(dataDir); assert.equal(stops, 1);
  await stopManagedProcess(dataDir); assert.equal(stops, 1, 'duplicate requests cannot stop twice');
});

test('managed start exits on an occupied port without stopping the existing service', async t => {
  const dataDir = await temporary(t);
  const occupied = net.createServer(socket => socket.end());
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port; await saveConfig(dataDir, { port });
  const child = spawn(process.execPath, ['bin/nemo.mjs', 'start'], { cwd: resolve('.'), env: { ...process.env, NEMO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let error = ''; child.stdout.resume(); child.stderr.on('data', part => error += part);
  const timer = setTimeout(() => child.kill(), 8000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, error); assert.match(error, /port is already in use/); assert.equal(occupied.listening, true);
  await assert.rejects(readFile(join(dataDir, 'cli-process.json')), { code: 'ENOENT' });
});
