import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createHermesProvider } from '../lib/hermes.mjs';
import { prepareHermesWorkspace, createHermesMemory } from '../lib/hermes-memory.mjs';
import { createCalendarStore } from '../lib/calendar.mjs';

const runtime = resolve('.work/desktop-runtime');
const python = join(runtime, 'hermes/python/python.exe');
const source = join(runtime, 'hermes/source');
const marker = 'SYNTHETIC_NATIVE_OWNER_NOTE_7829';
const savedText = `User prefers concise replies. ${marker}`;
const session = { provider: 'chatgpt', accessToken: 'synthetic-native-memory-subscription', model: 'synthetic-memory-model' };
const response = output => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_native_memory', status: 'completed', output, usage: {} } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
const answer = () => response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic native-memory reply.' }] }]);

test('actual Hermes native memory saves, recalls privately, respects denied memory and shares the UI store', { skip: !existsSync(python), timeout: 180_000 }, async t => {
  const physicalRoot = await mkdtemp(resolve('.work/native-memory-runtime-')), root = physicalRoot + '-configured';
  let aliasCreated = false;
  t.after(async () => {
    if (aliasCreated) await unlink(root);
    assert.equal(dirname(physicalRoot), resolve('.work')); assert.match(physicalRoot, /native-memory-runtime-/);
    await rm(physicalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await symlink(physicalRoot, root, process.platform === 'win32' ? 'junction' : 'dir'); aliasCreated = true;
  const profiles = await createProfileStore({ dataDir: root });
  const owner = await profiles.owner(), other = await profiles.create('Second synthetic person');
  const shared = join(root, 'runtime-settings'); await mkdir(shared);
  let phase = 'save', requests = 0, writes = 0;
  const activity = [];
  const model = async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    const system = body.input.filter(item => item.role === 'developer').flatMap(item => item.content || []).map(item => item.text || '').join('\n');
    const tools = body.tools?.flatMap(group => group.tools || []).map(tool => tool.name) || [];
    assert.deepEqual(tools, phase === 'denied' ? [] : ['memory']);
    if (phase === 'recall') assert.ok(system.includes(marker), 'native note must be in this person’s system prompt');
    if (['other', 'denied', 'after-clear'].includes(phase)) assert.equal(system.includes(marker), false, phase + ' must not receive the note');
    if (phase === 'save' && writes++ === 0) return response([{ type: 'function_call', namespace: 'nemo', name: 'memory', call_id: 'native_save_1',
      arguments: JSON.stringify({ target: 'user', operations: [{ action: 'add', content: savedText }] }) }]);
    if (phase === 'save') {
      const output = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'native_save_1');
      assert.ok(output?.output.includes('"success": true') || output?.output.includes('"success":true'));
    }
    return answer();
  };
  async function agentFor(profile) {
    const dataDir = profiles.directory(profile.id), home = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: dataDir });
    return { home, agent: createHermesProvider({ hermesPython: python, hermesSource: source, hermesHome: shared,
      builtinMemoryHome: home, cwd: root, dataDir, family: true, profileId: profile.id, requireChatGPT: true,
      chatgptSession: async () => session, chatgptStatus: () => ({ connected: true, planUsageEnabled: true }), chatgptFetch: model, timeoutMs: 55_000 }) };
  }
  const { agent, home } = await agentFor(owner);
  assert.notEqual(resolve(home), resolve(profiles.directory(owner.id), 'hermes'), 'real native turn must use the verified configured-root alias');
  const first = await agent.run({ message: 'Remember my permanent formatting preference: concise replies.', permissionRevision: '0:0:false', onActivity: value => activity.push(value) });
  assert.equal(first.toolCalls, 1);
  assert.equal(first.text, 'Synthetic native-memory reply.');
  assert.equal((await readFile(join(home, 'memories/USER.md'), 'utf8')).trim(), savedText);
  assert.ok(activity.some(value => value.kind === 'tool' && value.name === 'memory' && value.state === 'completed'));
  await assert.rejects(readFile(join(shared, 'memories/USER.md')), { code: 'ENOENT' });

  const memory = await createHermesMemory({ profileId: owner.id, profileDataDir: profiles.directory(owner.id), command: () => agent.memoryCommand() });
  t.after(() => memory.close());
  const board = await memory.curation.board(owner.id);
  assert.equal(board.items.length, 1); assert.equal(board.items[0].text, savedText);
  phase = 'recall';
  const recallActivity = [];
  const recalled = await agent.run({ message: 'What response style should you use?', permissionRevision: '0:0:false', onActivity: value => recallActivity.push(value) });
  assert.equal(recalled.toolCalls, 0);
  assert.equal(recallActivity.some(value => value.kind === 'tool' && value.name === 'memory'), false, 'a text reply without a native tool call never claims a save');
  phase = 'other';
  const second = await agentFor(other);
  await second.agent.run({ message: 'What response style should you use?', permissionRevision: '0:0:false' });
  phase = 'denied';
  await agent.run({ message: 'Reply without using stored notes.', permissionRevision: '0:0:false', builtinMemoryAllowed: false });

  const preview = await memory.controller.preview(owner.id, { id: board.items[0].id, action: 'forget' });
  const removed = await memory.controller.remove(owner.id, { confirmation: preview.confirmation });
  assert.equal(removed.receipt.state, 'complete');
  assert.equal((await memory.curation.board(owner.id)).items.length, 0);
  phase = 'after-clear';
  await agent.run({ message: 'Start a new private conversation.', permissionRevision: '0:0:false' });
  assert.equal(requests, 6);
});

test('actual Hermes combines its native memory tool with an explicitly permitted calendar read', { skip: !existsSync(python), timeout: 80_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const profiles = await createProfileStore({ dataDir: root }); const owner = await profiles.owner();
  const dataDir = profiles.directory(owner.id), home = await prepareHermesWorkspace({ profileId: owner.id, profileDataDir: dataDir });
  const calendar = await createCalendarStore({ dataDir }); const token = await calendar.issueToken();
  await calendar.importSnapshot({ events: [{ title: 'SYNTHETIC_NATIVE_CALENDAR_READ', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString() }] }, token);
  let requests = 0;
  const agent = createHermesProvider({ hermesPython: python, hermesSource: source, hermesHome: home, builtinMemoryHome: home,
    cwd: root, dataDir, family: true, profileId: owner.id, requireChatGPT: true, nodeExecutable: join(runtime, 'node/node.exe'),
    chatgptSession: async () => session, chatgptStatus: () => ({ connected: true, planUsageEnabled: true }), timeoutMs: 55_000,
    chatgptFetch: async (_url, options) => {
      const body = JSON.parse(options.body); requests++;
      assert.deepEqual(body.tools.flatMap(group => group.tools).map(tool => tool.name).sort(), ['mcp__nemo__calendar_list', 'memory'].sort());
      if (requests === 1) return response([
        { type: 'function_call', namespace: 'nemo', name: 'mcp__nemo__calendar_list', call_id: 'native_calendar_1', arguments: '{"limit":1}' },
        { type: 'function_call', namespace: 'nemo', name: 'memory', call_id: 'native_calendar_memory_1', arguments: JSON.stringify({ target: 'user', action: 'add', content: 'User prefers morning appointments.' }) },
      ]);
      assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'native_calendar_1' && item.output.includes('SYNTHETIC_NATIVE_CALENDAR_READ')));
      assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'native_calendar_memory_1' && /"success"\s*:\s*true/.test(item.output)));
      return answer();
    } });
  const result = await agent.run({ message: 'Read one synthetic event and remember my lasting appointment preference.', useIntegrations: true, allowedConnectionTools: ['calendar_list'], permissionRevision: '0:0:false' });
  assert.equal(result.toolCalls, 2); assert.equal(requests, 2);
  assert.equal((await readFile(join(home, 'memories/USER.md'), 'utf8')).trim(), 'User prefers morning appointments.');
});
