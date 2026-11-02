"""Exercise the native-memory trust boundary without importing an AI runtime."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types

spec = importlib.util.spec_from_file_location("native_policy_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
tree = ast.parse(Path(sys.argv[2]).read_text(encoding="utf-8"))
schema = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == "MEMORY_SCHEMA" for target in node.targets))
root, profile_id = Path(sys.argv[3]), sys.argv[4]
home = root / "profiles" / profile_id / "hermes"
os.environ.update({"NEMO_MCP_POLICY": "family", "NEMO_MCP_PROFILE_ID": profile_id,
    "NEMO_MCP_CONFIG_DIR": str(root), "NEMO_MCP_DATA_DIR": str(home.parent),
    "NEMO_BUILTIN_MEMORY_HOME": str(home), "NEMO_BUILTIN_MEMORY": "profile",
    "HERMES_HOME": str(home), "NEMO_MCP_PERMISSION_REVISION": "0:0:false",
    "NEMO_CHATGPT_PLAN_BROKER": "http://127.0.0.1:4444/v1", "NEMO_CHATGPT_PLAN_CAPABILITY": "a" * 43})
os.environ.pop("NEMO_LOCAL_MODEL_BROKER", None)
guard.CONNECTION_TOOL_NAMES = ("memory",)
guard._BUILTIN_MEMORY_PARAMETERS = copy.deepcopy(schema["parameters"])
guard._PARAMETERS["memory"] = copy.deepcopy(schema["parameters"])
calls = []


def regular(agent, api_kwargs):
    calls.append("provider")
    return "ok"


def streaming(agent, api_kwargs, *, on_first_delta=None):
    calls.append("provider-stream")
    return "ok"


class Agent:
    def __init__(self, *, base_url=None, api_key=None, provider=None,
                 requested_provider=None, api_mode=None, model=None,
                 fallback_model=None, credential_pool=None, request_overrides=None,
                 skip_context_files=False, skip_memory=False, skip_background_review=False,
                 enabled_toolsets=None, ephemeral_system_prompt=None):
        assert (skip_context_files, skip_memory, skip_background_review) == (True, True, True)
        assert enabled_toolsets == ["memory"]
        self.base_url, self.api_key, self.api_mode, self.model = base_url, api_key, api_mode, model
        self._fallback_chain = []
        self.ephemeral_system_prompt = ephemeral_system_prompt
        self.tools = [{"type": "function", "function": {"name": "memory", "parameters": copy.deepcopy(schema["parameters"])}}]
        self.valid_tool_names = {"memory"}
        self._memory_store = types.SimpleNamespace(memory_char_limit=2200, user_char_limit=1375)
        self._memory_enabled = self._user_profile_enabled = True
        self._memory_manager = None

    def run_conversation(self, *args, **kwargs):
        return self._interruptible_api_call({})

    def _interruptible_api_call(self, api_kwargs):
        return regular(self, api_kwargs)

    def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
        return streaming(self, api_kwargs, on_first_delta=on_first_delta)

    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        calls.append("execute")
        return "executed"

    def _run_codex_app_server_turn(self, *args, **kwargs):
        calls.append("unapproved-app-server")


def rejected(operation):
    before = list(calls)
    try:
        operation()
    except guard.ToolPolicyError:
        pass
    else:
        raise AssertionError("Unapproved operation was admitted")
    assert calls == before


helpers = types.SimpleNamespace(interruptible_api_call=regular, interruptible_streaming_api_call=streaming)
guard.install_guard(Agent, helpers, ("memory",))
proof = io.StringIO()
with contextlib.redirect_stdout(proof):
    agent = Agent()
assert json.loads(proof.getvalue()) == {"type": "nemo_guard", "version": 5, "stage": "startup",
    "tools": ["memory"], "builtinMemory": True, "isolated": True, "learningPolicy": "standard-v1"}
assert agent.run_conversation("Synthetic query") == "ok"
assert agent._interruptible_api_call({"tools": agent.tools}) == "ok"
guard.validate_memory_arguments({"target": "user", "action": "add", "content": "Prefers concise replies."})
guard.validate_memory_arguments({"target": "user", "operations": [{"action": "remove", "old_text": "old"}, {"action": "add", "new_text": "new"}]})
for arguments in [{}, {"target": "user", "action": "read"},
        {"target": "user", "action": "add", "content": "x", "path": "/outside"},
        {"target": "user", "action": "replace", "content": "new"},
        {"target": "user", "action": "add", "content": "x" * 2201},
        {"target": "user", "operations": []},
        {"target": "user", "operations": [{"action": "add", "target": "memory", "content": "x"}]}]:
    rejected(lambda arguments=arguments: guard.validate_memory_arguments(arguments))


def message(name, arguments):
    return types.SimpleNamespace(tool_calls=[types.SimpleNamespace(function=types.SimpleNamespace(name=name, arguments=json.dumps(arguments)))])


assert agent._execute_tool_calls(message("memory", {"target": "user", "action": "add", "content": "Synthetic note"}), [], "task") == "executed"
rejected(lambda: agent._execute_tool_calls(message("terminal", {"command": "outside"}), [], "task"))
rejected(lambda: agent._execute_tool_calls(message("memory", {"target": "user", "action": "remove", "path": "outside"}), [], "task"))
rejected(lambda: agent._run_codex_app_server_turn())
agent.tools[0]["function"]["parameters"]["properties"]["action"]["enum"].append("read")
with contextlib.redirect_stdout(io.StringIO()):
    rejected(lambda: agent._interruptible_api_call({}))
agent.tools[0]["function"]["parameters"] = copy.deepcopy(schema["parameters"])
marker = home / "nemo-profile.json"
original = marker.read_text(encoding="utf-8")
marker.write_text(json.dumps({"version": 1, "profileId": "wrong-owner"}), encoding="utf-8")
with contextlib.redirect_stdout(io.StringIO()):
    rejected(lambda: agent._interruptible_api_call({}))
marker.write_text(original, encoding="utf-8")

registry_path = root / "profiles.json"
registry = json.loads(registry_path.read_text(encoding="utf-8"))
current = next(profile for profile in registry["profiles"] if profile["id"] == profile_id)
current["policyRevision"] = 1
registry_path.write_text(json.dumps(registry), encoding="utf-8")
with contextlib.redirect_stdout(io.StringIO()):
    rejected(lambda: agent._interruptible_api_call({}))
os.environ["NEMO_MCP_PERMISSION_REVISION"] = "1:0:false"
assert agent._interruptible_api_call({}) == "ok"
current.update({"role": "member", "classification": "child", "capabilityGrants": {"memory": True}})
registry_path.write_text(json.dumps(registry), encoding="utf-8")
state_path = home / "nemo-memory-state.json"
state_path.write_text(json.dumps({"version": 1, "sources": {"gmail": False, "calendar": False}}), encoding="utf-8")
assert agent._interruptible_api_call({}) == "ok"
state_path.write_text(json.dumps({"version": 1, "sources": {"gmail": True, "calendar": False}}), encoding="utf-8")
with contextlib.redirect_stdout(io.StringIO()):
    rejected(lambda: agent._interruptible_api_call({}))
state_path.write_text(json.dumps({"version": 1, "sources": {"gmail": False, "calendar": False}}), encoding="utf-8")
current["capabilityGrants"]["memory"] = False
registry_path.write_text(json.dumps(registry), encoding="utf-8")
with contextlib.redirect_stdout(io.StringIO()):
    rejected(lambda: agent._interruptible_api_call({}))
print(json.dumps({"ok": True, "provider": "synthetic-only", "nativeTool": "memory", "isolated": True}))
