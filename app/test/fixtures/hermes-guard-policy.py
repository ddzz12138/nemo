"""Synthetic connection-policy tests: no Hermes imports, account data, or inference."""
import contextlib
import copy
import importlib.util
import io
import json
import sys
import types

spec = importlib.util.spec_from_file_location("nemo_guard_policy_test", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
calls = []


def regular(agent, api_kwargs):
    calls.append("inference")
    return "ok"


def streaming(agent, api_kwargs, *, on_first_delta=None):
    calls.append("stream")
    return "ok"


helpers = types.SimpleNamespace(interruptible_api_call=regular, interruptible_streaming_api_call=streaming)
selection_calls = []


def select(enabled_toolsets=None, disabled_toolsets=None, quiet_mode=False, skip_tool_search_assembly=False):
    selection_calls.append((enabled_toolsets, disabled_toolsets, quiet_mode, skip_tool_search_assembly))
    return ["direct-schemas"]


model_tools = types.SimpleNamespace(get_tool_definitions=select)
guard.use_direct_mcp_schemas(model_tools)
assert model_tools.get_tool_definitions(["nemo"], [], True) == ["direct-schemas"]
assert selection_calls == [(["nemo"], [], True, True)]
tools = [{"type": "function", "function": {"name": name, "parameters": copy.deepcopy(guard._PARAMETERS[name])}}
         for name in guard.CONNECTION_TOOL_NAMES]
for annotations in [{"readOnlyHint": True}, {"read_only_hint": True},
                    types.SimpleNamespace(readOnlyHint=True), types.SimpleNamespace(read_only_hint=True)]:
    assert guard.read_only_annotation(types.SimpleNamespace(annotations=annotations)) is True
for annotations in [None, {}, {"readOnlyHint": "true"}, {"read_only_hint": False},
                    {"readOnlyHint": True, "read_only_hint": False}, types.SimpleNamespace(read_only_hint=1)]:
    assert guard.read_only_annotation(types.SimpleNamespace(annotations=annotations)) is False


class Agent:
    def __init__(self, tools_override=None, names=None, mode="codex_responses"):
        self.tools = copy.deepcopy(tools if tools_override is None else tools_override)
        self.valid_tool_names = set(guard.CONNECTION_TOOL_NAMES) if names is None else names
        self.api_mode = mode

    def run_conversation(self, *args, **kwargs):
        return self._interruptible_api_call({})

    def _interruptible_api_call(self, api_kwargs):
        return regular(self, api_kwargs)

    def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
        return streaming(self, api_kwargs, on_first_delta=on_first_delta)

    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        calls.append("execute")

    def _run_codex_app_server_turn(self, *args, **kwargs):
        calls.append("unsafe-transport")


def denied(action):
    before = list(calls)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            action()
    except guard.ToolPolicyError:
        pass
    else:
        raise AssertionError("unsafe request was accepted")
    assert calls == before, "inference or execution ran before policy rejection"


guard.install_guard(Agent, helpers, guard.CONNECTION_TOOL_NAMES)
proof = io.StringIO()
with contextlib.redirect_stdout(proof):
    agent = Agent()
assert json.loads(proof.getvalue()) == {"type": "nemo_guard", "version": 2, "stage": "startup", "tools": list(guard.CONNECTION_TOOL_NAMES)}
assert agent._skip_mcp_refresh is True
flat = [{"type": "function", **copy.deepcopy(tool["function"])} for tool in tools]
assert agent._interruptible_api_call({"tools": flat}) == "ok"
assert agent._interruptible_streaming_api_call({"tools": tools}) == "ok"
assert agent.run_conversation("hello") == "ok"
for kwargs in [[], None, {"tools": False}, {"tools": [{"type": "web_search"}]},
               {"tools": [{"type": "function", "name": "terminal", "parameters": {}}]},
               {"functions": [{"name": "gmail_send"}]}, {"toolConfig": {}}, {"tools": [flat[0], flat[0]]}]:
    denied(lambda kwargs=kwargs: agent._interruptible_api_call(kwargs))
    denied(lambda kwargs=kwargs: agent._interruptible_streaming_api_call(kwargs))
changed = copy.deepcopy(flat)
changed[0]["parameters"]["properties"]["url"] = {"type": "string"}
denied(lambda: agent._interruptible_api_call({"tools": changed}))
ambiguous = {**copy.deepcopy(tools[0]), "name": "terminal"}
denied(lambda: agent._interruptible_api_call({"tools": [ambiguous]}))
for arguments in [None, [], {"limit": True}, {"limit": 0}, {"limit": 201}, {"url": "https://example.invalid"}]:
    denied(lambda arguments=arguments: guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[0], arguments))
for arguments in [{}, {"limit": 1}, {"limit": 11}, {"query": ""}, {"query": "x\n"}, {"query": "x" * 501}, {"query": 9}]:
    denied(lambda arguments=arguments: guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[1], arguments))
for arguments in [{}, {"limit": 1}, {"query": ""}, {"query": "x\n"}, {"query": "x" * 501},
                  {"query": 9}, {"query": "fixture", "limit": 11}, {"query": "fixture", "limit": True},
                  {"query": "fixture", "cursor": "a" * 64}, {"query": "fixture", "command": "must-not-run"}]:
    denied(lambda arguments=arguments: guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[2], arguments))
for arguments in [{"query": "fixture"}, {"query": "explicit saved note", "limit": 10}]:
    assert guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[2], arguments) is arguments
denied(lambda: guard.validate_tool_arguments("mcp__nemo__memory_save", {"content": "must-not-save"}))

valid_calendar_queries = [
    {"start": "2026-10-21T00:00:00+11:00", "end": "2026-10-22T00:00:00+11:00", "titleContains": "meeting", "limit": 2},
    {"start": "2026-10-20T23:00:00.123Z", "end": "2026-10-21T10:30:00+11:00"},
    {"start": "2024-02-29T00:00:00Z", "titleContains": "家族", "ifRevision": "a" * 64},
    {"end": "2026-10-22T00:00:00.1-05:00"},
]
for arguments in valid_calendar_queries:
    assert guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[0], arguments) is arguments
for index, arguments in enumerate([
    {"start": "2026-10-21"}, {"start": "2026-10-21T00:00:00"},
    {"start": "2026-10-21T00:00Z"}, {"start": "2026-10-21T00:00:00+1100"},
    {"start": "2026-02-30T00:00:00Z"}, {"start": "2026-10-21T24:00:00Z"},
    {"start": "2026-10-21T00:00:00+11:60"}, {"start": "2026-10-21T00:00:00+24:00"},
    {"start": "2026-10-21T00:00:00.1234Z"}, {"start": 9}, {"end": None},
    {"start": "2026-10-21T00:00:00Z", "end": "2026-10-21T00:00:00Z"},
    {"start": "2026-10-21T00:00:00Z", "end": "2026-10-21T10:00:00+11:00"},
    {"titleContains": ""}, {"titleContains": " "}, {"titleContains": "x" * 161},
    {"titleContains": "private\nvalue"}, {"titleContains": "x\x7f"}, {"titleContains": False},
    {"ifRevision": "a" * 63}, {"ifRevision": "A" * 64}, {"ifRevision": "a" * 64 + "\n"},
    {"ifRevision": []}, {"cursor": "a" * 64},
]):
    try:
        denied(lambda arguments=arguments: guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[0], arguments))
    except AssertionError:
        raise AssertionError(f"Invalid calendar query fixture {index} was accepted") from None
assert guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[1], {"cursor": "b" * 64}) == {"cursor": "b" * 64}
for arguments in [
    {"cursor": "b" * 63}, {"cursor": "B" * 64}, {"cursor": "b" * 64 + "\n"},
    {"cursor": None}, {"cursor": "b" * 64, "query": "flight"},
    {"cursor": "b" * 64, "limit": 10}, {"pageToken": "raw-google-token"},
    {"limit": True}, {"query": "flight", "limit": 5, "start": "2026-10-21T00:00:00Z"},
]:
    denied(lambda arguments=arguments: guard.validate_tool_arguments(guard.CONNECTION_TOOL_NAMES[1], arguments))
denied(lambda: guard.validate_tool_arguments("mcp__nemo__gmail_send", {}))


def call(name=guard.CONNECTION_TOOL_NAMES[0], arguments='{"limit":1}'):
    return types.SimpleNamespace(function=types.SimpleNamespace(name=name, arguments=arguments))


for batch in [None, [], [call(arguments="not-json")], [call(arguments="[]")],
              [call(), call(name="terminal")], [call(arguments='{"url":"bad"}')],
              [call(), call(arguments='{"start":"2026-02-30T00:00:00Z"}')],
              [call(name=guard.CONNECTION_TOOL_NAMES[1], arguments='{"cursor":"' + "b" * 64 + '","query":"changed-query"}')]]:
    denied(lambda batch=batch: agent._execute_tool_calls(types.SimpleNamespace(tool_calls=batch), [], "fixture"))
assert agent._nemo_tool_count == 0
for _ in range(guard.MAX_TOOL_CALLS):
    agent._execute_tool_calls(types.SimpleNamespace(tool_calls=[call()]), [], "fixture")
assert calls.count("execute") == guard.MAX_TOOL_CALLS
denied(lambda: agent._execute_tool_calls(types.SimpleNamespace(tool_calls=[call()]), [], "fixture"))
denied(lambda: agent._run_codex_app_server_turn())
agent.tools[0]["function"]["parameters"]["additionalProperties"] = True
denied(lambda: agent.run_conversation("unsafe changed surface"))
denied(lambda: agent._interruptible_api_call({}))
denied(lambda: agent._interruptible_streaming_api_call({}))
denied(lambda: agent._execute_tool_calls(types.SimpleNamespace(tool_calls=[call()]), [], "fixture"))
for kwargs in [{"tools_override": []}, {"names": {"terminal"}}, {"mode": "codex_app_server"}, {"mode": "anthropic_messages"}]:
    denied(lambda kwargs=kwargs: Agent(**kwargs))
print(json.dumps({"ok": True, "maxToolCalls": guard.MAX_TOOL_CALLS, "inference": "synthetic-only"}))
