"""Per-process tool policy for the known Hermes CLI transport.

This controls the agent tool surface, not arbitrary installed Python plugins or
shell hooks. It never writes Hermes configuration or handles login credentials.
"""

import atexit
import copy
import inspect
import json
import os
import re
import runpy
import stat
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


class ToolPolicyError(RuntimeError):
    pass


def chatgpt_plan_route():
    """Only the trusted Node host can provide the ephemeral plan adapter."""
    value = os.environ.get("NEMO_CHATGPT_PLAN_BROKER")
    if value is None:
        return None
    parsed = urlparse(value)
    capability = os.environ.get("NEMO_CHATGPT_PLAN_CAPABILITY", "")
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.path != "/v1" or parsed.query or parsed.fragment
            or parsed.username or parsed.password or not parsed.port
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", capability)):
        raise ToolPolicyError("Nemo ChatGPT connection is invalid.")
    return {"base_url": value, "api_key": capability, "port": parsed.port}


def managed_model_route():
    value = os.environ.get("NEMO_LOCAL_MODEL_BROKER")
    if value is not None:
        if os.environ.get("NEMO_CHATGPT_PLAN_BROKER") is not None:
            raise ToolPolicyError("Nemo assistant routes conflict.")
        parsed = urlparse(value)
        capability = os.environ.get("NEMO_LOCAL_MODEL_CAPABILITY", "")
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or parsed.path != "/v1" or parsed.query or parsed.fragment
                or parsed.username or parsed.password or not parsed.port
                or not re.fullmatch(r"[A-Za-z0-9_-]{43}", capability)):
            raise ToolPolicyError("Nemo local assistant connection is invalid.")
        return {"base_url": value, "api_key": capability, "port": parsed.port,
                "model": "nemo-local-gemma4", "local": True}
    route = chatgpt_plan_route()
    return {**route, "model": "nemo-chatgpt-plan", "local": False} if route else None


def isolate_chatgpt_plan_network():
    route = managed_model_route()
    if route is None:
        return
    # Configured provider fallbacks and auxiliary inference must not escape the
    # plan adapter. Client-side MCP tools run in their separately guarded Node
    # process and do not receive the adapter capability or OAuth credential.
    # Windows asyncio uses socket.socketpair() for its private event-loop wakeup
    # pipe. Permit only socketpair's construction, not arbitrary loopback routes.
    import socket
    pair_state = threading.local()
    original_socketpair = socket.socketpair
    def local_socketpair(*args, **kwargs):
        previous = getattr(pair_state, "constructing", False)
        pair_state.constructing = True
        try:
            return original_socketpair(*args, **kwargs)
        finally:
            pair_state.constructing = previous
    socket.socketpair = local_socketpair
    def audit(event, arguments):
        if event == "socket.connect":
            address = arguments[1]
            if (getattr(pair_state, "constructing", False)
                    and isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1")):
                return
            if (not isinstance(address, tuple) or len(address) < 2
                    or address[0] != "127.0.0.1" or address[1] != route["port"]):
                raise ToolPolicyError("Nemo blocked another AI connection.")
        elif event == "socket.getaddrinfo" and arguments[0] != "127.0.0.1":
            if getattr(pair_state, "constructing", False) and arguments[0] in ("localhost", "::1"):
                return
            raise ToolPolicyError("Nemo blocked another AI connection.")
    sys.addaudithook(audit)


def install_chatgpt_plan_resolution():
    route = managed_model_route()
    if route is None:
        return
    from hermes_cli import runtime_provider
    for name, required in (("resolve_runtime_provider", ("requested", "explicit_api_key", "explicit_base_url", "target_model")),
                           ("resolve_runtime_with_fallback", ("config", "requested", "target_model", "explicit_base_url", "explicit_api_key"))):
        function = getattr(runtime_provider, name, None)
        if not callable(function) or any(key not in inspect.signature(function).parameters for key in required):
            raise ToolPolicyError("Nemo ChatGPT resolution seam changed.")
    def resolve_plan(**_kwargs):
        return {"provider": "custom", "api_mode": "chat_completions",
                "base_url": route["base_url"], "api_key": route["api_key"],
                "model": route["model"], "requested_provider": "custom",
                "source": route["model"], "credential_pool": None}
    runtime_provider.resolve_runtime_provider = resolve_plan
    runtime_provider.resolve_runtime_with_fallback = lambda config, **kwargs: (resolve_plan(), None)
    # Nemo already derives a visible conversation title. Do not spend another
    # plan request on Hermes's background title upgrade after a successful reply.
    from agent import title_generator
    if not callable(getattr(title_generator, "_model_title_upgrade_enabled", None)):
        raise ToolPolicyError("Nemo ChatGPT title seam changed.")
    title_generator._model_title_upgrade_enabled = lambda: False


ALLOWED_API_MODES = frozenset({
    "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse",
})
_NO_REQUEST = object()
CONNECTION_TOOL_NAMES = ("mcp__nemo__calendar_list", "mcp__nemo__gmail_search", "mcp__nemo__memory_search")
_PARAMETERS = {
    CONNECTION_TOOL_NAMES[0]: {"type": "object", "properties": {
        "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        "start": {"type": "string", "maxLength": 40},
        "end": {"type": "string", "maxLength": 40},
        "titleContains": {"type": "string", "maxLength": 160},
        "ifRevision": {"type": "string", "minLength": 64, "maxLength": 64}}, "additionalProperties": False, "required": []},
    CONNECTION_TOOL_NAMES[1]: {"type": "object", "properties": {
        "query": {"type": "string", "maxLength": 500},
        "limit": {"type": "integer", "minimum": 1, "maximum": 10},
        "cursor": {"type": "string", "minLength": 64, "maxLength": 64}}, "additionalProperties": False, "required": []},
    CONNECTION_TOOL_NAMES[2]: {"type": "object", "properties": {
        "query": {"type": "string", "minLength": 1, "maxLength": 500},
        "limit": {"type": "integer", "minimum": 1, "maximum": 10},
        "source": {"type": "string", "enum": ["notes", "gmail", "all"]}}, "additionalProperties": False, "required": ["query"]},
}
# The installed Hermes sanitizer drops conditional-schema keywords before agent
# construction. Verify that exact projection at the agent/provider boundary,
# and the complete raw schema at registration. Execution validation below still
# requires an explicit query or a cursor-only continuation before any dispatch.
_MCP_PARAMETERS = copy.deepcopy(_PARAMETERS)
_MCP_PARAMETERS[CONNECTION_TOOL_NAMES[1]]["anyOf"] = [{"required": ["query"]}, {"required": ["cursor"]}]
_MCP_PARAMETERS[CONNECTION_TOOL_NAMES[1]]["not"] = {
    "anyOf": [{"required": ["cursor", "query"]}, {"required": ["cursor", "limit"]}]}
MAX_TOOL_CALLS = 6
_ISO_QUERY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])")
_OPAQUE_ID = re.compile(r"[a-f0-9]{64}")


def _query_date(value):
    if type(value) is not str or len(value) > 40 or _ISO_QUERY.fullmatch(value) is None:
        raise ToolPolicyError("Nemo blocked an invalid calendar date filter.")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, OverflowError):
        raise ToolPolicyError("Nemo blocked an invalid calendar date filter.") from None


def emit_policy_error(stage, error, agent=None, event_sink=None):
    # Only static exception messages raised in this module map to public codes.
    # No raw tool names, schemas, account state or provider diagnostics leave here.
    codes = {
        "Nemo connection tools must be a list.": "CONNECTION_TOOLS_SHAPE",
        "Nemo connection tool names must be a set.": "CONNECTION_NAMES_SHAPE",
        "Nemo connection tool names changed.": "CONNECTION_NAMES_CHANGED",
        "Nemo connection provider transport is unsupported.": "CONNECTION_API_MODE",
        "Nemo connection tool schemas changed.": "CONNECTION_SCHEMA_CHANGED",
        "Nemo requires exactly its three read-only connection tools.": "CONNECTION_TOOL_COUNT",
        "Nemo blocked a non-function tool declaration.": "CONNECTION_NON_FUNCTION",
        "Nemo blocked an unapproved tool declaration.": "CONNECTION_UNAPPROVED_TOOL",
        "Nemo blocked an ambiguous nested tool declaration.": "CONNECTION_AMBIGUOUS_SCHEMA",
        "Nemo blocked an unsupported flat tool declaration.": "CONNECTION_FLAT_SCHEMA",
        "Nemo blocked an unsupported function declaration.": "CONNECTION_FUNCTION_SCHEMA",
        "Nemo MCP did not register its exact read-only tool set.": "MCP_REGISTRATION",
        "Nemo MCP registry provenance or schema changed.": "MCP_REGISTRY_SCHEMA",
        "Nemo MCP launch configuration is invalid.": "MCP_LAUNCH_CONFIGURATION",
        "Nemo profile context is missing.": "MCP_PROFILE_CONTEXT_MISSING",
        "Nemo profile context does not match its private directory.": "MCP_PROFILE_PATH_MISMATCH",
        "Nemo MCP data directory must be absolute.": "MCP_DATA_DIRECTORY",
        "Nemo connection permissions are invalid.": "MCP_PERMISSION_SELECTION",
    }
    metrics = {}
    if agent is not None:
        names = getattr(agent, "valid_tool_names", None)
        tools = getattr(agent, "tools", None)
        metrics = {"toolCount": len(tools) if type(tools) is list else None,
                   "expectedNamesPresent": [name in names for name in CONNECTION_TOOL_NAMES] if type(names) is set else [],
                   "unexpectedNameCount": len(names - set(CONNECTION_TOOL_NAMES)) if type(names) is set else None}
    value = {"type": "nemo_guard_error", "version": 1, "stage": stage,
             "code": codes.get(str(error), "TOOL_POLICY_REJECTED"), **metrics}
    if event_sink is not None: event_sink(value)
    else: print(json.dumps(value), flush=True)


def validate_tool_arguments(name, arguments):
    """Validate the exact read-only schemas again at the execution boundary."""
    if name not in CONNECTION_TOOL_NAMES or type(arguments) is not dict:
        raise ToolPolicyError("Nemo blocked an unapproved tool or argument shape.")
    calendar = name == "mcp__nemo__calendar_list"
    memory = name == "mcp__nemo__memory_search"
    allowed = ({"limit", "start", "end", "titleContains", "ifRevision"} if calendar
               else {"query", "limit", "source"} if memory else {"query", "limit", "cursor"})
    if set(arguments) - allowed:
        raise ToolPolicyError("Nemo blocked an unknown tool argument.")
    if memory and "source" in arguments and arguments["source"] not in ("notes", "gmail", "all"):
        raise ToolPolicyError("Nemo blocked an invalid memory source.")
    if memory and "query" not in arguments:
        raise ToolPolicyError("Nemo requires a specific saved memory query.")
    if not calendar and not memory and "query" not in arguments and "cursor" not in arguments:
        raise ToolPolicyError("Nemo requires a specific Gmail query or continuation.")
    if "limit" in arguments:
        maximum = 200 if calendar else 10
        if type(arguments["limit"]) is not int or not 1 <= arguments["limit"] <= maximum:
            raise ToolPolicyError("Nemo blocked an invalid result limit.")
    if "query" in arguments:
        query = arguments["query"]
        if type(query) is not str or not query.strip() or len(query) > 500 or any(ord(c) < 32 or ord(c) == 127 for c in query):
            raise ToolPolicyError("Nemo blocked an invalid lookup query.")
    if calendar:
        dates = {field: _query_date(arguments[field]) for field in ("start", "end") if field in arguments}
        if "start" in dates and "end" in dates and dates["end"] <= dates["start"]:
            raise ToolPolicyError("Nemo blocked an invalid calendar date range.")
        if "titleContains" in arguments:
            title = arguments["titleContains"]
            if type(title) is not str or not title.strip() or len(title) > 160 or any(ord(c) < 32 or ord(c) == 127 for c in title):
                raise ToolPolicyError("Nemo blocked an invalid calendar title filter.")
        if "ifRevision" in arguments:
            revision = arguments["ifRevision"]
            if type(revision) is not str or _OPAQUE_ID.fullmatch(revision) is None:
                raise ToolPolicyError("Nemo blocked an invalid calendar revision.")
    elif "cursor" in arguments:
        cursor = arguments["cursor"]
        if type(cursor) is not str or _OPAQUE_ID.fullmatch(cursor) is None or "query" in arguments or "limit" in arguments:
            raise ToolPolicyError("Nemo blocked an invalid Gmail continuation cursor.")
    return arguments


def _schema_name(tool, *, provider=False):
    if type(tool) is not dict or tool.get("type") != "function":
        raise ToolPolicyError("Nemo blocked a non-function tool declaration.")
    if "function" in tool:
        if set(tool) != {"type", "function"}:
            raise ToolPolicyError("Nemo blocked an ambiguous nested tool declaration.")
    elif not provider or set(tool) - {"type", "name", "description", "parameters", "strict"}:
        raise ToolPolicyError("Nemo blocked an unsupported flat tool declaration.")
    function = tool.get("function") if "function" in tool else tool if provider else None
    if type(function) is not dict or function.get("name") not in CONNECTION_TOOL_NAMES:
        raise ToolPolicyError("Nemo blocked an unapproved tool declaration.")
    if "function" in tool and set(function) - {"name", "description", "parameters", "strict"}:
        raise ToolPolicyError("Nemo blocked an unsupported function declaration.")
    name = function["name"]
    if function.get("parameters") != _PARAMETERS[name]:
        raise ToolPolicyError("Nemo connection tool schemas changed.")
    return name


def assert_connection_tools(agent, api_kwargs=_NO_REQUEST):
    if type(getattr(agent, "tools", None)) is not list:
        raise ToolPolicyError("Nemo connection tools must be a list.")
    if type(getattr(agent, "valid_tool_names", None)) is not set:
        raise ToolPolicyError("Nemo connection tool names must be a set.")
    if agent.valid_tool_names != set(CONNECTION_TOOL_NAMES):
        raise ToolPolicyError("Nemo connection tool names changed.")
    if getattr(agent, "api_mode", None) not in {"chat_completions", "codex_responses"}:
        raise ToolPolicyError("Nemo connection provider transport is unsupported.")
    names = [_schema_name(tool) for tool in agent.tools]
    if len(names) != len(CONNECTION_TOOL_NAMES) or set(names) != set(CONNECTION_TOOL_NAMES):
        raise ToolPolicyError("Nemo requires exactly its three read-only connection tools.")
    if api_kwargs is not _NO_REQUEST:
        if type(api_kwargs) is not dict:
            raise ToolPolicyError("Hermes provider request shape changed.")
        tools = api_kwargs.get("tools")
        if tools is not None:
            if type(tools) is not list:
                raise ToolPolicyError("Nemo blocked a malformed provider tool list.")
            names = [_schema_name(tool, provider=True) for tool in tools]
            if len(set(names)) != len(names):
                raise ToolPolicyError("Nemo blocked duplicate provider tools.")
        if api_kwargs.get("functions") not in (None, []) or api_kwargs.get("toolConfig") is not None:
            raise ToolPolicyError("Nemo blocked an unsupported provider tool transport.")


def read_only_annotation(tool):
    """MCP SDK 1.x uses camelCase; 2.x uses snake_case attributes.

    Missing, false, non-boolean, or conflicting hints remain write-capable.
    This compatibility shim is limited to Nemo's ephemeral Hermes process.
    """
    annotations = getattr(tool, "annotations", None)
    missing = object()
    if isinstance(annotations, dict):
        values = [annotations[key] for key in ("read_only_hint", "readOnlyHint") if key in annotations]
    else:
        values = [value for key in ("read_only_hint", "readOnlyHint")
                  if (value := getattr(annotations, key, missing)) is not missing]
    return bool(values) and all(value is True for value in values)


def isolate_mcp_configuration(servers):
    """Override discovery in this process; never load or persist the user's MCP configuration."""
    from tools import mcp_tool_config, mcp_tool_registration, mcp_tool_discovery
    from hermes_cli import mcp_startup
    fixed = copy.deepcopy(servers)
    mcp_tool_config._load_mcp_config = lambda: copy.deepcopy(fixed)
    mcp_startup._has_configured_mcp_servers = lambda: bool(fixed)
    mcp_tool_discovery._discovery_connect_concurrency = lambda: 1
    # The explicit ephemeral server must not modify Hermes's persistent schema cache.
    mcp_tool_registration._write_schema_cache = lambda *args, **kwargs: None
    mcp_tool_registration._annotation_read_only_hint = read_only_annotation
    sink = open(os.devnull, "a", encoding="utf-8")
    atexit.register(sink.close)
    mcp_tool_config._get_mcp_stderr_log = lambda: sink

    def safe_child_env(user_env=None):
        # Never forward Hermes provider credentials or external secret-source variables.
        permitted = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC",
                     "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
                     "PROGRAMFILES(X86)", "PROGRAMDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL"}
        env = {key: value for key, value in os.environ.items() if key.upper() in permitted}
        env.update(user_env or {})
        return env

    mcp_tool_config._build_safe_env = safe_child_env


def same_windows_directory_alias(logical, physical):
    """Accept AppData virtualization only with a matching directory file ID.

    Individual profile or profiles-directory reparse points remain forbidden.
    A resolved path string alone cannot establish an alias inside a family root.
    """
    if os.name != "nt":
        return False
    try:
        for path in (logical.parent, logical):
            info = path.lstat()
            attributes = getattr(info, "st_file_attributes", None)
            if (not stat.S_ISDIR(info.st_mode) or type(attributes) is not int
                    or attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                return False
        left, right = logical.stat(), physical.stat()
        return (stat.S_ISDIR(left.st_mode) and stat.S_ISDIR(right.st_mode)
                and left.st_ino != 0 and left.st_dev == right.st_dev
                and left.st_ino == right.st_ino)
    except OSError:
        return False


def profile_mcp_context(data_dir, config_dir, profile_id):
    """Bind the physical profile, then use one logical root for the child.

    Windows application virtualization can resolve the profile to a physical
    alias while the configured root retains its logical name. Never mix those
    representations at the Node boundary, or rewrite the saved configuration.
    """
    if (not isinstance(data_dir, str) or not isinstance(config_dir, str)
            or not isinstance(profile_id, str)
            or re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", profile_id) is None
            or not Path(data_dir).is_absolute() or not Path(config_dir).is_absolute()):
        raise ToolPolicyError("Nemo profile context is missing.")
    root = Path(config_dir)
    physical_profile = root.resolve() / "profiles" / profile_id
    resolved_profile = physical_profile.resolve()
    if (Path(data_dir).resolve() != resolved_profile
            or (resolved_profile != physical_profile
                and not same_windows_directory_alias(physical_profile, resolved_profile))):
        raise ToolPolicyError("Nemo profile context does not match its private directory.")
    return str(root / "profiles" / profile_id), str(root)


def prepare_mcp_connections():
    """Register only the sibling Nemo stdio server and return its exact tool names.

    Paths come from Nemo's trusted server configuration, never a phone request.
    A fixture data directory is supported without touching any real account data.
    """
    command = Path(os.environ.get("NEMO_MCP_COMMAND", ""))
    server = Path(os.environ.get("NEMO_MCP_SERVER", ""))
    expected = Path(__file__).resolve().parent.parent / "mcp-server.mjs"
    if (not command.is_absolute() or not command.is_file() or command.name.lower() not in {"node", "node.exe"}
            or not server.is_absolute() or not server.is_file() or server.resolve() != expected):
        raise ToolPolicyError("Nemo MCP launch configuration is invalid.")
    child_env = {"NEMO_MCP_LIFETIME_MS": "120000"}
    data_dir = os.environ.get("NEMO_MCP_DATA_DIR")
    if data_dir:
        if not Path(data_dir).is_absolute():
            raise ToolPolicyError("Nemo MCP data directory must be absolute.")
        child_env["NEMO_MCP_DATA_DIR"] = str(Path(data_dir).resolve())
    if os.environ.get("NEMO_MCP_POLICY") == "family":
        profile_id = os.environ.get("NEMO_MCP_PROFILE_ID", "")
        if re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", profile_id) is None or not data_dir:
            raise ToolPolicyError("Nemo profile context is missing.")
        profile_data, profile_root = profile_mcp_context(data_dir, os.environ.get("NEMO_MCP_CONFIG_DIR"), profile_id)
        child_env["NEMO_MCP_DATA_DIR"] = profile_data
        child_env["NEMO_MCP_PROFILE_ID"] = profile_id
        child_env["NEMO_MCP_CONFIG_DIR"] = profile_root
        child_env["NEMO_MCP_POLICY"] = "family"
        if os.environ.get("NEMO_MCP_MEMORY") == "profile":
            child_env["NEMO_MCP_MEMORY"] = "profile"
        for key in ("NEMO_MCP_ALLOWED_TOOLS", "NEMO_MCP_PERMISSION_REVISION"):
            if key in os.environ:
                child_env[key] = os.environ[key]
    servers = {"nemo": {"command": str(command), "args": [str(server)], "env": child_env,
                        "connect_timeout": 20, "timeout": 20, "lazy": False, "trust": "untrusted",
                        "tools": {"include": [name.removeprefix("mcp__nemo__") for name in CONNECTION_TOOL_NAMES], "resources": False, "prompts": False}}}
    isolate_mcp_configuration(servers)
    from tools.mcp_tool_discovery import register_mcp_servers
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.registry import registry
    names = register_mcp_servers(servers)
    if len(names) != len(CONNECTION_TOOL_NAMES) or set(names) != set(CONNECTION_TOOL_NAMES):
        shutdown_mcp_servers()
        raise ToolPolicyError("Nemo MCP did not register its exact read-only tool set.")
    entries = {name: registry.get_entry(name) for name in CONNECTION_TOOL_NAMES}
    for name, entry in entries.items():
        if (entry is None or entry.toolset != "mcp-nemo"
                or entry.handler.__module__ != "tools.mcp_tool_handlers"
                or entry.schema.get("parameters") != _MCP_PARAMETERS[name]):
            shutdown_mcp_servers()
            raise ToolPolicyError("Nemo MCP registry provenance or schema changed.")
    handlers = {name: entry.handler for name, entry in entries.items()}
    schemas = {name: copy.deepcopy(entry.schema) for name, entry in entries.items()}
    original_dispatch = registry.dispatch
    calls = 0
    lock = threading.Lock()
    deadline = time.monotonic() + 120

    def guarded_dispatch(name, args, *, scope=None, **kwargs):
        nonlocal calls
        validate_tool_arguments(name, args)
        with lock:
            if calls >= MAX_TOOL_CALLS or time.monotonic() >= deadline:
                raise ToolPolicyError("Nemo reached its connection tool budget.")
            entry = registry.get_entry(name, scope=scope)
            if (entry is not entries[name] or entry.handler is not handlers[name]
                    or entry.toolset != "mcp-nemo" or entry.schema != schemas[name]):
                raise ToolPolicyError("Nemo connection tool registration changed.")
            calls += 1
        return original_dispatch(name, args, scope=scope, **kwargs)

    registry.dispatch = guarded_dispatch
    atexit.register(lambda: shutdown_mcp_servers(timeout=5.0))
    return CONNECTION_TOOL_NAMES


def assert_no_tools(agent, api_kwargs=_NO_REQUEST):
    # Missing/wrongly shaped attributes are a failed assertion, never defaults.
    if (type(getattr(agent, "tools", None)) is not list or agent.tools != []
            or type(getattr(agent, "valid_tool_names", None)) is not set
            or agent.valid_tool_names != set()
            or getattr(agent, "api_mode", None) not in ALLOWED_API_MODES):
        raise ToolPolicyError("Nemo requires a verified empty agent tool surface.")
    if api_kwargs is not _NO_REQUEST:
        if type(api_kwargs) is not dict:
            raise ToolPolicyError("Hermes provider request shape changed.")
        tools = api_kwargs.get("tools")
        if tools is not None and (type(tools) is not list or tools != []):
            raise ToolPolicyError("Nemo blocked provider tools in chat-only mode.")
        # Legacy OpenAI tool declarations must also remain absent/empty.
        functions = api_kwargs.get("functions")
        if functions is not None and (type(functions) is not list or functions != []):
            raise ToolPolicyError("Nemo blocked legacy provider tools.")
        if api_kwargs.get("toolConfig") is not None:
            raise ToolPolicyError("Nemo blocked an unsupported provider tool transport.")


def _require_signature(function, names, keyword_only=()):
    if not callable(function):
        raise ToolPolicyError("Hermes transport is missing a required guard seam.")
    parameters = list(inspect.signature(function).parameters.values())
    if [parameter.name for parameter in parameters] != list(names):
        raise ToolPolicyError("Hermes transport signature changed.")
    for parameter in parameters:
        required_kind = (inspect.Parameter.KEYWORD_ONLY if parameter.name in keyword_only
                         else inspect.Parameter.POSITIONAL_OR_KEYWORD)
        if parameter.kind is not required_kind:
            raise ToolPolicyError("Hermes transport argument convention changed.")


def use_direct_mcp_schemas(model_tools):
    """Keep the three exact tools visible in this process.

    Current Hermes defers any MCP tool behind tool_search/tool_describe/tool_call
    even with its default `auto` setting. Those generic bridge tools are outside
    Nemo's grant. Use the supported raw-schema switch instead, without changing
    the user's persistent tool-search settings or relaxing the allowlist.
    """
    original = getattr(model_tools, "get_tool_definitions", None)
    _require_signature(original, ("enabled_toolsets", "disabled_toolsets", "quiet_mode", "skip_tool_search_assembly"))

    def direct_definitions(enabled_toolsets=None, disabled_toolsets=None, quiet_mode=False, skip_tool_search_assembly=False):
        return original(enabled_toolsets, disabled_toolsets, quiet_mode, skip_tool_search_assembly=True)

    model_tools.get_tool_definitions = direct_definitions


def install_guard(agent_class, helpers, allowed_tools=(), event_sink=None, max_tool_calls=MAX_TOOL_CALLS, per_turn_budget=False, before_tool_batch=None, after_tool_batch=None):
    """Install on the app's child process only; fake classes exercise this in tests."""
    def publish(value):
        if event_sink is not None: event_sink(value)
        else: print(json.dumps(value), flush=True)
    for name in ("__init__", "run_conversation", "_interruptible_api_call",
                 "_interruptible_streaming_api_call", "_execute_tool_calls",
                 "_run_codex_app_server_turn"):
        if not callable(getattr(agent_class, name, None)):
            raise ToolPolicyError("Hermes is missing a required chat-only guard seam.")
    _require_signature(getattr(helpers, "interruptible_api_call", None), ("agent", "api_kwargs"))
    _require_signature(getattr(helpers, "interruptible_streaming_api_call", None),
                       ("agent", "api_kwargs", "on_first_delta"), ("on_first_delta",))
    connections = tuple(allowed_tools) == CONNECTION_TOOL_NAMES
    if allowed_tools and not connections:
        raise ToolPolicyError("Nemo tool policy is not an approved mode.")
    check = assert_connection_tools if connections else assert_no_tools
    original_init = agent_class.__init__
    original_turn = agent_class.run_conversation
    original_call = agent_class._interruptible_api_call
    original_stream = agent_class._interruptible_streaming_api_call
    original_execute = agent_class._execute_tool_calls
    if connections:
        _require_signature(original_execute, ("self", "assistant_message", "messages", "effective_task_id", "api_call_count"))

    def verified(stage, self, api_kwargs=_NO_REQUEST):
        try:
            expected = getattr(self, "_nemo_child_instruction", None)
            if expected and not getattr(self, "ephemeral_system_prompt", "").endswith(expected):
                raise ToolPolicyError("Nemo learning policy changed.")
            check(self, api_kwargs)
            route = managed_model_route()
            if route is not None and (getattr(self, "base_url", "").rstrip("/") != route["base_url"]
                    or getattr(self, "api_key", None) != route["api_key"]
                    or getattr(self, "api_mode", None) != "chat_completions"
                    or getattr(self, "model", None) != route["model"]
                    or getattr(self, "_fallback_chain", None)):
                raise ToolPolicyError("Nemo ChatGPT connection changed.")
        except ToolPolicyError as error:
            emit_policy_error(stage, error, self, event_sink)
            raise

    def guarded_init(self, *args, **kwargs):
        try:
            route = managed_model_route()
            if route is not None:
                overrides = {"base_url": route["base_url"], "api_key": route["api_key"],
                             "provider": "custom", "requested_provider": "custom",
                             "api_mode": "chat_completions", "model": route["model"],
                             "fallback_model": [], "credential_pool": None,
                             "request_overrides": None}
                if args or any(key not in inspect.signature(original_init).parameters for key in overrides):
                    raise ToolPolicyError("Nemo ChatGPT connection seam changed.")
                kwargs.update(overrides)
                if route["local"]:
                    kwargs["max_tokens"] = 2048
            family = os.environ.get("NEMO_MCP_POLICY") == "family"
            learning_policy = os.environ.get("NEMO_CHILD_POLICY", "standard-v1")
            instruction = None
            if family:
                for key in ("skip_context_files", "skip_memory", "skip_background_review"):
                    if key not in inspect.signature(original_init).parameters:
                        raise ToolPolicyError("Hermes profile isolation seam changed.")
                    kwargs[key] = True
                if learning_policy not in ("standard-v1", "child-v1"):
                    raise ToolPolicyError("Unknown Nemo learning policy.")
                if learning_policy == "child-v1":
                    if "ephemeral_system_prompt" not in inspect.signature(original_init).parameters:
                        raise ToolPolicyError("Hermes learning policy seam changed.")
                    policy = json.loads(Path(__file__).with_name("child-policy.json").read_text(encoding="utf-8"))
                    if policy.get("version") != learning_policy or not isinstance(policy.get("instruction"), str) or not policy["instruction"].strip():
                        raise ToolPolicyError("Nemo learning policy is unavailable.")
                    instruction = policy["instruction"]
                    kwargs["ephemeral_system_prompt"] = ((kwargs.get("ephemeral_system_prompt") or "") + "\n\n" + instruction).strip()
            original_init(self, *args, **kwargs)
            if route is not None and route["local"]:
                # The local gateway validates a complete bounded response before
                # returning it. Keep the CLI's normal final text/Activity events.
                self._disable_streaming = True
                if getattr(getattr(self, "context_compressor", None), "context_length", None) != 65536:
                    raise ToolPolicyError("Nemo local context could not be verified.")
            self._nemo_child_instruction = instruction
        except Exception:
            publish({"type": "nemo_guard_error", "version": 1,
                     "stage": "init", "code": "AGENT_INITIALIZATION_FAILED"})
            raise
        verified("init", self)
        self._skip_mcp_refresh = True
        self._nemo_tool_count = 0
        proof = {"type": "nemo_guard", "version": (4 if os.environ.get("NEMO_MCP_MEMORY") == "profile" else 3) if family else 2 if connections else 1,
                 "stage": "startup", "tools": list(allowed_tools)}
        if family:
            proof["isolated"] = True
            proof["learningPolicy"] = learning_policy
        publish(proof)
        # Forward the actual spinner word through this child process only.
        # This is a presentation callback, never reasoning text or diagnostics.
        verbs = ("pondering", "contemplating", "musing", "cogitating", "ruminating",
                 "deliberating", "mulling", "reflecting", "processing", "reasoning",
                 "analyzing", "computing", "synthesizing", "formulating", "brainstorming")
        def thinking_status(text):
            import re
            words = re.findall(r"[a-z]+", str(text).lower()) if text else []
            verb = next((word for word in words if word in verbs), "working") if text else None
            publish({"type": "nemo_status", "phase": "thinking" if text else "idle", "verb": verb})
        self.thinking_callback = thinking_status

    def guarded_turn(self, *args, **kwargs):
        if per_turn_budget:
            self._nemo_tool_count = 0
        verified("turn", self)
        return original_turn(self, *args, **kwargs)

    def guarded_call(self, api_kwargs):
        verified("provider", self, api_kwargs)
        return original_call(self, api_kwargs)

    def guarded_stream(self, api_kwargs, *, on_first_delta=None):
        verified("provider", self, api_kwargs)
        return original_stream(self, api_kwargs, on_first_delta=on_first_delta)

    def deny_tools(self, *args, **kwargs):
        raise ToolPolicyError("Nemo blocked agent tool execution in chat-only mode.")

    def guarded_execute(self, assistant_message, messages, effective_task_id, api_call_count=0):
        check(self)
        tool_calls = getattr(assistant_message, "tool_calls", None)
        if type(tool_calls) is not list or not tool_calls or self._nemo_tool_count + len(tool_calls) > max_tool_calls:
            raise ToolPolicyError("Nemo blocked an invalid tool batch or exhausted budget.")
        # Validate the whole batch before the first call executes, including calls
        # Hermes might otherwise normalize, repair, coerce, or run concurrently.
        for call in tool_calls:
            function = getattr(call, "function", None)
            raw = getattr(function, "arguments", None)
            if type(raw) is not str or len(raw) > 4000:
                raise ToolPolicyError("Nemo blocked malformed tool arguments.")
            try:
                arguments = json.loads(raw)
            except (ValueError, TypeError):
                raise ToolPolicyError("Nemo blocked malformed tool arguments.") from None
            validate_tool_arguments(getattr(function, "name", None), arguments)
        self._nemo_tool_count += len(tool_calls)
        admitted = before_tool_batch(tool_calls) if before_tool_batch else None
        success = False
        try:
            result = original_execute(self, assistant_message, messages, effective_task_id, api_call_count)
            success = True
            return result
        finally:
            if after_tool_batch is not None: after_tool_batch(admitted, success)

    agent_class.__init__ = guarded_init
    agent_class.run_conversation = guarded_turn
    agent_class._interruptible_api_call = guarded_call
    agent_class._interruptible_streaming_api_call = guarded_stream
    agent_class._execute_tool_calls = guarded_execute if connections else deny_tools
    agent_class._run_codex_app_server_turn = deny_tools


def main():
    global CONNECTION_TOOL_NAMES
    isolate_chatgpt_plan_network()
    if os.environ.get("NEMO_MCP_POLICY") == "family" and os.environ.get("NEMO_MCP_MEMORY") != "profile":
        CONNECTION_TOOL_NAMES = CONNECTION_TOOL_NAMES[:2]
    if "NEMO_MCP_ALLOWED_TOOLS" in os.environ:
        names = json.loads(os.environ["NEMO_MCP_ALLOWED_TOOLS"])
        if os.environ.get("NEMO_MCP_POLICY") != "family" or type(names) is not list or not names or any(type(name) is not str for name in names) or len(set(names)) != len(names) or any("mcp__nemo__" + name not in CONNECTION_TOOL_NAMES for name in names):
            raise ToolPolicyError("Nemo connection permissions are invalid.")
        CONNECTION_TOOL_NAMES = tuple(name for name in CONNECTION_TOOL_NAMES if name.removeprefix("mcp__nemo__") in names)
    # The fixed Nemo CLI flags require these values. Set them before importing
    # agent modules so imports cannot snapshot an inherited worker context.
    for key in list(os.environ):
        if key.startswith("HERMES_KANBAN_"):
            del os.environ[key]
    os.environ.pop("HERMES_YOLO_MODE", None)
    os.environ["HERMES_IGNORE_RULES"] = "1"
    mode = os.environ.get("NEMO_HERMES_MODE", "chat-only")
    if mode not in {"chat-only", "connections"}:
        raise ToolPolicyError("Nemo tool mode is invalid.")
    allowed_tools = prepare_mcp_connections() if mode == "connections" else ()
    if mode == "chat-only":
        isolate_mcp_configuration({})
    else:
        import model_tools
        use_direct_mcp_schemas(model_tools)
    from run_agent import AIAgent
    from agent import chat_completion_helpers
    install_guard(AIAgent, chat_completion_helpers, allowed_tools)
    install_chatgpt_plan_resolution()
    # Existing launcher already prepared sys.path and hermes_bootstrap. argv's
    # remaining fixed flags and stdin pass unchanged into the supported CLI.
    runpy.run_module("hermes_cli.main", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    try:
        main()
    except ToolPolicyError as error:
        # Keep provider/agent internals out of stdout and browser diagnostics.
        emit_policy_error("startup", error)
        print("Nemo agent tool policy could not be verified.", file=sys.stderr)
        raise SystemExit(78)
