import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from '../lib/profile-store.mjs';
import { configureHermesCommand, createHermesEventPolicy, createHermesProvider } from '../lib/hermes.mjs';
import { toPlanRequest, toHermesCompletion } from '../lib/chatgpt-plan-broker.mjs';
import { prepareHermesWorkspace } from '../lib/hermes-memory.mjs';

test('native memory only changes fixed toolset and turn flags and requires isolated startup proof', () => {
  const base = ['python', '-I', '-c', 'bootstrap', 'chat', '--toolsets', 'none', '--max-turns', '1'];
  assert.equal(configureHermesCommand(base, false, true)[6], 'memory');
  assert.equal(configureHermesCommand(base, true, true)[6], 'nemo,memory');
  assert.equal(configureHermesCommand(base, false, true)[8], '8');
  const policy = createHermesEventPolicy(false, { family: true, builtinMemory: true, childMode: false });
  assert.throws(() => policy.observe({ type: 'nemo_guard', version: 3, isolated: true, tools: [], stage: 'startup', learningPolicy: 'standard-v1' }));
  policy.observe({ type: 'nemo_guard', version: 5, builtinMemory: true, isolated: true, tools: ['memory'], stage: 'startup', learningPolicy: 'standard-v1' });
  policy.observe({ type: 'tool_use', name: 'memory', tool_call_id: 'native-1', input: { target: 'user', action: 'add', content: 'Synthetic preference' } });
  policy.observe({ type: 'tool_result', name: 'memory', tool_call_id: 'native-1', output: { success: true, done: true } });
  policy.observe({ type: 'result' });
  assert.equal(policy.toolCalls, 1);
  assert.throws(() => policy.observe({ type: 'tool_use', name: 'terminal', input: {} }));
  assert.throws(() => createHermesEventPolicy(false, { builtinMemory: true }));
});

test('native memory cannot activate in local, API-key, non-family or unscoped provider modes', () => {
  for (const options of [{}, { requireChatGPT: true, chatgptSession: async () => null }, { family: true }, { family: true, requireChatGPT: true, chatgptSession: async () => null, memoryEnabled: true }]) {
    assert.throws(() => createHermesProvider({ ...options, dataDir: resolve('synthetic-profile'), builtinMemoryHome: resolve('synthetic-profile/hermes') }), /private ChatGPT profile/);
  }
  assert.throws(() => createHermesProvider({ family: true, requireChatGPT: true, chatgptSession: async () => null, dataDir: resolve('synthetic-profile'), builtinMemoryHome: resolve('outside/hermes') }), /private ChatGPT profile/);
});

test('native provider accepts the trusted root alias only when it resolves to the same unlinked private profile', async t => {
  const root = await mkdtemp(resolve('.work/native-provider-alias-')), alias = root + '-configured';
  let aliasCreated = false, redirectedCreated = false, homeAliasCreated = false, redirected, homeAlias;
  t.after(async () => {
    if (homeAliasCreated) await unlink(homeAlias);
    if (redirectedCreated) await unlink(redirected);
    if (aliasCreated) await unlink(alias);
    assert.equal(dirname(root), resolve('.work')); assert.match(root, /native-provider-alias-/);
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const profiles = await createProfileStore({ dataDir: root }), owner = await profiles.owner();
  const home = await prepareHermesWorkspace({ profileId: owner.id, profileDataDir: profiles.directory(owner.id) });
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); aliasCreated = true;
  const dataDir = join(alias, 'profiles', owner.id);
  assert.notEqual(resolve(home), resolve(dataDir, 'hermes'), 'exercise distinct logical spellings of the same workspace');
  let credentialCalls = 0;
  const options = { hermesPython: process.execPath, hermesSource: resolve('vendor/hermes-source'), dataDir,
    family: true, profileId: owner.id, builtinMemoryHome: home, requireChatGPT: true,
    chatgptSession: async () => { credentialCalls++; throw new Error('Do not open a real account'); } };
  const agent = createHermesProvider(options);
  assert.match((await agent.memoryCommand())[4], /hermes_memory\.py/);
  assert.equal(credentialCalls, 0);
  const other = await profiles.create('Synthetic other person');
  const otherHome = await prepareHermesWorkspace({ profileId: other.id, profileDataDir: profiles.directory(other.id) });
  assert.throws(() => createHermesProvider({ ...options, builtinMemoryHome: otherHome }), /private ChatGPT profile/);
  assert.throws(() => createHermesProvider({ ...options, profileId: other.id }), /private ChatGPT profile/);
  homeAlias = join(root, 'redirected-home');
  await symlink(home, homeAlias, process.platform === 'win32' ? 'junction' : 'dir'); homeAliasCreated = true;
  assert.throws(() => createHermesProvider({ ...options, builtinMemoryHome: homeAlias }), /private ChatGPT profile/);
  redirected = join(root, 'profiles', '00000000-0000-0000-0000-000000000000');
  await symlink(profiles.directory(owner.id), redirected, process.platform === 'win32' ? 'junction' : 'dir'); redirectedCreated = true;
  assert.throws(() => createHermesProvider({ ...options, dataDir: join(alias, 'profiles', '00000000-0000-0000-0000-000000000000'), profileId: '00000000-0000-0000-0000-000000000000' }), /private ChatGPT profile/);
  assert.throws(() => createHermesProvider({ ...options, dataDir: redirected, builtinMemoryHome: join(redirected, 'hermes'), profileId: '00000000-0000-0000-0000-000000000000' }), /private ChatGPT profile/);
});

test('ChatGPT broker admits native memory only when permitted and preserves bounded native batches', () => {
  const arguments_ = JSON.stringify({ target: 'memory', operations: [{ action: 'remove', old_text: 'a'.repeat(2200) }, { action: 'add', content: 'b'.repeat(2200) }] });
  const completion = { status: 'completed', output: [{ type: 'function_call', namespace: 'nemo', name: 'memory', call_id: 'native-call', arguments: arguments_ }] };
  assert.throws(() => toHermesCompletion(completion, []));
  const translated = toHermesCompletion(completion, ['memory']);
  assert.equal(translated.choices[0].message.tool_calls[0].function.arguments, arguments_);
  const request = toPlanRequest({ messages: [{ role: 'user', content: 'Synthetic preference' }], tools: [{ type: 'function', function: { name: 'memory', parameters: { type: 'object' } } }] }, 'synthetic-model', ['memory']);
  assert.equal(request.tools[0].tools[0].name, 'memory');
  assert.equal(request.store, false);
  assert.throws(() => toPlanRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'memory', parameters: {} } }] }, 'synthetic-model', []));
});

test('memory command runs only the fixed bridge and never starts chat or opens account credentials', async () => {
  let credentials = 0;
  const dataDir = resolve('test/synthetic-profile-not-created');
  const agent = createHermesProvider({ hermesPython: process.execPath, hermesSource: resolve('vendor/hermes-source'),
    dataDir, family: true, profileId: '11111111-1111-4111-8111-111111111111', builtinMemoryHome: join(dataDir, 'hermes'),
    requireChatGPT: true, chatgptSession: async () => { credentials++; throw new Error('Memory view must not request model credentials'); } });
  const command = await agent.memoryCommand();
  assert.deepEqual(command.slice(0, 4), [process.execPath, '-B', '-I', '-c']);
  assert.equal(command.length, 5);
  assert.match(command[4], /hermes_memory\.py/);
  assert.doesNotMatch(command[4], /hermes_cli\.main|hermes_guard\.py/);
  assert.equal(credentials, 0);
});

function pythonPath() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  const bundled = resolve('.work/desktop-runtime/hermes/python/python.exe');
  if (existsSync(bundled)) return bundled;
  const directory = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools');
  if (process.platform !== 'win32') return 'python3';
  if (!existsSync(directory)) return null;
  return readdirSync(directory).filter(name => name.startsWith('python-')).map(name => join(directory, name, 'python.exe')).find(existsSync) || null;
}
const python = pythonPath();
test('native Python guard verifies owner, exact schema, bounded operations and current permissions before execution', { skip: !python }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-native-policy-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const registry = await createProfileStore({ dataDir: root }); const owner = await registry.owner();
  const home = join(registry.directory(owner.id), 'hermes'); await mkdir(home, { recursive: true });
  await writeFile(join(home, 'nemo-profile.json'), JSON.stringify({ version: 1, profileId: owner.id }));
  const result = spawnSync(python, ['-B', '-I', fileURLToPath(new URL('./fixtures/hermes-native-policy.py', import.meta.url)), fileURLToPath(new URL('../lib/hermes_guard.py', import.meta.url)), fileURLToPath(new URL('../vendor/hermes-source/tools/memory_tool.py', import.meta.url)), root, owner.id], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, provider: 'synthetic-only', nativeTool: 'memory', isolated: true });
});
