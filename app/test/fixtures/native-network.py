"""Isolated process test; never resolves external DNS or reaches a real service."""
import asyncio
import contextlib
import importlib.util
import io
import json
import socket
import sys

spec = importlib.util.spec_from_file_location("nemo_native_worker", sys.argv[1])
native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
channel = io.StringIO(); output = native.RpcOutput(channel)
with contextlib.redirect_stdout(io.StringIO()):
    output.guard_event({"type": "nemo_guard", "version": 3, "stage": "startup", "tools": [], "isolated": True, "learningPolicy": "standard-v1"})
assert json.loads(channel.getvalue())["params"]["type"] == "nemo.guard"

listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen()
port = listener.getsockname()[1]
native.install_network_boundary("http://127.0.0.1:%d/v1" % port)
client = socket.create_connection(("127.0.0.1", port)); peer, _ = listener.accept(); client.sendall(b"synthetic"); assert peer.recv(9) == b"synthetic"
client.close(); peer.close(); listener.close()
for address in (("127.0.0.1", port + 1), ("192.0.2.1", 443)):
    other = socket.socket()
    try:
        other.connect(address); raise AssertionError("accepted unapproved connection")
    except PermissionError: pass
    finally: other.close()
try: socket.getaddrinfo("external.example.test", 443); raise AssertionError("resolved external DNS")
except PermissionError: pass
left, right = socket.socketpair(); left.sendall(b"pair"); assert right.recv(4) == b"pair"; left.close(); right.close()
loop = asyncio.new_event_loop(); loop.close()
print(json.dumps({"ok": True, "network": "synthetic-broker-only", "socketpair": True, "proofChannel": True}))
