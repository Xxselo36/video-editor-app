"""abuse — the refusals the API must give (cheap unless uploads are on).

Always (no uploads, no cost):
  * 400 MB declared JSON body          → 413 before the body is sent
  * 2 MiB chunked JSON body            → 413 (limit 1 MiB)
  * 400 MB declared multipart POST /jobs → 413 (limit 100 MB)
  * presign without / with a bogus token → 401 (accounts on; else SKIP)
  * GET /jobs/status without a token   → 401 (accounts on)
  * presign with size 50 GB / 1e6 s    → 413 file_too_large / video_too_long
  * GET /jobs/status with 51 ids       → 400 too_many_ids

With uploads (tiny generated clips; a real target needs
--i-understand-this-costs-money — each accepted upload is a short real
analysis; a local target doesn't):
  * --per-user-uploads N at once by ONE test user (CLEO_TEST_BEARER /
    Clerk session) → at most --per-user-limit accepted, the rest
    429 too_many_active_jobs; presign right after → 429 too
  * --queue-cap-uploads K at once (service identity) → the queue
    overflows: some 503 server_busy WITH Retry-After, nothing else
Every job created here is deleted at the end.
"""
from __future__ import annotations

import asyncio
import http.client
import json
import secrets
import select
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp

from ..common import (
    Identity, Recorder, UsageError, admin_identity, auth_mode, call,
    delete_jobs, is_local, list_jobs, log, make_session, note_created,
    user_identities,
)
from ..report import Check, FAIL, INFO, PASS, SKIP, WARN, Result

NAME = "abuse"
HELP = "oversized bodies → 413, no token → 401, per-user 429, queue cap 503"
KIB, MIB = 1024, 1024 * 1024
# The cheapest analysis the web app can ask for.
CHEAP_SETTINGS = {"caption_preset": "clean", "style": "smooth",
                  "voice_triggers": False, "remove_fillers": False,
                  "smartcam_enabled": False, "output_formats": [],
                  "_cost_test": True}


def add_args(p) -> None:
    p.add_argument("--declared-mb", type=float, default=400,
                   help="Content-Length claimed by the oversized requests")
    p.add_argument("--per-user-uploads", type=int, default=4,
                   help="concurrent uploads by one test user (WP7: 20); "
                        "0 = skip")
    p.add_argument("--per-user-limit", type=int, default=2,
                   help="the target's CLEO_MAX_ACTIVE_PER_USER")
    p.add_argument("--queue-cap-uploads", type=int, default=0,
                   help="concurrent uploads to overflow the queue; must exceed "
                        "CLEO_MAX_ANALYZE + CLEO_MAX_QUEUE (default 2 + 20 → "
                        "use 25). 0 = skip")
    p.add_argument("--clip-seconds", type=float, default=20,
                   help="length of the generated upload clip")


# ── raw requests (the body must NOT be sent in full) ─────────────────


def _readable(sock) -> bool:
    if getattr(sock, "pending", None) and sock.pending():
        return True
    return bool(select.select([sock], [], [], 0)[0])


def raw_post(base: str, path: str, *, content_type: str,
             declared: int | None = None, chunked_total: int | None = None,
             send_first: int = 64 * KIB, headers: dict | None = None,
             timeout: float = 20.0) -> dict:
    """POST with a claimed Content-Length (`declared`) of which only
    `send_first` bytes are sent, or a chunked body of `chunked_total`
    bytes; stops sending as soon as the server answers. Returns status,
    headers, body, ms, bytes sent, note."""
    u = urlsplit(base)
    if u.scheme == "https":
        conn = http.client.HTTPSConnection(
            u.hostname, u.port or 443, timeout=timeout,
            context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port or 80,
                                          timeout=timeout)
    out = {"status": None, "headers": {}, "body": b"", "sent": 0, "note": ""}
    piece = b"x" * (16 * KIB)
    t0 = time.perf_counter()
    try:
        conn.putrequest("POST", u.path.rstrip("/") + path,
                        skip_accept_encoding=True)
        conn.putheader("Content-Type", content_type)
        for k, v in (headers or {}).items():
            conn.putheader(k, v)
        if declared is not None:
            conn.putheader("Content-Length", str(declared))
        else:
            conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        limit = send_first if declared is not None else (chunked_total or 0)
        answered = False
        while out["sent"] < limit:
            if _readable(conn.sock):
                answered = True
                break
            if declared is not None:
                conn.send(piece)
            else:
                conn.send(b"%x\r\n%s\r\n" % (len(piece), piece))
            out["sent"] += len(piece)
        if declared is None and not answered and not _readable(conn.sock):
            conn.send(b"0\r\n\r\n")
    except (BrokenPipeError, ConnectionResetError) as e:
        out["note"] = f"server closed the connection while we sent ({type(e).__name__})"
    except (socket.timeout, OSError) as e:
        out["note"] = f"send failed: {type(e).__name__}"
    try:
        r = conn.getresponse()
        out["status"] = r.status
        out["headers"] = {k.lower(): v for k, v in r.getheaders()}
        out["body"] = r.read(2000)
    except socket.timeout:
        out["note"] = "no answer within the timeout: the server waits for the body"
    except (ConnectionResetError, BrokenPipeError, http.client.HTTPException,
            OSError) as e:
        out["note"] = (out["note"] + "; " if out["note"] else "") + \
            f"no answer ({type(e).__name__})"
    finally:
        out["ms"] = (time.perf_counter() - t0) * 1000
        conn.close()
    return out


def _detail(body: bytes) -> str:
    try:
        d = json.loads(body or b"{}")
    except ValueError:
        return ""
    if isinstance(d, dict):
        d = d.get("detail")
        if isinstance(d, dict):
            d = d.get("code")
    return str(d or "")


# ── helpers ──────────────────────────────────────────────────────────


def make_clip(seconds: float, work: Path) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        try:
            import imageio_ffmpeg  # type: ignore
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            raise UsageError("uploads need ffmpeg on PATH") from None
    out = work / "lt-abuse.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         f"testsrc=size=320x240:rate=15:duration={seconds:g}", "-f", "lavfi",
         "-i", f"sine=frequency=440:sample_rate=16000:duration={seconds:g}",
         "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
         "-movflags", "+faststart", str(out)], check=True)
    return out


async def _upload(session, rec: Recorder, base: str, headers: dict,
                  clip: bytes, name: str, label: str):
    form = aiohttp.FormData()
    form.add_field("file", clip, filename=name, content_type="video/mp4")
    form.add_field("settings", json.dumps(CHEAP_SETTINGS))
    return await call(session, rec, label, "POST", base + "/jobs",
                      headers=headers, data=form, timeout=600)


async def _concurrent_uploads(session, rec, base, ident: Identity, clip: bytes,
                              n: int, label: str, tag: str, run: dict):
    """n uploads at once. Each job id is remembered (run["created"] and
    <out>/created-ids.txt) the moment its upload returns — not after the
    whole gather, which a Ctrl-C / CI cancel may never finish."""
    headers = await ident.headers(session)

    async def one(i: int):
        r = await _upload(session, rec, base, headers, clip,
                          f"{run['prefix']}{tag}-{i:02d}.mp4", label)
        jid = (r.json() or {}).get("job_id") if r.status == 200 else None
        if jid:
            run["created"].append((ident, jid))
            note_created(run["out"], [jid], f"abuse {run['prefix']}{tag}-{i:02d}")
        return r

    return await asyncio.gather(*[one(i) for i in range(n)])


async def _ghosts(s, base: str, idents: list, prefix: str,
                  known: set[str]) -> list[tuple]:
    """Jobs with this run's file names that we never got an id for (an
    upload interrupted or timed out client-side after the server took
    it). Needs GET /jobs, i.e. accounts on."""
    out = []
    for ident in idents:
        try:
            rows = await list_jobs(s, base, ident) or []
        except Exception as e:
            log(f"ghost search as {ident.label} failed: {e}")
            continue
        for row in rows:
            if (str(row.get("filename") or "").startswith(prefix)
                    and row.get("id") not in known):
                known.add(row["id"])
                out.append((ident, row["id"]))
    return out


def _codes(resps) -> str:
    c: dict[str, int] = {}
    for r in resps:
        k = str(r.status or f"ERR:{r.error}")
        d = _detail(r.body) if r.status and r.status >= 400 else ""
        k += f" {d}" if d else ""
        c[k] = c.get(k, 0) + 1
    return ", ".join(f"{k}×{v}" for k, v in sorted(c.items()))


# ── the checks ───────────────────────────────────────────────────────


def _raw_check(rec: Recorder, name: str, label: str, res: dict,
               want: int, want_detail: str | None = None) -> Check:
    code = res["status"] if res["status"] is not None else "ERR:no-answer"
    rec.record(label, code, res["ms"], headers=res["headers"], body=res["body"])
    detail = _detail(res["body"])
    ok = res["status"] == want and (want_detail is None or detail == want_detail)
    text = (f"{res['status'] or 'no answer'} {detail}".strip()
            + f" after {res['ms']:.0f} ms, {res['sent'] / KIB:.0f} KiB sent")
    if res["note"]:
        text += f" ({res['note']})"
    return Check(name, PASS if ok else FAIL, text.strip())


async def _run(args, base: str) -> tuple[Recorder, list[Check], dict]:
    rec = Recorder()
    checks: list[Check] = []
    declared = int(args.declared_mb * 1e6)
    anon = Identity()
    admin = admin_identity()
    users = user_identities()
    uploads_ok = args.costs_ok or is_local(base)
    created: list[tuple[Identity, str]] = []
    run = {"created": created, "out": args.out,
           "prefix": f"lt-abuse-{time.strftime('%m%d%H%M')}{secrets.token_hex(2)}-"}
    used: list[Identity] = []  # identities that uploaded (ghost search)
    info: dict = {}
    async with make_session(args.timeout) as s:
        auth_on = await auth_mode(s, base, anon)
        info["auth_on"] = auth_on
        ident = admin or (users[0] if users else anon)
        info["identity"] = ident.label

        # 1–3: oversized bodies, sent without credentials (the limit
        # must hit before auth, i.e. before anything reads the body).
        res = await asyncio.to_thread(
            raw_post, base, "/uploads/presign", content_type="application/json",
            declared=declared, timeout=args.timeout)
        checks.append(_raw_check(
            rec, f"{args.declared_mb:g} MB declared JSON body → 413 before the body",
            f"POST /uploads/presign ({args.declared_mb:g} MB declared)", res, 413,
            "request_too_large"))
        res = await asyncio.to_thread(
            raw_post, base, "/uploads/presign", content_type="application/json",
            chunked_total=2 * MIB, timeout=args.timeout)
        checks.append(_raw_check(
            rec, "2 MiB chunked JSON body → 413",
            "POST /uploads/presign (2 MiB chunked)", res, 413, "request_too_large"))
        res = await asyncio.to_thread(
            raw_post, base, "/jobs",
            content_type="multipart/form-data; boundary=lt", declared=declared,
            timeout=args.timeout)
        checks.append(_raw_check(
            rec, f"{args.declared_mb:g} MB declared multipart POST /jobs → 413",
            f"POST /jobs ({args.declared_mb:g} MB declared)", res, 413,
            "file_too_large"))

        # 4–6: no / bad credentials.
        presign_body = {"filename": "lt.mp4", "content_type": "video/mp4",
                        "size": 1_000_000, "duration": 10}
        if auth_on:
            for name, label, headers in (
                    ("presign without a token → 401",
                     "POST /uploads/presign (no token)", {}),
                    ("presign with a bogus token → 401",
                     "POST /uploads/presign (bogus token)",
                     {"Authorization": "Bearer lt.bogus.token"})):
                r = await call(s, rec, label, "POST", base + "/uploads/presign",
                               headers=headers, json_body=presign_body)
                checks.append(Check(name, PASS if r.status == 401 else FAIL,
                                    f"{r.status or r.error} {_detail(r.body)}"))
            r = await call(s, rec, "GET /jobs/status (no token)", "GET",
                           base + "/jobs/status?ids=lt-x")
            checks.append(Check("GET /jobs/status without a token → 401",
                                PASS if r.status == 401 else FAIL,
                                f"{r.status or r.error} {_detail(r.body)}"))
        else:
            checks.append(Check("presign / status without a token → 401", SKIP,
                                "accounts are off on the target (anonymous "
                                "access is intended there)"))

        # 7: caps checked at presign, before any bytes move.
        if auth_on and ident is anon:
            checks.append(Check("presign caps → 413", SKIP,
                                "needs CLEO_ADMIN_TOKEN or a test user"))
        else:
            h = await ident.headers(s)
            for name, body, want in (
                    ("presign with size 50 GB → 413 file_too_large",
                     {**presign_body, "size": 50e9, "duration": 0}, "file_too_large"),
                    ("presign with 1e6 s → 413 video_too_long",
                     {**presign_body, "size": 0, "duration": 1e6}, "video_too_long")):
                r = await call(s, rec, f"POST /uploads/presign ({want})", "POST",
                               base + "/uploads/presign", headers=h, json_body=body)
                d = _detail(r.body)
                checks.append(Check(name, PASS if (r.status, d) == (413, want)
                                    else FAIL, f"{r.status or r.error} {d}"))

        # 8: too many ids.
        h = await ident.headers(s) if not (auth_on and ident is anon) else {}
        ids = ",".join(f"lt-{i}" for i in range(51))
        r = await call(s, rec, "GET /jobs/status (51 ids)", "GET",
                       f"{base}/jobs/status?ids={ids}", headers=h)
        want = 401 if (auth_on and ident is anon) else 400
        checks.append(Check(f"GET /jobs/status with 51 ids → {want}",
                            PASS if r.status == want else FAIL,
                            f"{r.status or r.error} {_detail(r.body)}"))

        # 9–10: uploads.
        need_uploads = args.per_user_uploads > 0 or args.queue_cap_uploads > 0
        clip = None
        if need_uploads and uploads_ok:
            with tempfile.TemporaryDirectory(prefix="lt-abuse-") as tmp:
                clip = make_clip(args.clip_seconds, Path(tmp)).read_bytes()
        try:
            await _per_user(args, s, rec, base, auth_on, users, clip, uploads_ok,
                            checks, run, used)
            await _queue_cap(args, s, rec, base, auth_on, admin, clip, uploads_ok,
                             checks, run, used)
        finally:
            if used and auth_on:
                ghosts = await _ghosts(s, base, used, run["prefix"],
                                       {j for _, j in created})
                if ghosts:
                    log(f"found {len(ghosts)} jobs whose upload never answered")
                    note_created(args.out, [j for _, j in ghosts], "abuse ghost")
                    created += ghosts
            if created:
                log(f"cleanup: deleting {len(created)} jobs")
                left = []
                for who in {id(i): i for i, _ in created}.values():
                    ids_ = [j for i, j in created if i is who]
                    left += await delete_jobs(s, base, who, ids_, timeout=900, log=log)
                checks.append(Check("cleanup: every created job deleted",
                                    PASS if not left else FAIL,
                                    f"{len(created)} deleted" if not left else
                                    f"left over: {', '.join(left)}"))
    return rec, checks, info


async def _per_user(args, s, rec, base, auth_on, users, clip, uploads_ok,
                    checks, run, used) -> None:
    n, limit = args.per_user_uploads, args.per_user_limit
    name = f"{n} uploads at once by one user → ≤ {limit} accepted, rest 429"
    if n <= 0:
        return
    if not auth_on:
        checks.append(Check(name, SKIP, "accounts are off on the target"))
        return
    if not users:
        checks.append(Check(name, SKIP, "needs a test user (CLEO_TEST_BEARER or "
                                        "CLEO_TEST_SESSION_IDS + CLERK_SECRET_KEY)"))
        return
    if not uploads_ok:
        checks.append(Check(name, SKIP, "uploads cost money on a real target: "
                                        "add --i-understand-this-costs-money"))
        return
    user = users[0]
    used.append(user)
    resps = await _concurrent_uploads(s, rec, base, user, clip, n,
                                      "POST /jobs (one user, concurrent)", "user", run)
    ok = [r for r in resps if r.status == 200]
    refused = [r for r in resps if r.status == 429
               and _detail(r.body) == "too_many_active_jobs"]
    other = len(resps) - len(ok) - len(refused)
    passed = len(ok) <= limit and other == 0 and (n <= limit or bool(refused))
    detail = _codes(resps)
    if any(r.status == 402 for r in resps):
        detail += " — the test user needs a plan with minutes left"
    checks.append(Check(name, PASS if passed else FAIL, detail))
    if refused:
        # The harness wants Retry-After on every 429/503 (README); the
        # per-user limit is not time-based, so it's a WARN here, shown
        # rather than silently accepted.
        with_ra = sum(1 for r in refused if "retry-after" in r.headers)
        checks.append(Check(
            "per-user 429 carries Retry-After",
            PASS if with_ra == len(refused) else WARN,
            f"{with_ra}/{len(refused)} with Retry-After"
            + ("" if with_ra == len(refused) else
               " — not required for this refusal (it lasts until a job "
               "finishes), but clients can't tell when to retry")))
    if ok:
        r = await call(s, rec, "POST /uploads/presign (user at limit)", "POST",
                       base + "/uploads/presign", headers=await user.headers(s),
                       json_body={"filename": "lt.mp4", "size": 1_000_000})
        d = _detail(r.body)
        if len(ok) >= limit:
            checks.append(Check("presign while at the per-user limit → 429",
                                PASS if (r.status, d) == (429, "too_many_active_jobs")
                                else INFO,
                                f"{r.status or r.error} {d}"
                                + ("" if r.status == 429 else
                                   " (the accepted jobs may have finished already)")))


async def _queue_cap(args, s, rec, base, auth_on, admin, clip, uploads_ok,
                     checks, run, used) -> None:
    k = args.queue_cap_uploads
    name = f"{k} uploads at once → queue full: 503 server_busy + Retry-After"
    if k <= 0:
        checks.append(Check("queue cap → 503 + Retry-After", SKIP,
                            "--queue-cap-uploads not set"))
        return
    if auth_on and admin is None:
        checks.append(Check(name, SKIP, "needs CLEO_ADMIN_TOKEN (the service "
                                        "identity has no per-user limit)"))
        return
    if not uploads_ok:
        checks.append(Check(name, SKIP, "uploads cost money on a real target: "
                                        "add --i-understand-this-costs-money"))
        return
    who = admin if auth_on else Identity()
    used.append(who)
    resps = await _concurrent_uploads(s, rec, base, who, clip, k,
                                      "POST /jobs (queue overflow)", "queue", run)
    busy = [r for r in resps if r.status == 503]
    busy_ra = [r for r in busy if "retry-after" in r.headers
               and _detail(r.body) == "server_busy"]
    other = [r for r in resps if r.status not in (200, 503)]
    passed = bool(busy) and len(busy_ra) == len(busy) and not other
    detail = _codes(resps)
    if busy:
        detail += f"; Retry-After on {len(busy_ra)}/{len(busy)}"
    else:
        detail += " — no 503: raise --queue-cap-uploads above the target's " \
                  "CLEO_MAX_ANALYZE + CLEO_MAX_QUEUE"
    checks.append(Check(name, PASS if passed else FAIL, detail))


def main(args, base: str) -> Result:
    if args.per_user_uploads < 0 or args.queue_cap_uploads < 0:
        raise UsageError("upload counts must be ≥ 0")
    t0 = time.time()
    rec, checks, info = asyncio.run(_run(args, base))
    meta = {"Target": base, "Accounts on target": info.get("auth_on"),
            "Identity for authorised checks": info.get("identity"),
            "Uploads allowed": args.costs_ok or is_local(base)}
    return Result(NAME, meta, rec, max(1.0, time.time() - t0), checks)
