"""Where the analysis' text-made cuts end (owner report S5: words cut
oddly — '…eep' after "Cleo keep", a clipped onset after "Cleo go", the
word before a filler losing its tail).

Real Whisper words touch and drift by about 100 ms, so cuts on their
times clip words; src/edge_snap.py puts every edge of a filler, stutter,
gap, loop and command cut on the audio. Unit tests of the snap, then the
real src.plugin_api.analyze_video on two synthetic recordings: the
Whisper words are faster-whisper's own output for espeak recordings of
these scripts (rec2: German, rec1b: English), the audio is rebuilt from
the recordings' true word extents (each word a voiced burst with a
30-40 ms stop closure inside, room noise between), and every word must
come out whole: kept words keep their full sound, cut words leave
nothing audible.
"""
from __future__ import annotations

import copy
import subprocess
import wave

import numpy as np
import pytest

from src import edge_snap

FPS = edge_snap.RATE


# ── the snap ─────────────────────────────────────────────────────────

def _env(spans: list[tuple[float, float]], dur: float, closure: bool = True):
    """dB per 10 ms frame: -20 inside `spans` (a 40 ms -60 closure at 60 %
    of each span longer than 0.25 s), -60 elsewhere."""
    env = np.full(int(dur * FPS), -60.0)
    for s, e in spans:
        env[int(round(s * FPS)):int(round(e * FPS))] = -20.0
        if closure and e - s > 0.25:
            c = int(round((s + 0.6 * (e - s)) * FPS))
            env[c:c + 4] = -60.0
    return env


def _w(s, e):
    return {"start": s, "end": e}


def test_edges_go_to_the_gap_between_the_words():
    # Whisper: keep 8.50-8.74, next word 9.16; the keep really sounds
    # until 8.90 (rec2's timings). The removal [8.12, 8.74] ends in the
    # pause after the keep, not in it (and not in its closure).
    env = _env([(7.18, 7.59), (8.09, 8.48), (8.52, 8.90), (9.15, 9.65)], 12)
    words = [_w(7.06, 7.5), _w(8.12, 8.5), _w(8.5, 8.74), _w(9.16, 9.62)]
    a, b = edge_snap.snap_removals([(8.12, 8.74)], words, env,
                                   edge_snap.WINDOW_COMMAND_S)[0]
    assert 7.59 <= a <= 8.09
    assert 8.90 <= b <= 9.15


def test_flat_audio_or_no_audio_leaves_the_edges():
    words = [_w(1.0, 1.5), _w(2.0, 2.5)]
    flat = np.full(500, -60.0)
    assert edge_snap.snap_removals([(1.6, 1.9)], words, flat) == [(1.6, 1.9)]
    assert edge_snap.snap_removals([(1.6, 1.9)], words, None) == [(1.6, 1.9)]


def test_an_edge_never_passes_a_neighbours_middle():
    # Touching words, the quiet spot far inside the kept word: the edge
    # stops at its middle at most (here: stays, as the audio there is
    # not quieter).
    env = _env([(0.0, 1.0), (1.0, 1.4)], 3, closure=False)
    env[40:44] = -60.0                      # a dip at 0.40-0.44 (kept word)
    words = [_w(0.0, 1.0), _w(1.0, 1.4)]
    a, b = edge_snap.snap_removals([(1.0, 1.4)], words, env, 0.25)[0]
    assert a >= 0.5


def test_the_recording_ends_stay():
    env = _env([(0.0, 0.5), (0.9, 2.0)], 2.0)
    words = [_w(0.0, 0.4), _w(1.0, 2.0)]
    assert edge_snap.snap_removals([(0.0, 0.45), (1.2, 2.0)], words, env,
                                   duration=2.0)[1][1] == 2.0
    assert edge_snap.snap_removals([(0.0, 0.45)], words, env)[0][0] == 0.0


def test_merge_touching():
    assert edge_snap.merge_touching([(3, 4), (0, 1), (1, 2)]) == [(0, 2), (3, 4)]


# ── the real analysis on two recordings ─────────────────────────────

# Whisper's words (per segment) and the true word extents.
REC2_WHISPER = [
    [("Okay,", 0.0, 0.88), ("das", 1.04, 1.18), ("ist", 1.18, 1.5), ("nur", 1.5, 1.88), ("der", 1.88, 2.16), ("Anfang.", 2.16, 2.52), ("Cleo", 3.78, 3.96), ("start.", 3.96, 4.26)],
    [("Heute", 5.26, 5.58), ("zeige", 5.58, 6.08), ("ich", 6.08, 6.38), ("euch", 6.38, 6.62), ("drei", 6.62, 7.06), ("Ticks.", 7.06, 7.5), ("Cleo", 8.12, 8.5), ("keep.", 8.5, 8.74)],
    [("Sofort", 9.16, 9.62), ("danach", 9.62, 9.98), ("kommt", 9.98, 10.34), ("der", 10.34, 10.64), ("zweite", 10.64, 10.9), ("Teil.", 10.9, 11.5), ("Cleo", 11.84, 12.1), ("keep.", 12.1, 12.38), ("Fisch", 12.64, 12.86), ("ist", 12.86, 13.12), ("gesund.", 13.12, 13.5)],
    [("Ich", 14.38, 14.64), ("mache", 14.64, 14.9), ("das", 14.9, 15.26), ("jetzt", 15.26, 15.6), ("nochmal.", 15.6, 16.08), ("Cleo", 16.54, 16.86), ("cut.", 16.86, 17.1), ("Ich", 17.36, 17.54), ("mache", 17.54, 17.84), ("das", 17.84, 18.16), ("jetzt", 18.16, 18.54), ("richtig.", 18.54, 19.1)],
    [("Cleo", 19.84, 20.38), ("keep.", 20.38, 20.68), ("Das", 21.52, 21.8), ("war", 21.8, 22.18), ("es", 22.18, 22.54), ("schon.", 22.54, 22.88), ("Cleo", 23.64, 24.12), ("stop.", 24.12, 24.42)],
    [("Falsch,", 24.42, 25.64), ("falsch.", 25.72, 26.38), ("Cleo,", 26.68, 27.04), ("go,", 27.12, 27.32), ("ja.", 27.54, 27.78), ("Und", 28.54, 28.9), ("tschüss.", 28.9, 29.24), ("Cleo,", 29.76, 30.28), ("finish.", 30.38, 30.56)],
]
REC2_TRUTH = [("okay", 0.6, 0.984), ("das", 1.024, 1.264), ("ist", 1.304, 1.568), ("nur", 1.608, 1.957), ("der", 1.997, 2.212), ("anfang", 2.252, 2.686), ("cleo", 3.586, 3.975), ("start", 4.015, 4.479), ("heute", 5.279, 5.698), ("zeige", 5.738, 6.162), ("ich", 6.202, 6.421), ("euch", 6.461, 6.756), ("drei", 6.796, 7.14), ("tricks", 7.18, 7.594), ("cleo", 8.094, 8.483), ("keep", 8.523, 8.902), ("sofort", 9.152, 9.646), ("danach", 9.686, 10.025), ("kommt", 10.065, 10.419), ("der", 10.46, 10.674), ("zweite", 10.714, 11.228), ("teil", 11.268, 11.637), ("cleo", 11.697, 12.086), ("keep", 12.126, 12.505), ("fisch", 12.565, 12.88), ("ist", 12.919, 13.184), ("gesund", 13.224, 13.643), ("ich", 14.443, 14.662), ("mache", 14.703, 15.047), ("das", 15.087, 15.326), ("jetzt", 15.366, 15.795), ("nochmal", 15.835, 16.304), ("cleo", 16.454, 16.843), ("cut", 16.883, 17.207), ("ich", 17.358, 17.577), ("mache", 17.617, 17.961), ("das", 18.001, 18.241), ("jetzt", 18.281, 18.71), ("richtig", 18.75, 19.189), ("cleo", 19.989, 20.378), ("keep", 20.418, 20.797), ("das", 21.597, 21.837), ("war", 21.877, 22.291), ("es", 22.331, 22.565), ("schon", 22.605, 23.024), ("cleo", 23.724, 24.113), ("stop", 24.153, 24.602), ("falsch", 25.202, 25.606), ("falsch", 25.646, 26.05), ("cleo", 26.65, 27.039), ("go", 27.079, 27.409), ("ja", 27.509, 27.868), ("und", 28.668, 28.962), ("tschüss", 29.002, 29.267), ("cleo", 29.867, 30.256), ("finish", 30.296, 30.725)]

REC1B_WHISPER = [
    [("Okay,", 0.0, 0.86), ("this", 1.06, 1.42), ("is", 1.42, 1.82), ("the", 1.82, 2.14), ("setup", 2.14, 2.5), ("part.", 2.5, 3.06), ("Cleo", 3.92, 4.4), ("start.", 4.4, 4.74), ("Today", 5.76, 6.06), ("I", 6.06, 6.56), ("show", 6.56, 6.96), ("you", 6.96, 7.34), ("three", 7.34, 7.72), ("tricks", 7.72, 8.24), ("for", 8.24, 8.74), ("better", 8.74, 9.12), ("videos.", 9.12, 9.72), ("Cleo", 10.3, 10.72)],
    [("keep.", 10.72, 10.98), ("The", 11.76, 12.18), ("first", 12.18, 12.6), ("trick", 12.6, 12.98), ("is", 12.98, 13.42), ("simple", 13.42, 13.88), ("Cleo", 13.88, 14.46), ("keep.", 14.46, 14.72), ("Next", 14.92, 15.3), ("we", 15.3, 15.68), ("talk", 15.68, 16.06), ("about", 16.06, 16.56), ("the", 16.56, 17.0), ("light.", 17.0, 17.32), ("I", 18.24, 18.6), ("really", 18.6, 19.0), ("love", 19.0, 19.48)],
    [("fresh", 19.48, 19.82), ("fish.", 19.82, 20.36), ("Cleo", 20.96, 21.5), ("stop.", 21.5, 21.78), ("This", 22.66, 23.04), ("part", 23.04, 23.38), ("was", 23.38, 23.8), ("wrong.", 23.8, 24.36), ("Cleo", 25.14, 25.58), ("go,", 25.58, 25.86), ("yes.", 26.08, 26.32), ("Soft", 27.24, 27.68), ("light", 27.68, 28.08), ("matters", 28.08, 28.68), ("most.", 28.68, 29.12), ("Cleo", 29.98, 30.56)],
    [("keep.", 30.56, 30.8), ("We", 31.8, 32.14), ("um", 32.14, 32.54), ("use", 32.54, 32.86), ("a", 32.86, 33.28), ("big", 33.28, 33.58), ("window.", 33.58, 34.12), ("Cleo", 34.86, 35.52), ("keep.", 35.52, 35.8), ("This", 36.76, 37.18), ("take", 37.18, 37.5), ("is", 37.5, 37.92), ("bad,", 37.92, 38.28), ("Cleo", 38.58, 38.94), ("cut.", 38.94, 39.22), ("This", 39.5, 39.76), ("take", 39.76, 40.16), ("is", 40.16, 40.56), ("good.", 40.56, 40.82), ("Thanks", 41.72, 42.26)],
    [("for", 42.26, 42.76), ("watching.", 42.76, 43.32), ("Cleo", 44.02, 44.54), ("finish.", 44.54, 44.86), ("Bye", 45.6, 45.98), ("bye.", 45.98, 46.24)],
]
REC1B_TRUTH = [("okay", 0.6, 1.054), ("this", 1.094, 1.468), ("is", 1.508, 1.842), ("the", 1.882, 2.152), ("setup", 2.192, 2.691), ("part", 2.731, 3.115), ("cleo", 4.015, 4.404), ("start", 4.444, 4.908), ("today", 5.808, 6.287), ("i", 6.327, 6.631), ("show", 6.671, 7.08), ("you", 7.12, 7.454), ("three", 7.494, 7.848), ("tricks", 7.888, 8.367), ("for", 8.407, 8.802), ("better", 8.841, 9.221), ("videos", 9.261, 9.819), ("cleo", 10.319, 10.709), ("keep", 10.748, 11.128), ("the", 11.928, 12.197), ("first", 12.237, 12.671), ("trick", 12.711, 13.085), ("is", 13.125, 13.46), ("simple", 13.499, 13.998), ("cleo", 14.058, 14.447), ("keep", 14.487, 14.867), ("next", 14.927, 15.415), ("we", 15.456, 15.8), ("talk", 15.84, 16.189), ("about", 16.229, 16.708), ("the", 16.748, 17.017), ("light", 17.057, 17.441), ("i", 18.341, 18.646), ("really", 18.686, 19.095), ("love", 19.135, 19.539), ("fresh", 19.579, 19.998), ("fish", 20.038, 20.412), ("cleo", 21.112, 21.501), ("stop", 21.541, 21.99), ("this", 22.69, 23.064), ("part", 23.104, 23.488), ("was", 23.528, 23.962), ("wrong", 24.002, 24.486), ("cleo", 25.186, 25.575), ("go", 25.615, 25.945), ("yes", 26.025, 26.434), ("soft", 27.334, 27.788), ("light", 27.828, 28.212), ("matters", 28.252, 28.761), ("most", 28.801, 29.245), ("cleo", 30.145, 30.534), ("keep", 30.574, 30.953), ("we", 31.853, 32.197), ("um", 32.237, 32.576), ("use", 32.616, 32.975), ("a", 33.016, 33.31), ("big", 33.35, 33.709), ("window", 33.749, 34.233), ("cleo", 35.133, 35.522), ("keep", 35.562, 35.941), ("this", 36.841, 37.215), ("take", 37.255, 37.605), ("is", 37.645, 37.979), ("bad", 38.019, 38.403), ("cleo", 38.553, 38.942), ("cut", 38.982, 39.306), ("this", 39.456, 39.831), ("take", 39.87, 40.22), ("is", 40.26, 40.594), ("good", 40.634, 40.928), ("thanks", 41.828, 42.422), ("for", 42.462, 42.856), ("watching", 42.896, 43.435), ("cleo", 44.135, 44.524), ("finish", 44.564, 44.993), ("bye", 45.693, 46.052), ("bye", 46.092, 46.451)]

SR = 22050


def _intent(truth: list[tuple]) -> list[bool]:
    """Which words the script means to cut: every command, the setup
    before "Cleo start", the take a "Cleo cut" throws away (back to the
    last keep / go), "Cleo stop" … "go", the "um", all after finish."""
    texts = [t[0] for t in truth]
    cut = [False] * len(texts)
    stopped = False
    i = 0
    while i < len(texts):
        nxt = texts[i + 1] if i + 1 < len(texts) else ""
        if texts[i] == "cleo":
            cut[i] = cut[i + 1] = True
            if nxt == "start":
                cut[:i] = [True] * i
            elif nxt == "stop":
                stopped = True
            elif nxt == "go":
                stopped = False
            elif nxt == "cut":
                k = i - 1
                while k >= 0 and texts[k] not in ("keep", "go"):
                    cut[k] = True
                    k -= 1
            elif nxt == "finish":
                cut[i:] = [True] * (len(texts) - i)
            i += 2
            continue
        cut[i] = cut[i] or stopped or texts[i] == "um"
        i += 1
    return cut


def _recording(path, truth: list[tuple], dur: float) -> None:
    """A talking-head clip whose audio has a voiced burst at each true
    word extent (8 ms attack / release, a 35 ms closure at 60 % of words
    over 0.25 s) over -60 dBFS room noise; black 64x64 video at 30 fps."""
    rng = np.random.default_rng(7)
    n = int(dur * SR)
    a = rng.normal(0, 0.001, n)
    t = np.arange(n) / SR
    for k, (_txt, s, e) in enumerate(truth):
        i0, i1 = int(s * SR), int(e * SR)
        seg = t[i0:i1]
        f0 = 120 + 15 * (k % 5)
        voice = sum(np.sin(2 * np.pi * f0 * h * seg) / h for h in range(1, 8))
        env = np.ones(i1 - i0)
        ramp = int(0.008 * SR)
        env[:ramp] = np.linspace(0, 1, ramp)
        env[-ramp:] = np.linspace(1, 0, ramp)
        if e - s > 0.25:
            c0 = int((0.6 * (e - s)) * SR)
            env[c0:c0 + int(0.035 * SR)] = 0.0
        a[i0:i1] += 0.25 * voice * env
    wav = path.with_suffix(".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
    from backend import pipeline
    subprocess.run([pipeline.get_ffmpeg_path(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={dur}",
                    "-i", str(wav), "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", str(path)], check=True)


def _analyse(tmp_path, monkeypatch, whisper, truth, style, language):
    from src import audio as A
    from src import plugin_api
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    dur = truth[-1][2] + 1.5
    clip = tmp_path / "rec.mp4"
    _recording(clip, truth, dur)
    tr = {"language": language, "segments": [
        {"start": seg[0][1], "end": seg[-1][2],
         "text": " ".join(w for w, _s, _e in seg),
         "words": [{"word": " " + w, "start": s, "end": e, "probability": 0.9}
                   for (w, s, e) in seg]} for seg in whisper]}

    def transcribe(self):
        self._transcription = copy.deepcopy(tr)
        self._build_subtitles_from_transcription()
        return self._subtitles
    monkeypatch.setattr(A.AudioAnalyzer, "transcribe", transcribe)
    res = plugin_api.analyze_video(str(clip), style=style, voice_triggers=True)
    return [(float(s), float(e)) for s, e in res.segments]


def _defects(segs, truth) -> list[str]:
    def kept(s, e):
        return sum(max(0.0, min(e, b) - max(s, a)) for a, b in segs)
    out = []
    for (text, s, e), cut in zip(truth, _intent(truth)):
        k = kept(s, e)
        if cut and k > 0.015:
            out.append(f"cut word {text!r} {s}-{e}: {k * 1000:.0f} ms audible")
        if not cut and (e - s) - k > 0.012:
            out.append(f"kept word {text!r} {s}-{e}: {((e - s) - k) * 1000:.0f} ms lost")
    return out


@pytest.mark.parametrize("rec", ["rec2", "rec1b"])
@pytest.mark.parametrize("style", ["fast", "smooth"])
def test_every_word_comes_out_whole(tmp_path, monkeypatch, rec, style):
    whisper, truth, lang = {"rec2": (REC2_WHISPER, REC2_TRUTH, "de"),
                            "rec1b": (REC1B_WHISPER, REC1B_TRUTH, "en")}[rec]
    segs = _analyse(tmp_path, monkeypatch, whisper, truth, style, lang)
    assert _defects(segs, truth) == [], segs
