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


def _cached(cache: Path, name: str, size: int, age_s: float) -> Path:
    import os
    p = cache / f"{name}.mp4"
    p.write_bytes(b"x" * size)
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


def test_the_proxy_cache_gives_way_to_an_upload(monkeypatch):
    cache = M._proxy_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    for i, n in enumerate((3000, 2000, 1000)):     # oldest first
        _cached(cache, f"job{i}", n, 3600 - i)
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 0.0)
    disk = FakeDisk(monkeypatch, total=1e6, free=10_000)
    monkeypatch.setenv("CLEO_DISK_FACTOR", "1")
    # A check (presign / multipart init, no reservation) deletes
    # nothing: it passes because the room could be made.
    M._INFLIGHT.reserve_disk(None, 12_500)
    assert len(list(cache.glob("*.mp4"))) == 3
    # 12,500 needed, 10,000 free: the oldest cached proxy (3000) is
    # enough — only it goes, for a real reservation.
    token = M._INFLIGHT.admit(None)
    M._INFLIGHT.reserve_disk(token, 12_500)
    assert sorted(p.name for p in cache.glob("*.mp4")) == ["job1.mp4",
                                                          "job2.mp4"]
    M._INFLIGHT.release(token)
    # More than the whole cache: nothing is deleted, 507.
    disk.free = 0
    token = M._INFLIGHT.admit(None)
    with pytest.raises(M.DiskRefusal):
        M._INFLIGHT.reserve_disk(token, 100_000)
    with pytest.raises(M.DiskRefusal):
        M._INFLIGHT.reserve_disk(None, 100_000)
    M._INFLIGHT.release(token)
    assert len(list(cache.glob("*.mp4"))) == 2


def test_the_reclaim_spares_proxies_in_use(monkeypatch):
    """Never deleted for an upload: a proxy used in the last 10 minutes,
    one an ffmpeg call is reading (_proxy_in_use), one being fetched
    (its _proxy_cache_lock held)."""
    cache = M._proxy_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    for p in cache.glob("*.mp4"):
        p.unlink()
    recent = _cached(cache, "recent", 5000, 60)        # an editor session
    reading = _cached(cache, "reading", 5000, 3600)
    fetching = _cached(cache, "fetching", 5000, 3600)
    old = _cached(cache, "old", 1000, 7200)
    lock = M._proxy_cache_lock("fetching")
    with M._proxy_in_use("reading"), lock:
        # Only `old` is reclaimable: not enough for 2000 → nothing goes.
        assert M._proxy_cache_reclaim(2000) == 0
        assert M._proxy_cache_reclaim(2000, dry_run=True) == 0
        assert M._proxy_cache_reclaim(500, dry_run=True) == 1000
        assert old.exists()
        assert M._proxy_cache_reclaim(500) == 1000
        assert not old.exists()
        assert recent.exists() and reading.exists() and fetching.exists()
        # The LRU trim skips the one being read too.
        monkeypatch.setenv("CLEO_PROXY_CACHE_GB", "0")
        M._proxy_cache_trim(keep=recent)
        assert reading.exists() and not fetching.exists()
    # Done reading, a quarter of an hour on: it goes.
    monkeypatch.setenv("CLEO_PROXY_RECLAIM_MIN_AGE_S", "0")
    assert M._proxy_cache_reclaim(1) == 5000
    assert not reading.exists()
    assert M._PROXY_IN_USE == {}
    recent.unlink()


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


def test_capacity_counts_whole_windows_and_lists_the_newest(monkeypatch):
    """24h / 7d counts cover their whole window (not just the rows a
    short first query returned), "recent" is the 50 newest."""
    now = time.time()
    for i in range(60):                  # within the last day
        store.record_event("upload_refused", None,
                           {"code": "server_storage_full", "n": i},
                           at=now - 3600 + i)
    for i in range(5):                   # 3–5 days ago
        store.record_event("upload_refused", None, {"code": "server_busy"},
                           at=now - (3 + i * 0.5) * 86400)
    store.record_event("upload_refused", None, {"code": "too_many_uploads"},
                       at=now - 10 * 86400)               # outside 7d
    store.record_event("upload_refused", None, {}, at=now - 60)
    rep = M.capacity_report(now)["refusals"]
    assert rep["by_code"]["24h"] == {"server_storage_full": 60, "None": 1}
    assert rep["by_code"]["7d"] == {"server_storage_full": 60,
                                    "server_busy": 5, "None": 1}
    recent = rep["recent"]
    assert len(recent) == 50
    ats = [e["at"] for e in recent]
    assert ats == sorted(ats, reverse=True)
    assert recent[0]["age_s"] == 60 and recent[0]["code"] is None
    assert recent[1]["code"] == "server_storage_full"
    assert recent[1]["at"] == pytest.approx(now - 3600 + 59)
    with pytest.raises(ValueError):
        store.event_counts(0, "upload_refused", "code') OR 1=1 --")


def test_capacity_limits_report_the_defaults_in_use():
    limits = {k: f() for k, f in M._CAPACITY_LIMITS.items()}
    assert limits["CLEO_DISK_MEZZ_MBPS"] == M._disk_mezz_mbps() == 40
    assert limits["CLEO_DISK_PREVIEW_MBPS"] == 10
    assert limits["CLEO_DISK_FACTOR"] == 3.5


# ── the reserved length is the analysed length ───────────────────────


def test_post_jobs_caps_the_analysis_at_the_reserved_length(client, fake_r2,
                                                            monkeypatch):
    """Billing off: a header claiming 10 s reserves disk for 10 s — and
    the analysis stops at 10 s + the true-up tolerance, however long the
    file really is (the queue task carries the same cap)."""
    from backend import accounts, taskq
    FakeDisk(monkeypatch, total=10 * GB, free=9.5 * GB)
    fake_r2["size"], fake_r2["seconds"] = 4 * GB, 10.0
    r = client.post("/jobs", data={"settings": '{"_max_seconds": 99999}',
                                   "storage_key": "uploads/a.mov"})
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    cap = 10 + accounts.TRUE_UP_TOLERANCE_S
    assert job.settings["_max_seconds"] == cap
    if taskq.enabled():
        task = M._tasks().active_task(job.id, "ingest")
        assert task.payload["max_seconds"] == cap


def test_the_measured_length_caps_the_analysis_unbilled(monkeypatch):
    """No length at POST /jobs: the worker's measurement is the cap —
    in both length gates (WP1 and the queue worker)."""
    from backend import accounts
    from backend import worker as task_worker
    job = store.create(None, {"_measure_length": True},
                       source_key="uploads/x.mp4")
    monkeypatch.setattr(M, "_probe_duration", lambda p: 42.4)
    got = M._length_gate(job, "x.mp4", lambda *a: None)
    assert got == {"_max_seconds": 43 + accounts.TRUE_UP_TOLERANCE_S}
    job = store.create(None, {"_measure_length": True},
                       source_key="uploads/y.mp4")
    real_get = task_worker._get
    monkeypatch.setattr(task_worker, "_get", lambda name: (
        (lambda p: 42.4) if name == "probe_duration" else real_get(name)))
    got = task_worker._length_gate(None, job, "y.mp4", lambda *a: None)
    assert got == {"_max_seconds": 43 + accounts.TRUE_UP_TOLERANCE_S}


def test_the_mezz_proxy_and_precheck_stop_at_the_cap(tmp_path, monkeypatch):
    """analyze_only hands _max_seconds to every step that reads the
    source: the audio precheck and the normalize (mezz + proxy, -t;
    test_billing / test_pipeline_media cut real files with it)."""
    from backend import pipeline
    seen = {}

    def precheck(path, max_seconds=None):
        seen["precheck"] = max_seconds
        return {}

    class Stop(Exception):
        pass

    def normalize(src, dst, max_side=1920, max_seconds=None, proxy_path=None,
                  cfr_rate=None):
        seen["normalize"] = max_seconds
        raise Stop
    monkeypatch.setattr(pipeline, "_precheck_audio", precheck)
    monkeypatch.setattr(pipeline, "_normalize_orientation", normalize)
    monkeypatch.setattr(pipeline, "cfr_rate_of", lambda p: None)
    with pytest.raises(Stop):
        pipeline.analyze_only(str(tmp_path / "in.mp4"), str(tmp_path),
                              settings={"_max_seconds": 15.0})
    assert seen == {"precheck": 15.0, "normalize": 15.0}


# ── the disk guard ───────────────────────────────────────────────────


def test_the_disk_guard_kills_only_this_jobs_ffmpeg(tmp_path, monkeypatch):
    import subprocess
    import sys
    from backend import worker as task_worker
    ws = tmp_path / "jobs" / "j1" / "a1"
    ws.mkdir(parents=True)
    sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
    mine = subprocess.Popen([*sleeper, str(ws / "normalized.mp4")])
    other = subprocess.Popen([*sleeper, str(tmp_path / "jobs" / "j2")])
    try:
        disk = FakeDisk(monkeypatch, total=10 * GB, free=5 * GB)
        guard = task_worker.DiskGuard("j1", ws, tmp_path, 1 * GB,
                                      interval=0.02)
        with guard:
            time.sleep(0.1)
            assert not guard.tripped and mine.poll() is None
            guard.check()                    # nothing to raise yet
            disk.free = 0.5 * GB
            assert mine.wait(timeout=5) != 0           # killed
            assert guard.tripped
        assert other.poll() is None                     # another job's
        err = guard.error(RuntimeError("ffmpeg orientation-normalize "
                                       "failed: killed"))
        assert isinstance(err, OSError)
        assert "No space left on device" in str(err)
        with pytest.raises(task_worker.DiskGuardTripped):
            guard.progress(lambda m, p: None)("x", 1)
        assert guard.cancel_check()() is True
    finally:
        for p in (mine, other):
            p.kill()
            p.wait()


def test_a_full_disk_mid_analysis_fails_the_job_as_storage_full(
        monkeypatch, auth_on):
    """WP1: the volume drops under CLEO_MIN_FREE_GB while the analysis
    runs → that job stops with server_storage_full, its minutes back."""
    from backend import accounts
    monkeypatch.setenv("CLEO_DISK_GUARD_S", "0.02")
    disk = FakeDisk(monkeypatch, total=10 * GB, free=8 * GB)
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    job = store.create(str(f), {}, owner_id="user_a")
    accounts.charge(job.id, "user_a", 60, enforce=False)
    reached = []

    def analyze(input_path, output_dir, settings, progress_cb, **kw):
        disk.free = 0.4 * GB                    # something fills the disk
        end = time.monotonic() + 10
        while time.monotonic() < end:
            progress_cb("Analyzing audio…", 20)      # raises once tripped
            time.sleep(0.01)
        reached.append(True)
        raise AssertionError("the guard never stopped the analysis")
    monkeypatch.setattr(M, "analyze_only", analyze)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert reached == []
    assert got.status == "error"
    assert got.error_code == "server_storage_full", got.error
    assert got.refunded is True
    assert accounts.get_usage(job.id)["refunded"]
    [ev] = [e for e in store.events(0, kinds=["analysis_failed"])
            if e["job_id"] == job.id]
    assert ev["data"]["code"] == "server_storage_full"
    assert not M._workspace(job.id).exists()


def test_queue_dispatch_sizes_by_resolution_and_smartcam(monkeypatch):
    """local_room uses the admission's formula: a 4K job needs a 4K mezz
    (the 1080p ceiling would let it in), no SmartCam no second mezz."""
    import types
    FakeDisk(monkeypatch, total=10 * GB, free=10 * GB)
    ops = M._QueueOps(periodic=False)

    def task(**p):
        return types.SimpleNamespace(payload={"size": 4 * GB,
                                              "charged_s": 600, **p})
    hd = task(resolution="1080", smartcam=True)
    uhd = task(resolution="2160", smartcam=False)
    assert M._disk_need(4 * GB, 600, "2160", False) > 9 * GB
    assert ops.local_room([hd, hd]) == 1      # 7.75 + 1 floor each
    assert ops.local_room([uhd]) == 0
    assert ops.local_room([task()]) == 1      # old payloads: 1080p
    # _queue_admit writes those inputs into the task.
    job = store.create(None, {}, source_key="uploads/q.mov")
    parsed = {"resolution": "2160", "target_aspect": "16:9",
              "_max_seconds": 605}
    assert M._queue_admit(job.id, None, parsed, "free", 600.0, 4 * GB,
                          "uploads/q.mov") == "ok"
    p = M._tasks().active_task(job.id, "ingest").payload
    assert (p["resolution"], p["smartcam"], p["charged_s"]) == (
        "2160", False, 600.0)
    assert ops.local_room([types.SimpleNamespace(payload=p)]) == 0
