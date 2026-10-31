"""Real Hermes registry and MCP transport fixture; no inference or real data."""
import importlib.util
import faulthandler
import json
import os
from pathlib import Path
import site
import socket
import sys

faulthandler.dump_traceback_later(20, exit=True)

source_root, site_packages, guard_path, real_home = sys.argv[1:]
sys.path.insert(0, source_root)
site.addsitedir(site_packages)
blocked_files = {str((Path(real_home) / name).resolve()).casefold()
                 for name in (".env", "auth.json", "config.yaml")}


def audit(event, args):
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        if str(Path(os.fsdecode(args[0])).resolve()).casefold() in blocked_files:
            raise AssertionError("Fixture attempted to open real Hermes configuration or credentials")
    if event == "socket.connect":
        address = args[1]
        if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("Fixture attempted non-loopback network access")


sys.addaudithook(audit)
spec = importlib.util.spec_from_file_location("nemo_mcp_guard_fixture", guard_path)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
guard.CONNECTION_TOOL_NAMES = guard.CONNECTION_TOOL_NAMES[:2]
expected = {"mcp__nemo__calendar_list", "mcp__nemo__gmail_search"}
try:
    names = guard.prepare_mcp_connections()
    assert set(names) == expected, "Guard must expose exactly the three Nemo reads"
    from tools.registry import registry
    from tools import mcp_tool, mcp_tool_config
    from tools.mcp_tool_scope import _key_name
    assert set(mcp_tool_config._load_mcp_config()) == {"nemo"}, "Unrelated MCP config must be isolated"
    assert {_key_name(key) for key in mcp_tool._servers} == {"nemo"}
    assert {name: value for hints in mcp_tool._tool_read_only_hints.values()
            for name, value in hints.items()} == {"calendar_list": True, "gmail_search": True}
    assert set(registry.get_tool_names_for_toolset("mcp-nemo")) == expected
    assert not any("unrelated" in name for name in registry.get_all_tool_names())
    from jsonschema import Draft202012Validator
    gmail_schema = registry.get_schema("mcp__nemo__gmail_search")["parameters"]
    Draft202012Validator.check_schema(gmail_schema)
    validator = Draft202012Validator(gmail_schema)
    for arguments in ({"query": "subject:fixture"}, {"query": "subject:fixture", "limit": 10},
                      {"cursor": "a" * 64}):
        assert validator.is_valid(arguments), "Advertised Gmail schema rejected valid search arguments"
    for arguments in ({}, {"limit": 10}, {"cursor": "a" * 64, "query": "subject:fixture"},
                      {"cursor": "a" * 64, "limit": 10},
                      {"cursor": "a" * 64, "query": "subject:fixture", "limit": 10}):
        assert not validator.is_valid(arguments), "Advertised Gmail schema accepted mixed continuation arguments"
    assert "mcp__nemo__memory_search" not in registry.get_tool_names_for_toolset("mcp-nemo")
    for name in expected:
        schema = registry.get_schema(name)
        assert schema["name"] == name
        assert schema["parameters"]["additionalProperties"] is False
        assert schema["parameters"] == guard._MCP_PARAMETERS[name]
    # Exercise the real schema selection seam too. Hermes's progressive tool
    # search bridge would otherwise replace these exact names during CLI init.
    import model_tools
    guard.use_direct_mcp_schemas(model_tools)
    definitions = model_tools.get_tool_definitions(enabled_toolsets=["nemo"], quiet_mode=True)
    assert {tool["function"]["name"] for tool in definitions} == expected
    for tool in definitions:
        name = tool["function"]["name"]
        assert tool["function"]["parameters"] == guard._PARAMETERS[name], "Normalized schema mismatch: " + json.dumps(tool["function"]["parameters"])
    result = registry.dispatch("mcp__nemo__calendar_list", {"limit": 1})
    rendered = result if isinstance(result, str) else json.dumps(result)
    assert "SYNTHETIC_MCP_EVENT_42" in rendered, rendered
    entry = registry.get_entry("mcp__nemo__calendar_list")
    original_handler = entry.handler
    unsafe_calls = []
    entry.handler = lambda args: unsafe_calls.append(args)
    try:
        registry.dispatch("mcp__nemo__calendar_list", {"limit": 1})
    except guard.ToolPolicyError:
        pass
    else:
        raise AssertionError("Registry accepted an in-place changed handler")
    assert unsafe_calls == []
    entry.handler = original_handler
    entry.schema["parameters"]["additionalProperties"] = True
    try:
        registry.dispatch("mcp__nemo__calendar_list", {"limit": 1})
    except guard.ToolPolicyError:
        pass
    else:
        raise AssertionError("Registry accepted an in-place widened schema")
    entry.schema["parameters"]["additionalProperties"] = False
    for name, args in (
        ("mcp__nemo__gmail_send", {"to": "nobody@example.invalid"}),
        ("terminal", {"command": "must-not-run"}),
        ("mcp__nemo__calendar_list", {"limit": 1, "command": "must-not-run"}),
        ("mcp__nemo__gmail_search", {"query": "fixture", "limit": 99}),
        ("mcp__nemo__memory_search", {"query": "fixture", "cursor": "a" * 64}),
        ("mcp__nemo__memory_save", {"content": "must-not-save"}),
    ):
        try:
            guard.validate_tool_arguments(name, args)
        except guard.ToolPolicyError:
            pass
        else:
            raise AssertionError("Guard accepted an unsafe tool or argument")
    try:
        registry.dispatch("terminal", {"command": "must-not-run"})
    except guard.ToolPolicyError:
        pass
    else:
        raise AssertionError("Registry execution guard accepted a forbidden tool")
    assert "run_agent" not in sys.modules, "MCP fixture must never construct a model client"
    faulthandler.cancel_dump_traceback_later()
    print("HERMES_MCP_FIXTURE_OK", flush=True)
finally:
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    shutdown_mcp_servers(timeout=5.0)
