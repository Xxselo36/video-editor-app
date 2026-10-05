"""Ops inspect: why are uploads refused? Prints GET /admin/capacity.

Reads the live backend's /admin/capacity (X-Admin-Token) and prints the
disk of CLEO_TMP_ROOT, what the jobs in flight reserve, what a
10-minute upload of 0.5–4 GB needs and whether it fits now, the
in-flight entries, the multipart-init rate, the CLEO_* limits in effect
and the newest upload refusals (upload_refused events) — then a short
diagnosis.

Env: CLEO_ADMIN_TOKEN (required), CLEO_API (default
https://api.cleocuts.com).

Logs are public (the repo is): only numbers, flags and snake_case codes
are printed — never the token, user ids or their hashes ("who"), job ids
or response bodies. Exit 1 when the endpoint can't be read.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("CLEO_API", "https://api.cleocuts.com").rstrip("/")
RETRY_WAIT_S = 30
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# The fields of a refusal that are printed ("who" never is).
REFUSAL_COLUMNS = ("age_s", "where", "code", "status", "size_gb", "seconds",
                   "free_gb", "reserved_gb", "need_gb", "n_upload",
                   "n_analyze", "n_render")


def safe(value) -> str:
    """A value as printed: numbers, flags and codes; anything else '?'."""
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return f"{value:g}" if isinstance(value, float) else str(value)
    if isinstance(value, str) and _CODE.match(value):
        return value
    return "?"


def summary(line: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def get_capacity(token: str, *, sleep=time.sleep) -> tuple[int, dict | None]:
    """GET /admin/capacity as the admin; one retry after RETRY_WAIT_S
    for network errors and 5xx. (status, parsed body or None)."""
    last = ""
    for attempt in (1, 2):
        req = urllib.request.Request(API + "/admin/capacity", headers={
            "X-Admin-Token": token, "Accept": "application/json",
            "User-Agent": "cleocuts-ops-inspect"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return e.code, None
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError) as e:
            last = type(getattr(e, "reason", e)).__name__
        except ValueError:
            return 0, None
        if attempt == 1:
            print(f"/admin/capacity: {last}, retrying in {RETRY_WAIT_S} s",
                  flush=True)
            sleep(RETRY_WAIT_S)
    print(f"/admin/capacity failed twice ({last})", flush=True)
    return 0, None


def diagnose(c: dict) -> list[str]:
    """Plain-language findings from the report (codes and numbers)."""
    out: list[str] = []
    recent = (c.get("refusals") or {}).get("recent") or []
    codes = {}
    for r in recent:
        codes[r.get("code")] = codes.get(r.get("code"), 0) + 1
    disk = [r for r in recent if r.get("code") == "server_storage_full"]
    if disk:
        r = disk[0]
        out.append(
            f"DISK: {len(disk)} of the last {len(recent)} refusals are "
            f"server_storage_full; newest: {safe(r.get('size_gb'))} GB upload "
            f"needed {safe(r.get('need_gb'))} GB, {safe(r.get('free_gb'))} GB "
            f"free, {safe(r.get('reserved_gb'))} GB reserved by jobs in "
            "flight (+ CLEO_MIN_FREE_GB).")
        if not r.get("seconds"):
            out.append("  that refusal had no video length: the old "
                       "CLEO_DISK_FACTOR x size estimate applied.")
    total = (c.get("tmp_root") or {}).get("total_gb")
    fits = c.get("fits_now") or []
    too_big = [f["size_gb"] for f in fits if not f.get("fits")]
    if too_big:
        out.append(f"ROOM: right now a 10-min upload of {safe(min(too_big))} GB "
                   f"or more does not fit (volume {safe(total)} GB, room "
                   f"{safe(c.get('room_gb'))} GB).")
    if codes.get("too_many_uploads"):
        out.append(f"RATE: {codes['too_many_uploads']} refusal(s) "
                   "too_many_uploads (CLEO_UPLOAD_INITS_PER_HOUR).")
    if codes.get("server_busy"):
        out.append(f"QUEUE: {codes['server_busy']} refusal(s) server_busy "
                   "(CLEO_MAX_QUEUE).")
    entries = (c.get("inflight") or {}).get("entries") or []
    stale = [e for e in entries
             if not e.get("has_thread") and (e.get("age_s") or 0) > 600]
    if stale:
        out.append(f"LEAK?: {len(stale)} upload entr(y/ies) without a worker "
                   "older than 10 min (swept after CLEO_UPLOAD_ENTRY_TTL_S).")
    if not out:
        out.append("No refusal pattern found in the recorded events.")
    return out


def report(c: dict) -> list[str]:
    lines: list[str] = []
    tmp, work = c.get("tmp_root") or {}, c.get("work_root") or {}
    lines.append("== disk (CLEO_TMP_ROOT, where analyses write) ==")
    lines.append(f"total {safe(tmp.get('total_gb'))} GB, used "
                 f"{safe(tmp.get('used_gb'))} GB, free "
                 f"{safe(tmp.get('free_gb'))} GB; same disk as the work root: "
                 f"{safe(tmp.get('same_disk_as_work_root'))} (work root free "
                 f"{safe(work.get('free_gb'))} GB)")
    lines.append(f"reserved by jobs in flight {safe(c.get('reserved_gb'))} GB; "
                 f"room for a new upload {safe(c.get('room_gb'))} GB; proxy "
                 f"cache {safe(c.get('proxy_cache_gb'))} GB")
    lines.append("== a 10-minute 1080p upload now ==")
    for f in c.get("fits_now") or []:
        lines.append(f"  {safe(f.get('size_gb'))} GB: needs "
                     f"{safe(f.get('need_gb'))} GB -> "
                     f"{'fits' if f.get('fits') else 'REFUSED (507)'}")
    inf = c.get("inflight") or {}
    lines.append("== in flight (this process) ==")
    lines.append(f"uploads {safe(inf.get('n_upload'))}, analyses "
                 f"{safe(inf.get('n_analyze'))}, renders "
                 f"{safe(inf.get('n_render'))}; reservations "
                 f"{safe(inf.get('reserved_gb'))} GB")
    for e in inf.get("entries") or []:
        lines.append(f"  {safe(e.get('kind'))}: {safe(e.get('age_s'))} s old, "
                     f"{safe(e.get('need_gb'))} GB, worker thread "
                     f"{safe(e.get('has_thread'))}")
    rate = c.get("init_rate") or {}
    lines.append("== multipart inits (last hour) ==")
    lines.append(f"limit {safe(rate.get('limit_per_hour'))}/h per caller; "
                 f"{safe(rate.get('events'))} init(s) by "
                 f"{safe(rate.get('keys'))} caller(s), at most "
                 f"{safe(rate.get('max_per_key'))} by one")
    lines.append("== limits in effect ==")
    for k, v in sorted((c.get("limits") or {}).items()):
        if re.match(r"^CLEO_[A-Z0-9_]+$", str(k)):
            lines.append(f"  {k} = {safe(v)}")
    ref = c.get("refusals") or {}
    by_code = ref.get("by_code") or {}
    lines.append("== upload refusals ==")
    for label in ("24h", "7d"):
        counts = by_code.get(label) or {}
        lines.append(f"  {label}: " + (", ".join(
            f"{safe(k)} {safe(n)}" for k, n in sorted(counts.items()))
            or "none"))
    recent = ref.get("recent") or []
    callers = len({r.get("who") for r in recent if r.get("who")})
    lines.append(f"  newest {len(recent)} (from {callers} caller(s)), newest "
                 "first:")
    lines.append("  " + " | ".join(REFUSAL_COLUMNS))
    for r in recent:
        lines.append("  " + " | ".join(safe(r.get(k)) for k in REFUSAL_COLUMNS))
    lines.append("== diagnosis ==")
    lines.extend(diagnose(c))
    return lines


def main() -> int:
    token = os.environ.get("CLEO_ADMIN_TOKEN", "")
    if not token:
        print("::error title=Ops inspect not configured::The CLEO_ADMIN_TOKEN "
              "repo secret is not set.", flush=True)
        return 1
    status, body = get_capacity(token)
    if status != 200 or not isinstance(body, dict):
        print(f"/admin/capacity: HTTP {status or 'error'} (404: the backend "
              "is older than this check or CLEO_ADMIN_TOKEN is unset there; "
              "401: the secret differs from Railway's)", flush=True)
        return 1
    lines = report(body)
    for line in lines:
        print(line, flush=True)
    summary("```\n" + "\n".join(lines) + "\n```")
    return 0


if __name__ == "__main__":
    sys.exit(main())
