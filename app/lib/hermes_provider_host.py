"""Host-only provider forwarding. Never installed in a family worker.

The selected Hermes runtime resolves its own provider credentials inside this
process. Only provider response bytes leave stdout; credentials, config and raw
exceptions never cross the process boundary. No request is retried here.
"""

import base64
import contextlib
import hashlib
import json
import re
import sys
from urllib.parse import urlsplit

UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
ALLOWED = {
    "/v1/responses": {"model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "include", "stream", "store", "max_output_tokens", "temperature", "top_p", "prompt_cache_key", "service_tier"},
    "/v1/chat/completions": {"model", "messages", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "response_format", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "seed", "store"},
}


class ForwardError(Exception):
    def __init__(self, code, status=502):
        self.code, self.status = code, status


def validate_request(request):
    if type(request) is not dict or set(request) != {"profileId", "method", "path", "body"}:
        raise ForwardError("PROVIDER_REQUEST", 400)
    if type(request["profileId"]) is not str or not UUID.fullmatch(request["profileId"]):
        raise ForwardError("PROVIDER_IDENTITY", 400)
    path, method, body = request["path"], request["method"], request["body"]
    if path == "/v1/models" and method == "GET" and body is None:
        return
    if type(path) is not str or path not in ALLOWED or method != "POST" or type(body) is not dict:
        raise ForwardError("PROVIDER_OPERATION", 400)
    if set(body) - ALLOWED[path] or ("store" in body and body["store"] is not False):
        raise ForwardError("PROVIDER_FIELDS", 400)
    if "stream" in body and type(body["stream"]) is not bool:
        raise ForwardError("PROVIDER_FIELDS", 400)
    content = body.get("input" if path == "/v1/responses" else "messages")
    if type(content) is not list:
        raise ForwardError("PROVIDER_CONTENT", 400)
    if "tools" in body and type(body["tools"]) is not list:
        raise ForwardError("PROVIDER_TOOL", 400)
    for tool in body.get("tools") or []:
        if type(tool) is not dict or tool.get("type") != "function":
            raise ForwardError("PROVIDER_TOOL", 400)


def provider_url(base_url, suffix):
    try:
        parts = urlsplit(base_url)
        local = parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")
        if (not local and parts.scheme != "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError()
        _ = parts.port
    except (ValueError, TypeError):
        raise ForwardError("PROVIDER_CONFIGURATION") from None
    return base_url.rstrip("/") + suffix


def prepare_body(request, runtime, model, normalize=None):
    mode = runtime.get("api_mode")
    path = request["path"]
    expected = {"codex_responses": "/v1/responses", "chat_completions": "/v1/chat/completions"}.get(mode)
    if path != expected:
        raise ForwardError("PROVIDER_PROTOCOL", 409)
    body = dict(request["body"])
    if "model" in body and body["model"] != model:
        raise ForwardError("PROVIDER_MODEL", 403)
    body["model"] = model
    body["store"] = False
    if "prompt_cache_key" in body:
        if type(body["prompt_cache_key"]) is not str or len(body["prompt_cache_key"]) > 200:
            raise ForwardError("PROVIDER_FIELDS", 400)
        body["prompt_cache_key"] = hashlib.sha256((request["profileId"] + "\0" + body["prompt_cache_key"]).encode()).hexdigest()
    if mode == "codex_responses":
        if body.get("stream") is not True:
            raise ForwardError("PROVIDER_STREAM_REQUIRED", 400)
        body.setdefault("instructions", "You are Hermes, assisting this private Nemo profile.")
        # Keep the installed runtime's Responses shape checks. No SDK-level
        # extra_headers/extra_body/URLs are accepted from the caller above.
        if normalize is not None:
            body = normalize(body)
    return body


def serve(request, *, resolve_runtime, load_model, client, emit, normalize=None, codex_headers=None):
    validate_request(request)
    model = load_model()
    if type(model) is not str or not model.strip() or len(model) > 200:
        raise ForwardError("PROVIDER_MODEL_SETUP", 503)
    if request["path"] == "/v1/models":
        emit({"type": "headers", "status": 200, "contentType": "application/json"})
        payload = json.dumps({"object": "list", "data": [{"id": model, "object": "model", "owned_by": "nemo-host"}]}).encode()
        emit({"type": "chunk", "data": base64.b64encode(payload).decode()})
        emit({"type": "end"})
        return
    if "model" in request["body"] and request["body"]["model"] != model:
        raise ForwardError("PROVIDER_MODEL", 403)
    runtime = resolve_runtime(model)
    if type(runtime) is not dict or not isinstance(runtime.get("api_key"), str) or not runtime["api_key"]:
        raise ForwardError("PROVIDER_AUTH", 503)
    body = prepare_body(request, runtime, model, normalize)
    url = provider_url(runtime.get("base_url"), request["path"][3:])
    headers = {"Authorization": "Bearer " + runtime["api_key"], "Content-Type": "application/json", "Accept": "text/event-stream" if body.get("stream") else "application/json"}
    if codex_headers is not None:
        headers.update(codex_headers(runtime["api_key"], base_url=runtime["base_url"]))
    # Client construction sets follow_redirects=False and trust_env=False.
    # Provider endpoints come solely from the host runtime, never a worker.
    with client.stream("POST", url, headers=headers, json=body) as response:
        if response.status_code != 200:
            # Provider errors can contain request echoes or auth diagnostics.
            # Return only the HTTP status plus a static code.
            status = response.status_code if 400 <= response.status_code <= 599 else 502
            raise ForwardError("PROVIDER_UPSTREAM", status)
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        expected = "text/event-stream" if body.get("stream") else "application/json"
        if expected == "text/event-stream" and not content_type:
            # Some self-hosted compatible gateways omit the MIME header. A
            # real Responses SSE frame is required before any bytes are sent.
            chunks = iter(response.iter_bytes(chunk_size=16_384))
            prefix = bytearray()
            complete = False
            for chunk in chunks:
                prefix.extend(chunk)
                if len(prefix) > 65_536:
                    raise ForwardError("PROVIDER_RESPONSE")
                decoded = bytes(prefix).replace(b"\r\n", b"\n")
                for block in decoded.split(b"\n\n")[:-1]:
                    data = b"\n".join(line[5:].lstrip() for line in block.split(b"\n") if line.startswith(b"data:"))
                    if not data:
                        continue
                    try: event = json.loads(data)
                    except (ValueError, TypeError): raise ForwardError("PROVIDER_RESPONSE") from None
                    if type(event) is not dict or type(event.get("type")) is not str or not event["type"].startswith("response."):
                        raise ForwardError("PROVIDER_RESPONSE")
                    complete = True
                    break
                if complete:
                    break
            if not complete:
                raise ForwardError("PROVIDER_RESPONSE_EMPTY" if not prefix else "PROVIDER_RESPONSE")
            emit({"type": "headers", "status": 200, "contentType": expected})
            for offset in range(0, len(prefix), 16_384):
                emit({"type": "chunk", "data": base64.b64encode(prefix[offset:offset + 16_384]).decode()})
            for chunk in chunks:
                if chunk:
                    emit({"type": "chunk", "data": base64.b64encode(chunk).decode()})
            emit({"type": "end"})
            return
        if expected == "text/event-stream" and content_type == "application/json":
            # Some compatible Responses endpoints return a completed JSON
            # object even for streaming requests. Accept only the actual
            # completed-response contract; never pass error/debug JSON along.
            raw = bytearray()
            for chunk in response.iter_bytes(chunk_size=16_384):
                raw.extend(chunk)
                if len(raw) > 8_000_000:
                    raise ForwardError("PROVIDER_RESPONSE")
            try:
                result = json.loads(raw)
            except (ValueError, TypeError):
                raise ForwardError("PROVIDER_RESPONSE") from None
            if type(result) is dict and result.get("error"):
                raise ForwardError("PROVIDER_RESPONSE_ERROR")
            if request["path"] != "/v1/responses" or type(result) is not dict or result.get("object") != "response" or type(result.get("output")) is not list:
                raise ForwardError("PROVIDER_RESPONSE_JSON")
            if result.get("status") != "completed":
                raise ForwardError("PROVIDER_RESPONSE_INCOMPLETE")
            emit({"type": "headers", "status": 200, "contentType": expected})
            event = ("event: response.completed\ndata: " + json.dumps({"type": "response.completed", "response": result}) + "\n\n").encode()
            for offset in range(0, len(event), 16_384):
                emit({"type": "chunk", "data": base64.b64encode(event[offset:offset + 16_384]).decode()})
            emit({"type": "end"})
            return
        if content_type != expected:
            kind = {"text/html": "PROVIDER_RESPONSE_HTML", "text/plain": "PROVIDER_RESPONSE_TEXT", "": "PROVIDER_RESPONSE_EMPTY_TYPE", "application/octet-stream": "PROVIDER_RESPONSE_OCTET", "text/event-stream": "PROVIDER_RESPONSE_STREAM_TYPE", "application/x-ndjson": "PROVIDER_RESPONSE_NDJSON"}.get(content_type, "PROVIDER_RESPONSE_TYPE")
            raise ForwardError(kind)
        emit({"type": "headers", "status": 200, "contentType": expected})
        for chunk in response.iter_bytes(chunk_size=16_384):
            if chunk:
                emit({"type": "chunk", "data": base64.b64encode(chunk).decode()})
        emit({"type": "end"})


def main():
    # Save stdout before silencing any third-party import/credential diagnostics.
    channel = sys.stdout
    def emit(frame):
        channel.write(json.dumps(frame, separators=(",", ":")) + "\n")
        channel.flush()
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ForwardError("PROVIDER_REQUEST", 413)
        request = json.loads(raw)
        validate_request(request)
        with contextlib.redirect_stdout(sys.stderr):
            import httpx
            from agent.ssl_verify import install_truststore
            install_truststore()
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from agent.codex_headers import codex_cloudflare_headers, is_official_codex_base_url
            from agent.codex_responses_adapter import _preflight_codex_api_kwargs
            def load_model():
                settings = load_config().get("model", {})
                return settings.get("default") if type(settings) is dict else None
            def runtime(model):
                return resolve_runtime_provider(target_model=model)
            def identity(token, *, base_url):
                return codex_cloudflare_headers(token, base_url=base_url) if is_official_codex_base_url(base_url) else {}
            with httpx.Client(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(600.0, connect=20.0)) as client:
                serve(request, resolve_runtime=runtime, load_model=load_model, client=client, emit=emit,
                      normalize=lambda body: _preflight_codex_api_kwargs(body, allow_stream=True), codex_headers=identity)
    except ForwardError as error:
        emit({"type": "error", "code": error.code, "status": error.status})
    except Exception as error:
        # No raw exception, token, account ID or upstream response body.
        kind = type(error).__name__
        code = "PROVIDER_DEPENDENCY" if kind in ("ImportError", "ModuleNotFoundError") else "PROVIDER_PAYLOAD" if kind in ("ValueError", "JSONDecodeError") else "PROVIDER_TRANSPORT" if kind in ("ConnectError", "ConnectTimeout", "ReadError", "ReadTimeout", "RemoteProtocolError", "SSLError") else "PROVIDER_RUNTIME" if kind in ("AttributeError", "TypeError", "KeyError") else "PROVIDER_UNAVAILABLE"
        emit({"type": "error", "code": code, "status": 502})


if __name__ == "__main__":
    main()
