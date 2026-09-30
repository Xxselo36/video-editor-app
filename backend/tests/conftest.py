"""Shared fixtures for the backend tests.

backend.jobs opens its SQLite DB at import, so the throwaway DB and work
dir are set up here, before anything imports backend.*. Every test
starts with auth and billing OFF and empty tables; fixtures switch
features on through env vars, exactly like a deployment would.

Run from the repo root:
    python -m pytest backend/tests -q
(needs fastapi, httpx, PyJWT[crypto] and the pipeline deps of
backend/requirements.txt; no network, no API keys.)

Database: SQLite by default. CLEO_TEST_DB=postgres runs the whole suite
on Postgres instead — an embedded server (pip install pgserver, plus
psycopg[binary] and psycopg_pool) started once for the session, with
DATABASE_URL pointed at a fresh database whose tables are emptied
before every test. Tests marked sqlite_only (SQLite internals: WAL
pragmas, raw rows, the /tmp fallback) are skipped there. The Postgres
tests (test_pg_*.py) run in both modes, each on databases of their own
(fixture pg_server; skipped without pgserver).

Media: the local media backend by default (backend/media.py; files
under the test work root). CLEO_TEST_MEDIA=r2 runs the whole suite with
media in R2 (R2_* set and CLEO_MEDIA_BACKEND=r2), faked in-process by moto (pip install "moto[s3]>=5.2",
backend/requirements-dev.txt): R2_* env vars point at a moto bucket for
every test. Tests of local-disk internals are marked local_media_only
and skipped there. The fixture `r2` gives a single test R2 on moto in
either mode (an emptied bucket).
"""
from __future__ import annotations

import atexit
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="cleo-tests-"))
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)
os.environ["CLEO_JOB_DB"] = str(_TMP / "jobs.db")
os.environ["CLEO_WORK_ROOT"] = str(_TMP / "work")
os.environ["CLEO_TMP_ROOT"] = str(_TMP / "tmp")
os.environ["CLEO_MIN_FREE_GB"] = "0"
_OPT_IN_ENV = ("CLEO_MEDIA_BACKEND", "CLEO_UPLOAD_MODE", "CLEO_MODAL_RENDER_FN",
               "CLEO_PROXY_VIDEO", "CLEO_MEDIA_ORPHAN_SWEEP",
               "CLEO_MEDIA_ORPHAN_MAX", "CLEO_MEDIA_PRESIGN",
               "R2_BACKUP_BUCKET", "CLEO_MODAL_R2")
for _k in (*_OPT_IN_ENV, "CLEO_MEDIA_ROOT", "CLEO_BACKFILL",
           "R2_ENDPOINT_URL"):
    os.environ.pop(_k, None)
REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

TEST_DB = os.environ.get("CLEO_TEST_DB", "sqlite").strip().lower() or "sqlite"
if TEST_DB not in ("sqlite", "postgres"):
    raise RuntimeError(f"CLEO_TEST_DB={TEST_DB!r}: use sqlite or postgres")
os.environ.pop("CLEO_DB_BACKEND", None)
os.environ.pop("DATABASE_URL", None)


class _PgServer:
    """One embedded Postgres (pgserver) for the session; fresh() makes a
    new empty database on it and returns its URL."""

    def __init__(self) -> None:
        import pgserver
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self._relocate_binaries()
        # cleanup_mode=None + our own stop: pgserver's `pg_ctl stop` runs
        # as its unprivileged user and fails when the tests run as root,
        # leaving the server running.
        self.server = pgserver.get_server(str(_TMP / "pg"),
                                          cleanup_mode=None)
        atexit.register(self.stop)
        self._n = 0

    @staticmethod
    def _relocate_binaries() -> None:
        """As root, pgserver runs postgres as an unprivileged user, which
        must be able to reach the binaries; inside a private parent
        directory (e.g. a venv under a 0700 temp dir) it can't. Use a
        copy under the system temp dir instead (made once, reused)."""
        import pgserver._commands as cmds
        import pgserver.postgres_server as srv
        # site-packages/pgserver/pginstall/bin; the binaries find their
        # libraries in site-packages/pgserver.libs ($ORIGIN/../../..).
        src = Path(cmds.POSTGRES_BIN_PATH).parents[2]
        tag = hashlib.sha1(str(src).encode()).hexdigest()[:10]
        dst = Path(tempfile.gettempdir()) / f"cleo-pgserver-{tag}"
        rel = ("pgserver/pginstall", "pgserver.libs")
        if not (dst / "pgserver/pginstall/bin/pg_ctl").exists():
            tmp = Path(tempfile.mkdtemp(prefix="cleo-pgserver-",
                                        dir=tempfile.gettempdir()))
            os.chmod(tmp, 0o755)
            for part in rel:
                if (src / part).exists():
                    shutil.copytree(src / part, tmp / part)
            try:
                os.rename(tmp, dst)
            except OSError:  # another session made it meanwhile
                shutil.rmtree(tmp, ignore_errors=True)
        for mod in (cmds, srv):
            mod.POSTGRES_BIN_PATH = dst / "pgserver/pginstall/bin"

    def stop(self) -> None:
        """Fast shutdown of the postmaster (SIGINT), waiting up to 10 s."""
        import signal
        pid = self.server.get_pid()
        if not pid:
            return
        try:
            os.kill(pid, signal.SIGINT)
        except OSError:
            return
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except OSError:
                return
            time.sleep(0.1)

    def fresh(self, name: str | None = None) -> str:
        import psycopg
        self._n += 1
        name = name or f"t{os.getpid()}_{self._n}"
        with psycopg.connect(self.server.get_uri(), autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS "{name}"')
            c.execute(f'CREATE DATABASE "{name}"')
        return self.server.get_uri(name)


_PG: _PgServer | None = None


def pg_server_or_skip() -> _PgServer:
    global _PG
    if _PG is None:
        import warnings
        with warnings.catch_warnings():
            # platformdirs (via pgserver), in containers without a login
            # session.
            warnings.filterwarnings("ignore", "XDG_RUNTIME_DIR is not set")
            try:
                import pgserver  # noqa: F401
                import psycopg  # noqa: F401
                import psycopg_pool  # noqa: F401
            except ImportError as e:
                pytest.skip(f"Postgres tests need pgserver + psycopg: {e}")
            _PG = _PgServer()
    return _PG


if TEST_DB == "postgres":
    os.environ["DATABASE_URL"] = pg_server_or_skip().fresh("cleo_suite")

TEST_MEDIA = os.environ.get("CLEO_TEST_MEDIA", "local").strip().lower() or "local"
if TEST_MEDIA not in ("local", "r2"):
    raise RuntimeError(f"CLEO_TEST_MEDIA={TEST_MEDIA!r}: use local or r2")
R2_BUCKET = "cleo-test-media"
R2_ENV = {"R2_ACCOUNT_ID": "acct0test", "R2_ACCESS_KEY_ID": "AKIATESTKEY",
          "R2_SECRET_ACCESS_KEY": "test-secret", "R2_BUCKET": R2_BUCKET}
R2_ENDPOINT = f"https://{R2_ENV['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
# moto answers S3 calls to the R2 endpoint too.
os.environ["MOTO_S3_CUSTOM_ENDPOINTS"] = R2_ENDPOINT
_SESSION_MOTO = None


def _moto_bucket(empty: bool = True):
    """The test bucket on the active moto mock (created once), emptied."""
    import boto3
    s3 = boto3.session.Session().client(
        "s3", endpoint_url=R2_ENDPOINT, region_name="us-east-1",
        aws_access_key_id=R2_ENV["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=R2_ENV["R2_SECRET_ACCESS_KEY"])
    try:
        s3.head_bucket(Bucket=R2_BUCKET)
    except Exception:
        s3.create_bucket(Bucket=R2_BUCKET)
    if empty:
        for page in s3.get_paginator("list_objects_v2").paginate(
                Bucket=R2_BUCKET):
            keys = [{"Key": o["Key"]} for o in page.get("Contents") or []]
            if keys:
                s3.delete_objects(Bucket=R2_BUCKET,
                                  Delete={"Objects": keys, "Quiet": True})
        for up in s3.list_multipart_uploads(
                Bucket=R2_BUCKET).get("Uploads") or []:
            s3.abort_multipart_upload(Bucket=R2_BUCKET, Key=up["Key"],
                                      UploadId=up["UploadId"])
    return s3


if TEST_MEDIA == "r2":
    from moto import mock_aws
    _SESSION_MOTO = mock_aws()
    _SESSION_MOTO.start()
    atexit.register(_SESSION_MOTO.stop)
    os.environ.update(R2_ENV)
    os.environ["CLEO_MEDIA_BACKEND"] = "r2"
    _moto_bucket()

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Never report test errors to Sentry: empty, not unset, so load_dotenv
# can't fill it in from a local .env.
os.environ["SENTRY_DSN"] = ""
import backend.main as M  # noqa: E402
from backend import accounts, auth, billing, db  # noqa: E402
from backend.jobs import store  # noqa: E402

# Real test-mode webhook captures (see fixtures/lemon_squeezy/NOTICE).
FIXTURES = Path(__file__).parent / "fixtures" / "lemon_squeezy"

ISSUER = "https://clerk.test.example"
AZP = "http://localhost:3000"
KID = "test-key-1"
STORE_ID = "179021"          # store_id in the LS fixtures
VARIANTS = {"starter": "111", "pro": "795658", "studio": "333"}
WEBHOOK_SECRET = "whsec_test"

_FEATURE_ENV = (
    "CLERK_ISSUER", "CLERK_JWT_KEY", "CLERK_AUTHORIZED_PARTIES",
    "CLERK_SECRET_KEY", "CLEO_ADMIN_TOKEN", "CLEO_MEDIA_SECRET",
    "CLEO_AUTH_TEST", "CLEO_ENV", "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_ENVIRONMENT",
    "CLEO_BILLING_ENFORCE", "CLEO_COMP_USERS", "CLEO_BILLING_TESTERS",
    "CLEO_APP_URL",
    "LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_WEBHOOK_SECRET", "LEMONSQUEEZY_TEST_MODE",
    "LEMONSQUEEZY_VARIANT_STARTER", "LEMONSQUEEZY_VARIANT_PRO",
    "LEMONSQUEEZY_VARIANT_STUDIO", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
)


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "sqlite_only: tests SQLite internals; skipped with "
        "CLEO_TEST_DB=postgres")
    config.addinivalue_line(
        "markers", "local_media_only: tests local-disk media internals; "
        "skipped with CLEO_TEST_MEDIA=r2")


def pytest_collection_modifyitems(config, items):
    skip_pg = pytest.mark.skip(reason="SQLite-specific (CLEO_TEST_DB=postgres)")
    skip_r2 = pytest.mark.skip(reason="local media only (CLEO_TEST_MEDIA=r2)")
    for item in items:
        if TEST_DB == "postgres" and "sqlite_only" in item.keywords:
            item.add_marker(skip_pg)
        if TEST_MEDIA == "r2" and "local_media_only" in item.keywords:
            item.add_marker(skip_r2)


@pytest.fixture(scope="session")
def pg_server():
    """The session's embedded Postgres (see _PgServer); skips the test
    without pgserver / psycopg."""
    return pg_server_or_skip()


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    for k in _FEATURE_ENV:
        monkeypatch.delenv(k, raising=False)
    for k in _OPT_IN_ENV:
        monkeypatch.delenv(k, raising=False)
    if TEST_MEDIA == "r2":
        for k, v in R2_ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    store._truncate_gc_for_tests()
    store._truncate_events_for_tests()
    shutil.rmtree(M._WORK_ROOT / "media", ignore_errors=True)
    shutil.rmtree(M._TMP_ROOT / "proxy-cache", ignore_errors=True)
    auth._jwks = None
    accounts._TEST_PLANS.clear()
    billing._price_cache.clear()
    billing._refresh_tried.clear()
    with M._INIT_RATE._lock:
        M._INIT_RATE._events.clear()
    if db.active() == "postgres":
        store._truncate_for_tests()
        shutil.rmtree(M._WORK_ROOT / "uploads", ignore_errors=True)
        accounts._db().truncate_for_tests()
    else:
        with store._lock:
            store._conn.execute("DELETE FROM jobs")
            store._conn.commit()
        shutil.rmtree(M._WORK_ROOT / "uploads", ignore_errors=True)
        conn = accounts._db()
        with accounts._lock:
            for table in ("meta", "users", "subscriptions", "usage",
                          "billing_events"):
                conn.execute(f"DELETE FROM {table}")
    # Never start real analysis threads from POST /jobs.
    started: list[str] = []
    monkeypatch.setattr(M, "_run_analyze", lambda job_id: started.append(job_id))
    yield started


@pytest.fixture
def client():
    # Not a context manager: no lifespan, so no background loops.
    return TestClient(M.app)


@pytest.fixture
def no_r2(monkeypatch):
    """A deployment without R2 (also under CLEO_TEST_MEDIA=r2)."""
    for k in R2_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)


@pytest.fixture
def r2(monkeypatch):
    """R2 for this test, faked in-process by moto (the session's mock
    with CLEO_TEST_MEDIA=r2, else one of its own): R2_* env set, new
    jobs' media in R2 (CLEO_MEDIA_BACKEND=r2), bucket emptied. Returns a
    boto3 client on it."""
    for k, v in R2_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    if _SESSION_MOTO is not None:
        yield _moto_bucket()
        return
    from moto import mock_aws
    with mock_aws():
        yield _moto_bucket()


# ── auth ─────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def jwks(rsa_key):
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rsa_key.public_key()))
    jwk.update({"kid": KID, "use": "sig", "alg": "RS256"})
    return {"keys": [jwk]}


@pytest.fixture
def jwks_calls(monkeypatch, jwks):
    """Stub the JWKS endpoint (no network); records fetched URLs."""
    calls: list[str] = []

    def fetch_data(self):
        calls.append(self.uri)
        return jwks
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fetch_data)
    return calls


@pytest.fixture
def auth_on(monkeypatch, jwks_calls):
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    return jwks_calls


@pytest.fixture
def make_token(rsa_key):
    def _make(sub="user_a", key=None, headers=None, **overrides):
        now = int(time.time())
        claims = {"iss": ISSUER, "sub": sub, "sid": "sess_1", "azp": AZP,
                  "iat": now, "nbf": now, "exp": now + 60}
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, key or rsa_key, algorithm="RS256",
                          headers={"kid": KID, **(headers or {})})
    return _make


@pytest.fixture
def bearer(make_token):
    def _h(sub="user_a", **kw):
        return {"Authorization": f"Bearer {make_token(sub, **kw)}"}
    return _h


# ── billing ──────────────────────────────────────────────────────────


class FakeLS:
    """Stands in for billing._ls_request: subscriptions / invoices /
    variants served from dicts; `down` makes every call fail."""

    def __init__(self):
        self.subs: dict[str, dict] = {}
        self.invoices: dict[str, list[dict]] = {}
        self.variants: dict[str, dict] = {}
        self.currency = "USD"
        self.calls: list[tuple[str, str, dict | None]] = []
        self.down = False
        self.checkout_url = "https://store.lemonsqueezy.com/checkout/custom/abc"

    def sub(self, sid, status="active", variant="795658", **attrs):
        a = {"store_id": int(STORE_ID), "variant_id": int(variant),
             "status": status, "test_mode": False, "customer_id": 42,
             "renews_at": "2099-01-01T00:00:00.000000Z", "ends_at": None,
             "created_at": "2026-09-01T10:00:00.000000Z",
             "updated_at": "2026-09-01T10:00:05.000000Z",
             "user_email": "a@example.com",
             "urls": {"customer_portal": f"https://portal.test/{sid}",
                      "update_payment_method": f"https://pay.test/{sid}"}}
        a.update(attrs)
        self.subs[str(sid)] = {"type": "subscriptions", "id": str(sid),
                               "attributes": a}
        return self.subs[str(sid)]

    def __call__(self, method, path, body=None, timeout=15.0):
        self.calls.append((method, path, body))
        if self.down:
            raise billing.LemonSqueezyError(503, "down")
        path = path.replace(billing.API_BASE, "")
        if path.startswith("/subscriptions/"):
            sid = path.split("/")[2]
            if sid not in self.subs:
                raise billing.LemonSqueezyError(404, "not found")
            return {"data": self.subs[sid]}
        if path.startswith("/subscriptions?"):
            return {"data": list(self.subs.values()), "links": {"next": None}}
        if path.startswith("/subscription-invoices?"):
            sid = path.split("subscription_id%5D=")[1].split("&")[0]
            return {"data": self.invoices.get(sid, [])}
        if path == "/checkouts":
            return {"data": {"attributes": {"url": self.checkout_url}}}
        if path.startswith("/variants/"):
            vid = path.split("/")[2]
            if vid not in self.variants:
                raise billing.LemonSqueezyError(404, "not found")
            return {"data": {"attributes": self.variants[vid]}}
        if path.startswith("/stores/"):
            return {"data": {"attributes": {"currency": self.currency}}}
        raise billing.LemonSqueezyError(404, f"unexpected {method} {path}")


@pytest.fixture
def ls(monkeypatch):
    fake = FakeLS()
    monkeypatch.setattr(billing, "_ls_request", fake)
    monkeypatch.setattr(billing, "clerk_email", lambda uid: None)
    return fake


@pytest.fixture
def billing_on(monkeypatch, auth_on, ls):
    monkeypatch.setenv("LEMONSQUEEZY_API_KEY", "test_key")
    monkeypatch.setenv("LEMONSQUEEZY_STORE_ID", STORE_ID)
    monkeypatch.setenv("LEMONSQUEEZY_WEBHOOK_SECRET", WEBHOOK_SECRET)
    for plan, vid in VARIANTS.items():
        monkeypatch.setenv(f"LEMONSQUEEZY_VARIANT_{plan.upper()}", vid)
    return ls


@pytest.fixture
def enforce(monkeypatch, billing_on):
    monkeypatch.setenv("CLEO_BILLING_ENFORCE", "1")
    return billing_on


def analysis_result(output_dir, duration: float = 1.0, segments=None,
                    **extra) -> dict:
    """What backend.pipeline.analyze_only returns, with small stand-in
    files in output_dir (the job's workspace): normalized.mp4, the
    editor proxy and the first preview — the worker stores them."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, body in (("normalized.mp4", b"mezz"), ("proxy.mp4", b"proxy"),
                       ("preview.mp4", b"prev")):
        (out / name).write_bytes(body)
    res = {"normalized_path": str(out / "normalized.mp4"),
           "preview_path": str(out / "preview.mp4"),
           "segments": segments or [(0.0, duration)], "subtitles": [],
           "duration": duration, "language": "en"}
    res.update(extra)
    return res


def sign(raw: bytes, secret: str = WEBHOOK_SECRET) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def fixture_payload(name: str, user_id: str | None = None,
                    signed: bool = True) -> dict:
    """A captured webhook, as if from one of our checkouts for user_id
    (custom data signed like billing.create_checkout does)."""
    payload = json.loads((FIXTURES / name).read_text())
    if user_id is not None:
        custom = payload["meta"]["custom_data"]
        custom["user_id"] = user_id
        if signed:
            custom["sig"] = billing.checkout_signature(user_id)
    return payload


def add_sub(sid="sub_1", user_id="user_a", plan="pro", status="active",
            **fields):
    """Insert a subscription row directly (entitlement / quota tests)."""
    row = {"id": sid, "user_id": user_id, "variant_id": VARIANTS[plan],
           "plan": plan, "status": status, "test_mode": 0,
           "customer_id": "42", "renews_at": time.time() + 20 * 86400,
           "ends_at": None, "portal_url": None, "update_payment_url": None,
           "raw_json": "{}", "created_at": time.time() - 10 * 86400,
           "ls_updated_at": time.time() - 10 * 86400}
    period_start = fields.pop("period_start", None)
    row.update(fields)
    accounts.upsert_subscription(row)
    if period_start:  # like a subscription_payment_success webhook
        accounts.set_period_start(sid, period_start)
    return row
