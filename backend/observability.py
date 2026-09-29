"""Backend error monitoring (Sentry) — off unless SENTRY_DSN is set.

    init_sentry()          once, at startup, before FastAPI() and the routes
    capture(exc, **tags)   report an exception that was caught and handled

Both are no-ops without SENTRY_DSN, and when sentry-sdk isn't installed
(then init_sentry logs one warning). sentry_sdk is imported lazily, inside
init_sentry, so this module imports anywhere. Only backend/main.py should
import it: backend.jobs/costs/llm/whisper_groq/pipeline, src/ and plugins/
are shared with the desktop app and the Modal image and must not.

What gets reported:
  - unhandled exceptions in routes and 5xx HTTPExceptions (FastAPI/
    Starlette integration), uncaught exceptions in threads;
  - log records at ERROR and above become events; INFO/WARNING records
    are kept as breadcrumbs on the next event;
  - capture(exc, job_id=..., phase=...) for failures the code handles
    itself (worker threads catch everything and mark the job failed).

What never leaves the server (scrub_event / scrub_breadcrumb run on every
error, transaction and breadcrumb; if a scrubber fails the item is
dropped, never sent unscrubbed):
  - request bodies and cookies (they are also never read:
    max_request_body_size="never", send_default_pii=False);
  - the headers Authorization, Cookie, X-Admin-Token, X-Api-Key, every
    header whose name contains token/secret/signature (Lemon Squeezy's
    X-Signature, ...) and client-IP headers;
  - query strings and fragments of every URL anywhere in the event
    (media ?t= tokens, presigned R2 X-Amz-Signature=...), URL userinfo
    (postgres://user:password@...), bearer tokens, JWTs, API keys;
  - email addresses, in messages and everywhere else;
  - values of keys that look like secrets (token, secret, password,
    query, ...);
  - local variables of stack frames (include_local_variables=False: they
    hold transcripts, i.e. video content, and user data) and ffmpeg
    command lines (drawtext carries subtitle text): subprocess
    breadcrumbs/spans and CalledProcessError/TimeoutExpired messages
    keep only the program name;
  - GPS positions (ISO 6709, "+52.5163+013.3777/") that ffmpeg prints
    from phone-video metadata into the stderr tails of pipeline errors.

Not covered: free text a caller puts into an exception message itself
(a transcript quoted in a ValueError, say) — keep user content out of
exception and log.error messages.

Env:
  SENTRY_DSN                  on/off switch (never logged)
  SENTRY_TRACES_SAMPLE_RATE   0..1, default 0 = no performance tracing
  SENTRY_ENVIRONMENT          else RAILWAY_ENVIRONMENT_NAME, else the
                              SDK's default ("production")
  RAILWAY_GIT_COMMIT_SHA      release (set by Railway on every deploy)
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

_log = logging.getLogger(__name__)

_enabled = False

FILTERED = "[Filtered]"

# ── Headers ──────────────────────────────────────────────────────────
_DROP_HEADERS = frozenset({
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-admin-token", "x-api-key",
    # Client IPs (Railway's edge sets these).
    "x-real-ip", "x-client-ip", "cf-connecting-ip", "true-client-ip",
    "x-envoy-external-address", "forwarded", "x-forwarded-for",
})
_DROP_HEADER_PARTS = ("token", "secret", "signature", "forwarded")

# ── Keys whose values are secrets, wherever they appear ──────────────
_SENSITIVE_KEY = re.compile(
    r"token|secret|signature|passw|authorization|cookie|api[-_]?key|"
    r"credential|private[-_]?key|dsn|jwt|x-amz-|"
    # query strings wherever they turn up (query_string, http.query,
    # url.query): bare "t=…&X-Amz-Signature=…", no "?" for scrub_text.
    r"query",
    re.IGNORECASE,
)
# Source lines of stack frames: code, not runtime data — left readable.
_SOURCE_KEYS = frozenset({"pre_context", "context_line", "post_context"})
# Payloads in breadcrumb / span data.
_PAYLOAD_KEYS = ("body", "request_body", "response_body", "input",
                 "response", "http.query", "http.fragment",
                 "http.request.body", "http.response.body")
_MAX_DEPTH = 40

# ── Text patterns ────────────────────────────────────────────────────
# str() of subprocess.CalledProcessError / TimeoutExpired carries the
# whole argv (ffmpeg drawtext=text='<transcript>', filter graphs, paths):
# "Command '[...]' returned non-zero exit status 1." → "Command 'ffmpeg' …"
_COMMAND = re.compile(
    r"(Command ')(.*)(' (?:returned non-zero exit status|died with"
    r"|timed out after))", re.S)
# ISO 6709 GPS positions from video metadata: ffmpeg prints them
# ("location : +52.5163+013.3777/") in the stderr tails that pipeline
# errors carry.
_GEO = re.compile(
    r"[+-]\d{2,6}(?:\.\d+)?[+-]\d{3,7}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?"
    r"(?:CRS[A-Za-z0-9_:]*)?/")
# scheme://user:password@host → scheme://[Filtered]@host
_USERINFO = re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/?#@\"'<>`]+@", re.I)
# Absolute URLs: keep scheme://host/path, drop ?query and #fragment.
_URL_QUERY = re.compile(
    r"\b((?:https?|wss?)://[^\s\"'<>`?#]*)[?#][^\s\"'<>`]*", re.I)
# Relative ones ("/jobs/x/watch?t=…", "…/download?dl&t=…") and bare
# "?a=b" query strings.
_REL_QUERY = re.compile(r"\?[^\s\"'<>`=?#]*=[^\s\"'<>`]*")
_BEARER = re.compile(r"\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}", re.I)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*")
_API_KEY = re.compile(
    r"\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}"
    r"|whsec_[A-Za-z0-9+/=_-]{8,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}"
    r"|AKIA[0-9A-Z]{16})")
_EMAIL = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


def scrub_text(s: str) -> str:
    """Strip query strings, credentials and email addresses from text."""
    if not s:
        return s
    s = _COMMAND.sub(lambda m: m.group(1) + _program(m.group(2))
                     + m.group(3), s)
    s = _GEO.sub("[location]", s)
    s = _USERINFO.sub(r"\1" + FILTERED + "@", s)
    s = _URL_QUERY.sub(r"\1", s)
    s = _REL_QUERY.sub("", s)
    s = _BEARER.sub(lambda m: f"{m.group(1)} {FILTERED}", s)
    s = _JWT.sub(FILTERED, s)
    s = _API_KEY.sub(FILTERED, s)
    return _EMAIL.sub("[email]", s)


def _scrub(value: Any, depth: int = 0) -> Any:
    """scrub_text on every string, FILTERED for secret-looking keys (in
    place for dicts and lists, like Sentry's own event processors)."""
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, (dict, list, tuple)) and depth > _MAX_DEPTH:
        return FILTERED  # fail closed, never pass on unscrubbed data
    if isinstance(value, dict):
        for key in list(value):
            if not isinstance(key, str):
                value[key] = _scrub(value[key], depth + 1)
            elif key in _SOURCE_KEYS:
                continue
            elif _SENSITIVE_KEY.search(key):
                if value[key] not in (None, "", [], {}):
                    value[key] = FILTERED
            else:
                value[key] = _scrub(value[key], depth + 1)
        return value
    if isinstance(value, list):
        for i, item in enumerate(value):
            value[i] = _scrub(item, depth + 1)
        return value
    if isinstance(value, tuple):
        return tuple(_scrub(item, depth + 1) for item in value)
    return value


def _drop_header(name: Any) -> bool:
    n = str(name).strip().lower()
    return n in _DROP_HEADERS or any(p in n for p in _DROP_HEADER_PARTS)


def _filter_headers(headers: Any) -> Any:
    if isinstance(headers, dict):
        return {k: v for k, v in headers.items() if not _drop_header(k)}
    if isinstance(headers, (list, tuple)):  # [[name, value], ...]
        return [h for h in headers
                if isinstance(h, (list, tuple)) and len(h) == 2
                and not _drop_header(h[0])]
    return {}


def _program(command: Any) -> str:
    """'/usr/bin/ffmpeg -y -i … drawtext=text=…' → 'ffmpeg'."""
    first = str(command or "").strip().lstrip("'\"[(").split(" ", 1)[0]
    first = first.rstrip("'\",)]")
    return os.path.basename(first) or "subprocess"


def scrub_breadcrumb(crumb: dict, hint: Any = None) -> dict | None:
    """before_breadcrumb: breadcrumbs keep what happened, never payloads."""
    try:
        data = crumb.get("data")
        if isinstance(data, dict):
            for key in _PAYLOAD_KEYS:
                data.pop(key, None)
        if "subprocess" in (crumb.get("type"), crumb.get("category")):
            crumb["message"] = _program(crumb.get("message"))
        return _scrub(crumb)
    except Exception:
        return None


def scrub_event(event: dict, hint: Any = None) -> dict | None:
    """before_send / before_send_transaction."""
    try:
        # The serializer's annotations ({"": {"rem": …, "len": …}}, no
        # values): text-scrubbed below, but not key-filtered — "[Filtered]"
        # in place of a meta object is malformed.
        meta = event.pop("_meta", None)
        request = event.get("request")
        if isinstance(request, dict):
            for key in ("data", "cookies", "query_string"):
                request.pop(key, None)
            if "headers" in request:
                request["headers"] = _filter_headers(request["headers"])
            env = request.get("env")
            if isinstance(env, dict):
                env.pop("REMOTE_ADDR", None)
        if "user" in event:  # an id at most — no email, name or IP
            user = event.pop("user")
            if isinstance(user, dict) and user.get("id"):
                event["user"] = {"id": user["id"]}
        crumbs = event.get("breadcrumbs")
        values = crumbs.get("values") if isinstance(crumbs, dict) else crumbs
        if isinstance(values, list):
            values[:] = [c for c in (scrub_breadcrumb(c) for c in values
                                     if isinstance(c, dict))
                         if c is not None]
        for span in event.get("spans") or ():
            if not isinstance(span, dict):
                continue
            if str(span.get("op") or "").startswith("subprocess"):
                span["description"] = _program(span.get("description"))
            data = span.get("data")
            if isinstance(data, dict):
                for key in _PAYLOAD_KEYS:
                    data.pop(key, None)
        event = _scrub(event)
        if isinstance(meta, dict):
            event["_meta"] = _scrub_text_only(meta)
        return event
    except Exception:
        return None


def _scrub_text_only(value: Any, depth: int = 0) -> Any:
    """scrub_text on every string, keys left alone (for _meta)."""
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, (dict, list)) and depth > _MAX_DEPTH:
        return {}
    if isinstance(value, dict):
        return {k: _scrub_text_only(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub_text_only(v, depth + 1) for v in value]
    return value


def _traces_sample_rate() -> float | None:
    """SENTRY_TRACES_SAMPLE_RATE in (0, 1], else None: tracing off
    entirely (0.0 would still build a transaction per request)."""
    try:
        rate = float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "").strip()
                     or 0)
    except ValueError:
        return None
    if not rate > 0:  # also NaN
        return None
    return min(rate, 1.0)


def enabled() -> bool:
    return _enabled


def init_sentry(**overrides: Any) -> bool:
    """Start Sentry if SENTRY_DSN is set. Returns whether it is on.

    Never raises: without the package or with a bad DSN it logs one
    warning and the app runs without error monitoring. `overrides` go
    to sentry_sdk.init as they are (tests pass a transport)."""
    global _enabled
    if _enabled:
        return True
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import (
            LoggingIntegration, ignore_logger,
        )
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        _log.warning("SENTRY_DSN is set but sentry-sdk is not installed "
                     "(pip install 'sentry-sdk[fastapi]'): error "
                     "monitoring is off")
        return False
    except Exception as e:  # DidNotEnable (not an ImportError) when an
        # integration can't import what it patches, e.g. after an
        # incompatible Starlette/FastAPI upgrade: run without Sentry.
        _log.warning("sentry-sdk integrations unavailable (%s): error "
                     "monitoring is off", type(e).__name__)
        return False

    environment = (os.environ.get("SENTRY_ENVIRONMENT", "").strip()
                   or os.environ.get("RAILWAY_ENVIRONMENT_NAME", "").strip()
                   or None)
    release = os.environ.get("RAILWAY_GIT_COMMIT_SHA", "").strip() or None
    options: dict[str, Any] = dict(
        dsn=dsn,
        environment=environment,
        release=release,
        traces_sample_rate=_traces_sample_rate(),
        send_default_pii=False,
        max_request_body_size="never",
        include_local_variables=False,
        # No sentry-trace/baggage headers on calls to R2, Groq, Anthropic,
        # Modal, Clerk, Lemon Squeezy.
        trace_propagation_targets=[],
        # Only the integrations listed here (plus the SDK defaults:
        # threads, excepthook, http.client, subprocess, ...) — not every
        # library the SDK finds installed (anthropic, openai, boto3, ...).
        auto_enabling_integrations=False,
        integrations=[
            StarletteIntegration(transaction_style="url"),
            FastApiIntegration(transaction_style="url"),
            LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
        ],
        before_send=scrub_event,
        before_send_transaction=scrub_event,
        before_breadcrumb=scrub_breadcrumb,
    )
    options.update(overrides)
    try:
        sentry_sdk.init(**options)
    except Exception as e:  # e.g. BadDsn — never print the DSN itself
        _log.warning("Sentry init failed (%s): error monitoring is off",
                     type(e).__name__)
        return False
    # One line per request, after the response: noise, and it would
    # carry the request's query string.
    ignore_logger("uvicorn.access")
    _enabled = True
    print(f"[sentry] on — environment={environment or 'production'}, "
          f"release={(release or 'auto')[:12]}, "
          f"traces={options['traces_sample_rate'] or 0}", flush=True)
    return True


def capture(exc: BaseException, **tags: Any) -> None:
    """Report a handled exception, with tags (job_id=..., phase=...).
    A no-op while Sentry is off; never raises."""
    if not _enabled:
        return
    try:
        import sentry_sdk
        with sentry_sdk.new_scope() as scope:
            for key, value in tags.items():
                if value is not None:
                    scope.set_tag(key, str(value)[:200])
            sentry_sdk.capture_exception(exc)
    except Exception:
        pass
