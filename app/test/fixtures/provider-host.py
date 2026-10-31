"""Synthetic credential boundary test. No Hermes, credentials or HTTP calls."""
import base64
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("nemo_provider_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
runtime = {"api_mode": "codex_responses", "base_url": "https://provider.example.test/v1", "api_key": "SYNTHETIC_HOST_CREDENTIAL"}
calls, frames, resolutions = [], [], []


class Response:
    status_code = 200
    headers = {"content-type": "text/event-stream; charset=utf-8"}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def iter_bytes(self, chunk_size):
        yield b'event: response.output_text.delta\ndata: {"delta":"Synthetic answer"}\n\n'


class Client:
    def stream(self, method, url, **kwargs):
        calls.append((method, url, kwargs))
        return Response()


def resolve(model):
    resolutions.append(model)
    return runtime


def request(**fields):
    return {"profileId": A, "method": "POST", "path": "/v1/responses", "body": {"model": "configured-model", "input": [], "stream": True, **fields}}


def invoke(value):
    host.serve(value, resolve_runtime=resolve, load_model=lambda: "configured-model", client=Client(), emit=frames.append, normalize=lambda body: body)


invoke(request(prompt_cache_key="same-conversation"))
assert calls[0][1] == "https://provider.example.test/v1/responses"
assert calls[0][2]["headers"]["Authorization"] == "Bearer SYNTHETIC_HOST_CREDENTIAL"
assert calls[0][2]["json"]["store"] is False
assert "SYNTHETIC_HOST_CREDENTIAL" not in json.dumps(frames)
assert frames[0]["type"] == "headers" and frames[-1]["type"] == "end"
assert b"Synthetic answer" in base64.b64decode(frames[1]["data"])
first_cache_key = calls[0][2]["json"]["prompt_cache_key"]
other = request(prompt_cache_key="same-conversation"); other["profileId"] = B
invoke(other)
assert first_cache_key != calls[-1][2]["json"]["prompt_cache_key"]

for extra in ({"base_url": "https://attacker.test"}, {"extra_headers": {"Authorization": "override"}}, {"extra_body": {}}, {"previous_response_id": "another-person"}, {"store": True}, {"tools": [{"type": "web_search"}]}, {"tools": 3}, {"model": "unapproved-paid-model"}):
    before = len(calls), len(resolutions)
    try: invoke(request(**extra)); raise AssertionError("accepted forbidden request")
    except host.ForwardError: pass
    assert (len(calls), len(resolutions)) == before

for value in (None, [], {**request(), "profileId": "../other"}, {**request(), "path": "/v1/models?secret=x"}):
    try: invoke(value); raise AssertionError("accepted invalid identity/operation")
    except host.ForwardError: pass

before = len(resolutions)
invoke({"profileId": A, "method": "GET", "path": "/v1/models", "body": None})
assert len(resolutions) == before, "listing configured model must not resolve credentials"

for url in ("http://provider.example.test/v1", "https://user:password@provider.test", "https://provider.test?secret=x", "file:///tmp/key"):
    try: host.provider_url(url, "/responses"); raise AssertionError("accepted unsafe endpoint")
    except host.ForwardError: pass
assert host.provider_url("http://127.0.0.1:11434/v1", "/chat/completions").endswith("/v1/chat/completions")
try: host.prepare_body(request(), {**runtime, "api_mode": "anthropic_messages"}, "configured-model"); raise AssertionError("accepted unsupported protocol")
except host.ForwardError as error: assert error.status == 409

class JsonResponse(Response):
    headers = {"content-type": "application/json"}
    value = {"object": "response", "id": "resp_synthetic", "status": "completed", "output": []}
    def iter_bytes(self, chunk_size): yield json.dumps(self.value).encode()
class JsonClient:
    def stream(self, *args, **kwargs): return JsonResponse()
json_frames = []
host.serve(request(), resolve_runtime=resolve, load_model=lambda: "configured-model", client=JsonClient(), emit=json_frames.append)
assert json_frames[0]["contentType"] == "text/event-stream"
assert b'response.completed' in base64.b64decode(json_frames[1]["data"])
JsonResponse.value = {"error": {"message": "SYNTHETIC_PRIVATE_DIAGNOSTIC"}}
try:
    host.serve(request(), resolve_runtime=resolve, load_model=lambda: "configured-model", client=JsonClient(), emit=json_frames.append)
    raise AssertionError("accepted error JSON")
except host.ForwardError as error: assert error.code == "PROVIDER_RESPONSE_ERROR"
assert "SYNTHETIC_PRIVATE_DIAGNOSTIC" not in json.dumps(json_frames)

class Headerless(Response):
    headers = {}
    def iter_bytes(self, chunk_size):
        yield b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Synthetic answer"}\n\n'
class HeaderlessClient:
    def stream(self, *args, **kwargs): return Headerless()
headerless_frames = []
host.serve(request(), resolve_runtime=resolve, load_model=lambda: "configured-model", client=HeaderlessClient(), emit=headerless_frames.append)
assert headerless_frames[0]["contentType"] == "text/event-stream"
assert b'Synthetic answer' in base64.b64decode(headerless_frames[1]["data"])

print(json.dumps({"ok": True, "credentials": "synthetic-only", "network": False}))
