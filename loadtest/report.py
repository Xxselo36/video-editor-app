"""Pass/fail checks against the WP7 thresholds and the markdown report
(also appended to $GITHUB_STEP_SUMMARY when set)."""
from __future__ import annotations

import json
import math
import os
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .common import REPO_ROOT, Recorder, is_http, percentile

PASS, FAIL, WARN, SKIP, INFO = "PASS", "FAIL", "WARN", "SKIP", "INFO"
OK_2XX = frozenset(range(200, 300)) | {304}
LAG_WARN_MS = 50.0
MAX_REFUSAL_RATE = 0.01  # default share of 429/503 (+ Retry-After) allowed


@dataclass
class Expect:
    """What one endpoint label may answer and how fast.

    ok       status codes that are intended (anything else fails)
    p95_ms   latency threshold (None = report only)
    refusals 429 / 503 WITH Retry-After count as intended overload
             refusals (WP7: "only intended 402/413/429/503 with
             Retry-After"); without the header they fail
    all_ok   every request must get an `ok` answer, no transport error
             either (/health: "100% up")
    required the scenario's main measurement: FAIL when it got no answer
             at all (e.g. every token mint failed)
    max_refusal_rate
             share of requests that may be such refusals (default: the
             evaluate() argument). Above it the endpoint wasn't measured
             — FAIL, not a pass on refusals."""
    label: str
    ok: frozenset = OK_2XX
    p95_ms: float | None = None
    refusals: bool = True
    all_ok: bool = False
    required: bool = False
    max_refusal_rate: float | None = None


@dataclass
class Check:
    name: str
    result: str
    detail: str = ""


@dataclass
class Result:
    """What a scenario hands back to the CLI."""
    scenario: str
    meta: dict
    rec: Recorder
    duration_s: float
    checks: list[Check] = field(default_factory=list)
    sections: list[tuple[str, str]] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

    @property
    def verdict(self) -> str:
        return FAIL if any(c.result == FAIL for c in self.checks) else PASS


def _fmt_ms(v: float) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    return f"{v:.0f}" if v >= 10 else f"{v:.1f}"


def evaluate(rec: Recorder, expects: list[Expect], *,
             max_error_rate: float,
             max_refusal_rate: float = MAX_REFUSAL_RATE) -> list[Check]:
    checks: list[Check] = []
    token_errors = rec.counters.get("token errors", 0)
    if token_errors:
        # Requests that were never sent: the run measured less than it
        # claims (Clerk minting failed / expired test session).
        checks.append(Check("0 token errors (test-user tokens minted)", FAIL,
                            f"{token_errors} requests not sent: no token"))
    known = {e.label for e in expects}
    todo = list(expects) + [Expect(label) for label in rec.codes
                            if label not in known]
    for e in todo:
        codes = rec.codes.get(e.label)
        if not codes:
            if e.required:
                checks.append(Check(f"{e.label}: measured", FAIL,
                                    "no request answered — nothing was measured"))
            continue
        total = sum(codes.values())
        errors = sum(v for k, v in codes.items() if not is_http(k))
        bad: dict[str, int] = {}
        refused = 0
        for k, v in codes.items():
            if not is_http(k) or int(k) in e.ok:
                continue
            if e.refusals and k in ("429", "503"):
                refused += v
                continue
            bad[k] = bad.get(k, 0) + v
        missing_ra = rec.no_retry_after.get(e.label, 0) if e.refusals else 0
        if missing_ra:
            bad["429/503 without Retry-After"] = missing_ra
            refused -= missing_ra
        if e.p95_ms is not None:
            # Real answers only: 429/503 refusals are kept apart.
            p95 = percentile(sorted(rec.lat.get(e.label, ())), 95)
            ok = not math.isnan(p95) and p95 < e.p95_ms
            checks.append(Check(f"{e.label}: p95 < {e.p95_ms:g} ms",
                                PASS if ok else FAIL,
                                f"p95 {_fmt_ms(p95)} ms" if not math.isnan(p95)
                                else "no answer other than refusals / errors"))
        detail = (", ".join(f"{k}: {v}" for k, v in sorted(bad.items()))
                  if bad else f"{total} requests")
        if refused:
            detail += f"; {refused} intended refusals (429/503 + Retry-After)"
        checks.append(Check(f"{e.label}: only intended status codes",
                            FAIL if bad else PASS, detail))
        if e.refusals and refused > 0:
            cap = (e.max_refusal_rate if e.max_refusal_rate is not None
                   else max_refusal_rate)
            share = refused / total
            checks.append(Check(
                f"{e.label}: refusals (429/503) ≤ {cap:.1%}",
                PASS if share <= cap else FAIL,
                f"{refused}/{total} ({share:.2%}) refused"
                + ("" if share <= cap else
                   " — the endpoint was mostly not measured (WAF / rate "
                   "limit / overload); --max-refusal-rate to change")))
        if e.all_ok:
            good = sum(v for k, v in codes.items()
                       if is_http(k) and int(k) in e.ok)
            checks.append(Check(f"{e.label}: 100% answered", PASS if good == total
                                else FAIL, f"{good}/{total} OK"))
        elif errors:
            rate = errors / total
            checks.append(Check(
                f"{e.label}: transport errors ≤ {max_error_rate:.2%}",
                PASS if rate <= max_error_rate else FAIL,
                f"{errors}/{total} ({rate:.3%})"))
    if rec.lag:
        p99 = percentile(sorted(rec.lag), 99)
        checks.append(Check(
            f"load generator not saturated (event-loop lag p99 < {LAG_WARN_MS:g} ms)",
            PASS if p99 < LAG_WARN_MS else WARN,
            f"lag p99 {_fmt_ms(p99)} ms"
            + ("" if p99 < LAG_WARN_MS else
               " — latencies include client delay: use more --procs / runners")))
    return checks


def endpoint_table(rec: Recorder, duration_s: float) -> str:
    media = sum(rec.nbytes.values()) >= 10e6  # show MB only when it matters
    lines = ["| Endpoint | Requests | req/s | p50 ms | p95 ms | p99 ms | max ms "
             "| Status codes |" + (" MB read |" if media else ""),
             "|---|---:|---:|---:|---:|---:|---:|---|" + ("---:|" if media else "")]
    for label in sorted(rec.codes):
        s = rec.summary(label, duration_s)
        codes = ", ".join(f"{k}×{v}" for k, v in s["codes"].items())
        lines.append(
            f"| `{label}` | {s['requests']} | {s['rps'] or 0:.1f} | "
            f"{_fmt_ms(s['p50_ms'])} | {_fmt_ms(s['p95_ms'])} | "
            f"{_fmt_ms(s['p99_ms'])} | {_fmt_ms(s['max_ms'])} | {codes} |"
            + (f" {s['bytes'] / 1e6:.1f} |" if media else ""))
    return "\n".join(lines)


def git_rev() -> str:
    sha = os.environ.get("GITHUB_SHA", "")
    if sha:
        return sha[:10]
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                              cwd=REPO_ROOT, capture_output=True, text=True,
                              timeout=5).stdout.strip() or "?"
    except Exception:
        return "?"


def render(res: Result) -> str:
    out = [f"## Load test `{res.scenario}`: **{res.verdict}**", ""]
    out += ["| | |", "|---|---|"]
    out += [f"| {k} | {v} |" for k, v in res.meta.items()]
    out += ["", "### Checks", "", "| Result | Check | Detail |", "|---|---|---|"]
    out += [f"| **{c.result}** | {c.name} | {c.detail} |" for c in res.checks]
    if res.rec.codes:
        out += ["", "### Endpoints", "",
                "Latency = until the whole response was read (media: until "
                "the response headers).", "", endpoint_table(res.rec, res.duration_s)]
    if res.rec.counters:
        out += ["", "### Counters", "", "| Counter | Value |", "|---|---:|"]
        out += [f"| {k} | {v:,} |" for k, v in sorted(res.rec.counters.items())]
    for title, body in res.sections:
        out += ["", f"### {title}", "", body]
    if res.rec.samples:
        out += ["", "<details><summary>Examples of non-2xx answers</summary>", ""]
        for key, bodies in sorted(res.rec.samples.items())[:25]:
            for b in bodies:
                out.append(f"- `{key}`: `{b[:200].replace('`', ' ') or '(empty)'}`")
        out += ["", "</details>"]
    if res.rec.notes:
        out += ["", "### Notes", ""] + [f"- {n}" for n in res.rec.notes]
    return "\n".join(out) + "\n"


def _clean(o):
    """NaN → None (JSON has no NaN), sets → sorted lists."""
    if isinstance(o, float) and math.isnan(o):
        return None
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set, frozenset)):
        items = sorted(o) if isinstance(o, (set, frozenset)) else o
        return [_clean(v) for v in items]
    return o


def to_json(res: Result) -> dict:
    return _clean({
        "scenario": res.scenario,
        "verdict": res.verdict,
        "meta": res.meta,
        "duration_s": res.duration_s,
        "checks": [asdict(c) for c in res.checks],
        "endpoints": {label: res.rec.summary(label, res.duration_s)
                      for label in sorted(res.rec.codes)},
        "counters": dict(res.rec.counters),
        "lost_ids": sorted(res.rec.lost_ids),
        "extra": res.extra,
    })


def write(res: Result, out_dir: str | Path) -> tuple[Path, str]:
    text = render(res)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    md = out / f"{res.scenario}-{stamp}.md"
    md.write_text(text)
    (out / f"{res.scenario}-{stamp}.json").write_text(
        json.dumps(to_json(res), indent=2, default=str))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(text + "\n")
    return md, text

