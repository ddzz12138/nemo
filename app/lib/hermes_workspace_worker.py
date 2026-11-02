"""Launch the stock Hermes gateway for the explicitly authorized local owner.

No tool registry, skill loader, approval handler, agent class, network stack or
source file is replaced. Only the launch-scoped provider points at Nemo's local
ChatGPT adapter. Ordinary family workers keep their separate guarded path.
"""
import json
import os
from pathlib import Path
import re
import sys
import threading

_owner_job = None


def install_owner_process_boundary():
    """Windows owns the complete spawned process tree through a kernel job.

    This changes no Hermes tool behavior. A crashed/force-stopped launcher closes
    the last job handle, and Windows terminates its descendants as well. A host
    unable to establish this boundary must not advertise the full workspace.
    """
    global _owner_job
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise RuntimeError("Owner process boundary unavailable")
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
            or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess())):
        kernel.CloseHandle(job)
        raise RuntimeError("Owner process boundary unavailable")
    _owner_job = job  # Retain the non-inheritable handle until process termination.


class RpcOutput:
    """Keep diagnostic stdout out of the JSON-RPC transport, without tool edits."""
    def __init__(self, target):
        self.target, self.buffer, self.lock = target, "", threading.RLock()

    def write(self, text):
        with self.lock:
            self.buffer += text
            if len(self.buffer) > 16_000_000:
                os._exit(78)
            while "\n" in self.buffer:
                line, self.buffer = self.buffer.split("\n", 1)
                try:
                    value = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(value, dict) and value.get("jsonrpc") == "2.0":
                    self.target.write(json.dumps(value, separators=(",", ":")) + "\n")
                    self.target.flush()
        return len(text)

    def flush(self):
        self.target.flush()

    def isatty(self):
        return False

    @property
    def encoding(self):
        return "utf-8"


def main():
    install_owner_process_boundary()
    profile_id = os.environ.get("NEMO_WORKSPACE_PROFILE", "")
    if re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", profile_id) is None:
        raise RuntimeError("Missing workspace owner")
    root = Path(os.environ["NEMO_WORKSPACE_ROOT"]).resolve()
    home = Path(os.environ["HERMES_HOME"])
    if home.is_symlink() or home.resolve() != root / "profiles" / profile_id / "hermes":
        raise RuntimeError("Wrong private Hermes home")
    registry = json.loads((root / "profiles.json").read_text(encoding="utf-8"))
    owner = next((row for row in registry.get("profiles", []) if row.get("id") == profile_id), {})
    if registry.get("version") != 2 or owner.get("role") != "owner" or owner.get("childMode") or owner.get("disabled"):
        raise RuntimeError("Host owner is unavailable")
    marker = json.loads((home / "nemo-profile.json").read_text(encoding="utf-8"))
    if marker != {"version": 1, "profileId": profile_id}:
        raise RuntimeError("Wrong private Hermes owner")
    # The upstream configuration overlay disables automatic crash recovery for
    # this launch. Confirm it before importing the gateway: reopening in Nemo
    # restores a conversation, never authorizes another run of its last action.
    from hermes_cli.managed_scope import get_managed_dir, load_managed_config
    policy = get_managed_dir()
    if (policy is None or not policy.resolve().is_relative_to(home.resolve() / "scratch")
            or load_managed_config() != {"desktop": {"auto_continue": {"enabled": False}}}):
        raise RuntimeError("Workspace recovery policy unavailable")
    sys.stdout = RpcOutput(sys.stdout)
    # These are upstream-supported launch overrides, not provider patches. The
    # actual OAuth credential remains in the host's broker, never in this worker.
    from hermes_cli.runtime_provider import resolve_runtime_provider
    route = resolve_runtime_provider(requested="custom", target_model=os.environ["HERMES_MODEL"])
    if (route.get("base_url", "").rstrip("/") != os.environ["CUSTOM_BASE_URL"]
            or route.get("api_key") != os.environ["OPENAI_API_KEY"]
            or route.get("api_mode") != "chat_completions"):
        raise RuntimeError("Wrong ChatGPT broker route")
    # The CLI normally seeds a fresh home's bundled skills before launching its
    # UI. Calling that same upstream synchronizer is necessary when embedding
    # the gateway directly; it preserves manifests, owner edits and OS gating.
    from tools.skills_sync import sync_skills
    sync_skills(quiet=True)
    from tui_gateway import entry
    entry.main()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No raw config, provider credential, tool arguments or stderr is sent.
        print(json.dumps({"jsonrpc": "2.0", "method": "event", "params": {
            "type": "nemo.workspace.error", "payload": {"code": "HERMES_WORKSPACE_STARTUP"}}}), flush=True)
        raise SystemExit(78)
