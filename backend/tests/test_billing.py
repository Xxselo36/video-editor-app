"""Entitlement, minutes quota (charge / true-up / refund), checkout,
portal, /billing/config and GET /me."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, billing, pipeline
from backend.jobs import DEFAULT_PLAN, store
from conftest import add_sub, analysis_result


def _ts(s: str) -> float:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


def _upload(client, headers, settings="{}"):
    return client.post("/jobs", headers=headers,
                       data={"settings": settings, "filename": "v.mp4"},
                       files={"file": ("v.mp4", b"x" * 100, "video/mp4")})


@pytest.fixture
def probe(monkeypatch):
    """Probed length of the next uploads (seconds)."""
    box = {"seconds": 60.0}
    monkeypatch.setattr(M, "_probe_duration", lambda path: box["seconds"])
    return box


def _uploads_dir_files():
    d = Path(M._WORK_ROOT) / "uploads"
    return [p for p in d.iterdir()] if d.exists() else []


# ── entitlement ──────────────────────────────────────────────────────

NOW = time.time()


@pytest.mark.parametrize("status,ends_at,grants", [
    ("active", None, True),
    ("on_trial", None, True),
    ("past_due", None, True),
    ("cancelled", NOW + 86400, True),
    ("cancelled", NOW - 60, False),
    ("cancelled", None, False),
    ("paused", None, False),
    ("unpaid", None, False),
    ("expired", None, False),
])
def test_entitlement_by_status(status, ends_at, grants):
    add_sub(status=status, ends_at=ends_at)
    ent = accounts.entitlement("user_a", now=NOW)
    assert (ent is not None) == grants
    if grants:
        assert ent.plan == "pro" and ent.source == "subscription"


def test_best_plan_wins_and_test_mode_filters(monkeypatch):
    add_sub("s1", plan="starter")
    add_sub("s2", plan="studio", status="expired")
    add_sub("s3", plan="pro")
    add_sub("s4", plan="studio", test_mode=1)
    assert accounts.entitlement("user_a").plan == "pro"
    monkeypatch.setenv("LEMONSQUEEZY_TEST_MODE", "1")
    assert accounts.entitlement("user_a").plan == "studio"
    assert accounts.entitlement("user_b") is None


def test_comp_users(monkeypatch):
    monkeypatch.setenv("CLEO_COMP_USERS", "user_x, Friend@Example.com")
    assert accounts.entitlement("user_x").plan == "studio"
    accounts.ensure_user("user_y", "friend@example.com")
    ent = accounts.entitlement("user_y")
    assert ent.plan == "studio" and ent.source == "comp"
    assert accounts.entitlement("user_z") is None


# ── periods ──────────────────────────────────────────────────────────


def test_add_months_clamps():
    assert accounts.add_months(_ts("2026-01-31T12:00:00"), 1) == _ts("2026-02-28T12:00:00")
    assert accounts.add_months(_ts("2026-01-31T12:00:00"), 2) == _ts("2026-03-31T12:00:00")
    assert accounts.add_months(_ts("2026-11-15T00:00:00"), 3) == _ts("2027-02-15T00:00:00")


def test_period_fallback_advances_whole_months():
    now = _ts("2026-09-28T10:00:00")
    ent = accounts.Entitlement("pro", "subscription",
                               {"created_at": _ts("2026-01-31T09:00:00")})
    start, end = accounts.period_for(ent, now)
    assert start == _ts("2026-08-31T09:00:00")
    assert end == _ts("2026-09-30T09:00:00")


def test_invoice_period_does_not_reset_on_its_own():
    # past_due: renewal not paid → the old period (and its usage) stays.
    now = _ts("2026-09-28T10:00:00")
    ent = accounts.Entitlement("pro", "subscription", {
        "period_start": _ts("2026-08-10T00:00:00"),
        "created_at": _ts("2026-01-10T00:00:00")})
    assert accounts.period_for(ent, now)[0] == _ts("2026-08-10T00:00:00")


def test_used_counts_period_and_skips_refunds():
    add_sub(period_start=time.time() - 3600)
    accounts.charge("old", "user_a", 999, enforce=False,
                    now=time.time() - 7200)  # before the period
    accounts.charge("j1", "user_a", 100, enforce=True)
    accounts.charge("j2", "user_a", 50, enforce=True)
    accounts.refund("j2", "test")
    ent = accounts.entitlement("user_a")
    start = accounts.period_for(ent)[0]
    assert accounts.used_seconds("user_a", start) == 100
    assert accounts.refund("j2", "again") is False  # idempotent


def test_parallel_charges_never_overspend(monkeypatch):
    monkeypatch.setitem(accounts.PLAN_MINUTES, "starter", 10)  # 600 s
    add_sub(plan="starter", period_start=time.time() - 60)
    ok, refused = [], []

    def one(i):
        try:
            accounts.charge(f"p{i}", "user_a", 100, enforce=True)
            ok.append(i)
        except accounts.QuotaExceeded:
            refused.append(i)
    threads = [threading.Thread(target=one, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(ok) == 6 and len(refused) == 4


# ── POST /jobs quota ─────────────────────────────────────────────────


def test_enforced_upload_needs_subscription(client, enforce, bearer, probe):
    r = _upload(client, bearer())
    assert r.status_code == 402
    assert r.json() == {"detail": {"code": "subscription_required"},
                        "code": "subscription_required", "params": {}}
    assert _uploads_dir_files() == []  # upload thrown away
    assert store.list_all() == []


def test_enforced_upload_charges_and_refuses_over_quota(
        client, enforce, bearer, probe, clean_state, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_MINUTES", "120")  # above the 30 min cap
    add_sub(plan="starter", period_start=time.time() - 60)  # 5400 s
    probe["seconds"] = 5000.2
    r = _upload(client, bearer())
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    assert clean_state == [job_id]  # analysis started
    assert store.get(job_id).plan == "starter"
    assert store.get(job_id).owner_id == "user_a"
    usage = accounts.get_usage(job_id)
    assert usage["seconds_billed"] == 5001  # per started second

    probe["seconds"] = 600
    r = _upload(client, bearer())
    assert r.status_code == 402
    assert r.json()["detail"] == {"code": "quota_exceeded",
                                  "remaining_seconds": 399,
                                  "needed_seconds": 600}
    assert len(store.list_all()) == 1
    probe["seconds"] = 399
    assert _upload(client, bearer()).status_code == 200


def test_unreadable_video(client, enforce, bearer, monkeypatch):
    add_sub()
    monkeypatch.setattr(M, "_probe_duration", lambda p: None)
    r = _upload(client, bearer())
    assert r.status_code == 400 and r.json()["detail"] == "unreadable_video"
    assert store.list_all() == []


def test_not_enforced_records_but_never_blocks(client, billing_on, bearer,
                                               probe, monkeypatch):
    r = _upload(client, bearer())  # no subscription at all
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    assert store.get(job_id).plan == DEFAULT_PLAN
    assert accounts.get_usage(job_id)["seconds_billed"] == 60
    monkeypatch.setattr(M, "_probe_duration", lambda p: None)
    assert _upload(client, bearer()).status_code == 200


def test_service_user_is_not_charged(client, enforce, bearer, probe,
                                     monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    r = _upload(client, {"X-Admin-Token": "s3cret"},
                settings='{"_cost_test": true}')
    assert r.status_code == 200
    assert accounts.get_usage(r.json()["job_id"]) is None


def test_presign_paywall_comes_before_no_r2(client, enforce, bearer, no_r2):
    """Without R2 the frontend falls back to the legacy upload (whole
    file) on 503 — the 402 must come first."""
    r = client.post("/uploads/presign", headers=bearer(), json={})
    assert r.status_code == 402
    assert r.json()["detail"]["code"] == "subscription_required"
    add_sub(plan="starter", period_start=time.time() - 60)
    r = client.post("/uploads/presign", headers=bearer(), json={"duration": 60})
    assert r.status_code == 503


def test_enforced_upload_caps_the_analysis(client, enforce, bearer, probe,
                                           billing_on, monkeypatch):
    """The charge trusts the container's duration header: analysis must
    not process more than was charged (+ tolerance)."""
    add_sub(plan="starter", period_start=time.time() - 60)
    probe["seconds"] = 3.5  # a header claiming 3.5 s (the minimum is 3, UX5)
    r = _upload(client, bearer())
    assert r.status_code == 200
    job = store.get(r.json()["job_id"])
    assert accounts.get_usage(job.id)["seconds_billed"] == 4
    assert job.settings["_max_seconds"] == 4 + accounts.TRUE_UP_TOLERANCE_S
    # Clients can't set it themselves.
    r = _upload(client, bearer(), settings='{"_max_seconds": 99999}')
    assert store.get(r.json()["job_id"]).settings["_max_seconds"] == 4 + accounts.TRUE_UP_TOLERANCE_S
    # Not enforced: nobody is blocked; capped at CLEO_MAX_MINUTES only
    # (the client's value is dropped).
    monkeypatch.delenv("CLEO_BILLING_ENFORCE")
    r = _upload(client, bearer(), settings='{"_max_seconds": 3}')
    assert store.get(r.json()["job_id"]).settings["_max_seconds"] == 1801
    monkeypatch.setenv("CLEO_MAX_MINUTES", "0")    # cap off
    r = _upload(client, bearer(), settings='{"_max_seconds": 3}')
    assert r.status_code == 200, r.text
    assert "_max_seconds" not in store.get(r.json()["job_id"]).settings


def test_normalize_respects_the_cap(tmp_path):
    """Real ffmpeg: the cap cuts the normalized file (everything after
    normalization — transcription, cleanup — works on that file)."""
    import shutil
    import subprocess
    from backend import pipeline
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe not installed")
    src = tmp_path / "src.mp4"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                    "testsrc=size=64x64:rate=10:duration=8", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=8", "-c:a", "aac",
                    "-shortest", str(src)], check=True)
    out = tmp_path / "normalized.mp4"
    pipeline._normalize_orientation(str(src), str(out), max_seconds=3.0)
    assert M._probe_duration(str(out)) == pytest.approx(3.0, abs=0.3)


def test_failed_analysis_is_trued_up(auth_on, monkeypatch):
    """A content failure comes after the transcription was paid for:
    charge what the normalized file really holds — no refund while enough
    speech was found (NO_SPEECH_REFUND_S; below it: test_no_speech.py)."""
    job = _analyzed_job(seconds=1)

    def no_speech(input_path, output_dir, settings, progress_cb):
        Path(output_dir, "normalized.mp4").write_bytes(b"x")
        raise pipeline.NoSpeechError(speech_seconds=25.0)
    monkeypatch.setattr(M, "analyze_only", no_speech)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 250.0)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.status, got.error_code, got.refunded) == (
        "error", "no_speech", None)
    usage = accounts.get_usage(job.id)
    assert usage["seconds_billed"] == 250 and usage["refunded"] == 0


def test_presign_soft_check(client, enforce, bearer, monkeypatch):
    import backend.storage as storage
    monkeypatch.setattr(storage, "r2_available", lambda: True)
    monkeypatch.setattr(storage, "presign_upload",
                        lambda filename, content_type, prefix: {
                            "storage_key": prefix + "k.mp4"})
    r = client.post("/uploads/presign", headers=bearer(), json={})
    assert r.status_code == 402
    assert r.json()["detail"]["code"] == "subscription_required"
    add_sub(plan="starter", period_start=time.time() - 60)
    r = client.post("/uploads/presign", headers=bearer(),
                    json={"duration": 6000})
    assert r.json()["detail"]["code"] == "quota_exceeded"
    r = client.post("/uploads/presign", headers=bearer(),
                    json={"duration": 60})
    assert r.status_code == 200


# ── true-up / refund ─────────────────────────────────────────────────


def _analyzed_job(owner="user_a", seconds=100):
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    job = store.create(str(f), {}, owner_id=owner)
    accounts.charge(job.id, owner, seconds, enforce=False)
    return job


@pytest.mark.parametrize("actual,billed", [(200.4, 201), (103, 100)])
def test_true_up(auth_on, monkeypatch, actual, billed):
    job = _analyzed_job(seconds=100)
    monkeypatch.setattr(M, "analyze_only",
                        lambda **kw: analysis_result(kw["output_dir"], actual))
    M._run_analyze_inner(job.id)
    assert store.get(job.id).status == "awaiting_review"
    usage = accounts.get_usage(job.id)
    assert usage["seconds_billed"] == billed
    assert usage["seconds_actual"] == actual


@pytest.mark.parametrize("exc,refunded", [
    (OSError(28, "No space left on device"), True),
    (RuntimeError("ffmpeg orientation-normalize failed (hdr=False):\n..."), True),
    (FileNotFoundError("ffprobe"), True),
    # Content failures: charged — except (almost) no speech at all.
    (RuntimeError("No speech detected in the video."), True),
    (pipeline.NoSpeechError(), True),
    (pipeline.NoSpeechError(speech_seconds=12.0), False),
    (ValueError("Video has no audio track"), True),
    (ValueError("nothing to apply"), False),
])
def test_refund_only_for_infrastructure_failures(auth_on, monkeypatch, exc,
                                                 refunded):
    job = _analyzed_job()

    def boom(**kw):
        raise exc
    monkeypatch.setattr(M, "analyze_only", boom)
    M._run_analyze_inner(job.id)
    assert store.get(job.id).status == "error"
    assert bool(accounts.get_usage(job.id)["refunded"]) == refunded


def test_container_restart_refund(auth_on):
    job = _analyzed_job()
    store.update(job.id, status="processing")
    store.mark_stuck_as_error()
    M._refund_interrupted()
    assert accounts.get_usage(job.id)["refunded"] == 1


def test_deleting_a_job_keeps_the_usage(client, billing_on, bearer, probe):
    job_id = _upload(client, bearer()).json()["job_id"]
    store.update(job_id, status="done")
    assert client.delete(f"/jobs/{job_id}", headers=bearer()).status_code == 200
    assert store.get(job_id) is None
    assert accounts.get_usage(job_id)["seconds_billed"] == 60


# ── checkout / portal ────────────────────────────────────────────────


def test_checkout(client, billing_on, bearer, monkeypatch):
    monkeypatch.setenv("CLEO_APP_URL", "https://app.example/")
    monkeypatch.setenv("LEMONSQUEEZY_TEST_MODE", "1")
    monkeypatch.setenv("CLEO_BILLING_TESTERS", "user_a")
    r = client.post("/billing/checkout", headers=bearer(),
                    json={"plan": "starter", "email": "typed@example.com"})
    assert r.status_code == 200, r.text
    assert r.json() == {"url": billing_on.checkout_url}
    method, path, body = billing_on.calls[-1]
    assert (method, path) == ("POST", "/checkouts")
    a = body["data"]["attributes"]
    assert a["checkout_data"] == {
        "custom": {"user_id": "user_a",
                   "sig": billing.checkout_signature("user_a")},
        "email": "typed@example.com"}
    assert accounts.last_checkout_at("user_a") is not None
    assert a["product_options"]["redirect_url"] == \
        "https://app.example/app/account?billing=success"
    assert a["product_options"]["enabled_variants"] == [111]
    assert a["test_mode"] is True
    rel = body["data"]["relationships"]
    assert rel["variant"]["data"] == {"type": "variants", "id": "111"}
    assert rel["store"]["data"]["id"] == "179021"


def test_checkout_prefers_clerk_email(client, billing_on, bearer,
                                      monkeypatch):
    monkeypatch.setattr(billing, "clerk_email", lambda uid: "real@example.com")
    client.post("/billing/checkout", headers=bearer(),
                json={"plan": "pro", "email": "typed@example.com"})
    body = billing_on.calls[-1][2]
    assert body["data"]["attributes"]["checkout_data"]["email"] == \
        "real@example.com"
    assert accounts.get_user("user_a")["email"] == "real@example.com"


def test_checkout_refused_when_subscribed(client, billing_on, bearer):
    add_sub("sub_1", plan="starter")
    billing_on.sub("sub_1", variant="111")
    r = client.post("/billing/checkout", headers=bearer(),
                    json={"plan": "pro"})
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "already_subscribed",
                                  "portal_url": "https://portal.test/sub_1"}
    assert not any(c[1] == "/checkouts" for c in billing_on.calls)


def test_test_mode_checkout_is_for_testers_only(client, billing_on, bearer,
                                               monkeypatch):
    """With LEMONSQUEEZY_TEST_MODE on production, the public must not get
    a plan for the public test card number."""
    monkeypatch.setenv("LEMONSQUEEZY_TEST_MODE", "1")
    r = client.post("/billing/checkout", headers=bearer("user_stranger"),
                    json={"plan": "pro"})
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "test_mode_testers_only"}
    assert not any(c[1] == "/checkouts" for c in billing_on.calls)
    monkeypatch.setenv("CLEO_BILLING_TESTERS", "owner@example.com")
    accounts.ensure_user("user_owner", "owner@example.com")
    assert client.post("/billing/checkout", headers=bearer("user_owner"),
                       json={"plan": "pro"}).status_code == 200
    monkeypatch.setenv("CLEO_COMP_USERS", "user_friend")
    assert client.post("/billing/checkout", headers=bearer("user_friend"),
                       json={"plan": "pro"}).status_code == 200
    # Live mode: everyone.
    monkeypatch.delenv("LEMONSQUEEZY_TEST_MODE")
    assert client.post("/billing/checkout", headers=bearer("user_stranger"),
                       json={"plan": "pro"}).status_code == 200


def test_comp_user_with_subscription_cannot_buy_twice(client, billing_on,
                                                      bearer, monkeypatch):
    monkeypatch.setenv("CLEO_COMP_USERS", "user_a")
    add_sub("sub_1", plan="pro")
    billing_on.sub("sub_1")
    r = client.post("/billing/checkout", headers=bearer(),
                    json={"plan": "starter"})
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "already_subscribed",
                                  "portal_url": "https://portal.test/sub_1"}
    assert not any(c[1] == "/checkouts" for c in billing_on.calls)


@pytest.mark.parametrize("status,blocked", [
    ("paused", True), ("unpaid", True), ("expired", False)])
def test_paused_or_unpaid_subscription_blocks_checkout(client, billing_on,
                                                       bearer, status,
                                                       blocked):
    """Resuming / fixing the card goes through the portal — a second
    checkout would bill twice once the old one comes back."""
    add_sub("sub_old", plan="pro", status=status)
    billing_on.sub("sub_old", status=status)
    r = client.post("/billing/checkout", headers=bearer(),
                    json={"plan": "pro"})
    if blocked:
        assert r.status_code == 409
        assert r.json()["detail"]["portal_url"] == \
            "https://portal.test/sub_old"
    else:
        assert r.status_code == 200


def test_checkout_errors(client, billing_on, bearer, monkeypatch):
    assert client.post("/billing/checkout", headers=bearer(),
                       json={"plan": "gold"}).status_code == 400
    assert client.post("/billing/checkout",
                       json={"plan": "pro"}).status_code == 401
    billing_on.down = True
    assert client.post("/billing/checkout", headers=bearer(),
                       json={"plan": "pro"}).status_code == 502
    # Comp users may still buy.
    billing_on.down = False
    monkeypatch.setenv("CLEO_COMP_USERS", "user_a")
    assert client.post("/billing/checkout", headers=bearer(),
                       json={"plan": "pro"}).status_code == 200


def test_portal(client, billing_on, bearer):
    assert client.get("/billing/portal", headers=bearer()).status_code == 404
    add_sub("sub_1")
    billing_on.sub("sub_1")
    r = client.get("/billing/portal", headers=bearer())
    assert r.json() == {"url": "https://portal.test/sub_1"}


def test_billing_routes_off(client, auth_on, bearer):
    assert client.post("/billing/checkout", headers=bearer(),
                       json={"plan": "pro"}).status_code == 404
    assert client.get("/billing/portal", headers=bearer()).status_code == 404


# ── config ───────────────────────────────────────────────────────────


def test_price_survives_a_failed_currency_lookup(client, billing_on,
                                                monkeypatch):
    """One failed /stores lookup must not blank the formatted prices for
    the variants' full cache hour — only until the store is retried."""
    billing_on.variants["795658"] = {"price": 1900, "interval": "month"}
    real = billing._ls_request
    fail = {"store": True}

    def flaky(method, path, body=None, timeout=15.0):
        if path.startswith("/stores/") and fail["store"]:
            raise billing.LemonSqueezyError(503, "down")
        return real(method, path, body, timeout)
    monkeypatch.setattr(billing, "_ls_request", flaky)
    pro = lambda: {p["id"]: p for p in
                   client.get("/billing/config").json()["plans"]}["pro"]
    assert pro()["price_formatted"] is None
    assert pro()["price"] == 1900
    fail["store"] = False
    # The failed store lookup is retried after 5 min …
    key = f"store:{billing.store_id()}"
    ts, value = billing._price_cache[key]
    billing._price_cache[key] = (ts - 301, value)
    variant_calls = sum(c[1].startswith("/variants/") for c in billing_on.calls)
    assert pro()["price_formatted"] == "$19.00"
    # … without refetching the (cached) variant.
    assert sum(c[1].startswith("/variants/") for c in billing_on.calls) == \
        variant_calls


def test_config(client, billing_on, monkeypatch):
    monkeypatch.delenv("LEMONSQUEEZY_VARIANT_STUDIO")
    billing_on.variants["111"] = {"price": 900, "interval": "month"}
    cfg = client.get("/billing/config").json()
    assert cfg["enabled"] is True and cfg["enforce"] is False
    plans = {p["id"]: p for p in cfg["plans"]}
    assert plans["starter"]["price_formatted"] == "$9.00"
    assert plans["starter"]["interval"] == "month"
    assert plans["starter"]["minutes"] == 90
    assert plans["starter"]["retention_days"] == 14
    assert plans["pro"]["price_formatted"] is None  # lookup failed
    assert plans["studio"]["available"] is False
    n = len(billing_on.calls)
    client.get("/billing/config")
    assert len(billing_on.calls) == n  # cached


@pytest.mark.sqlite_only
def test_billing_refuses_tmp_db(client, billing_on, monkeypatch):
    import backend.jobs as jobs
    monkeypatch.delenv("CLEO_JOB_DB")
    monkeypatch.setattr(jobs, "_db_path", lambda: "/tmp/cleo_jobs.db")
    cfg = client.get("/billing/config").json()
    assert cfg["enabled"] is False and cfg["reason"] == "db_not_persistent"


def test_config_without_auth(client):
    cfg = client.get("/billing/config").json()
    assert cfg["enabled"] is False and cfg["reason"] == "auth_disabled"
    assert [p["id"] for p in cfg["plans"]] == ["starter", "pro", "studio"]


# ── GET /me ──────────────────────────────────────────────────────────


def test_me_auth_off(client):
    assert client.get("/me").json() == {"auth_enabled": False}


def test_me_auth_only(client, auth_on, bearer):
    me = client.get("/me", headers=bearer()).json()
    assert me["auth_enabled"] is True
    assert me["user"] == {"id": "user_a", "email": None}
    assert me["billing"]["enabled"] is False
    assert me["plan"] is None and me["minutes"] is None
    assert me["subscription"] is None
    assert isinstance(me["media_token"], str)


def test_me_with_subscription(client, billing_on, bearer, probe):
    add_sub("sub_1", plan="pro", period_start=_ts("2026-09-10T00:00:00"),
            renews_at=_ts("2099-10-10T00:00:00"))
    billing_on.sub("sub_1")
    probe["seconds"] = 90
    _upload(client, bearer())
    me = client.get("/me", headers=bearer()).json()
    assert me["plan"] == "pro"
    assert me["subscription"] == {"status": "active", "plan": "pro",
                                  "renews_at": "2099-10-10T00:00:00Z",
                                  "ends_at": None, "test_mode": False}
    m = me["minutes"]
    assert (m["limit"], m["used"], m["remaining"]) == (300.0, 1.5, 298.5)
    assert m["period_start"] == "2026-09-10T00:00:00Z"
    assert m["period_end"] == "2026-10-10T00:00:00Z"
    assert me["billing"] == {"enabled": True, "enforce": False,
                             "test_mode": False}


def test_me_shows_lapsed_subscription(client, billing_on, bearer):
    add_sub("sub_1", status="expired")
    billing_on.sub("sub_1", status="expired")
    me = client.get("/me", headers=bearer()).json()
    assert me["plan"] is None and me["minutes"] is None
    assert me["subscription"]["status"] == "expired"


def test_me_refreshes_stale_subscription(client, billing_on, bearer):
    # Local: active, renewal date passed, last sync 2 h ago. LS: cancelled.
    add_sub("sub_1", renews_at=time.time() - 60)
    with accounts._lock:
        accounts._db().execute("UPDATE subscriptions SET updated_at = ?",
                               (accounts.ts(time.time() - 7200),))
    billing_on.sub("sub_1", status="cancelled",
                   ends_at="2000-01-01T00:00:00Z",
                   updated_at="2099-01-01T00:00:00Z")
    me = client.get("/me", headers=bearer()).json()
    assert ("GET", "/subscriptions/sub_1", None) in billing_on.calls
    assert me["plan"] is None
    assert me["subscription"]["status"] == "cancelled"


def test_me_refresh_backs_off_while_ls_is_down(client, billing_on, bearer):
    add_sub("sub_1", renews_at=time.time() - 60)
    add_sub("sub_2", plan="starter", renews_at=time.time() - 60)
    with accounts._lock:
        accounts._db().execute("UPDATE subscriptions SET updated_at = ?",
                               (accounts.ts(time.time() - 7200),))
    billing_on.down = True
    for _ in range(3):
        assert client.get("/me", headers=bearer()).status_code == 200
    fetches = [c for c in billing_on.calls if c[1].startswith("/subscriptions/")]
    # One attempt, and the outage stopped the loop before sub_2.
    assert len(fetches) == 1
    # Tried again once the back-off has passed.
    billing_on.down = False
    billing.refresh_user("user_a", now=time.time() + 301)
    fetches = [c for c in billing_on.calls if c[1].startswith("/subscriptions/")]
    assert len(fetches) >= 3


def test_latest_subscription_is_stable_across_resyncs(client, billing_on,
                                                      bearer):
    """The subscription /me shows is the newest by LS time, not by local
    sync time (every re-sync bumped that and flipped the order)."""
    t26, t25 = _ts("2026-03-01T00:00:00"), _ts("2025-06-01T00:00:00")
    add_sub("pro26", plan="pro", status="paused", created_at=t26,
            ls_updated_at=t26)
    add_sub("starter25", plan="starter", status="expired", created_at=t25,
            ls_updated_at=t25, ends_at=t25)
    billing_on.sub("pro26", status="paused",
                   created_at="2026-03-01T00:00:00Z",
                   updated_at="2026-03-01T00:00:00Z")
    billing_on.sub("starter25", status="expired", variant="111",
                   created_at="2025-06-01T00:00:00Z",
                   updated_at="2025-06-01T00:00:00Z")
    for _ in range(3):
        billing.reconcile()
        assert accounts.latest_subscription("user_a")["id"] == "pro26"
    me = client.get("/me", headers=bearer()).json()
    assert me["subscription"]["status"] == "paused"
    assert me["subscription"]["plan"] == "pro"


def test_me_comp(client, billing_on, bearer, monkeypatch):
    monkeypatch.setenv("CLEO_COMP_USERS", "user_a")
    me = client.get("/me", headers=bearer()).json()
    assert me["plan"] == "studio" and me["comp"] is True
    assert me["subscription"] is None
    assert me["minutes"]["limit"] == 900.0


def test_probe_duration(tmp_path):
    """Real ffprobe: a normal MP4, and a streamed WebM whose header has
    no duration (MediaRecorder) — the packet-scan fallback."""
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe not installed")
    mp4 = tmp_path / "a.mp4"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                    "testsrc=size=64x64:rate=10:duration=3", str(mp4)],
                   check=True)
    assert M._probe_duration(str(mp4)) == pytest.approx(3.0, abs=0.2)
    webm = tmp_path / "live.webm"
    # Piped output can't seek back to write the duration → like a
    # MediaRecorder recording.
    with open(webm, "wb") as out:
        subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i",
                        "testsrc=size=64x64:rate=10:duration=4",
                        "-c:v", "libvpx", "-f", "webm", "-"],
                       stdout=out, check=True)
    fmt = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0", str(webm)],
                         capture_output=True, text=True).stdout.strip()
    assert fmt in ("N/A", "")  # the case the fallback exists for
    assert M._probe_duration(str(webm)) == pytest.approx(3.9, abs=0.3)
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video")
    assert M._probe_duration(str(junk)) is None
