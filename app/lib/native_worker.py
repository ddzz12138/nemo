"""Private-home, broker-only native worker with optional managed read tools.

This is basic chat, not the Docker/full-tool worker. No owner configuration or
credentials are copied. The existing guard verifies every agent/provider call.
"""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
import threading
from urllib.parse import urlsplit


def install_network_boundary(base_url):
    parsed = urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.port < 1024 or parsed.path != "/v1" or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise RuntimeError("Invalid broker boundary")
    allowed = ("127.0.0.1", parsed.port)
    original_connect, original_ex, original_resolve = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo
    original_pair = socket.socketpair
    pair_scope = threading.local()
    def address(value):
        if isinstance(value, tuple) and len(value) >= 2 and getattr(pair_scope, "active", False):
            try:
                if ipaddress.ip_address(value[0]).is_loopback: return
            except ValueError: pass
        if not isinstance(value, tuple) or len(value) < 2 or value[0] != allowed[0] or value[1] != allowed[1]:
            raise PermissionError("Native chat can connect only to its provider broker")
    def connect(self, value): address(value); return original_connect(self, value)
    def connect_ex(self, value): address(value); return original_ex(self, value)
    def resolve(host, port, *args, **kwargs):
        address((host, int(port)))
        return original_resolve(host, port, *args, **kwargs)
    def socketpair(*args, **kwargs):
        # asyncio's Windows self-pipe uses a freshly-created loopback pair.
        # This exception is scoped to the stdlib factory on this thread, not
        # arbitrary connections to other localhost services.
        pair_scope.active = True
        try: return original_pair(*args, **kwargs)
        finally: pair_scope.active = False
    socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo = connect, connect_ex, resolve
    socket.socketpair = socketpair


class RpcOutput:
    def __init__(self, target): self.target, self.buffer, self.lock = target, "", threading.RLock()
    def write(self, text):
        with self.lock:
            self.buffer += text
            if len(self.buffer) > 2_000_000:
                os._exit(78)
            while "\n" in self.buffer:
                line, self.buffer = self.buffer.split("\n", 1)
                try: value = json.loads(line)
                except (TypeError, ValueError): continue
                if not isinstance(value, dict): continue
                if value.get("type") in ("nemo_guard", "nemo_guard_error", "nemo_status"):
                    kind = {"nemo_guard": "nemo.guard", "nemo_guard_error": "nemo.guard_error", "nemo_status": "nemo.status"}[value["type"]]
                    value = {"jsonrpc": "2.0", "method": "event", "params": {"type": kind, "payload": value}}
                if value.get("jsonrpc") == "2.0":
                    self.target.write(json.dumps(value, separators=(",", ":")) + "\n"); self.target.flush()
        return len(text)
    def flush(self): self.target.flush()
    def guard_event(self, value): self.write(json.dumps(value) + "\n")
    def isatty(self): return False
    @property
    def encoding(self): return "utf-8"


def main():
    home = Path(os.environ["HERMES_HOME"]).resolve()
    profile = os.environ.get("NEMO_NATIVE_PROFILE", "")
    if re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", profile) is None:
        raise RuntimeError("Missing native profile")
    marker = json.loads((home / "nemo-managed.json").read_text(encoding="utf-8"))
    config = json.loads((home / "config.yaml").read_text(encoding="utf-8"))
    if marker != {"version": 1, "profileId": profile, "mode": "chat-only"}:
        raise RuntimeError("Native profile marker changed")
    install_network_boundary(config["model"]["base_url"])
    output = RpcOutput(sys.stdout); sys.stdout = output
    os.environ["HERMES_IGNORE_RULES"] = "1"
    os.environ["NEMO_MCP_POLICY"] = "family"
    os.environ["NEMO_HERMES_MODE"] = "chat-only"
    guard_path = Path(__file__).with_name("hermes_guard.py")
    spec = importlib.util.spec_from_file_location("nemo_native_guard", guard_path)
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    guard.isolate_mcp_configuration({})
    from hermes_cli import runtime_provider
    original_mode = runtime_provider._resolve_plain_custom_api_mode
    def broker_mode(model_config, base_url):
        # The pinned resolver otherwise infers Chat Completions for unknown
        # localhost proxies. Only this generated endpoint may use the host's
        # explicit protocol; prompts cannot select it or replace the endpoint.
        if base_url == config["model"]["base_url"]:
            mode = config["model"]["api_mode"]
            if mode not in ("chat_completions", "codex_responses"):
                raise RuntimeError("Unsupported broker protocol")
            return mode
        return original_mode(model_config, base_url)
    runtime_provider._resolve_plain_custom_api_mode = broker_mode
    from run_agent import AIAgent
    from agent import chat_completion_helpers
    allowed_tools = ()
    before_tools = after_tools = None
    if config.get("nemo_read_tools"):
        tool_spec = importlib.util.spec_from_file_location("nemo_native_tools", Path(__file__).with_name("native_tools.py"))
        tool_module = importlib.util.module_from_spec(tool_spec); tool_spec.loader.exec_module(tool_module)
        allowed_tools = tool_module.install(guard, config)
    if config.get("nemo_interactions") is True:
        ui_spec = importlib.util.spec_from_file_location("nemo_native_interactions", Path(__file__).with_name("native_interactions.py"))
        ui_module = importlib.util.module_from_spec(ui_spec); ui_spec.loader.exec_module(ui_module)
        allowed_tools, before_tools, after_tools = ui_module.install(guard, config, allowed_tools, output)
    # Native agent construction captures ordinary stdout as diagnostics. Policy
    # proofs use the original RPC channel even within that capture context.
    guard.install_guard(AIAgent, chat_completion_helpers, allowed_tools, event_sink=output.guard_event, max_tool_calls=64, per_turn_budget=True, before_tool_batch=before_tools, after_tool_batch=after_tools)
    from hermes_cli import auth, model_switch_providers
    auth._global_auth_file_path = lambda: None
    model_switch_providers.prewarm_picker_cache_async = lambda: None
    from tui_gateway import entry, server
    history_spec = importlib.util.spec_from_file_location("nemo_native_history", Path(__file__).with_name("native_history.py"))
    history_module = importlib.util.module_from_spec(history_spec); history_spec.loader.exec_module(history_module)
    history_module.install(server, home)
    server._load_enabled_toolsets = lambda platform=None: ["mcp-nemo"] if allowed_tools else ["none"]
    if config.get("nemo_interactions") is True:
        server._clarify_timeout_seconds = lambda: None  # The host journal owns expiry and human waiting.
    server._schedule_startup_orphan_sweep = lambda: None
    entry._install_sidecar_publisher = lambda: None
    entry.main()


if __name__ == "__main__":
    try: main()
    except Exception:
        # Native parent receives no source/config/auth diagnostics.
        print(json.dumps({"jsonrpc": "2.0", "method": "event", "params": {"type": "nemo.guard_error", "payload": {"code": "NATIVE_STARTUP"}}}), flush=True)
        raise SystemExit(78)
