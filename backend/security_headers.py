"""Security headers on every HTTP response — pure ASGI middleware.

Pure ASGI on purpose, not BaseHTTPMiddleware: it only touches the
`http.response.start` message and passes every body chunk straight
through, so streamed and Range (206) video responses are never buffered.
A header the route (or an inner middleware) already set is left alone.

    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    X-Frame-Options: DENY
    Strict-Transport-Security: max-age=63072000; includeSubDomains
        (no preload — hard to undo; browsers ignore it over plain http)
    Cross-Origin-Resource-Policy: cross-origin
        The web app runs on another origin and loads media from this API
        with plain <video src> / <img src> (no-cors requests):
        /jobs/{id}/preview-video, /watch, /thumbnail, /download and the
        caption previews. `same-site` or `same-origin` would make the
        browser block them. Everything here is behind auth (bearer token
        or per-user ?t= media token) anyway.

Wiring (backend/main.py): add it right after _BodyLimitMiddleware and
before CORSMiddleware, so CORS stays outermost and the 413s of the body
limit get the headers too:

    app.add_middleware(_BodyLimitMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    ... CORSMiddleware ...

CORS preflights are answered by CORSMiddleware itself and don't carry
these headers; they don't need them (CORP only applies to no-cors
requests).
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping

Scope = dict
Message = dict
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

DEFAULT_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Cross-Origin-Resource-Policy": "cross-origin",
}


def _encode(headers: Mapping[str, str]) -> tuple[tuple[bytes, bytes], ...]:
    return tuple((name.lower().encode("latin-1"), value.encode("latin-1"))
                 for name, value in headers.items())


class SecurityHeadersMiddleware:
    """Adds `headers` (default DEFAULT_HEADERS) to every HTTP response
    that doesn't already have them. WebSocket and lifespan pass through."""

    def __init__(self, app: ASGIApp,
                 headers: Mapping[str, str] | None = None) -> None:
        self.app = app
        self.headers = _encode(DEFAULT_HEADERS if headers is None
                               else headers)

    async def __call__(self, scope: Scope, receive: Receive,
                       send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = self._with_headers(message)
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _with_headers(self, message: Message) -> Message:
        raw: list[Any] = list(message.get("headers") or ())
        present = {bytes(name).lower() for name, _ in raw}
        missing = [(name, value) for name, value in self.headers
                   if name not in present]
        if not missing:
            return message
        return {**message, "headers": raw + missing}

