"""Unit tests for the load-test harness (no backend needed).

    python -m unittest discover -s loadtest/tests -t .
"""
from __future__ import annotations

import asyncio
import json
import math
import pickle
import random
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

import aiohttp
from aiohttp import web

from loadtest import cli, report
from loadtest.common import (
    BearerIdentity, ClerkSessionIdentity, Identity, Recorder, UsageError,
    make_session, note_created, percentile, probe_loop, read_ids,
    resolve_identities, user_identities,
)
from loadtest.report import Expect, Result, evaluate
from loadtest.scenarios import burst, editor_saves


class Percentiles(unittest.TestCase):
    def test_nearest_rank(self):
        vals = list(range(1, 101))
        self.assertEqual(percentile(vals, 50), 50)
        self.assertEqual(percentile(vals, 95), 95)
        self.assertEqual(percentile(vals, 99), 99)
        self.assertEqual(percentile(vals, 100), 100)
        self.assertEqual(percentile([7], 95), 7)
        self.assertTrue(math.isnan(percentile([], 95)))


class Recording(unittest.TestCase):
    def test_retry_after_and_merge(self):
        a, b = Recorder(), Recorder()
        a.record("x", 200, 5)
        a.record("x", 503, 7, headers={"retry-after": "120"})
        b.record("x", 503, 9, headers={})
        b.record("x", "ERR:timeout", 30000)
        a.merge(b)
        self.assertEqual(a.codes["x"], {"200": 1, "503": 2, "ERR:timeout": 1})
        self.assertEqual(a.no_retry_after["x"], 1)
        # errors have no latency; refusals are kept out of the p95
        self.assertEqual(len(a.lat["x"]), 1)
        self.assertEqual(len(a.refusal_lat["x"]), 2)
        pickle.loads(pickle.dumps(a))  # crosses process boundaries

    def test_evaluate(self):
        rec = Recorder()
        for _ in range(98):
            rec.record("GET /s", 200, 10)
        rec.record("GET /s", 304, 12)
        rec.record("GET /s", 503, 15, headers={"retry-after": "1"})
        rec.record("GET /h", 200, 900)
        rec.record("GET /h", "ERR:timeout", 0)
        rec.record("GET /other", 404, 3)
        checks = {c.name: c.result for c in evaluate(rec, [
            Expect("GET /s", frozenset({200, 304}), 200),
            Expect("GET /h", frozenset({200}), 200, refusals=False, all_ok=True),
        ], max_error_rate=0.001)}
        self.assertEqual(checks["GET /s: p95 < 200 ms"], report.PASS)
        self.assertEqual(checks["GET /s: only intended status codes"], report.PASS)
        self.assertEqual(checks["GET /h: p95 < 200 ms"], report.FAIL)
        self.assertEqual(checks["GET /h: 100% answered"], report.FAIL)
        # Labels without an expectation: anything but 2xx/304 fails.
        self.assertEqual(checks["GET /other: only intended status codes"], report.FAIL)

    def test_refusal_without_retry_after_fails(self):
        rec = Recorder()
        rec.record("GET /s", 429, 5, headers={})
        (codes,) = [c for c in evaluate(rec, [Expect("GET /s")], max_error_rate=0)
                    if "intended" in c.name]
        self.assertEqual(codes.result, report.FAIL)
        self.assertIn("without Retry-After", codes.detail)


    def test_refusals_above_the_share_fail(self):
        # A WAF answering everything with 429 + Retry-After measured nothing.
        rec = Recorder()
        for _ in range(58):
            rec.record("GET /s", 429, 5, headers={"retry-after": "60"})
        checks = {c.name: c for c in evaluate(
            rec, [Expect("GET /s", frozenset({200, 304}), 200, required=True)],
            max_error_rate=0.001)}
        self.assertEqual(checks["GET /s: refusals (429/503) ≤ 1.0%"].result, report.FAIL)
        self.assertEqual(checks["GET /s: p95 < 200 ms"].result, report.FAIL)
        # below the share: fine
        rec = Recorder()
        for _ in range(199):
            rec.record("GET /s", 200, 5)
        rec.record("GET /s", 503, 1, headers={"retry-after": "1"})
        self.assertTrue(all(c.result == report.PASS for c in evaluate(
            rec, [Expect("GET /s", frozenset({200}), 200)], max_error_rate=0)))

    def test_token_errors_and_unmeasured_labels_fail(self):
        rec = Recorder()
        rec.counters["token errors"] += 58
        rec.record("GET /health", 200, 3)
        checks = {c.name: c.result for c in evaluate(rec, [
            Expect("GET /s", frozenset({200}), 200, required=True),
            Expect("GET /optional", frozenset({200}), 200),
            Expect("GET /health", frozenset({200}), 200, all_ok=True)],
            max_error_rate=0)}
        self.assertEqual(checks["0 token errors (test-user tokens minted)"], report.FAIL)
        self.assertEqual(checks["GET /s: measured"], report.FAIL)
        self.assertNotIn("GET /optional: measured", checks)

    def test_created_ids_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            note_created(tmp, ["j1"], "burst x a.mp4")
            note_created(tmp, ["j2", None], "")
            self.assertEqual(read_ids(None, f"{tmp}/created-ids.txt"), ["j1", "j2"])
            # cleanup with a list that was never written: nothing to do
            self.assertEqual(cli.main(["cleanup", "--base-url", "http://127.0.0.1:1",
                                       "--ids-file", f"{tmp}/none.txt"]), 0)


class Cli(unittest.TestCase):
    def parse(self, *argv):
        return cli.build_parser().parse_args(list(argv))

    def test_base_url_guard(self):
        self.assertEqual(cli.resolve_base_url(self.parse("poll-soak")),
                         "https://api.cleocuts.com")
        for scenario in ("editor-saves", "media", "abuse", "burst"):
            with self.assertRaises(UsageError):
                cli.resolve_base_url(self.parse(scenario))
        with self.assertRaises(UsageError):
            cli.resolve_base_url(self.parse("burst", "--base-url", "http://x"))
        self.assertEqual(cli.resolve_base_url(self.parse(
            "burst", "--base-url", "http://x/", "--i-understand-this-costs-money")),
            "http://x")

    def test_usage_error_exit_code(self):
        self.assertEqual(cli.main(["media"]), 2)


class Identities(unittest.TestCase):
    def test_env(self):
        env = {"CLEO_TEST_BEARER": "a, b\nc # comment", "CLEO_ADMIN_TOKEN": "t"}
        users = user_identities(env)
        self.assertEqual([u.token for u in users], ["a", "b", "c"])
        self.assertIsInstance(users[0], BearerIdentity)
        self.assertEqual(resolve_identities("auto", env)[0].kind, "admin")
        self.assertEqual(resolve_identities("auto", {})[0].kind, "none")
        with self.assertRaises(UsageError):
            user_identities({"CLEO_TEST_SESSION_IDS": "sess_1"})
        with self.assertRaises(UsageError):
            resolve_identities("user", {})

    def test_clerk_identity_pickles_without_loop_state(self):
        ident = ClerkSessionIdentity("sk", "sess_123456", 1, "https://x")
        ident._lock = asyncio.Lock()
        ident._jwt = "cached"
        copy = pickle.loads(pickle.dumps(ident))
        self.assertIsNone(copy._lock)
        self.assertIsNone(copy._jwt)

    def test_read_ids(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("a,b\n# x\nc\n")
        self.assertEqual(read_ids("b, d", f.name), ["b", "d", "a", "c"])
        Path(f.name).unlink()


class Mutations(unittest.TestCase):
    def test_mutate_keeps_valid_timelines(self):
        base = [{"start": s, "end": s + 5, "speed": 1.0, "fadeIn": 0.0,
                 "fadeOut": 0.0, "volume": 1.0} for s in (0, 6, 12, 18)]
        rnd = random.Random(1)
        reorders = 0
        for _ in range(500):
            segs, reordered = editor_saves.mutate(base, 23.0, rnd, 0.5, 0.3, 0.5)
            reorders += reordered
            self.assertTrue(1 <= len(segs) <= 4)
            for s in segs:
                self.assertGreaterEqual(s["start"], 0)
                self.assertLessEqual(s["end"], 23.0)
                self.assertGreater(s["end"] - s["start"], 0.05)
        self.assertTrue(100 < reorders < 400)
        self.assertEqual(len(base), 4)  # base untouched


class Burst(unittest.TestCase):
    def test_parse_clips(self):
        ct = burst.import_cost_test("http://127.0.0.1:1", "tok")
        self.assertEqual(ct.API, "http://127.0.0.1:1")
        self.assertEqual(burst.parse_clips("synthetic:2x50, phone1080:10:podcast", ct),
                         [("synthetic", 2.0, "tiktok", 50),
                          ("phone1080", 10.0, "podcast", 1)])
        with self.assertRaises(SystemExit):
            burst.parse_clips("nope:1x2", ct)

    def test_estimate_rate(self):
        rate, src = burst.estimate_rate({"rows": [
            {"test": True, "video_minutes": 2, "usd_all_in": 0.1},
            {"test": True, "video_minutes": 8, "usd_all_in": 0.3},
            {"test": False, "video_minutes": 100, "usd_all_in": 99}]}, False)
        self.assertAlmostEqual(rate, 0.04)
        self.assertIn("earlier test jobs", src)
        rate, src = burst.estimate_rate({}, True)
        self.assertEqual(rate, burst.FALLBACK_USD_PER_MIN[True])


    def test_drain_check(self):
        args = cli.build_parser().parse_args([
            "burst", "--base-url", "http://x", "--max-analyze", "1"])
        b = burst.Burst.__new__(burst.Burst)
        # 1 slot, 60 s per video-min (job a never queued), 4 × 1 min
        b.accepted = {j: {"t1": 0.0, "minutes": 1.0} for j in "abcd"}
        mk = lambda done, q: {"final": "awaiting_review", "done_at": done,
                              "queue": q, "missing": False}
        b.state = {"a": mk(60, []), "b": mk(120, [1]), "c": mk(180, [2, 1]),
                   "d": mk(240, [3, 2, 1])}
        c = burst.drain_check(args, b, 4.0, 240)
        self.assertEqual(c.result, report.PASS, c.detail)
        b.state["d"]["done_at"] = 900  # the queue drained 3.75× slower
        c = burst.drain_check(args, b, 4.0, 900)
        self.assertEqual(c.result, report.FAIL, c.detail)
        args.expect_video_min_per_hour = 10
        self.assertEqual(burst.drain_check(args, b, 4.0, 900).result, report.PASS)

    def test_limits_and_executor_from_the_server(self):
        def parse(*extra):
            with mock.patch.dict(os.environ, {"CLEO_MAX_ANALYZE": "",
                                              "CLEO_MAX_QUEUE": ""}):
                return cli.build_parser().parse_args(
                    ["burst", "--base-url", "http://x", *extra])
        modal = {"enabled": True, "max_queue": 200,
                 "kinds": {"ingest": {"executor": "modal", "limit": 20}}}
        args = parse("--executor", "modal")
        self.assertEqual(burst.resolve_limits(args, modal), "modal")
        self.assertEqual((args.max_analyze, args.max_queue), (20, 200))
        # Given limits win; another executor than asked refuses to start.
        args = parse("--max-analyze", "3")
        burst.resolve_limits(args, modal)
        self.assertEqual((args.max_analyze, args.max_queue), (3, 200))
        local = {"enabled": True, "max_queue": 20,
                 "kinds": {"ingest": {"executor": "local", "limit": 2}}}
        with self.assertRaises(UsageError):
            burst.resolve_limits(parse("--executor", "modal"), local)
        args = parse()
        self.assertEqual(burst.resolve_limits(args, {}), "?")
        self.assertEqual((args.max_analyze, args.max_queue), (2, 20))
        self.assertEqual(burst.resolve_limits(parse(), {"enabled": False}),
                         "wp1")


class ReportRendering(unittest.TestCase):
    def test_render_and_json(self):
        rec = Recorder()
        rec.record("GET /health", 200, 3)
        res = Result("poll-soak", {"Target": "x"}, rec, 10.0,
                     evaluate(rec, [], max_error_rate=0))
        text = report.render(res)
        self.assertIn("**PASS**", text)
        self.assertIn("`GET /health`", text)
        with tempfile.TemporaryDirectory() as tmp:
            md, _ = report.write(res, tmp)
            data = json.loads(md.with_suffix(".json").read_text())
            self.assertEqual(data["verdict"], "PASS")
            json.dumps(data, allow_nan=False)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ClerkMinting(unittest.TestCase):
    """ClerkSessionIdentity against a fake Clerk Backend API."""

    def test_mints_and_refreshes(self):
        calls = []

        async def mint(request):
            calls.append((request.match_info["sid"],
                          request.headers.get("Authorization")))
            return web.json_response({"object": "token", "jwt": f"jwt{len(calls)}"})

        async def run():
            app = web.Application()
            app.router.add_post("/v1/sessions/{sid}/tokens", mint)
            runner = web.AppRunner(app)
            await runner.setup()
            port = _free_port()
            await web.TCPSite(runner, "127.0.0.1", port).start()
            ident = ClerkSessionIdentity("sk_test", "sess_abc", 1,
                                         f"http://127.0.0.1:{port}/v1")
            ident.REFRESH_S = 0.2
            try:
                async with aiohttp.ClientSession() as s:
                    h1 = await ident.headers(s)
                    h2 = await ident.headers(s)  # cached
                    await asyncio.sleep(0.3)
                    h3 = await ident.headers(s)  # renewed
            finally:
                await runner.cleanup()
            return h1, h2, h3

        h1, h2, h3 = asyncio.run(run())
        self.assertEqual(h1, {"Authorization": "Bearer jwt1"})
        self.assertEqual(h2, h1)
        self.assertEqual(h3, {"Authorization": "Bearer jwt2"})
        self.assertEqual(calls, [("sess_abc", "Bearer sk_test")] * 2)


class PollSoakEndToEnd(unittest.TestCase):
    """poll-soak against a tiny fake API (auth off, two jobs)."""

    def setUp(self):
        self.port = _free_port()
        self.hits = {"status": 0}
        ready = threading.Event()

        async def status(request):
            self.hits["status"] += 1
            if self.hits.get("refuse") and self.hits["status"] > 1:  # after setup
                return web.json_response({"detail": "rate limited"}, status=429,
                                         headers={"Retry-After": "60"})
            ids = [i for i in request.query.get("ids", "").split(",") if i]
            if len(ids) > 50:
                return web.json_response({"detail": "too_many_ids"}, status=400)
            known = [i for i in ids if i in ("j1", "j2")]
            etag = 'W/"1"'
            if request.headers.get("If-None-Match") == etag:
                return web.Response(status=304, headers={"ETag": etag})
            return web.json_response(
                {"jobs": [{"id": i, "status": "done"} for i in known],
                 "missing": [i for i in ids if i not in known]},
                headers={"ETag": etag})

        async def ok(request):
            return web.json_response({"status": "ok"})

        async def me(request):
            return web.json_response({"auth_enabled": False})

        app = web.Application()
        app.router.add_get("/jobs/status", status)
        app.router.add_get("/health", ok)
        app.router.add_get("/ready", ok)
        app.router.add_get("/me", me)

        def serve():
            self.loop = asyncio.new_event_loop()
            runner = web.AppRunner(app)
            self.loop.run_until_complete(runner.setup())
            self.loop.run_until_complete(
                web.TCPSite(runner, "127.0.0.1", self.port).start())
            ready.set()
            self.loop.run_forever()
            self.loop.run_until_complete(runner.cleanup())

        self.thread = threading.Thread(target=serve, daemon=True)
        self.thread.start()
        ready.wait(10)

    def tearDown(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)

    def test_probe_loop_refreshes_headers(self):
        class Counting(Identity):
            n = 0

            async def headers(self, session):
                self.n += 1
                return {"Authorization": f"Bearer t{self.n}"}

        ident = Counting()

        async def run():
            rec = Recorder()
            async with make_session(5) as s:
                await probe_loop(s, rec, f"http://127.0.0.1:{self.port}",
                                 time.time() + 0.45, [("GET /health", "/health")],
                                 ident=ident, every=0.1)
            return rec

        rec = asyncio.run(run())
        self.assertGreaterEqual(ident.n, 4)  # a fresh token every round
        self.assertEqual(ident.n, sum(rec.codes["GET /health"].values()))

    def test_media_status_probe_sends_at_most_50_ids(self):
        from types import SimpleNamespace
        from loadtest.scenarios import media
        ctx = SimpleNamespace(
            base=f"http://127.0.0.1:{self.port}", start_at=time.time(),
            stop_at=time.time() + 0.3, identities=[Identity()],
            params={"streams": [{"id": f"j{i}"} for i in range(60)],
                    "downloads": [{"id": "j1"}]})

        async def run():
            rec = Recorder()
            async with make_session(5) as s:
                await media._probes(s, rec, ctx)
            return rec

        rec = asyncio.run(run())
        self.assertEqual(set(rec.codes["GET /jobs/status"]), {"200"})

    def test_all_refused_is_a_fail(self):
        self.hits["refuse"] = True
        with tempfile.TemporaryDirectory() as tmp:
            args = cli.build_parser().parse_args([
                "poll-soak", "--base-url", f"http://127.0.0.1:{self.port}",
                "--identity", "none", "--users", "5", "--minutes", "0.05",
                "--interval", "0.5", "--ids", "j1,j2", "--out", tmp])
            res = cli.SCENARIOS["poll-soak"].main(args, args.base_url)
        self.assertEqual(res.verdict, report.FAIL, report.render(res))

    def test_sigterm_takes_the_interrupt_path(self):
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
        with tempfile.TemporaryDirectory() as tmp:
            p = subprocess.Popen(
                [sys.executable, "-m", "loadtest", "poll-soak", "--base-url",
                 f"http://127.0.0.1:{self.port}", "--identity", "none",
                 "--users", "2", "--minutes", "1", "--ids", "j1", "--out", tmp],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(3)
            p.send_signal(signal.SIGTERM)
            out, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 130, err.decode()[-500:])
        self.assertIn(b"interrupted", err)

    def test_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = cli.build_parser().parse_args([
                "poll-soak", "--base-url", f"http://127.0.0.1:{self.port}",
                "--identity", "none", "--users", "5", "--minutes", "0.05",
                "--interval", "0.5", "--ids", "j1,j2", "--out", tmp])
            res = cli.SCENARIOS["poll-soak"].main(args, args.base_url)
        self.assertEqual(res.verdict, report.PASS, report.render(res))
        codes = res.rec.codes["GET /jobs/status"]
        self.assertGreater(codes["304"], 0)
        self.assertGreater(self.hits["status"], 10)
        self.assertEqual(res.rec.lost_ids, set())


if __name__ == "__main__":
    unittest.main()
