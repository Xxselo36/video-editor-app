"""Test auth (CLEO_AUTH_TEST, backend/auth.py): `X-Test-User` signs a
request in like a Clerk token would — and the API refuses to start with
it in production or next to a live Clerk secret, where the header is
ignored too."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.main as M
from backend import auth
from backend.jobs import store


@pytest.fixture
def test_auth(monkeypatch):
    monkeypatch.setenv("CLEO_AUTH_TEST", "1")


def _job(owner: str | None = None):
    job = store.create(None, {}, filename="x.mp4", owner_id=owner)
    store.update(job.id, status="awaiting_review")
    return job


# ── the header ───────────────────────────────────────────────────────


def test_off_by_default_the_header_is_ignored(client):
    r = client.get("/me", headers={"X-Test-User": "user_t"})
    assert r.json() == {"auth_enabled": False}
    assert not auth.auth_enabled()


def test_signs_in_as_the_named_user(client, test_auth):
    r = client.get("/me", headers={"X-Test-User": "user_t"})
    assert r.status_code == 200
    me = r.json()
    assert me["auth_enabled"] is True
    assert me["user"]["id"] == "user_t"
    # Media URLs work like for a Clerk user.
    assert auth.verify_media_token(me["media_token"]) == "user_t"


def test_accounts_are_on_without_the_header(client, test_auth):
    assert client.get("/me").status_code == 401
    assert client.get("/me").json()["detail"] == "auth_required"


@pytest.mark.parametrize("header", ["", "bad id", "a/b", "u1;plan=gold", "x" * 129])
def test_a_malformed_header_is_refused(client, test_auth, header):
    r = client.get("/me", headers={"X-Test-User": header} if header else {})
    assert r.status_code == 401


def test_jobs_belong_to_their_test_user(client, test_auth):
    mine, theirs = _job("user_a"), _job("user_b")
    a = {"X-Test-User": "user_a"}
    assert client.get(f"/jobs/{mine.id}", headers=a).status_code == 200
    assert client.get(f"/jobs/{theirs.id}", headers=a).status_code == 404
    ids = [j["id"] for j in client.get("/jobs", headers=a).json()]
    assert ids == [mine.id]


def test_an_unowned_beta_job_is_claimed(client, test_auth):
    job = _job(None)
    assert client.get(f"/jobs/{job.id}", headers={"X-Test-User": "user_a"}).status_code == 200
    assert store.get(job.id).owner_id == "user_a"
    assert client.get(f"/jobs/{job.id}", headers={"X-Test-User": "user_b"}).status_code == 404


def test_media_routes_take_the_header(client, test_auth):
    job = _job("user_a")
    # No preview yet: 409, not 401 — the header was accepted.
    r = client.get(f"/jobs/{job.id}/preview-video", headers={"X-Test-User": "user_a"})
    assert r.status_code == 409
    assert client.get(f"/jobs/{job.id}/preview-video").status_code == 401


def test_plan_in_the_header(client, test_auth, billing_on):
    h = {"X-Test-User": "user_p;plan=pro"}
    me = client.get("/me", headers=h).json()
    assert me["plan"] == "pro"
    assert me["minutes"]["limit"] > 0
    assert client.get("/me", headers={"X-Test-User": "user_p;plan=none"}).json()["plan"] is None
    # Without a plan the user's own entitlement counts again (none here).
    assert client.get("/me", headers={"X-Test-User": "user_p"}).json()["plan"] is None


# ── the guard ────────────────────────────────────────────────────────

REFUSED = [
    ("CLEO_ENV", "production"),
    ("RAILWAY_ENVIRONMENT_NAME", "production"),
    ("CLERK_SECRET_KEY", "sk_live_abc123"),
]


@pytest.mark.parametrize("key,value", REFUSED)
def test_refuses_to_start_in_production(monkeypatch, test_auth, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(auth.TestAuthRefused):
        auth.check_test_auth()
    # The app's startup (lifespan) fails before anything else runs.
    with pytest.raises(auth.TestAuthRefused):
        with TestClient(M.app):
            pass


@pytest.mark.parametrize("key,value", REFUSED)
def test_the_header_is_ignored_where_refused(client, monkeypatch, test_auth, key, value):
    monkeypatch.setenv(key, value)
    assert not auth.test_auth_enabled()
    assert client.get("/me", headers={"X-Test-User": "user_t"}).json() == {"auth_enabled": False}


def test_allowed_with_a_test_clerk_secret(monkeypatch, test_auth):
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_abc123")
    monkeypatch.setenv("CLEO_ENV", "staging")
    auth.check_test_auth()  # no exception
    assert auth.test_auth_enabled()


def test_without_test_auth_production_starts_as_before(monkeypatch):
    monkeypatch.setenv("CLEO_ENV", "production")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_live_abc123")
    auth.check_test_auth()  # no exception
    assert not auth.test_auth_enabled()


def test_clerk_tokens_still_work_next_to_test_auth(client, test_auth, auth_on, bearer):
    assert client.get("/me", headers=bearer("user_clerk")).json()["user"]["id"] == "user_clerk"
    assert client.get("/me", headers={"X-Test-User": "user_t"}).json()["user"]["id"] == "user_t"
