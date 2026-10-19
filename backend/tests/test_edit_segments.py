"""POST /jobs/{id}/edit-segments (the v2 editor's timeline save; owner
report S1/S6): the timeline's revision rule, so a stale tab or device
never silently overwrites newer work, and no preview encode for a save
the stored preview already shows (a speed change, an undo back to the
built cut, the same list again) — while volume and fades now reach the
server preview."""
from __future__ import annotations

import pytest

import backend.main as M
from backend import storage
from backend.jobs import store


def _review_job(tmp_path):
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"n")
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", normalized_path=str(src),
                 segments=[(0.0, 5.0)], duration=10.0)
    return job


@pytest.fixture
def builds(monkeypatch):
    """The preview encodes (args), stored like _rebuild_preview stores."""
    calls: list[tuple] = []

    def rebuild(job_id, source, segments, effects=None):
        calls.append((list(segments), effects))
        cur = store.get(job_id)
        store.update(job_id, preview_key=f"jobs/{job_id}/preview/v{len(calls)}.mp4",
                     preview_segments=[[float(a), float(b)] for a, b in segments],
                     preview_effects=effects,
                     preview_version=(cur.preview_version or 0) + 1)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)
    return calls


def _save(client, job_id, segs, **revs):
    return client.post(f"/jobs/{job_id}/edit-segments",
                       json={"segments": segs, **revs})


# ── revisions (save-6) ──────────────────────────────────────────────

def test_a_stale_tab_cannot_overwrite_newer_work(client, tmp_path, builds):
    job = _review_job(tmp_path)
    assert client.get(f"/jobs/{job.id}").json()["edit_rev"] == 0
    # The Mac and the iPhone both opened the project at rev 0.
    r = _save(client, job.id, [{"start": 0.35, "end": 4.73}], base_rev=0, rev=100)
    assert r.status_code == 200, r.text
    assert r.json()["edit_rev"] == 100
    # The other device, still on rev 0, trims too: refused, nothing stored.
    r = _save(client, job.id, [{"start": 0.35, "end": 5.23}], base_rev=0, rev=101)
    assert r.status_code == 409
    assert r.json()["detail"] == "stale_rev" and r.json()["rev"] == 100
    got = store.get(job.id)
    assert got.segments == [(0.35, 4.73)] and got.edit_rev == 100
    # Its rev must be newer too.
    assert _save(client, job.id, [{"start": 0, "end": 3}], base_rev=100,
                 rev=100).status_code == 409
    # A save on the current rev goes through.
    r = _save(client, job.id, [{"start": 0, "end": 3}], base_rev=100, rev=150)
    assert r.status_code == 200 and store.get(job.id).edit_rev == 150


def test_saves_without_revisions_still_overwrite_and_get_one(client, tmp_path, builds):
    job = _review_job(tmp_path)
    store.update(job.id, edit_rev=150)
    r = _save(client, job.id, [{"start": 1, "end": 4}])
    assert r.status_code == 200
    rev = store.get(job.id).edit_rev
    assert rev > 150
    # ... so a tab that saved before it is stale now
    assert _save(client, job.id, [{"start": 0, "end": 2}], base_rev=150,
                 rev=200).status_code == 409


@pytest.mark.parametrize("revs", [{"base_rev": 0}, {"rev": 5},
                                  {"base_rev": "0", "rev": 5},
                                  {"base_rev": 0, "rev": True}])
def test_half_or_odd_revisions_are_refused(client, tmp_path, builds, revs):
    job = _review_job(tmp_path)
    r = _save(client, job.id, [{"start": 0, "end": 2}], **revs)
    assert r.status_code == 400 and r.json()["detail"] == "bad_rev"
    assert store.get(job.id).segments == [(0.0, 5.0)]


# ── no encode for what the preview already shows (save-8) ───────────

def test_identical_and_speed_only_saves_need_no_encode(client, tmp_path, builds):
    job = _review_job(tmp_path)
    clip = {"start": 0.0, "end": 4.0}
    r = _save(client, job.id, [clip])
    assert r.json()["preview_ok"] and len(builds) == 1
    version = store.get(job.id).preview_version
    # the same list again, then only its speed: the preview is current
    for seg in (clip, {**clip, "speed": 2.0}):
        r = _save(client, job.id, [seg])
        assert r.status_code == 200
        assert r.json()["preview_ok"] is True and r.json()["superseded"] is False
        assert r.json()["preview_version"] == version
    assert len(builds) == 1
    # the speed is stored for the export all the same
    assert store.get(job.id).settings["segment_effects"][0]["speed"] == 2.0


def test_volume_and_fades_are_baked_into_the_preview(client, tmp_path, builds):
    job = _review_job(tmp_path)
    _save(client, job.id, [{"start": 0.0, "end": 4.0}])
    r = _save(client, job.id, [{"start": 0.0, "end": 4.0, "volume": 0}])
    assert r.json()["preview_ok"] and len(builds) == 2
    assert builds[-1][1] == [{"volume": 0.0, "fadeIn": 0.0, "fadeOut": 0.0, "speed": 1.0}]
    # a fade carries the clip's speed (it sets the fade's source length)
    _save(client, job.id, [{"start": 0.0, "end": 4.0, "fadeIn": 0.5, "speed": 2}])
    assert builds[-1][1] == [{"volume": 1.0, "fadeIn": 0.5, "fadeOut": 0.0, "speed": 2.0}]
    # undo back to the plain cut: the plain preview is no longer stored,
    # so it is encoded again — without effects
    _save(client, job.id, [{"start": 0.0, "end": 4.0}])
    assert builds[-1] == ([(0.0, 4.0)], None) and len(builds) == 4


def test_a_running_older_rebuild_is_waited_for(monkeypatch, tmp_path):
    """Save A starts an encode; save B (the list the preview showed
    before A) arrives meanwhile: B must not be answered from the stale
    stored preview — it waits for A's encode, then encodes its own."""
    import asyncio
    import threading

    import httpx
    job = _review_job(tmp_path)
    store.update(job.id, preview_key=f"jobs/{job.id}/preview/v1.mp4",
                 preview_segments=[[0.0, 5.0]], preview_version=1)
    started, release = threading.Event(), threading.Event()
    built = []

    def rebuild(job_id, source, segments, effects=None):
        built.append(list(segments))
        if len(built) == 1:
            started.set()
            assert release.wait(5)
        cur = store.get(job_id)
        store.update(job_id, preview_segments=[list(s) for s in segments],
                     preview_effects=effects,
                     preview_version=(cur.preview_version or 0) + 1)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)

    async def main():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            a = asyncio.create_task(c.post(f"/jobs/{job.id}/edit-segments",
                                           json={"segments": [{"start": 0, "end": 3}]}))
            while not started.is_set():
                await asyncio.sleep(0.01)
            b = asyncio.create_task(c.post(f"/jobs/{job.id}/edit-segments",
                                           json={"segments": [{"start": 0, "end": 5}]}))
            await asyncio.sleep(0.2)
            release.set()
            return (await a).json(), (await b).json()
    ra, rb = asyncio.run(main())
    assert rb["preview_ok"] and rb["preview_segments"] == [[0.0, 5.0]]
    assert built == [[(0.0, 3.0)], [(0.0, 5.0)]]


def test_the_real_rebuild_stores_what_it_baked(client, r2, monkeypatch):
    job = store.create(None, {})
    p = f"jobs/{job.id}/"
    r2.put_object(Bucket=storage.bucket(), Key=p + "proxy.mp4", Body=b"PROXY")
    store.update(job.id, status="awaiting_review", mezz_key=p + "mezz.mp4",
                 proxy_key=p + "proxy.mp4", duration=10.0, segments=[(0.0, 10.0)])
    cuts = []

    def cut(source, segments, output, effects=None):
        cuts.append(effects)
        with open(output, "wb") as fh:
            fh.write(b"preview")
    monkeypatch.setattr(M.pipeline, "_ffmpeg_cuts_preview", cut)
    r = _save(client, job.id, [{"start": 0, "end": 3, "fadeOut": 0.4}])
    assert r.status_code == 200 and r.json()["preview_ok"]
    fx = [{"volume": 1.0, "fadeIn": 0.0, "fadeOut": 0.4, "speed": 1.0}]
    assert cuts == [fx] and store.get(job.id).preview_effects == fx
    # unchanged: no second encode
    assert _save(client, job.id, [{"start": 0, "end": 3, "fadeOut": 0.4}]).json()["preview_ok"]
    assert len(cuts) == 1


# ── saves never wait for an encode (save-2, preview-7-queue) ────────

def _wait_status(client, job_id, want, timeout=10.0):
    import time
    end = time.monotonic() + timeout
    while True:
        j = client.get(f"/jobs/{job_id}").json()
        if j["preview_status"] == want or time.monotonic() > end:
            return j
        time.sleep(0.02)


@pytest.fixture
def slow_builds(monkeypatch):
    """_rebuild_preview that waits for `release` (stored like the real one)."""
    import threading
    state = {"release": threading.Event(), "started": threading.Event(), "calls": []}

    def rebuild(job_id, source, segments, effects=None):
        state["calls"].append(list(segments))
        state["started"].set()
        assert state["release"].wait(10)
        cur = store.get(job_id)
        store.update(job_id, preview_key=f"jobs/{job_id}/preview/v{(cur.preview_version or 0) + 1}.mp4",
                     preview_segments=[[float(a), float(b)] for a, b in segments],
                     preview_effects=effects, preview_error=None,
                     preview_version=(cur.preview_version or 0) + 1)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)
    yield state
    state["release"].set()


def test_a_save_is_answered_as_soon_as_it_is_stored(client, tmp_path, slow_builds):
    import time
    job = _review_job(tmp_path)
    t0 = time.monotonic()
    r = _save(client, job.id, [{"start": 0.5, "end": 4.0}], base_rev=0, rev=10)
    took = time.monotonic() - t0
    assert r.status_code == 200 and took < 2.0, took
    body = r.json()
    # stored, the encode still to come — and said so
    assert body["edit_rev"] == 10 and store.get(job.id).segments == [(0.5, 4.0)]
    assert (body["preview_ok"], body["preview_rebuilt"], body["superseded"],
            body["preview_status"]) == (False, False, False, "building")
    assert slow_builds["started"].wait(5)
    assert client.get(f"/jobs/{job.id}").json()["preview_status"] == "building"
    # the next save goes at once too, while the first encode runs
    t0 = time.monotonic()
    r = _save(client, job.id, [{"start": 0.5, "end": 3.0}], base_rev=10, rev=11)
    assert r.status_code == 200 and time.monotonic() - t0 < 2.0
    slow_builds["release"].set()
    j = _wait_status(client, job.id, "ready")
    assert j["preview_status"] == "ready" and j["preview_error"] is None
    assert j["preview_segments"] == [[0.5, 3.0]]
    # the first save's encode ran (it had started); the second one's after it
    assert slow_builds["calls"] == [[(0.5, 4.0)], [(0.5, 3.0)]]


def test_saves_behind_a_running_encode_build_only_the_newest(client, tmp_path, slow_builds):
    job = _review_job(tmp_path)
    _save(client, job.id, [{"start": 0, "end": 4.0}], base_rev=0, rev=1)
    assert slow_builds["started"].wait(5)
    for rev, end in ((2, 3.5), (3, 3.0), (4, 2.5)):
        assert _save(client, job.id, [{"start": 0, "end": end}],
                     base_rev=rev - 1, rev=rev).status_code == 200
    slow_builds["release"].set()
    j = _wait_status(client, job.id, "ready")
    assert j["preview_segments"] == [[0.0, 2.5]]
    assert slow_builds["calls"] == [[(0.0, 4.0)], [(0.0, 2.5)]]


def _proxy_job(tmp_path, monkeypatch):
    """A job the editor plays from the proxy (CLEO_PROXY_VIDEO=1, a
    legacy proxy.mp4 next to the normalized file)."""
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = _review_job(tmp_path)
    (tmp_path / "proxy.mp4").write_bytes(b"proxy")
    (tmp_path / "preview.mp4").write_bytes(b"preview-1")
    store.update(job.id, preview_path=str(tmp_path / "preview.mp4"),
                 preview_segments=[[0.0, 5.0]], preview_version=1)
    assert store.get(job.id)._has_proxy()
    return job


def test_proxy_playback_skips_the_rebuild_until_the_preview_is_asked_for(
        client, tmp_path, monkeypatch, builds):
    job = _proxy_job(tmp_path, monkeypatch)
    # new client (revisions) and an editor from before: no encode either way
    r = _save(client, job.id, [{"start": 1, "end": 4}], base_rev=0, rev=5)
    assert r.json()["preview_status"] == "stale" and r.json()["preview_ok"] is False
    r = _save(client, job.id, [{"start": 1, "end": 3}])
    assert r.status_code == 200 and r.json()["preview_status"] == "stale"
    assert builds == []
    # a player that falls back to the preview: it gets the version it
    # asks for at once, and the stored timeline's preview is built
    r = client.get(f"/jobs/{job.id}/preview-video", params={"v": 1})
    assert r.status_code == 200 and r.content == b"preview-1"
    j = _wait_status(client, job.id, "ready")
    assert j["preview_segments"] == [[1.0, 3.0]] and len(builds) == 1
    assert j["preview_version"] == 2
    # asked again: nothing more to build
    client.get(f"/jobs/{job.id}/preview-video", params={"v": 2})
    assert len(builds) == 1


def test_preview_mode_saves_of_an_old_client_still_wait_for_the_encode(
        client, tmp_path, builds):
    job = _review_job(tmp_path)
    r = _save(client, job.id, [{"start": 1, "end": 4}])
    body = r.json()
    assert (body["preview_ok"], body["preview_rebuilt"], body["preview_status"]) == (
        True, True, "ready")
    assert body["preview_segments"] == [[1.0, 4.0]] and len(builds) == 1


# ── a skipped encode says so (preview-skip-version) ────────────────

def test_a_skipped_encode_names_the_preview_that_shows_the_save(client, tmp_path, builds):
    job = _review_job(tmp_path)
    clip = {"start": 0.0, "end": 4.0}
    assert _save(client, job.id, [clip]).json()["preview_rebuilt"] is True
    version = store.get(job.id).preview_version
    rev = store.get(job.id).edit_rev
    for seg in (clip, {**clip, "speed": 2.0}):
        body = _save(client, job.id, [seg], base_rev=rev, rev=rev + 1).json()
        rev += 1
        assert (body["preview_ok"], body["preview_rebuilt"], body["preview_status"],
                body["preview_version"], body["preview_segments"]) == (
            True, False, "ready", version, [[0.0, 4.0]])
        # an old client's identical save: no new version either
        body = _save(client, job.id, [seg]).json()
        rev = store.get(job.id).edit_rev
        assert (body["preview_ok"], body["preview_rebuilt"],
                body["preview_version"]) == (True, False, version)
    assert len(builds) == 1


def test_no_ok_for_a_preview_an_older_encode_is_about_to_replace(
        client, tmp_path, slow_builds):
    """The stored preview shows this save, but an encode of another
    timeline is still running: it will replace that preview, so the
    answer can't call it ok (it is "building", then this save is built
    again after it)."""
    job = _review_job(tmp_path)
    store.update(job.id, preview_key=f"jobs/{job.id}/preview/v1.mp4",
                 preview_segments=[[0.0, 5.0]], preview_version=1)
    _save(client, job.id, [{"start": 0, "end": 3}], base_rev=0, rev=1)
    assert slow_builds["started"].wait(5)
    body = _save(client, job.id, [{"start": 0, "end": 5}], base_rev=1, rev=2).json()
    assert (body["preview_ok"], body["preview_status"], body["preview_version"]) == (
        False, "building", 1)
    slow_builds["release"].set()
    j = _wait_status(client, job.id, "ready")
    assert j["preview_segments"] == [[0.0, 5.0]] and j["preview_version"] == 3


# ── GET /preview-video?v= is that version (be-preview-version) ──────

def _put_preview(job, n, body):
    import tempfile
    from backend import media
    key = f"{media.job_prefix(job.id)}preview/v{n}.mp4"
    with tempfile.NamedTemporaryFile(suffix=".mp4") as fh:
        fh.write(body)
        fh.flush()
        media.put_file(fh.name, key, content_type="video/mp4",
                       store=media.backend())
    return key


def _served(r) -> bytes | str:
    """The local file's bytes, or the key an R2 307 points at."""
    if r.status_code == 307:
        loc = r.headers["location"]
        return loc.split("?")[0].split("/jobs/", 1)[1]
    assert r.status_code == 200, r.text
    return r.content


def test_preview_video_serves_exactly_the_version_asked_for(client, tmp_path):
    from backend import media
    job = _review_job(tmp_path)
    k1 = _put_preview(job, 1, b"version-1")
    k2 = _put_preview(job, 2, b"version-2")
    store.update(job.id, preview_key=k2, preview_version=2,
                 preview_segments=[[0.0, 5.0]], media_store=media.backend())

    def get(**params):
        return client.get(f"/jobs/{job.id}/preview-video", params=params,
                          follow_redirects=False)

    for params, key, data in (({}, k2, b"version-2"), ({"v": 2}, k2, b"version-2"),
                              ({"v": 1}, k1, b"version-1")):
        got = _served(get(**params))
        assert got == (data if media.backend() != "r2" else key[len("jobs/"):]), params
    # versioned answers can be cached for good (a version never changes)
    r = get(v=1)
    if r.status_code == 200:
        assert "immutable" in r.headers["cache-control"]
    # a version not stored (yet / any more): 409, with the current one
    r = get(v=3)
    assert r.status_code == 409
    assert r.json()["code"] == "preview_not_ready" and r.json()["preview_version"] == 2
    # v=0, what GET /jobs/{id} names before the first preview exists (an
    # analysis without one: proxy playback): the first one, v1, for good
    # (test_first_preview.py)
    assert _served(get(v=0)) == (b"version-1" if media.backend() != "r2"
                                 else k1[len("jobs/"):])
    media.delete(k1, store=media.backend())
    assert get(v=1).status_code == 409
    r = get(v=0)
    assert r.status_code == 409 and r.json()["preview_version"] == 2
    # an old client's cache-buster that isn't a number: the current one
    assert _served(get(v="x")) == (b"version-2" if media.backend() != "r2" else k2[len("jobs/"):])


def test_a_legacy_preview_file_is_only_its_own_version(client, tmp_path):
    job = _review_job(tmp_path)
    (tmp_path / "preview.mp4").write_bytes(b"legacy")
    store.update(job.id, preview_path=str(tmp_path / "preview.mp4"),
                 preview_version=4, preview_segments=[[0.0, 5.0]])
    url = f"/jobs/{job.id}/preview-video"
    assert client.get(url, params={"v": 4}).content == b"legacy"
    assert client.get(url).content == b"legacy"
    assert client.get(url, params={"v": 3}).status_code == 409


# ── failures reach the client, logs have numbers only (be-preview-4) ─

def test_a_failed_rebuild_is_reported_and_logged_without_text(
        client, tmp_path, monkeypatch, capsys):
    job = _review_job(tmp_path)
    fail = {"on": True}
    calls = []

    def rebuild(job_id, source, segments, effects=None):
        calls.append(list(segments))
        if fail["on"]:
            raise RuntimeError("ffmpeg preview-cut failed:\n/data/jobs/x/secret "
                               "Hallo das ist mein Text")
        cur = store.get(job_id)
        store.update(job_id, preview_key=f"jobs/{job_id}/preview/v9.mp4",
                     preview_segments=[[float(a), float(b)] for a, b in segments],
                     preview_effects=effects, preview_error=None,
                     preview_version=(cur.preview_version or 0) + 1)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)
    # an old client: the answer itself says it
    body = _save(client, job.id, [{"start": 0, "end": 2}]).json()
    assert (body["preview_ok"], body["superseded"], body["preview_status"],
            body["preview_error"]) == (False, False, "failed", "encode_failed")
    # a new one: GET /jobs/{id} says it once the background build failed
    rev = store.get(job.id).edit_rev
    _save(client, job.id, [{"start": 0, "end": 3}], base_rev=rev, rev=rev + 1)
    j = _wait_status(client, job.id, "failed")
    assert (j["preview_status"], j["preview_error"]) == ("failed", "encode_failed")
    log = capsys.readouterr().out
    assert "code=encode_failed" in log and "segments=1" in log
    assert "/data/" not in log and "Hallo" not in log and "secret" not in log
    # the failure doesn't make GET /preview-video build again and again
    n = len(calls)
    client.get(f"/jobs/{job.id}/preview-video")
    assert len(calls) == n
    # Retry: builds again, and the preview catches up
    fail["on"] = False
    r = client.post(f"/jobs/{job.id}/preview")
    assert r.status_code == 200 and r.json()["preview_status"] in ("building", "ready")
    j = _wait_status(client, job.id, "ready")
    assert j["preview_segments"] == [[0.0, 3.0]] and j["preview_error"] is None
    # a newer timeline is never "failed" for an older one's failure
    fail["on"] = True
    rev = store.get(job.id).edit_rev
    _save(client, job.id, [{"start": 0, "end": 1}], base_rev=rev, rev=rev + 1)
    _wait_status(client, job.id, "failed")
    fail["on"] = False
    rev = store.get(job.id).edit_rev
    body = _save(client, job.id, [{"start": 0, "end": 1.5}], base_rev=rev, rev=rev + 1).json()
    assert body["preview_status"] == "building" and body["preview_error"] is None
    assert _wait_status(client, job.id, "ready")["preview_segments"] == [[0.0, 1.5]]
