"""Resumable browser uploads (POST /uploads/multipart/*, backend/main.py):
part sizing, the stateless upload ticket and the telemetry rate limit.

The ticket is handed out by `init` and required by every later call:

    base64url(json{u, k, id, s, ps, n, ct, exp}) + "." + hex(HMAC-SHA256(K, payload))
    K = HMAC-SHA256(media secret, "upload-ticket-v1")

u = the caller (user id, "" with auth off), k = storage key, id = the R2
UploadId, s = size, ps = part size, n = parts, ct = content type, exp =
Unix time (resume_window_s: up to 7 days, never longer than the bucket's
lifecycle rules keep the upload). No server state: any replica can check
it.

stdlib only.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

MIB = 1024 * 1024
MIN_PART = 16 * MIB
# R2 allows 10,000 parts; stay well below so rounding never runs out.
TARGET_PARTS = 9500
# Ticket lifetime when the bucket's lifecycle rules aren't known (the
# token may not read them): fits the 1-day abort rule of before.
TICKET_TTL_S = 23 * 3600
# How long an interrupted upload can be resumed at most.
RESUME_MAX_S = 7 * 86400
# A ticket ends this long before the bucket aborts the upload.
ABORT_MARGIN_S = 3600
# ... and this long before a completed upload expires (S3 dates a
# multipart object by its initiation): time for POST /jobs + analysis.
EXPIRE_MARGIN_S = 86400
# Part URLs live at most this long (the client re-signs on a 403).
SIGN_TTL_S = 6 * 3600

# What an upload's key may end with (from the file name, lowercased).
VIDEO_EXTS = frozenset({
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".3g2",
    ".mts", ".m2ts", ".ts", ".mpg", ".mpeg", ".wmv", ".flv", ".hevc",
    ".qt",
})


class TicketError(Exception):
    """A ticket that isn't ours (403 bad_ticket) or expired (410)."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def resume_window_s(known: bool, abort_days: int | None,
                    expire_days: int | None) -> int:
    """Seconds a new upload's ticket (and so the browser's resume record,
    which keeps the ticket's expires_at) lives: RESUME_MAX_S, but never
    past what the bucket keeps — its incomplete parts (abort rule, minus
    ABORT_MARGIN_S) and the completed object (expiration rule, minus
    EXPIRE_MARGIN_S). Rules unknown → TICKET_TTL_S. At least an hour."""
    if not known:
        return TICKET_TTL_S
    window = RESUME_MAX_S
    if abort_days:
        window = min(window, abort_days * 86400 - ABORT_MARGIN_S)
    if expire_days:
        window = min(window, expire_days * 86400 - EXPIRE_MARGIN_S)
    return max(3600, int(window))


def part_plan(size: int) -> tuple[int, int]:
    """(part size, parts) for an upload of `size` bytes:
    max(16 MiB, ceil(size / 9500 / 1 MiB) MiB), ceil(size / part size)."""
    size = int(size)
    ps = max(MIN_PART, math.ceil(size / TARGET_PARTS / MIB) * MIB)
    return ps, max(1, math.ceil(size / ps))


def part_length(size: int, ps: int, n: int, number: int) -> int:
    """Exact byte length of part `number` (1-based): ps, or the rest."""
    if number < n:
        return ps
    return size - ps * (n - 1)


def upload_ext(filename: str | None) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in VIDEO_EXTS else ".mp4"


def upload_content_type(content_type: str | None) -> str:
    """video/* or application/octet-stream; anything else becomes the
    latter."""
    ct = (content_type or "").strip().lower()
    if len(ct) <= 100 and ct.startswith("video/") and all(
            c.isalnum() or c in "/.+-" for c in ct):
        return ct
    return "application/octet-stream"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _key(secret: str) -> bytes:
    return hmac.new(secret.encode(), b"upload-ticket-v1",
                    hashlib.sha256).digest()


def make_ticket(secret: str, claims: dict[str, Any]) -> str:
    payload = _b64(json.dumps(claims, separators=(",", ":"),
                              sort_keys=True).encode())
    sig = hmac.new(_key(secret), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def read_ticket(secret: str, ticket: Any, user_id: str,
                now: float | None = None) -> dict[str, Any]:
    """The claims of a valid ticket for `user_id`. Raises TicketError:
    403 bad_ticket (not ours, tampered, someone else's), 410
    upload_expired."""
    if not isinstance(ticket, str) or ticket.count(".") != 1 or len(ticket) > 4096:
        raise TicketError(403, "bad_ticket")
    payload, sig = ticket.split(".")
    want = hmac.new(_key(secret), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig.encode("latin-1", "replace"), want.encode()):
        raise TicketError(403, "bad_ticket")
    try:
        claims = json.loads(_unb64(payload))
    except (ValueError, TypeError):
        raise TicketError(403, "bad_ticket") from None
    if not isinstance(claims, dict) or claims.get("u") != user_id:
        raise TicketError(403, "bad_ticket")
    try:
        exp = float(claims["exp"])
        for k in ("s", "ps", "n"):
            claims[k] = int(claims[k])
        str(claims["k"]), str(claims["id"])
    except (KeyError, TypeError, ValueError):
        raise TicketError(403, "bad_ticket") from None
    if (time.time() if now is None else now) >= exp:
        raise TicketError(410, "upload_expired")
    return claims


class RateLimit:
    """At most `limit` events per `window` seconds per key (in-process)."""

    def __init__(self, limit: int, window: float = 60.0) -> None:
        self.limit = limit
        self.window = window
        self._lock = threading.Lock()
        self._events: dict[str, deque] = {}

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._events.setdefault(key, deque())
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            if len(self._events) > 10000:  # forget idle keys
                for k in [k for k, v in self._events.items() if not v]:
                    del self._events[k]
            return True
