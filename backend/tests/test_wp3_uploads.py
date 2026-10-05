"""WP3: resumable multipart upload (POST /uploads/multipart/*): part
sizing, the stateless ticket, signing, ListParts reconcile, complete
(parts check, size check, idempotent), abort, the refusals in presign's
order, the single-PUT kill switch and the telemetry endpoint. R2 is moto
in-process (parts go up with boto3 here; the HTTP-PUT flow through
presigned URLs is in test_wp3_http.py)."""
from __future__ import annotations

import base64
import json
import time
from urllib.parse import parse_qs, urlsplit

import pytest

import backend.main as M
from backend import storage
from backend import uploads as upl
from conftest import add_sub

MIB = 1024 * 1024


@pytest.fixture(autouse=True)
def upload_state(monkeypatch):
    for k in ("CLEO_MAX_UPLOAD_GB", "CLEO_MAX_MINUTES", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_MAX_ANALYZE"):
        monkeypatch.delenv(k, raising=False)
    # Sizes up to 4 GB without 14 GB of free disk here.
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    # Multipart is opt-in (default: single PUT, 409 use_single_put).
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    M._resume_window.clear()
    yield
    M._resume_window.clear()
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


def _init(client, size, headers=None, **extra):
    return client.post("/uploads/multipart/init", headers=headers or {},
                       json={"filename": "Clip.MOV",
                             "content_type": "video/quicktime",
                             "size": size, **extra})


def _put(r2, t, n, nbytes):
    """Upload part n of the ticket's upload (as the browser would)."""
    claims = json.loads(base64.urlsafe_b64decode(
        t.split(".")[0] + "=" * (-len(t.split(".")[0]) % 4)))
    r2.upload_part(Bucket=storage.bucket(), Key=claims["k"],
                   UploadId=claims["id"], PartNumber=n, Body=b"p" * nbytes)
    return claims


# ── part sizing ──────────────────────────────────────────────────────


@pytest.mark.parametrize("size,ps,n,last", [
    (1, 16 * MIB, 1, 1),
    (16 * MIB, 16 * MIB, 1, 16 * MIB),
    (16 * MIB + 1, 16 * MIB, 2, 1),
    (4_000_000_000, 16 * MIB, 239, 4_000_000_000 - 238 * 16 * MIB),
    # > 9,500 parts at 16 MiB: the part size grows (R2 allows 10,000).
    (9500 * 16 * MIB + 1, 17 * MIB, 8942, (9500 * 16 * MIB + 1) - 8941 * 17 * MIB),
    (200_000_000_000, 21 * MIB, 9083, 200_000_000_000 - 9082 * 21 * MIB),
])
def test_part_sizing(size, ps, n, last):
    assert upl.part_plan(size) == (ps, n)
    assert n <= 9500
    assert upl.part_length(size, ps, n, n) == last
    assert 0 < last <= ps
    if n > 1:
        assert upl.part_length(size, ps, n, 1) == ps


# ── init / sign ──────────────────────────────────────────────────────


def test_init_signs_the_first_parts_with_their_exact_length(client, r2,
                                                           monkeypatch):
    signed = []
    real = storage.mpu_sign

    def spy(key, upload_id, n, size, expires_in=21600):
        signed.append((n, size, expires_in))
        return real(key, upload_id, n, size, expires_in)
    monkeypatch.setattr(storage, "mpu_sign", spy)
    size = 40 * MIB + 7
    r = _init(client, size)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["part_size"] == 16 * MIB and body["parts_total"] == 3
    assert body["storage_key"].startswith("uploads/")
    assert body["storage_key"].endswith(".mov")
    assert abs(body["expires_at"] - (time.time() + M._upload_ttl_s())) < 60
    assert [p["part_number"] for p in body["parts"]] == [1, 2, 3]
    assert [(n, s) for n, s, _ in signed] == [
        (1, 16 * MIB), (2, 16 * MIB), (3, 8 * MIB + 7)]
    assert all(e == 6 * 3600 for _, _, e in signed)
    for p in body["parts"]:
        q = parse_qs(urlsplit(p["url"]).query)
        assert "content-length" in q["X-Amz-SignedHeaders"][0].split(";")
        assert q["partNumber"] == [str(p["part_number"])]
    # The multipart upload is open, with the whitelisted content type.
    ups = r2.list_multipart_uploads(Bucket=storage.bucket())["Uploads"]
    assert [u["Key"] for u in ups] == [body["storage_key"]]


def test_init_signs_at_most_8_and_sign_checks_numbers(client, r2):
    body = _init(client, 200 * MIB).json()
    assert body["parts_total"] == 13 and len(body["parts"]) == 8
    t = body["ticket"]
    r = client.post("/uploads/multipart/sign",
                    json={"ticket": t, "part_numbers": [9, 13, 9]})
    assert r.status_code == 200
    assert [p["part_number"] for p in r.json()["parts"]] == [9, 13]
    for bad in ([0], [14], [], list(range(1, 66)), ["1"], [True], [1.5], "1"):
        r = client.post("/uploads/multipart/sign",
                        json={"ticket": t, "part_numbers": bad})
        assert r.status_code == 400, bad
        assert r.json()["detail"] == "bad_part_numbers"


def test_upload_content_type_whitelist(client, r2):
    for sent, stored in (("video/mp4", "video/mp4"),
                         ("text/html", "application/octet-stream"),
                         ("", "application/octet-stream"),
                         ("video/x-matroska", "video/x-matroska")):
        body = client.post("/uploads/multipart/init", json={
            "filename": "a.exe", "content_type": sent, "size": 10}).json()
        assert body["storage_key"].endswith(".mp4")   # ext whitelisted too
        _put(r2, body["ticket"], 1, 10)
        assert client.post("/uploads/multipart/complete", json={
            "ticket": body["ticket"]}).status_code == 200
        head = r2.head_object(Bucket=storage.bucket(), Key=body["storage_key"])
        assert head["ContentType"] == stored


# ── tickets ──────────────────────────────────────────────────────────


def test_ticket_tamper_expiry_and_other_users(client, r2, auth_on, bearer,
                                              monkeypatch):
    body = _init(client, 20 * MIB, headers=bearer("user_a")).json()
    assert body["storage_key"].startswith("uploads/user_a/")
    t = body["ticket"]
    ok = {"ticket": t, "part_numbers": [1]}
    assert client.post("/uploads/multipart/sign", json=ok,
                       headers=bearer("user_a")).status_code == 200
    payload, sig = t.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    forged = dict(claims, s=claims["s"] * 2)
    forged_payload = base64.urlsafe_b64encode(
        json.dumps(forged).encode()).decode().rstrip("=")
    for bad in (f"{forged_payload}.{sig}", f"{payload}.{'0' * 64}",
                f"{payload}x.{sig}", "nonsense", None, 7):
        r = client.post("/uploads/multipart/parts", json={"ticket": bad},
                        headers=bearer("user_a"))
        assert (r.status_code, r.json()) == (403, {"detail": "bad_ticket", "code": "bad_ticket", "params": {}})
    # Someone else's ticket.
    for path in ("sign", "parts", "complete", "abort"):
        r = client.post(f"/uploads/multipart/{path}", json=ok,
                        headers=bearer("user_b"))
        assert (r.status_code, r.json()) == (403, {"detail": "bad_ticket", "code": "bad_ticket", "params": {}})
    # Expired (23 h): the same claims, signed with the real key.
    expired = upl.make_ticket(M._ticket_secret(),
                              dict(claims, exp=int(time.time()) - 1))
    for path in ("sign", "parts", "complete", "abort"):
        r = client.post(f"/uploads/multipart/{path}",
                        json={"ticket": expired, "part_numbers": [1]},
                        headers=bearer("user_a"))
        assert (r.status_code, r.json()) == (410,
                                             {"detail": "upload_expired", "code": "upload_expired", "params": {}})


def test_ticket_unit():
    t = upl.make_ticket("k1", {"u": "a", "k": "uploads/a/x.mp4", "id": "i",
                               "s": 5, "ps": 16 * MIB, "n": 1, "ct": "v",
                               "exp": 100})
    assert upl.read_ticket("k1", t, "a", now=99)["s"] == 5
    with pytest.raises(upl.TicketError) as e:
        upl.read_ticket("k2", t, "a", now=99)
    assert (e.value.status, e.value.code) == (403, "bad_ticket")
    with pytest.raises(upl.TicketError) as e:
        upl.read_ticket("k1", t, "b", now=99)
    assert e.value.status == 403
    with pytest.raises(upl.TicketError) as e:
        upl.read_ticket("k1", t, "a", now=100)
    assert (e.value.status, e.value.code) == (410, "upload_expired")


# ── how long an upload can be resumed ────────────────────────────────


OLD_RULES = [  # the bucket rules of before (2026-10): 2 d / 1 d
    {"ID": "uploads-expire-2d", "Status": "Enabled",
     "Filter": {"Prefix": "uploads/"}, "Expiration": {"Days": 2}},
    {"ID": "uploads-abort-mpu-1d", "Status": "Enabled",
     "Filter": {"Prefix": "uploads/"},
     "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]


def test_resume_window_unit():
    H, D = 3600, 86400
    assert upl.resume_window_s(False, 8, 9) == 23 * H        # rules unknown
    assert upl.resume_window_s(True, 1, 2) == 23 * H         # old rules
    assert upl.resume_window_s(True, 8, 9) == 7 * D          # new rules
    assert upl.resume_window_s(True, None, None) == 7 * D    # nothing aborts
    assert upl.resume_window_s(True, 30, 3) == 2 * D         # expiry first
    assert upl.resume_window_s(True, 3, 30) == 3 * D - H
    assert upl.resume_window_s(True, None, 1) == H           # at least 1 h
    from backend import r2_setup
    assert r2_setup.uploads_retention_days(OLD_RULES) == (1, 2)
    assert r2_setup.uploads_retention_days(
        r2_setup.lifecycle_config()["Rules"]) == (8, 9)
    off = [dict(r, Status="Disabled") for r in OLD_RULES]
    assert r2_setup.uploads_retention_days(off) == (None, None)
    # The rules this repo sets keep a resume for 7 days — and pass the
    # check.
    assert r2_setup.lifecycle_problems(
        r2_setup.lifecycle_config()["Rules"]) == []


def test_ticket_never_outlives_the_bucket_rules(client, r2, monkeypatch):
    """The ticket — and the browser's resume record, which keeps its
    expires_at — ends before R2 aborts the upload: 23 h with the old
    rules or rules that can't be read, 7 days with the new ones."""
    from backend import r2_setup
    D = 86400

    def ttl():
        M._resume_window.clear()
        body = _init(client, 20 * MIB).json()
        return body["expires_at"] - time.time()

    try:
        r2.put_bucket_lifecycle_configuration(
            Bucket=storage.bucket(),
            LifecycleConfiguration={"Rules": OLD_RULES})
        assert abs(ttl() - 23 * 3600) < 60
        r2.put_bucket_lifecycle_configuration(
            Bucket=storage.bucket(),
            LifecycleConfiguration=r2_setup.lifecycle_config())
        assert abs(ttl() - 7 * D) < 60
        # A ticket of day 6 still works; R2 still has the parts.
        t = _init(client, 20 * MIB).json()["ticket"]
        claims = upl.read_ticket(M._ticket_secret(), t, "",
                                 now=time.time() + 6 * D)
        assert claims["exp"] > time.time() + 6.9 * D
        # Read once, then cached (6 h): no lifecycle call per init.
        calls = []
        real = storage._client

        class Spy:
            def __init__(self, c):
                self._c = c

            def __getattr__(self, name):
                if name == "get_bucket_lifecycle_configuration":
                    calls.append(name)
                return getattr(self._c, name)
        monkeypatch.setattr(storage, "_client", lambda: Spy(real()))
        for _ in range(3):
            assert _init(client, 20 * MIB).status_code == 200
        assert calls == []
        # Rules the token may not read: 23 h, as before.
        M._resume_window.clear()

        class Denied(Spy):
            def get_bucket_lifecycle_configuration(self, **kw):
                raise RuntimeError("AccessDenied")
        monkeypatch.setattr(storage, "_client", lambda: Denied(real()))
        body = _init(client, 20 * MIB).json()
        assert abs(body["expires_at"] - time.time() - 23 * 3600) < 60
    finally:
        r2.delete_bucket_lifecycle(Bucket=storage.bucket())


# ── parts / complete / abort ─────────────────────────────────────────


def test_resume_reconciles_with_list_parts(client, r2):
    body = _init(client, 40 * MIB).json()
    t = body["ticket"]
    _put(r2, t, 2, 16 * MIB)
    r = client.post("/uploads/multipart/parts", json={"ticket": t})
    assert r.json() == {"parts": [{"part_number": 2, "size": 16 * MIB}]}


def test_complete_checks_parts_and_is_idempotent(client, r2):
    size = 16 * MIB + 100
    body = _init(client, size).json()
    t, key = body["ticket"], body["storage_key"]
    _put(r2, t, 1, 16 * MIB)
    r = client.post("/uploads/multipart/complete", json={"ticket": t})
    assert (r.status_code, r.json()) == (409, {"detail": "parts_missing",
                                               "missing": [2], "code": "parts_missing",
                                               "params": {"missing": [2]}})
    _put(r2, t, 2, 99)                      # wrong length counts as missing
    r = client.post("/uploads/multipart/complete", json={"ticket": t})
    assert (r.status_code, r.json()["missing"]) == (409, [2])
    _put(r2, t, 2, 100)                     # re-upload replaces the part
    r = client.post("/uploads/multipart/complete", json={"ticket": t})
    assert (r.status_code, r.json()) == (200, {"storage_key": key,
                                               "size": size})
    assert storage.head(key) == size
    # Repeated (the answer got lost): same answer, and parts says done.
    r = client.post("/uploads/multipart/complete", json={"ticket": t})
    assert (r.status_code, r.json()) == (200, {"storage_key": key,
                                               "size": size})
    r = client.post("/uploads/multipart/parts", json={"ticket": t})
    assert r.json()["completed"] is True
    assert [p["size"] for p in r.json()["parts"]] == [16 * MIB, 100]


def test_missing_list_is_capped_at_100(client, r2):
    body = _init(client, 150 * 16 * MIB).json()
    r = client.post("/uploads/multipart/complete",
                    json={"ticket": body["ticket"]})
    assert r.status_code == 409 and r.json()["missing"] == list(range(1, 101))


def test_complete_over_the_cap_or_wrong_size_deletes_the_object(
        client, r2, monkeypatch):
    body = _init(client, 100).json()
    _put(r2, body["ticket"], 1, 100)
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", str(50 / 1e9))   # cap lowered
    r = client.post("/uploads/multipart/complete",
                    json={"ticket": body["ticket"]})
    assert r.status_code == 413 and r.json()["detail"] == "file_too_large"
    assert storage.head(body["storage_key"]) is None
    monkeypatch.delenv("CLEO_MAX_UPLOAD_GB")
    body = _init(client, 100).json()
    _put(r2, body["ticket"], 1, 100)
    real = M._completed_size
    # HEAD after completing reports another size than announced.
    monkeypatch.setattr(M, "_completed_size", lambda t: real(t) + 1)
    r = client.post("/uploads/multipart/complete",
                    json={"ticket": body["ticket"]})
    assert r.status_code == 413
    assert storage.head(body["storage_key"]) is None


def test_abort_is_idempotent(client, r2):
    body = _init(client, 10).json()
    for _ in range(2):
        r = client.post("/uploads/multipart/abort",
                        json={"ticket": body["ticket"]})
        assert r.status_code == 204
    assert not r2.list_multipart_uploads(
        Bucket=storage.bucket()).get("Uploads")
    r = client.post("/uploads/multipart/parts", json={"ticket": body["ticket"]})
    assert (r.status_code, r.json()) == (410, {"detail": "upload_expired", "code": "upload_expired", "params": {}})
    r = client.post("/uploads/multipart/complete",
                    json={"ticket": body["ticket"]})
    assert r.status_code == 410


# ── refusals (presign's order) and the kill switch ───────────────────


def test_init_refusals_in_presign_order(client, r2, enforce, bearer,
                                       monkeypatch):
    h = bearer()
    r = _init(client, 10 * 1e9, headers=h)             # 402 before 413
    assert r.status_code == 402
    assert r.json()["detail"]["code"] == "subscription_required"
    add_sub(plan="starter", period_start=time.time() - 60)
    r = _init(client, 10, headers=h, duration=6000)
    assert r.json()["detail"]["code"] == "quota_exceeded"
    for size in (0, -5, 4.1e9):
        r = _init(client, size, headers=h)
        assert (r.status_code, r.json()) == (
            413, {"detail": "file_too_large", "max_gb": 4, "code": "file_too_large", "params": {"max_gb": 4}})
    monkeypatch.setenv("CLEO_MAX_MINUTES", "1")
    r = _init(client, 10, headers=h, duration=120)
    assert (r.status_code, r.json()) == (
        413, {"detail": "video_too_long", "max_minutes": 1, "code": "video_too_long", "params": {"max_minutes": 1}})
    monkeypatch.delenv("CLEO_MAX_MINUTES")
    monkeypatch.setenv("CLEO_MAX_ACTIVE_PER_USER", "0")
    monkeypatch.setenv("CLEO_MAX_QUEUE", "-2")
    r = _init(client, 10, headers=h, duration=10)
    assert r.status_code == 503 and r.json() == {"detail": "server_busy", "code": "server_busy", "params": {}}
    assert r.headers["retry-after"] == "120"
    monkeypatch.setenv("CLEO_MAX_QUEUE", "20")
    monkeypatch.setenv("CLEO_DISK_FACTOR", "1e12")
    # (with a length the need is the realistic one — test_capacity.py)
    monkeypatch.setenv("CLEO_DISK_MEZZ_MBPS", "1e12")
    r = _init(client, 10, headers=h, duration=10)
    assert (r.status_code, r.json()) == (507, {"detail": "server_storage_full", "code": "server_storage_full", "params": {}})
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    assert _init(client, 10, headers=h, duration=10).status_code == 200
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "single")
    r = _init(client, 10, headers=h, duration=10)
    assert (r.status_code, r.json()) == (409, {"detail": "use_single_put", "code": "use_single_put", "params": {}})


@pytest.mark.wp1_only("fills _INFLIGHT by hand; ported: test_wp4_queue.py::test_presign_per_user_limit_from_the_database")
def test_init_per_user_limit(client, r2, auth_on, bearer, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_ACTIVE_PER_USER", "1")
    import threading
    ev = threading.Event()
    t = threading.Thread(target=ev.wait, daemon=True)
    t.start()
    try:
        M._INFLIGHT.track("busyjob00001", "user_a", "analyze", t)
        r = _init(client, 10, headers=bearer("user_a"))
        assert (r.status_code, r.json()) == (429,
                                             {"detail": "too_many_active_jobs", "code": "too_many_active_jobs", "params": {}})
        assert _init(client, 10, headers=bearer("user_b")).status_code == 200
    finally:
        ev.set()


def test_init_without_r2_is_503_not_busy(client, no_r2):
    r = _init(client, 10)
    assert r.status_code == 503 and r.json()["detail"] != "server_busy"


# ── telemetry ────────────────────────────────────────────────────────


def test_telemetry_logs_one_line_without_the_ticket(client, r2, capsys):
    t = _init(client, 10).json()["ticket"]
    r = client.post("/uploads/telemetry", json={
        "ticket": t, "event": "part_retry", "part": 2, "attempt": 3,
        "elapsed_ms": 60012, "loaded": 1234, "ua": "Mozilla/5.0 (iPhone)",
        "junk": "x" * 100})
    assert r.status_code == 204
    out = capsys.readouterr().out
    line = [ln for ln in out.splitlines() if ln.startswith("[upload]")][-1]
    assert "event=part_retry part=2 attempt=3 elapsed_ms=60012" in line
    assert "user=-" in line and "iPhone" in line and "obj=" in line
    assert t not in out and t.split(".")[1] not in out and "junk" not in line
    r = client.post("/uploads/telemetry", content=b"{" + b" " * 3000 + b"}",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert client.post("/uploads/telemetry", json={"x": 1}).status_code == 400


def test_telemetry_is_rate_limited_per_user(client, auth_on, bearer,
                                            monkeypatch):
    monkeypatch.setattr(M, "_TELEMETRY", upl.RateLimit(30, 60.0))
    codes = [client.post("/uploads/telemetry", json={"event": "e"},
                         headers=bearer("user_a")).status_code
             for _ in range(31)]
    assert codes == [204] * 30 + [429]
    assert client.post("/uploads/telemetry", json={"event": "e"},
                       headers=bearer("user_b")).status_code == 204
