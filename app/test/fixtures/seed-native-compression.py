"""Synthetic-only fixture. No provider configuration or source accounts are read."""
import sys
import json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import hermes_bootstrap
from hermes_state import SessionDB

database, root = Path(sys.argv[2]).resolve(), sys.argv[3]
if "nemo-history-engine-" not in str(database) or database.name != "state.db":
    raise RuntimeError("Not a synthetic history fixture")
db = SessionDB(database)
try:
    db.reopen_session(root)
    db.end_session(root, "compression")
    db.create_session("synthetic_compression_child", "cli", parent_session_id=root)
    db.append_message("synthetic_compression_child", "user", "SYNTHETIC_COMPRESSED_TURN")
    db.append_message("synthetic_compression_child", "assistant", "Synthetic compressed response")
    with db._read_ctx() as connection:
        rows = [dict(row) for row in connection.execute("SELECT id, parent_session_id, end_reason, model_config FROM sessions")]
    print(json.dumps({"rows": rows, "root": root}))
finally:
    db.close()
