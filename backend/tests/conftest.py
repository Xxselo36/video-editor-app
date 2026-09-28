"""Shared fixtures for the backend tests.

backend.jobs opens its SQLite DB at import, so the throwaway DB and work
dir are set up here, before anything imports backend.*. Every test
starts with auth and billing OFF and empty tables; fixtures switch
features on through env vars, exactly like a deployment would.

Run from the repo root:
    python -m pytest backend/tests -q
(needs fastapi, httpx, PyJWT[crypto] and the pipeline deps of
backend/requirements.txt; no network, no API keys.)
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
os.environ["CLEO_MIN_FREE_GB"] = "0"
REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import backend.main as M  # noqa: E402
from backend import accounts, auth, billing  # noqa: E402
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
    "CLEO_BILLING_ENFORCE", "CLEO_COMP_USERS", "CLEO_APP_URL",
    "LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_WEBHOOK_SECRET", "LEMONSQUEEZY_TEST_MODE",
    "LEMONSQUEEZY_VARIANT_STARTER", "LEMONSQUEEZY_VARIANT_PRO",
    "LEMONSQUEEZY_VARIANT_STUDIO", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
)


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    for k in _FEATURE_ENV:
        monkeypatch.delenv(k, raising=False)
    auth._jwks = None
    billing._price_cache.clear()
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


def sign(raw: bytes, secret: str = WEBHOOK_SECRET) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def fixture_payload(name: str, user_id: str | None = None) -> dict:
    payload = json.loads((FIXTURES / name).read_text())
    if user_id is not None:
        payload["meta"]["custom_data"]["user_id"] = user_id
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
