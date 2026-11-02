"""Nemo's fixed, non-inference bridge to the pinned Hermes MemoryStore.

authenticated profile -> private Hermes home -> native store -> bounded JSON
No provider, extraction model, arbitrary path, or user-selected operation runs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


class BridgeError(Exception):
    def __init__(self, code, status=503):
        self.code, self.status = code, status


def fail(code="MEMORY_STORE", status=503):
    raise BridgeError(code, status)


def safe_node(path, directory=False, missing=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing:
            return False
        fail()
    if (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400
            or not directory and info.st_nlink > 1):
        fail("MEMORY_PROFILE", 403)
    if directory and not stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
        fail()
    return True


def bounded_json(path, maximum=262144):
    safe_node(path)
    if path.stat().st_size > maximum:
        fail()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError, OSError):
        fail()


def workspace():
    profile_id = os.environ.get("NEMO_MEMORY_PROFILE_ID", "")
    data = Path(os.environ.get("NEMO_MEMORY_DATA_DIR", ""))
    home = Path(os.environ.get("HERMES_HOME", ""))
    if (re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", profile_id) is None
            or not data.is_absolute() or not home.is_absolute()
            or data.name != profile_id or data.parent.name != "profiles"
            or home != data / "hermes"):
        fail("MEMORY_PROFILE", 403)
    for directory in (data.parent.parent, data.parent, data, home):
        safe_node(directory, directory=True)
    if home.resolve() != data.resolve() / "hermes":
        fail("MEMORY_PROFILE", 403)
    registry = bounded_json(data.parent.parent / "profiles.json")
    if (registry.get("version") != 2 or not isinstance(registry.get("profiles"), list)
            or not any(p.get("id") == profile_id and not p.get("disabled") for p in registry["profiles"])):
        fail("MEMORY_PROFILE", 403)
    if bounded_json(home / "nemo-profile.json", 1024) != {"version": 1, "profileId": profile_id}:
        fail("MEMORY_PROFILE", 403)
    memory_dir = home / "memories"
    if not safe_node(memory_dir, directory=True, missing=True):
        memory_dir.mkdir(mode=0o700)
    for name in ("MEMORY.md", "USER.md", "MEMORY.md.lock", "USER.md.lock"):
        safe_node(memory_dir / name, missing=True)
    for name in ("nemo-memory-state.json", "nemo-memory-state.json.lock", ".nemo-memory-bridge.lock"):
        safe_node(home / name, missing=True)
    return home


def fields(payload, allowed, required=()):
    if type(payload) is not dict or set(payload) - set(allowed) or not set(required) <= set(payload):
        fail("MEMORY_INPUT", 400)


def authorize_mutation(home):
    """Recheck current policy at the final disk-mutation boundary.

    Read-only board access is also used by Nemo's audited parental review, so
    that existing route must not become a mutation permission shortcut.
    """
    registry = bounded_json(home.parent.parent.parent / "profiles.json")
    profile_id = os.environ.get("NEMO_MEMORY_PROFILE_ID", "")
    profile = next((p for p in registry.get("profiles", []) if type(p) is dict and p.get("id") == profile_id), None)
    if registry.get("version") != 2 or not profile or profile.get("disabled"):
        fail("MEMORY_PROFILE", 403)
    child = profile.get("role") != "owner" and (profile.get("childMode") is True or profile.get("classification") == "child")
    if child and (type(profile.get("capabilityGrants")) is not dict or profile["capabilityGrants"].get("memory") is not True):
        fail("TOOL_PERMISSION", 403)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def snapshot(store):
    rows, raw_files = [], []
    for target in ("user", "memory"):
        path = store._path_for(target)
        safe_node(path, missing=True)
        with store._file_lock(path):
            safe_node(path, missing=True)
            if path.exists() and path.stat().st_size > 65536:
                fail()
            raw, readable = store._read_raw_checked(path)
            if not readable:
                fail()
            entries = list(dict.fromkeys(store._parse_entries(raw)))
        raw_files.append([target, raw])
        for entry in entries:
            entry_hash = digest(target + "\0" + entry)
            rows.append({"id": "hermes:" + target + ":" + entry_hash,
                         "revision": entry_hash, "target": target, "text": entry})
    return {"items": rows, "revision": digest(json.dumps(raw_files, ensure_ascii=False))}


def selected(snapshot_value, identifier, revision):
    if not isinstance(identifier, str) or re.fullmatch(r"hermes:(user|memory):[a-f0-9]{64}", identifier) is None:
        fail("MEMORY_INPUT", 400)
    item = next((entry for entry in snapshot_value["items"] if entry["id"] == identifier), None)
    if item is None or not isinstance(revision, str) or item["revision"] != revision:
        fail("MEMORY_CHANGED", 409)
    return item


def verify_native(result):
    if not isinstance(result, dict) or result.get("success") is not True:
        fail("MEMORY_REJECTED", 409)


def state(home):
    path = home / "nemo-memory-state.json"
    if not safe_node(path, missing=True):
        return None
    value = bounded_json(path, 1024)
    if (type(value) is not dict or set(value) != {"version", "sources"} or value.get("version") != 1
            or type(value.get("sources")) is not dict or set(value["sources"]) != {"gmail", "calendar"}
            or any(type(v) is not bool for v in value["sources"].values())):
        fail()
    return value


def persist_state(home, sources):
    from tools.memory_tool_store import atomic_write_text
    path = home / "nemo-memory-state.json"
    safe_node(path, missing=True)
    atomic_write_text(path, json.dumps({"version": 1, "sources": sources}), tmp_prefix=".nemo_state_")


def perform(payload):
    home = workspace()
    from tools.memory_tool import MemoryStore
    store = MemoryStore(memory_char_limit=2200, user_char_limit=1375)
    fields(payload, {"operation", "id", "revision", "target", "content", "sources", "source"}, {"operation"})
    operation = payload["operation"]
    if operation not in {"snapshot", "add", "replace", "remove", "clear", "mark-connected", "source-cleared"}:
        fail("MEMORY_INPUT", 400)
    # This outer native lock serializes bridge operations and source bookkeeping.
    # Native add/replace/remove retain their own per-file locks and exact matching.
    with store._file_lock(home / ".nemo-memory-bridge"):
        before = snapshot(store)
        if operation == "snapshot":
            fields(payload, {"operation"})
            return {"ok": True, **before}
        if operation == "mark-connected":
            fields(payload, {"operation", "sources"}, {"sources"})
            sources = payload["sources"]
            if type(sources) is not dict or set(sources) != {"gmail", "calendar"} or any(type(v) is not bool for v in sources.values()):
                fail("MEMORY_INPUT", 400)
            previous = state(home)
            merged = {key: previous is None or previous["sources"][key] or sources[key] for key in sources}
            persist_state(home, merged)
            return {"ok": True}
        if operation == "source-cleared":
            fields(payload, {"operation", "source"}, {"source"})
            if payload["source"] not in ("gmail", "calendar"):
                fail("MEMORY_INPUT", 400)
            exposure = state(home)
            if before["items"] and (exposure is None or exposure["sources"][payload["source"]]):
                fail("GMAIL_MEMORY_CLEANUP" if payload["source"] == "gmail" else "MEMORY_SOURCE_CLEANUP", 409)
            if not before["items"]:
                persist_state(home, {"gmail": False, "calendar": False})
            return {"ok": True}
        if operation == "clear":
            fields(payload, {"operation", "revision"}, {"revision"})
            if payload["revision"] != before["revision"]:
                fail("MEMORY_CHANGED", 409)
            authorize_mutation(home)
            changed, failed = False, False
            # Hermes intentionally rejects a batch that empties a whole target.
            # Use its deliberate single-remove API; never rewrite its file here.
            for item in before["items"]:
                try:
                    authorize_mutation(home)
                    result = store.remove(item["target"], item["text"], matched_entry=item["text"])
                    verify_native(result)
                    changed = True
                except Exception:
                    failed = True
            try:
                after = snapshot(store)
                complete = not failed and not after["items"]
                if complete:
                    persist_state(home, {"gmail": False, "calendar": False})
            except Exception:
                complete = False
                after = None
            return {"ok": True, "changed": changed, "complete": complete,
                    "snapshot": after}
        if operation == "add":
            fields(payload, {"operation", "target", "content"}, {"target", "content"})
            target = payload["target"]
            if target not in ("user", "memory"):
                fail("MEMORY_INPUT", 400)
            content = payload["content"]
            if not isinstance(content, str) or not content.strip() or "\0" in content or len(content) > (1375 if target == "user" else 2200):
                fail("MEMORY_INPUT", 400)
            authorize_mutation(home)
            verify_native(store.add(target, content))
        else:
            allowed = {"operation", "id", "revision", "content"} if operation == "replace" else {"operation", "id", "revision"}
            fields(payload, allowed, allowed)
            item = selected(before, payload["id"], payload["revision"])
            if operation == "replace":
                content = payload["content"]
                if not isinstance(content, str) or not content.strip() or "\0" in content or len(content) > (1375 if item["target"] == "user" else 2200):
                    fail("MEMORY_INPUT", 400)
                authorize_mutation(home)
                verify_native(store.replace(item["target"], item["text"], content, matched_entry=item["text"]))
            else:
                authorize_mutation(home)
                verify_native(store.remove(item["target"], item["text"], matched_entry=item["text"]))
        after = snapshot(store)
        return {"ok": True, "changed": before["revision"] != after["revision"], "snapshot": after}


def main():
    # The bridge imports local pinned store code only. Even accidental provider
    # or helper invocation must not establish a network connection or subprocess.
    def local_only(event, args):
        if event in {"socket.connect", "socket.bind", "subprocess.Popen", "os.system", "os.exec"}:
            raise RuntimeError("Memory bridge is local storage only")
    sys.addaudithook(local_only)
    try:
        raw = sys.stdin.read(20001)
        if len(raw) > 20000:
            fail("MEMORY_INPUT", 400)
        result = perform(json.loads(raw))
    except BridgeError as error:
        result = {"ok": False, "code": error.code, "status": error.status}
    except Exception:
        result = {"ok": False, "code": "MEMORY_STORE", "status": 503}
    print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
