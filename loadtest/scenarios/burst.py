"""burst — K real uploads within 60 s (EXPENSIVE: Groq, Claude, Modal).

Builds talking-head test clips with .github/scripts/cost_test.py
(make_video), uploads K of them spread over --window seconds
(cost_test.upload, as the service identity, tagged _cost_test), watches
all jobs through GET /jobs/status until the analysis ends (queue
positions must only shrink), optionally renders them (--render,
cost_test.wait), checks for lost / duplicated / ghost jobs, and reports
what it cost (/admin/costs before vs. after).

The created jobs are ALWAYS deleted at the end — also after errors and
Ctrl-C (jobs still processing are waited for; whatever can't be deleted
is printed with the command to delete it later).

Needs CLEO_ADMIN_TOKEN, ffmpeg + espeak-ng, --base-url and
--i-understand-this-costs-money. Refuses to start when the estimate is
above --max-usd.

The server's ingest executor (GET /admin/queue: local, or modal with
CLEO_EXECUTOR_INGEST=modal) is in the report; --executor modal refuses
to start against a server that analyses locally. Without --max-analyze /
--max-queue (and $CLEO_MAX_ANALYZE / $CLEO_MAX_QUEUE) the server's own
running limit and queue cap are used — e.g. 20 / 200 with Modal.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import secrets
import sys
import tempfile
import statistics
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

from ..common import (
    REPO_ROOT, STATUS_BATCH, Recorder, UsageError, admin_identity, call, log,
    make_session, note_created,
)
from ..report import Check, Expect, FAIL, INFO, PASS, SKIP, Result, evaluate

NAME = "burst"
HELP = "K real uploads within 60 s — EXPENSIVE (Groq, Claude, Modal)"
LABEL_UPLOAD = "POST /jobs (upload incl. transfer)"
LABEL_STATUS = "GET /jobs/status (monitor)"
# $/video-minute when /admin/costs has nothing to go by (audit numbers:
# 2-min phone video ≈ $0.04 analysis + ≈ $0.015 Modal render).
FALLBACK_USD_PER_MIN = {False: 0.025, True: 0.035}
ANALYSIS_DONE = {"awaiting_review", "error", "done"}


def add_args(p) -> None:
    p.add_argument("--clips", default="synthetic:1x5",
                   help="profile:minutes[:preset]xCOUNT, comma-separated "
                        "(profiles/presets of cost_test.py). WP4: "
                        "synthetic:2x50,synthetic:10x10")
    p.add_argument("--window", type=float, default=60,
                   help="seconds over which the uploads are spread")
    p.add_argument("--render", action="store_true",
                   help="also render every analysed job (Modal: costs more)")
    p.add_argument("--job-timeout", type=float, default=3600)
    p.add_argument("--poll", type=float, default=5,
                   help="seconds between two status polls of all jobs")
    p.add_argument("--max-usd", type=float, default=5.0,
                   help="refuse to start when the estimate is higher")
    p.add_argument("--cleanup-timeout", type=float, default=1800)
    p.add_argument("--max-analyze", type=int,
                   default=_env_int("CLEO_MAX_ANALYZE", 0) or None,
                   help="the target's parallel analyses (default: "
                        "$CLEO_MAX_ANALYZE, else the server's ingest running "
                        "limit from /admin/queue, else 2)")
    p.add_argument("--max-queue", type=int,
                   default=_env_int("CLEO_MAX_QUEUE", 0) or None,
                   help="the target's CLEO_MAX_QUEUE (default: $CLEO_MAX_QUEUE, "
                        "else the server's queue cap from /admin/queue, else 20)")
    p.add_argument("--executor", choices=("any", "local", "modal"),
                   default="any",
                   help="the ingest executor the server must use (GET "
                        "/admin/queue); modal = the Modal analysis "
                        "(CLEO_EXECUTOR_INGEST=modal)")
    p.add_argument("--min-accepted", type=int, default=None,
                   help="uploads that must be accepted (default: min(K, "
                        "--max-analyze + --max-queue)); 0 accepted always FAILs")
    p.add_argument("--expect-video-min-per-hour", type=float, default=None,
                   help="predicted queue drain rate; default: --max-analyze × "
                        "the analysis speed of this run's jobs that never "
                        "queued. FAIL below --min-drain-share of it")
    p.add_argument("--min-drain-share", type=float, default=0.8)
    p.add_argument("--time-budget-min", type=float,
                   default=float(os.environ.get("LOADTEST_TIME_BUDGET_MIN") or 0),
                   help="refuse to start when window + upload timeout + "
                        "job/render timeouts + cleanup could exceed this "
                        "(CI job timeout; default $LOADTEST_TIME_BUDGET_MIN, "
                        "0 = no limit)")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


UPLOAD_TIMEOUT_MIN = 30  # cost_test.upload: curl -m 1800


def server_queue(ct) -> dict:
    """GET /admin/queue, or {} (an older server, the queue off)."""
    try:
        return ct.http("GET", "/admin/queue") or {}
    except Exception as e:
        log(f"/admin/queue: {ct.redact(e)[:160]}")
        return {}


def resolve_limits(args, queue: dict) -> str:
    """The ingest executor of the server ("wp1" with the queue off, "?"
    unknown); fills --max-analyze / --max-queue from it when not given.
    Raises UsageError when --executor names another executor."""
    ingest = (queue.get("kinds") or {}).get("ingest") or {}
    if not queue:
        executor = "?"
    elif not queue.get("enabled"):
        executor = "wp1"
    else:
        executor = ingest.get("executor") or "local"
    if args.executor != "any" and executor != args.executor:
        raise UsageError(f"the server analyses with {executor!r}, --executor "
                         f"wants {args.executor!r} — nothing was uploaded")
    if args.max_analyze is None:
        args.max_analyze = int(ingest.get("limit") or 2)
    if args.max_queue is None:
        args.max_queue = int(queue.get("max_queue") or 20)
    return executor


def worst_case_minutes(args) -> float:
    """How long a run can take before its cleanup has finished."""
    return (args.window / 60 + UPLOAD_TIMEOUT_MIN
            + args.job_timeout / 60 * (2 if args.render else 1)
            + args.cleanup_timeout / 60)


class _Monitor:
    """GET /jobs/status for the monitor over one keep-alive aiohttp
    session on a private event loop (burst itself is threaded): timed
    like the other scenarios' reads — not a fresh TCP+TLS handshake per
    sample — and with the response headers (Retry-After) recorded."""

    def __init__(self, base: str, token: str, timeout: float = 120.0) -> None:
        self.base, self.token, self.timeout = base.rstrip("/"), token, timeout
        self.loop = asyncio.new_event_loop()
        self.session = None

    def get(self, rec: Recorder | None, label: str, path: str):
        async def go():
            if self.session is None:
                self.session = make_session(self.timeout)
            return await call(self.session, rec, label, "GET", self.base + path,
                              headers={"X-Admin-Token": self.token})
        return self.loop.run_until_complete(go())

    def close(self) -> None:
        try:
            if self.session is not None:
                self.loop.run_until_complete(self.session.close())
        finally:
            self.loop.close()


def parse_clips(spec: str, ct) -> list[tuple[str, float, str, int]]:
    out = []
    for item in (x.strip() for x in spec.split(",")):
        if not item:
            continue
        m = re.fullmatch(r"(.+?)(?:[x×*](\d+))?", item)
        head, count = m.group(1), int(m.group(2) or 1)
        (prof, mins, preset), = ct.parse_runs(head)
        if count < 1 or mins <= 0:
            raise UsageError(f"bad clip spec {item!r}")
        out.append((prof, mins, preset, count))
    if not out:
        raise UsageError("--clips is empty")
    return out


def import_cost_test(base: str, token: str):
    scripts = str(REPO_ROOT / ".github" / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    ct = importlib.import_module("cost_test")
    ct.API = base.rstrip("/")
    ct.ADMIN = token
    ct.SUMMARY = None  # our report goes to the step summary, not theirs
    return ct


def estimate_rate(costs: dict, render: bool) -> tuple[float, str]:
    rows = [r for r in costs.get("rows", [])
            if r.get("test") and r.get("video_minutes")]
    mins = sum(r["video_minutes"] for r in rows)
    if rows and mins > 0:
        rate = sum(r["usd_all_in"] for r in rows) / mins
        return rate, (f"{len(rows)} earlier test jobs on /admin/costs "
                      "(cost-test runs render too: an upper bound without "
                      "--render)")
    if costs.get("usd_per_video_minute"):
        return float(costs["usd_per_video_minute"]), "all jobs on /admin/costs"
    return FALLBACK_USD_PER_MIN[render], "fallback model (no cost data yet)"


def _code(err: Exception) -> str:
    text = str(err)
    m = (re.search(r"returned error: (\d{3})", text)
         or re.search(r"HTTP (\d{3})", text))
    return m.group(1) if m else "ERR:upload"


def _runs(values: list) -> list:
    """[3, 3, 2, 2, 1] -> [3, 2, 1] (for the report)."""
    return [v for i, v in enumerate(values) if i == 0 or v != values[i - 1]]


class Burst:
    def __init__(self, args, base: str, ct, rec: Recorder) -> None:
        self.args, self.base, self.ct, self.rec = args, base, ct, rec
        self.run_id = time.strftime("%m%d%H%M") + secrets.token_hex(2)
        self.prefix = f"lt-{self.run_id}-"
        self.uploads: list[dict] = []
        self.accepted: dict[str, dict] = {}   # job id -> upload
        self.orphans: list[str] = []
        self.state: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.mon = _Monitor(base, ct.ADMIN)

    # ── clips + uploads ──────────────────────────────────────────────
    def make_clips(self, plan, work: Path) -> list[dict]:
        clips = []
        built: dict[tuple[str, float], Path] = {}
        n = 0
        for prof, mins, preset, count in plan:
            video = built.get((prof, mins))
            if video is None:
                t = time.time()
                video = built[(prof, mins)] = self.ct.make_video(prof, mins, work)
                log(f"   built {prof} {mins:g} min "
                    f"({video.stat().st_size / 1e6:.0f} MB) in {time.time() - t:.0f}s")
            for _ in range(count):
                # Unique file names: the job's filename shows who is who
                # (duplicate / ghost detection via GET /jobs).
                link = work / f"{self.prefix}{n:03d}.mp4"
                try:
                    os.link(video, link)
                except OSError:
                    link.write_bytes(video.read_bytes())
                clips.append({"path": link, "profile": prof, "minutes": mins,
                              "preset": preset, "filename": link.name})
                n += 1
        return clips

    def _upload_one(self, clip: dict, at: float) -> None:
        delay = at - time.time()
        if delay > 0:
            time.sleep(delay)
        up = {**clip, "t0": time.time(), "job": None, "code": None}
        t0 = time.perf_counter()
        try:
            up["job"] = self.ct.upload(clip["path"], clip["preset"])
            up["code"] = "200"
        except Exception as e:
            up["error"] = " ".join(self.ct.redact(e).split())[:300]
            up["code"] = _code(e)
            if up["code"] == "503" and "server_busy" not in up["error"]:
                # e.g. "direct upload not available" (no R2): not the
                # intended overload refusal.
                up["code"] = "ERR:http-503"
        ms = (time.perf_counter() - t0) * 1000
        up["t1"] = time.time()
        if up["job"]:
            # At once: a killed run still leaves the id for `cleanup`.
            note_created(self.args.out, [up["job"]],
                         f"burst {self.run_id} {clip['filename']}")
        with self.lock:
            self.rec.record(LABEL_UPLOAD, up["code"], ms,
                            body=(up.get("error") or "").encode())
            self.uploads.append(up)
            if up["job"]:
                self.accepted[up["job"]] = up
        log(f"   {clip['filename']}: {up['code']} in {ms / 1000:.1f}s"
            + (f" → {up['job']}" if up["job"] else f" ({up.get('error', '')[:120]})"))

    def upload_all(self, clips: list[dict]) -> None:
        t0 = time.time() + 1
        step = self.args.window / max(1, len(clips))
        with ThreadPoolExecutor(max_workers=len(clips)) as pool:
            for n, clip in enumerate(clips):
                pool.submit(self._upload_one, clip, t0 + n * step)

    # ── watching ─────────────────────────────────────────────────────
    def status_rows(self, ids: list[str], record: bool = True) -> dict[str, dict]:
        rows: dict[str, dict] = {}
        for i in range(0, len(ids), STATUS_BATCH):
            chunk = ids[i:i + STATUS_BATCH]
            r = self.mon.get(self.rec if record else None, LABEL_STATUS,
                             "/jobs/status?ids=" + ",".join(map(quote, chunk)))
            body = r.json() if r.status == 200 else None
            if not isinstance(body, dict):
                raise RuntimeError(f"GET /jobs/status failed: {r.status or r.error}")
            rows.update({row["id"]: row for row in body.get("jobs", [])})
        return rows

    def watch_analysis(self) -> None:
        ids = list(self.accepted)
        self.state = {i: {"queue": [], "statuses": [], "done_at": None,
                          "final": None, "missing": False} for i in ids}
        deadline = time.time() + self.args.job_timeout
        last_log = 0.0
        while time.time() < deadline:
            open_ids = [i for i, s in self.state.items()
                        if s["done_at"] is None and not s["missing"]]
            if not open_ids:
                return
            try:
                rows = self.status_rows(open_ids)
            except RuntimeError as e:
                log(f"   {e} — retrying")
                time.sleep(self.args.poll)
                continue
            now = time.time()
            for jid in open_ids:
                st = self.state[jid]
                row = rows.get(jid)
                if row is None:
                    st["missing"] = True
                    continue
                if not st["statuses"] or st["statuses"][-1] != row["status"]:
                    st["statuses"].append(row["status"])
                if row.get("queue_position"):
                    st["queue"].append(row["queue_position"])
                if row["status"] in ANALYSIS_DONE:
                    st["done_at"] = now
                    st["final"] = row["status"]
                    st["error"] = row.get("error") or row.get("message")
            if now - last_log > 30:
                last_log = now
                c = Counter(rows[i]["status"] for i in open_ids if i in rows)
                queued = sorted(rows[i]["queue_position"] for i in open_ids
                                if i in rows and rows[i].get("queue_position"))
                log(f"   {time.strftime('%H:%M:%S')} {dict(c)}"
                    + (f", queue positions {queued[:10]}{'…' if len(queued) > 10 else ''}"
                       if queued else ""))
            time.sleep(self.args.poll)

    def render_all(self) -> dict[str, str]:
        """POST /render for every analysed job (cost_test's way), then
        cost_test.wait for each. job id -> outcome."""
        todo = [i for i, s in self.state.items() if s["final"] == "awaiting_review"]
        out: dict[str, str] = {}

        def one(jid: str) -> None:
            try:
                subs = self.ct.http("GET", f"/jobs/{jid}/subtitles")
                self.ct.http("POST", f"/jobs/{jid}/render", json.dumps({
                    "subtitles": self.ct.build_phrases(subs["subtitles"]),
                    "disabled_cuts": []}).encode(),
                    {"Content-Type": "application/json"})
                j = self.ct.wait(jid, "done", self.args.job_timeout)
                out[jid] = ("done" if j.get("status") == "done" else
                            f"render failed: {j.get('error') or j.get('message')}")
            except Exception as e:
                out[jid] = f"render failed: {self.ct.redact(e)[:200]}"
            log(f"   render {jid}: {out[jid]}")

        with ThreadPoolExecutor(max_workers=max(1, len(todo))) as pool:
            list(pool.map(one, todo))
        return out

    def find_ghosts(self) -> tuple[dict[str, list[str]], list[str], str | None]:
        """Jobs on the server with our file names: (filename -> job ids
        with more than one job, ids we never got an answer for, note)."""
        try:
            rows = self.ct.http("GET", "/jobs")
        except Exception as e:
            return {}, [], f"GET /jobs unavailable ({self.ct.redact(e)[:80]}) — " \
                           "duplicate/ghost check skipped (accounts off?)"
        ours: dict[str, list[str]] = {}
        for r in rows if isinstance(rows, list) else []:
            if (r.get("filename") or "").startswith(self.prefix):
                ours.setdefault(r["filename"], []).append(r["id"])
        dups = {f: ids for f, ids in ours.items() if len(ids) > 1}
        ghosts = [i for ids in ours.values() for i in ids if i not in self.accepted]
        note_created(self.args.out, ghosts, f"burst {self.run_id} ghost")
        return dups, ghosts, None

    # ── cleanup ──────────────────────────────────────────────────────
    def cleanup(self, ids: list[str]) -> list[str]:
        pending = list(dict.fromkeys(ids))
        if not pending:
            return []
        log(f"cleanup: deleting {len(pending)} jobs (waiting for running ones)")
        deadline = time.time() + self.args.cleanup_timeout
        while pending:
            try:
                rows = self.status_rows(pending, record=False)
            except RuntimeError as e:
                log(f"   {e}")
                rows = {i: {"status": "?"} for i in pending}
            pending = [i for i in pending if i in rows]
            ready = [i for i in pending
                     if rows[i].get("status") not in ("processing", "pending")]
            if ready:
                self.ct.delete_jobs(ready)
            if not pending or time.time() > deadline:
                break
            time.sleep(10)
        return pending


def drain_check(args, b: "Burst", analysed: float, t_end: float) -> Check:
    """WP7: the queue drains at the predicted rate. Predicted = parallel
    analyses × the speed of this run's jobs that never waited in the
    queue (seconds of analysis per video minute), unless
    --expect-video-min-per-hour gives it."""
    name = "queue drains at the predicted rate"
    done = {i: s for i, s in b.state.items()
            if s["final"] in ("awaiting_review", "done") and s["done_at"]}
    if not done or not analysed:
        return Check(name, FAIL if b.accepted else SKIP,
                     "no analysis finished" if b.accepted else "nothing accepted")
    t0 = min(b.accepted[i]["t1"] for i in done)
    span = max(1.0, t_end - t0)
    actual = analysed / span * 3600
    queued = any(s["queue"] for s in b.state.values())
    if args.expect_video_min_per_hour:
        predicted, how = args.expect_video_min_per_hour, "--expect-video-min-per-hour"
    else:
        speeds = [(s["done_at"] - b.accepted[i]["t1"]) / b.accepted[i]["minutes"]
                  for i, s in done.items() if not s["queue"]]
        if not speeds:
            return Check(name, INFO, f"{actual:.0f} video-min/h; no unqueued "
                         "job to predict from")
        s_per_min = statistics.median(speeds)
        slots = min(args.max_analyze, len(b.accepted))
        predicted = slots * 3600 / max(1e-6, s_per_min)
        how = (f"{slots} parallel × {s_per_min:.0f} s per video-min "
               "(median of the jobs that never queued)")
        if not queued:
            # No backlog: the slots were never all busy, so the rate says
            # nothing about draining.
            return Check(name, INFO, f"{actual:.0f} video-min/h, no queue built "
                         f"up (prediction {predicted:.0f} from {how})")
    ok = actual >= args.min_drain_share * predicted
    return Check(f"{name} (≥ {args.min_drain_share:.0%})", PASS if ok else FAIL,
                 f"{analysed:g} video-min in {span / 60:.1f} min = {actual:.0f} "
                 f"video-min/h vs {predicted:.0f} predicted ({how})")


def main(args, base: str) -> Result:
    admin = admin_identity()
    if admin is None:
        raise UsageError("burst needs CLEO_ADMIN_TOKEN (service identity, "
                         "/admin/costs)")
    ct = import_cost_test(base, admin.token)
    plan = parse_clips(args.clips, ct)
    executor = resolve_limits(args, server_queue(ct))
    k = sum(c for *_, c in plan)
    video_min = sum(m * c for _, m, _, c in plan)
    try:
        before = ct.http("GET", "/admin/costs")
    except Exception as e:
        raise UsageError(f"/admin/costs: {ct.redact(e)}") from None
    rate, rate_src = estimate_rate(before, args.render)
    estimate = rate * video_min
    min_accepted = (args.min_accepted if args.min_accepted is not None
                    else min(k, args.max_analyze + args.max_queue))
    worst = worst_case_minutes(args)
    if args.time_budget_min and worst > args.time_budget_min:
        raise UsageError(
            f"this run can take {worst:.0f} min before its cleanup is done "
            f"(window + {UPLOAD_TIMEOUT_MIN} min upload timeout + --job-timeout"
            f"{' ×2 (render)' if args.render else ''} + --cleanup-timeout), above "
            f"the time budget of {args.time_budget_min:g} min (the CI job would "
            "be killed mid-run): lower --job-timeout / --cleanup-timeout")
    log(f"burst: {k} uploads ({video_min:g} video-min) within {args.window:g}s "
        f"against {base}{' + render' if args.render else ''}; ingest executor "
        f"{executor}, {args.max_analyze} parallel + {args.max_queue} queued")
    # Only this run's own numbers: the whole server's spend would end up
    # in public Actions logs.
    log(f"COST ESTIMATE: ≈ ${estimate:.2f} (${rate:.4f}/video-min from {rate_src})")
    if estimate > args.max_usd:
        raise UsageError(f"estimate ${estimate:.2f} is above --max-usd "
                         f"{args.max_usd:g} — raise it if you mean it")

    rec = Recorder()
    b = Burst(args, base, ct, rec)
    renders: dict[str, str] = {}
    dups: dict[str, list[str]] = {}
    ghost_note = None
    after: dict = {}
    leftovers: list[str] = []
    t_start = time.time()
    completed = False
    try:
        with tempfile.TemporaryDirectory(prefix="lt-burst-") as tmp:
            log("building clips (cost_test.make_video)…")
            clips = b.make_clips(plan, Path(tmp))
            log(f"uploading {len(clips)} clips over {args.window:g}s…")
            t_start = time.time()
            b.upload_all(clips)
        log(f"{len(b.accepted)}/{k} accepted; watching the analyses…")
        b.watch_analysis()
        if args.render:
            log("rendering…")
            renders = b.render_all()
        dups, b.orphans, ghost_note = b.find_ghosts()
        try:
            after = ct.http("GET", "/admin/costs")
        except Exception as e:
            rec.notes.append(f"/admin/costs after the run failed: {ct.redact(e)[:120]}")
        completed = True
    finally:
        if not completed:
            # Aborted (error, Ctrl-C): an upload in flight may have made a
            # job we never heard of — find it by its file name.
            try:
                b.orphans = b.find_ghosts()[1]
            except Exception as e:
                log(f"ghost search failed: {e}")
        created = list(dict.fromkeys(list(b.accepted) + b.orphans))
        interrupted = False
        try:
            leftovers = b.cleanup(created)
        except KeyboardInterrupt:  # second Ctrl-C: at least say what's left
            leftovers, interrupted = created, True
        if leftovers:
            log("COULD NOT DELETE: " + ",".join(leftovers))
            log(f"  later: python -m loadtest cleanup --base-url {base} "
                f"--ids {','.join(leftovers)}")
        b.mon.close()
        if interrupted:
            raise KeyboardInterrupt
    t_end = max([s["done_at"] or 0 for s in b.state.values()] or [time.time()])

    # ── checks ───────────────────────────────────────────────────────
    checks = evaluate(rec, [
        # 503 server_busy is an intended refusal; its Retry-After header
        # is checked by `abuse` (curl doesn't show headers here).
        Expect(LABEL_UPLOAD, frozenset({200, 503}), None, refusals=False),
        Expect(LABEL_STATUS, frozenset({200}), args.p95_ms),
    ], max_error_rate=args.max_error_rate, max_refusal_rate=args.max_refusal_rate)
    busy = sum(1 for u in b.uploads if u["code"] == "503")
    n_ok = len(b.accepted)
    # A burst nothing got through measured nothing: never a PASS.
    checks.append(Check(
        f"uploads accepted ≥ {min_accepted} of {k}",
        PASS if n_ok >= max(1, min_accepted) else FAIL,
        f"{n_ok}/{k} accepted"
        + (f", {busy} refused as server_busy (503; intended once "
           f"{args.max_analyze} + {args.max_queue} are taken — Retry-After is "
           "checked by `abuse`)" if busy else "")))
    st = b.state
    lost = [i for i, s in st.items() if s["missing"]]
    stuck = [i for i, s in st.items() if s["done_at"] is None and not s["missing"]]
    failed = {i: s.get("error") for i, s in st.items() if s["final"] == "error"}
    non_mono = [i for i, s in st.items()
                if any(b2 > a for a, b2 in zip(s["queue"], s["queue"][1:], strict=False))]
    checks.append(Check("0 lost jobs (accepted, then missing)",
                        PASS if not lost else FAIL,
                        f"{len(st)} accepted" + (f"; lost {lost}" if lost else "")))
    if ghost_note:
        checks.append(Check("0 duplicated / ghost jobs", SKIP, ghost_note))
    else:
        checks.append(Check(
            "0 duplicated / ghost jobs", PASS if not dups and not b.orphans else FAIL,
            (f"duplicates {dups}; " if dups else "")
            + (f"ghosts (created, client got an error) {b.orphans}" if b.orphans
               else "none")))
    checks.append(Check("every analysis finished within --job-timeout",
                        PASS if not stuck else FAIL,
                        f"{len(stuck)} still running" if stuck else
                        f"{len(st)} finished"))
    checks.append(Check("0 failed analyses", PASS if not failed else FAIL,
                        "; ".join(f"{i}: {e}" for i, e in failed.items())[:500]
                        or f"{len(st)} ok"))
    checks.append(Check("queue positions only shrink", PASS if not non_mono else FAIL,
                        f"{sum(1 for s in st.values() if s['queue'])} jobs queued"
                        + (f"; grew for {non_mono}" if non_mono else "")))
    if args.render:
        bad = {i: o for i, o in renders.items() if o != "done"}
        checks.append(Check("0 failed renders", PASS if not bad else FAIL,
                            "; ".join(f"{i}: {o}" for i, o in bad.items())[:500]
                            or f"{len(renders)} rendered"))
    checks.append(Check("cleanup: every created job deleted",
                        PASS if not leftovers else FAIL,
                        "all deleted" if not leftovers else
                        f"left over: {', '.join(leftovers)}"))

    # ── costs ────────────────────────────────────────────────────────
    ours = [r for r in after.get("rows", [])
            if r["job_id"] in b.accepted or r["job_id"] in b.orphans]
    actual = sum(r["usd_all_in"] for r in ours)
    mins = sum(r["video_minutes"] for r in ours)
    cost_lines = [
        f"- Estimate before: **${estimate:.2f}** (${rate:.4f}/video-min, {rate_src})",
        f"- Actual for these jobs (/admin/costs rows): **${actual:.2f}** for "
        f"{mins:.1f} video-min" + (f" = ${actual / mins:.4f}/video-min" if mins else ""),
    ]
    # Like for like only with --render: the reference jobs (cost-test
    # runs) were rendered too.
    if mins and args.render and "earlier test jobs" in rate_src:
        within = abs(actual / mins - rate) <= 0.2 * rate
        checks.append(Check("cost per video-minute within 20% of the estimate",
                            PASS if within else FAIL,
                            f"${actual / mins:.4f} vs ${rate:.4f}"))
    else:
        checks.append(Check("cost per video-minute", INFO,
                            f"${actual / mins:.4f}/video-min" if mins else "no cost rows"))
    analysed = sum(u["minutes"] for i, u in b.accepted.items()
                   if st.get(i, {}).get("final") in ("awaiting_review", "done"))
    checks.append(drain_check(args, b, analysed, t_end))
    rec.counters.update(Counter(f"upload → {u['code']}" for u in b.uploads))
    rows_md = ["| File | Profile | Min | Upload | Job | Statuses | Queue positions |",
               "|---|---|---:|---|---|---|---|"]
    for u in sorted(b.uploads, key=lambda u: u["filename"]):
        s = st.get(u["job"] or "", {})
        rows_md.append(
            f"| {u['filename']} | {u['profile']} | {u['minutes']:g} | {u['code']} | "
            f"`{u['job'] or '-'}` | {' → '.join(s.get('statuses', [])) or '-'} | "
            f"{' → '.join(map(str, _runs(s.get('queue', [])))) or '-'} |")
    meta = {"Target": base, "Identity": admin.label, "Run id": b.run_id,
            "Ingest executor": f"{executor} ({args.max_analyze} parallel, "
                               f"queue {args.max_queue})",
            "Clips": args.clips, "Uploads": f"{k} within {args.window:g} s",
            "Render": args.render, "Video minutes": f"{video_min:g}"}
    return Result(NAME, meta, rec, max(1.0, t_end - t_start), checks,
                  sections=[("Costs", "\n".join(cost_lines)),
                            ("Jobs", "\n".join(rows_md))],
                  extra={"estimate_usd": estimate, "actual_usd": actual,
                         "leftovers": leftovers})
