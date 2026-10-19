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
