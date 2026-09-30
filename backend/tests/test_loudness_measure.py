"""Loudness measurement pass (UT3, review D10): one loudnorm analysis of
the mezz audio → job.audio_loudness {I, TP, LRA, thresh, offset}."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from backend import audio_analysis as aa


def _audio(path: Path, expr: str, seconds: float) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{expr}':s=48000:d={seconds}", "-c:a", "pcm_s16le",
                    str(path)], check=True)
    return path


def test_sine_level(tmp_path):
    # 1 kHz sine, peak 0.1 (-20 dBFS): about -23 LUFS (-3 dB for a sine's
    # RMS, +0.7 dB of K-weighting at 1 kHz), true peak -20 dBTP
    src = _audio(tmp_path / "s.wav", "0.1*sin(2*PI*1000*t)", 6)
    m = aa.measure_loudness(str(src))
    assert set(m) == {"I", "TP", "LRA", "thresh", "offset"}
    assert m["I"] == pytest.approx(-22.4, abs=1.0)
    assert m["TP"] == pytest.approx(-20.0, abs=0.5)
    assert m["LRA"] == pytest.approx(0.0, abs=1.0)
    assert m["thresh"] < m["I"]


def test_quieter_source_measures_lower(tmp_path):
    loud = aa.measure_loudness(str(_audio(tmp_path / "a.wav", "0.2*sin(2*PI*500*t)", 4)))
    quiet = aa.measure_loudness(str(_audio(tmp_path / "b.wav", "0.02*sin(2*PI*500*t)", 4)))
    assert loud["I"] - quiet["I"] == pytest.approx(20.0, abs=0.5)


def test_silence_has_no_level(tmp_path):
    m = aa.measure_loudness(str(_audio(tmp_path / "z.wav", "0", 3)))
    assert m is not None and m["I"] is None


def test_parse_report():
    stderr = """[Parsed_loudnorm_0 @ 0x55] \n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-4.47",
\t"input_lra" : "18.06",\n\t"input_thresh" : "-39.20",\n\t"output_i" : "-16.58",
\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.58"\n}\n"""
    assert aa.parse_loudnorm(stderr) == {"I": -27.61, "TP": -4.47, "LRA": 18.06,
                                         "thresh": -39.2, "offset": 0.58}
    assert aa.parse_loudnorm("no report here") is None
