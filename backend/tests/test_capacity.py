"""Upload capacity (Oct 2026 incident: a 10-minute iPhone video refused
with "servers are busy"): the disk reservation sized by what the
analysis really writes, the proxy cache giving way to an upload,
upload_refused events for every refusal of the upload routes, GET
/admin/capacity, no leaked _Inflight upload entries (finally + TTL
sweep) and multipart inits that count only real new uploads."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.main as M
from backend import storage
from backend.jobs import store

GB = 1e9


@pytest.fixture(autouse=True)
def capacity_state(monkeypatch):
    for k in ("CLEO_DISK_FACTOR", "CLEO_DISK_MEZZ_MBPS",
              "CLEO_DISK_PREVIEW_MBPS", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_UPLOAD_INITS_PER_HOUR",
              "CLEO_UPLOAD_ENTRY_TTL_S", "CLEO_MAX_UPLOAD_GB",
              "CLEO_MAX_MINUTES"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 1 * GB)
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    yield
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


class FakeDisk:
    """shutil.disk_usage of CLEO_TMP_ROOT: a volume of `total` bytes
    with `free` free — minus what the proxy cache holds beyond what it
    held at the start (so deleting cached proxies frees room)."""

    def __init__(self, monkeypatch, total: float, free: float) -> None:
        self.total, self.free = total, free
        self.cache0 = M._proxy_cache_bytes()
        real = M.shutil.disk_usage

        def usage(path):
            free_now = self.free + (self.cache0 - M._proxy_cache_bytes())
            return real(path)._replace(total=int(self.total),
                                       free=int(free_now),
                                       used=int(self.total - free_now))
        monkeypatch.setattr(M.shutil, "disk_usage", usage)


@pytest.fixture
def fake_r2(monkeypatch, r2):
    """R2 uploads of state["size"] bytes (HEAD faked), the header probe
    answering state["seconds"]."""
    state = {"size": 1000, "seconds": 600.0}
    real_size = M.media.size
    monkeypatch.setattr(M.media, "size", lambda key, **kw: (
        state["size"] if key.startswith("uploads/") else real_size(key, **kw)))
    monkeypatch.setattr(M.media, "get_file",
                        lambda key, path, **kw: Path(path).write_bytes(b"v"))
    monkeypatch.setattr(M, "_probe_remote",
                        lambda url: (state["seconds"], True, True))
    return state


def _events():
    return [e["data"] for e in store.events(0, kinds=["upload_refused"])]


def _init(client, size, headers=None, **extra):
    return client.post("/uploads/multipart/init", headers=headers or {},
                       json={"filename": "IMG_0001.MOV",
                             "content_type": "video/quicktime",
                             "size": size, **extra})


# ── the reservation: what the analysis really writes ─────────────────


def test_disk_need_without_a_length_is_the_old_factor():
    assert M._disk_need(2 * GB) == pytest.approx(7 * GB)
    assert M._disk_need(2 * GB, None) == M._disk_need(2 * GB, 0)
    assert M._disk_need(2 * GB, float("nan")) == pytest.approx(7 * GB)


def test_disk_need_from_length_and_resolution(monkeypatch):
    ten_min = 600
    mezz = 600 * 40e6 / 8            # 3 GB: the 1080p mezz ceiling
    small = 600 * 10e6 / 8           # 0.75 GB: proxy + preview
    # The incident: a 4 GB 4K HEVC iPhone clip of 10 minutes. The mezz
    # (1080p) is far smaller than the upload: 4 + 3 + 0.75, not 14.
    assert M._disk_need(4 * GB, ten_min) == pytest.approx(4 * GB + mezz + small)
    # SmartCam keeps a second mezz next to the first (the source is gone
    # by then): max(S, M) + M.
    assert M._disk_need(1 * GB, ten_min, smartcam=True) == pytest.approx(
        min(3.5 * GB, mezz + mezz + small))
    assert M._disk_need(2.5 * GB, ten_min, smartcam=False) == pytest.approx(
        2.5 * GB + mezz + small)
    assert M._disk_need(2.5 * GB, ten_min, smartcam=True) == pytest.approx(
        3 * GB + mezz + small)
    # Never more than the old estimate (small low-bitrate uploads).
    assert M._disk_need(0.2 * GB, ten_min) == pytest.approx(0.7 * GB)
    # A 4K job keeps a 4K mezz: four times the pixels.
    assert M._disk_need(4 * GB, ten_min, "2160", smartcam=False) == \
        pytest.approx(min(14 * GB, 4 * GB + 4 * mezz + small))
    # Tunable; CLEO_DISK_FACTOR=0 still turns the check off.
    monkeypatch.setenv("CLEO_DISK_MEZZ_MBPS", "20")
    assert M._disk_need(4 * GB, ten_min, smartcam=False) == pytest.approx(
        4 * GB + mezz / 2 + small)
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    assert M._disk_need(4 * GB, ten_min) == 0


def test_the_mezz_ceiling_covers_the_measured_encodes():
    """The 1080p mezz bitrates measured with _normalize_orientation (see
    the comment above _disk_need) stay under the ceiling — except the
    pathological pure-noise clip, which the SmartCam term and the 1 GB
    floor still cover."""
    ceiling = M._env_float("CLEO_DISK_MEZZ_MBPS", 40)
    for measured in (9.3, 11.2, 15.2, 15.7):
        assert measured * 2 <= ceiling
    s, m = 33 / 8 * 600, 45 / 8 * 600   # MB of a 10-min noise clip
    peak_mb = s + m                     # normalize, no SmartCam
    assert peak_mb * 1e6 <= M._disk_need(s * 1e6, 600, smartcam=True) \
        + M._MIN_FREE_BYTES


def test_a_10_gb_volume_takes_the_incident_upload(monkeypatch):
    """10 GB volume, 9.5 GB free: a 4 GB / 10-minute upload was refused
    (3.5 × 4 + 1 = 15 GB); now it needs 8.75 GB and fits. A second one
    in parallel doesn't (the first one's reservation counts)."""
    FakeDisk(monkeypatch, total=10 * GB, free=9.5 * GB)
    with pytest.raises(M.HTTPException) as e:
        M._INFLIGHT.reserve_disk(None, 4 * GB)          # length unknown
    assert e.value.status_code == 507
    assert isinstance(e.value, M.DiskRefusal)
    assert (e.value.free, e.value.need) == (9.5 * GB, pytest.approx(14 * GB))
    t1 = M._INFLIGHT.admit(None)
    M._INFLIGHT.reserve_disk(t1, 4 * GB, None, seconds=600)
    t2 = M._INFLIGHT.admit(None)
    with pytest.raises(M.DiskRefusal) as e:
        M._INFLIGHT.reserve_disk(t2, 4 * GB, None, seconds=600)
    assert e.value.reserved == pytest.approx(7.75 * GB)
    M._INFLIGHT.release(t1)
    M._INFLIGHT.reserve_disk(t2, 4 * GB, None, seconds=600)
    M._INFLIGHT.release(t2)


def test_the_proxy_cache_gives_way_to_an_upload(monkeypatch):
    cache = M._proxy_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    for i, n in enumerate((3000, 2000, 1000)):     # oldest first
        p = cache / f"job{i}.mp4"
        p.write_bytes(b"x" * n)
        t = time.time() - 100 + i
        import os
        os.utime(p, (t, t))
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 0.0)
    disk = FakeDisk(monkeypatch, total=1e6, free=10_000)
    monkeypatch.setenv("CLEO_DISK_FACTOR", "1")
    # 12,500 needed, 10,000 free: the oldest cached proxy (3000) is
    # enough — only it goes.
    M._INFLIGHT.reserve_disk(None, 12_500)
    assert sorted(p.name for p in cache.glob("*.mp4")) == ["job1.mp4",
                                                          "job2.mp4"]
    # More than the whole cache: nothing is deleted, 507.
    disk.free = 0
    with pytest.raises(M.DiskRefusal):
        M._INFLIGHT.reserve_disk(None, 100_000)
    assert len(list(cache.glob("*.mp4"))) == 2


@pytest.mark.wp1_only("the in-process reservation of POST /jobs")
def test_post_jobs_reserves_by_the_probed_length(client, fake_r2,
                                                  monkeypatch):
    FakeDisk(monkeypatch, total=10 * GB, free=9.5 * GB)
    fake_r2["size"], fake_r2["seconds"] = 4 * GB, 600.0
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "uploads/a.mov"})
    assert r.status_code == 200, r.text
    # 4K requested: a 4K mezz doesn't fit — 507, and it is recorded.
    r = client.post("/jobs", data={"settings": '{"resolution": "2160"}',
                                   "storage_key": "uploads/b.mov"})
    assert r.status_code == 507
    assert r.json() == {"detail": "server_storage_full",
                        "code": "server_storage_full", "params": {}}
    [ev] = _events()
    assert ev["where"] == "jobs" and ev["code"] == "server_storage_full"
    assert (ev["size_gb"], ev["seconds"], ev["free_gb"]) == (4.0, 600.0, 9.5)
    assert ev["need_gb"] > 9


# ── upload_refused events ────────────────────────────────────────────


@pytest.mark.wp1_only("the in-process disk check of multipart init")
def test_init_refusal_is_recorded_with_the_numbers(client, r2, auth_on,
                                                    bearer, monkeypatch):
    FakeDisk(monkeypatch, total=10 * GB, free=6 * GB)
    r = _init(client, 2 * GB, headers=bearer("user_owner"))
    assert r.status_code == 507
    [ev] = _events()
    assert {k: ev[k] for k in ("where", "code", "status", "size_gb",
                               "free_gb", "need_gb", "reserved_gb",
                               "n_upload", "n_analyze", "n_render")} == {
        "where": "init", "code": "server_storage_full", "status": 507,
        "size_gb": 2.0, "free_gb": 6.0, "need_gb": 7.0, "reserved_gb": 0.0,
        "n_upload": 0, "n_analyze": 0, "n_render": 0}
    # Identity only as a keyed hash, stable per user.
    assert len(ev["who"]) == 12 and "user_owner" not in str(ev)
    _init(client, 2 * GB, headers=bearer("user_owner"))
    _init(client, 2 * GB, headers=bearer("user_other"))
    who = [e["who"] for e in _events()]
    assert who[0] == who[1] != who[2]
    # With the browser's reading of the length it fits.
    assert _init(client, 2 * GB, headers=bearer("user_owner"),
                 duration=120).status_code == 200
    assert len(_events()) == 3


def test_refusals_of_every_upload_route_are_recorded(client, r2, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "1")
    assert client.post("/uploads/presign",
                       json={"size": 2 * GB}).status_code == 413
    assert _init(client, 2 * GB).status_code == 413
    assert client.post("/uploads/multipart/sign",
                       json={"ticket": "x.y", "part_numbers": [1]}
                       ).status_code == 403
    assert client.post("/uploads/multipart/complete",
                       json={"ticket": "x.y"}).status_code == 403
    assert client.post("/jobs", data={"settings": "nope"}).status_code == 400
    got = [(e["where"], e["code"], e["status"]) for e in _events()]
    assert got == [("presign", "file_too_large", 413),
                   ("init", "file_too_large", 413),
                   ("sign", "bad_ticket", 403),
                   ("complete", "bad_ticket", 403),
                   ("jobs", "invalid_payload", 400)]
    assert _events()[0]["size_gb"] == 2.0


def test_protocol_answers_are_not_refusals(client, r2, monkeypatch):
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "single")
    assert _init(client, 1000).status_code == 409   # use_single_put
    assert _events() == []


def test_refusal_events_are_capped(client, r2, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "1")
    monkeypatch.setattr(M._REFUSAL_EVENTS, "limit", 2)
    for _ in range(5):
        assert _init(client, 2 * GB).status_code == 413
    assert len(_events()) == 2


# ── no leaked upload entries ─────────────────────────────────────────


@pytest.mark.wp1_only("_Inflight upload entries of POST /jobs")
def test_post_jobs_releases_its_entry_on_every_outcome(fake_r2, monkeypatch):
    client = TestClient(M.app, raise_server_exceptions=False)
    FakeDisk(monkeypatch, total=10 * GB, free=1.5 * GB)
    fake_r2["size"] = 2 * GB
    assert client.post("/jobs", data={"settings": "{}", "storage_key":
                                      "uploads/a.mov"}).status_code == 507

    def boom(key):
        raise RuntimeError("probe pool broke")
    monkeypatch.setattr(M, "_probe_upload", boom)
    assert client.post("/jobs", data={"settings": "{}", "storage_key":
                                      "uploads/b.mov"}).status_code == 500
    assert M._INFLIGHT.snapshot() == []


def test_stale_thread_less_entries_are_swept(monkeypatch):
    """An upload entry nothing released any more (it would hold the
    queue cap and its disk reservation until a restart) drops out after
    CLEO_UPLOAD_ENTRY_TTL_S; live ones and worker threads stay."""
    monkeypatch.setenv("CLEO_MAX_QUEUE", "1")
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "1")
    old = M._INFLIGHT.admit(None)
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries[old]["at"] -= 7201
        M._INFLIGHT._entries[old]["need"] = 50 * GB
    ev = threading.Event()
    worker = threading.Thread(target=ev.wait, daemon=True)
    worker.start()
    try:
        with M._INFLIGHT._lock:
            M._INFLIGHT._entries["oldjob"] = {
                **M._INFLIGHT._entry(None, "analyze"), "thread": worker,
                "at": time.monotonic() - 99_999}
        fresh = M._INFLIGHT.admit(None)
        kinds = sorted((e["kind"], e["has_thread"])
                       for e in M._INFLIGHT.snapshot())
        assert kinds == [("analyze", True), ("upload", False)]
        assert M._INFLIGHT.counts()["reserved_gb"] == 0
        M._INFLIGHT.release(fresh)
        # 0 = never swept.
        monkeypatch.setenv("CLEO_UPLOAD_ENTRY_TTL_S", "0")
        kept = M._INFLIGHT.admit(None)
        with M._INFLIGHT._lock:
            M._INFLIGHT._entries[kept]["at"] -= 10 ** 6
        assert len(M._INFLIGHT.snapshot()) == 2
    finally:
        ev.set()


# ── multipart inits ──────────────────────────────────────────────────


def test_resume_and_retry_dont_spend_inits(client, r2, auth_on, bearer,
                                           monkeypatch):
    """One init per new upload: a resume (/parts with the saved ticket),
    re-signing parts and a complete that is retried never count; an
    init that fails at R2 is taken back. The default is 60 an hour."""
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    assert M._init_limit() == 60
    h = bearer()
    r = _init(client, 40 * 1024 * 1024, headers=h)
    assert r.status_code == 200
    ticket = r.json()["ticket"]
    for _ in range(5):
        assert client.post("/uploads/multipart/parts", headers=h,
                           json={"ticket": ticket}).status_code == 200
        assert client.post("/uploads/multipart/sign", headers=h,
                           json={"ticket": ticket, "part_numbers": [1, 2]}
                           ).status_code == 200
        assert client.post("/uploads/multipart/complete", headers=h,
                           json={"ticket": ticket}).status_code == 409
    assert M._INIT_RATE.stats() == {"keys": 1, "events": 1, "max_per_key": 1}
    # R2 fails to open the upload: 502, not counted.
    monkeypatch.setattr(storage, "mpu_create",
                        lambda key, ct: (_ for _ in ()).throw(OSError("down")))
    assert _init(client, 1000, headers=h).status_code == 502
    assert M._INIT_RATE.stats()["events"] == 1


def test_rate_limit_refund_and_stats():
    from backend import uploads as upl
    rl = upl.RateLimit(2, 60.0)
    assert rl.allow("a", now=0) and rl.allow("a", now=1)
    assert not rl.allow("a", now=2)
    rl.refund("a")
    assert rl.allow("a", now=3)
    rl.refund("nobody")
    assert rl.stats(now=30) == {"keys": 1, "events": 2, "max_per_key": 2}
    assert rl.stats(now=62) == {"keys": 1, "events": 1, "max_per_key": 1}


# ── GET /admin/capacity ──────────────────────────────────────────────


def test_admin_capacity_needs_the_admin_token(client, monkeypatch):
    assert client.get("/admin/capacity").status_code == 404
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    assert client.get("/admin/capacity").status_code == 401
    assert client.get("/admin/capacity",
                      headers={"X-Admin-Token": "nope"}).status_code == 401


def test_admin_capacity_report(client, r2, auth_on, bearer, monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "1")
    FakeDisk(monkeypatch, total=10 * GB, free=9.5 * GB)
    for _ in range(3):
        _init(client, 2 * GB, headers=bearer("user_owner"))
    tok = M._INFLIGHT.admit(None)
    try:
        r = client.get("/admin/capacity", headers={"X-Admin-Token": "s3cret"})
    finally:
        M._INFLIGHT.release(tok)
    assert r.status_code == 200
    body = r.json()
    assert body["tmp_root"]["total_gb"] == 10.0
    assert body["tmp_root"]["free_gb"] == 9.5
    assert body["inflight"]["n_upload"] == 1
    [entry] = body["inflight"]["entries"]
    assert entry["kind"] == "upload" and entry["has_thread"] is False
    assert body["limits"]["CLEO_DISK_FACTOR"] == 3.5
    assert body["limits"]["CLEO_UPLOAD_INITS_PER_HOUR"] == 60
    assert body["limits"]["CLEO_MAX_UPLOAD_GB"] == 1
    assert body["init_rate"]["limit_per_hour"] == 60
    fits = {f["size_gb"]: f["fits"] for f in body["fits_now"]}
    assert fits[0.5] and fits[4]          # 8.5 GB room, 4 GB needs 7.75
    assert body["refusals"]["by_code"]["24h"] == {"file_too_large": 3}
    recent = body["refusals"]["recent"]
    assert len(recent) == 3 and recent[0]["code"] == "file_too_large"
    assert recent[0]["where"] == "init" and recent[0]["size_gb"] == 2.0
    assert "user_owner" not in r.text
    # What .github/workflows/ops-inspect.yml prints of it: numbers and
    # codes, never the caller hashes (the repo's logs are public).
    lines = _ops_inspect().report(body)
    text = "\n".join(lines)
    assert recent[0]["who"] not in text
    assert "total 10 GB" in text and "file_too_large 3" in text
    assert "  4 GB: needs 7.75 GB -> fits" in text
    assert "CLEO_UPLOAD_INITS_PER_HOUR = 60" in text


def _ops_inspect():
    import importlib.util
    path = (Path(__file__).resolve().parents[2] / ".github" / "scripts"
            / "ops_inspect.py")
    spec = importlib.util.spec_from_file_location("ops_inspect", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_ops_inspect_prints_only_numbers_and_codes():
    oi = _ops_inspect()
    assert [oi.safe(v) for v in (None, True, 3, 2.5, "server_storage_full",
                                 "user_2abcDEF", "a@b.c", {"x": 1})] == [
        "-", "yes", "3", "2.5", "server_storage_full", "?", "?", "?"]
    body = {"tmp_root": {"total_gb": 10.0, "free_gb": 9.2},
            "room_gb": 8.2, "fits_now": [{"size_gb": 4, "need_gb": 8.75,
                                          "fits": False}],
            "refusals": {"recent": [
                {"code": "server_storage_full", "size_gb": 3.4,
                 "need_gb": 12.9, "free_gb": 9.2, "reserved_gb": 0.0,
                 "seconds": None, "who": "0123456789ab"}]}}
    text = "\n".join(oi.report(body))
    assert "0123456789ab" not in text
    assert "DISK: 1 of the last 1 refusals are server_storage_full" in text
    assert "no video length" in text
    assert "ROOM: right now a 10-min upload of 4 GB or more" in text
