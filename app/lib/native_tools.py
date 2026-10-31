"""Managed read-tool adapters: only a task-bound broker grant enters a worker.

No connector files, Google grants or account-selection parameters live here.
The trusted host resolves all private state from the authenticated worker grant.
"""
import copy
import json
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def install(guard, config):
    declarations = config.get("nemo_read_tools", [])
    if type(declarations) is not list or not declarations or len(declarations) > 3:
        raise RuntimeError("Invalid managed read-tool set")
    definitions = []
    for tool in declarations:
        if type(tool) is not dict or set(tool) != {"name", "description", "inputSchema", "annotations"}:
            raise RuntimeError("Invalid managed read schema")
        name = "mcp__nemo__" + str(tool["name"])
        raw = copy.deepcopy(tool["inputSchema"])
        raw.setdefault("required", [])
        if name not in guard.CONNECTION_TOOL_NAMES or raw != guard._MCP_PARAMETERS[name]:
            raise RuntimeError("Managed read schema changed")
        definitions.append({"type": "function", "function": {
            "name": name, "description": tool["description"],
            "parameters": copy.deepcopy(guard._PARAMETERS[name])}})
    names = tuple(item["function"]["name"] for item in definitions)
    if len(set(names)) != len(names):
        raise RuntimeError("Duplicate managed read declaration")
    guard.CONNECTION_TOOL_NAMES = names
    from tools.registry import registry
    handlers, entries = {}, {}

    def relay(name, arguments):
        guard.validate_tool_arguments(name, arguments)
        request = Request(config["model"]["base_url"] + "/nemo/tools/call",
                          data=json.dumps({"callId": str(uuid.uuid4()),
                                           "name": name.removeprefix("mcp__nemo__"),
                                           "arguments": arguments}).encode("utf-8"),
                          headers={"Content-Type": "application/json",
                                   "Authorization": "Bearer " + config["model"]["api_key"]},
                          method="POST")
        try:
            with urlopen(request, timeout=30) as response:
                content = response.read(500_001)
            if len(content) > 500_000:
                raise RuntimeError("Read result too large")
            return json.dumps(json.loads(content), separators=(",", ":"))
        except HTTPError as error:
            return json.dumps({"error": "Connection unavailable or permission changed. No data was changed.", "code": "NATIVE_TOOL_HTTP", "status": error.code})
        except Exception as error:
            return json.dumps({"error": "Connection unavailable or permission changed. No data was changed.", "code": "NATIVE_TOOL_UNAVAILABLE", "kind": type(error).__name__ if isinstance(error, (URLError, TimeoutError, PermissionError, ValueError)) else "Unavailable"})

    for declaration in definitions:
        name = declaration["function"]["name"]
        def handler(args, _name=name, **kwargs):
            return relay(_name, args)
        handlers[name] = handler
        registry.register(name=name, toolset="mcp-nemo", schema=declaration["function"], handler=handler)
        entries[name] = registry.get_entry(name)

    dispatch = registry.dispatch
    def checked_dispatch(name, args, *, scope=None, **kwargs):
        if name not in handlers:
            raise guard.ToolPolicyError("Managed native worker blocked an unapproved tool")
        entry = registry.get_entry(name, scope=scope)
        if entry is not entries[name] or entry.handler is not handlers[name] or entry.schema != next(item["function"] for item in definitions if item["function"]["name"] == name):
            raise guard.ToolPolicyError("Managed native tool registration changed")
        guard.validate_tool_arguments(name, args)
        return dispatch(name, args, scope=scope, **kwargs)
    registry.dispatch = checked_dispatch
    import model_tools
    # Avoid the broader generic tool-search bridge. The guard rechecks these
    # exact schemas on every provider request and complete execution batch.
    model_tools.get_tool_definitions = lambda *args, **kwargs: copy.deepcopy(definitions)
    return names
