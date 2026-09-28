"""End-to-end cost test against the live backend.

Builds talking-head-like test videos (synthetic German speech with
pauses and fillers over a moving test pattern), runs each through
upload → analyze → render exactly like the web app, and reports the
timings. The backend records the costs of these jobs; with the
CLEO_ADMIN_TOKEN secret set, the per-job costs are printed too.

Resolution, frame rate and bitrate change upload size, normalization,
storage and render time a lot, so runs are "profile:minutes" pairs:

    python cost_test.py phone1080:2,phone1080:10,phone4k:3

Profiles (see PROFILES): synthetic (1080p, 1 Mbit/s — cheap baseline),
phone1080 (1080p30, 16 Mbit/s with sensor-like noise), phone4k (4K30,
45 Mbit/s, stored landscape with a rotation flag like an iPhone portrait
clip) and phone4k60 (same at 60 fps, 60 Mbit/s). A bare number means
"synthetic". Files over 90 MB go straight to R2 like in the web app.
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

API = os.environ.get("CLEO_API", "https://api.cleocuts.com").rstrip("/")
ADMIN = os.environ.get("CLEO_ADMIN_TOKEN", "")
SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")
R2_THRESHOLD = 90 * 1024 * 1024  # same cut-over as the web app

PROFILES: dict[str, dict] = {
    "synthetic": {"w": 1080, "h": 1920, "fps": 30, "vb": "900k",
                  "noise": 0, "preset": "veryfast", "rotate": False,
                  "audio": ["-ar", "44100", "-ac", "1", "-b:a", "96k"]},
    "phone1080": {"w": 1080, "h": 1920, "fps": 30, "vb": "16M",
                  "noise": 12, "preset": "veryfast", "rotate": False,
                  "audio": ["-ar", "48000", "-ac", "2", "-b:a", "192k"]},
    "phone4k": {"w": 2160, "h": 3840, "fps": 30, "vb": "45M",
                "noise": 12, "preset": "ultrafast", "rotate": True,
                "audio": ["-ar", "48000", "-ac", "2", "-b:a", "192k"]},
    "phone4k60": {"w": 2160, "h": 3840, "fps": 60, "vb": "60M",
                  "noise": 12, "preset": "ultrafast", "rotate": True,
                  "audio": ["-ar", "48000", "-ac", "2", "-b:a", "192k"]},
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


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True)


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
        # Sensor-like grain so the encoder can't compress the frames
        # unrealistically well (affects every size/time number).
        vf += f",noise=alls={cfg['noise']}:allf=t+u"
    vb = cfg["vb"]
    num = float(vb[:-1]) * (1e6 if vb.endswith("M") else 1e3)
    raw = work / f"raw_{profile}_{minutes:g}.mp4"
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", vf, "-i", str(audio),
         "-shortest", "-c:v", "libx264", "-preset", cfg["preset"],
         "-pix_fmt", "yuv420p", "-g", str(cfg["fps"]),
         "-b:v", vb, "-maxrate", f"{int(num * 1.2)}",
         "-bufsize", f"{int(num * 2)}",
         "-c:a", "aac", *cfg["audio"], "-movflags", "+faststart", str(raw)])
    audio.unlink(missing_ok=True)
    out = work / f"{profile}_{minutes:g}min.mp4"
    if cfg["rotate"]:
        try:
            run(["ffmpeg", "-y", "-display_rotation:v:0", "90", "-i", str(raw),
                 "-c", "copy", "-movflags", "+faststart", str(out)])
            raw.unlink(missing_ok=True)
            return out
        except subprocess.CalledProcessError as e:
            print(f"   (rotation flag failed, using unrotated file: "
                  f"{e.stderr[-200:]!r})", flush=True)
    raw.rename(out)
    return out


def probe(video: Path) -> str:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,bit_rate:"
         "stream_side_data=rotation", "-of", "json", str(video)],
        capture_output=True, text=True)
    try:
        s = json.loads(r.stdout)["streams"][0]
        rot = next((d.get("rotation") for d in s.get("side_data_list", [])
                    if "rotation" in d), None)
        fps = s.get("r_frame_rate", "?")
        br = int(s.get("bit_rate") or 0) / 1e6
        return (f"{s['width']}x{s['height']} @{fps} {br:.0f} Mbit/s"
                + (f" rot {rot}" if rot is not None else ""))
    except Exception:
        return "?"


def http(method: str, path: str, data: bytes | None = None,
         headers: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"{}")


SETTINGS = json.dumps({
    # Same settings the web app sends for the TikTok / Reels preset.
    "caption_preset": "clipper", "style": "balanced",
    "voice_triggers": True, "remove_fillers": True,
    "whisper_model": "medium", "smartcam_enabled": False,
    "resolution": "1080", "output_formats": [],
})


def upload(video: Path) -> str:
    if video.stat().st_size > R2_THRESHOLD:
        # Big files: presigned PUT straight to R2, then /jobs with the key.
        info = http("POST", "/uploads/presign",
                    json.dumps({"filename": video.name,
                                "content_type": "video/mp4"}).encode(),
                    {"Content-Type": "application/json"})
        run(["curl", "-sS", "--fail", "-m", "3600", "-X", "PUT",
             "-H", "Content-Type: video/mp4", "-T", str(video),
             info["upload_url"]])
        form = ["-F", f"storage_key={info['storage_key']}",
                "-F", f"filename={video.name}"]
    else:
        form = ["-F", f"file=@{video};type=video/mp4"]
    out = subprocess.run(
        ["curl", "-sS", "--fail-with-body", "-m", "1800", *form,
         "-F", f"settings={SETTINGS}", f"{API}/jobs"],
        check=True, capture_output=True, text=True)
    return json.loads(out.stdout)["job_id"]


def wait(job_id: str, until: set[str], timeout: float) -> dict:
    t0 = time.time()
    j: dict = {}
    while time.time() - t0 < timeout:
        j = http("GET", f"/jobs/{job_id}")
        if j["status"] in until or j["status"] == "error":
            return j
        time.sleep(10)
    raise TimeoutError(f"{job_id} stuck in {j.get('status')}: {j.get('message')}")


def parse_runs(arg: str) -> list[tuple[str, float]]:
    runs = []
    for item in (x.strip() for x in arg.split(",")):
        if not item:
            continue
        prof, _, mins = item.rpartition(":")
        prof = prof or "synthetic"
        if prof not in PROFILES:
            raise SystemExit(f"unknown profile {prof!r}; use {list(PROFILES)}")
        runs.append((prof, float(mins)))
    return runs


def main() -> int:
    runs = parse_runs(sys.argv[1] if len(sys.argv) > 1
                      else "phone1080:2,phone1080:10,phone4k:3")
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for prof, m in runs:
            t_gen = time.time()
            video = make_video(prof, m, work)
            size_mb = video.stat().st_size / 1e6
            info = probe(video)
            print(f"== {prof} {m:g} min: {info}, {size_mb:.0f} MB "
                  f"(built in {time.time() - t_gen:.0f}s)", flush=True)
            row = {"profile": prof, "min": m, "info": info, "mb": size_mb,
                   "job": "-", "status": "?", "up": 0, "an": 0, "re": 0}
            rows.append(row)
            try:
                t0 = time.time()
                row["job"] = upload(video)
                row["up"] = time.time() - t0
                print(f"   job {row['job']} uploaded in {row['up']:.0f}s",
                      flush=True)
                j = wait(row["job"], {"awaiting_review"}, 3600)
                row["an"] = time.time() - t0 - row["up"]
                if j["status"] == "error":
                    row["status"] = f"analyze error: {j.get('message')}"
                    print(f"   {row['status']}", flush=True)
                    continue
                subs = http("GET", f"/jobs/{row['job']}/subtitles")["subtitles"]
                http("POST", f"/jobs/{row['job']}/render",
                     json.dumps({"subtitles": subs,
                                 "disabled_cuts": []}).encode(),
                     {"Content-Type": "application/json"})
                t1 = time.time()
                j = wait(row["job"], {"done"}, 3600)
                row["re"] = time.time() - t1
                row["status"] = "done" if j["status"] == "done" else \
                    f"render failed: {j.get('error') or j.get('message')}"
                print(f"   analyze {row['an']:.0f}s, render {row['re']:.0f}s "
                      f"→ {row['status']}", flush=True)
            except Exception as e:  # keep going with the next run
                row["status"] = f"failed: {e}"
                print(f"   {row['status']}", flush=True)
            finally:
                video.unlink(missing_ok=True)

    lines = ["| Profil | Länge | Quelle | MB | Job | Status | Upload | Analyse | Render |",
             "|---|---|---|---|---|---|---|---|---|"]
    lines += [f"| {r['profile']} | {r['min']:g} min | {r['info']} | "
              f"{r['mb']:.0f} | `{r['job']}` | {r['status']} | {r['up']:.0f}s | "
              f"{r['an']:.0f}s | {r['re']:.0f}s |" for r in rows]
    if ADMIN:
        costs = http("GET", "/admin/costs", headers={"X-Admin-Token": ADMIN})
        by_job = {r["job_id"]: r for r in costs["rows"]}
        lines += ["", "| Profil | Job | Minuten | Speicher MB | USD gesamt | "
                  "USD/Min | Teile | Dateien MB |",
                  "|---|---|---|---|---|---|---|---|"]
        for r in rows:
            c = by_job.get(r["job"])
            if not c:
                continue
            parts = ", ".join(f"{k[4:]} {v:.4f}" for k, v in c["usd"].items()
                              if k != "usd_total")
            lines.append(
                f"| {r['profile']} | `{r['job']}` | {c['video_minutes']} | "
                f"{c['storage_mb']} | {c['usd_all_in']:.4f} | "
                f"{c['usd_per_video_minute']} | {parts} | "
                f"{json.dumps(c.get('files_mb', {}))} |")
    text = "\n".join(lines)
    print(text)
    if SUMMARY:
        Path(SUMMARY).write_text("## Cost test\n\n" + text + "\n")
    return 0 if all(r["status"] == "done" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
