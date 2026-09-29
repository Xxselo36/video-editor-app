"""editor-saves — timeline saves in the review editor (CPU on the server).

N editors each POST /jobs/{id}/edit-segments every 5–10 s against jobs
that are in review (awaiting_review): small trims, sometimes a deleted
clip, changed effects and — the expensive case before WP5 — reorders.
Meanwhile /health and GET /jobs/status are probed once a second: saves
must not starve the cheap reads. At the end every job gets its original
timeline back (unless --no-restore) and is checked to still exist.

The jobs are modified! Use test jobs only (e.g. from the cost-test
workflow with keep_jobs, or burst). Against a non-local target the
harness refuses jobs that /admin/costs doesn't list as test jobs of the
service user, unless --allow-foreign-jobs.

Pass: save p95 < --save-p95-ms (default 200; WP5 target 100 — before
WP5 each save waits for a preview re-encode, so expect FAIL there),
cheap reads p95 < 200 ms, only intended status codes, no failed preview
rebuilds, 0 lost jobs, every timeline restored.
"""
from __future__ import annotations

import asyncio
import random
import time
from urllib.parse import quote

from ..common import (
    Recorder, UsageError, admin_identity, auth_mode, auto_procs, call,
    is_local, lag_monitor, log, make_session, probe_loop, read_ids,
    require_identity, resolve_identities, run_workers, sleep_until,
)
from ..report import Check, Expect, FAIL, INFO, PASS, SKIP, WARN, Result, evaluate

NAME = "editor-saves"
HELP = "N editors saving timelines (incl. reorders) every 5–10 s"
LABEL_SAVE = "POST /jobs/{id}/edit-segments"
LABEL_REORDER = "POST /jobs/{id}/edit-segments (reorder)"
EFFECT_KEYS = ("speed", "fadeIn", "fadeOut", "volume")


def add_args(p) -> None:
    p.add_argument("--editors", type=int, default=10, help="WP7: 100–500")
    p.add_argument("--minutes", type=float, default=3)
    p.add_argument("--min-interval", type=float, default=5.0)
    p.add_argument("--max-interval", type=float, default=10.0)
    p.add_argument("--reorder-prob", type=float, default=0.3)
    p.add_argument("--delete-prob", type=float, default=0.15)
    p.add_argument("--effects-prob", type=float, default=0.3)
    p.add_argument("--save-p95-ms", type=float, default=200.0)
    p.add_argument("--no-restore", action="store_true",
                   help="leave the last saved timeline on the jobs")
    p.add_argument("--allow-foreign-jobs", action="store_true",
                   help="skip the 'test jobs only' safety check")


def mutate(base: list[dict], duration: float, rnd: random.Random,
           reorder_prob: float, delete_prob: float,
           effects_prob: float) -> tuple[list[dict], bool]:
    """A plausible edit of `base`: trims, maybe a deleted clip, effects,
    maybe a reorder (moved or swapped clips). Returns (segments,
    reordered)."""
    segs = [{k: s.get(k) for k in ("start", "end", *EFFECT_KEYS)
             if s.get(k) is not None} for s in base]
    end_cap = duration if duration > 0 else max(s["end"] for s in segs) + 1
    for s in segs:
        if rnd.random() < 0.5:
            s["start"] = min(max(0.0, s["start"] + rnd.uniform(-0.3, 0.3)),
                             s["end"] - 0.2)
        if rnd.random() < 0.5:
            s["end"] = max(min(end_cap, s["end"] + rnd.uniform(-0.3, 0.3)),
                           s["start"] + 0.2)
        s["start"] = round(max(0.0, s["start"]), 3)
        s["end"] = round(s["end"], 3)
    if len(segs) > 1 and rnd.random() < delete_prob:
        segs.pop(rnd.randrange(len(segs)))
    if rnd.random() < effects_prob:
        s = rnd.choice(segs)
        s["speed"] = rnd.choice([0.5, 0.75, 1.0, 1.25, 1.5, 2.0])
        s["volume"] = round(rnd.uniform(0.3, 1.6), 2)
        s["fadeIn"] = rnd.choice([0.0, 0.0, 0.3, 0.5])
        s["fadeOut"] = rnd.choice([0.0, 0.0, 0.3, 0.5])
    reordered = len(segs) > 1 and rnd.random() < reorder_prob
    if reordered:
        if rnd.random() < 0.5:
            segs.insert(0, segs.pop())  # last clip to the front
        else:
            a, b = rnd.sample(range(len(segs)), 2)
            segs[a], segs[b] = segs[b], segs[a]
    return segs, reordered


def _timeline(segs: list[dict]) -> list[tuple]:
    return [(round(float(s["start"]), 3), round(float(s["end"]), 3),
             *(round(float(s.get(k, d)), 3) for k, d in
               zip(EFFECT_KEYS, (1.0, 0.0, 0.0, 1.0), strict=True)))
            for s in segs]


async def _test_job_ids(s, base: str) -> set[str] | None:
    """Ids /admin/costs lists as test jobs (or jobs of the service user).
    None when that can't be asked (no admin token)."""
    admin = admin_identity()
    if admin is None:
        return None
    r = await call(s, None, "", "GET", base + "/admin/costs",
                   headers=await admin.headers(s), timeout=300)
    if r.status != 200:
        return None
    return {row["job_id"] for row in (r.json() or {}).get("rows", [])
            if row.get("test") or row.get("owner_id") == "svc:admin"}


async def _setup(args, base: str, identities: list) -> dict:
    ids = read_ids(args.ids, args.ids_file)
    if not ids:
        raise UsageError("editor-saves needs --ids / --ids-file: jobs in review "
                         "(awaiting_review) that may be modified")
    async with make_session(args.timeout) as s:
        auth_on = await auth_mode(s, base, identities[0])
        require_identity(auth_on, identities)
        if not is_local(base) and not args.allow_foreign_jobs:
            test_ids = await _test_job_ids(s, base)
            if test_ids is None:
                raise UsageError("can't verify that these are test jobs (needs "
                                 "CLEO_ADMIN_TOKEN for /admin/costs); pass "
                                 "--allow-foreign-jobs if you are sure")
            foreign = [i for i in ids if i not in test_ids]
            if foreign:
                raise UsageError("not test jobs (per /admin/costs): "
                                 + ", ".join(foreign)
                                 + " — refusing to modify them")
        jobs = []
        for n, jid in enumerate(ids):
            ident = identities[n % len(identities)]
            r = await call(s, None, "", "GET", f"{base}/jobs/{quote(jid)}",
                           headers=await ident.headers(s))
            job = r.json() if r.status == 200 else None
            if not isinstance(job, dict):
                raise UsageError(f"job {jid}: HTTP {r.status or r.error}")
            if job.get("status") != "awaiting_review":
                raise UsageError(f"job {jid} is {job.get('status')!r}, needs "
                                 "awaiting_review")
            base_segs = job.get("edit_segments") or [
                {"start": a, "end": b} for a, b in job.get("preview_segments") or []]
            if not base_segs:
                raise UsageError(f"job {jid} has no segments")
            jobs.append({"id": jid, "base": base_segs,
                         "duration": float(job.get("duration") or 0),
                         "ident": n % len(identities),
                         "preview_version": job.get("preview_version")})
    return {"auth_on": auth_on, "jobs": jobs}


async def _restore(args, base: str, identities: list, jobs: list[dict],
                   rec: Recorder) -> list[Check]:
    """Put each job's original timeline back and check it's still there."""
    lost, restored, failed = [], 0, []
    async with make_session(max(args.timeout, 120)) as s:
        for job in jobs:
            ident = identities[job["ident"]]
            url = f"{base}/jobs/{quote(job['id'])}"
            if not args.no_restore:
                r = await call(s, None, "", "POST", url + "/edit-segments",
                               headers=await ident.headers(s),
                               json_body={"segments": job["base"]})
                if r.status != 200:
                    failed.append(f"{job['id']} (HTTP {r.status or r.error})")
                    continue
            r = await call(s, None, "", "GET", url, headers=await ident.headers(s))
            if r.status == 404:
                lost.append(job["id"])
                continue
            now = r.json() or {}
            if not args.no_restore:
                if _timeline(now.get("edit_segments") or []) == _timeline(job["base"]):
                    restored += 1
                else:
                    failed.append(f"{job['id']} (timeline differs)")
            if now.get("preview_version") is not None and job["preview_version"] is not None:
                rec.counters["preview versions built"] += (
                    now["preview_version"] - job["preview_version"])
    checks = [Check("0 lost jobs", PASS if not lost else FAIL,
                    f"{len(jobs)} jobs" + (f"; lost: {', '.join(lost)}" if lost else ""))]
    if args.no_restore:
        checks.append(Check("original timelines restored", SKIP, "--no-restore"))
    else:
        checks.append(Check("original timelines restored",
                            PASS if not failed else FAIL,
                            f"{restored}/{len(jobs)}"
                            + (f"; failed: {', '.join(failed)}" if failed else "")))
    return checks


def main(args, base: str) -> Result:
    identities = resolve_identities(args.identity)
    if args.editors < 1 or args.minutes <= 0:
        raise UsageError("--editors and --minutes must be > 0")
    if not 0 < args.min_interval <= args.max_interval:
        raise UsageError("need 0 < --min-interval ≤ --max-interval")
    setup = asyncio.run(_setup(args, base, identities))
    jobs = setup["jobs"]
    duration = args.minutes * 60
    params = {
        "jobs": jobs, "min_interval": args.min_interval,
        "max_interval": args.max_interval, "reorder_prob": args.reorder_prob,
        "delete_prob": args.delete_prob, "effects_prob": args.effects_prob,
        "seed": args.seed if args.seed is not None else int(time.time()),
    }
    procs = auto_procs(args.procs, args.editors)
    log(f"editor-saves: {args.editors} editors on {len(jobs)} jobs, a save "
        f"every {args.min_interval:g}–{args.max_interval:g}s for "
        f"{args.minutes:g} min against {base}")
    try:
        rec = run_workers(__name__, "worker", base=base, params=params,
                          identities=identities, total_vus=args.editors,
                          procs=procs, duration_s=duration, timeout=args.timeout)
    finally:
        # Restore even after Ctrl-C / a crash in the run.
        restore_rec = Recorder()
        restore_checks = asyncio.run(_restore(args, base, identities, jobs,
                                              restore_rec))
    rec.merge(restore_rec)
    p95 = args.p95_ms
    expects = [
        Expect(LABEL_SAVE, frozenset({200}), args.save_p95_ms, required=True),
        Expect(LABEL_REORDER, frozenset({200}), args.save_p95_ms),
        Expect("GET /health", frozenset({200}), p95, refusals=False, all_ok=True),
        Expect("GET /jobs/status", frozenset({200, 304}), p95),
    ]
    checks = evaluate(rec, expects, max_error_rate=args.max_error_rate,
                      max_refusal_rate=args.max_refusal_rate)
    c = rec.counters
    answered = c["answers with preview_ok"] + c["answers without preview_ok"]
    if not answered:
        checks.append(Check("0 failed preview rebuilds", FAIL,
                            "no save was answered 200 — nothing to judge"))
    elif c["answers with preview_ok"]:
        failed = c["preview rebuild failed"]
        checks.append(Check("0 failed preview rebuilds",
                            PASS if failed == 0 else FAIL,
                            f"{failed} saves answered preview_ok=false without "
                            f"being superseded; {c['superseded']} superseded"))
    else:
        checks.append(Check("preview rebuilds", INFO,
                            "answers carry no preview_ok (WP5: no server "
                            "rebuild)"))
    checks += restore_checks
    if identities[0].kind == "admin":
        checks.append(Check(
            "real-user path measured", WARN,
            "measured as the service identity (X-Admin-Token): no JWT "
            "verification or ownership checks — use --identity user for "
            "the WP7 gate"))
    per_job = args.editors / len(jobs)
    meta = {
        "Target": base, "Identity": identities[0].label,
        "Editors": args.editors, "Jobs": f"{len(jobs)} ({per_job:.1f} editors/job)",
        "Save interval": f"{args.min_interval:g}–{args.max_interval:g} s",
        "Duration": f"{args.minutes:g} min",
        "Reorder / delete / effects prob.":
            f"{args.reorder_prob:g} / {args.delete_prob:g} / {args.effects_prob:g}",
        "Processes": procs,
    }
    if per_job > 1:
        rec.notes.append("several editors share a job: saves of one job "
                         "supersede each other (the server rebuilds only the "
                         "newest) — more jobs give a harder test")
    return Result(NAME, meta, rec, duration, checks)


async def worker(ctx) -> Recorder:
    rec = Recorder()
    async with make_session(ctx.timeout) as session:
        tasks = [lag_monitor(rec, ctx.stop_at)]
        tasks += [_editor(session, rec, ctx, i) for i in ctx.vus]
        if ctx.proc == 0:
            tasks.append(_probes(session, rec, ctx))
        await asyncio.gather(*tasks)
    return rec


async def _probes(session, rec, ctx) -> None:
    ident = ctx.identities[0]
    ids = ",".join(quote(j["id"]) for j in ctx.params["jobs"][:50])
    await sleep_until(ctx.start_at)
    await probe_loop(session, rec, ctx.base, ctx.stop_at,
                     [("GET /health", "/health"),
                      ("GET /jobs/status", f"/jobs/status?ids={ids}")],
                     ident=ident)


async def _editor(session, rec: Recorder, ctx, i: int) -> None:
    p = ctx.params
    rnd = random.Random(p["seed"] * 1_000_003 + i)
    job = p["jobs"][i % len(p["jobs"])]
    ident = ctx.identities[job["ident"]]
    url = f"{ctx.base}/jobs/{quote(job['id'])}/edit-segments"
    await sleep_until(ctx.start_at + rnd.uniform(0, p["max_interval"]))
    while time.time() < ctx.stop_at:
        t0 = time.time()
        segs, reordered = mutate(job["base"], job["duration"], rnd,
                                 p["reorder_prob"], p["delete_prob"],
                                 p["effects_prob"])
        try:
            headers = await ident.headers(session)
        except Exception as e:
            rec.counters["token errors"] += 1
            if len(rec.notes) < 10:
                rec.notes.append(f"{ident.label}: {e}"[:200])
            headers = None
        if headers is not None:
            r = await call(session, rec, LABEL_REORDER if reordered else LABEL_SAVE,
                           "POST", url, headers=headers, json_body={"segments": segs})
            body = r.json() if r.status == 200 else None
            if isinstance(body, dict):
                if "preview_ok" in body:
                    rec.counters["answers with preview_ok"] += 1
                    if body.get("superseded"):
                        rec.counters["superseded"] += 1
                    elif not body.get("preview_ok"):
                        rec.counters["preview rebuild failed"] += 1
                else:
                    rec.counters["answers without preview_ok"] += 1
        # Next save 5–10 s after this one started (debounced editor).
        await sleep_until(min(t0 + rnd.uniform(p["min_interval"], p["max_interval"]),
                              ctx.stop_at))
