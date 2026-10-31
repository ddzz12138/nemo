"""Pure path-binding regression. No Hermes imports, accounts or tool queries."""
import json, runpy, sys, stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

scope = runpy.run_path(sys.argv[1], run_name="nemo_path_fixture")
bind, rejected = scope["profile_mcp_context"], scope["ToolPolicyError"]
cases = json.load(sys.stdin)
checked = 0
for row in cases:
    try:
        data, root = bind(row["data"], row["root"], row["profile"])
    except rejected:
        assert row["allowed"] is False, row["case"]
    else:
        assert row["allowed"] is True, row["case"]
        assert Path(data) == Path(row["root"]) / "profiles" / row["profile"]
        assert Path(root) == Path(row["root"])
    checked += 1
alias = scope["same_windows_directory_alias"]
def info(inode=7, device=3, attributes=16):
    return SimpleNamespace(st_mode=stat.S_IFDIR, st_ino=inode,
                           st_dev=device, st_file_attributes=attributes)
def paths(left=None, right=None, parent=None):
    left, right, parent = left or info(), right or info(), parent or info()
    return (SimpleNamespace(parent=SimpleNamespace(lstat=lambda: parent),
                            lstat=lambda: left, stat=lambda: left),
            SimpleNamespace(stat=lambda: right))
with patch.object(scope["os"], "name", "nt"):
    assert alias(*paths()) is True
    for left, right, parent in [
        (info(inode=0), info(inode=0), info()),
        (info(), info(inode=8), info()),
        (info(), info(device=4), info()),
        (info(attributes=16 | stat.FILE_ATTRIBUTE_REPARSE_POINT), info(), info()),
        (info(), info(), info(attributes=16 | stat.FILE_ATTRIBUTE_REPARSE_POINT)),
    ]:
        assert alias(*paths(left, right, parent)) is False
with patch.object(scope["os"], "name", "posix"):
    assert alias(*paths()) is False

# A Windows overlay can map just the profile to another physical address.
# Verify the binding still returns the original logical root for the Node child.
ordinary = next(row for row in cases if row["case"] == "ordinary profile")
logical = Path(ordinary["data"])
virtual = logical.parent.parent / "virtualized" / "profiles" / ordinary["profile"]
original_resolve = Path.resolve
def overlay_resolve(self, *args, **kwargs):
    return virtual if self == logical else original_resolve(self, *args, **kwargs)
with patch.object(Path, "resolve", overlay_resolve):
    with patch.dict(bind.__globals__, {"same_windows_directory_alias": lambda left, right: left == logical and right == virtual}):
        data, root = bind(ordinary["data"], ordinary["root"], ordinary["profile"])
        assert Path(data) == logical and Path(root) == Path(ordinary["root"])
    with patch.dict(bind.__globals__, {"same_windows_directory_alias": lambda *_: False}):
        try:
            bind(ordinary["data"], ordinary["root"], ordinary["profile"])
        except rejected:
            pass
        else:
            raise AssertionError("Unverified physical aliases must remain blocked")
print(json.dumps({"ok": True, "cases": checked, "modelCalled": False}))
