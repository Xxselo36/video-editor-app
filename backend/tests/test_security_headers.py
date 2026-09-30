"""backend/security_headers.py — on a small standalone app wrapped the
way backend/main.py wraps its app (body limit innermost, then security
headers, CORS outermost). Doesn't import backend.main."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse, JSONResponse, Response, StreamingResponse,
)
from fastapi.testclient import TestClient

from backend.security_headers import DEFAULT_HEADERS, SecurityHeadersMiddleware

EXPECTED = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "cross-origin-resource-policy": "cross-origin",
}
WEB = "http://localhost:3000"
VIDEO = bytes(range(256)) * 400  # 102400 bytes


class _BodyLimit:
    """Stand-in for main.py's _BodyLimitMiddleware: 413 straight from
    Content-Length."""

    def __init__(self, app, limit: int = 1024) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            for name, value in scope.get("headers") or ():
                if name == b"content-length" and int(value) > self.limit:
                    return await JSONResponse(
                        {"detail": "request_too_large", "code": "request_too_large", "params": {}}, status_code=413,
                        headers={"Connection": "close"},
                    )(scope, receive, send)
        await self.app(scope, receive, send)


def _app(tmp_path) -> FastAPI:
    video = tmp_path / "out.mp4"
    video.write_bytes(VIDEO)
    app = FastAPI()

    @app.get("/json")
    def json_route():
        return {"ok": True}

    @app.post("/upload")
    def upload():
        return {"ok": True}

    @app.get("/stream")
    def stream():
        def chunks():
            for i in range(5):
                yield f"chunk{i}\n".encode()
        return StreamingResponse(chunks(), media_type="text/plain")

    @app.get("/watch")
    def watch():
        return FileResponse(video, media_type="video/mp4",
                            headers={"Accept-Ranges": "bytes"})

    @app.get("/own-headers")
    def own_headers():
        return Response("x", headers={
            "X-Frame-Options": "SAMEORIGIN",
            "Cross-Origin-Resource-Policy": "same-site",
            "Referrer-Policy": "strict-origin",
        })

    @app.get("/boom")
    def boom():
        from fastapi import HTTPException
        raise HTTPException(409, "not ready")

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("hi")
        await websocket.close()

    # Same order as backend/main.py: first added = innermost.
    app.add_middleware(_BodyLimit)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):3000",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag", "Retry-After"],
    )
    return app


@pytest.fixture
def client(tmp_path):
    return TestClient(_app(tmp_path))


def _assert_security_headers(response, skip=()):
    for name, value in EXPECTED.items():
        if name in skip:
            continue
        assert response.headers.get_list(name) == [value], name


def test_default_headers_match_spec():
    assert {k.lower(): v for k, v in DEFAULT_HEADERS.items()} == EXPECTED


def test_json_response(client):
    r = client.get("/json")
    assert r.status_code == 200 and r.json() == {"ok": True}
    _assert_security_headers(r)
    assert r.headers["content-type"] == "application/json"


def test_error_and_404_responses(client):
    _assert_security_headers(client.get("/boom"))
    _assert_security_headers(client.get("/nope"))
    r = client.head("/json")
    assert r.status_code == 405
    _assert_security_headers(r)


def test_streaming_response(client):
    r = client.get("/stream")
    assert r.status_code == 200
    assert r.text == "".join(f"chunk{i}\n" for i in range(5))
    _assert_security_headers(r)


def test_range_file_response_206(client):
    r = client.get("/watch", headers={"Range": "bytes=100-1123"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 100-1123/{len(VIDEO)}"
    assert r.headers["content-length"] == "1024"
    assert r.content == VIDEO[100:1124]
    _assert_security_headers(r)
    full = client.get("/watch")
    assert full.status_code == 200 and full.content == VIDEO
    _assert_security_headers(full)


def test_existing_headers_are_not_overridden(client):
    r = client.get("/own-headers")
    assert r.headers.get_list("x-frame-options") == ["SAMEORIGIN"]
    assert r.headers.get_list("cross-origin-resource-policy") == ["same-site"]
    assert r.headers.get_list("referrer-policy") == ["strict-origin"]
    _assert_security_headers(r, skip=("x-frame-options", "referrer-policy",
                                       "cross-origin-resource-policy"))


def test_body_limit_413_gets_headers_and_cors(client):
    r = client.post("/upload", content=b"x" * 2048,
                    headers={"Origin": WEB})
    assert r.status_code == 413
    assert r.json() == {"detail": "request_too_large", "code": "request_too_large", "params": {}}
    assert r.headers["access-control-allow-origin"] == WEB
    _assert_security_headers(r)


def test_cors_preflight_still_ok(client):
    r = client.options("/upload", headers={
        "Origin": WEB,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == WEB
    assert r.headers["access-control-allow-credentials"] == "true"
    assert "POST" in r.headers["access-control-allow-methods"]
    assert "authorization" in r.headers["access-control-allow-headers"]
    # Disallowed origin: still CORS's answer.
    bad = client.options("/upload", headers={
        "Origin": "https://evil.example",
        "Access-Control-Request-Method": "POST",
    })
    assert bad.status_code == 400
    assert "access-control-allow-origin" not in bad.headers


def test_cors_simple_request_has_both(client):
    r = client.get("/watch", headers={"Origin": WEB, "Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.headers["access-control-allow-origin"] == WEB
    assert "retry-after" in r.headers["access-control-expose-headers"].lower()
    _assert_security_headers(r)


def test_websocket_passes_through(client):
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_text() == "hi"


def test_custom_header_set():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 204,
                    "headers": [(b"X-Frame-Options", b"SAMEORIGIN")]})
        await send({"type": "http.response.body", "body": b""})

    wrapped = SecurityHeadersMiddleware(
        app, headers={"X-Frame-Options": "DENY", "X-Test": "1"})
    r = TestClient(wrapped).get("/")
    # Existing header matched case-insensitively, not duplicated.
    assert r.headers.get_list("x-frame-options") == ["SAMEORIGIN"]
    assert r.headers["x-test"] == "1"
    assert "strict-transport-security" not in r.headers


def test_does_not_buffer_streaming_bodies():
    """The response start and the first chunk reach the server before
    the app produces the second chunk — which it only does once the
    first one was sent. A buffering middleware would deadlock here."""
    first_chunk_sent = asyncio.Event()

    async def chunks():
        yield b"first"
        await first_chunk_sent.wait()
        yield b"second"

    inner = StreamingResponse(chunks(), media_type="video/mp4")
    wrapped = SecurityHeadersMiddleware(inner)
    sent: list[dict] = []

    async def receive():
        await asyncio.sleep(3600)  # client never disconnects
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body" and \
                message.get("body") == b"first":
            first_chunk_sent.set()

    scope = {"type": "http", "asgi": {"version": "3.0"},
             "http_version": "1.1", "method": "GET", "path": "/",
             "raw_path": b"/", "query_string": b"", "headers": [],
             "scheme": "http", "server": ("test", 80)}

    async def run():
        await asyncio.wait_for(wrapped(scope, receive, send), timeout=5)

    asyncio.run(run())
    assert [m["type"] for m in sent] == [
        "http.response.start", "http.response.body", "http.response.body",
        "http.response.body"]
    headers = dict(sent[0]["headers"])
    assert headers[b"x-content-type-options"] == b"nosniff"
    assert headers[b"cross-origin-resource-policy"] == b"cross-origin"
    assert [m.get("body") for m in sent[1:]] == [b"first", b"second", b""]
