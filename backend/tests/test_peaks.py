"""Peaks envelope (peaks.bin) and cut-edge snapping (UT3, review C10):
backend/audio_analysis.py against generated audio and the shared
testdata/snap_vectors.json (the web's state/snap.ts runs the same)."""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import pytest

from backend import audio_analysis as aa

FF = "ffmpeg"
VECTORS = json.loads((Path(__file__).resolve().parents[2] / "testdata"
                      / "snap_vectors.json").read_text())


def _wav(path: Path, expr: str, seconds: float, rate: int = 48000) -> Path:
    """Mono audio from an aevalsrc expression (in an .m4a, like a mezz)."""
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{expr}':s={rate}:d={seconds}", "-c:a", "aac",
                    "-b:a", "192k", str(path)], check=True)
    return path


@pytest.mark.parametrize("v", VECTORS["vectors"], ids=[v["name"] for v in VECTORS["vectors"]])
def test_snap_vectors(v):
    got = aa.snap_edge(v["t"], v["peaks"], window=v.get("window", VECTORS["window"]),
                       rate=VECTORS["rate"])
    assert got == pytest.approx(v["expected"], abs=1e-9)


def test_snap_result_is_a_local_minimum_in_reach():
    peaks = [(i * 7919) % 97 for i in range(500)]
    for k in range(200):
        t = k * 0.0237
        s = aa.snap_edge(t, peaks)
        assert abs(s - t) <= 0.12 + 1e-9
        i = int(s * 100)
        reach = [j for j in range(len(peaks)) if abs((j + 0.5) / 100 - t) <= 0.12 + 1e-9]
        assert peaks[i] == min(peaks[j] for j in reach)


def test_encoding_scale():
    vals = list(aa.encode_frame_rms([0.0, 1e-6, 10 ** (-48 / 20), 1.0, 2.0]))
    assert vals == [0, 0, 64, 127, 127]


def test_envelope_of_tone_and_silence(tmp_path):
    # 1 s silence, 1 s tone at amplitude 0.5, 0.5 s silence
    src = _wav(tmp_path / "a.m4a",
               "if(between(t,1,2),0.5*sin(2*PI*1000*t),0)", 2.5)
    blob = aa.compute_peaks(str(src))
    assert blob is not None
    v = aa.decode_peaks(blob)
    assert abs(len(v) - 250) <= 3            # 100 Hz (AAC priming may add a frame or two)
    assert max(v[:90]) == 0 and max(v[215:]) == 0
    # sine RMS = 0.5/sqrt(2) → -9.03 dBFS → 127·(96-9.03)/96 = 115
    tone = v[110:190]
    assert min(tone) >= 113 and max(tone) <= 117
    # snapping a cut edge placed just inside the tone moves it into the silence
    assert aa.snap_edge(1.05, v) < 1.0
    assert aa.snap_edge(1.97, v) > 2.0


def test_no_audio_stream(tmp_path):
    src = tmp_path / "v.mp4"
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x64:d=1",
                    "-c:v", "libx264", "-preset", "ultrafast", str(src)], check=True)
    assert aa.analyze_audio(str(src)) == (None, None)


def test_write_peaks(tmp_path):
    src = _wav(tmp_path / "a.m4a", "0.25*sin(2*PI*440*t)", 1.0)
    out = tmp_path / "peaks.bin"
    loud, ok = aa.write_peaks(str(src), str(out))
    assert ok and out.stat().st_size in range(99, 104)
    assert loud is not None and math.isfinite(loud["I"])
