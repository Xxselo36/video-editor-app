"""End-to-end cost test against the live backend.

Builds talking-head-like test videos (synthetic German speech with
pauses and fillers over a moving test pattern), runs each through
upload → analyze → render exactly like the web app, and reports the
timings. The backend records the costs of these jobs; with the
CLEO_ADMIN_TOKEN secret set, the per-job costs are printed too.

Usage: python cost_test.py 2,10   (video lengths in minutes)
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


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def make_video(minutes: float, work: Path) -> Path:
    """Synthetic speech + pauses, muxed onto a portrait test pattern."""
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
        pause = rnd.choice([0.3, 0.4, 0.6, 1.2, 2.0])  # some cuttable gaps
        p = work / f"p{i}.wav"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i",
             "anullsrc=r=22050:cl=mono", "-t", str(pause), str(p)])
        total += pause
        parts.append(p)
        i += 1
    lst = work / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    audio = work / "speech.wav"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
         "-ar", "44100", "-ac", "1", str(audio)])
    out = work / f"test_{minutes:g}min.mp4"
    run(["ffmpeg", "-y", "-f", "lavfi", "-i",
         "testsrc2=size=1080x1920:rate=30", "-i", str(audio),
         "-shortest", "-c:v", "libx264", "-preset", "veryfast",
         "-b:v", "900k", "-maxrate", "1200k", "-bufsize", "2400k",
         "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)])
    return out


def http(method: str, path: str, data: bytes | None = None,
         headers: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"{}")


def upload(video: Path) -> str:
    settings = json.dumps({
        "caption_preset": "clipper", "style": "balanced",
        "voice_triggers": True, "remove_fillers": True,
        "whisper_model": "medium", "smartcam_enabled": False,
        "resolution": "1080", "output_formats": [],
    })
    out = subprocess.run(
        ["curl", "-sS", "--fail-with-body", "-m", "900",
         "-F", f"file=@{video};type=video/mp4",
         "-F", f"settings={settings}", f"{API}/jobs"],
        check=True, capture_output=True, text=True)
    return json.loads(out.stdout)["job_id"]


def wait(job_id: str, until: set[str], timeout: float) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = http("GET", f"/jobs/{job_id}")
        if j["status"] in until or j["status"] == "error":
            return j
        time.sleep(10)
    raise TimeoutError(f"{job_id} stuck in {j['status']}: {j.get('message')}")


def main() -> int:
    lengths = [float(x) for x in (sys.argv[1] if len(sys.argv) > 1
                                  else "2,10").split(",") if x.strip()]
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for m in lengths:
            video = make_video(m, work)
            size_mb = video.stat().st_size / 1e6
            print(f"== {m:g} min video, {size_mb:.1f} MB", flush=True)
            t0 = time.time()
            job_id = upload(video)
            t_up = time.time() - t0
            print(f"   job {job_id} uploaded in {t_up:.0f}s", flush=True)
            j = wait(job_id, {"awaiting_review"}, 3600)
            t_an = time.time() - t0 - t_up
            if j["status"] == "error":
                print(f"   ANALYZE ERROR: {j.get('message')}", flush=True)
                rows.append((m, job_id, "analyze error", t_up, t_an, 0))
                continue
            subs = http("GET", f"/jobs/{job_id}/subtitles")["subtitles"]
            http("POST", f"/jobs/{job_id}/render",
                 json.dumps({"subtitles": subs, "disabled_cuts": []}).encode(),
                 {"Content-Type": "application/json"})
            t1 = time.time()
            j = wait(job_id, {"done"}, 3600)
            t_re = time.time() - t1
            status = j["status"] if j["status"] == "done" else \
                f"render failed: {j.get('error') or j.get('message')}"
            print(f"   analyze {t_an:.0f}s, render {t_re:.0f}s → {status}",
                  flush=True)
            rows.append((m, job_id, status, t_up, t_an, t_re))

    lines = ["| Video | Job | Status | Upload | Analyse | Render |",
             "|---|---|---|---|---|---|"]
    lines += [f"| {m:g} min | `{jid}` | {st} | {u:.0f}s | {a:.0f}s | {r:.0f}s |"
              for m, jid, st, u, a, r in rows]
    if ADMIN:
        costs = http("GET", "/admin/costs", headers={"X-Admin-Token": ADMIN})
        mine = {jid for _, jid, *_ in rows}
        lines += ["", "| Job | Minuten | Speicher MB | USD gesamt | USD/Min | Teile |",
                  "|---|---|---|---|---|---|"]
        for r in costs["rows"]:
            if r["job_id"] in mine:
                parts = ", ".join(f"{k[4:]} {v:.4f}" for k, v in r["usd"].items()
                                  if k != "usd_total")
                lines.append(f"| `{r['job_id']}` | {r['video_minutes']} | "
                             f"{r['storage_mb']} | {r['usd_all_in']:.4f} | "
                             f"{r['usd_per_video_minute']} | {parts} |")
                lines.append(f"|  files | {json.dumps(r.get('files_mb', {}))} |||||")
    text = "\n".join(lines)
    print(text)
    if SUMMARY:
        Path(SUMMARY).write_text("## Cost test\n\n" + text + "\n")
    return 0 if all(st == "done" for _, _, st, *_ in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
