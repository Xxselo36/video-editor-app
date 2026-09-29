"""WP3: renders on media keys (Modal render_r2 faked like in
test_modal_robustness.py; the local fallback), media GC (delete →
rows → objects, retries, not_before, the orphan sweep) and the backfill
of legacy local jobs. R2 is moto, in-process."""
from __future__ import annotations

import ast
import logging
import os
import sys
import threading
import time
import types
from pathlib import Path

import pytest

import backend.main as M
from backend import pipeline, r2_backfill, storage
from backend.jobs import store
from conftest import REPO


def _wait_for(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


class AuthError(Exception):
    """Same class name as modal.exception.AuthError."""


class FakeR2Modal:
    """modal.Function.from_name("cleocuts-render", "render_r2"): spawn()
    records its arguments and — like the real function — writes the
    outputs to R2; `plan` holds an outcome per spawn ("ok" or an
    exception spawn / get raises)."""

    def __init__(self, r2, plan=("ok",)):
        self.plan = list(plan)
        self.spawns: list[dict] = []
        self.names: list[str] = []
        self.events: list[str] = []
        self.cancelled = 0
        fake = self

        class _Call:
            def __init__(self, outcome):
                self.outcome = outcome

            def get(self, timeout=None):
                if isinstance(self.outcome, BaseException):
                    raise self.outcome
                return self.outcome

            def cancel(self):
                fake.cancelled += 1

            def get_call_graph(self):
                return []

        class _Fn:
            def spawn(self, **kw):
                fake.events.append("spawn")
                fake.spawns.append(kw)
                out = fake.plan.pop(0)
                if out == "ok":
                    out = fake.render(kw)
                return _Call(out)

            def get_current_stats(self):
                return types.SimpleNamespace(num_total_runners=1, backlog=0)

        class _Function:
            @staticmethod
            def from_name(app, name):
                fake.names.append(f"{app}/{name}")
                return _Fn()

        self.r2 = r2
        self.module = types.SimpleNamespace(Function=_Function)

    def render(self, kw):
        p = kw["out_prefix"]
        files = {"primary.mp4": b"primary", "1x1.mp4": b"sq",
                 "thumb.jpg": b"jpg"}
        for i, _ in enumerate(kw["hooks"]):
            files[f"hook_{i + 1}.mp4"] = b"hook"
        for name, body in files.items():
            self.r2.put_object(Bucket=storage.bucket(), Key=p + name,
                               Body=body)
        return {
            "outputs": {"primary": {"key": p + "primary.mp4", "size": 7},
                        "9:16": {"key": p + "primary.mp4", "size": 7},
                        "1:1": {"key": p + "1x1.mp4", "size": 2}},
            "thumb": {"key": p + "thumb.jpg", "size": 3},
            "hooks": [{"k": i + 1, "key": f"{p}hook_{i + 1}.mp4", "size": 4,
                       "title": h["title"], "reason": h["reason"],
                       "start": h["start"], "end": h["end"]}
                      for i, h in enumerate(kw["hooks"])],
            "timings": {"burn": 1.0}}


HOOKS = [{"start": 10.0, "end": 25.0, "title": "Hook A", "reason": "funny"},
         {"start": 40.0, "end": 55.0, "title": "Hook B", "reason": "wow"}]
SUBS = [{"start": i * 20.0, "end": i * 20.0 + 5, "text": f"line {i}"}
        for i in range(6)]


@pytest.fixture
def llm(monkeypatch):
    import backend.llm as llm_mod
    calls = []

    def detect(items, language=None):
        calls.append(("detect", len(items)))
        return [dict(h) for h in HOOKS]
    monkeypatch.setattr(llm_mod, "detect_hook_moments", detect)
    monkeypatch.setattr(llm_mod, "generate_social_caption",
                        lambda text, language=None: {"caption": "cap",
                                                     "hashtags": ["#x"]})
    return calls


@pytest.fixture
def modal_r2(r2, monkeypatch, llm):
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    monkeypatch.delenv("CLEO_LOCAL_RENDER_FALLBACK", raising=False)
    # render_r2 is opt-in (default: the volume path, render_burn_concat).
    monkeypatch.setenv("CLEO_MODAL_RENDER_FN", "render_r2")
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    monkeypatch.setenv("CLEO_MODAL_POLL_S", "0.05")
    fake = FakeR2Modal(r2)
    monkeypatch.setitem(sys.modules, "modal", fake.module)
    real_detect = pipeline.detect_hooks

    def detect(*a, **k):
        fake.events.append("hooks")
        return real_detect(*a, **k)
    monkeypatch.setattr(pipeline, "detect_hooks", detect)
    return fake


def _review_job(**fields):
    job = store.create(None, {}, owner_id=None)
    p = f"jobs/{job.id}/"
    base = dict(status="awaiting_review", mezz_key=p + "mezz.mp4",
                segments=[(0.0, 30.0), (30.2, 60.0), (70.0, 120.0)],
                duration=120.0, language="en",
                settings={"caption_preset": "clipper", "style": "tight",
                          "output_formats": ["9:16", "1:1"],
                          "segment_effects": [
                              {"speed": 1.0, "fadeIn": 0.0, "fadeOut": 0.0,
                               "volume": 1.0},
                              {"speed": 1.5, "fadeIn": 0.5, "fadeOut": 0.0,
                               "volume": 1.0},
                              {"speed": 1.0, "fadeIn": 0.0, "fadeOut": 0.0,
                               "volume": 0.5}]})
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


def test_render_r2_gets_keys_and_commits_outputs(client, modal_r2):
    job = _review_job()
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": SUBS})
    assert r.status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    assert modal_r2.names == ["cleocuts-render/render_r2"]
    [kw] = modal_r2.spawns
    p = f"jobs/{job.id}/"
    assert (kw["job_id"], kw["gen"], kw["mezz_key"], kw["out_prefix"]) == (
        job.id, 1, p + "mezz.mp4", p + "r1/")
    assert kw["segments"] == [[0.0, 30.0], [30.2, 60.0], [70.0, 120.0]]
    assert [e["speed"] for e in kw["segment_effects"]] == [1.0, 1.5, 1.0]
    assert kw["segment_effects"][2]["volume"] == 0.5
    assert kw["output_formats"] == ["9:16", "1:1"]
    assert (kw["caption_preset"], kw["cut_style"], kw["language"]) == (
        "clipper", "tight", "en")
    assert kw["subtitles"] == SUBS
    assert kw["hooks"] == HOOKS
    # Hook moments come from the LLM before the spawn.
    assert modal_r2.events == ["hooks", "spawn"]
    got = store.get(job.id)
    assert got.render_gen == 1
    assert got.output_keys == {
        "primary": p + "r1/primary.mp4", "9:16": p + "r1/primary.mp4",
        "1:1": p + "r1/1x1.mp4", "hook_1": p + "r1/hook_1.mp4",
        "hook_2": p + "r1/hook_2.mp4"}
    assert got.thumb_key == p + "r1/thumb.jpg"
    assert got.hook_clips == [
        {"key": "hook_1", "title": "Hook A", "reason": "funny",
         "start": 10.0, "end": 25.0},
        {"key": "hook_2", "title": "Hook B", "reason": "wow",
         "start": 40.0, "end": 55.0}]
    assert got.media_bytes == {p + "r1/primary.mp4": 7, p + "r1/1x1.mp4": 2,
                               p + "r1/thumb.jpg": 3, p + "r1/hook_1.mp4": 4,
                               p + "r1/hook_2.mp4": 4}
    assert (got.social_caption, got.output_path) == ("cap", None)
    d = client.get(f"/jobs/{job.id}").json()
    assert d["has_output"] and d["outputs"][:3] == ["primary", "9:16", "1:1"]
    assert store.gc_all() == []
    # (removed in the worker's finally, just after the status write)
    assert _wait_for(lambda: not M._workspace(job.id).exists())


def test_rerender_gets_a_new_prefix_and_the_old_one_goes_a_day_later(
        client, modal_r2):
    modal_r2.plan.append("ok")
    job = _review_job()
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    store.update(job.id, status="awaiting_review")
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    got = store.get(job.id)
    p = f"jobs/{job.id}/"
    assert [s["out_prefix"] for s in modal_r2.spawns] == [p + "r1/", p + "r2/"]
    assert got.render_gen == 2
    assert set(got.output_keys.values()) <= {
        p + "r2/" + n for n in ("primary.mp4", "1x1.mp4", "hook_1.mp4",
                                "hook_2.mp4")}
    assert all(k.startswith(p + "r2/") for k in got.media_bytes)
    rows = store.gc_all()
    assert [r["prefix"] for r in rows] == [p + "r1/"]
    assert abs(rows[0]["not_before"] - (time.time() + 86400)) < 60
    assert M.run_media_gc() == 0                     # not due yet
    assert M.run_media_gc(now=time.time() + 86400 + 60) == 1
    left = storage.list_r2(p)
    assert left and all(o["key"].startswith(p + "r2/") for o in left)


def test_failed_render_queues_its_prefix_after_modals_timeout(client,
                                                              modal_r2):
    """A failed render's r{g}/ is deleted only once a Modal call that
    may still be running can't write there any more."""
    modal_r2.plan[:] = [AuthError("Token missing")]
    job = _review_job()
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "awaiting_review")
    got = store.get(job.id)
    assert got.message == "render_failed"
    assert got.error.startswith("render_unavailable: AuthError")
    rows = store.gc_all()
    assert [r["prefix"] for r in rows] == [f"jobs/{job.id}/r1/"]
    assert rows[0]["store"] == "r2"
    due = time.time() + pipeline._MODAL_FUNCTION_TIMEOUT_S
    assert due <= rows[0]["not_before"] <= due + 400
    assert got.output_keys == {}


@pytest.mark.parametrize("media_mode", ["r2", "local"])
def test_local_fallback_uploads_to_the_same_keys(client, r2, llm, monkeypatch,
                                                 media_mode):
    """No Modal (dev): the render runs here from the stored mezz, and
    its outputs go to the same keys; a same-size format (a hard link)
    is stored once and aliases the primary."""
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    if media_mode == "local":
        monkeypatch.setenv("CLEO_MEDIA_BACKEND", "local")
    job = _review_job()
    M.media.put_file(Path(__file__), job.mezz_key, content_type="video/mp4")
    seen = {}

    def render_only(**kw):
        seen.update(kw)
        out = Path(kw["output_dir"])
        out.mkdir(parents=True, exist_ok=True)
        assert Path(kw["normalized_path"]).read_bytes() == \
            Path(__file__).read_bytes()
        (out / "cleo_output.mp4").write_bytes(b"primary!")
        os.link(out / "cleo_output.mp4", out / "cleo_output_9-16.mp4")
        (out / "cleo_output_1-1.mp4").write_bytes(b"square")
        (out / "cleo_thumbnail.jpg").write_bytes(b"jpg")
        (out / "cleo_hook_2.mp4").write_bytes(b"hook")
        return {"outputs": {"primary": str(out / "cleo_output.mp4"),
                            "9:16": str(out / "cleo_output_9-16.mp4"),
                            "1:1": str(out / "cleo_output_1-1.mp4"),
                            "hook_2": str(out / "cleo_hook_2.mp4")},
                "hook_clips": [{"key": "hook_2", "title": "B",
                                "reason": "r", "start": 1.0, "end": 2.0,
                                "path": str(out / "cleo_hook_2.mp4")}]}
    monkeypatch.setattr(pipeline, "render_only", render_only)
    puts = []
    real_put = M.media.put_file
    monkeypatch.setattr(M.media, "put_file", lambda path, key, **kw: (
        puts.append(key), real_put(path, key, **kw))[1])
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    assert seen["hooks"] == HOOKS and seen["use_modal"] is False
    got = store.get(job.id)
    p = f"jobs/{job.id}/r1/"
    assert got.output_keys == {"primary": p + "primary.mp4",
                               "9:16": p + "primary.mp4",
                               "1:1": p + "1x1.mp4",
                               "hook_2": p + "hook_2.mp4"}
    assert got.thumb_key == p + "thumb.jpg"
    assert sorted(puts) == sorted([p + "primary.mp4", p + "1x1.mp4",
                                   p + "thumb.jpg", p + "hook_2.mp4"])
    assert M.media.size(p + "primary.mp4") == 8
    assert got.hook_clips == [{"key": "hook_2", "title": "B", "reason": "r",
                               "start": 1.0, "end": 2.0}]
    # (removed in the worker's finally, just after the status write)
    assert _wait_for(lambda: not M._workspace(job.id).exists())


def test_legacy_job_mezz_is_backfilled_before_its_render(client, r2, llm,
                                                         monkeypatch,
                                                         tmp_path):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    normalized = tmp_path / "normalized.mp4"
    normalized.write_bytes(b"legacy-mezz")
    job = _review_job(mezz_key=None, normalized_path=str(normalized))
    got_mezz = []

    def render_only(**kw):
        got_mezz.append(Path(kw["normalized_path"]).read_bytes())
        out = Path(kw["output_dir"])
        out.mkdir(parents=True, exist_ok=True)
        (out / "cleo_output.mp4").write_bytes(b"p")
        return {"outputs": {"primary": str(out / "cleo_output.mp4")},
                "hook_clips": []}
    monkeypatch.setattr(pipeline, "render_only", render_only)
    client.post(f"/jobs/{job.id}/render", json={"subtitles": []})
    assert _wait_for(lambda: store.get(job.id).status == "done")
    got = store.get(job.id)
    assert got.mezz_key == f"jobs/{job.id}/mezz.mp4"
    assert M.media.size(got.mezz_key) == 11 and got_mezz == [b"legacy-mezz"]
    assert got.media_bytes[got.mezz_key] == 11


def test_render_to_dir_order_and_aliases(tmp_path, monkeypatch):
    """render_r2's work on Modal: burn → concat → effects → thumbnail →
    formats → hooks; a format with the primary's size is the primary."""
    calls = []

    def burn(**kw):
        calls.append("burn")
        clip = Path(kw["output_dir"]) / "c0.mp4"
        clip.write_bytes(b"clip")
        return [(str(clip), 1.0)]

    def concat(clips, out, **kw):
        calls.append("concat")
        Path(out).write_bytes(b"primary")

    def effects(src, dst, segments, fx):
        calls.append("effects")
        Path(dst).write_bytes(b"primary+fx")

    def thumb(src, dst):
        calls.append("thumb")
        assert Path(src).read_bytes() == b"primary+fx"
        Path(dst).write_bytes(b"jpg")

    def export(src, dst, w, h):
        calls.append(f"export {w}x{h}")
        Path(dst).write_bytes(b"fmt")

    def hook(src, dst, start, end):
        calls.append(f"hook {start}")
        Path(dst).write_bytes(b"hook")
    monkeypatch.setattr(pipeline, "_multi_clip_burn", burn)
    monkeypatch.setattr(pipeline, "_ffmpeg_concat", concat)
    monkeypatch.setattr(pipeline, "_apply_segment_effects", effects)
    monkeypatch.setattr(pipeline, "_generate_thumbnail", thumb)
    monkeypatch.setattr(pipeline, "_export_format", export)
    monkeypatch.setattr(pipeline, "_extract_hook_clip", hook)
    monkeypatch.setattr(pipeline, "_video_size", lambda p: (1080, 1920))
    timings = {}
    files = pipeline.render_to_dir(
        str(tmp_path / "mezz.mp4"), str(tmp_path / "out"), [(0.0, 1.0)],
        [{"speed": 2.0}], [], "clean", "balanced", "en",
        ["9:16", "1:1", "4:5"], HOOKS[:1], parallelism=8, timings=timings)
    assert calls == ["burn", "concat", "effects", "thumb", "export 1080x1080",
                     "hook 10.0"]
    assert files["formats"] == {"9:16": files["primary"],
                                "1:1": str(tmp_path / "out" / "1x1.mp4")}
    assert {"burn", "concat", "effects", "thumbnail", "formats",
            "hooks"} <= set(timings)
    puts = []
    res = pipeline.store_render_files(
        files, "jobs/0123456789ab/r3/",
        lambda path, key, content_type: puts.append(key) or 5)
    assert res["outputs"]["9:16"] == res["outputs"]["primary"] == {
        "key": "jobs/0123456789ab/r3/primary.mp4", "size": 5}
    assert res["thumb"]["key"] == "jobs/0123456789ab/r3/thumb.jpg"
    assert res["hooks"][0]["key"] == "jobs/0123456789ab/r3/hook_1.mp4"
    assert len(puts) == len(set(puts)) == 4


def test_modal_function_definition():
    src = (REPO / "backend" / "modal_render.py").read_text()
    tree = ast.parse(src)
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert {"render_r2", "render_burn_concat"} <= set(fns)
    # render_r2 only exists in a deploy with CLEO_MODAL_R2=1 (the workflow
    # sets it when the cleocuts-r2 secret exists) — and always inside
    # Modal's containers.
    [guard] = [n for n in tree.body if isinstance(n, ast.If)
               and any(isinstance(b, ast.FunctionDef)
                       and b.name == "render_r2" for b in n.body)]
    assert ast.unparse(guard.test) == "WITH_R2"
    assert "CLEO_MODAL_R2" in src and "modal.is_local()" in src
    deco = ast.unparse(fns["render_r2"].decorator_list[0])
    assert "timeout=3600" in deco and "Secret.from_name('cleocuts-r2')" in deco
    assert "cpu=8.0" in deco and "memory=8192" in deco
    args = [a.arg for a in fns["render_r2"].args.args]
    assert args == ["job_id", "gen", "mezz_key", "out_prefix", "segments",
                    "subtitles", "caption_preset", "cut_style", "language",
                    "output_formats", "segment_effects", "hooks", "bucket"]
    assert '"boto3' in src
    assert pipeline._MODAL_FUNCTION_TIMEOUT_S == 3600.0


# ── media GC ─────────────────────────────────────────────────────────


SRC = "uploads/u/0123456789abcdef0123456789abcdef.mp4"


def _stored_job(r2, n=3):
    job = store.create(None, {}, source_key=SRC)
    b = storage.bucket()
    r2.put_object(Bucket=b, Key=SRC, Body=b"s")
    for i in range(n):
        r2.put_object(Bucket=b, Key=f"jobs/{job.id}/r1/f{i}.mp4", Body=b"x")
    store.update(job.id, status="done")
    return store.get(job.id)


def test_delete_queues_then_deletes(client, r2):
    job = _stored_job(r2)
    other = _stored_job(r2)
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert store.get(job.id) is None
    assert storage.list_r2(f"jobs/{job.id}/") == []
    assert storage.head(SRC) is None
    assert store.gc_all() == []
    assert len(storage.list_r2(f"jobs/{other.id}/")) == 3


def test_gc_retries_a_failed_delete(client, r2, monkeypatch, caplog):
    job = _stored_job(r2)
    real = M.media.delete_any
    down = {"on": True}

    def flaky(entry, where=None):
        if down["on"]:
            raise ConnectionError("R2 unreachable")
        return real(entry, where)
    monkeypatch.setattr(M.media, "delete_any", flaky)
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert store.get(job.id) is None             # the row went anyway
    rows = {r["prefix"]: r for r in store.gc_all()}
    assert set(rows) == {f"jobs/{job.id}/", SRC}
    assert all(r["attempts"] == 1 and "unreachable" in r["last_error"]
               for r in rows.values())
    assert len(storage.list_r2(f"jobs/{job.id}/")) == 3
    caplog.set_level(logging.ERROR, logger="backend.media")
    for i in range(9):
        # A failure pushes the row back (backoff): not due right away.
        assert M.run_media_gc() == 0 and store.gc_due() == []
        M.run_media_gc(now=time.time() + 7 * 3600)
    assert {r["attempts"] for r in store.gc_all()} == {10}
    assert any("GC STUCK" in r.getMessage() for r in caplog.records)
    down["on"] = False
    assert M.run_media_gc(now=time.time() + 7 * 3600) == 2
    assert store.gc_all() == [] and storage.list_r2(f"jobs/{job.id}/") == []


def test_gc_keeps_the_earlier_time_and_waits_for_it(r2):
    store.gc_add(["jobs/0123456789ab/r1/"], time.time() + 3600)
    store.gc_add(["jobs/0123456789ab/r1/"], time.time() + 7200)
    [row] = store.gc_all()
    assert abs(row["not_before"] - (time.time() + 3600)) < 60
    store.gc_add(["jobs/0123456789ab/r1/"], time.time() - 1)
    assert store.gc_all()[0]["not_before"] <= time.time()
    assert M.run_media_gc() == 1


def test_orphan_sweep(r2, monkeypatch):
    monkeypatch.setenv("CLEO_MEDIA_ORPHAN_SWEEP", "1")
    known = _stored_job(r2)
    b = storage.bucket()
    # Ours: jobs/.owner holds this database's id.
    r2.put_object(Bucket=b, Key="jobs/.owner", Body=M._media_owner_id())
    r2.put_object(Bucket=b, Key="jobs/aaaaaaaaaaaa/mezz.mp4", Body=b"o")
    r2.put_object(Bucket=b, Key="uploads/u/left.mp4", Body=b"u")
    assert M.sweep_media_orphans() == 0            # younger than 2 days
    later = time.time() + 3 * 86400
    assert M.sweep_media_orphans(now=later) == 1
    assert [(r["prefix"], r["store"]) for r in store.gc_all()] == [
        ("jobs/aaaaaaaaaaaa/", "r2")]
    assert M.run_media_gc() == 1
    assert storage.list_r2("jobs/aaaaaaaaaaaa/") == []
    assert len(storage.list_r2(f"jobs/{known.id}/")) == 3
    assert storage.head("uploads/u/left.mp4") == 1   # lifecycle's job


def test_orphan_sweep_is_opt_in_and_runs_weekly(monkeypatch):
    now = time.time()
    monkeypatch.delenv("CLEO_MEDIA_ORPHAN_SWEEP", raising=False)
    assert M._orphan_sweep_due(now) is False
    monkeypatch.setenv("CLEO_MEDIA_ORPHAN_SWEEP", "1")
    # The first check seeds the stamp: never due at once (a fresh
    # deployment — or one pointed at someone else's bucket — doesn't
    # sweep at boot).
    assert M._orphan_sweep_due(now) is False
    assert M._orphan_sweep_due(now + 3600) is False
    assert M._orphan_sweep_due(now + 7 * 86400 + 1) is True
    assert M._orphan_sweep_due(now + 7 * 86400 + 2) is False


# ── backfill ─────────────────────────────────────────────────────────


def _legacy_job(root: Path, status="done", proxy=True):
    d = root / "legacy"
    d.mkdir(parents=True, exist_ok=True)
    job = store.create(None, {})
    jd = d / job.id
    jd.mkdir()
    (jd / "normalized.mp4").write_bytes(b"N" * 100)
    if proxy:
        (jd / "proxy.mp4").write_bytes(b"P" * 20)
    (jd / "preview.mp4").write_bytes(b"V" * 30)
    (jd / "cleo_output.mp4").write_bytes(b"O" * 50)
    os.link(jd / "cleo_output.mp4", jd / "cleo_output_9-16.mp4")
    (jd / "cleo_output_1-1.mp4").write_bytes(b"S" * 40)
    (jd / "cleo_thumbnail.jpg").write_bytes(b"T" * 5)
    (jd / "cleo_hook_1.mp4").write_bytes(b"H" * 7)
    store.update(job.id, status=status,
                 normalized_path=str(jd / "normalized.mp4"),
                 preview_path=str(jd / "preview.mp4"), preview_version=4,
                 output_path=str(jd / "cleo_output.mp4"),
                 outputs={"primary": str(jd / "cleo_output.mp4"),
                          "9:16": str(jd / "cleo_output_9-16.mp4"),
                          "1:1": str(jd / "cleo_output_1-1.mp4"),
                          "hook_1": str(jd / "cleo_hook_1.mp4")},
                 hook_clips=[{"key": "hook_1", "title": "H", "reason": "",
                              "start": 0.0, "end": 1.0,
                              "path": str(jd / "cleo_hook_1.mp4")}],
                 updated_at=1_700_000_000.0)
    return store.get(job.id), jd


def test_backfill_uploads_hardlinked_outputs_once_and_is_idempotent(
        r2, tmp_path, monkeypatch):
    job, jd = _legacy_job(tmp_path)
    puts = []
    real = M.media.put_file
    monkeypatch.setattr(M.media, "put_file", lambda path, key, **kw: (
        puts.append(key), real(path, key, **kw))[1])
    lines = []
    summary = r2_backfill.run(echo=lines.append)
    p = f"jobs/{job.id}/"
    assert sorted(puts) == sorted([
        p + "mezz.mp4", p + "proxy.mp4", p + "preview/v4.mp4",
        p + "r1/primary.mp4", p + "r1/1x1.mp4", p + "r1/thumb.jpg",
        p + "r1/hook_1.mp4"])
    got = store.get(job.id)
    assert got.output_keys == {"primary": p + "r1/primary.mp4",
                               "9:16": p + "r1/primary.mp4",
                               "1:1": p + "r1/1x1.mp4",
                               "hook_1": p + "r1/hook_1.mp4"}
    assert (got.mezz_key, got.proxy_key, got.preview_key, got.thumb_key) == (
        p + "mezz.mp4", p + "proxy.mp4", p + "preview/v4.mp4",
        p + "r1/thumb.jpg")
    assert got.render_gen == 1 and got.updated_at == 1_700_000_000.0
    assert got.media_bytes[p + "r1/primary.mp4"] == 50
    assert sum(got.media_bytes.values()) == 100 + 20 + 30 + 50 + 40 + 5 + 7
    assert summary["jobs"] == 1 and summary["bytes"] == 252
    assert summary["egress_usd_est"] == round(252 / 1e9 * 0.05, 4)
    assert summary["local_only_left"] == 0
    assert len(lines) == 1 and job.id in lines[0] and "done" in lines[0]
    # Served from R2 now (307), still local on disk until --delete-local.
    assert (jd / "normalized.mp4").exists()
    puts.clear()
    again = r2_backfill.run(echo=lines.append)
    assert puts == [] and again["jobs"] == 0 and len(lines) == 1


def test_backfill_dry_run_skips_running_and_makes_missing_proxies(
        r2, tmp_path, monkeypatch):
    job, jd = _legacy_job(tmp_path, proxy=False)
    running, _ = _legacy_job(tmp_path / "b", status="processing")
    summary = r2_backfill.run(dry_run=True, echo=lambda line: None)
    assert summary["jobs"] == 1 and store.get(job.id).mezz_key is None
    assert storage.list_r2("jobs/") == []
    made = []

    def make_proxy(src, dst):
        made.append(src)
        Path(dst).write_bytes(b"new-proxy")
        return True
    monkeypatch.setattr(pipeline, "_make_proxy", make_proxy)
    r2_backfill.run(echo=lambda line: None)
    got = store.get(job.id)
    assert made == [str(jd / "normalized.mp4")]
    assert storage.head(got.proxy_key) == 9
    assert not list(jd.glob("proxy.backfill.*"))
    assert store.get(running.id).mezz_key is None


def test_backfill_skips_a_job_that_changed_meanwhile(r2, tmp_path,
                                                     monkeypatch):
    job, _ = _legacy_job(tmp_path)
    real = storage.put_file

    def put_and_touch(path, key, **kw):
        store.update(job.id, status="error")
        return real(path, key, **kw)
    monkeypatch.setattr(storage, "put_file", put_and_touch)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "skipped" and store.get(job.id).mezz_key is None


def test_delete_local_only_for_verified_jobs(r2, tmp_path):
    a, da = _legacy_job(tmp_path / "a")
    b, db_ = _legacy_job(tmp_path / "b")
    r2_backfill.run(echo=lambda line: None)
    storage.delete(store.get(b.id).mezz_key)       # b doesn't verify
    summary = r2_backfill.run(delete_local_files=True, echo=lambda line: None)
    assert summary["jobs"] == 1 and summary["skipped"] == 1
    assert not (da / "normalized.mp4").exists()
    assert not (da / "cleo_output_9-16.mp4").exists()
    assert (db_ / "normalized.mp4").exists()
    got = store.get(a.id)
    assert got.normalized_path is None and got.outputs == {}
    assert got.hook_clips == [{"key": "hook_1", "title": "H", "reason": "",
                               "start": 0.0, "end": 1.0}]
    assert got.has_mezz()


def test_backfill_cli(r2, tmp_path, capsys):
    job, _ = _legacy_job(tmp_path)
    assert r2_backfill.main(["--dry-run", "--job", job.id]) == 0
    out = capsys.readouterr().out
    assert "target: R2 bucket" in out and "(dry run)" in out
    assert "dry-run" in out
    assert r2_backfill.main(["--job", job.id, "--max-mbps", "1000"]) == 0
    assert store.get(job.id).mezz_key


def test_backfill_tick_runs_only_when_switched_on(r2, tmp_path, monkeypatch):
    job, _ = _legacy_job(tmp_path)
    monkeypatch.delenv("CLEO_BACKFILL", raising=False)
    M._backfill_tick()
    assert store.get(job.id).mezz_key is None
    monkeypatch.setenv("CLEO_BACKFILL", "1")
    M._backfill_tick()
    assert store.get(job.id).mezz_key


def test_one_backfill_runner(r2):
    assert r2_backfill._RUN.acquire(blocking=False)
    try:
        assert r2_backfill.run(echo=lambda line: None) is None
    finally:
        r2_backfill._RUN.release()
    t = threading.Thread(target=r2_backfill.run,
                         kwargs={"echo": lambda line: None})
    t.start()
    t.join()
