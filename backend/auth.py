"""Sign-in for the web backend: Clerk session JWTs, job ownership and
tokens for media URLs.

OFF until CLERK_ISSUER is set (e.g. https://clerk.cleocuts.com, the
Clerk Frontend API URL = the `iss` of its session tokens). While off,
every dependency here returns None and the backend behaves exactly as
before accounts existed (anonymous; a job id is all it takes).

When on:
  * `Authorization: Bearer <Clerk session token>` (RS256). Keys come from
    CLERK_JWT_KEY (PEM, networkless — recommended for production) or
    `<CLERK_ISSUER>/.well-known/jwks.json` (key set cached 5 min, so a key
    Clerk removes stops working; the last good set is kept while the
    endpoint is down). exp/nbf get 60 s leeway — a legacy upload can take longer
    than the token's 60 s lifetime and FastAPI only runs dependencies
    after the whole body has arrived. `azp` must be one of
    CLERK_AUTHORIZED_PARTIES (comma list of the web app's origins).
  * `X-Admin-Token: <CLEO_ADMIN_TOKEN>` → service user `svc:admin`: sees
    every job, no quota, may tag jobs `_cost_test` (cost_test.py).
  * <video>/<img>/<a> can't send headers, so the media routes also take
    `?t=<media token>` (GET /me hands it out): HMAC of the user id and
    the UTC day, valid that day and the next, so a player's src never
    changes during an editing session.

PyJWT is imported lazily: with auth off the backend runs without it.
Only backend/main.py imports this module.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request

from backend import accounts
from backend.jobs import Job, store

DEFAULT_AUTHORIZED_PARTIES = (
    "https://cleocuts.com,https://www.cleocuts.com,http://localhost:3000"
)
# Clerk tokens live 60 s; the upload body is read before we check it.
_LEEWAY_S = 60
# Media tokens: one window per UTC day, current + previous accepted.
_MEDIA_WINDOW_S = 86400
# JWKS: fetch timeout; after a failed fetch, requests fail fast for this
# long instead of each waiting out another timeout (the client holds a
# lock while fetching, so they would queue up); the last good key set
# is still served for up to _JWKS_STALE_S while the endpoint is down.
_JWKS_TIMEOUT_S = 5
_JWKS_RETRY_S = 30
_JWKS_STALE_S = 6 * 3600


@dataclass(frozen=True)
class User:
    id: str
    email: str | None = None
    is_service: bool = False


SERVICE_USER = User(id="svc:admin", is_service=True)


def issuer() -> str:
    return os.environ.get("CLERK_ISSUER", "").strip().rstrip("/")


def auth_enabled() -> bool:
    return bool(issuer())


def authorized_parties() -> set[str]:
    raw = os.environ.get("CLERK_AUTHORIZED_PARTIES", "").strip()
    raw = raw or DEFAULT_AUTHORIZED_PARTIES
    return {p.strip().rstrip("/") for p in raw.split(",") if p.strip()}


# ── JWT ──────────────────────────────────────────────────────────────

_jwks_lock = threading.Lock()
_jwks: tuple[str, Any] | None = None  # (url, PyJWKClient)


def _make_jwks_client(url: str):
    """PyJWKClient without its per-kid LRU cache (`cache_keys`): that one
    never expires, so a key Clerk removed from its JWKS (rotation after a
    leak) stayed trusted until the process restarted. Only the key set
    is cached (5 min). To not trade that for outages, the last good set
    is served while the endpoint fails, and after a failure requests
    fail fast for _JWKS_RETRY_S instead of queueing on the fetch lock."""
    import jwt

    class _Client(jwt.PyJWKClient):
        _last_good: tuple[float, Any] | None = None
        _failed_at = float("-inf")

        def _stale(self, now: float):
            if self._last_good and now - self._last_good[0] < _JWKS_STALE_S:
                return self._last_good[1]
            return None

        def fetch_data(self):
            now = time.monotonic()
            if now - self._failed_at < _JWKS_RETRY_S:
                stale = self._stale(now)
                if stale is not None:
                    return stale
                raise jwt.PyJWKClientConnectionError(
                    "JWKS unreachable (retrying shortly)")
            try:
                data = super().fetch_data()
            except jwt.PyJWKClientConnectionError:
                self._failed_at = now
                stale = self._stale(now)
                if stale is not None:
                    print("[auth] JWKS fetch failed — using the last good "
                          "key set", flush=True)
                    return stale
                raise
            self._last_good = (now, data)
            return data

    return _Client(url, cache_keys=False, lifespan=300,
                   timeout=_JWKS_TIMEOUT_S)


def _jwks_client(url: str):
    global _jwks
    with _jwks_lock:
        if _jwks is None or _jwks[0] != url:
            _jwks = (url, _make_jwks_client(url))
        return _jwks[1]


def _signing_key(token: str):
    pem = os.environ.get("CLERK_JWT_KEY", "").strip()
    if pem:
        # Env UIs often keep the PEM on one line with literal "\n".
        return pem.replace("\\n", "\n")
    url = f"{issuer()}/.well-known/jwks.json"
    return _jwks_client(url).get_signing_key_from_jwt(token).key


def verify_token(token: str) -> dict[str, Any]:
    """Claims of a valid Clerk session token; raises jwt.InvalidTokenError
    (or PyJWKClientError when the keys can't be fetched)."""
    import jwt
    header = jwt.get_unverified_header(token)
    if header.get("typ", "JWT") != "JWT":  # e.g. OAuth "at+jwt"
        raise jwt.InvalidTokenError("wrong token type")
    if header.get("cat") == "cl_B7d4PD333AAA":  # Clerk M2M token
        raise jwt.InvalidTokenError("machine token")
    claims = jwt.decode(
        token,
        _signing_key(token),
        algorithms=["RS256"],
        issuer=issuer(),
        leeway=_LEEWAY_S,
        options={"require": ["exp", "iat", "sub", "iss", "sid"],
                 "verify_aud": False},
    )
    azp = (claims.get("azp") or "").rstrip("/")
    if not azp or azp not in authorized_parties():
        raise jwt.InvalidTokenError(f"azp {claims.get('azp')!r} not allowed")
    if claims.get("sts") == "pending":
        raise jwt.InvalidTokenError("session pending")
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise jwt.InvalidTokenError("no subject")
    return claims


def _auth_required() -> HTTPException:
    # Always 401 for credential problems — the frontend treats 404 as
    # "project gone" and would drop it.
    return HTTPException(401, "auth_required")


def _admin_user(request: Request) -> User | None:
    expected = os.environ.get("CLEO_ADMIN_TOKEN", "")
    got = request.headers.get("x-admin-token", "")
    if expected and got and hmac.compare_digest(
            got.encode("latin-1", "replace"), expected.encode()):
        return SERVICE_USER
    return None


def _bearer_user(request: Request) -> User | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return None
    try:
        claims = verify_token(token)
    except Exception as e:  # invalid, expired, JWKS unreachable, ...
        if type(e).__name__ != "ExpiredSignatureError":
            # repr + cut: messages can quote the token's (unverified)
            # header, e.g. a `kid` with newlines forging log lines.
            print(f"[auth] token rejected: {type(e).__name__}: "
                  f"{str(e)[:120]!r}", flush=True)
        raise _auth_required() from None
    email = claims.get("email")
    return User(id=claims["sub"],
                email=email if isinstance(email, str) else None)


def log_status() -> None:
    """Called at startup: recommend the networkless key, and warm the
    JWKS cache in the background so the first request doesn't wait."""
    if not auth_enabled():
        return
    if os.environ.get("CLERK_JWT_KEY", "").strip():
        print("[auth] on — tokens verified with CLERK_JWT_KEY", flush=True)
        return
    url = f"{issuer()}/.well-known/jwks.json"
    print(f"[auth] on — tokens verified with keys from {url}. Recommended "
          "for production: set CLERK_JWT_KEY (Clerk Dashboard → API Keys → "
          "JWT public key), then sign-in doesn't depend on reaching Clerk.",
          flush=True)

    def warm():
        try:
            _jwks_client(url).get_jwk_set()
        except Exception as e:
            print(f"[auth] JWKS prefetch failed: {str(e)[:120]!r}",
                  flush=True)
    threading.Thread(target=warm, daemon=True).start()


# ── FastAPI dependencies (plain def: the JWKS fetch blocks) ──────────


def current_user(request: Request) -> User | None:
    """The caller. None only while auth is off (anonymous, as before
    accounts); otherwise a verified user or 401 auth_required."""
    if not auth_enabled():
        return None
    user = _admin_user(request) or _bearer_user(request)
    if user is None:
        raise _auth_required()
    return user


def require_user(request: Request) -> User:
    """For routes that only exist with accounts: 404 not_available while
    auth is off (the frontend then keeps using localStorage)."""
    if not auth_enabled():
        raise HTTPException(404, "not_available")
    return current_user(request)


def media_user(request: Request) -> User | None:
    """current_user, or the `t` media token for <video>/<img>/<a> URLs."""
    if not auth_enabled():
        return None
    user = _admin_user(request)
    if user is not None:
        return user
    try:
        user = _bearer_user(request)
    except HTTPException:
        if not request.query_params.get("t"):
            raise
        user = None
    user = user or _media_token_user(request)
    if user is None:
        raise _auth_required()
    return user


# ── media tokens ─────────────────────────────────────────────────────


def _window(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // _MEDIA_WINDOW_S)


def _media_sig(user_id: str, window: int) -> str:
    key = accounts.media_secret().encode()
    msg = f"u={user_id}&w={window}".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def media_token(user_id: str, now: float | None = None) -> str:
    """Token for the media routes: `<user id>.<day>.<hmac>`. The same all
    UTC day, so the URL of a playing <video> never has to change."""
    w = _window(now)
    return f"{user_id}.{w}.{_media_sig(user_id, w)}"


def verify_media_token(token: str, now: float | None = None) -> str | None:
    """User id of a valid media token (issued today or yesterday)."""
    try:
        user_id, w_str, sig = token.rsplit(".", 2)
        w = int(w_str)
    except ValueError:
        return None
    if not user_id or w not in (_window(now), _window(now) - 1):
        return None
    if not hmac.compare_digest(sig.encode("latin-1", "replace"),
                               _media_sig(user_id, w).encode()):
        return None
    return user_id


def _media_token_user(request: Request) -> User | None:
    token = request.query_params.get("t")
    if not token:
        return None
    user_id = verify_media_token(token)
    if user_id is None:
        raise _auth_required()
    return User(id=user_id)


# ── job ownership ────────────────────────────────────────────────────


def get_owned_job(job_id: str, user: User | None) -> Job:
    """The job if `user` may see it, else 404 (same as a missing job, so
    ids of other people's projects don't leak). Beta jobs without an
    owner are claimed by the first signed-in user who opens them — the
    job id was the only key to them until now."""
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if user is None or user.is_service:
        return job
    if job.owner_id is None:
        owner = store.claim(job_id, user.id)
        if owner == user.id:
            job.owner_id = owner
            print(f"[auth] {user.id} claimed beta job {job_id}", flush=True)
            return job
        raise HTTPException(404, "job not found")
    if job.owner_id == user.id:
        return job
    raise HTTPException(404, "job not found")


def upload_prefix(user: User | None) -> str:
    """R2 key prefix for a caller's uploads (`uploads/<user id>/`)."""
    if user is None:
        return "uploads/"
    return "uploads/" + re.sub(r"[^A-Za-z0-9_-]", "-", user.id) + "/"


# ── logging ──────────────────────────────────────────────────────────

_TOKEN_RE = re.compile(r"([?&]t=)[^&\s\"]*")


class RedactMediaTokens(logging.Filter):
    """Blank `t=` query values in uvicorn access-log lines, so media
    tokens don't end up in Railway's logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and record.args:
            record.args = tuple(
                _TOKEN_RE.sub(r"\1[redacted]", a) if isinstance(a, str) else a
                for a in record.args)
        elif isinstance(record.msg, str) and "t=" in record.msg:
            record.msg = _TOKEN_RE.sub(r"\1[redacted]", record.msg)
        return True


def install_log_filter() -> None:
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, RedactMediaTokens) for f in logger.filters):
        logger.addFilter(RedactMediaTokens())
