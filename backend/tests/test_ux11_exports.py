"""UX11: exports after the first one — re-edit (POST /reopen), the
fair-use ledger (charge after the free exports, refund on failure), the
caps, the instant export of a speculative render, the bonus-clip gate,
the post text, SRT / VTT and download names, the survey.

Renders are faked at pipeline.render_to_keys; they run the real render
paths around it — the WP1 thread, or the task queue's worker with
CLEO_TEST_QUEUE=1 (conftest's leader) — so both commits are covered."""
from __future__ import annotations

import threading
import time

import pytest

import backend.main as M
from backend import accounts, captions_v2, exports, llm, pipeline
from backend.jobs import store
from conftest import TEST_QUEUE, add_sub

UNITS = [
    {"start": 0.2, "end": 0.6, "text": "Hello"},
    {"start": 0.6, "end": 1.0, "text": "world."},
    {"start": 2.2, "end": 2.6, "text": "Second"},
    {"start": 2.6, "end": 3.1, "text": "sentence"},
    {"start": 6.0, "end": 6.5, "text": "cut"},
]


V2_BODY = {"subtitles": UNITS, "client": "v2"}


def _wait_for(pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _settled(job_id: str, status: str, timeout=15.0) -> bool:
    """`status` reached and the worker let go of the job (WP1 thread or
    the queue's task finalized)."""
    def ok():
        job = store.get(job_id)
        if job is None or job.status != status:
            return False
        if TEST_QUEUE:
            return all(t.finalized_at for t in store.tasks.for_job(job_id))
        return job_id not in M._active_jobs
    return _wait_for(ok, timeout)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("CLEO_FREE_RENDERS", "CLEO_RENDER_FAIRUSE_PCT",
              "CLEO_MAX_RENDERS_PER_USER", "CLEO_MAX_RENDER_QUEUE",
              "CLEO_MAX_RENDERS_PER_JOB_DAY", "CLEO_SPECULATIVE_RENDER"):
        monkeypatch.delenv(k, raising=False)
    # No LLM: a fixed post text (it shows whether the render made one).
    monkeypatch.setattr(llm, "generate_social_caption",
                        lambda text, language=None: {"caption": "from render",
                                                     "hashtags": ["x"]})
    monkeypatch.setattr(llm, "detect_hook_moments",
                        lambda lines, language=None: [])


class FakeRender:
    """pipeline.render_to_keys: records its calls; outputs under the
    render's own prefix (a format aliasing the primary); `fail` raises,
    `gate` (an Event) holds it."""

    def __init__(self):
        self.calls: list[dict] = []
        self.fail = False
        self.gate: threading.Event | None = None

    def __call__(self, **kw):
        self.calls.append(kw)
        if self.gate is not None:
            assert self.gate.wait(20)
        if self.fail:
            raise RuntimeError("encoder exploded")
        p = kw["out_prefix"]
        return {"outputs": {"primary": {"key": p + "primary.mp4", "size": 7},
                            "9:16": {"key": p + "primary.mp4", "size": 7},
                            "1:1": {"key": p + "1x1.mp4", "size": 3}},
                "thumb": {"key": p + "thumb.jpg", "size": 2}, "hooks": []}


@pytest.fixture
def render(monkeypatch):
    fake = FakeRender()
    monkeypatch.setattr(pipeline, "render_to_keys", fake)
    yield fake
    if fake.gate is not None:
        fake.gate.set()


def _review_job(owner=None, duration=10.0, **fields):
    job = store.create(None, {}, filename=fields.pop("filename", "Mein Take.mov"),
                       owner_id=owner)
    segs = [(0.0, 4.0), (5.0, 10.0)]
    base = dict(status="awaiting_review", segments=segs, duration=duration,
                subtitles=[dict(u) for u in UNITS], language="en",
                mezz_key=f"jobs/{job.id}/mezz.mp4", render_gen=0,
                analysis_segments_hash=exports.segments_hash(segs))
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


def _export(client, job_id, headers=None, subtitles=UNITS, status="done",
            client_marker="v2"):
    """An export as the v2 export sheet sends it ({"client": "v2"}: the
    UX11 rules apply); client_marker=None: a v1 export."""
    body = {"subtitles": subtitles}
    if client_marker:
        body["client"] = client_marker
    r = client.post(f"/jobs/{job_id}/render", json=body,
                    headers=headers or {})
    assert r.status_code == 200, r.text
    assert _settled(job_id, status), store.get(job_id).status
    return r.json()


def _reopen(client, job_id, headers=None):
    r = client.post(f"/jobs/{job_id}/reopen", headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


# ── re-edit ──────────────────────────────────────────────────────────


def test_reopen_keeps_the_export_and_a_rerender_replaces_it(client, render):
    job = _review_job()
    first = _export(client, job.id)
    assert first["gen"] == 1 and first["cost_seconds"] == 0
    done = store.get(job.id)
    assert done.renders_ok == 1 and done.export_captions
    old_keys = dict(done.output_keys)
    body = client.get(f"/jobs/{job.id}").json()
    # One download per distinct file (9:16 aliases the primary).
    assert body["downloads"] == [{"format": "primary", "bytes": 7},
                                 {"format": "1:1", "bytes": 3}]
    assert body["renders_ok"] == 1 and body["has_captions_file"] is True
    assert body["download_names"]["primary"] == "mein_take_cleocuts.mp4"
    assert body["output_aspect"] == "original"
    # Billing off: no counter, nothing to pay.
    assert body["free_renders_left"] is None
    assert body["next_render_cost_seconds"] == 0

    reopened = _reopen(client, job.id)
    assert reopened["status"] == "awaiting_review"
    cur = store.get(job.id)
    assert cur.output_keys == old_keys       # still downloadable
    assert client.get(f"/jobs/{job.id}/download",
                      follow_redirects=False).status_code in (200, 307, 409)
    assert reopened["outputs"] and reopened["has_output"] is True

    second = _export(client, job.id)
    assert second["gen"] == 2
    cur = store.get(job.id)
    assert cur.renders_ok == 2
    assert all(k.startswith(f"jobs/{job.id}/r2/") for k in cur.output_keys.values())
    # The previous export goes a day later (someone may still stream it).
    rows = [r for r in store.gc_all() if r["prefix"] == f"jobs/{job.id}/r1/"]
    assert rows and rows[0]["not_before"] > time.time() + 86000
    assert [e["kind"] for e in store.events(0, ["reopened"])] == ["reopened"]


def test_reopen_refusals(client, monkeypatch):
    job = _review_job()
    assert _reopen(client, job.id)["status"] == "awaiting_review"   # idempotent
    store.update(job.id, status="processing")
    r = client.post(f"/jobs/{job.id}/reopen")
    assert (r.status_code, r.json()["code"]) == (409, "busy")
    store.update(job.id, status="error")
    r = client.post(f"/jobs/{job.id}/reopen")
    assert (r.status_code, r.json()["code"]) == (409, "not_editable")
    store.update(job.id, status="done", mezz_key=None, normalized_path=None)
    r = client.post(f"/jobs/{job.id}/reopen")
    assert (r.status_code, r.json()["code"]) == (409, "media_unavailable")
    store.update(job.id, mezz_key=f"jobs/{job.id}/mezz.mp4")
    monkeypatch.setattr(M.Job, "expires_at", lambda self: time.time() - 5)
    r = client.post(f"/jobs/{job.id}/reopen")
    assert (r.status_code, r.json()["code"]) == (410, "media_expired")
    assert store.get(job.id).status == "done"


def test_reopen_vs_a_concurrent_render(client, render):
    """The CAS: a render that started (job processing) can't be reopened
    under it; two reopens of a done job both land in review once."""
    job = _review_job()
    render.gate = threading.Event()
    r = client.post(f"/jobs/{job.id}/render", json=V2_BODY)
    assert r.status_code == 200
    r = client.post(f"/jobs/{job.id}/reopen")
    assert (r.status_code, r.json()["code"]) == (409, "busy")
    render.gate.set()
    assert _settled(job.id, "done")
    results = []
    threads = [threading.Thread(target=lambda: results.append(
        client.post(f"/jobs/{job.id}/reopen").status_code)) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [200, 200]
    assert store.get(job.id).status == "awaiting_review"


def test_failed_rerender_keeps_the_previous_export(client, render):
    job = _review_job()
    _export(client, job.id)
    keys = dict(store.get(job.id).output_keys)
    _reopen(client, job.id)
    render.fail = True
    _export(client, job.id, status="awaiting_review")
    cur = store.get(job.id)
    assert cur.error_code == "render_failed" and cur.output_keys == keys
    assert cur.renders_ok == 1                  # failures never count


def test_caption_engine_stays_pinned_through_reedit(client, render):
    """UT4 F11: a project keeps the engine of its first render. One
    exported before UT4 (no pin, outputs) renders — and pins — v1."""
    job = _review_job(output_keys={"primary": "jobs/x/r1/p.mp4"},
                      status="done", render_gen=1, doc={"words": []})
    _reopen(client, job.id)
    cur = store.get(job.id)
    assert captions_v2.decide(cur)[0] == "v1"
    _export(client, job.id)
    assert store.get(job.id).caption_engine == "v1"
    _reopen(client, job.id)
    assert captions_v2.decide(store.get(job.id)) == ("v1", "pinned")


# ── fair use ─────────────────────────────────────────────────────────


@pytest.fixture
def paying(billing_on, bearer):
    add_sub(user_id="user_a", plan="pro")
    return bearer


def _fairuse_job(seconds=120):
    job = _review_job(owner="user_a", duration=float(seconds))
    accounts.charge(job.id, "user_a", seconds, enforce=False)  # the upload
    return job


def _usage_rows(job_id):
    return {k: accounts.get_usage(k) for k in
            (exports.usage_key(job_id, g) for g in range(1, 8))
            if accounts.get_usage(k)}


def test_three_free_then_25_percent_once_per_export(client, render, paying):
    h = paying()
    job = _fairuse_job(120)
    seen = []
    for n in range(1, 5):
        before = client.get(f"/jobs/{job.id}", headers=h).json()
        seen.append((before["free_renders_left"],
                     before["next_render_cost_seconds"]))
        out = _export(client, job.id, headers=h)
        assert out["cost_seconds"] == (30 if n == 4 else 0)
        _reopen(client, job.id, headers=h)
    assert seen == [(3, 0), (2, 0), (1, 0), (0, 30)]
    rows = _usage_rows(job.id)
    assert list(rows) == [f"{job.id}#r4"]
    assert rows[f"{job.id}#r4"]["seconds_billed"] == 30
    assert rows[f"{job.id}#r4"]["user_id"] == "user_a"
    body = client.get(f"/jobs/{job.id}", headers=h).json()
    assert body["fair_use"] == {"billed": True, "free_total": 3, "pct": 25.0,
                                "basis_seconds": 120.0}


def test_failed_paid_export_is_refunded(client, render, paying):
    h = paying()
    job = _fairuse_job(60)
    store.update(job.id, renders_ok=3)
    render.fail = True
    out = _export(client, job.id, headers=h, status="awaiting_review")
    # 15 if the charge landed before the failure, 0 if the failure won
    # the race (the charge refunds itself then): refunded either way.
    assert out["cost_seconds"] in (0, 15)
    row = accounts.get_usage(exports.usage_key(job.id, out["gen"]))
    assert row["refunded"]
    # The next (successful) export charges its own key once.
    render.fail = False
    out2 = _export(client, job.id, headers=h)
    assert out2["gen"] == out["gen"] + 1 and out2["cost_seconds"] == 15
    assert not accounts.get_usage(exports.usage_key(job.id, out2["gen"]))["refunded"]


def test_fair_use_never_blocks_over_quota(client, render, paying):
    h = paying()
    job = _fairuse_job(60)
    accounts.charge("other", "user_a", 10 ** 7, enforce=False)   # all used up
    store.update(job.id, renders_ok=5)
    out = _export(client, job.id, headers=h)
    assert out["cost_seconds"] == 15 and store.get(job.id).status == "done"


def test_billing_off_and_service_user_are_free(client, render, monkeypatch,
                                               billing_on):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    job = _review_job(owner="user_a", renders_ok=7)
    out = _export(client, job.id, headers={"X-Admin-Token": "s3cret"})
    assert out["cost_seconds"] == 0 and out["free_renders_left"] is None
    assert _usage_rows(job.id) == {}


def test_charge_is_a_noop_without_billing(client, render):
    job = _review_job(renders_ok=9)
    assert _export(client, job.id)["cost_seconds"] == 0
    assert _usage_rows(job.id) == {}


def test_cost_rounds_up_and_pct_is_configurable(monkeypatch):
    monkeypatch.setenv("CLEO_RENDER_FAIRUSE_PCT", "25")
    assert exports.render_cost_seconds(181) == 46       # ceil(45.25)
    monkeypatch.setenv("CLEO_FREE_RENDERS", "1")
    assert exports.next_render_cost(0, 100) == 0
    assert exports.next_render_cost(1, 100) == 25


# ── caps ─────────────────────────────────────────────────────────────


def test_second_parallel_export_of_a_user_is_refused(client, render, auth_on,
                                                     bearer):
    h = bearer()
    a, b = _review_job(owner="user_a"), _review_job(owner="user_a")
    render.gate = threading.Event()
    assert client.post(f"/jobs/{a.id}/render", json=V2_BODY,
                       headers=h).status_code == 200
    r = client.post(f"/jobs/{b.id}/render", json=V2_BODY,
                    headers=h)
    assert (r.status_code, r.json()["code"]) == (429, "too_many_renders")
    assert store.get(b.id).status == "awaiting_review"
    # Another account isn't affected.
    c = _review_job(owner="user_b")
    assert client.post(f"/jobs/{c.id}/render", json=V2_BODY,
                       headers=bearer("user_b")).status_code == 200
    render.gate.set()
    assert _settled(a.id, "done") and _settled(c.id, "done")


def test_daily_cap_per_video(client, render, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_RENDERS_PER_JOB_DAY", "2")
    now = time.time()
    job = _review_job(render_times=[now - 90000, now - 60, now - 30])
    r = client.post(f"/jobs/{job.id}/render", json=V2_BODY)
    assert (r.status_code, r.json()["code"]) == (429, "render_limit")
    store.update(job.id, render_times=[now - 90000, now - 60])
    _export(client, job.id)
    assert len(exports.recent_renders(store.get(job.id).render_times)) == 2


def test_render_queue_cap(client, render, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_RENDER_QUEUE", "3")
    monkeypatch.setattr(M, "_render_backlog", lambda: 3)
    job = _review_job()
    r = client.post(f"/jobs/{job.id}/render", json=V2_BODY)
    assert (r.status_code, r.json()["code"]) == (503, "server_busy")
    assert r.headers["retry-after"] == "120"


# ── speculative render: the instant export ──────────────────────────


@pytest.fixture
def spec_on(monkeypatch):
    monkeypatch.setenv("CLEO_SPECULATIVE_RENDER", "1")
    monkeypatch.setattr(captions_v2, "decide", lambda job, style=None: (
        (job.caption_engine, "pinned") if job.caption_engine
        else ("v2", "test")))
    prepared = []

    def prepare(store_, job_id, job, subtitles):
        prepared.append(job_id)
        return {"words": [], "test": True}
    monkeypatch.setattr(captions_v2, "prepare_render", prepare)
    return prepared


def _spec_done(job_id):
    return _wait_for(lambda: (store.get(job_id).spec or {}).get("status")
                     in ("done", "failed"))


def test_instant_export_when_nothing_changed(client, render, spec_on, paying,
                                            monkeypatch):
    monkeypatch.setenv("CLEO_FREE_RENDERS", "0")      # an export would cost
    h = paying()
    job = _fairuse_job(60)
    assert client.get(f"/jobs/{job.id}", headers=h).json()[
        "next_render_cost_seconds"] == 15
    assert M._maybe_speculate(job.id)
    assert _spec_done(job.id)
    cur = store.get(job.id)
    assert cur.status == "awaiting_review" and cur.spec["status"] == "done"
    assert cur.caption_engine == "v2" and cur.render_gen == 1
    assert client.get(f"/jobs/{job.id}", headers=h).json()["spec_ready"] is True
    r = client.post(f"/jobs/{job.id}/render",
                    json={"subtitles": exports.analysis_units(cur), "client": "v2"},
                    headers=h)
    body = r.json()
    assert r.status_code == 200 and body["instant"] is True
    assert body["status"] == "done" and body["cost_seconds"] == 0
    cur = store.get(job.id)
    assert cur.renders_ok == 0 and _usage_rows(job.id) == {}
    assert cur.output_keys["primary"] == f"jobs/{job.id}/r1/primary.mp4"
    assert cur.export_captions and cur.spec["status"] == "promoted"
    assert len(render.calls) == 1                        # no second render
    assert [e["kind"] for e in store.events(0, ["render_instant"])] == [
        "render_instant"]


def test_no_instant_export_after_an_edit(client, render, spec_on):
    job = _review_job()
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    store.update(job.id, doc_rev=5)                       # an editor save
    assert client.get(f"/jobs/{job.id}").json()["spec_ready"] is False
    out = _export(client, job.id)
    assert out["instant"] is False and out["gen"] == 2
    cur = store.get(job.id)
    assert cur.spec["status"] == "stale" and len(render.calls) == 2
    # The unused speculative files go.
    assert f"jobs/{job.id}/r1/" in [r["prefix"] for r in store.gc_all()]


def test_no_instant_export_for_other_captions(client, render, spec_on):
    job = _review_job()
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    edited = [dict(u) for u in UNITS]
    edited[0]["text"] = "Hallo"
    assert _export(client, job.id, subtitles=edited)["instant"] is False


def test_speculative_render_dropped_when_exports_wait(render, spec_on,
                                                      monkeypatch):
    monkeypatch.setenv("CLEO_MAX_RENDER_QUEUE", "4")
    monkeypatch.setattr(M, "_render_backlog", lambda: 3)
    job = _review_job()
    assert M._maybe_speculate(job.id) is False
    assert store.get(job.id).spec is None and render.calls == []


def test_speculative_render_only_for_v2_and_only_when_on(render, monkeypatch):
    job = _review_job()
    assert M._maybe_speculate(job.id) is False           # switched off
    monkeypatch.setenv("CLEO_SPECULATIVE_RENDER", "1")
    assert M._maybe_speculate(job.id) is False           # v1 job
    assert store.get(job.id).spec is None


def test_failed_speculative_render_leaves_the_job_as_it_was(client, render,
                                                            spec_on):
    """Review C: its r1/ is queued for deletion, so the first real export
    takes r2/ (never the deleted generation), and the engine is decided
    as if there had been no speculative render."""
    job = _review_job(doc={"words": []})
    render.fail = True
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    cur = store.get(job.id)
    assert cur.spec["status"] == "failed"
    assert (cur.render_gen, cur.caption_engine) == (1, None)
    assert cur.status == "awaiting_review"
    assert f"jobs/{job.id}/r1/" in [r["prefix"] for r in store.gc_all()]
    render.fail = False
    out = _export(client, job.id)
    assert out["gen"] == 2
    keys = store.get(job.id).output_keys.values()
    assert all(k.startswith(f"jobs/{job.id}/r2/") for k in keys)
    assert f"jobs/{job.id}/r2/" not in [r["prefix"] for r in store.gc_all()]
    # Not "exported before" because of the speculative generation.
    fresh = store.get(job.id)
    fresh.output_keys, fresh.render_gen = {}, 2
    assert captions_v2.exported_before(fresh) is False


def test_speculative_render_is_exempt_from_the_user_cap(client, render,
                                                        spec_on, auth_on,
                                                        bearer):
    h = bearer()
    a, b = _review_job(owner="user_a"), _review_job(owner="user_a")
    render.gate = threading.Event()
    assert M._maybe_speculate(a.id)
    _wait_for(lambda: len(render.calls) == 1)
    # The speculative render of a doesn't count as an export of user_a.
    assert client.post(f"/jobs/{b.id}/render", json=V2_BODY,
                       headers=h).status_code == 200
    render.gate.set()
    assert _settled(b.id, "done") and _spec_done(a.id)


# ── bonus clips (review G6) ──────────────────────────────────────────


def test_bonus_clips_only_for_an_untouched_long_timeline(client, render):
    long = _review_job(duration=200.0, segments=[(0.0, 120.0)],
                       analysis_segments_hash=exports.segments_hash([(0.0, 120.0)]))
    _export(client, long.id)
    assert render.calls[-1]["settings"].get("hook_clips_enabled", True) is True
    _reopen(client, long.id)
    store.update(long.id, segments=[(0.0, 100.0)])           # edited
    _export(client, long.id)
    assert render.calls[-1]["settings"]["hook_clips_enabled"] is False
    short = _review_job()                                    # 9 s output
    _export(client, short.id)
    assert render.calls[-1]["settings"]["hook_clips_enabled"] is False


def test_hooks_gate_keeps_legacy_jobs():
    class J:
        analysis_segments_hash = None
        segments = [(0.0, 100.0)]
        settings: dict = {}
    assert exports.hooks_allowed(J(), 100.0) is True
    assert exports.hooks_allowed(J(), 50.0) is False


# ── post text, captions files, names, survey ────────────────────────


def test_post_text_saved_by_the_user(client, render):
    job = _review_job()
    _export(client, job.id)
    r = client.post(f"/jobs/{job.id}/social-caption",
                    json={"text": "  my own text \r\n#tag "})
    assert r.json() == {"text": "my own text \n#tag"}
    body = client.get(f"/jobs/{job.id}").json()
    assert body["social_caption_edited"] == "my own text \n#tag"
    assert body["social_caption"] == "from render"
    assert client.post(f"/jobs/{job.id}/social-caption",
                       json={"text": 5}).status_code == 400


def test_post_text_follows_the_edited_transcript(client, render, monkeypatch):
    """Review B: made at render from the export's transcript; a v2
    re-export with the same transcript and cut keeps it (no LLM call),
    a changed transcript makes it again; v1 makes it every time."""
    calls = []

    def social(text, language=None):
        calls.append(text)
        return {"caption": f"about: {text}", "hashtags": []}
    monkeypatch.setattr(llm, "generate_social_caption", social)
    job = _review_job()
    _export(client, job.id)
    assert store.get(job.id).social_caption.startswith("about: Hello")
    _reopen(client, job.id)
    _export(client, job.id)                       # same transcript: kept
    assert len(calls) == 1
    _reopen(client, job.id)
    edited = [dict(u) for u in UNITS]
    edited[0]["text"] = "Goodbye"
    _export(client, job.id, subtitles=edited)
    assert len(calls) == 2
    assert store.get(job.id).social_caption.startswith("about: Goodbye")
    _reopen(client, job.id)
    _export(client, job.id, subtitles=edited, client_marker=None)   # v1
    assert len(calls) == 3


def test_render_makes_the_post_text_when_there_is_none(client, render):
    job = _review_job()
    _export(client, job.id)
    assert store.get(job.id).social_caption == "from render"


def test_srt_and_vtt_follow_the_cut(client, render):
    job = _review_job()
    _export(client, job.id)
    srt = client.get(f"/jobs/{job.id}/captions.srt")
    assert srt.status_code == 200
    assert srt.headers["content-type"].startswith("application/x-subrip")
    assert 'filename="mein_take_cleocuts.srt"' in srt.headers["content-disposition"]
    # Kept: 0–4 s and 5–10 s; "cut" (6.0 s) lands at 5.0 s in the output.
    assert srt.text == (
        "1\n00:00:00,200 --> 00:00:01,000\nHello world.\n\n"
        "2\n00:00:02,200 --> 00:00:03,100\nSecond sentence\n\n"
        "3\n00:00:05,000 --> 00:00:05,500\ncut\n")
    vtt = client.get(f"/jobs/{job.id}/captions.vtt")
    assert vtt.text.startswith("WEBVTT\n\n00:00:00.200 --> 00:00:01.000\nHello world.")
    other = _review_job()
    assert client.get(f"/jobs/{other.id}/captions.srt").status_code == 409


def test_caption_cues_wrap_and_split():
    words = [{"text": "word%d" % i, "start": i * 0.3, "end": i * 0.3 + 0.25}
             for i in range(30)]
    snap = {"units": [[w["text"], w["start"], w["end"]] for w in words],
            "clips": [[0.0, 20.0, 1.0]], "offset_ms": 0}
    cues = exports.caption_cues(snap)
    for s, e, lines in cues:
        assert len(lines) <= 2 and all(len(x) <= 42 for x in lines)
        assert e - s <= exports.CUE_MAX_S + 0.3
    assert sum(len(" ".join(ls).split()) for _, _, ls in cues) == 30
    assert all(cues[i][1] <= cues[i + 1][0] for i in range(len(cues) - 1))
    assert exports.to_vtt([(0, 1, ["a <b> --> c"])]).endswith(
        "a &lt;b> → c\n")


@pytest.mark.parametrize("title,fmt,aspect,want", [
    ("Mein Take 3.mov", "primary", "9:16", "mein_take_3_cleocuts_9x16.mp4"),
    ("Über Größe – Teil 2.MP4", "16:9", "9:16", "uber_grosse_teil_2_cleocuts_16x9.mp4"),
    ("Привет мир.mp4", "primary", "original", "privet_mir_cleocuts.mp4"),
    ("動画テスト.mp4", "primary", "9:16", "video_2026-09-30_cleocuts_9x16.mp4"),
    (None, "hook_2", "9:16", "video_2026-09-30_cleocuts_clip_2.mp4"),
    ("İstanbul çekimi.mov", "primary", None, "istanbul_cekimi_cleocuts.mp4"),
])
def test_download_names(title, fmt, aspect, want):
    created = time.mktime(time.strptime("2026-09-30 12:00", "%Y-%m-%d %H:%M"))
    assert exports.download_name(title, fmt, aspect, created) == want


def test_download_route_uses_the_project_name(client, render, no_r2):
    job = _review_job(filename="Привет мир.mp4", settings={"target_aspect": "9:16"})
    _export(client, job.id)
    store.update(job.id, output_keys={})          # legacy local file path
    out = M._WORK_ROOT / "ux11" / job.id
    out.mkdir(parents=True, exist_ok=True)
    (out / "cleo_output.mp4").write_bytes(b"mp4")
    store.update(job.id, output_path=str(out / "cleo_output.mp4"),
                 outputs={"primary": str(out / "cleo_output.mp4")})
    r = client.get(f"/jobs/{job.id}/download", params={"name": "v2"})
    assert r.status_code == 200
    assert 'filename="privet_mir_cleocuts_9x16.mp4"' in r.headers["content-disposition"]
    # Without it: the name of before UX11.
    r = client.get(f"/jobs/{job.id}/download")
    assert f'filename="cleo_{job.id}_primary.mp4"' in r.headers["content-disposition"]


def test_feedback_survey(client):
    job = _review_job()
    r = client.post("/feedback", json={"kind": "post_export", "job_id": job.id,
                                       "answer": "yes", "text": "CapCut " * 100})
    assert r.status_code == 204
    [ev] = store.events(0, ["feedback_post_export"])
    assert ev["job_id"] == job.id and ev["data"]["answer"] == "yes"
    assert len(ev["data"]["text"]) == 300
    assert client.post("/feedback", json={"kind": "spam"}).status_code == 400
    assert client.post("/feedback", json={"kind": "post_export",
                                          "answer": "maybe"}).status_code == 400
    assert client.post("/feedback", json={"kind": "post_export",
                                          "job_id": "nope00000000"}).status_code == 404


# ── the v2 editor's payload shape (doc words → units) ───────────────


def test_doc_units_match_the_shared_vectors():
    """exports.doc_units is the twin of doc.ts captionUnits: the same
    units for the unedited doc as testdata/caption_units_vectors.json
    (which the web's vitest checks too)."""
    import json
    from conftest import REPO
    vectors = json.loads((REPO / "testdata" / "caption_units_vectors.json")
                         .read_text())["vectors"]
    for v in vectors:
        got = [[u["text"], round(u["original_start"], 3), round(u["original_end"], 3)]
               for u in exports.doc_units(v["words"])]
        want = [[u["text"], round(u.get("original_start", u["start"]), 3),
                 round(u.get("original_end", u["end"]), 3)] for u in v["units"]]
        assert got == want, v["name"]


def test_instant_export_takes_the_v2_editors_payload(client, render, spec_on):
    words = [{"id": "w1", "text": "Hello", "start": 0.2, "end": 0.6},
             {"id": "w2", "text": "um", "start": 0.6, "end": 0.8, "hidden": True},
             {"id": "w3", "text": "world.", "start": 0.8, "end": 1.0},
             {"id": "w4", "text": "So", "start": 2.2, "end": 2.4},
             {"id": "w5", "text": "great", "start": 2.4, "end": 2.9}]
    job = _review_job(doc={"words": words, "style": {"presetId": "power",
                                                     "overrides": {}}})
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    payload = exports.doc_units(words)
    assert [u["text"] for u in payload] == ["Hello", "world.", "So great"]
    out = _export(client, job.id, subtitles=payload)
    assert out["instant"] is True and len(render.calls) == 1


def test_instant_export_takes_the_words_that_play(client, render, spec_on):
    """UX10's export source leaves out words in cut ranges (the job's
    timeline keeps 0–4 s and 5–10 s) and never glues across a cut."""
    words = [{"id": "w1", "text": "So", "start": 3.5, "end": 3.7},
             {"id": "w2", "text": "uh", "start": 4.3, "end": 4.6},
             {"id": "w3", "text": "great", "start": 5.2, "end": 5.6}]
    job = _review_job(doc={"words": words, "style": {"presetId": "power",
                                                     "overrides": {}}})
    assert exports.removed_ranges(job.segments, job.duration) == [(4.0, 5.0)]
    payload = exports.doc_units(words, [(4.0, 5.0)])
    assert [u["text"] for u in payload] == ["So", "great"]
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    assert _export(client, job.id, subtitles=payload)["instant"] is True


# ── review fixes: v1 parity, restart refund, charge race ───────────


def test_v1_export_is_unchanged(client, render, paying, monkeypatch):
    """Review A: without {"client": "v2"} an export behaves as before
    UX11 — no per-account / daily / queue caps, no bonus-clip gate, no
    fair-use charge, the post text made every time, the old file name."""
    h = paying()
    monkeypatch.setenv("CLEO_MAX_RENDERS_PER_JOB_DAY", "1")
    monkeypatch.setenv("CLEO_MAX_RENDER_QUEUE", "1")
    monkeypatch.setattr(M, "_render_backlog", lambda: 5)
    now = time.time()
    a = _fairuse_job(60)
    store.update(a.id, renders_ok=9, render_times=[now - 10, now - 5],
                 segments=[(0.0, 50.0)])            # an edited cut, 50 s
    b = _review_job(owner="user_a")
    render.gate = threading.Event()
    assert client.post(f"/jobs/{a.id}/render", json={"subtitles": UNITS},
                       headers=h).status_code == 200
    # a second export of the same account at once: queued, not refused
    assert client.post(f"/jobs/{b.id}/render", json={"subtitles": UNITS},
                       headers=h).status_code == 200
    render.gate.set()
    assert _settled(a.id, "done") and _settled(b.id, "done")
    first = next(c for c in render.calls if c["job_id"] == a.id)
    assert first["settings"] == store.get(a.id).settings     # as stored
    assert "hook_clips_enabled" not in first["settings"]
    assert _usage_rows(a.id) == {}                           # no charge
    assert store.get(a.id).export_client is None
    assert store.get(a.id).render_times == [now - 10, now - 5]
    names = []
    monkeypatch.setattr(M, "_media", lambda job, key, mt, nr, download_name=None,
                        cache=None: names.append(download_name) or {})
    client.get(f"/jobs/{a.id}/download", headers=h)
    client.get(f"/jobs/{a.id}/download", params={"name": "v2"}, headers=h)
    assert names[0] == f"cleo_{a.id}_primary.mp4"            # as before
    assert names[1] == "mein_take_cleocuts.mp4"


def test_v1_export_never_takes_a_speculative_render(client, render, spec_on):
    job = _review_job()
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    out = _export(client, job.id, subtitles=exports.analysis_units(store.get(job.id)),
                  client_marker=None)
    assert out["instant"] is False and len(render.calls) == 2


def test_restart_refunds_an_interrupted_paid_export(paying):
    """Review D: the WP1 boot sends an interrupted export back to review
    and refunds its fair-use charge (idempotent by its ledger key)."""
    job = _fairuse_job(60)
    store.update(job.id, status="processing", render_gen=4)
    key = exports.usage_key(job.id, 4)
    accounts.charge(key, "user_a", 15, enforce=False)
    assert M._mark_stuck_and_refund() == 1
    assert store.get(job.id).status == "awaiting_review"
    assert accounts.get_usage(key)["refunded"]
    assert accounts.get_usage(job.id)["refunded"] in (False, 0, None)
    M._refund_render(job.id, 4)                    # again: no change
    assert accounts.get_usage(key)["refunded"]


def test_a_charge_after_a_fast_failure_refunds_itself(paying, bearer):
    """Review E: the render failed before the charge landed — the charge
    sees it and refunds itself."""
    job = _fairuse_job(60)
    store.update(job.id, renders_ok=5, render_gen=3, status="awaiting_review",
                 error_code="render_failed")
    user = M.auth.User(id="user_a")
    assert M._charge_render(job.id, user, 3, 5) == 0
    assert accounts.get_usage(exports.usage_key(job.id, 3))["refunded"]
    # still rendering: the charge stays
    store.update(job.id, status="processing", render_gen=4)
    assert M._charge_render(job.id, user, 4, 5) == 15
    assert not accounts.get_usage(exports.usage_key(job.id, 4))["refunded"]
