import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareNodeRuntime, validateNodeRelease, verifyNodeBytes, verifyPreparedNodeRuntime } from '../scripts/prepare-node-runtime.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
import { policyRevision } from '../lib/family-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(root, 'desktop', 'node-release.json'), 'utf8'));
const staged = join(root, '.work', 'desktop-runtime');
let hasStaged = false;
try { await access(join(staged, 'node', 'node.exe')); hasStaged = true; } catch {}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('the Node release pins the official Windows executable and cannot redirect downloads or escape its resource path', () => {
  assert.equal(validateNodeRelease(release), release);
  assert.equal(release.nodeVersion, '24.13.1');
  assert.equal(release.sha256, 'e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50');
  assert.equal(release.checksums.url, 'https://nodejs.org/dist/v24.13.1/SHASUMS256.txt');
  for (const changed of [{ file: '../node.exe' }, { file: 'C:/private/node.exe' }, { url: 'https://nodejs.org.evil.example/dist/node.exe' }, { url: 'http://nodejs.org/dist/v24.13.1/win-x64/node.exe' }, { checksums: { ...release.checksums, entry: 'win-arm64/node.exe' } }, { license: { ...release.license, file: '../LICENSE.txt' } }]) assert.throws(() => validateNodeRelease({ ...release, ...changed }), /official Windows/);
  assert.throws(() => verifyNodeBytes(Buffer.from('An unverified runtime must never execute'), release), /does not match/);
});

test('actual official Node bytes stage alone, preserve other runtime settings, and start without PATH', { skip: !hasStaged || process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nemo official node '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = { version: 1, platform: 'win32', arch: 'x64', cloudflared: { file: 'cloudflared.exe', sha256: 'preserve-connector' }, hermes: { source: 'hermes/source', inventory: 'preserve-runtime' }, registrationOrigin: 'https://setup.example' };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(previous));
  const result = await prepareNodeRuntime({ out: directory, nodeSource: join(staged, 'node', 'node.exe'), licenseSource: join(staged, 'node', 'LICENSE.txt'), checksumsSource: join(staged, 'node', 'SHASUMS256.txt'), fetchImpl: () => { throw new Error('The verified offline build must never contact a service.'); } });
  assert.equal(sha256(await readFile(result.executable)), release.sha256);
  assert.deepEqual((await readdir(join(directory, 'node'))).sort(), ['LICENSE.txt', 'SHASUMS256.txt', 'node.exe']);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.cloudflared, previous.cloudflared);
  assert.deepEqual(manifest.hermes, previous.hermes);
  assert.equal(manifest.registrationOrigin, previous.registrationOrigin);
  assert.equal((await verifyPreparedNodeRuntime(directory)).version, 'v24.13.1');
  const corrupt = Buffer.from(await readFile(result.executable)); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => verifyNodeBytes(corrupt, release), /does not match/);
});

test('bundled Node launches the actual private MCP server and reads only a synthetic profile with empty PATH', { skip: !hasStaged || process.platform !== 'win32', timeout: 30000 }, async t => {
  const verified = await verifyPreparedNodeRuntime(staged);
  const directory = await mkdtemp(join(tmpdir(), 'nemo bundled MCP '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = await createProfileStore({ dataDir: directory });
  const owner = await profiles.owner();
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nemo-bundled-node-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'calendar_list', arguments: { start: '2026-10-24T00:00:00Z', end: '2026-10-25T00:00:00Z' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gmail_search', arguments: { query: 'anything' } } },
  ];
  const child = spawn(verified.executable, [resolve(root, 'mcp-server.mjs')], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows', PATH: '',
    NEMO_MCP_DATA_DIR: join(directory, 'profiles', owner.id), NEMO_MCP_CONFIG_DIR: directory, NEMO_MCP_PROFILE_ID: owner.id,
    NEMO_MCP_ALLOWED_TOOLS: JSON.stringify(['calendar_list']), NEMO_MCP_PERMISSION_REVISION: policyRevision(owner), NEMO_MCP_LIFETIME_MS: '10000',
  } });
  let output = '', diagnostics = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
  child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const [code] = await once(child, 'close'); assert.equal(code, 0, diagnostics);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.name, 'nemo-readonly-connections');
  assert.deepEqual(replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name), ['calendar_list']);
  const calendar = replies.find(reply => reply.id === 3).result;
  assert.equal(calendar.isError, false, JSON.stringify(calendar));
  assert.equal(replies.find(reply => reply.id === 4).error.code, -32602, 'no account credential or ungranted tool was available');
  assert.ok(!output.includes('OPENROUTER_API_KEY'));
});
