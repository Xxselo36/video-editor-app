"""backend/observability.py — Sentry setup and scrubbing. Doesn't import
backend.main; the real-SDK round trip runs in a subprocess (with a
capturing transport, no network) so the SDK's global patches never
touch the other tests."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import textwrap
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

from backend import observability as obs

REPO = Path(__file__).resolve().parents[2]
FAKE_DSN = "https://publickey@o0.ingest.sentry.invalid/1"

# Every value below must be gone after scrubbing.
SECRETS = [
    "MEDIATOKEN123", "R2SIG456", "R2CRED789", "AUTHJWTPART",
    "COOKIEVAL42", "ADMINTOK42", "APIKEY42", "LSSIGNATURE42", "CSRFTOK42",
    "hunter2", "BODYSECRET", "PGPASSWORD42", "gsk_abcdefghijklmnopqrstuvwxyz",
    "203.0.113.7", "alice@example.com", "bob@example.org", "carol@example.net",
    "dave@example.com", "erin@example.com", "frank@example.com",
    "grace@example.com", "SPOKEN TRANSCRIPT", "LOCALTOKEN42",
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl",
    "DLTOKEN42", "QSTOKEN42", "+52.5163+013.3777", "in.mp4",
]
# str() of a real CalledProcessError: the whole argv, transcript included.
FFMPEG_ERROR = str(subprocess.CalledProcessError(1, [
    "/usr/bin/ffmpeg", "-y", "-i", "/data/cleo_jobs/j1/in.mp4", "-vf",
    "drawtext=text='SPOKEN TRANSCRIPT':fontsize=48", "out.mp4"]))
# A pipeline RuntimeError with ffmpeg's stderr tail (what -hide_banner
# still prints about the input: an iPhone clip's GPS position).
FFMPEG_TAIL = ("ffmpeg orientation-normalize failed (hdr=False):\n"
               "    com.apple.quicktime.location.ISO6709: "
               "+52.5163+013.3777+034.030/\n"
               "    location        : +52.5163+013.3777/\n"
               "  Duration: 00:00:03.20, start: 0.000000, bitrate: 111 kb/s\n"
               "[AVFilterGraph @ 0x5571826059c0] No such filter: 'x'")


@pytest.fixture(autouse=True)
def _sentry_env(monkeypatch):
    for name in ("SENTRY_DSN", "SENTRY_TRACES_SAMPLE_RATE",
                 "SENTRY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME",
                 "RAILWAY_GIT_COMMIT_SHA"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(obs, "_enabled", False)


def _fastapi_event() -> dict:
    """Shaped like what sentry_sdk's FastAPI integration hands before_send
    (after serialization), with secrets planted everywhere."""
    return {
        "event_id": "0123456789abcdef0123456789abcdef",
        "level": "error",
        "platform": "python",
        "logger": "backend.pipeline",
        "transaction": "/jobs/{job_id}/watch",
        "transaction_info": {"source": "route"},
        "server_name": "railway-abc",
        "environment": "production",
        "release": "0b28b96",
        "message": "watch failed for alice@example.com",
        "logentry": {
            "message": "upload %s failed for %s",
            "params": [
                "https://acct.r2.cloudflarestorage.com/cleo/uploads/k.mp4"
                "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=R2CRED789"
                "&X-Amz-Signature=R2SIG456",
                "bob@example.org",
            ],
            "formatted": "upload https://acct.r2.cloudflarestorage.com/cleo/"
                         "uploads/k.mp4?X-Amz-Signature=R2SIG456 failed for "
                         "bob@example.org",
        },
        "exception": {"values": [{
            "type": "RuntimeError",
            "value": "GET /jobs/j1/watch?t=MEDIATOKEN123&format=primary "
                     "failed for carol@example.net "
                     "(postgresql://cleo:PGPASSWORD42@db.internal:5432/cleo)",
            "module": None,
            "mechanism": {"type": "fastapi", "handled": False},
            "stacktrace": {"frames": [{
                "filename": "backend/main.py",
                "abs_path": "/app/backend/main.py",
                "function": "watch_job",
                "module": "backend.main",
                "lineno": 2580,
                "pre_context": ["def watch_job(job_id: str):"],
                "context_line": "    raise RuntimeError(msg)",
                "post_context": [],
                "in_app": True,
                "vars": {
                    "job_id": "'j1'",
                    "media_token": "'LOCALTOKEN42'",
                    "user_email": "'dave@example.com'",
                    "headers": {"Authorization": "Bearer AUTHJWTPART"},
                    "groq": "gsk_abcdefghijklmnopqrstuvwxyz",
                },
            }]},
        }, {
            "type": "CalledProcessError", "module": "subprocess",
            "value": FFMPEG_ERROR,
            "mechanism": {"type": "chained", "handled": True},
        }, {
            "type": "RuntimeError", "value": FFMPEG_TAIL,
            "mechanism": {"type": "chained", "handled": True},
        }]},
        "request": {
            "url": "https://api.cleo.video/jobs/j1/watch?t=MEDIATOKEN123",
            "method": "GET",
            "query_string": "t=MEDIATOKEN123&format=primary",
            "headers": {
                "host": "api.cleo.video",
                "user-agent": "Mozilla/5.0 (Macintosh)",
                "accept": "video/mp4",
                "range": "bytes=0-",
                "origin": "https://cleo.video",
                "referer": "https://cleo.video/app?job=j1&t=MEDIATOKEN123",
                "authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2V"
                                 "yXzEifQ.c2lnbmF0dXJl",
                "cookie": "__session=COOKIEVAL42; __client_uat=1",
                "x-admin-token": "ADMINTOK42",
                "X-Api-Key": "APIKEY42",
                "x-signature": "LSSIGNATURE42",
                "x-csrf-token": "CSRFTOK42",
                "x-forwarded-for": "203.0.113.7",
                "x-real-ip": "203.0.113.7",
            },
            "cookies": {"__session": "COOKIEVAL42"},
            "data": {"email": "erin@example.com", "password": "hunter2",
                     "note": "BODYSECRET"},
            "env": {"REMOTE_ADDR": "203.0.113.7", "SERVER_NAME": "api"},
        },
        "user": {"id": "user_2abc", "email": "frank@example.com",
                 "ip_address": "203.0.113.7"},
        "tags": {"job_id": "j1", "phase": "render"},
        "extra": {"presigned": "https://acct.r2.cloudflarestorage.com/x?"
                               "X-Amz-Signature=R2SIG456",
                  "admin_secret": "ADMINTOK42",
                  "link": "/jobs/j1/download?dl&t=DLTOKEN42"},
        "contexts": {
            "trace": {"trace_id": "a" * 32, "span_id": "b" * 16,
                      "op": "http.server",
                      # bare query strings, no "?" for scrub_text to see
                      "data": {"http.query": "t=QSTOKEN42",
                               "url.query": "X-Amz-Signature=R2SIG456",
                               "http.response.status_code": 500}},
            "response": {"status_code": 500},
        },
        # The serializer's annotations (added before before_send).
        "_meta": {"request": {
            "data": {"": {"rem": [["!config", "x"]]}},
            "headers": {"authorization": {"": {"rem": [["!config", "s"]]}}},
        }},
        "breadcrumbs": {"values": [
            {"type": "http", "category": "httplib", "level": "info",
             "timestamp": "2026-09-28T10:00:00Z",
             "data": {"url": "https://acct.r2.cloudflarestorage.com/cleo/k"
                             "?X-Amz-Signature=R2SIG456",
                      "http.method": "PUT", "status_code": 200,
                      "http.query": "X-Amz-Signature=R2SIG456",
                      "http.fragment": ""}},
            {"type": "log", "category": "backend.jobs", "level": "info",
             "timestamp": "2026-09-28T10:00:01Z",
             "message": "receipt sent to grace@example.com", "data": {}},
            {"type": "subprocess", "category": "subprocess",
             "timestamp": "2026-09-28T10:00:02Z",
             "message": "/usr/bin/ffmpeg -y -i /data/cleo_jobs/j1/in.mp4 "
                        "-vf drawtext=text='SPOKEN TRANSCRIPT' out.mp4",
             "data": {}},
        ]},
    }


def _no_secrets_left(value) -> None:
    dump = json.dumps(value, default=str)
    left = [s for s in SECRETS if s in dump]
    assert not left, f"not scrubbed: {left}"
    assert "@example." not in dump


# ── scrubbers ────────────────────────────────────────────────────────

def test_scrub_event_removes_every_sensitive_field():
    event = obs.scrub_event(_fastapi_event(), {})
    assert event is not None
    _no_secrets_left(event)

    req = event["request"]
    assert "data" not in req and "cookies" not in req
    assert "query_string" not in req
    assert req["url"] == "https://api.cleo.video/jobs/j1/watch"
    assert set(req["headers"]) == {"host", "user-agent", "accept", "range",
                                   "origin", "referer"}
    assert req["headers"]["referer"] == "https://cleo.video/app"
    assert req["headers"]["user-agent"] == "Mozilla/5.0 (Macintosh)"
    assert req["env"] == {"SERVER_NAME": "api"}
    assert event["user"] == {"id": "user_2abc"}

    # Still useful for debugging.
    exc = event["exception"]["values"][0]
    assert exc["type"] == "RuntimeError"
    assert exc["value"].startswith("GET /jobs/j1/watch failed for [email]")
    assert "postgresql://[Filtered]@db.internal:5432/cleo" in exc["value"]
    frame = exc["stacktrace"]["frames"][0]
    assert frame["function"] == "watch_job"
    assert frame["context_line"] == "    raise RuntimeError(msg)"
    assert frame["vars"]["media_token"] == obs.FILTERED
    assert frame["vars"]["headers"]["Authorization"] == obs.FILTERED
    assert frame["vars"]["job_id"] == "'j1'"
    assert event["message"] == "watch failed for [email]"
    assert event["logentry"]["params"] == [
        "https://acct.r2.cloudflarestorage.com/cleo/uploads/k.mp4", "[email]"]
    assert event["tags"] == {"job_id": "j1", "phase": "render"}
    assert event["transaction"] == "/jobs/{job_id}/watch"
    assert event["extra"]["admin_secret"] == obs.FILTERED
    assert event["extra"]["link"] == "/jobs/j1/download"
    assert event["contexts"]["trace"]["data"] == {
        "http.query": obs.FILTERED, "url.query": obs.FILTERED,
        "http.response.status_code": 500}
    cpe, tail = event["exception"]["values"][1:]
    assert cpe["value"] == "Command 'ffmpeg' returned non-zero exit status 1."
    assert "location        : [location]" in tail["value"]
    assert "ISO6709: [location]" in tail["value"]
    assert tail["value"].endswith("No such filter: 'x'")
    assert "Duration: 00:00:03.20, start: 0.000000" in tail["value"]
    # Annotations stay objects (not "[Filtered]" strings).
    assert event["_meta"]["request"]["headers"]["authorization"] == \
        {"": {"rem": [["!config", "s"]]}}

    crumbs = event["breadcrumbs"]["values"]
    assert crumbs[0]["data"] == {
        "url": "https://acct.r2.cloudflarestorage.com/cleo/k",
        "http.method": "PUT", "status_code": 200}
    assert crumbs[1]["message"] == "receipt sent to [email]"
    assert crumbs[2]["message"] == "ffmpeg"


def test_scrub_event_list_headers_and_no_user_id():
    event = {"request": {"headers": [["Authorization", "Bearer AUTHJWTPART"],
                                     ["X-Api-Key", "APIKEY42"],
                                     ["Accept", "*/*"]]},
             "user": {"email": "frank@example.com"}}
    out = obs.scrub_event(event)
    assert out == {"request": {"headers": [["Accept", "*/*"]]}}


def test_scrub_transaction_spans():
    tx = {
        "type": "transaction",
        "transaction": "/jobs/{job_id}/render",
        "request": {"url": "https://api.cleo.video/jobs/j1/render?t=MEDIATOKEN123",
                    "query_string": "t=MEDIATOKEN123"},
        "spans": [
            {"op": "subprocess",
             "description": "ffmpeg -vf drawtext=text='SPOKEN TRANSCRIPT' o.mp4",
             "data": {"subprocess.cwd": "/data"}},
            {"op": "http.client",
             "description": "PUT https://acct.r2.cloudflarestorage.com/k?"
                            "X-Amz-Signature=R2SIG456",
             "data": {"url": "https://acct.r2.cloudflarestorage.com/k",
                      "http.query": "X-Amz-Signature=R2SIG456"}},
        ],
    }
    out = obs.scrub_event(tx)
    _no_secrets_left(out)
    assert out["spans"][0]["description"] == "ffmpeg"
    assert out["spans"][1]["description"] == \
        "PUT https://acct.r2.cloudflarestorage.com/k"
    assert out["request"] == {"url": "https://api.cleo.video/jobs/j1/render"}


def test_scrub_breadcrumb():
    ts = datetime.now(timezone.utc)
    crumb = {"type": "http", "category": "httplib", "timestamp": ts,
             "data": {"url": "https://api.groq.com/v1/x?key=APIKEY42",
                      "http.query": "key=APIKEY42", "body": "BODYSECRET",
                      "response_body": "BODYSECRET"}}
    out = obs.scrub_breadcrumb(crumb, {})
    assert out["data"] == {"url": "https://api.groq.com/v1/x"}
    assert out["timestamp"] is ts
    log = obs.scrub_breadcrumb({"type": "log", "message":
                                "GET /jobs/j1/watch?t=MEDIATOKEN123 for "
                                "alice@example.com, Bearer AUTHJWTPART"})
    assert log["message"] == \
        "GET /jobs/j1/watch for [email], Bearer [Filtered]"
    sub = obs.scrub_breadcrumb({"type": "subprocess", "category": "subprocess",
                                "message": "['/opt/ffprobe', '-v', 'quiet']"})
    assert sub["message"] == "ffprobe"


def test_scrub_text_subprocess_errors():
    """CalledProcessError / TimeoutExpired messages keep the program only
    (drawtext carries the transcript, filter graphs run to 100 KB)."""
    cmd = ["/usr/bin/ffmpeg", "-vf", "drawtext=text='SPOKEN TRANSCRIPT'", "o"]
    assert obs.scrub_text(str(subprocess.CalledProcessError(1, cmd))) == \
        "Command 'ffmpeg' returned non-zero exit status 1."
    assert obs.scrub_text(str(subprocess.CalledProcessError(
        -9, "ffmpeg -vf drawtext=text='SPOKEN' o.mp4"))) == \
        "Command 'ffmpeg' died with <Signals.SIGKILL: 9>."
    assert obs.scrub_text(
        "render failed: " + str(subprocess.TimeoutExpired(cmd, 1800))) == \
        "render failed: Command 'ffmpeg' timed out after 1800 seconds"


def test_scrubbers_fail_closed(monkeypatch):
    def broken(value, depth=0):
        raise RuntimeError("scrubber bug")
    monkeypatch.setattr(obs, "_scrub", broken)
    assert obs.scrub_event(_fastapi_event()) is None
    assert obs.scrub_breadcrumb({"message": "x"}) is None


def test_scrub_text_keeps_ordinary_text():
    for text in ("Analysis of job j1 took 12.5s (status=done); see "
                 "/jobs/j1/status", "basic plan, missing Bearer token",
                 "https://api.cleo.video/jobs/j1/watch",
                 "Duration: 00:00:03.20, start: 0.000000, bitrate: 111 kb/s",
                 "at 2026-09-28T10:00:00+00:00, gain +5.0 dB -3.2 dB, 16/9",
                 "Is it ready? status=done"):
        assert obs.scrub_text(text) == text
    assert obs.scrub_text("") == ""
    assert obs.scrub_text("sk-ant-api03-abcdefghijklmnop key") == \
        "[Filtered] key"


# ── init_sentry / capture without Sentry ─────────────────────────────

def test_init_is_noop_without_dsn(monkeypatch, caplog):
    # Blocked import: init_sentry must not even try without a DSN.
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    with caplog.at_level(logging.WARNING, logger="backend.observability"):
        assert obs.init_sentry() is False
    assert caplog.records == []
    assert obs.enabled() is False
    monkeypatch.setenv("SENTRY_DSN", "   ")
    assert obs.init_sentry() is False


def test_init_without_package_warns_once(monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    with caplog.at_level(logging.WARNING, logger="backend.observability"):
        assert obs.init_sentry() is False
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "sentry-sdk is not installed" in warnings[0].getMessage()
    assert "publickey" not in caplog.text  # never log the DSN
    assert obs.enabled() is False


def test_capture_is_noop_when_off(monkeypatch):
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    assert obs.capture(ValueError("x"), job_id="j1") is None


def test_init_options(monkeypatch, capsys):
    sentry_sdk = pytest.importorskip("sentry_sdk")
    seen: dict = {}
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: seen.update(kw))
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "0b28b96deadbeef")
    assert obs.init_sentry() is True
    assert obs.enabled() is True
    assert obs.init_sentry() is True  # idempotent
    assert seen["dsn"] == FAKE_DSN
    assert seen["send_default_pii"] is False
    assert seen["max_request_body_size"] == "never"
    assert seen["include_local_variables"] is False
    assert seen["traces_sample_rate"] == 0.25
    assert seen["environment"] == "staging"
    assert seen["release"] == "0b28b96deadbeef"
    assert seen["trace_propagation_targets"] == []
    assert seen["before_send"] is obs.scrub_event
    assert seen["before_send_transaction"] is obs.scrub_event
    assert seen["before_breadcrumb"] is obs.scrub_breadcrumb
    names = sorted(type(i).__name__ for i in seen["integrations"])
    assert names == ["FastApiIntegration", "LoggingIntegration",
                     "StarletteIntegration"]
    assert "publickey" not in capsys.readouterr().out


@pytest.mark.parametrize("raw, expected", [
    ("", None), ("0", None), ("nope", None), ("-1", None), ("nan", None),
    ("0.1", 0.1), ("1", 1.0), ("5", 1.0),
])
def test_traces_sample_rate(monkeypatch, raw, expected):
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", raw)
    assert obs._traces_sample_rate() == expected


def test_sentry_environment_wins(monkeypatch):
    sentry_sdk = pytest.importorskip("sentry_sdk")
    seen: dict = {}
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: seen.update(kw))
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "prod-eu")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    assert obs.init_sentry() is True
    assert seen["environment"] == "prod-eu"
    assert seen["release"] is None and seen["traces_sample_rate"] is None


def test_integration_did_not_enable_does_not_raise(monkeypatch, caplog):
    """sentry_sdk.integrations.fastapi/starlette raise DidNotEnable (not
    an ImportError) at import when what they patch is missing or moved,
    e.g. after a Starlette upgrade. That must not stop the backend."""
    pytest.importorskip("sentry_sdk")
    from sentry_sdk.integrations import DidNotEnable

    broken = types.ModuleType("sentry_sdk.integrations.fastapi")

    def module_getattr(name):
        raise DidNotEnable("Starlette is not installed")
    broken.__getattr__ = module_getattr
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.fastapi",
                        broken)
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    with caplog.at_level(logging.WARNING, logger="backend.observability"):
        assert obs.init_sentry() is False
    assert "integrations unavailable (DidNotEnable)" in caplog.text
    assert "publickey" not in caplog.text
    assert obs.enabled() is False


def test_bad_dsn_does_not_raise(monkeypatch, caplog):
    sentry_sdk = pytest.importorskip("sentry_sdk")
    from sentry_sdk.utils import BadDsn

    def init(**kw):  # what the real init raises (without its side effects)
        raise BadDsn(f"Unsupported scheme in {kw['dsn']}")
    monkeypatch.setattr(sentry_sdk, "init", init)
    monkeypatch.setenv("SENTRY_DSN", "not a dsn with SECRETPART")
    with caplog.at_level(logging.WARNING, logger="backend.observability"):
        assert obs.init_sentry() is False
    assert "Sentry init failed" in caplog.text
    assert "SECRETPART" not in caplog.text


# ── import rule ──────────────────────────────────────────────────────

def _run(code: str, tmp_path, **env) -> subprocess.CompletedProcess:
    full_env = {**os.environ, "CLEO_JOB_DB": str(tmp_path / "jobs.db"),
                "CLEO_WORK_ROOT": str(tmp_path / "work"), **env}
    for name in ("SENTRY_DSN", "SENTRY_TRACES_SAMPLE_RATE", "DATABASE_URL"):
        if name not in env:
            full_env.pop(name, None)
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)],
                          cwd=REPO, env=full_env, capture_output=True,
                          text=True, timeout=120)


def test_shared_modules_import_without_sentry(tmp_path):
    """backend.jobs/costs/llm/whisper_groq/pipeline are shared with the
    desktop app and the Modal image: they import with sentry_sdk blocked
    and never pull in backend.observability."""
    r = _run("""
        import sys
        sys.modules["sentry_sdk"] = None
        import backend.jobs, backend.costs, backend.llm
        import backend.whisper_groq, backend.pipeline
        assert "backend.observability" not in sys.modules, "imported"
        import backend.observability as obs
        assert obs.init_sentry() is False
        print("OK")
    """, tmp_path)
    assert r.returncode == 0, r.stderr[-3000:]
    assert r.stdout.strip().endswith("OK")


# ── the real SDK, end to end (subprocess, no network) ────────────────

_ROUND_TRIP = r"""
import http.client, json, logging, socket, subprocess, sys

import sentry_sdk
from sentry_sdk.transport import Transport

class FakeR2(http.client.HTTPConnection):
    # A canned 200 over a socketpair: the SDK's http.client patch sees a
    # real request/response (presigned query and all), no server, no port.
    def connect(self):
        self.sock, self._peer = socket.socketpair()
        self._peer.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

captured = []

class Capture(Transport):
    def capture_envelope(self, envelope):
        for item in envelope.items:
            if item.type in ("event", "transaction"):
                captured.append(item.payload.json)

from backend import observability as obs
assert obs.init_sentry(transport=Capture()) is True

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

log = logging.getLogger("backend.roundtrip")
log.setLevel(logging.INFO)
app = FastAPI()

@app.post("/jobs/{job_id}/render")
async def render(job_id: str, request: Request):
    await request.json()
    log.info("render %s for ivan@example.com", job_id)
    log.warning("slow presign https://acct.r2.cloudflarestorage.com/b/k"
                "?X-Amz-Signature=R2SIG456")
    subprocess.run([sys.executable, "-c", "pass",
                    "drawtext=text='SPOKEN TRANSCRIPT'"], check=True)
    conn = FakeR2("acct.r2.cloudflarestorage.com")
    conn.request("PUT", "/cleo/k.mp4?X-Amz-Credential=R2CRED789"
                        "&X-Amz-Signature=R2SIG456", body=b"x")
    conn.getresponse().read()
    conn.close()
    conn._peer.close()
    try:  # what a worker thread's except block would hand to capture()
        subprocess.run([sys.executable, "-c", "raise SystemExit(3)",
                        "drawtext=text='SPOKEN TRANSCRIPT'"], check=True)
    except subprocess.CalledProcessError as e:
        obs.capture(e, job_id=job_id, phase="render")
    raise RuntimeError("render failed for judy@example.com at "
                       "/jobs/j1/watch?t=MEDIATOKEN123")

@app.get("/modal")
def modal():
    log.error("[modal] RENDER TIMEOUT for kate@example.com")
    log.error("ffmpeg failed:\n    location        : +52.5163+013.3777/")
    return {"ok": True}

client = TestClient(app, raise_server_exceptions=False)
r = client.post(
    "/jobs/j1/render?t=MEDIATOKEN123&format=primary",
    json={"email": "leo@example.com", "password": "hunter2",
          "note": "BODYSECRET"},
    headers={"Authorization": "Bearer AUTHJWTPART",
             "Cookie": "__session=COOKIEVAL42",
             "X-Admin-Token": "ADMINTOK42", "X-Api-Key": "APIKEY42",
             "X-Signature": "LSSIGNATURE42", "X-Forwarded-For": "203.0.113.7",
             "User-Agent": "roundtrip-agent"})
assert r.status_code == 500, r.status_code
assert client.get("/modal").status_code == 200
obs.capture(ValueError("handled for mallory@example.com"),
            job_id="j9", phase="analyze", skipped=None)
sentry_sdk.flush()
print("CAPTURED" + json.dumps(captured))
"""


@pytest.mark.parametrize("traces", ["1.0", ""], ids=["tracing", "default"])
def test_real_sdk_round_trip(tmp_path, traces):
    """With tracing on, and with the production default (off)."""
    pytest.importorskip("sentry_sdk")
    r = _run(_ROUND_TRIP, tmp_path, SENTRY_DSN=FAKE_DSN,
             SENTRY_TRACES_SAMPLE_RATE=traces,
             SENTRY_ENVIRONMENT="test", RAILWAY_GIT_COMMIT_SHA="abc1234")
    assert r.returncode == 0, r.stderr[-3000:]
    assert "publickey" not in r.stdout + r.stderr
    line = next(ln for ln in r.stdout.splitlines()
                if ln.startswith("CAPTURED"))
    captured = json.loads(line[len("CAPTURED"):])
    extra_secrets = ["ivan@", "judy@", "kate@", "leo@", "mallory@"]
    dump = json.dumps(captured)
    _no_secrets_left(captured)
    assert not [s for s in extra_secrets if s in dump]

    errors = [e for e in captured if e.get("type") != "transaction"]
    txs = [e for e in captured if e.get("type") == "transaction"]
    if traces:
        assert txs, "traces_sample_rate=1.0 should produce transactions"
    else:
        assert not txs, "tracing is off by default"
    for e in captured:
        assert e["environment"] == "test" and e["release"] == "abc1234"

    # 1. The unhandled route exception, with its request.
    boom = next(e for e in errors if e.get("exception", {}).get("values", [{}])
                [-1].get("type") == "RuntimeError")
    assert boom["exception"]["values"][-1]["value"] == \
        "render failed for [email] at /jobs/j1/watch"
    assert boom["transaction"] == "/jobs/{job_id}/render"
    req = boom["request"]
    assert req["url"] == "http://testserver/jobs/j1/render"
    assert not {"data", "cookies", "query_string"} & set(req)
    headers = {k.lower() for k in req["headers"]}
    assert "user-agent" in headers
    assert not headers & {"authorization", "cookie", "x-admin-token",
                          "x-api-key", "x-signature", "x-forwarded-for"}
    frames = boom["exception"]["values"][-1]["stacktrace"]["frames"]
    assert all("vars" not in f for f in frames)
    crumbs = boom["breadcrumbs"]["values"]
    messages = [c.get("message") for c in crumbs]
    assert "render j1 for [email]" in messages
    assert ("slow presign https://acct.r2.cloudflarestorage.com/b/k"
            in messages)
    assert "SPOKEN" not in json.dumps(crumbs)
    assert any(c.get("category") == "subprocess" and
               c["message"].startswith("python") for c in crumbs)
    r2 = [c for c in crumbs if c.get("category") == "httplib"]
    assert r2 and r2[0]["data"]["url"] == \
        "http://acct.r2.cloudflarestorage.com/cleo/k.mp4"
    assert not {"http.query", "http.fragment"} & set(r2[0]["data"])

    # 2. log.error → event.
    logged = [e for e in errors if e.get("logger") == "backend.roundtrip"]
    assert [e["level"] for e in logged] == ["error", "error"]
    text = json.dumps([e.get("logentry") or e.get("message") for e in logged])
    assert "RENDER TIMEOUT for [email]" in text
    assert "location        : [location]" in text

    # 3. A handled CalledProcessError: the program, not its argv.
    cpe = next(e for e in errors if e.get("exception", {}).get(
        "values", [{}])[-1].get("type") == "CalledProcessError")
    value = cpe["exception"]["values"][-1]["value"]
    assert value.startswith("Command 'python"), value
    assert value.endswith("' returned non-zero exit status 3."), value
    assert cpe["tags"]["phase"] == "render"

    # 4. capture() with tags.
    handled = next(e for e in errors if e.get("exception", {}).get(
        "values", [{}])[-1].get("type") == "ValueError")
    assert handled["tags"]["job_id"] == "j9"
    assert handled["tags"]["phase"] == "analyze"
    assert "skipped" not in handled["tags"]
    assert handled["exception"]["values"][-1]["value"] == "handled for [email]"

    # Transactions are scrubbed too.
    for tx in txs:
        assert "query_string" not in tx.get("request", {})
        for span in tx.get("spans", []):
            if span.get("op") == "subprocess":
                assert span["description"].startswith("python")
