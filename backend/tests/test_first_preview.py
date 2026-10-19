"""No first preview at analysis while the editor plays the proxy
(CLEO_PROXY_VIDEO=1, round 3): the analysis encodes no preview/v1 — the
editor follows the edit list on the proxy itself, and nothing else reads
the preview (poster and filmstrip come from the proxy; renders, bonus
clips and the speculative render from the mezz). A player that falls
back to the preview (the proxy didn't play on that device) gets its
first preview built on demand: GET /jobs/{id}/preview-video waits for
that build and serves it, so the fallback never ends on a dead player.

Without CLEO_PROXY_VIDEO, or when the proxy encode failed, the analysis
makes the first preview exactly as before."""
from __future__ import annotations

import tempfile
import threading
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import jobs, media, pipeline, taskq, worker
from backend.jobs import store
from conftest import analysis_result
from test_analysis_doc import _clip, fake_transcription  # noqa: F401 (fixture)


@pytest.fixture
def cut_previews(monkeypatch):
    """pipeline._ffmpeg_cuts_preview, counted (the real encode runs)."""
    calls: list[str] = []
    real = pipeline._ffmpeg_cuts_preview

    def counted(input_path, segments, output_path, *a, **kw):
        calls.append(input_path)
        return real(input_path, segments, output_path, *a, **kw)
    monkeypatch.setattr(pipeline, "_ffmpeg_cuts_preview", counted)
    return calls


def _store(res: dict, job_id: str = "0123456789ab") -> tuple[dict, list[str]]:
    """store_analysis_outputs with a put that only records the keys."""
    keys: list[str] = []

    def put(path, key, ctype):
        keys.append(key)
        return Path(path).stat().st_size
    return pipeline.store_analysis_outputs(res, job_id, put), keys


# ── the analysis ─────────────────────────────────────────────────────


@pytest.mark.parametrize("flag,made", [("1", False), ("", True), ("0", True)])
def test_proxy_playback_analysis_encodes_no_first_preview(
        tmp_path, monkeypatch, fake_transcription, cut_previews, flag, made):  # noqa: F811
    monkeypatch.setenv("CLEO_PROXY_VIDEO", flag)
    job = tmp_path / "job"
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(job),
                                {"smartcam_enabled": False})
    assert (job / pipeline.PROXY_NAME).is_file()
    assert (job / "preview.mp4").is_file() is made
    assert len(cut_previews) == (1 if made else 0)
    if made:
        assert res["preview_path"] == str(job / "preview.mp4")
        assert cut_previews == [str(job / pipeline.PROXY_NAME)]
    else:
        assert res["preview_path"] is None
    # Everything else the editor opens with is still there: poster and
    # filmstrip (both from the proxy), peaks, the doc.
    assert Path(res["poster_path"]).is_file()
    assert res["filmstrip_meta"] and Path(res["filmstrip_path"]).is_file()
    assert res["peaks_path"] and res["doc"] is not None and res["segments"]
    fields, keys = _store(res)
    p = "jobs/0123456789ab/"
    assert (p + "preview/v1.mp4" in keys) is made
    assert ("preview_key" in fields) is made
    assert {p + "mezz.mp4", p + "proxy.mp4", p + "poster.jpg",
            p + "filmstrip.jpg", p + "peaks.bin"} <= set(keys)
    want = ({"preview_segments": [list(s) for s in res["segments"]],
             "preview_version": 1} if made
            else {"preview_segments": [], "preview_version": 0})
    assert pipeline.first_preview_fields(res["segments"], fields) == want


def test_a_failed_proxy_keeps_the_first_preview(tmp_path, monkeypatch,
                                                fake_transcription,  # noqa: F811
                                                cut_previews):
    """No proxy (its encode failed): the preview is all the editor can
    play (has_proxy false), so it is made — from the normalized file."""
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    real = pipeline._normalize_orientation
    monkeypatch.setattr(pipeline, "_normalize_orientation",
                        lambda *a, **kw: real(*a, **{**kw, "proxy_path": None}))
    monkeypatch.setattr(pipeline, "_make_proxy", lambda *a, **kw: False)
    job = tmp_path / "job"
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(job),
                                {"smartcam_enabled": False})
    assert not (job / pipeline.PROXY_NAME).exists()
    assert Path(res["preview_path"]).is_file()
    assert cut_previews == [str(job / "normalized.mp4")]
    fields, keys = _store(res)
    assert "proxy_key" not in fields and fields["preview_key"].endswith("preview/v1.mp4")


def test_a_stale_preview_of_a_rerun_is_never_stored(tmp_path, monkeypatch,
                                                    fake_transcription):  # noqa: F811
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = tmp_path / "job"
    job.mkdir()
    (job / "preview.mp4").write_bytes(b"from an earlier run")
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(job), {})
    assert res["preview_path"] is None and not (job / "preview.mp4").exists()


def test_first_preview_wanted_needs_the_flag_and_the_proxy(tmp_path, monkeypatch):
    proxy = tmp_path / pipeline.PROXY_NAME
    monkeypatch.delenv("CLEO_PROXY_VIDEO", raising=False)
    assert pipeline.first_preview_wanted(str(proxy)) is True
    monkeypatch.setenv("CLEO_PROXY_VIDEO", " 1 ")
    assert pipeline.first_preview_wanted(str(proxy)) is True      # no proxy
    proxy.write_bytes(b"p")
    assert pipeline.first_preview_wanted(str(proxy)) is False
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "true")                 # only "1"
    assert pipeline.first_preview_wanted(str(proxy)) is True


# ── the commit (both analysis paths) ─────────────────────────────────


def _no_preview_result(output_dir, duration: float = 12.0) -> dict:
    """analyze_only's result with CLEO_PROXY_VIDEO=1: no preview.mp4."""
    res = analysis_result(output_dir, duration,
                          segments=[(0.5, 4.0), (5.0, duration)])
    Path(res["preview_path"]).unlink()
    res["preview_path"] = None
    return res


def _new_job():
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {})


def _assert_review_without_preview(client, job_id: str) -> None:
    got = store.get(job_id)
    p = f"jobs/{job_id}/"
    assert got.status == "awaiting_review"
    assert (got.mezz_key, got.proxy_key, got.preview_key) == (
        p + "mezz.mp4", p + "proxy.mp4", None)
    assert (got.preview_version, got.preview_segments) == (0, [])
    assert not any("preview" in k for k in got.media_bytes)
    j = client.get(f"/jobs/{job_id}").json()
    assert j["has_proxy"] is True
    # what the editor reads: version 0, mapped like the stored timeline
    # (the first build shows exactly that), none being built
    assert (j["preview_version"], j["preview_status"]) == (0, "stale")
    assert j["preview_segments"] == [[0.5, 4.0], [5.0, 12.0]]


def test_wp1_commit_without_a_first_preview(client, monkeypatch):
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = _new_job()
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: _no_preview_result(output_dir))
    M._run_analyze_inner(job.id)
    _assert_review_without_preview(client, job.id)


def test_wp1_commit_with_the_first_preview_is_unchanged(client, monkeypatch):
    job = _new_job()
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: analysis_result(output_dir, 12.0))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.preview_key == f"jobs/{job.id}/preview/v1.mp4"
    assert (got.preview_version, got.preview_segments) == (1, [[0.0, 12.0]])


@pytest.mark.no_task_leader
def test_worker_commit_without_a_first_preview(client, monkeypatch):
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = _new_job()
    ts = jobs.task_store()
    tid, _ = ts.enqueue(job.id, "ingest", {"v": taskq.WORKER_PROTOCOL, "job_id": job.id,
                                          "est_audio_s": 3, "size": 0},
                        owner_id=None, job_change=dict(status="processing", message="queued"))
    ts.claim_for_dispatch("ingest", 1, "L", 300, "local")
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: _no_preview_result(output_dir))
    assert worker.run("ingest", tid, job.id, 1, taskq.WORKER_PROTOCOL) == {"committed": True}
    _assert_review_without_preview(client, job.id)


# ── a player that falls back: the first preview on demand ───────────


@pytest.fixture
def first_builds(monkeypatch):
    """The preview encodes, stored like _rebuild_preview stores them (a
    real media object per version). `gate` (an Event) holds a build,
    `fail` makes it fail."""
    state: dict = {"calls": [], "gate": None, "fail": False, "started": threading.Event()}

    def rebuild(job_id, source, segments, effects=None):
        state["calls"].append([tuple(s) for s in segments])
        state["started"].set()
        if state["gate"] is not None:
            assert state["gate"].wait(20)
        if state["fail"]:
            raise RuntimeError("ffmpeg preview-cut failed")
        cur = store.get(job_id)
        n = (cur.preview_version or 0) + 1
        key = f"{media.job_prefix(job_id)}preview/v{n}.mp4"
        with tempfile.NamedTemporaryFile(suffix=".mp4") as fh:
            fh.write(f"preview-{n}".encode())
            fh.flush()
            media.put_file(fh.name, key, content_type="video/mp4",
                           store=media.store_of(cur))
        store.update(job_id, preview_key=key, preview_version=n, preview_error=None,
                     preview_segments=[[float(a), float(b)] for a, b in segments],
                     preview_effects=effects)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)
    return state


def _proxy_job_without_preview(monkeypatch):
    """A job analysed with CLEO_PROXY_VIDEO=1: proxy, no preview."""
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = store.create(None, {})
    p = media.job_prefix(job.id)
    store.update(job.id, status="awaiting_review", media_store=media.backend(),
                 mezz_key=p + "mezz.mp4", proxy_key=p + "proxy.mp4",
                 segments=[(0.5, 4.0), (5.0, 9.0)], duration=10.0)
    got = store.get(job.id)
    assert got._has_proxy() and got.preview_version == 0 and not got.preview_key
    return got


def _served(r) -> bytes | str:
    """The local file's bytes, or the version an R2 307 points at."""
    if r.status_code == 307:
        return r.headers["location"].split("?")[0].rsplit("/", 1)[1]
    assert r.status_code == 200, r.text
    return r.content


def _is(r, n: int) -> bool:
    return _served(r) in (f"preview-{n}".encode(), f"v{n}.mp4")


def _get(client, job_id, **params):
    return client.get(f"/jobs/{job_id}/preview-video", params=params,
                      follow_redirects=False)


def test_a_fallback_player_gets_the_first_preview_built_and_served(client, monkeypatch,
                                                                   first_builds):
    job = _proxy_job_without_preview(monkeypatch)
    # the editor asks for the version GET /jobs/{id} names: 0
    r = _get(client, job.id, v=0)
    assert _is(r, 1)
    if r.status_code == 200:   # a version's answer: it never changes
        assert "immutable" in r.headers["cache-control"]
    assert first_builds["calls"] == [[(0.5, 4.0), (5.0, 9.0)]]
    j = client.get(f"/jobs/{job.id}").json()
    assert (j["preview_version"], j["preview_status"]) == (1, "ready")
    assert j["preview_segments"] == [[0.5, 4.0], [5.0, 9.0]]
    # the player's next range requests of ?v=0, the editor's swap to
    # ?v=1, an old client without ?v=: the same file, no second build
    for params in ({"v": 0}, {"v": 0}, {"v": 1}, {}):
        assert _is(_get(client, job.id, **params), 1), params
    assert len(first_builds["calls"]) == 1
    # an edit, rebuilt (the editor's poll asks): ?v=0 stays the file the
    # player streams, ?v=2 is the new one
    rev = store.get(job.id).edit_rev
    client.post(f"/jobs/{job.id}/edit-segments",
                json={"segments": [{"start": 1.0, "end": 3.0}], "base_rev": rev,
                      "rev": rev + 1})
    assert client.post(f"/jobs/{job.id}/preview").status_code == 200
    end = time.monotonic() + 10
    while store.get(job.id).preview_version != 2 and time.monotonic() < end:
        time.sleep(0.05)
    assert _is(_get(client, job.id, v=0), 1) and _is(_get(client, job.id, v=2), 2)
    assert len(first_builds["calls"]) == 2


def test_the_first_request_waits_for_the_build(client, monkeypatch, first_builds):
    job = _proxy_job_without_preview(monkeypatch)
    gate = first_builds["gate"] = threading.Event()
    threading.Timer(0.6, gate.set).start()
    t0 = time.monotonic()
    r = _get(client, job.id)
    assert time.monotonic() - t0 >= 0.5
    assert _is(r, 1)


def test_concurrent_requests_share_one_build(client, monkeypatch, first_builds):
    """iOS Safari asks for a media src in several range requests."""
    job = _proxy_job_without_preview(monkeypatch)
    gate = first_builds["gate"] = threading.Event()
    out: list = []

    def ask():
        out.append(_get(client, job.id, v=0))
    threads = [threading.Thread(target=ask) for _ in range(3)]
    for t in threads:
        t.start()
    assert first_builds["started"].wait(10)
    time.sleep(0.3)
    gate.set()
    for t in threads:
        t.join(20)
    assert len(out) == 3 and all(_is(r, 1) for r in out)
    assert len(first_builds["calls"]) == 1


def test_the_wait_has_a_limit(client, monkeypatch, first_builds):
    monkeypatch.setenv("CLEO_FIRST_PREVIEW_WAIT_S", "0.3")
    job = _proxy_job_without_preview(monkeypatch)
    gate = first_builds["gate"] = threading.Event()
    t0 = time.monotonic()
    r = _get(client, job.id, v=0)
    assert r.status_code == 409 and time.monotonic() - t0 < 5
    gate.set()
    end = time.monotonic() + 10
    while store.get(job.id).preview_version != 1 and time.monotonic() < end:
        time.sleep(0.05)
    # the build went on; the next request gets it
    assert _is(_get(client, job.id, v=0), 1)
    assert len(first_builds["calls"]) == 1


def test_a_failed_first_build_answers_at_once(client, monkeypatch, first_builds):
    monkeypatch.setenv("CLEO_FIRST_PREVIEW_WAIT_S", "30")
    job = _proxy_job_without_preview(monkeypatch)
    first_builds["fail"] = True
    t0 = time.monotonic()
    r = _get(client, job.id, v=0)
    assert r.status_code == 409 and time.monotonic() - t0 < 5
    j = client.get(f"/jobs/{job.id}").json()
    assert (j["preview_status"], j["preview_error"]) == ("failed", "encode_failed")
    # no build loop: asked again, nothing is built until a Retry
    assert _get(client, job.id, v=0).status_code == 409
    assert len(first_builds["calls"]) == 1
    first_builds["fail"] = False
    assert client.post(f"/jobs/{job.id}/preview").status_code == 200
    end = time.monotonic() + 10
    while store.get(job.id).preview_version != 1 and time.monotonic() < end:
        time.sleep(0.05)
    assert _is(_get(client, job.id, v=0), 1)


def test_proxy_saves_still_build_nothing(client, monkeypatch, first_builds):
    """Edits while the editor plays the proxy: no encode; the first one
    comes only when a player asks for the preview — of the timeline as
    stored then."""
    job = _proxy_job_without_preview(monkeypatch)
    r = client.post(f"/jobs/{job.id}/edit-segments",
                    json={"segments": [{"start": 1.0, "end": 3.0}], "base_rev": 0, "rev": 5})
    body = r.json()
    assert r.status_code == 200, r.text
    assert (body["preview_status"], body["preview_ok"], body["preview_version"]) == (
        "stale", False, 0)
    time.sleep(0.2)
    assert first_builds["calls"] == []
    assert _is(_get(client, job.id, v=0), 1)
    assert first_builds["calls"] == [[(1.0, 3.0)]]
    assert store.get(job.id).preview_segments == [[1.0, 3.0]]


def test_an_unknown_version_is_still_refused(client, monkeypatch, first_builds):
    """Only the version GET /jobs/{id} names (0) or none waits; another
    one is a 409 as before (the build still starts)."""
    job = _proxy_job_without_preview(monkeypatch)
    r = _get(client, job.id, v=3)
    assert r.status_code == 409 and r.json()["preview_version"] == 0
    end = time.monotonic() + 10
    while store.get(job.id).preview_version != 1 and time.monotonic() < end:
        time.sleep(0.05)
    assert len(first_builds["calls"]) == 1
