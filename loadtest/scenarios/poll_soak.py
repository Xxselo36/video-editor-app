"""poll-soak — the dashboard poll (cheap, read-only).

N virtual users each poll GET /jobs/status?ids=… for a few job ids every
2 s (sending the ETag back as If-None-Match like web/src/lib/jobStatus.ts,
so unchanged answers are 304), and open the Library (GET /jobs) about
once a minute. Meanwhile /health and /ready are probed once a second.

Pass: p95 < 200 ms for every cheap read, only intended status codes,
/health 100 % answered, no job id that existed at the start goes
"missing" (lost), transport errors ≤ --max-error-rate.
"""
from __future__ import annotations

import asyncio
import math
import random
import time
from urllib.parse import quote

from ..common import (
    Recorder, UsageError, auth_mode, auto_procs, call, job_status_map,
    lag_monitor, list_jobs, log, make_session, probe_loop, read_ids,
    require_identity, resolve_identities, run_workers, sleep_until,
)
from ..report import Check, Expect, PASS, FAIL, INFO, WARN, Result, evaluate

NAME = "poll-soak"
HELP = "N users polling GET /jobs/status every 2 s (+ Library, /health, /ready)"
LABEL_STATUS = "GET /jobs/status"
LABEL_LIBRARY = "GET /jobs (library)"
LABEL_LIBRARY_ALL = "GET /jobs (service: all jobs)"


def add_args(p) -> None:
    p.add_argument("--users", type=int, default=50,
                   help="virtual users (WP7: 1000)")
    p.add_argument("--minutes", type=float, default=5, help="WP7: 30")
    p.add_argument("--interval", type=float, default=2.0,
                   help="seconds between two polls of one user")
    p.add_argument("--ids-per-user", type=int, default=5,
                   help="job ids per status poll (dashboard cards)")
    p.add_argument("--library-every", type=float, default=60,
                   help="seconds between two GET /jobs of one user (0 = never)")
    p.add_argument("--admin-library-every", type=float, default=60,
                   help="as service identity GET /jobs lists EVERY job; it is "
                        "then sent only this often in total (0 = never)")
    p.add_argument("--no-etag", action="store_true",
                   help="don't send If-None-Match (every answer is a 200)")
    p.add_argument("--ramp", type=float, default=None,
                   help="seconds over which users start (default min(60, T/10))")
    p.add_argument("--synthetic-ids", type=int, default=20,
                   help="when no job ids are given/found: poll this many ids "
                        "that don't exist (still exercises the DB lookup)")


async def _setup(args, base: str, identities: list) -> dict:
    async with make_session(args.timeout) as s:
        auth_on = await auth_mode(s, base, identities[0])
        require_identity(auth_on, identities)
        given = read_ids(args.ids, args.ids_file)
        pools: list[list[str]] = []
        notes: list[str] = []
        if given:
            pools = [given] * len(identities)
        elif auth_on:
            for ident in identities:
                rows = await list_jobs(s, base, ident) or []
                pools.append([r["id"] for r in rows][:50])
            if identities[0].kind == "admin" and pools[0]:
                notes.append("job ids: the 50 newest jobs of all users "
                              "(service identity)")
        n = max(1, args.synthetic_ids)
        synthetic = [f"lt-missing-{i:03d}" for i in range(n)]
        if not any(pools):
            pools = [synthetic] * len(identities)
            notes.append(f"no job ids given or found: polling {n} ids that "
                         "don't exist (answers list them as missing)")
        elif not all(pools):
            pools = [pool or synthetic for pool in pools]
            notes.append("some test users have no jobs: they poll ids that "
                         "don't exist")
        # Per identity: a job one test user sees may be "missing" for another.
        present: list[list[str]] = []
        for ident, pool in zip(identities, pools, strict=True):
            seen = ([] if pool is synthetic else
                    sorted(await job_status_map(s, base, ident, pool)))
            present.append(seen)
    return {"auth_on": auth_on, "pools": pools, "present": present,
            "given": bool(given), "notes": notes}


def main(args, base: str) -> Result:
    identities = resolve_identities(args.identity)
    if args.users < 1 or args.minutes <= 0 or args.interval <= 0:
        raise UsageError("--users, --minutes and --interval must be > 0")
    setup = asyncio.run(_setup(args, base, identities))
    duration = args.minutes * 60
    ramp = args.ramp if args.ramp is not None else min(60.0, duration / 10)
    kind = identities[0].kind
    user_library = args.library_every if (setup["auth_on"] and kind == "user") else 0
    admin_library = (args.admin_library_every
                     if (setup["auth_on"] and kind == "admin") else 0)
    params = {
        "pools": setup["pools"], "present": setup["present"],
        "interval": args.interval, "ids_per_user": max(1, args.ids_per_user),
        "library_every": user_library, "admin_library_every": admin_library,
        "etag": not args.no_etag, "ramp": ramp,
        "seed": args.seed if args.seed is not None else int(time.time()),
    }
    procs = auto_procs(args.procs, args.users)
    log(f"poll-soak: {args.users} users × every {args.interval:g}s for "
        f"{args.minutes:g} min against {base} as {identities[0].label} "
        f"({procs} process{'es' if procs > 1 else ''}, "
        f"{len(set().union(*setup['present']))} existing job ids)")
    rec = run_workers(__name__, "worker", base=base, params=params,
                      identities=identities, total_vus=args.users, procs=procs,
                      duration_s=duration, timeout=args.timeout)
    rec.notes = setup["notes"] + rec.notes
    if not setup["auth_on"]:
        rec.notes.append("accounts are off on the target: GET /jobs (Library) "
                         "doesn't exist there (404) and was not called")
    elif kind == "admin":
        rec.notes.append("service identity: GET /jobs lists every job of every "
                         f"user — sent once per {args.admin_library_every:g}s "
                         "in total, report only (use --identity user for the "
                         "real Library load)")

    p95 = args.p95_ms
    expects = [
        Expect(LABEL_STATUS, frozenset({200, 304}), p95, required=True),
        Expect(LABEL_LIBRARY, frozenset({200}), p95),
        Expect(LABEL_LIBRARY_ALL, frozenset({200}), None),
        Expect("GET /health", frozenset({200}), p95, refusals=False, all_ok=True),
        Expect("GET /ready", frozenset({200}), p95),
    ]
    checks = evaluate(rec, expects, max_error_rate=args.max_error_rate,
                      max_refusal_rate=args.max_refusal_rate)
    lost = sorted(rec.lost_ids)
    watched = len(set().union(*setup["present"]))
    # Ids found on the server (not given) may be real users' jobs, which
    # they can delete meanwhile: only a warning then.
    checks.append(Check(
        "0 lost jobs (existing ids never reported missing)",
        PASS if not lost else (FAIL if setup["given"] else WARN),
        f"{watched} ids watched" + (f"; lost: {', '.join(lost[:10])}" if lost else "")))
    target_rps = args.users / args.interval
    got = sum(rec.codes.get(LABEL_STATUS, {}).values()) / duration
    # The first `ramp` seconds run below full rate by design.
    expected = target_rps * max(0.0, duration - ramp / 2) / duration
    # Below 90 %: the load the verdict claims was not applied (slow
    # answers — each user waits for its answer — or requests not sent).
    checks.append(Check(
        f"status poll rate ≥ 90% of {expected:.1f} req/s",
        PASS if got >= 0.9 * expected else FAIL,
        f"{got:.1f} req/s achieved (target {target_rps:.1f} req/s after the ramp)"))
    if kind == "admin":
        checks.append(Check(
            "real-user path measured", WARN,
            "measured as the service identity (X-Admin-Token): no JWT "
            "verification, ownership filter or per-user Library — run "
            "with --identity user for the WP7 gate"))
    not_modified = rec.codes.get(LABEL_STATUS, {}).get("304", 0)
    if not_modified:
        checks.append(Check("ETag / 304 in use", INFO,
                            f"{not_modified} answers were 304 Not Modified"))
    meta = {
        "Target": base, "Identity": identities[0].label
        + (f" (+{len(identities) - 1} more)" if len(identities) > 1 else ""),
        "Users": args.users, "Poll interval": f"{args.interval:g} s",
        "Duration": f"{args.minutes:g} min (ramp {ramp:.0f} s)",
        "Ids per poll": params["ids_per_user"],
        "Accounts on target": setup["auth_on"],
        "Processes": procs,
    }
    return Result(NAME, meta, rec, duration, checks,
                  extra={"target_rps": target_rps, "achieved_rps": got})


async def worker(ctx) -> Recorder:
    rec = Recorder()
    p = ctx.params
    async with make_session(ctx.timeout) as session:
        tasks = [lag_monitor(rec, ctx.stop_at)]
        tasks += [_user(session, rec, ctx, i) for i in ctx.vus]
        if ctx.proc == 0:
            tasks.append(_probes(session, rec, ctx))
            if p["admin_library_every"]:
                tasks.append(_admin_library(session, rec, ctx))
        await asyncio.gather(*tasks)
    return rec


async def _probes(session, rec, ctx) -> None:
    await sleep_until(ctx.start_at)
    await probe_loop(session, rec, ctx.base, ctx.stop_at,
                     [("GET /health", "/health"), ("GET /ready", "/ready")])


async def _admin_library(session, rec, ctx) -> None:
    ident = ctx.identities[0]
    every = ctx.params["admin_library_every"]
    await sleep_until(ctx.start_at + min(every, 10.0))
    while time.time() < ctx.stop_at:
        await call(session, rec, LABEL_LIBRARY_ALL, "GET", ctx.base + "/jobs",
                   headers=await ident.headers(session))
        await sleep_until(min(time.time() + every, ctx.stop_at))


async def _user(session, rec: Recorder, ctx, i: int) -> None:
    p = ctx.params
    rnd = random.Random(p["seed"] * 1_000_003 + i)
    n_ident = len(ctx.identities)
    ident = ctx.identities[i % n_ident]
    pool = p["pools"][i % n_ident]
    ids = rnd.sample(pool, min(p["ids_per_user"], len(pool)))
    watched = set(ids) & set(p["present"][i % n_ident])
    url = f"{ctx.base}/jobs/status?ids={','.join(map(quote, ids))}"
    interval = p["interval"]
    # Users join evenly over the ramp, each at a random phase.
    start = ctx.start_at + p["ramp"] * i / max(1, ctx.total_vus) \
        + rnd.random() * interval
    await sleep_until(start)
    lib_every = p["library_every"]
    next_lib = time.time() + rnd.random() * lib_every if lib_every else math.inf
    etag: str | None = None
    nxt = time.time()
    while time.time() < ctx.stop_at:
        try:
            headers = dict(await ident.headers(session))
        except Exception as e:  # token minting failed
            rec.counters["token errors"] += 1
            if len(rec.notes) < 10:
                rec.notes.append(f"{ident.label}: {e}"[:200])
            await asyncio.sleep(interval)
            continue
        if etag and p["etag"]:
            headers["If-None-Match"] = etag
        r = await call(session, rec, LABEL_STATUS, "GET", url, headers=headers)
        if r.status == 200:
            etag = r.headers.get("etag")
            body = r.json()
            if not isinstance(body, dict):
                rec.counters["status: unparseable body"] += 1
            else:
                lost = watched & set(body.get("missing") or ())
                if lost:
                    rec.lost_ids |= lost
                    watched -= lost
        if time.time() >= next_lib:
            await call(session, rec, LABEL_LIBRARY, "GET", ctx.base + "/jobs",
                       headers={k: v for k, v in headers.items()
                                if k != "If-None-Match"})
            next_lib += lib_every
        nxt += interval
        # A slow answer delays this user's next poll (like the browser,
        # which waits for the answer) instead of bursting to catch up.
        nxt = max(nxt, time.time())
        await sleep_until(min(nxt, ctx.stop_at))
