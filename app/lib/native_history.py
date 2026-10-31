"""Private transcript maintenance for Nemo-managed homes only.

The host coordinator supplies an owned stored ID. No model tool or public RPC
route exposes these operations. Receipts fence transcript changes; all native
compression records and delegated transcripts are removed, while explicit sibling
branches remain independent. File removal is verified rather than best-effort.
"""
import hashlib
import json
import re
from pathlib import Path

_ID = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")


def _fingerprint(db, key, connection=None):
    if connection is None:
        with db._read_ctx() as connection:
            return _fingerprint(db, key, connection)
    if connection.execute("SELECT 1 FROM sessions WHERE id = ?", (key,)).fetchone() is None:
        return None
    messages = [dict(row) for row in connection.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY id", (key,)).fetchall()]
    def binary(value):
        if isinstance(value, (bytes, bytearray, memoryview)):
            return {"blob_sha256": hashlib.sha256(value).hexdigest(), "length": len(value)}
        raise TypeError("unsupported transcript column")
    return hashlib.sha256(json.dumps(messages, sort_keys=True, separators=(",", ":"), default=binary).encode()).hexdigest()


def _lineage(db, key, connection=None):
    # Use the pinned SessionDB for reads. Explicit copied branches own their
    # transcripts and must not be traversed as compression continuations.
    if connection is None:
        with db._read_ctx() as connection:
            return _lineage(db, key, connection)
    rows = connection.execute("SELECT id, parent_session_id, end_reason, model_config FROM sessions LIMIT 20001").fetchall()
    if len(rows) > 20000:
        raise ValueError("history capacity")
    rows = {row["id"]: dict(row) for row in rows}
    if key not in rows:
        return set(), None
    def branch(row):
        try: return bool(json.loads(row.get("model_config") or "{}").get("_branched_from"))
        except (TypeError, ValueError, AttributeError): raise ValueError("history metadata")
    root, visited = key, set()
    while root in rows:
        if root in visited: raise ValueError("history cycle")
        visited.add(root)
        child, parent = rows[root], rows.get(rows[root]["parent_session_id"])
        if branch(child) or parent is None or parent["end_reason"] != "compression": break
        root = parent["id"]
    selected, pending = set(), [root]
    while pending:
        current = pending.pop()
        if current in selected: raise ValueError("history cycle")
        selected.add(current)
        if rows[current]["end_reason"] == "compression":
            pending.extend(row["id"] for row in rows.values() if row["parent_session_id"] == current and not branch(row))
    leaves = [current for current in selected if not any(row["parent_session_id"] == current and row["id"] in selected for row in rows.values())]
    if len(leaves) != 1: raise ValueError("history tip")
    return selected, leaves[0]


def _targets(db, key, connection=None):
    if connection is None:
        with db._read_ctx() as connection:
            return _targets(db, key, connection)
    from hermes_state_sessions import _collect_delegate_child_ids
    selected, _tip = _lineage(db, key, connection)
    selected.update(_collect_delegate_child_ids(connection, list(selected)))
    return [{"id": current, "fingerprint": _fingerprint(db, current, connection)} for current in sorted(selected)]


def install(server, home):
    from tui_gateway.contracts.base import Params, Result
    from tui_gateway.contracts.registry import method
    class TargetParams(Params):
        session_id: str
        profile: str = "default"
    class TargetRow(Params):
        id: str
        fingerprint: str
    class DeleteParams(TargetParams):
        targets: list[TargetRow]
    class TargetResult(Result):
        targets: list[TargetRow]
        resume_id: str | None
    class DeleteResult(Result):
        deleted: bool
        records: int
        files_removed: bool
    method("nemo.history.targets", params=TargetParams, result=TargetResult)
    method("nemo.history.delete", params=DeleteParams, result=DeleteResult)
    def valid(params):
        if params.get("profile") != "default" or not _ID.fullmatch(params.get("session_id", "")):
            raise ValueError("private identity")
    def targets(rid, params):
        try:
            valid(params)
            with server._profile_db(params) as db:
                if db is None: raise ValueError("store unavailable")
                result = _targets(db, params["session_id"])
                _ids, tip = _lineage(db, params["session_id"])
            return server._ok(rid, {"targets": result, "resume_id": tip})
        except Exception as error:
            return server._err(rid, 5036, "Private transcript inspection needs recovery.", {"kind": type(error).__name__})
    def delete(rid, params):
        try:
            valid(params)
            expected = params.get("targets")
            if not isinstance(expected, list) or len(expected) > 20000 or any(not isinstance(row, dict) or set(row) != {"id", "fingerprint"} or not _ID.fullmatch(row["id"]) or not re.fullmatch(r"[a-f0-9]{64}", row["fingerprint"]) for row in expected):
                raise ValueError("receipt")
            keys = [row["id"] for row in expected]
            if len(keys) != len(set(keys)): raise ValueError("duplicate receipt")
            snapshot, error = server._snapshot_sessions(rid)
            if error: return error
            if any(session.get("session_key") in keys for _sid, session in snapshot):
                return server._err(rid, 4023, "Close active conversations before deletion.")
            directory = home / "sessions"
            if directory.is_symlink() or not directory.resolve().is_relative_to(home): raise ValueError("private directory")
            with server._profile_db(params, writer=True) as db:
                if db is None: raise ValueError("store unavailable")
                skipped = []
                # Fence the exact receipt inside SessionDB's deletion write
                # transaction, including rows hidden by undo or compaction.
                execute_write = db._execute_write
                def fenced_write(operation, *args, **kwargs):
                    def fenced(connection):
                        actual = _targets(db, params["session_id"], connection)
                        if any(row not in expected for row in actual): raise ValueError("changed lineage")
                        if any((current := _fingerprint(db, row["id"], connection)) is not None and current != row["fingerprint"] for row in expected): raise ValueError("changed transcript")
                        return operation(connection)
                    return execute_write(fenced, *args, **kwargs)
                db._execute_write = fenced_write
                try: db.delete_sessions(keys, sessions_dir=directory, exclude_active_write_guards=True, skipped_ids=skipped)
                finally: db._execute_write = execute_write
                if skipped or any(db.get_session(key) is not None for key in keys): raise ValueError("store incomplete")
            # Hermes intentionally ignores unlink errors. Nemo reports success
            # only after every file named by the saved receipt is gone.
            for key in keys:
                files = [directory / (key + suffix) for suffix in (".json", ".jsonl")]
                files.append(directory / ("session_" + key + ".json"))
                if directory.exists(): files.extend(directory.glob("request_dump_" + key + "_*.json"))
                for file in files: file.unlink(missing_ok=True)
                if any(file.exists() for file in files): raise ValueError("file incomplete")
            return server._ok(rid, {"deleted": True, "records": len(keys), "files_removed": True})
        except Exception:
            return server._err(rid, 5036, "Private transcript deletion is incomplete or changed.")
    server.register_method("nemo.history.targets", targets)
    server.register_method("nemo.history.delete", delete)
