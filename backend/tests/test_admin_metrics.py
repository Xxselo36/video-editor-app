"""UX3: job events (analysis / render outcomes) and GET /admin/metrics —
the reliability gates of the launch (analysis ≥ 97 %, render ≥ 98 %,
p50 render wall time ≤ 1× the video length), readable from week 1."""
from __future__ import annotations

import time

import pytest

import backend.main as M
from backend import pipeline
from backend.jobs import store
from conftest import analysis_result

TOKEN = {"X-Admin-Token": "s3cret"}


@pytest.fixture
def admin(monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")


def _metrics(client, **params):
    r = client.get("/admin/metrics", headers=TOKEN, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_metrics_are_admin_only(client, monkeypatch):
    assert client.get("/admin/metrics").status_code == 404   # no token set
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    assert client.get("/admin/metrics",
                      headers={"X-Admin-Token": "nope"}).status_code == 401
    assert client.get("/admin/metrics", headers=TOKEN).status_code == 200
    assert client.get("/admin/metrics", headers=TOKEN,
                      params={"days": 0}).status_code == 400


def test_empty_window(client, admin):
    m = _metrics(client)
    assert m["days"] == 14
    assert m["analysis"]["success_rate"] is None
    assert m["render"]["success_rate"] is None
    assert m["gates"]["render_success"] == {"target": 0.98, "value": None,
                                            "ok": None}
    assert m["lost_edit_reports"] is None


# ── events written by the real job flows ─────────────────────────────


def _upload_job(settings=None):
    src = M._WORK_ROOT / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), settings or {})


def _render_job():
    job = store.create(None, {})
    store.update(job.id, status="processing", render_gen=1,
                 segments=[(0.0, 4.0), (5.0, 7.0)],
                 settings={"segment_effects": [{"speed": 2.0}, {}]},
                 mezz_key=f"jobs/{job.id}/mezz.mp4")
    return store.get(job.id)


def _ok_render(**kw):
    return {"outputs": {"primary": {"key": kw["out_prefix"] + "p.mp4",
                                    "size": 1}},
            "thumb": None, "hooks": []}


def test_job_flows_record_events(client, admin, monkeypatch):
    # Two analyses: one fine, one "no speech" (user-caused).
    monkeypatch.setattr(M, "analyze_only",
                        lambda **kw: analysis_result(kw["output_dir"], 30.0))
    M._run_analyze_inner(_upload_job().id)

    def silent(**kw):
        raise pipeline.NoSpeechError()
    monkeypatch.setattr(M, "analyze_only", silent)
    M._run_analyze_inner(_upload_job().id)

    def broken(**kw):
        raise ValueError("nothing to apply")
    monkeypatch.setattr(M, "analyze_only", broken)
    M._run_analyze_inner(_upload_job().id)

    # Two renders: one done, one failing.
    monkeypatch.setattr(M.pipeline, "render_to_keys", _ok_render)
    done = _render_job()
    M._run_render_inner(done.id, [], requested_at=time.time() - 3.0)

    def boom(**kw):
        raise pipeline.RenderUnavailableError("gave up", code="render_timeout")
    monkeypatch.setattr(M.pipeline, "render_to_keys", boom)
    M._run_render_inner(_render_job().id, [])

    kinds = [e["kind"] for e in store.events(time.time() - 60)]
    assert sorted(kinds) == ["analysis_done", "analysis_failed",
                             "analysis_failed", "render_done",
                             "render_failed"]
    rendered = store.events(time.time() - 60, kinds=["render_done"])[0]
    assert rendered["job_id"] == done.id
    data = rendered["data"]
    assert data["output_s"] == pytest.approx(4.0 / 2 + 2.0)  # speed 2 on clip 1
    assert data["wall_s"] >= 3.0 and data["work_s"] < data["wall_s"]
    assert data["gen"] == 1 and data["test"] is False

    m = _metrics(client)
    assert m["analysis"] == {
        "done": 1, "failed": 1, "user_caused": 1, "success_rate": 0.5,
        "by_code": {"no_speech": 1, "unknown": 1}}
    assert m["render"]["done"] == 1 and m["render"]["failed"] == 1
    assert m["render"]["success_rate"] == 0.5
    assert m["render"]["by_code"] == {"render_timeout": 1}
    assert m["render"]["samples"] == 1
    assert m["render"]["p50_ratio"] == pytest.approx(data["wall_s"] / 4.0,
                                                     abs=0.01)
    assert m["gates"]["analysis_success"]["ok"] is False
    assert m["gates"]["render_p50_ratio"]["ok"] is True


def test_refused_uploads_are_not_analysis_failures(client, admin,
                                                   monkeypatch):
    job = _upload_job({"_measure_length": True})
    monkeypatch.setattr(M, "_probe_duration", lambda p: 99999.0)
    M._run_analyze_inner(job.id)
    assert store.get(job.id).error_code == "video_too_long"
    assert [e["kind"] for e in store.events(0)] == ["analysis_refused"]
    m = _metrics(client)
    assert m["analysis"]["done"] == m["analysis"]["failed"] == 0


# ── the numbers ──────────────────────────────────────────────────────


def _ev(kind, **data):
    return {"kind": kind, "at": time.time(), "job_id": "j", "data": data}


def test_summary_math():
    events = (
        [_ev("analysis_done")] * 97
        + [_ev("analysis_failed", code="unknown")] * 3
        + [_ev("analysis_failed", code="no_audio")] * 5     # user-caused
        + [_ev("render_done", wall_s=w, work_s=w - 1, output_s=10.0)
           for w in (4, 6, 8, 10, 30)]
        + [_ev("render_done", wall_s=5)]                     # no length
        + [_ev("render_failed", code="render_failed")]
    )
    m = M.metrics_summary(events, days=14, since=0.0, until=1.0)
    assert m["analysis"]["success_rate"] == 0.97
    assert m["analysis"]["user_caused"] == 5
    assert m["gates"]["analysis_success"] == {"target": 0.97, "value": 0.97,
                                              "ok": True}
    assert m["render"]["success_rate"] == round(6 / 7, 4)
    assert m["gates"]["render_success"]["ok"] is False
    assert m["render"]["samples"] == 5
    assert m["render"]["p50_ratio"] == 0.8          # 8 s / 10 s
    assert m["render"]["p90_ratio"] == 3.0
    assert m["render"]["p50_work_ratio"] == 0.7
    assert m["render"]["p50_wall_s"] == 6.0         # of all 6 renders
    assert m["gates"]["render_p50_ratio"]["ok"] is True


def test_window_and_cost_tests(client, admin):
    now = time.time()
    store.record_event("render_done", "old", {"wall_s": 1, "output_s": 1},
                       at=now - 20 * 86400)
    store.record_event("render_done", "new", {"wall_s": 2, "output_s": 1})
    store.record_event("render_failed", "cost", {"code": "render_failed",
                                                 "test": True})
    m = _metrics(client)
    assert (m["render"]["done"], m["render"]["failed"]) == (1, 0)
    m = _metrics(client, days=30, include_tests=True)
    assert (m["render"]["done"], m["render"]["failed"]) == (2, 1)
    assert _metrics(client, days=1000)["days"] == 90   # EVENTS_KEEP_DAYS


def test_events_are_pruned(admin):
    now = time.time()
    store.record_event("render_done", "a", {}, at=now - 100 * 86400)
    store.record_event("render_done", "b", {}, at=now - 10)
    assert store.prune_events(now - 90 * 86400) == 1
    assert [e["job_id"] for e in store.events(0)] == ["b"]


def test_recording_never_fails_a_job(monkeypatch):
    def down(*a, **kw):
        raise RuntimeError("database down")
    monkeypatch.setattr(store, "record_event", down)
    M._record_event("render_done", None, wall_s=1.0)   # no exception


def test_sentry_test_endpoint(client, admin):
    r = client.post("/admin/sentry-test", headers=TOKEN)
    assert r.status_code == 200
    assert r.json()["sentry"] is False               # no SENTRY_DSN in tests
    assert client.post("/admin/sentry-test").status_code == 401
