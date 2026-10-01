#!/usr/bin/env python3
"""Stub backend for the web e2e suites (web/e2e) and screenshot runs.

The CURRENT backend (backend.main) on a throwaway database and work
root, with the expensive parts faked and a test API to create jobs:

* Analysis: a new upload walks through the real stage messages
  (STUB_ANALYSIS_SECONDS, default 6 s) and lands in review with the
  speech clip of stub_media.py (landscape when the upload's settings ask
  for landscape). The real worker path runs around it: slots, workspace,
  storing mezz / proxy / preview (backend.main._store_analysis), commit.
* Rendering: pipeline.render_to_keys is replaced — stage messages, then
  the clip's VP8 proxy stored as the rendered formats (or a failure, per
  job). Social captions are canned. No Groq / Claude / Modal is called.
* Edit document (UT3): every analysed or seeded review job gets a doc
  (backend/doc.py) from its clip's words — the speech clip's word
  timings (fillers flagged), the grid clip's lines split into words — so
  GET / PATCH /jobs/{id}/doc answer as for a real new job (the backend's
  own routes). Seed option `doc: false` makes a job from before the doc
  (404 no_doc).
* Previews: the real cut preview (pipeline._ffmpeg_cuts_preview) is
  re-encoded to VP8 — Playwright's Chromium plays no H.264/AAC — and
  cached by source content + segments, so seeding is fast.
* src.plugin_api and plugins.premiere.video_editor_premiere (analysis
  and burn; heavy imports) are replaced by empty modules: nothing here
  runs them.

Test API (only this script registers it; never part of the backend):

  POST /_test/seed/{seed}   body: options (all optional) → {"id", …}
       seeds: review (grid clip — the editor suites' timings),
              review_speech, review_land, review_long (the speech clip
              with a ~30-minute podcast's 10 000 words in its doc: the
              Text tab's long-transcript state, §1.7 row 21),
              render_failed, analyzing,
              queued, rendering, error, err_no_speech (refunded),
              err_unreadable, done, done_land (the §1.7 state matrix
              grows here: later packages add seeds; the upload
              refusals no_video / no_audio / video_too_short are the
              real backend's answers to the media below)
       options: filename, owner (a user id: the job's owner_id),
              age_s (created that long ago), clip ("grid" | "speech"),
              orientation ("portrait" | "landscape"), settings (dict),
              caption_preset, doc (false: no edit document),
              poster (false: no first-frame poster, as before UT5),
              ai_cuts ([[start, end, kind], …] source seconds,
                       review_speech: more analysis cuts — "voice_cmd" a
                       Cleo-cut take, "filler" a repeat / stutter range
                       whose words get cut: "filler"),
              extra_words ([{text, start, end, nospeech?}, …]: more
                       transcribed words, e.g. one in a pause the speech
                       detection called silence),
              proxy: "off"   has_proxy false, proxy-video 404 (today's
                             production default: CLEO_PROXY_VIDEO unset)
                     "on"    has_proxy true, proxy-video plays
                     "probe" has_proxy not reported (older backend),
                             proxy-video plays
                     "probe-none"  not reported, proxy-video 404
                     "real"  the backend's own answer (R2 mode: 307)
              render: "ok" | "fail"; render_seconds; slow_rebuild (s
              every /edit-segments waits before its rebuild)
  POST /_test/config        {"analysis_seconds": s, "by_filename":
                             {name: {analysis_seconds, clip, proxy, render, …}}}
                            (uploads of that file name; clip: the analysis
                            result, default speech — grid without espeak-ng)
  GET  /_test/job/{id}      the job with internals (keys, owner, sizes)
  GET  /_test/media/{name}  a stub clip for uploads: grid.mp4,
                            speech.mp4, speech_land.mp4, long.webm (31 min),
                            and ones POST /jobs refuses: audio.m4a
                            (no_video), silent.mp4 (no_audio), short.mp4
                            (video_too_short)
  GET  /_test/info          mode, R2 endpoint, seeds
  GET  /_test/uploads       (R2 mode) open multipart uploads + objects

Run from the repo root (web: NEXT_PUBLIC_BACKEND_URL=http://localhost:8501):

  python backend/tests/stub_server.py [--port 8501]
      [--web-origin http://localhost:3501]   # CORS (also CLEO_ALLOWED_ORIGINS)
      [--auth]   # test auth: CLEO_AUTH_TEST=1, requests carry X-Test-User
      [--r2]     # media + uploads in R2, faked by a moto server on a free
                 # port (CLEO_UPLOAD_MODE=multipart, CLEO_PROXY_VIDEO=1)

Needs the backend requirements (+ moto for --r2), ffmpeg and espeak-ng.
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
import types
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
for p in (str(REPO), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import stub_media  # noqa: E402

SEED_NAMES = ("review", "review_speech", "review_land", "review_long", "render_failed", "analyzing",
              "queued", "rendering", "error", "err_no_speech", "err_unreadable", "done",
              "done_land")

TIKTOK = {"caption_preset": "clipper", "style": "tight", "voice_triggers": True,
          "remove_fillers": True, "smartcam_enabled": True, "smartcam_format": "portrait",
          "resolution": "1080", "output_formats": ["9:16"]}
PODCAST = {**TIKTOK, "caption_preset": "clean", "style": "smooth", "smartcam_enabled": False,
           "smartcam_format": "landscape", "output_formats": ["16:9", "9:16"]}
SOCIAL = {"caption": "3 mistakes that quietly kill your TikTok reach (and the 10-second fix "
                     "for each) 👇",
          "hashtags": ["tiktoktips", "contentcreator", "creatortips", "growonTikTok", "fyp"]}
HOOKS = [{"key": "hook_1", "title": "Nobody waits ten seconds",
          "reason": "Relatable pattern-interrupt in the first line — strong standalone opener.",
          "start": 5.0, "end": 11.4},
         {"key": "hook_2", "title": "No captions? They're gone.",
          "reason": "Clear takeaway with a punchline; high share and save potential.",
          "start": 19.2, "end": 28.3}]
# Real stages of the analysis (backend/errors.py STAGES) with their
# messages and share of its time.
STAGES = [("analyze.normalize", "Checking audio…", 1, 1.5),
          ("analyze.normalize", "Preparing video…", 3, 3),
          ("analyze.smartcam", "Preparing preview…", 9, 2),
          ("analyze.transcribe", "Analyzing audio…", 10, 2),
          ("analyze.transcribe", "Transcribing (35%)…", 35, 4),
          ("analyze.transcribe", "Transcribing (62%)…", 62, 4),
          ("analyze.transcribe", "Transcribing (88%)…", 78, 3),
          ("analyze.cleanup", "Polishing transcript…", 85, 3),
          ("analyze.cuts", "Building preview…", 95, 3)]


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=int(os.environ.get("STUB_PORT") or 8501))
    ap.add_argument("--host", default=os.environ.get("STUB_HOST") or "127.0.0.1")
    ap.add_argument("--web-origin", default=os.environ.get("STUB_WEB_ORIGIN") or "http://localhost:3501")
    ap.add_argument("--auth", action="store_true", default=os.environ.get("CLEO_AUTH_TEST") == "1")
    ap.add_argument("--r2", action="store_true", default=os.environ.get("CLEO_TEST_R2") == "moto")
    return ap.parse_args()


def _prepare_env(args: argparse.Namespace, tmp: Path) -> None:
    """Environment of a throwaway deployment — before backend.* is imported."""
    for k in list(os.environ):
        if (k.startswith(("R2_", "MODAL_", "ANTHROPIC", "GROQ", "CLERK_", "LEMONSQUEEZY_"))
                or k in ("DATABASE_URL", "CLEO_DB_BACKEND", "CLEO_MEDIA_BACKEND",
                         "CLEO_UPLOAD_MODE", "CLEO_MEDIA_ROOT", "CLEO_ENV",
                         "CLEO_ADMIN_TOKEN", "CLEO_BILLING_ENFORCE", "CLEO_COMP_USERS")):
            del os.environ[k]
    origins = {args.web_origin, args.web_origin.replace("://localhost", "://127.0.0.1")}
    os.environ.update({
        "CLEO_JOB_DB": str(tmp / "jobs.db"),
        "CLEO_WORK_ROOT": str(tmp / "work"),
        "CLEO_TMP_ROOT": str(tmp / "tmp"),
        "CLEO_MIN_FREE_GB": "0",
        # Empty, not unset: load_dotenv must not fill it from a local .env.
        "SENTRY_DSN": "",
        # The real proxy route answers; the stub decides per job (seed option `proxy`).
        "CLEO_PROXY_VIDEO": "1",
    })
    os.environ.setdefault("CLEO_ALLOWED_ORIGINS", ",".join(sorted(origins)))
    if args.auth:
        os.environ["CLEO_AUTH_TEST"] = "1"
    else:
        os.environ.pop("CLEO_AUTH_TEST", None)


def _start_moto(web_origins: list[str]) -> tuple[Any, str, Any]:
    """A moto S3 server on a free port as the R2 of this stub."""
    import logging

    import boto3
    from moto.server import ThreadedMotoServer
    # moto's werkzeug logs every request; keep the test output readable.
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    srv = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    srv.start()
    endpoint = f"http://localhost:{srv.get_host_and_port()[1]}"
    env = {"R2_ACCOUNT_ID": "acct0test", "R2_ACCESS_KEY_ID": "AKIATEST",
           "R2_SECRET_ACCESS_KEY": "secret", "R2_BUCKET": "cleocuts-media-test",
           "R2_ENDPOINT_URL": endpoint, "CLEO_MEDIA_BACKEND": "r2",
           "CLEO_UPLOAD_MODE": "multipart"}
    os.environ.update(env)
    s3 = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                      aws_access_key_id=env["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"])
    s3.create_bucket(Bucket=env["R2_BUCKET"])
    # The bucket as DEPLOY.md §10 sets up the real one (CORS for the web
    # origin, lifecycle rules for abandoned uploads).
    from backend import r2_setup
    s3.put_bucket_cors(Bucket=env["R2_BUCKET"],
                       CORSConfiguration=r2_setup.cors_config(web_origins))
    s3.put_bucket_lifecycle_configuration(Bucket=env["R2_BUCKET"],
                                          LifecycleConfiguration=r2_setup.lifecycle_config())
    return srv, endpoint, s3


def _stub_heavy_modules() -> None:
    """Analysis and the caption burn live in modules the stub never runs."""
    for name in ("src.plugin_api", "plugins.premiere.video_editor_premiere"):
        m = types.ModuleType(name)
        m.__getattr__ = lambda attr: (lambda *a, **k: None)  # type: ignore[attr-defined]
        sys.modules[name] = m


def main() -> None:  # noqa: C901 - one wiring function, read top to bottom
    args = _parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="cleo-stub-"))
    atexit.register(shutil.rmtree, tmp, ignore_errors=True)
    # Playwright stops the stub with SIGTERM, which uvicorn re-raises after
    # its graceful shutdown: leave through SystemExit, so the atexit
    # cleanup (moto, the throwaway database and media) runs.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    _prepare_env(args, tmp)
    web_origins = sorted({args.web_origin, args.web_origin.replace("://localhost", "://127.0.0.1")})
    moto = r2_endpoint = s3 = None
    if args.r2:
        moto, r2_endpoint, s3 = _start_moto(web_origins)
        atexit.register(moto.stop)
    _stub_heavy_modules()

    import backend.main as M
    import backend.pipeline as pipeline
    from backend import errors, llm, media
    from backend import jobs as J
    from backend.auth import get_owned_job, media_user
    from backend.jobs import store
    from fastapi import Body, Depends, HTTPException
    from fastapi.responses import FileResponse
    from fastapi.routing import APIRoute

    stub_media.grid()  # the editor suites need it at once
    speech_built = threading.Event()   # set once the build finished or failed
    speech_state = {"ok": False}

    def _warm_speech() -> None:
        try:
            for o in stub_media.SPEECH_SIZES:
                stub_media.speech(o)
            speech_state["ok"] = True
        except Exception as e:  # no espeak-ng: speech seeds answer 503
            print(f"[stub] speech clip unavailable: {e}", flush=True)
        finally:
            speech_built.set()
    threading.Thread(target=_warm_speech, daemon=True).start()

    def speech_ready(timeout: float) -> bool:
        return speech_built.wait(timeout=timeout) and speech_state["ok"]

    cfg_lock = threading.Lock()
    CFG: dict[str, dict[str, Any]] = {}          # job id → stub behaviour
    CONFIG: dict[str, Any] = {"analysis_seconds": float(os.environ.get("STUB_ANALYSIS_SECONDS") or 6),
                              "by_filename": {}}

    def cfg(job_id: str) -> dict[str, Any]:
        with cfg_lock:
            return dict(CFG.get(job_id) or {})

    def set_cfg(job_id: str, **values: Any) -> None:
        with cfg_lock:
            CFG.setdefault(job_id, {}).update({k: v for k, v in values.items() if v is not None})

    def clip_files(clip: str, orientation: str) -> dict[str, Path]:
        if clip == "speech":
            if not speech_ready(180):
                raise HTTPException(503, "stub: the speech clip is unavailable (espeak-ng?)")
            return stub_media.speech(orientation)
        return stub_media.grid()

    def clip_data(clip: str) -> dict[str, Any]:
        return stub_media.speech_data() if clip == "speech" else stub_media.grid_data()

    # ── previews: real cut, then VP8, cached ──────────────────────────
    real_cuts_preview = pipeline._ffmpeg_cuts_preview
    preview_cache = tmp / "preview-cache"
    preview_cache.mkdir()

    def _content_id(path: str) -> str:
        h = hashlib.sha1()
        with open(path, "rb") as fh:
            h.update(fh.read(1 << 16))
        return f"{os.path.getsize(path)}-{h.hexdigest()}"

    def chromium_cuts_preview(input_path: str, segments, output_path: str) -> None:
        segs = [[round(float(s), 3), round(float(e), 3)] for s, e in segments]
        key = hashlib.sha1(f"{_content_id(input_path)}{segs}".encode()).hexdigest()
        cached = preview_cache / f"{key}.webm"
        if not cached.exists():
            h264 = preview_cache / f"{key}.{threading.get_ident()}.mp4"
            try:
                real_cuts_preview(input_path, segments, str(h264))
                stub_media.webm(h264, preview_cache / f"{key}.{threading.get_ident()}.webm")
                os.replace(preview_cache / f"{key}.{threading.get_ident()}.webm", cached)
            finally:
                h264.unlink(missing_ok=True)
        shutil.copyfile(cached, output_path)

    pipeline._ffmpeg_cuts_preview = chromium_cuts_preview

    from backend import cut_kinds
    from backend import doc as edit_doc

    def clip_doc(clip: str, data: dict[str, Any], settings: dict | None,
                 extra_words: list | None = None, fillers: list | None = None) -> dict[str, Any]:
        """The edit document of a stub clip, as the analysis builds it."""
        if clip == "speech":
            raw = stub_media.speech_words() + [dict(w) for w in extra_words or ()]
            words = edit_doc.words_from_transcript(raw, fillers)
        else:
            words = edit_doc.words_from_units(data["subtitles"])
        return edit_doc.build_doc(words, data["language"], settings or {},
                                  segments=data["segments"])

    def analysis_result(clip: str, orientation: str, out_dir: Path,
                        audio_warnings: list[str] | None = None,
                        settings: dict | None = None,
                        ai_cuts: list | None = None,
                        extra_words: list | None = None) -> dict[str, Any]:
        """What pipeline.analyze_only returns, for a stub clip, with its
        files (normalized, proxy, first preview) in `out_dir`. Every cut
        range gets its kind (backend/cut_kinds.py, UX10) from the
        analysis log and the doc's filler words, and the cut words theirs;
        `ai_cuts` / `extra_words`: see the seed options."""
        files = clip_files(clip, orientation)
        data = dict(clip_data(clip))
        log: list = []
        fillers: list = []
        for cs, ce, kind in ai_cuts or ():
            vs, ve = float(cs), float(ce)
            kept = []
            for s0, e0 in data["segments"]:
                if e0 <= vs or s0 >= ve:
                    kept.append([s0, e0])
                    continue
                if s0 < vs:
                    kept.append([s0, vs])
                if e0 > ve:
                    kept.append([ve, e0])
            data["segments"] = kept
            data["cut_ranges"] = pipeline._invert_segments([tuple(x) for x in kept], data["duration"])
            log.append((kind, vs, ve))
            if kind == "filler":
                fillers.append({"start": vs, "end": ve, "word": "repeat"})
        out_dir.mkdir(parents=True, exist_ok=True)
        norm = out_dir / "normalized.mp4"
        media._link_or_copy(files["src"], norm)
        media._link_or_copy(files["proxy"], out_dir / pipeline.PROXY_NAME)
        preview = out_dir / "preview.mp4"
        chromium_cuts_preview(str(files["proxy"]), data["segments"], str(preview))
        poster = out_dir / pipeline.POSTER_NAME
        segs = data["segments"]
        poster_ok = pipeline.make_poster(str(files["proxy"]), float(segs[0][0]) if segs else 0.0,
                                         str(poster))
        doc = clip_doc(clip, data, settings, extra_words, fillers)
        cuts = cut_kinds.label(data["cut_ranges"], log=log, words=doc["words"])
        cut_kinds.mark_words(doc["words"], cuts)
        return {"normalized_path": str(norm), "preview_path": str(preview),
                "poster_path": str(poster) if poster_ok else None,
                "segments": [tuple(s) for s in data["segments"]], "subtitles": data["subtitles"],
                "duration": data["duration"],
                "cut_ranges": cuts,
                "language": data["language"], "audio_warnings": audio_warnings or [],
                "audio_levels": {}, "scene_events": [],
                "doc": doc}

    def review_fields(res: dict[str, Any]) -> dict[str, Any]:
        """The job fields _run_analyze_inner commits for a finished analysis."""
        return dict(status="awaiting_review", message="Review subtitles", progress=100.0,
                    segments=res["segments"], preview_segments=[list(s) for s in res["segments"]],
                    preview_version=1, subtitles=res["subtitles"], duration=res["duration"],
                    cut_ranges=res["cut_ranges"], language=res["language"],
                    audio_warnings=res["audio_warnings"], audio_levels=res["audio_levels"],
                    scene_events=res["scene_events"], doc=res.get("doc"), doc_rev=0)

    # ── fake analysis (the real worker around it) ─────────────────────
    def fake_analyze_only(input_path: str, output_dir: str, settings: dict,
                          progress_cb, on_normalized=None, **_: Any) -> dict[str, Any]:
        job_id = Path(output_dir).name
        job = store.get(job_id)
        per_file = dict(CONFIG["by_filename"].get(job.filename if job else "", {}))
        total = float(per_file.pop("analysis_seconds", CONFIG["analysis_seconds"]))
        weight = sum(dt for *_, dt in STAGES)
        for code, msg, pct, dt in STAGES:
            progress_cb(errors.stage_message(code, msg), float(pct))
            time.sleep(total * dt / weight)
        if on_normalized is not None:
            on_normalized()
        landscape = (settings or {}).get("smartcam_format") == "landscape"
        clip = per_file.pop("clip", None) or ("speech" if speech_ready(120) else "grid")
        orientation = "landscape" if landscape else "portrait"
        set_cfg(job_id, **{"proxy": "on", "render": "ok", "clip": clip,
                           "orientation": orientation, **per_file})
        return analysis_result(clip, orientation, Path(output_dir), settings=settings)

    M.analyze_only = fake_analyze_only

    # ── fake render ───────────────────────────────────────────────────
    def fake_render_to_keys(*, job_id: str, out_prefix: str, store: str, segments=None,
                            settings=None, progress_cb=None, **_: Any) -> dict[str, Any]:
        c = cfg(job_id)
        secs = float(c.get("render_seconds", 2.0))
        n = max(1, len(segments or []))
        for pct in (10, 40, 70, 90):
            if progress_cb:
                progress_cb(errors.stage_message("render.encode", f"Rendering {n} clip(s)…", n=n)
                            if pct < 90 else errors.stage_message("render.finish", "Finishing…"),
                            float(pct))
            time.sleep(secs / 4)
        if c.get("render") == "fail":
            raise RuntimeError("Render worker unavailable (modal_unavailable)")
        files = clip_files(c.get("clip", "grid"), c.get("orientation", "portrait"))
        formats = ["primary"] + [f for f in (settings or {}).get("output_formats") or []
                                 if f in pipeline.EXPORT_FORMATS]
        outputs = {}
        for fmt in formats:
            key = f"{out_prefix}{'primary' if fmt == 'primary' else fmt.replace(':', 'x')}.mp4"
            outputs[fmt] = {"key": key, "size": media.put_file(files["proxy"], key,
                                                               content_type="video/mp4", store=store)}
        tkey = f"{out_prefix}thumb.jpg"
        tsize = media.put_file(files["thumb"], tkey, content_type="image/jpeg", store=store)
        return {"outputs": outputs, "thumb": {"key": tkey, "size": tsize}, "hooks": []}

    pipeline.render_to_keys = fake_render_to_keys
    llm.generate_social_caption = lambda *a, **k: dict(SOCIAL)

    # ── per-job behaviour: slow rebuilds, has_proxy, proxy-video ──────
    real_rebuild = M._rebuild_preview

    def slow_rebuild(job_id: str, source, segments) -> None:
        delay = float(cfg(job_id).get("slow_rebuild") or 0)
        if delay:
            time.sleep(delay)
        return real_rebuild(job_id, source, segments)

    M._rebuild_preview = slow_rebuild

    real_to_dict = J.Job.to_dict

    def to_dict(self, **kw: Any) -> dict[str, Any]:
        d = real_to_dict(self, **kw)
        mode = cfg(self.id).get("proxy")
        if mode == "on":
            d["has_proxy"] = True
        elif mode == "off":
            d["has_proxy"] = False
        elif mode in ("probe", "probe-none"):
            d.pop("has_proxy", None)   # a backend from before the proxy
        return d

    J.Job.to_dict = to_dict
    real_proxy_video = M.proxy_video

    def proxy_video(job_id: str, user=Depends(media_user)):
        if cfg(job_id).get("proxy") in ("off", "probe-none"):
            get_owned_job(job_id, user)
            raise HTTPException(404, "proxy_not_ready")
        return real_proxy_video(job_id, user)

    # First, so it wins over the backend's own route.
    M.app.router.routes.insert(0, APIRoute("/jobs/{job_id}/proxy-video", proxy_video,
                                           methods=["GET"]))

    # ── seeds ─────────────────────────────────────────────────────────
    def create(opts: dict[str, Any], settings: dict, filename: str,
               preset: tuple[str | None, str | None]) -> Any:
        job = store.create(None, dict(opts.get("settings") or settings),
                           filename=opts.get("filename") or filename,
                           owner_id=opts.get("owner") or None,
                           preset_id=opts.get("preset_id", preset[0]),
                           preset_label=opts.get("preset_label", preset[1]))
        if opts.get("caption_preset"):
            store.update(job.id, settings={**job.settings, "caption_preset": opts["caption_preset"]})
        return job

    def seed_review(job, clip: str, orientation: str, warnings: list[str] | None = None,
                    with_doc: bool = True, with_poster: bool = True,
                    ai_cuts: list | None = None,
                    extra_words: list | None = None) -> None:
        where = media.backend()
        ws = M._workspace(job.id, "seed")
        try:
            res = analysis_result(clip, orientation, ws, warnings, settings=job.settings,
                                  ai_cuts=ai_cuts, extra_words=extra_words)
            if not with_doc:
                res["doc"] = None
            if not with_poster:
                res["poster_path"] = None
            stored = M._store_analysis(job.id, res, lambda *_a: None, where)
        finally:
            shutil.rmtree(M._workspace(job.id), ignore_errors=True)
        store.update(job.id, **review_fields(res), **stored)

    def seed_done(job, clip: str, orientation: str, hooks: bool) -> None:
        seed_review(job, clip, orientation)
        where = media.backend()
        files = clip_files(clip, orientation)
        prefix = f"{media.job_prefix(job.id)}r1/"
        output_keys, sizes = {}, {}
        fmts = ["primary"] + list((store.get(job.id).settings or {}).get("output_formats") or [])
        for fmt in fmts:
            key = f"{prefix}{'primary' if fmt == 'primary' else fmt.replace(':', 'x')}.mp4"
            sizes[key] = media.put_file(files["proxy"], key, content_type="video/mp4", store=where)
            output_keys[fmt] = key
        hook_clips = []
        if hooks:
            for h in HOOKS:
                key = f"{prefix}{h['key']}.mp4"
                sizes[key] = media.put_file(files["proxy"], key, content_type="video/mp4", store=where)
                output_keys[h["key"]] = key
                hook_clips.append(dict(h))
        tkey = f"{prefix}thumb.jpg"
        sizes[tkey] = media.put_file(files["thumb"], tkey, content_type="image/jpeg", store=where)
        cur = store.get(job.id)
        store.update(job.id, status="done", message="Done", progress=100.0, render_gen=1,
                     output_keys=output_keys, thumb_key=tkey, hook_clips=hook_clips,
                     media_bytes={**(cur.media_bytes or {}), **sizes},
                     social_caption=SOCIAL["caption"] if hooks else "",
                     social_hashtags=list(SOCIAL["hashtags"]) if hooks else [])

    def long_words(n: int, duration: float) -> list[dict[str, Any]]:
        """n doc words over the clip (a 30-minute podcast's word count
        squeezed into the stub clip, so PATCH accepts their times):
        the speech script's words in a loop, 12-word sentences."""
        vocab = [w["text"].strip(".,:") for w in stub_media.speech_words()] or ["word"]
        step = max(duration - 0.5, 1.0) / n
        out = []
        for i in range(n):
            text = vocab[i % len(vocab)]
            if i % 12 == 11:
                text += "."
            t0 = round(i * step, 3)
            out.append({"id": f"w{i + 1:05d}", "text": text, "start": t0,
                        "end": round(t0 + step * 0.9, 3)})
        return out

    def seed(name: str, opts: dict[str, Any]) -> dict[str, Any]:
        clip = opts.get("clip")
        orientation = opts.get("orientation") or "portrait"
        tiktok = ("tiktok", "TikTok / Reels")
        if name == "review":
            clip = clip or "grid"
            job = create(opts, {"caption_preset": "clipper"}, "test.mp4", (None, None))
            seed_review(job, clip, orientation, with_doc=opts.get("doc", True) is not False)
            proxy = "off"
        elif name in ("review_speech", "render_failed"):
            clip = clip or "speech"
            job = create(opts, TIKTOK, "tiktok_3_mistakes.mp4" if name == "review_speech"
                         else "interview_cut_final.mp4", tiktok)
            seed_review(job, clip, orientation, with_doc=opts.get("doc", True) is not False,
                        with_poster=opts.get("poster", True) is not False,
                        ai_cuts=opts.get("ai_cuts"), extra_words=opts.get("extra_words"))
            if name == "render_failed":
                store.update(job.id, message="render_failed",
                             error="Render worker unavailable (modal_unavailable)",
                             error_code="render_unavailable")
            proxy = "on"
        elif name == "review_long":
            clip = clip or "speech"
            job = create(opts, TIKTOK, "podcast_ep30_full.mp4", tiktok)
            seed_review(job, clip, orientation)
            cur = store.get(job.id)
            words = long_words(int(opts.get("words") or 10_000), float(cur.duration or 30.0))
            store.update(job.id, doc={**cur.doc, "words": words}, doc_rev=0)
            proxy = "on"
        elif name == "review_land":
            clip, orientation = clip or "speech", "landscape"
            job = create(opts, PODCAST, "podcast_ep12_clip.mp4", ("podcast", "Podcast"))
            seed_review(job, clip, orientation, ["audio_quiet"])
            proxy = "on"
        elif name in ("analyzing", "queued", "rendering", "error", "err_no_speech",
                      "err_unreadable"):
            clip = clip or "speech"
            fields = {
                "analyzing": dict(status="processing", progress=62.0, **errors.stage(
                    "analyze.transcribe") | {"message": "Transcribing (62%)…"}),
                "queued": dict(status="processing", progress=0.0, queue_position=3,
                               **errors.stage("queued")),
                "rendering": dict(status="processing", progress=58.0, segments=[[0.0, 5.0]],
                                  **errors.stage("render.encode", n=6)
                                  | {"message": "Rendering 6 clip(s) on Modal…"}),
                "error": dict(status="error", progress=0.0,
                              error="No speech detected in the video.",
                              **errors.job_error("no_speech")),
                # §1.7 row 1: music only, minutes back.
                "err_no_speech": dict(status="error", progress=0.0, refunded=True,
                                      error="No speech detected in the video.",
                                      **errors.job_error("no_speech")),
                # §1.7 row 5: ffmpeg couldn't decode the upload.
                "err_unreadable": dict(status="error", progress=0.0, refunded=True,
                                       error="ffmpeg normalize failed: Invalid data found "
                                             "when processing input (/tmp/x/source.mov)",
                                       **errors.job_error("unreadable_video")),
            }[name]
            names = {"analyzing": "day_in_berlin_vlog.mp4", "queued": "q_and_a_livestream.mp4",
                     "rendering": "product_demo_v2.mp4", "error": "screen_recording_no_mic.mov",
                     "err_no_speech": "lofi_beats_no_voice.mp4",
                     "err_unreadable": "prores_4444_master.mov"}
            job = create(opts, PODCAST if name == "queued" else TIKTOK, names[name],
                         ("podcast", "Podcast") if name == "queued" else tiktok)
            store.update(job.id, **fields)
            proxy = "on"
        elif name in ("done", "done_land"):
            land = name == "done_land"
            clip = clip or "speech"
            orientation = "landscape" if land else orientation
            job = create(opts, PODCAST if land else TIKTOK,
                         "podcast_ep11_highlight.mp4" if land else "tiktok_3_mistakes_final.mp4",
                         ("podcast", "Podcast") if land else tiktok)
            seed_done(job, clip, orientation, hooks=not land)
            proxy = "on"
        else:
            raise HTTPException(404, f"unknown seed {name!r}; seeds: {', '.join(SEED_NAMES)}")
        if opts.get("age_s"):
            store.update(job.id, created_at=time.time() - float(opts["age_s"]))
        set_cfg(job.id, proxy=opts.get("proxy") or proxy, render=opts.get("render") or "ok",
                render_seconds=opts.get("render_seconds"), slow_rebuild=opts.get("slow_rebuild"),
                clip=clip or "grid", orientation=orientation)
        j = store.get(job.id)
        print(f"[stub] seeded {name} {job.id} ({cfg(job.id)})", flush=True)
        return {"id": job.id, "seed": name, "filename": j.filename, "status": j.status,
                "stub": cfg(job.id)}

    # ── test API ──────────────────────────────────────────────────────
    app = M.app

    @app.post("/_test/seed/{name}")
    def _test_seed(name: str, opts: dict = Body(default={})):
        return seed(name, opts or {})

    @app.post("/_test/config")
    def _test_config(values: dict = Body(default={})):
        if "analysis_seconds" in values:
            CONFIG["analysis_seconds"] = float(values["analysis_seconds"])
        for fname, v in (values.get("by_filename") or {}).items():
            CONFIG["by_filename"][fname] = dict(v or {})
        return CONFIG

    @app.get("/_test/job/{job_id}")
    def _test_job(job_id: str):
        j = store.get(job_id)
        if j is None:
            raise HTTPException(404, "job not found")
        where = media.store_of(j)
        size = None
        if j.source_key:
            try:
                size = media.size(j.source_key, store=where)
            except Exception:
                size = None
        return {**j.to_dict(), "source_key": j.source_key, "owner_id": j.owner_id,
                "mezz_key": j.mezz_key, "proxy_key": j.proxy_key, "preview_key": j.preview_key,
                "output_keys": j.output_keys, "media_store": where, "size": size,
                "stub": cfg(job_id)}

    @app.get("/_test/media/{name}")
    def _test_media(name: str):
        if name == "grid.mp4":
            return FileResponse(stub_media.grid()["src"], media_type="video/mp4")
        if name in ("speech.mp4", "speech_land.mp4"):
            files = clip_files("speech", "landscape" if name == "speech_land.mp4" else "portrait")
            return FileResponse(files["src"], media_type="video/mp4")
        if name == "long.webm":
            return FileResponse(stub_media.long_video(), media_type="video/webm")
        if name in stub_media.REFUSED_MEDIA:
            return FileResponse(stub_media.refused_media(name),
                                media_type="audio/mp4" if name.endswith(".m4a") else "video/mp4")
        raise HTTPException(404, "unknown media")

    @app.get("/_test/info")
    def _test_info():
        return {"auth_test": args.auth, "r2": args.r2, "r2_endpoint": r2_endpoint,
                "web_origins": web_origins, "speech": speech_state["ok"], "seeds": SEED_NAMES}

    if args.r2:
        @app.get("/_test/uploads")
        def _test_uploads():
            bucket = os.environ["R2_BUCKET"]
            ups = s3.list_multipart_uploads(Bucket=bucket).get("Uploads") or []
            objs = s3.list_objects_v2(Bucket=bucket, Prefix="uploads/").get("Contents") or []
            return {"open": [u["Key"] for u in ups], "objects": {o["Key"]: o["Size"] for o in objs}}

    print(f"[stub] backend on http://{args.host}:{args.port} (auth_test={args.auth}, "
          f"r2={r2_endpoint or 'off'}, cors={os.environ['CLEO_ALLOWED_ORIGINS']}, tmp={tmp})",
          flush=True)
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
