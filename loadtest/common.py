"""Shared plumbing for the load-test scenarios.

* target + identities (X-Admin-Token service identity, Clerk test users)
* `call()`: one timed HTTP request, recorded into a `Recorder`
* `Recorder`: latencies, status codes, bytes, refusals without
  Retry-After, examples of unexpected answers, event-loop lag
* `run_workers()`: runs a scenario's async worker for N virtual users,
  optionally spread over several processes (one event loop each), all
  starting at the same wall-clock instant.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import math
import multiprocessing
import os
import pickle
import re
import sys
import time
from array import array
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import aiohttp

DEFAULT_BASE_URL = "https://api.cleocuts.com"
USER_AGENT = "cleocuts-loadtest/1 (+loadtest/README.md)"
REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = Path(__file__).resolve().parent / "results"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
STATUS_BATCH = 50  # GET /jobs/status takes at most 50 ids

# Railway egress, $/GB — same number as backend/costs.py RATES
# ["railway_egress_gb"] (not imported: the harness runs without the
# backend's dependencies).
RAILWAY_EGRESS_USD_PER_GB = 0.05


class UsageError(Exception):
    """Bad command line or a target that can't run this scenario
    (exit code 2, no report)."""


def is_local(base_url: str) -> bool:
    host = (urlsplit(base_url).hostname or "").lower()
    return host in LOCAL_HOSTS or host.endswith(".localhost")


def split_list(raw: str | None) -> list[str]:
    """Comma / whitespace separated values; `#` starts a comment."""
    out: list[str] = []
    for line in (raw or "").splitlines():
        line = line.split("#", 1)[0]
        out += [x for x in re.split(r"[\s,]+", line) if x]
    return out


def read_ids(ids: str | None, ids_file: str | None) -> list[str]:
    got = split_list(ids)
    if ids_file:
        got += split_list(Path(ids_file).read_text())
    return list(dict.fromkeys(got))


# ── identities ───────────────────────────────────────────────────────


class Identity:
    """Who the requests are sent as. Picklable (sent to worker
    processes); per-process state is created lazily."""

    kind = "none"
    label = "anonymous"

    async def headers(self, session: aiohttp.ClientSession) -> dict[str, str]:
        return {}


class AdminIdentity(Identity):
    """X-Admin-Token = service user svc:admin: sees every job, no quota,
    no per-user limit, may tag jobs _cost_test."""

    kind = "admin"
    label = "service (X-Admin-Token)"

    def __init__(self, token: str) -> None:
        self.token = token

    async def headers(self, session):
        return {"X-Admin-Token": self.token}


class BearerIdentity(Identity):
    """A fixed Clerk session token. Clerk tokens live 60 s (+60 s leeway
    on the backend) — only for short runs; see ClerkSessionIdentity."""

    kind = "user"

    def __init__(self, token: str, n: int) -> None:
        self.token = token
        self.label = f"user #{n} (static bearer)"

    async def headers(self, session):
        return {"Authorization": f"Bearer {self.token}"}


class ClerkSessionIdentity(Identity):
    """Fresh session tokens for an existing Clerk session of a test user,
    minted through the Clerk Backend API (POST /sessions/{id}/tokens)
    and renewed every REFRESH_S seconds."""

    kind = "user"
    REFRESH_S = 40.0

    def __init__(self, secret: str, session_id: str, n: int, api: str) -> None:
        self.secret = secret
        self.session_id = session_id
        self.api = api.rstrip("/")
        self.label = f"user #{n} (Clerk session …{session_id[-6:]})"
        self._jwt: str | None = None
        self._at = 0.0
        self._lock: asyncio.Lock | None = None

    def __getstate__(self):
        state = dict(self.__dict__)
        state.update(_jwt=None, _at=0.0, _lock=None)
        return state

    async def headers(self, session):
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._jwt is None or time.monotonic() - self._at > self.REFRESH_S:
                url = f"{self.api}/sessions/{quote(self.session_id)}/tokens"
                async with session.post(
                        url, json={},
                        headers={"Authorization": f"Bearer {self.secret}"}) as r:
                    body = await r.json(content_type=None)
                    if r.status != 200 or not isinstance(body, dict) \
                            or not body.get("jwt"):
                        raise RuntimeError(
                            f"Clerk token for session …{self.session_id[-6:]}: "
                            f"HTTP {r.status}")
                self._jwt = body["jwt"]
                self._at = time.monotonic()
        return {"Authorization": f"Bearer {self._jwt}"}


def user_identities(env=os.environ) -> list[Identity]:
    """Test users from the environment:
    CLEO_TEST_BEARER       static session tokens (comma/space separated)
    CLEO_TEST_SESSION_IDS  Clerk session ids of test users, with
    CLERK_SECRET_KEY       the Clerk secret key (sk_…) to mint tokens
    CLERK_API_URL          default https://api.clerk.com/v1"""
    out: list[Identity] = []
    static = split_list(env.get("CLEO_TEST_BEARER"))
    out += [BearerIdentity(t, i + 1) for i, t in enumerate(static)]
    sids = split_list(env.get("CLEO_TEST_SESSION_IDS"))
    secret = env.get("CLERK_SECRET_KEY", "").strip()
    if sids and not secret:
        raise UsageError("CLEO_TEST_SESSION_IDS needs CLERK_SECRET_KEY")
    api = env.get("CLERK_API_URL", "").strip() or "https://api.clerk.com/v1"
    out += [ClerkSessionIdentity(secret, s, len(static) + i + 1, api)
            for i, s in enumerate(sids)]
    return out


def admin_identity(env=os.environ) -> AdminIdentity | None:
    token = env.get("CLEO_ADMIN_TOKEN", "").strip()
    return AdminIdentity(token) if token else None


def resolve_identities(choice: str, env=os.environ) -> list[Identity]:
    admin = admin_identity(env)
    if choice == "auto":
        choice = "admin" if admin else "none"
    if choice == "admin":
        if admin is None:
            raise UsageError("--identity admin needs CLEO_ADMIN_TOKEN")
        return [admin]
    if choice == "user":
        users = user_identities(env)
        if not users:
            raise UsageError("--identity user needs CLEO_TEST_BEARER or "
                             "CLEO_TEST_SESSION_IDS + CLERK_SECRET_KEY")
        return users
    return [Identity()]


# ── recording ────────────────────────────────────────────────────────


def percentile(sorted_vals, q: float) -> float:
    """Nearest-rank percentile of an ascending sequence (nan if empty)."""
    n = len(sorted_vals)
    if n == 0:
        return float("nan")
    k = max(0, min(n - 1, math.ceil(q / 100.0 * n) - 1))
    return float(sorted_vals[k])


def is_http(code: str) -> bool:
    return code.isdigit()


class Recorder:
    """Everything measured in one process; merge() combines processes."""

    MAX_SAMPLES = 3

    def __init__(self) -> None:
        self.lat: dict[str, array] = {}        # label -> ms (answered only,
        #                                         without 429/503 refusals)
        self.refusal_lat: dict[str, array] = {}  # label -> ms of 429/503
        self.codes: dict[str, Counter] = {}    # label -> "200"/"ERR:timeout"
        self.nbytes: Counter = Counter()        # label -> body bytes read
        self.no_retry_after: Counter = Counter()  # label -> 429/503 w/o header
        self.samples: dict[str, list[str]] = {}  # "label → code" -> bodies
        self.lag = array("d")                   # event-loop lag, ms
        self.counters: Counter = Counter()      # scenario specific
        self.lost_ids: set[str] = set()
        self.notes: list[str] = []

    def record(self, label: str, code: int | str, ms: float, *,
               nbytes: int = 0, headers: dict | None = None,
               body: bytes | None = b"") -> None:
        key = str(code)
        self.codes.setdefault(label, Counter())[key] += 1
        if is_http(key):
            if key in ("429", "503"):
                # A fast refusal must not make the p95 of real answers
                # look good: kept apart.
                self.refusal_lat.setdefault(label, array("d")).append(ms)
                if "retry-after" not in (headers or {}):
                    self.no_retry_after[label] += 1
            else:
                self.lat.setdefault(label, array("d")).append(ms)
        if nbytes:
            self.nbytes[label] += nbytes
        if not is_http(key) or int(key) >= 400:
            lst = self.samples.setdefault(f"{label} → {key}", [])
            if len(lst) < self.MAX_SAMPLES:
                text = (body or b"")[:300].decode("utf-8", "replace")
                lst.append(re.sub(r"\s+", " ", text).strip())

    def merge(self, other: "Recorder") -> "Recorder":
        for k, v in other.lat.items():
            self.lat.setdefault(k, array("d")).extend(v)
        for k, v in other.refusal_lat.items():
            self.refusal_lat.setdefault(k, array("d")).extend(v)
        for k, v in other.codes.items():
            self.codes.setdefault(k, Counter()).update(v)
        self.nbytes.update(other.nbytes)
        self.no_retry_after.update(other.no_retry_after)
        for k, v in other.samples.items():
            lst = self.samples.setdefault(k, [])
            lst.extend(v[: max(0, self.MAX_SAMPLES - len(lst))])
        self.lag.extend(other.lag)
        self.counters.update(other.counters)
        self.lost_ids |= other.lost_ids
        self.notes += [n for n in other.notes if n not in self.notes]
        return self

    def summary(self, label: str, duration_s: float) -> dict[str, Any]:
        codes = self.codes.get(label, Counter())
        total = sum(codes.values())
        lat = sorted(self.lat.get(label, ()))
        return {
            "requests": total,
            "rps": round(total / duration_s, 2) if duration_s > 0 else None,
            "p50_ms": percentile(lat, 50),
            "p95_ms": percentile(lat, 95),
            "p99_ms": percentile(lat, 99),
            "max_ms": lat[-1] if lat else float("nan"),
            "errors": sum(v for k, v in codes.items() if not is_http(k)),
            "codes": dict(sorted(codes.items())),
            "bytes": self.nbytes.get(label, 0),
            "no_retry_after": self.no_retry_after.get(label, 0),
            "refusals_429_503": len(self.refusal_lat.get(label, ())),
        }


# ── HTTP ─────────────────────────────────────────────────────────────


@dataclass
class Resp:
    status: int | None
    error: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    ms: float = 0.0        # until the (read part of the) body was in
    ttfb_ms: float = 0.0   # until the response headers were in
    nbytes: int = 0

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None


def _error_name(e: BaseException) -> str:
    if isinstance(e, asyncio.TimeoutError):
        return "timeout"
    if isinstance(e, aiohttp.ClientConnectorError):
        return "connect"
    if isinstance(e, aiohttp.ServerDisconnectedError):
        return "disconnected"
    if isinstance(e, aiohttp.ClientPayloadError):
        return "payload"
    return type(e).__name__


async def call(session: aiohttp.ClientSession, rec: Recorder | None,
               label: str, method: str, url: str, *,
               headers: dict | None = None, json_body: Any = None,
               data: Any = None, read_limit: int | None = None,
               keep_body: bool = True, measure: str = "total",
               allow_redirects: bool = False,
               timeout: float | None = None) -> Resp:
    """One timed request. `read_limit`: stop reading the body after that
    many bytes (the connection is dropped then). `keep_body=False` counts
    the bytes without keeping them (media); error bodies are kept anyway.
    `measure`: which time goes into the stats — "total" or "ttfb"."""
    kw: dict[str, Any] = {"headers": headers, "allow_redirects": allow_redirects}
    if json_body is not None:
        kw["json"] = json_body
    if data is not None:
        kw["data"] = data
    if timeout is not None:
        kw["timeout"] = aiohttp.ClientTimeout(total=timeout)
    t0 = time.perf_counter()
    out = Resp(status=None)
    try:
        async with session.request(method, url, **kw) as r:
            out.ttfb_ms = (time.perf_counter() - t0) * 1000
            out.status = r.status
            out.headers = {k.lower(): v for k, v in r.headers.items()}
            keep = keep_body or r.status >= 400
            chunks: list[bytes] = []
            n = 0
            async for chunk in r.content.iter_chunked(1 << 16):
                n += len(chunk)
                if keep:
                    chunks.append(chunk)
                if read_limit is not None and n >= read_limit:
                    break
            out.nbytes = n
            out.body = b"".join(chunks)
            out.ms = (time.perf_counter() - t0) * 1000
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        out.status = None
        out.error = _error_name(e)
        out.ms = (time.perf_counter() - t0) * 1000
    if rec is not None:
        code: int | str = out.status if out.status is not None else f"ERR:{out.error}"
        rec.record(label, code, out.ttfb_ms if measure == "ttfb" else out.ms,
                   nbytes=out.nbytes, headers=out.headers, body=out.body)
    return out


def make_session(timeout: float, limit: int = 0) -> aiohttp.ClientSession:
    """One connection pool per process; limit 0 = one connection per
    concurrent request (like one browser per virtual user)."""
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(limit=limit, ttl_dns_cache=300),
        timeout=aiohttp.ClientTimeout(total=timeout),
        headers={"User-Agent": USER_AGENT},
        trust_env=True,  # HTTPS_PROXY / NO_PROXY
    )


async def sleep_until(ts: float) -> None:
    delay = ts - time.time()
    if delay > 0:
        await asyncio.sleep(delay)


async def lag_monitor(rec: Recorder, stop_at: float, every: float = 0.1) -> None:
    """How late the event loop wakes up: if this grows, the load
    generator itself is the bottleneck and latencies include its delay."""
    loop = asyncio.get_running_loop()
    while time.time() < stop_at:
        t = loop.time()
        await asyncio.sleep(every)
        rec.lag.append(max(0.0, (loop.time() - t - every) * 1000))


async def probe_loop(session, rec: Recorder, base: str, stop_at: float,
                     targets: list[tuple[str, str]],
                     ident: "Identity | None" = None,
                     every: float = 1.0) -> None:
    """GET each (label, path) once per `every` seconds until stop_at —
    the cheap reads whose latency must stay low while the scenario runs.
    Headers come from `ident` before every round (Clerk tokens expire
    after about 2 min; the players and editors refresh per request too)."""
    nxt = time.time()
    while time.time() < stop_at:
        headers = None
        if ident is not None:
            try:
                headers = await ident.headers(session)
            except Exception as e:  # token minting failed
                rec.counters["token errors"] += 1
                if len(rec.notes) < 10:
                    rec.notes.append(f"{ident.label}: {e}"[:200])
                headers = False
        if headers is not False:
            for label, path in targets:
                await call(session, rec, label, "GET", base + path,
                           headers=headers or None)
        nxt += every
        await sleep_until(min(max(nxt, time.time()), stop_at))


# ── setup helpers (main process) ─────────────────────────────────────


async def auth_mode(session, base: str, ident: Identity) -> bool | None:
    """True/False = accounts on/off on the target (GET /me); raises
    UsageError when the identity is refused. None = unknown."""
    r = await call(session, None, "", "GET", base + "/me",
                   headers=await ident.headers(session))
    if r.status == 200:
        body = r.json() or {}
        return bool(body.get("auth_enabled"))
    if r.status == 401:
        if ident.kind == "none":
            return True
        raise UsageError(f"GET /me as {ident.label}: 401 — token invalid/expired")
    if r.status is None:
        raise UsageError(f"{base} unreachable: {r.error}")
    return None


def require_identity(auth_on: bool | None, identities: list) -> None:
    """Accounts on + anonymous load = every request a 401: say so now."""
    if auth_on and identities[0].kind == "none":
        raise UsageError("accounts are on at the target: set CLEO_ADMIN_TOKEN "
                         "or test users (--identity admin|user)")


async def job_status_map(session, base: str, ident: Identity,
                         ids: list[str]) -> dict[str, dict]:
    """id -> status row for the ids that exist (and are visible)."""
    out: dict[str, dict] = {}
    for i in range(0, len(ids), STATUS_BATCH):
        chunk = ids[i:i + STATUS_BATCH]
        r = await call(session, None, "", "GET",
                       f"{base}/jobs/status?ids={','.join(map(quote, chunk))}",
                       headers=await ident.headers(session))
        if r.status != 200:
            raise UsageError(f"GET /jobs/status: HTTP {r.status or r.error}")
        for row in (r.json() or {}).get("jobs", []):
            out[row["id"]] = row
    return out


async def list_jobs(session, base: str, ident: Identity) -> list[dict] | None:
    """GET /jobs (the Library). None when not available (accounts off)."""
    r = await call(session, None, "", "GET", base + "/jobs",
                   headers=await ident.headers(session))
    if r.status == 200 and isinstance(r.json(), list):
        return r.json()
    return None


async def delete_jobs(session, base: str, ident: Identity, ids: list[str],
                      timeout: float = 900.0, log=print) -> list[str]:
    """DELETE each job; a job still processing (409), a 5xx or a network
    error is retried until `timeout`. Returns the ids not deleted."""
    pending = list(dict.fromkeys(ids))
    failed: list[str] = []
    deadline = time.time() + timeout
    while pending:
        left = []
        for jid in pending:
            r = await call(session, None, "", "DELETE", f"{base}/jobs/{quote(jid)}",
                           headers=await ident.headers(session))
            if r.status in (200, 404):
                log(f"   deleted {jid}" if r.status == 200 else f"   {jid} already gone")
            elif r.status is None or r.status == 409 or r.status >= 500:
                left.append(jid)
            else:
                log(f"   can't delete {jid}: HTTP {r.status}")
                failed.append(jid)
        pending = left
        if pending and time.time() < deadline:
            await asyncio.sleep(10)
        elif pending:
            break
    return failed + pending


# ── running virtual users ────────────────────────────────────────────


@dataclass
class WorkerCtx:
    """What one worker process gets (picklable)."""
    base: str
    params: dict
    identities: list
    vus: list[int]          # global indices of this process's users
    total_vus: int
    proc: int
    procs: int
    start_at: float         # wall clock, same for every process
    stop_at: float
    timeout: float


def auto_procs(requested: int, total_vus: int, per_proc: int = 300) -> int:
    if requested > 0:
        return requested
    return max(1, min(os.cpu_count() or 1, math.ceil(total_vus / per_proc)))


def _proc_entry(args: tuple[str, str, WorkerCtx]) -> Recorder:
    module, func, ctx = args
    fn = getattr(importlib.import_module(module), func)
    return asyncio.run(fn(ctx))


def run_workers(module: str, func: str, *, base: str, params: dict,
                identities: list, total_vus: int, procs: int,
                duration_s: float, timeout: float,
                lead_s: float = 2.0) -> Recorder:
    """Run `module.func(ctx) -> Recorder` in `procs` processes (1 = in
    this one), users dealt round-robin, and merge what they recorded."""
    procs = max(1, min(procs, max(1, total_vus)))
    start_at = time.time() + lead_s + (1.5 if procs > 1 else 0.0)
    ctxs = [WorkerCtx(base=base, params=params, identities=identities,
                      vus=list(range(i, total_vus, procs)), total_vus=total_vus,
                      proc=i, procs=procs, start_at=start_at,
                      stop_at=start_at + duration_s, timeout=timeout)
            for i in range(procs)]
    if procs == 1:
        # Same as a worker process gets it: identities without state from
        # the setup's event loop (locks, cached tokens).
        return _proc_entry((module, func, pickle.loads(pickle.dumps(ctxs[0]))))
    mp = multiprocessing.get_context("spawn")
    with mp.Pool(procs) as pool:
        parts = pool.map(_proc_entry, [(module, func, c) for c in ctxs])
    rec = Recorder()
    for part in parts:
        rec.merge(part)
    return rec


CREATED_IDS_FILE = "created-ids.txt"


def note_created(out_dir: str | Path | None, ids, why: str = "") -> None:
    """Append job ids to <out>/created-ids.txt the moment they are known,
    so a run that is killed (CI cancel, timeout) still leaves the list
    for `python -m loadtest cleanup --ids-file …`."""
    ids = [i for i in ids if i]
    if not out_dir or not ids:
        return
    try:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        with open(out / CREATED_IDS_FILE, "a") as f:
            f.write("".join(f"{i}  # {why}\n" if why else f"{i}\n" for i in ids))
            f.flush()
            os.fsync(f.fileno())
    except OSError as e:
        log(f"could not write {CREATED_IDS_FILE}: {e}")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
