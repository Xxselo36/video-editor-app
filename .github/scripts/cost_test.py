"""End-to-end cost test against the live backend.

Builds talking-head-like test videos (synthetic German speech with
pauses and fillers over a moving test pattern), runs each through
upload → analyze → render exactly like the web app, and reports
timings plus (with the CLEO_ADMIN_TOKEN secret) the per-job costs.

Resolution, frame rate, codec, HDR and bitrate change upload size,
normalization, storage and render time a lot, so each run is

    profile:minutes[:preset]      e.g. phone1080:10  iphone4khdr:3:podcast

Profiles (PROFILES below):
  synthetic    1080x1920 H.264 1 Mbit/s, clean test pattern (cheap baseline)
  phone1080    1080x1920 30p H.264 High 16 Mbit/s, light sensor noise (SDR)
  phone4k      4K 30p H.264 High 45 Mbit/s, stored landscape + rotation flag
  iphone1080hdr 1080p 30p HEVC 10-bit HLG ~10 Mbit/s, rotated (iPhone default)
  iphone4khdr  4K 30p HEVC 10-bit HLG ~45 Mbit/s, rotated (iPhone 4K HDR)
  iphone4kloop iphone4khdr at 28 Mbit/s with a 30 s picture looped (built
               in minutes: 10 min ≈ 2.1 GB) — the big-upload case
               (iphone4kloop:10), e.g. for the Modal analysis
Presets mirror web/src/features/start/presets.legacy.ts PRESETS (default: tiktok).
A bare number means "synthetic". Files over 90 MB go straight to R2
like in the web app. Jobs are tagged _cost_test so /admin/costs can
exclude them (?exclude_tests=true).

EXPECT_EXECUTOR=local|modal (the workflow's ingest_executor input):
before anything is built, GET /admin/queue must report that ingest
executor (the server's CLEO_EXECUTOR_INGEST with CLEO_TASK_QUEUE=1) —
so a run meant for the Modal analysis can't silently measure the local
one. The executor is printed either way (with the admin token).

Known limits: the grain level is a guess, not calibrated against real
footage (it strongly affects file sizes); egress is an estimate (every
job file served once).
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

API = os.environ.get("CLEO_API", "https://api.cleocuts.com").rstrip("/")
ADMIN = os.environ.get("CLEO_ADMIN_TOKEN", "")
SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")
R2_THRESHOLD = 90 * 1024 * 1024  # same cut-over as the web app
SINGLE_PUT_LIMIT = 4.5e9         # R2 single PUT max is 5 GiB

_H264 = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p"]
_HLG = ["-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p10le",
        "-x265-params", "log-level=error:colorprim=bt2020:"
        "transfer=arib-std-b67:colormatrix=bt2020nc",
        "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
        "-colorspace", "bt2020nc"]
_PHONE_AUDIO = ["-ar", "48000", "-ac", "2", "-b:a", "192k"]

PROFILES: dict[str, dict] = {
    "synthetic": {"w": 1080, "h": 1920, "fps": 30, "vb": "900k", "noise": 0,
                  "codec": _H264, "preset": "veryfast", "rotate": False,
                  "audio": ["-ar", "44100", "-ac", "1", "-b:a", "96k"]},
    "phone1080": {"w": 1080, "h": 1920, "fps": 30, "vb": "16M", "noise": 6,
                  "codec": _H264, "preset": "veryfast", "rotate": False,
                  "audio": _PHONE_AUDIO},
    "phone4k": {"w": 2160, "h": 3840, "fps": 30, "vb": "45M", "noise": 6,
                "codec": _H264, "preset": "veryfast", "rotate": True,
                "audio": _PHONE_AUDIO},
    "iphone1080hdr": {"w": 1080, "h": 1920, "fps": 30, "vb": "10M", "noise": 6,
                      "codec": _HLG, "preset": "superfast", "rotate": True,
                      "audio": _PHONE_AUDIO},
    "iphone4khdr": {"w": 2160, "h": 3840, "fps": 30, "vb": "45M", "noise": 6,
                    "codec": _HLG, "preset": "superfast", "rotate": True,
                    "audio": _PHONE_AUDIO},
    # Encoding 10 min of 4K HEVC takes a runner most of an hour; 30 s
    # encoded once and stream-copied in a loop takes minutes and decodes
    # exactly as expensively on the server.
    "iphone4kloop": {"w": 2160, "h": 3840, "fps": 30, "vb": "28M", "noise": 6,
                     "codec": _HLG, "preset": "superfast", "rotate": True,
                     "audio": _PHONE_AUDIO, "loop_s": 30},
}

# web/src/features/start/presets.legacy.ts PRESETS[*].settings, as sent by
# the upload (features/upload/uploadJob.ts).
PRESETS: dict[str, dict] = {
    "tiktok": {"caption_preset": "clipper", "style": "tight",
               "voice_triggers": True, "remove_fillers": True,
               "smartcam_enabled": True, "smartcam_format": "portrait",
               "output_formats": ["9:16"]},
    "podcast": {"caption_preset": "clean", "style": "smooth",
                "voice_triggers": True, "remove_fillers": True,
                "smartcam_enabled": False, "smartcam_format": "landscape",
                "output_formats": ["16:9", "9:16"]},
    "vlog": {"caption_preset": "subtle", "style": "balanced",
             "voice_triggers": True, "remove_fillers": True,
             "smartcam_enabled": False, "smartcam_format": "portrait",
             "output_formats": []},
    "captions": {"caption_preset": "clean", "style": "smooth",
                 "voice_triggers": False, "remove_fillers": False,
                 "smartcam_enabled": False, "smartcam_format": "portrait",
                 "output_formats": []},
}

SENTENCES = [
    "Hallo zusammen und willkommen zurück auf meinem Kanal.",
    "Heute zeige ich euch, wie ich meine Videos in wenigen Minuten schneide.",
    "Äh, das Wichtigste zuerst: gutes Licht ist wichtiger als eine teure Kamera.",
    "Ich nehme alles mit dem Handy auf und rede einfach frei.",
    "Ähm, wenn ich mich verspreche, sage ich einfach das Kommando und mache weiter.",
    "Der zweite Punkt ist der Ton, also ein kleines Ansteckmikrofon reicht völlig.",
    "Viele unterschätzen, wie sehr schlechter Ton die Zuschauer vertreibt.",
    "Also, äh, lasst uns jetzt direkt in die Bearbeitung gehen.",
    "Die Pausen werden automatisch entfernt und die Untertitel erscheinen sofort.",
    "Danach prüfe ich nur noch kurz die Zeitleiste und exportiere das Video.",
    "Wenn euch das hilft, lasst gerne ein Abo da.",
    "Im nächsten Teil schauen wir uns an, wie man gute Hooks schreibt.",
    "Ein guter Einstieg entscheidet in den ersten drei Sekunden über alles.",
    "Ähm, ich teste das gerade mit verschiedenen Formaten und Längen.",
    "Das war es für heute, bis zum nächsten Mal.",
]


def redact(text: str) -> str:
    """Strip query strings (presigned signatures) from any URL."""
    return re.sub(r"(https?://[^\s?'\"]+)\?[^\s'\"]*", r"\1?…", str(text))


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(redact(
            f"{Path(cmd[0]).name} exit {r.returncode}: "
            f"{(r.stdout or '')[-400:]} {(r.stderr or '')[-400:]}"))
    return r


def wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def make_speech(minutes: float, work: Path) -> Path:
    """Synthetic speech with pauses (some cuttable) and fillers."""
    rnd = random.Random(int(minutes * 100))
    parts: list[Path] = []
    total = 0.0
    i = 0
    while total < minutes * 60:
        s = work / f"s{i}.wav"
        run(["espeak-ng", "-v", "de", "-s", "150", "-w", str(s),
             rnd.choice(SENTENCES)])
        total += wav_seconds(s)
        parts.append(s)
        pause = rnd.choice([0.3, 0.4, 0.6, 1.2, 2.0])
        p = work / f"p{i}.wav"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i",
             "anullsrc=r=22050:cl=mono", "-t", str(pause), str(p)])
        total += pause
        parts.append(p)
        i += 1
    lst = work / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    audio = work / f"speech_{minutes:g}.wav"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
         "-ar", "48000", "-ac", "1", str(audio)])
    for p in parts:
        p.unlink(missing_ok=True)
    return audio


def make_video(profile: str, minutes: float, work: Path) -> Path:
    cfg = PROFILES[profile]
    audio = make_speech(minutes, work)
    w, h = cfg["w"], cfg["h"]
    if cfg["rotate"]:
        # Phones store portrait clips as landscape frames plus a
        # rotation flag; the backend must honour it when normalizing.
        w, h = h, w
    vf = f"testsrc2=size={w}x{h}:rate={cfg['fps']}"
    if cfg["noise"]:
        # Light sensor-like grain so frames don't compress unrealistically
        # well. Level is a guess — it moves every size/time number.
        vf += f",noise=alls={cfg['noise']}:allf=t+u"
    vb = cfg["vb"]
    num = float(vb[:-1]) * (1e6 if vb.endswith("M") else 1e3)
    raw = work / f"raw_{profile}_{minutes:g}.mp4"
    rate = ["-b:v", vb, "-maxrate", str(int(num * 1.2)),
            "-bufsize", str(int(num * 2))]
    loop_s = cfg.get("loop_s")
    if loop_s and minutes * 60 > loop_s:
        # One loop_s piece of picture, then stream-copied over the whole
        # speech track (no second encode).
        piece = work / f"piece_{profile}.mp4"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", vf, "-t", str(loop_s),
             *cfg["codec"], "-preset", cfg["preset"],
             "-g", str(cfg["fps"]), *rate, "-an", str(piece)])
        # -t, not -shortest: with an endless copied input -shortest
        # doesn't stop the copy.
        run(["ffmpeg", "-y", "-stream_loop", "-1", "-i", str(piece),
             "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0",
             "-t", f"{wav_seconds(audio):.3f}",
             "-c:v", "copy", "-c:a", "aac", *cfg["audio"],
             "-movflags", "+faststart", str(raw)])
        piece.unlink(missing_ok=True)
    else:
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", vf, "-i", str(audio),
             "-shortest", *cfg["codec"], "-preset", cfg["preset"],
             "-g", str(cfg["fps"]), *rate,
             "-c:a", "aac", *cfg["audio"], "-movflags", "+faststart",
             str(raw)])
    audio.unlink(missing_ok=True)
    out = work / f"{profile}_{minutes:g}min.mp4"
    if cfg["rotate"]:
        try:
            run(["ffmpeg", "-y", "-display_rotation:v:0", "90", "-i", str(raw),
                 "-c", "copy", "-movflags", "+faststart", str(out)])
            raw.unlink(missing_ok=True)
            return out
        except RuntimeError as e:
            print(f"   (rotation flag failed, using unrotated file: {e})",
                  flush=True)
    raw.rename(out)
    return out


def probe(video: Path) -> str:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,profile,width,height,"
         "r_frame_rate,bit_rate,color_transfer:stream_side_data=rotation",
         "-of", "json", str(video)], capture_output=True, text=True)
    try:
        s = json.loads(r.stdout)["streams"][0]
        rot = next((d.get("rotation") for d in s.get("side_data_list", [])
                    if "rotation" in d), None)
        fps = s.get("r_frame_rate", "?").replace("/1", "")
        br = int(s.get("bit_rate") or 0) / 1e6
        hdr = " HLG" if s.get("color_transfer") == "arib-std-b67" else ""
        return (f"{s['codec_name']} {s['width']}x{s['height']} {fps}fps "
                f"{br:.0f}Mbit/s{hdr}" + (f" rot{rot}" if rot is not None else ""))
    except Exception:
        return "?"


def http(method: str, path: str, data: bytes | None = None,
         headers: dict | None = None) -> dict:
    # The admin token doubles as a service identity once accounts are on
    # (bypasses login + quota; lets the jobs keep the _cost_test tag).
    hdrs = {**({"X-Admin-Token": ADMIN} if ADMIN else {}), **(headers or {})}
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()[:500].decode(errors="replace")
        raise RuntimeError(redact(f"{method} {path} → HTTP {e.code}: {body}"))


def upload(video: Path, preset: str) -> str:
    settings = json.dumps({**PRESETS[preset], "whisper_model": "medium",
                           "resolution": "1080", "_cost_test": True})
    size = video.stat().st_size
    if size > SINGLE_PUT_LIMIT:
        raise RuntimeError(f"{size / 1e9:.1f} GB is over the single-PUT limit; "
                           "use a shorter run")
    if size > R2_THRESHOLD:
        # Big files: presigned PUT straight to R2, then /jobs with the key.
        info = http("POST", "/uploads/presign",
                    json.dumps({"filename": video.name,
                                "content_type": "video/mp4"}).encode(),
                    {"Content-Type": "application/json"})
        run(["curl", "-sS", "--fail-with-body", "-m", "3600", "-X", "PUT",
             "-H", "Content-Type: video/mp4", "-T", str(video),
             info["upload_url"]])
        form = ["-F", f"storage_key={info['storage_key']}",
                "-F", f"filename={video.name}"]
    else:
        form = ["-F", f"file=@{video};type=video/mp4"]
    auth = ["-H", f"X-Admin-Token: {ADMIN}"] if ADMIN else []
    out = run(["curl", "-sS", "--fail-with-body", "-m", "1800", *auth, *form,
               "-F", f"settings={settings}", f"{API}/jobs"])
    return json.loads(out.stdout)["job_id"]


POLL_S = 10.0


def wait(job_id: str, target: str, timeout: float) -> dict:
    """Poll until `target` status, an error, or (while rendering) the
    backend's render failure: status back to awaiting_review + error.

    Stall detection: when the job's (status, message, progress,
    updated_at) haven't changed for CLEO_STALL_S (900 s; 0 = off) it
    raises a "stalled" error instead of sitting out the whole timeout —
    a live job writes progress (a Modal render at least every 300 s).
    Time waiting in line for an analyze / render slot doesn't count: a
    queued job is only written when its place changes, and the slot
    ahead may be busy for longer than that."""
    try:
        stall_s = float(os.environ.get("CLEO_STALL_S", "") or 900)
    except ValueError:
        stall_s = 900.0
    t0 = time.time()
    j: dict = {}
    errors = 0
    seen: tuple | None = None
    changed_at = t0
    while time.time() - t0 < timeout:
        try:
            j = http("GET", f"/jobs/{job_id}")
            errors = 0
        except Exception as e:  # transient, like the web app's poller
            errors += 1
            if errors >= 6:
                raise RuntimeError(f"polling failed 6x in a row: {e}")
            time.sleep(POLL_S)
            continue
        st = j.get("status")
        if st == target or st == "error":
            return j
        if target == "done" and st == "awaiting_review" and j.get("error"):
            return j
        now = time.time()
        state = (st, j.get("message"), j.get("progress"), j.get("updated_at"))
        queued = (j.get("queue_position") is not None
                  or j.get("message") == "queued")
        if state != seen or queued:
            seen, changed_at = state, now
        elif stall_s > 0 and now - changed_at >= stall_s:
            raise RuntimeError(
                f"{job_id} stalled: no change for {now - changed_at:.0f}s "
                f"(status {st}, progress {j.get('progress')}, "
                f"message {j.get('message')!r})")
        time.sleep(POLL_S)
    raise TimeoutError(f"{job_id} still {j.get('status')} after "
                       f"{timeout:.0f}s: {j.get('message')}")


SENTENCE_END = re.compile(r"[.!?…][\"'»)\]]*\s*$")


def build_phrases(subs: list[dict]) -> list[dict]:
    """Port of the web's buildPhrases + the onApplyRender flattening."""
    phrases, cur = [], []

    def words(t: str) -> int:
        return len((t or "").split())

    def flush() -> None:
        if not cur:
            return
        first, last = cur[0], cur[-1]
        text = " ".join((s.get("text") or "").strip() for s in cur).strip()
        if text:
            phrases.append({
                "start": first["start"], "end": last["end"], "text": text,
                "original_start": first.get("original_start", first["start"]),
                "original_end": last.get("original_end", last["end"])})
        cur.clear()

    for s in subs:
        if not (s.get("text") or "").strip():
            continue
        if cur:
            prev = cur[-1]
            if (SENTENCE_END.search((prev.get("text") or "").strip())
                    or s["start"] - prev["end"] > 1.5
                    or sum(words(x.get("text")) for x in cur)
                    + words(s.get("text")) > 10):
                flush()
        cur.append(s)
    flush()
    return phrases


def parse_runs(arg: str) -> list[tuple[str, float, str]]:
    runs = []
    for item in (x.strip() for x in arg.split(",")):
        if not item:
            continue
        bits = item.split(":")
        if len(bits) == 1:
            bits = ["synthetic", bits[0]]
        prof, mins = bits[0], float(bits[1])
        preset = bits[2] if len(bits) > 2 else "tiktok"
        if prof not in PROFILES:
            raise SystemExit(f"unknown profile {prof!r}; use {list(PROFILES)}")
        if preset not in PRESETS:
            raise SystemExit(f"unknown preset {preset!r}; use {list(PRESETS)}")
        runs.append((prof, mins, preset))
    return runs


def report(rows: list[dict], final: bool) -> str:
    lines = ["| Profil | Vorlage | Länge | Quelle | MB | Job | Status | "
             "Upload | Analyse | Render |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    lines += [f"| {r['profile']} | {r['preset']} | {r['min']:g} min | "
              f"{r['info']} | {r['mb']:.0f} | `{r['job']}` | {r['status']} | "
              f"{r['up']:.0f}s | {r['an']:.0f}s | {r['re']:.0f}s |"
              for r in rows]
    if final and ADMIN:
        try:
            costs = http("GET", "/admin/costs",
                         headers={"X-Admin-Token": ADMIN})
            by_job = {c["job_id"]: c for c in costs["rows"]}
            lines += ["", "| Profil | Min | Speicher MB | USD gesamt | USD/Min "
                      "| Teile | Analyse s (Server) | Modal s / fallback "
                      "| Dateien MB |",
                      "|---|---|---|---|---|---|---|---|---|"]
            for r in rows:
                c = by_job.get(r["job"])
                if not c:
                    continue
                parts = ", ".join(f"{k[4:]} {v:.4f}" for k, v in c["usd"].items()
                                  if k != "usd_total")
                u = c.get("usage", {})
                lines.append(
                    f"| {r['profile']} | {c['video_minutes']} | {c['storage_mb']} "
                    f"| {c['usd_all_in']:.4f} | {c['usd_per_video_minute']} | "
                    f"{parts} | {u.get('wall_s_analyze', 0):.0f} | "
                    f"{u.get('modal_s', 0):.0f} / "
                    f"{int(u.get('modal_failed', 0))} | "
                    f"{json.dumps(c.get('files_mb', {}))} |")
        except Exception as e:
            lines += ["", f"(cost table unavailable: {e})"]
    text = "\n".join(lines)
    if SUMMARY:
        Path(SUMMARY).write_text("## Cost test\n\n" + text + "\n")
    return text


def check_executor() -> str | None:
    """The server's ingest executor (GET /admin/queue, admin token);
    exits when EXPECT_EXECUTOR names another one."""
    want = os.environ.get("EXPECT_EXECUTOR", "").strip().lower()
    if want in ("", "any"):
        want = ""
    if not ADMIN:
        if want:
            raise SystemExit("EXPECT_EXECUTOR needs CLEO_ADMIN_TOKEN "
                             "(GET /admin/queue)")
        return None
    try:
        q = http("GET", "/admin/queue")
    except Exception as e:
        if want:
            raise SystemExit(f"can't read the ingest executor: {redact(e)}")
        print(f"(ingest executor unknown: {redact(e)})", flush=True)
        return None
    ingest = (q.get("kinds") or {}).get("ingest") or {}
    got = (ingest.get("executor") or "local") if q.get("enabled") else "wp1"
    print(f"ingest executor: {got} (task queue "
          f"{'on' if q.get('enabled') else 'off'}, running limit "
          f"{ingest.get('limit')}, queue cap {q.get('max_queue', '?')})",
          flush=True)
    if want and got != want:
        raise SystemExit(f"the server analyses with {got!r}, this run expects "
                         f"{want!r} (EXPECT_EXECUTOR) — nothing was uploaded")
    return got


def delete_jobs(ids: list[str]) -> None:
    """Free the server volume — test jobs are big (hundreds of MB each)."""
    for jid in ids:
        try:
            http("DELETE", f"/jobs/{jid}")
            print(f"   deleted job {jid}", flush=True)
        except Exception as e:
            print(f"   could not delete {jid}: {e}", flush=True)


def inspect_jobs(ids: list[str]) -> None:
    """Print the server's view of stuck jobs (status fields only — no
    media URLs or transcripts, the Actions log is public)."""
    for path in ("/health", "/ready"):
        try:
            print(f"{path}: {json.dumps(http('GET', path))[:300]}", flush=True)
        except Exception as e:
            print(f"{path}: {redact(e)}", flush=True)
    keys = ("status", "message", "progress", "queue_position", "error",
            "created_at", "updated_at", "has_output")
    for jid in ids:
        try:
            j = http("GET", f"/jobs/{jid}")
            print(f"{jid}: " + json.dumps({k: j.get(k) for k in keys}),
                  flush=True)
        except Exception as e:
            print(f"{jid}: {redact(e)}", flush=True)


def main() -> int:
    if len(sys.argv) > 2 and sys.argv[1] == "--delete":
        delete_jobs([x.strip() for x in sys.argv[2].split(",") if x.strip()])
        return 0
    if len(sys.argv) > 2 and sys.argv[1] == "--inspect":
        inspect_jobs([x.strip() for x in sys.argv[2].split(",") if x.strip()])
        return 0
    runs = parse_runs(sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else
                      "phone1080:2,phone1080:10,phone4k:3,iphone4khdr:3")
    executor = check_executor()
    rows: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for prof, m, preset in runs:
            row = {"profile": prof, "preset": preset, "min": m, "info": "?",
                   "mb": 0.0, "job": "-", "status": "?", "up": 0, "an": 0,
                   "re": 0}
            rows.append(row)
            video = None
            try:
                t_gen = time.time()
                video = make_video(prof, m, work)
                row["mb"] = video.stat().st_size / 1e6
                row["info"] = probe(video)
                print(f"== {prof}/{preset} {m:g} min: {row['info']}, "
                      f"{row['mb']:.0f} MB (built in {time.time() - t_gen:.0f}s)",
                      flush=True)
                t0 = time.time()
                row["job"] = upload(video, preset)
                row["up"] = time.time() - t0
                print(f"   job {row['job']} uploaded in {row['up']:.0f}s",
                      flush=True)
                j = wait(row["job"], "awaiting_review", 3600)
                row["an"] = time.time() - t0 - row["up"]
                if j["status"] != "awaiting_review":
                    row["status"] = f"analyze error: {j.get('message')}"
                else:
                    subs = http("GET", f"/jobs/{row['job']}/subtitles")
                    body = {"subtitles": build_phrases(subs["subtitles"]),
                            "disabled_cuts": []}
                    engine = os.environ.get("CAPTION_ENGINE", "").strip()
                    if engine:  # the per-browser opt-in (?captions=v2)
                        body["caption_engine"] = engine
                    http("POST", f"/jobs/{row['job']}/render",
                         json.dumps(body).encode(),
                         {"Content-Type": "application/json"})
                    t1 = time.time()
                    j = wait(row["job"], "done", 3600)
                    row["re"] = time.time() - t1
                    row["status"] = "done" if j["status"] == "done" else \
                        f"render failed: {j.get('error') or j.get('message')}"
                    if j.get("caption_engine"):
                        print(f"   caption engine: {j['caption_engine']}",
                              flush=True)
            except Exception as e:  # keep going with the next run
                row["status"] = f"failed: {redact(e)}"[:300]
            finally:
                if video is not None:
                    video.unlink(missing_ok=True)
            print(f"   analyze {row['an']:.0f}s"
                  + (f" ({executor})" if executor else "")
                  + f", render {row['re']:.0f}s → {row['status']}",
                  flush=True)
            report(rows, final=False)  # summary survives a later cancel

    print(report(rows, final=True))
    if os.environ.get("KEEP_JOBS", "").lower() not in ("1", "true", "yes"):
        # Costs are in the summary now; the files would otherwise sit on
        # the production volume for the whole retention period.
        delete_jobs([r["job"] for r in rows if r["job"] != "-"])
    return 0 if all(r["status"] == "done" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
