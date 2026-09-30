"""Clerk JWT verification, job ownership (+ beta-job claiming), the
service identity and media tokens."""
from __future__ import annotations

import logging
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

import backend.main as M
from backend import auth
from backend.jobs import store
from conftest import ISSUER


def _job(owner=None, **fields):
    job = store.create("/nonexistent/in.mp4", {"caption_preset": "clean"},
                       owner_id=owner)
    if fields:
        store.update(job.id, **fields)
    return store.get(job.id)


def _upload(client, headers, **form):
    data = {"settings": "{}", **form}
    return client.post("/jobs", headers=headers, data=data,
                       files={"file": ("clip.mp4", b"not really a video",
                                       "video/mp4")})


# ── JWT ──────────────────────────────────────────────────────────────


def test_valid_token_is_accepted(client, auth_on, bearer):
    r = client.get("/me", headers=bearer("user_a"))
    assert r.status_code == 200
    assert r.json()["user"]["id"] == "user_a"
    assert auth_on == [f"{ISSUER}/.well-known/jwks.json"]


def test_jwks_is_cached(client, auth_on, bearer):
    for _ in range(3):
        assert client.get("/me", headers=bearer()).status_code == 200
    assert len(auth_on) == 1


def test_missing_token_is_401_not_404(client, auth_on):
    job = _job(owner="user_a")
    r = client.get(f"/jobs/{job.id}")
    assert r.status_code == 401
    assert r.json() == {"detail": "auth_required", "code": "auth_required", "params": {}}
    assert client.get("/me").status_code == 401


@pytest.mark.parametrize("overrides", [
    {"iss": "https://evil.example"},
    {"azp": "https://evil.example"},
    {"azp": None},                          # missing azp
    {"sts": "pending"},
    {"exp": int(time.time()) - 120},        # beyond the 60 s leeway
    {"nbf": int(time.time()) + 300},
    {"sid": None},
])
def test_bad_claims_are_rejected(client, auth_on, bearer, overrides):
    r = client.get("/me", headers=bearer("user_a", **overrides))
    assert r.status_code == 401
    assert r.json() == {"detail": "auth_required", "code": "auth_required", "params": {}}


def test_recently_expired_token_is_accepted(client, auth_on, bearer):
    # A slow legacy upload: the token expired while the body arrived.
    r = client.get("/me", headers=bearer(exp=int(time.time()) - 30))
    assert r.status_code == 200


def test_wrong_signing_key_is_rejected(client, auth_on, bearer):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    r = client.get("/me", headers=bearer(key=other))
    assert r.status_code == 401


def test_hs256_confusion_is_rejected(client, auth_on, rsa_key):
    pem = rsa_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo)
    now = int(time.time())
    claims = {"iss": ISSUER, "sub": "user_a", "sid": "s", "azp":
              "http://localhost:3000", "iat": now, "exp": now + 60}
    # PyJWT refuses to HMAC-sign with a PEM, so build the token by hand.
    import base64, hashlib, hmac, json
    enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
    head = enc(json.dumps({"alg": "HS256", "typ": "JWT", "kid": "test-key-1"}
                          ).encode())
    body = enc(json.dumps(claims).encode())
    sig = enc(hmac.new(pem, head + b"." + body, hashlib.sha256).digest())
    token = (head + b"." + body + b"." + sig).decode()
    r = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_garbage_and_other_schemes(client, auth_on, make_token):
    for value in ("Bearer nonsense", "Basic dXNlcjpwYXNz",
                  f"Token {make_token()}", "Bearer "):
        r = client.get("/me", headers={"Authorization": value})
        assert r.status_code == 401, value


def test_networkless_pem_key(client, monkeypatch, rsa_key, make_token):
    pem = rsa_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    # Dashboards often keep the PEM on one line with literal "\n".
    monkeypatch.setenv("CLERK_JWT_KEY", pem.replace("\n", "\\n"))

    def no_network(self):
        raise AssertionError("JWKS must not be fetched with CLERK_JWT_KEY")
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", no_network)
    r = client.get("/me", headers={"Authorization": f"Bearer {make_token()}"})
    assert r.status_code == 200


def test_authorized_parties_env(client, auth_on, monkeypatch, bearer):
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES",
                       "https://cleocuts.com, http://192.168.1.5:3000")
    assert client.get("/me", headers=bearer()).status_code == 401  # localhost
    ok = bearer(azp="http://192.168.1.5:3000")
    assert client.get("/me", headers=ok).status_code == 200


def test_jwks_outage_is_401(client, monkeypatch, bearer):
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)

    def down(self):
        raise jwt.PyJWKClientConnectionError("unreachable")
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", down)
    assert client.get("/me", headers=bearer()).status_code == 401


def test_rejected_token_cannot_forge_log_lines(client, auth_on, make_token,
                                              capsys):
    """PyJWT quotes the unverified `kid` in its error; newlines in it
    must not start a fake log line (e.g. a fake billing event)."""
    token = make_token(headers={"kid": "x\n[billing] webhook "
                                "subscription_created: {'applied': True}"})
    r = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    out = capsys.readouterr().out
    assert "[auth] token rejected" in out
    assert not any(line.startswith("[billing]") for line in out.splitlines())


def test_removed_jwks_key_stops_working(client, monkeypatch, bearer,
                                        rsa_key, jwks):
    """No per-kid cache without expiry: once Clerk drops a key from its
    JWKS (and the 5 min key-set cache ends) tokens signed with it fail."""
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    served = {"jwks": jwks}
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data",
                        lambda self: served["jwks"])
    assert client.get("/me", headers=bearer()).status_code == 200
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(other.public_key(),
                                             as_dict=True)
    jwk.update({"kid": "test-key-2", "use": "sig", "alg": "RS256"})
    served["jwks"] = {"keys": [jwk]}
    auth._jwks[1].jwk_set_cache.put(None)  # = the 5 min lifespan ran out
    assert client.get("/me", headers=bearer()).status_code == 401


def test_jwks_outage_keeps_last_good_keys_and_fails_fast(
        client, monkeypatch, bearer, jwks):
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    state = {"up": True, "calls": 0}

    def fetch(self):
        state["calls"] += 1
        if not state["up"]:
            raise jwt.PyJWKClientConnectionError("timed out")
        return jwks
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fetch)
    assert client.get("/me", headers=bearer()).status_code == 200
    state["up"] = False
    auth._jwks[1].jwk_set_cache.put(None)
    # Endpoint down: the last good key set still verifies tokens …
    for _ in range(3):
        assert client.get("/me", headers=bearer()).status_code == 200
    # … and after one failed fetch nobody waits for another for a while.
    assert state["calls"] == 2


def test_jwks_cold_start_outage_fails_fast(client, monkeypatch, bearer):
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    calls = []

    def down(self):
        calls.append(1)
        raise jwt.PyJWKClientConnectionError("timed out")
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", down)
    for _ in range(3):
        assert client.get("/me", headers=bearer()).status_code == 401
    assert len(calls) == 1


# ── ownership ────────────────────────────────────────────────────────


def test_upload_is_owned_and_hidden_from_others(client, auth_on, bearer):
    r = _upload(client, bearer("user_a"), filename="Holiday.mp4",
                preset_id="talking-head", preset_label="Talking head")
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    job = store.get(job_id)
    assert job.owner_id == "user_a"
    assert (job.filename, job.preset_id, job.preset_label) == (
        "Holiday.mp4", "talking-head", "Talking head")
    assert job.created_at > 0

    assert client.get(f"/jobs/{job_id}", headers=bearer("user_a")).status_code == 200
    for method, path in [("GET", f"/jobs/{job_id}"),
                         ("GET", f"/jobs/{job_id}/subtitles"),
                         ("DELETE", f"/jobs/{job_id}"),
                         ("POST", f"/jobs/{job_id}/render"),
                         ("POST", f"/jobs/{job_id}/phrases"),
                         ("GET", f"/jobs/{job_id}/watch"),
                         ("GET", f"/jobs/{job_id}/thumbnail")]:
        kw = {"json": {}} if method == "POST" else {}
        r = client.request(method, path, headers=bearer("user_b"), **kw)
        assert r.status_code == 404, (method, path, r.text)
        assert r.json() == {"detail": "job not found", "code": "not_found", "params": {}}
    assert store.get(job_id) is not None  # B's delete did nothing


def test_missing_job_is_404(client, auth_on, bearer):
    r = client.get("/jobs/doesnotexist", headers=bearer())
    assert r.status_code == 404


def test_beta_job_is_claimed_by_first_user(client, auth_on, bearer):
    job = _job(owner=None)
    store.update(job.id, updated_at=1000.0)
    r = client.get(f"/jobs/{job.id}", headers=bearer("user_b"))
    assert r.status_code == 200
    claimed = store.get(job.id)
    assert claimed.owner_id == "user_b"
    assert claimed.updated_at == 1000.0  # retention clock untouched
    assert client.get(f"/jobs/{job.id}", headers=bearer("user_a")).status_code == 404
    assert client.get(f"/jobs/{job.id}", headers=bearer("user_b")).status_code == 200


def test_claim_race_has_one_winner():
    job = _job(owner=None)
    assert store.claim(job.id, "user_a") == "user_a"
    assert store.claim(job.id, "user_b") == "user_a"
    assert store.claim("missing", "user_b") is None
    with pytest.raises(Exception) as e:
        auth.get_owned_job(job.id, auth.User(id="user_b"))
    assert e.value.status_code == 404


def test_job_list_is_per_user_newest_first(client, auth_on, bearer):
    ids = []
    for name in ("one.mp4", "two.mp4"):
        r = _upload(client, bearer("user_a"), filename=name)
        ids.append(r.json()["job_id"])
        time.sleep(0.01)
    _upload(client, bearer("user_b"), filename="other.mp4")
    rows = client.get("/jobs", headers=bearer("user_a")).json()
    assert [r["id"] for r in rows] == ids[::-1]
    assert rows[0]["filename"] == "two.mp4"
    assert set(rows[0]) >= {
        "id", "status", "message", "progress", "filename", "preset_id",
        "preset_label", "created_at", "updated_at", "expires_at",
        "has_output", "outputs", "hook_clips", "social_caption",
        "social_hashtags", "duration"}
    assert client.get("/jobs").status_code == 401


def test_service_user(client, auth_on, monkeypatch, bearer):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    job = _job(owner="user_a")
    svc = {"X-Admin-Token": "s3cret"}
    assert client.get(f"/jobs/{job.id}", headers=svc).status_code == 200
    assert store.get(job.id).owner_id == "user_a"  # no claim
    assert client.get(f"/jobs/{job.id}",
                      headers={"X-Admin-Token": "wrong"}).status_code == 401
    assert client.get(f"/jobs/{job.id}",
                      headers={"X-Admin-Token": "ünïcode".encode("latin-1")}
                      ).status_code == 401
    # The cost test tags its jobs; real users can't.
    r = _upload(client, svc, settings='{"_cost_test": true, "_r2_storage_key": "x"}')
    # (_max_seconds: every analysis stops at CLEO_MAX_MINUTES.)
    assert store.get(r.json()["job_id"]).settings == {
        "_cost_test": True, "_max_seconds": 30 * 60 + 1}
    r = _upload(client, bearer(), settings='{"_cost_test": true, "style": "tight"}')
    assert store.get(r.json()["job_id"]).settings == {
        "style": "tight", "_max_seconds": 30 * 60 + 1}
    assert len(client.get("/jobs", headers=svc).json()) == 3


def test_admin_costs_lists_owner(client, auth_on, monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    job = _job(owner="user_a", costs={"usd_total": 0.01})
    rows = client.get("/admin/costs",
                      headers={"X-Admin-Token": "s3cret"}).json()["rows"]
    assert rows[0]["job_id"] == job.id and rows[0]["owner_id"] == "user_a"


# ── uploads to R2 ────────────────────────────────────────────────────


@pytest.fixture
def fake_r2(monkeypatch, r2):
    """R2 on moto with the caller's upload in it; presign handing out a
    fixed key; the duration probe faked (no ffprobe over the network)."""
    import backend.storage as storage

    def presign(filename, expires_in=3600, content_type="video/mp4",
                prefix="uploads/"):
        return {"storage_key": f"{prefix}abc.mp4", "upload_url": "https://r2/x"}
    monkeypatch.setattr(storage, "presign_upload", presign)
    r2.put_object(Bucket=storage.bucket(), Key="uploads/user_a/abc.mp4",
                  Body=b"video")
    probed = []
    monkeypatch.setattr(M, "_probe_remote",
                        lambda url: (probed.append(url) or 60.0, None, None))
    downloaded = []
    real_get = M.media.get_file
    monkeypatch.setattr(M.media, "get_file", lambda key, path, **kw: (
        downloaded.append(key), real_get(key, path, **kw))[1])
    return downloaded, probed


def test_presign_keys_are_namespaced(client, auth_on, bearer, fake_r2):
    r = client.post("/uploads/presign", headers=bearer("user_a"),
                    json={"filename": "a.mp4"})
    assert r.json()["storage_key"] == "uploads/user_a/abc.mp4"
    assert client.post("/uploads/presign", json={}).status_code == 401


def test_foreign_storage_key_is_403(client, auth_on, bearer, fake_r2):
    downloaded, _ = fake_r2
    for key in ("uploads/user_b/abc.mp4", "uploads/abc.mp4",
                "uploads/user_a/../user_b/x.mp4", "private/thing"):
        r = client.post("/jobs", headers=bearer("user_a"),
                        data={"settings": "{}", "storage_key": key})
        assert r.status_code == 403, key
    assert downloaded == []
    r = client.post("/jobs", headers=bearer("user_a"),
                    data={"settings": "{}", "filename": "big.mov",
                          "storage_key": "uploads/user_a/abc.mp4"})
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert job.source_key == "uploads/user_a/abc.mp4"
    assert "_r2_storage_key" not in job.settings
    assert job.filename == "big.mov"
    assert downloaded == []   # the analysis worker fetches it, not POST /jobs


def test_multipart_routes_need_auth_and_a_ticket(client, auth_on, bearer,
                                                 no_r2, monkeypatch):
    """The resumable upload routes are back (WP3) — with ownership: a
    session, and a ticket signed for that user."""
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    paths = ("/uploads/multipart/init", "/uploads/multipart/sign",
             "/uploads/multipart/parts", "/uploads/multipart/complete",
             "/uploads/multipart/abort", "/uploads/telemetry")
    for path in paths:
        assert client.post(path, json={"event": "x"}).status_code == 401
    # No R2 on this deployment: init says so (not "server_busy", so the
    # web app falls back to the legacy upload).
    r = client.post("/uploads/multipart/init", headers=bearer(),
                    json={"size": 1000, "filename": "a.mp4"})
    assert r.status_code == 503 and r.json()["detail"] != "server_busy"
    for path in paths[1:-1]:
        r = client.post(path, headers=bearer(), json={"ticket": "x.y"})
        assert r.status_code == 403 and r.json() == {"detail": "bad_ticket", "code": "bad_ticket", "params": {}}
    job = _job(owner="user_a")
    r = client.get(f"/jobs/{job.id}/source-video", headers=bearer())
    assert r.status_code == 404


# ── media tokens ─────────────────────────────────────────────────────


def _rendered_job(owner):
    out = Path(M._WORK_ROOT) / f"media-{owner}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "cleo_output.mp4").write_bytes(b"mp4")
    (out / "cleo_thumbnail.jpg").write_bytes(b"jpg")
    (out / "preview.mp4").write_bytes(b"prev")
    return _job(owner=owner, status="done",
                output_path=str(out / "cleo_output.mp4"),
                outputs={"primary": str(out / "cleo_output.mp4")},
                preview_path=str(out / "preview.mp4"))


def test_media_token_opens_media_routes(client, auth_on, bearer):
    job = _rendered_job("user_a")
    token = client.get("/me", headers=bearer("user_a")).json()["media_token"]
    assert token == client.get("/me", headers=bearer("user_a")).json()["media_token"]
    for route in ("thumbnail", "watch", "download", "preview-video"):
        r = client.get(f"/jobs/{job.id}/{route}", params={"t": token})
        assert r.status_code == 200, (route, r.text)
    r = client.get(f"/jobs/{job.id}/thumbnail", params={"t": token})
    assert r.headers["cache-control"] == "private, max-age=86400"
    # Header auth works on media routes too.
    assert client.get(f"/jobs/{job.id}/watch", headers=bearer("user_a")).status_code == 200
    # Expired header token but a valid t → still fine.
    r = client.get(f"/jobs/{job.id}/watch", params={"t": token},
                   headers=bearer("user_a", exp=int(time.time()) - 600))
    assert r.status_code == 200


def test_media_token_is_scoped(client, auth_on, bearer):
    job = _rendered_job("user_a")
    token_b = auth.media_token("user_b")
    r = client.get(f"/jobs/{job.id}/watch", params={"t": token_b})
    assert r.status_code == 404
    token_a = auth.media_token("user_a")
    # Only media routes take ?t=.
    assert client.get(f"/jobs/{job.id}", params={"t": token_a}).status_code == 401
    assert client.get(f"/jobs/{job.id}/subtitles",
                      params={"t": token_a}).status_code == 401
    assert client.get(f"/jobs/{job.id}/watch").status_code == 401
    uid, w, sig = token_a.rsplit(".", 2)
    for bad in (f"{uid}.{w}.{'0' * len(sig)}", f"user_b.{w}.{sig}",
                f"{uid}.{int(w) + 1}.{sig}", "garbage", f"{uid}.{w}.ü"):
        r = client.get(f"/jobs/{job.id}/watch", params={"t": bad})
        assert r.status_code == 401, bad


def test_media_token_window():
    now = time.time()
    tok = auth.media_token("user_a", now=now - 86400)       # yesterday
    assert auth.verify_media_token(tok, now=now) == "user_a"
    tok = auth.media_token("user_a", now=now - 2 * 86400)   # day before
    assert auth.verify_media_token(tok, now=now) is None


def test_media_secret_is_persisted(monkeypatch):
    first = auth.media_token("user_a")
    assert auth.media_token("user_a") == first
    from backend import accounts
    accounts._reset_for_tests()  # "restart": same DB, same secret
    assert auth.media_token("user_a") == first
    monkeypatch.setenv("CLEO_MEDIA_SECRET", "explicit")
    assert auth.media_token("user_a") != first


def test_access_log_redacts_media_tokens():
    f = auth.RedactMediaTokens()
    rec = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/jobs/x/watch?format=primary&t=user_a.1.abc",
         "1.1", 200), None)
    assert f.filter(rec)
    assert "user_a.1.abc" not in rec.getMessage()
    assert "t=[redacted]" in rec.getMessage()
    assert "format=primary" in rec.getMessage()
    assert any(isinstance(x, auth.RedactMediaTokens)
               for x in logging.getLogger("uvicorn.access").filters)
