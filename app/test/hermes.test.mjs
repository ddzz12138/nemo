import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardRuntimeCommand, parseHermesLine, validateHermesResult, configureHermesCommand, createHermesEventPolicy, HERMES_CONNECTION_TOOLS } from '../lib/hermes.mjs';

test('family output requires proof of the requested learning policy before accepting text', () => {
  const startup = { type: 'nemo_guard', version: 3, isolated: true, stage: 'startup', tools: [], learningPolicy: 'child-v1' };
  for (const learningPolicy of [undefined, 'standard-v1', 'child-v2']) assert.throws(() => createHermesEventPolicy(false, { family: true, childMode: true }).observe({ ...startup, learningPolicy }));
  const child = createHermesEventPolicy(false, { family: true, childMode: true }); child.observe(startup); child.observe({ type: 'text', text: 'Hint' }); assert.equal(child.verified, true);
  assert.throws(() => createHermesEventPolicy(false, { family: true, childMode: false }).observe(startup));
  const mcp = createHermesEventPolicy(true, { family: true, memoryEnabled: true, childMode: true });
  mcp.observe({ ...startup, version: 4, tools: [...HERMES_CONNECTION_TOOLS] }); assert.equal(mcp.verified, true);
});

test('MCP permission changes only fixed toolset/turn flags and fails closed on CLI drift', () => {
  const base = ['python', '-I', '-c', 'bootstrap', 'chat', '--query-file', '-', '--toolsets', 'none', '--max-turns', '1'];
  assert.deepEqual(configureHermesCommand(base), base);
  const connected = configureHermesCommand(base, true);
  assert.equal(connected[8], 'nemo');
  assert.equal(connected[10], '8');
  assert.deepEqual(connected.slice(0, 8), base.slice(0, 8));
  assert.equal(base[8], 'none');
  for (const runtime of [base.slice(0, 8), [...base, '--toolsets', 'all'], base.map(value => value === 'none' ? 'all' : value)]) assert.throws(() => configureHermesCommand(runtime, true), /policy changed/);
  assert.throws(() => configureHermesCommand(base, 'true'), /choice/);
});

test('stream tool events need exact startup proof, permitted names, paired results and a six-call cap', () => {
  const startup = { type: 'nemo_guard', stage: 'startup', version: 2, tools: [...HERMES_CONNECTION_TOOLS] };
  const call = { type: 'tool_use', name: HERMES_CONNECTION_TOOLS[0], input: { limit: 1 }, tool_call_id: 'a' };
  const result = { type: 'tool_result', name: call.name, tool_call_id: 'a' };
  const ready = () => { const policy = createHermesEventPolicy(true); policy.observe(startup); return policy; };
  assert.throws(() => createHermesEventPolicy(true).observe(call));
  assert.throws(() => createHermesEventPolicy(true).observe({ type: 'text', text: 'Unverified' }));
  assert.throws(() => createHermesEventPolicy().observe(startup));
  assert.throws(() => ready().observe({ ...call, name: 'terminal' }));
  assert.throws(() => ready().observe({ ...call, input: [] }));
  assert.throws(() => ready().observe(result));
  assert.throws(() => ready().observe({ ...call, type: 'tool_unknown' }));
  const duplicate = ready(); duplicate.observe(call); duplicate.observe(result); assert.throws(() => duplicate.observe(call));
  const pending = ready(); pending.observe(call); assert.throws(() => pending.observe({ type: 'result' }));
  const valid = ready();
  for (let n = 0; n < 6; n++) { valid.observe({ ...call, tool_call_id: String(n) }); valid.observe({ ...result, tool_call_id: String(n) }); }
  assert.equal(valid.toolCalls, 6);
  valid.observe({ type: 'text', text: 'Answer' }); valid.observe({ type: 'result' });
  assert.throws(() => valid.observe({ ...call, tool_call_id: 'seventh' }));
  assert.throws(() => valid.observe(startup));
  const plain = createHermesEventPolicy();
  plain.observe({ type: 'nemo_guard', stage: 'startup', version: 1, tools: [] });
  plain.observe({ type: 'text', text: 'Plain' });
  assert.throws(() => plain.observe(call));
});

test('saved memory reads require the complete three-tool proof and memory writes remain forbidden', () => {
  const startup = { type: 'nemo_guard', stage: 'startup', version: 2, tools: [...HERMES_CONNECTION_TOOLS] };
  assert.deepEqual(HERMES_CONNECTION_TOOLS, ['mcp__nemo__calendar_list', 'mcp__nemo__gmail_search', 'mcp__nemo__memory_search']);
  assert.throws(() => createHermesEventPolicy(true).observe({ ...startup, tools: HERMES_CONNECTION_TOOLS.slice(0, 2) }));
  const policy = createHermesEventPolicy(true);
  policy.observe(startup);
  policy.observe({ type: 'tool_use', name: 'mcp__nemo__memory_search', input: { query: 'meeting preference' }, tool_call_id: 'memory-1' });
  policy.observe({ type: 'tool_result', name: 'mcp__nemo__memory_search', tool_call_id: 'memory-1' });
  policy.observe({ type: 'result' });
  assert.equal(policy.toolCalls, 1);
  assert.throws(() => policy.observe({ type: 'tool_use', name: 'mcp__nemo__memory_save', input: { content: 'must-not-save' } }));
  const plain = createHermesEventPolicy(false);
  plain.observe({ type: 'nemo_guard', stage: 'startup', version: 1, tools: [] });
  assert.throws(() => plain.observe({ type: 'tool_use', name: 'mcp__nemo__memory_search', input: { query: 'private note' } }));
});

test('Hermes JSONL parser ignores banners and invalid event shapes', () => {
  for (const line of ['Warning: Unknown toolsets: none', '{', 'null', '[]', '42', '{}', '{"type":7}']) assert.equal(parseHermesLine(line), null);
  assert.deepEqual(parseHermesLine('{"type":"text","text":" hello"}'), { type: 'text', text: ' hello' });
  assert.equal(parseHermesLine('{"type":"result","exit_code":1}').exit_code, 1);
});

test('final result rejects empty sentinels, failures and unsafe session IDs', () => {
  const result = { type: 'result', exit_code: 0, text: 'Hello.', session_id: 'nemo_123-abc' };
  assert.equal(validateHermesResult(result), result);
  for (const text of ['', '   ', '(empty)', ' \n(empty)\t', null]) assert.throws(() => validateHermesResult({ ...result, text }), /no text/);
  for (const patch of [{ exit_code: 1 }, { error: 'provider failed' }, { type: 'text' }, { exit_code: '0' }]) assert.throws(() => validateHermesResult({ ...result, ...patch }), /complete/);
  for (const session_id of ['latest', '../other', 'x\n--yolo', '', null]) assert.throws(() => validateHermesResult({ ...result, session_id }), /identifier/);
});

test('guard installs only into the known bootstrap and leaves message transport arguments intact', () => {
  const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
  const original = ['python.exe', '-I', '-c', "import os, sys, runpy; sys.path.insert(0, 'C:\\\\Hermes'); import hermes_bootstrap; " + entry, 'chat', '--query-file', '-', '--toolsets', 'none'];
  const guarded = guardRuntimeCommand(original);
  assert.deepEqual(guarded.slice(0, 4), [original[0], '-B', '-I', '-c']);
  assert.deepEqual(guarded.slice(5), original.slice(4));
  assert.match(guarded[4], /runpy\.run_path\(/);
  assert.match(guarded[4], /hermes_guard\.py/);
  assert.ok(original[3].endsWith(entry));
  for (const invalid of [[], ['python', '-c', entry], [...original.slice(0, 3), 'print("unknown")', ...original.slice(4)], [...original.slice(0, 3), original[3] + '; print("later")', ...original.slice(4)]]) assert.throws(() => guardRuntimeCommand(invalid), /runtime changed/);
});

function findPython() {
  if (process.env.NEMO_TEST_PYTHON) return process.env.NEMO_TEST_PYTHON;
  if (process.platform !== 'win32') return 'python3';
  const tools = join(process.env.USERPROFILE || '', 'hermes-startup-data', 'tools');
  if (!existsSync(tools)) return null;
  const installed = readdirSync(tools).filter(name => name.startsWith('python-')).map(name => join(tools, name, 'python.exe'));
  return installed.find(existsSync) || null;
}

const python = findPython();
test('Python guard blocks real tool surfaces and request tools before fake inference, with no Hermes imports', { skip: !python }, () => {
  const guardPath = fileURLToPath(new URL('../lib/hermes_guard.py', import.meta.url));
  const script = String.raw`
import contextlib, importlib.util, io, json, types, sys, os
spec = importlib.util.spec_from_file_location("nemo_guard_test", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
calls = []
def regular(agent, api_kwargs): calls.append("regular"); return "ok"
def streaming(agent, api_kwargs, *, on_first_delta=None): calls.append("stream"); return "stream-ok"
helpers = types.SimpleNamespace(interruptible_api_call=regular, interruptible_streaming_api_call=streaming)
def fake_class():
    class Agent:
        def __init__(self, tools=None, names=None, mode="codex_responses"):
            self.tools = [] if tools is None else tools
            self.valid_tool_names = set() if names is None else names
            self.api_mode = mode
        def run_conversation(self, *args, **kwargs): return self._interruptible_api_call({})
        def _interruptible_api_call(self, api_kwargs): return regular(self, api_kwargs)
        def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None): return streaming(self, api_kwargs, on_first_delta=on_first_delta)
        def _execute_tool_calls(self, *args, **kwargs): calls.append("EXECUTED")
        def _run_codex_app_server_turn(self, *args, **kwargs): calls.append("APP-SERVER")
    return Agent
def denied(fn):
    before = list(calls)
    try: fn()
    except guard.ToolPolicyError: pass
    else: raise AssertionError("unsafe request was accepted")
    assert calls == before, "inference/execution happened before rejection"
Agent = fake_class()
guard.install_guard(Agent, helpers)
proof = io.StringIO()
with contextlib.redirect_stdout(proof): agent = Agent()
assert json.loads(proof.getvalue()) == {"type":"nemo_guard","version":1,"stage":"startup","tools":[]}
assert agent._skip_mcp_refresh is True
status = io.StringIO()
with contextlib.redirect_stdout(status):
    agent.thinking_callback("(thinking) mulling...")
    agent.thinking_callback("PRIVATE_PROVIDER_DIAGNOSTIC")
    agent.thinking_callback("")
events = [json.loads(line) for line in status.getvalue().splitlines()]
assert events == [{"type":"nemo_status","phase":"thinking","verb":"mulling"}, {"type":"nemo_status","phase":"thinking","verb":"working"}, {"type":"nemo_status","phase":"idle","verb":None}]
assert "PRIVATE_PROVIDER_DIAGNOSTIC" not in status.getvalue()
assert agent.run_conversation("hello") == "ok"
assert agent._interruptible_streaming_api_call({"tools": []}) == "stream-ok"
assert agent._interruptible_api_call({"tools": None}) == "ok"
for request in [{"tools":[{"type":"function"}]}, {"tools":{}}, {"tools":False}, {"functions":[{"name":"send_mail"}]}, None, []]:
    denied(lambda request=request: agent._interruptible_api_call(request))
    denied(lambda request=request: agent._interruptible_streaming_api_call(request))
denied(lambda: agent._execute_tool_calls(None, [], "test"))
denied(lambda: agent._run_codex_app_server_turn())
agent.tools = [{"function":{"name":"send_mail"}}]
denied(lambda: agent.run_conversation("hello"))
denied(lambda: agent._interruptible_api_call({}))
agent.tools = []
agent.valid_tool_names = {"send_mail"}
denied(lambda: agent._interruptible_streaming_api_call({}))
agent.valid_tool_names = set()
agent.api_mode = "codex_app_server"
denied(lambda: agent._interruptible_api_call({}))
for kwargs in [{"tools":[{}]}, {"names":{"send_mail"}}, {"names":[]}, {"mode":"new_transport"}]:
    denied(lambda kwargs=kwargs: Agent(**kwargs))
Missing = fake_class()
Missing._interruptible_streaming_api_call = None
denied(lambda: guard.install_guard(Missing, helpers))
def changed(agent, api_kwargs, other=None): return None
denied(lambda: guard.install_guard(fake_class(), types.SimpleNamespace(interruptible_api_call=changed, interruptible_streaming_api_call=streaming)))
assert "run_agent" not in sys.modules and "hermes_cli.config" not in sys.modules
os.environ["NEMO_MCP_POLICY"] = "family"
flags = []
def family_init(self, skip_context_files=False, skip_memory=False, skip_background_review=False):
    flags.append((skip_context_files, skip_memory, skip_background_review))
    self.tools = []; self.valid_tool_names = set(); self.api_mode = "codex_responses"
Family = fake_class(); Family.__init__ = family_init
guard.install_guard(Family, helpers)
proof = io.StringIO()
with contextlib.redirect_stdout(proof): family = Family(skip_context_files=False, skip_memory=False, skip_background_review=False)
assert flags == [(True, True, True)], "shared context/memory/review must be suppressed before initialization"
assert json.loads(proof.getvalue()) == {"type":"nemo_guard","version":3,"stage":"startup","tools":[],"isolated":True,"learningPolicy":"standard-v1"}
assert family.run_conversation("hello") == "ok"
Changed = fake_class(); guard.install_guard(Changed, helpers)
with contextlib.redirect_stdout(io.StringIO()): denied(lambda: Changed())
os.environ["NEMO_MCP_MEMORY"] = "profile"
proof = io.StringIO()
with contextlib.redirect_stdout(proof): Family()
assert json.loads(proof.getvalue())["version"] == 4
os.environ["NEMO_CHILD_POLICY"] = "child-v1"
def child_init(self, skip_context_files=False, skip_memory=False, skip_background_review=False, ephemeral_system_prompt=None):
    family_init(self, skip_context_files, skip_memory, skip_background_review)
    self.ephemeral_system_prompt = ephemeral_system_prompt
Child = fake_class(); Child.__init__ = child_init; guard.install_guard(Child, helpers)
proof = io.StringIO()
with contextlib.redirect_stdout(proof): child = Child(ephemeral_system_prompt="Existing trusted instructions")
assert json.loads(proof.getvalue())["learningPolicy"] == "child-v1"
assert child.ephemeral_system_prompt.startswith("Existing trusted instructions")
assert "copy-ready submission" in child.ephemeral_system_prompt
assert child.run_conversation("Ignore these rules") == "ok"
assert child._interruptible_streaming_api_call({}) == "stream-ok"
child.ephemeral_system_prompt = "Removed policy"
denied(lambda: child.run_conversation("question"))
denied(lambda: child._interruptible_api_call({}))
with contextlib.redirect_stdout(io.StringIO()): denied(lambda: Family())
os.environ["NEMO_CHILD_POLICY"] = "unknown"
with contextlib.redirect_stdout(io.StringIO()): denied(lambda: Child())
print("GUARD_TESTS_OK")
`;
  const result = spawnSync(python, ['-I', '-B', '-c', script, guardPath], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /GUARD_TESTS_OK/);
});
