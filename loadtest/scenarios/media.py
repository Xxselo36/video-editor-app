"""media — video players and downloads (cheap; egress).

M concurrent "players" read a job's preview (or final video) with HTTP
Range requests the way <video> does — sequential chunks paced at the
playback bitrate, now and then a seek — and D downloaders each fetch
GET /jobs/{id}/download (up to --max-download-mb), then pause
--download-pause seconds. Meanwhile /health and
GET /jobs/status are probed once a second (big file responses used to
tie up the API's threadpool).

The API may answer a media request itself (200/206 from the volume,
today) or with a redirect to a presigned R2 URL (307, after WP3). Only
the API's answer is timed; with --follow-redirects the R2 read is done
and reported separately.

Pass: time to response headers p95 < 200 ms, only intended status codes
(200/206/302/307), cheap reads p95 < 200 ms, transport errors ≤
--max-error-rate. Costs Railway egress for what is read from the API
(estimate printed before the run; refused above --max-egress-gb).
"""
from __future__ import annotations

import asyncio
import math
import random
import re
import time
from urllib.parse import quote, urljoin

from ..common import (
    RAILWAY_EGRESS_USD_PER_GB, STATUS_BATCH, Recorder, UsageError, auth_mode, auto_procs,
    call, lag_monitor, log, make_session, probe_loop, read_ids,
    require_identity, resolve_identities, run_workers, sleep_until,
)
from ..report import Check, Expect, INFO, WARN, Result, evaluate

NAME = "media"
HELP = "M concurrent range-GET players + D downloads of preview/proxy/download"
REDIRECTS = (301, 302, 303, 307, 308)
LABEL_R2 = "GET presigned media URL (after redirect)"


def add_args(p) -> None:
    p.add_argument("--streams", type=int, default=20, help="WP7: 200")
    p.add_argument("--downloads", type=int, default=2, help="WP7: 50")
    p.add_argument("--minutes", type=float, default=2)
    p.add_argument("--paths", default="preview-video,watch",
                   help="what players read: /jobs/{id}/<path>, comma-separated "
                        "(preview-video, watch, proxy, … — paths that answer "
                        "404/409 are dropped with a note)")
    p.add_argument("--download-path", default="download")
    p.add_argument("--chunk-kb", type=int, default=1024,
                   help="bytes per range request")
    p.add_argument("--stream-kbps", type=float, default=2500,
                   help="playback bitrate the players are paced at")
    p.add_argument("--seek-prob", type=float, default=0.1)
    p.add_argument("--max-download-mb", type=float, default=100,
                   help="stop each download after this much (egress cap)")
    p.add_argument("--download-pause", type=float, default=30,
                   help="seconds a downloader waits before its next download")
    p.add_argument("--max-egress-gb", type=float, default=25,
                   help="refuse to start when the egress estimate is higher")
    p.add_argument("--follow-redirects", action="store_true",
                   help="also read from the presigned URL a 30x points to")


def _total_size(r) -> int | None:
    m = re.search(r"/(\d+)\s*$", r.headers.get("content-range", ""))
    if m:
        return int(m.group(1))
    if r.status == 200 and r.headers.get("content-length", "").isdigit():
        return int(r.headers["content-length"])
    return None


async def _probe_target(s, base: str, headers: dict, jid: str, path: str,
                        follow: bool) -> dict | str:
    """Size (and redirect) of one media URL, or why it can't be used."""
    url = f"{base}/jobs/{quote(jid)}/{path}"
    r = await call(s, None, "", "GET", url, headers={**headers, "Range": "bytes=0-0"},
                   read_limit=1, keep_body=False)
    if r.status in REDIRECTS:
        loc = urljoin(url, r.headers.get("location", ""))
        if not follow:
            return {"id": jid, "path": path, "url": url, "size": None,
                    "redirect": True}
        r2 = await call(s, None, "", "GET", loc, headers={"Range": "bytes=0-0"},
                        read_limit=1, keep_body=False)
        size = _total_size(r2) if r2.status in (200, 206) else None
        if not size:
            return f"{jid}/{path}: redirect target answered {r2.status or r2.error}"
        return {"id": jid, "path": path, "url": url, "size": size, "redirect": True}
    if r.status in (200, 206):
        size = _total_size(r)
        if not size:
            return f"{jid}/{path}: no size in the answer"
        return {"id": jid, "path": path, "url": url, "size": size, "redirect": False}
    return f"{jid}/{path}: HTTP {r.status or r.error}"


async def _setup(args, base: str, identities: list) -> dict:
    ids = read_ids(args.ids, args.ids_file)
    if not ids:
        raise UsageError("media needs --ids / --ids-file (jobs with a preview; "
                         "rendered jobs for watch/download)")
    paths = [x.strip().strip("/") for x in args.paths.split(",") if x.strip()]
    streams, downloads, dropped = [], [], []
    async with make_session(args.timeout) as s:
        auth_on = await auth_mode(s, base, identities[0])
        require_identity(auth_on, identities)
        for n, jid in enumerate(ids):
            ident = identities[n % len(identities)]
            headers = await ident.headers(s)
            for path in paths:
                t = await _probe_target(s, base, headers, jid, path,
                                        args.follow_redirects)
                (dropped.append(t) if isinstance(t, str)
                 else streams.append({**t, "ident": n % len(identities)}))
            if args.downloads:
                t = await _probe_target(s, base, headers, jid, args.download_path,
                                        args.follow_redirects)
                (dropped.append(t) if isinstance(t, str)
                 else downloads.append({**t, "ident": n % len(identities)}))
    if args.streams and not streams:
        raise UsageError("no usable stream target: " + "; ".join(dropped))
    if args.downloads and not downloads:
        raise UsageError("no usable download target: " + "; ".join(dropped))
    return {"auth_on": auth_on, "streams": streams, "downloads": downloads,
            "dropped": dropped}


def main(args, base: str) -> Result:
    identities = resolve_identities(args.identity)
    if args.streams < 0 or args.downloads < 0 or args.streams + args.downloads < 1:
        raise UsageError("need --streams + --downloads ≥ 1")
    setup = asyncio.run(_setup(args, base, identities))
    duration = args.minutes * 60
    chunk = max(16, args.chunk_kb) * 1024
    # Egress estimate (upper bound): players at their bitrate, each
    # downloader one (capped) download per --download-pause.
    stream_gb = args.streams * args.stream_kbps * 1000 / 8 * duration / 1e9
    dl_mb = min(args.max_download_mb,
                max((d["size"] or 0 for d in setup["downloads"]), default=0) / 1e6)
    rounds = math.ceil(duration / max(1.0, args.download_pause))
    dl_gb = args.downloads * rounds * dl_mb / 1e3
    est_gb = stream_gb + dl_gb
    log(f"media: {args.streams} players (~{stream_gb:.2f} GB at "
        f"{args.stream_kbps:g} kbit/s) + {args.downloads} downloaders (≤ {rounds} × "
        f"{dl_mb:.0f} MB each = {dl_gb:.2f} GB) for {args.minutes:g} min against "
        f"{base}: egress ≤ {est_gb:.2f} GB ≈ ${est_gb * RAILWAY_EGRESS_USD_PER_GB:.2f} "
        "if served by the API (R2: free)")
    if est_gb > args.max_egress_gb:
        raise UsageError(f"egress estimate {est_gb:.1f} GB is above --max-egress-gb "
                         f"{args.max_egress_gb:g}")
    params = {
        "streams": setup["streams"], "downloads": setup["downloads"],
        "n_streams": args.streams, "chunk": chunk,
        "bytes_per_s": args.stream_kbps * 1000 / 8, "seek_prob": args.seek_prob,
        "max_download": int(args.max_download_mb * 1e6),
        "download_pause": args.download_pause,
        "follow": args.follow_redirects,
        "seed": args.seed if args.seed is not None else int(time.time()),
    }
    total = args.streams + args.downloads
    procs = auto_procs(args.procs, total, per_proc=100)
    rec = run_workers(__name__, "worker", base=base, params=params,
                      identities=identities, total_vus=total, procs=procs,
                      duration_s=duration, timeout=args.timeout)
    for d in setup["dropped"]:
        rec.notes.append(f"dropped target {d}")
    p95 = args.p95_ms
    media_ok = frozenset({200, 206, *REDIRECTS})
    expects = [Expect("GET /health", frozenset({200}), p95, refusals=False,
                      all_ok=True),
               Expect("GET /jobs/status", frozenset({200, 304}), p95),
               Expect(LABEL_R2, frozenset({200, 206}), None)]
    for label in rec.codes:
        if label.startswith("GET /jobs/{id}/"):
            expects.append(Expect(label, media_ok, p95))
    if args.streams and not any(l.startswith("GET /jobs/{id}/") and "(range)" in l
                                for l in rec.codes):
        expects.append(Expect("GET /jobs/{id}/… (range)", required=True))
    checks = evaluate(rec, expects, max_error_rate=args.max_error_rate,
                      max_refusal_rate=args.max_refusal_rate)
    api_bytes = sum(v for k, v in rec.nbytes.items() if k.startswith("GET /jobs/{id}/"))
    r2_bytes = rec.nbytes.get(LABEL_R2, 0)
    checks.append(Check("egress", INFO,
                        f"{api_bytes / 1e9:.2f} GB from the API (≈ "
                        f"${api_bytes / 1e9 * RAILWAY_EGRESS_USD_PER_GB:.2f} at "
                        f"${RAILWAY_EGRESS_USD_PER_GB}/GB), {r2_bytes / 1e9:.2f} GB "
                        "from R2 (no egress fee)"))
    dl_ms = rec.counters.get("download ms", 0)
    if dl_ms:
        mbps = rec.counters["download bytes"] / 1e6 / (dl_ms / 1000)
        checks.append(Check("download throughput", INFO,
                            f"{mbps:.1f} MB/s per download on average"))
    if identities[0].kind == "admin":
        checks.append(Check(
            "real-user path measured", WARN,
            "measured as the service identity (X-Admin-Token): no JWT "
            "verification or ownership checks — use --identity user for "
            "the WP7 gate"))
    meta = {
        "Target": base, "Identity": identities[0].label,
        "Players": f"{args.streams} × {args.stream_kbps:g} kbit/s, "
                   f"{args.chunk_kb} KiB ranges",
        "Downloads": f"{args.downloads} (≤ {args.max_download_mb:g} MB each, "
                     f"pause {args.download_pause:g} s)",
        "Targets": f"{len(setup['streams'])} stream, {len(setup['downloads'])} "
                   "download",
        "Duration": f"{args.minutes:g} min", "Processes": procs,
    }
    return Result(NAME, meta, rec, duration, checks)


async def worker(ctx) -> Recorder:
    rec = Recorder()
    p = ctx.params
    async with make_session(ctx.timeout) as session:
        tasks = [lag_monitor(rec, ctx.stop_at)]
        for i in ctx.vus:
            tasks.append(_player(session, rec, ctx, i) if i < p["n_streams"]
                         else _download(session, rec, ctx, i))
        if ctx.proc == 0:
            tasks.append(_probes(session, rec, ctx))
        await asyncio.gather(*tasks)
    return rec


async def _probes(session, rec, ctx) -> None:
    # GET /jobs/status takes at most STATUS_BATCH ids (400 too_many_ids).
    ids = ",".join(list(dict.fromkeys(
        quote(t["id"]) for t in
        ctx.params["streams"] + ctx.params["downloads"]))[:STATUS_BATCH])
    await sleep_until(ctx.start_at)
    await probe_loop(session, rec, ctx.base, ctx.stop_at,
                     [("GET /health", "/health"),
                      ("GET /jobs/status", f"/jobs/status?ids={ids}")],
                     ident=ctx.identities[0])


async def _get_range(session, rec, ctx, target, headers, start: int, end: int,
                     label: str) -> int:
    """One range read (+ the R2 read after a redirect). Bytes read."""
    rng = {"Range": f"bytes={start}-{end}"}
    # read_limit: a server that ignores Range answers 200 with the
    # whole file — read no more than the chunk anyway.
    limit = end - start + 1
    r = await call(session, rec, label, "GET", target["url"],
                   headers={**headers, **rng}, keep_body=False, measure="ttfb",
                   read_limit=limit)
    got = r.nbytes
    if r.status in REDIRECTS and ctx.params["follow"]:
        loc = urljoin(target["url"], r.headers.get("location", ""))
        r2 = await call(session, rec, LABEL_R2, "GET", loc, headers=rng,
                        keep_body=False, measure="ttfb", read_limit=limit)
        got = r2.nbytes
    return got


async def _player(session, rec: Recorder, ctx, i: int) -> None:
    p = ctx.params
    rnd = random.Random(p["seed"] * 1_000_003 + i)
    await sleep_until(ctx.start_at + rnd.uniform(0, 3))
    while time.time() < ctx.stop_at:
        target = rnd.choice(p["streams"])
        ident = ctx.identities[target["ident"]]
        label = f"GET /jobs/{{id}}/{target['path']} (range)"
        size = target["size"] or 10 * p["chunk"]  # unknown (307, not followed)
        pos = 0
        while pos < size and time.time() < ctx.stop_at:
            t0 = time.time()
            end = min(size, pos + p["chunk"]) - 1
            got = await _get_range(session, rec, ctx, target,
                                   await ident.headers(session), pos, end, label)
            rec.counters["player chunks"] += 1
            pos = end + 1
            if rnd.random() < p["seek_prob"]:
                pos = rnd.randrange(0, size)
                rec.counters["player seeks"] += 1
            # Pace at the playback bitrate (a player buffers ahead, then
            # reads as fast as it plays).
            await sleep_until(min(t0 + max(got, p["chunk"] // 4) / p["bytes_per_s"],
                                  ctx.stop_at))


async def _download(session, rec: Recorder, ctx, i: int) -> None:
    p = ctx.params
    rnd = random.Random(p["seed"] * 1_000_003 + i)
    await sleep_until(ctx.start_at + rnd.uniform(0, 3))
    while time.time() < ctx.stop_at:
        target = rnd.choice(p["downloads"])
        ident = ctx.identities[target["ident"]]
        label = f"GET /jobs/{{id}}/{target['path']}"
        t0 = time.perf_counter()
        r = await call(session, rec, label, "GET", target["url"],
                       headers=await ident.headers(session), keep_body=False,
                       read_limit=p["max_download"], measure="ttfb",
                       timeout=max(ctx.timeout, 600))
        got = r.nbytes
        if r.status in REDIRECTS and p["follow"]:
            loc = urljoin(target["url"], r.headers.get("location", ""))
            r2 = await call(session, rec, LABEL_R2, "GET", loc, keep_body=False,
                            read_limit=p["max_download"], measure="ttfb",
                            timeout=max(ctx.timeout, 600))
            got = r2.nbytes
        rec.counters["downloads"] += 1
        rec.counters["download bytes"] += got
        rec.counters["download ms"] += int((time.perf_counter() - t0) * 1000)
        # A user downloads a video once, then does something else.
        await sleep_until(min(time.time() + p["download_pause"], ctx.stop_at))
