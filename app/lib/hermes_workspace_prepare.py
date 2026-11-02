"""Explicit owner-only preparation using Hermes's unchanged pinned PM APIs."""
import json
import os
from pathlib import Path
import re
import sys
import threading

PACKAGES = ("chromium", "agent-browser", "cua-driver")


def validate_owner():
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
        raise RuntimeError("Host owner unavailable")
    if json.loads((home / "nemo-profile.json").read_text(encoding="utf-8")) != {"version": 1, "profileId": profile_id}:
        raise RuntimeError("Wrong private Hermes owner")
    return home.resolve()


def prepare_packages(pm, emit, pause_event):
    """Small fixed operation; PM owns resolution, downloads, hashes and publish."""
    from pm.lock import Lockfile
    from pm.paths import lockfile_path, writable_store_root
    from pm.registry import get_package
    from pm.store import current_target
    home = Path(os.environ["HERMES_HOME"]).resolve()
    if not writable_store_root().resolve().is_relative_to(home):
        raise RuntimeError("Package writes must belong to the owner workspace")
    target = current_target()
    lock = Lockfile(lockfile_path())
    unavailable_runtime = False
    for name in PACKAGES:
        if pause_event.is_set():
            raise RuntimeError("Preparation cancelled")
        package = get_package(name)
        artifacts = lock.artifacts(name, target)
        if package.missing_reason(target) or not artifacts or any(
                re.fullmatch(r"[a-f0-9]{64}", artifact.get("sha256", "")) is None
                or not artifact.get("url", "").startswith("https://") for artifact in artifacts):
            continue  # Upstream platform gaps remain unavailable, never substituted.
        emit({"type": "progress", "package": name, "stage": "prepare", "done": 0, "total": 0})

        def progress(stage, done, total, _label, name=name):
            if stage in ("download", "unpack", "verify"):
                emit({"type": "progress", "package": name, "stage": stage,
                      "done": done if isinstance(done, int) and done >= 0 else 0,
                      "total": total if isinstance(total, int) and total >= 0 else 0})

        try:
            pm.ensure(name, explicit=True, progress=progress, pause_event=pause_event)
            emit({"type": "progress", "package": name, "stage": "ready", "done": 0, "total": 0})
        except Exception as exc:
            if pause_event.is_set():
                raise RuntimeError("Preparation cancelled") from None
            if getattr(exc, "package", None) == "pm-runtime":
                unavailable_runtime = True
                break
            # Preserve partial completion; native dependency checks below are
            # authoritative. Raw downloader paths/errors are never UI progress.
            continue
    return "HERMES_PM_RUNTIME_UNAVAILABLE" if unavailable_runtime else None


def main():
    validate_owner()
    protocol = sys.stdout
    sink = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stderr = sink
    lock = threading.Lock()

    def emit(value):
        with lock:
            protocol.write(json.dumps(value, separators=(",", ":")) + "\n")
            protocol.flush()

    pause_event = threading.Event()
    control_fd = os.dup(0)
    os.set_inheritable(control_fd, False)
    # Match PM's control-channel lifetime: a daemon must never hold Python's
    # buffered stdin lock at shutdown, and package probes receive plain EOF.
    with open(os.devnull, "rb") as null:
        os.dup2(null.fileno(), 0)

    def watch_cancel():
        pending = b""
        try:
            while block := os.read(control_fd, 256):
                pending += block
                if len(pending) > 128:
                    pause_event.set()
                    return
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if json.loads(line) == {"cancel": True}:
                        pause_event.set()
                        return
        except (OSError, ValueError, TypeError):
            pause_event.set()
        finally:
            os.close(control_fd)

    threading.Thread(target=watch_cancel, daemon=True).start()
    import pm
    code = prepare_packages(pm, emit, pause_event)
    if pause_event.is_set():
        raise RuntimeError("Preparation cancelled")
    from tools.browser_tool_install import check_browser_requirements
    from tools.browser_use_cli import is_browser_use_cli_mode
    from tools.computer_use.tool import check_computer_use_requirements
    # Upstream Browser Use is now the default. In that mode the old browser_*
    # check intentionally returns False; the native browser_exec tool uses the
    # same PM Chromium/agent-browser while retaining its own harness/schema.
    browser_ready = bool(check_browser_requirements()) or bool(
        is_browser_use_cli_mode() and pm.installed_package("chromium")
        and pm.installed_package("agent-browser"))
    emit({"type": "result", "browser": browser_ready,
          "computer": bool(check_computer_use_requirements()), **({"code": code} if code else {})})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(78)
