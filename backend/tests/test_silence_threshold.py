"""The silence threshold (src/audio.py: AudioAnalyzer.detect_silence,
silence_threshold_for).

The styles' thresholds are RMS levels re the file's loudest sample, made
for recordings whose loudest moment is speech. They used to be applied
to that peak as it came: one loud transient (a clap, a door) put all the
speech far under the threshold and cut soft speech - or all of it - as
silence, and broadband noise above the threshold read as speech, so no
pause was found. Now the threshold sits relative to the speech's own
peak (a transient doesn't count) and above the noise floor of the
pauses, and a normal recording cuts exactly as before.

The audio is synthetic, made here: speech-like phrases (a glottal pulse
train through two formant resonators, syllables at varying levels with
stop closures between them), room noise, claps, broadband noise.
"""
from __future__ import annotations

import copy
import subprocess
import wave

import numpy as np
import pytest
from scipy.signal import lfilter

from src import audio
from src.styles import get_style

SR = 16000
STYLES = ("fast", "smooth")


# ── synthetic recordings ─────────────────────────────────────────────

def _phrase(rng, dur: float, f0: float = 110.0, spread_db: float = 12.0) -> np.ndarray:
    """One spoken phrase, unit peak: syllables of 140-260 ms at levels
    0..-spread_db dB, 30-60 ms closures between them."""
    n = int(dur * SR)
    out = np.zeros(n)
    t = 0
    while t < n:
        syl = int(rng.uniform(0.14, 0.26) * SR)
        m = min(syl, n - t)
        v = np.zeros(m)
        v[np.arange(0, m, SR / (f0 * rng.uniform(0.9, 1.1))).astype(int)] = 1.0
        for fc, bw in ((rng.uniform(500, 800), 90), (rng.uniform(1000, 1600), 120)):
            r = np.exp(-np.pi * bw / SR)
            v = lfilter([1.0], [1, -2 * r * np.cos(2 * np.pi * fc / SR), r * r], v)
        env = np.sin(np.pi * np.arange(m) / m) ** 0.6
        out[t:t + m] = v * env * 10 ** (-rng.uniform(0, spread_db) / 20)
        t += syl + int(rng.uniform(0.03, 0.06) * SR)
    return out / np.max(np.abs(out))


def _noise(rng, n: int, kind: str = "white") -> np.ndarray:
    z = rng.standard_normal(n)
    if kind == "pink":   # Paul Kellet's filter
        z = lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786],
                    [1, -2.494956002, 2.017265875, -0.522189400], z)
    return z / np.sqrt(np.mean(z ** 2))


def _recording(phrases, pauses, *, lead=0.7, tail=0.9, noise_db=None,
               noise="white", wander_db=0.0, clap_db=None, spread_db=12.0,
               seed=0):
    """Phrases [(seconds, level dB re the loudest phrase)] with `pauses`
    (s) between them, room noise 65 dB under the speech peak, optional
    broadband noise at `noise_db` RMS re the speech peak (wandering by
    +-wander_db over 4 s), an optional clap at 0.15 s peaking `clap_db`
    over the speech peak. Returns the audio normalised to its peak (as
    get_audio_data does), the phrase spans and the pause spans (s)."""
    rng = np.random.default_rng(seed)
    t = lead
    parts, spans = [], []
    for k, (dur, lvl) in enumerate(phrases):
        spans.append((t, t + dur))
        parts.append((t, _phrase(rng, dur, spread_db=spread_db) * 10 ** (lvl / 20)))
        t += dur + (pauses[k] if k < len(pauses) else 0.0)
    n = int((t + tail) * SR)
    x = np.zeros(n)
    for start, p in parts:
        i = int(start * SR)
        x[i:i + len(p)] += p
    x /= np.max(np.abs(x))
    x += _noise(rng, n, "pink") * 10 ** (-65 / 20)
    if noise_db is not None:
        wander = 10 ** (wander_db * np.sin(2 * np.pi * np.arange(n) / (4 * SR)) / 20)
        x += _noise(rng, n, noise) * wander * 10 ** (noise_db / 20)
    if clap_db is not None:
        i, m = int(0.15 * SR), int(0.06 * SR)
        c = rng.standard_normal(m) * np.exp(-np.arange(m) / (0.008 * SR))
        x[i:i + m] += c / np.max(np.abs(c)) * 10 ** (clap_db / 20)
    gaps = [(spans[k][1], spans[k + 1][0]) for k in range(len(spans) - 1)]
    return x / np.max(np.abs(x)), spans, gaps


def _detect(x, style: str):
    cfg = get_style(style)
    a = audio.AudioAnalyzer("synthetic.mp4")
    a._sample_rate, a._audio_data = SR, x
    segs = a.detect_silence(cfg["silence_threshold"], cfg["min_silence_to_cut"])
    return a, segs


def _silent(segs, a: float, b: float) -> float:
    """Seconds of [a, b) inside detect_silence's silence segments."""
    return sum(max(0.0, min(b, s.end) - max(a, s.start))
               for s in segs if not s.has_speech)


# Seven phrases and the pauses between them (0.2 s: under every style's
# min_silence; 1.5 s: cut by every style).
PHRASES = [(1.6, 0), (1.2, 0), (1.9, 0), (1.4, 0), (1.7, 0), (1.3, 0), (1.5, 0)]
PAUSES = [0.6, 0.2, 1.0, 0.4, 1.5, 0.8]


def _speech_kept(segs, spans, share=0.95):
    return [(a, b, round(_silent(segs, a, b), 2)) for a, b in spans
            if _silent(segs, a, b) > (1 - share) * (b - a)]


def _cut_as_without_clap(segs, segs_without, spans, slack=0.1):
    """No phrase loses more than `slack` s more to silence than in the
    same recording without the clap (the speech's peak is estimated to
    within ~2 dB, so a 100 ms frame or two may flip)."""
    return [(a, b, round(_silent(segs, a, b), 2), round(_silent(segs_without, a, b), 2))
            for a, b in spans if _silent(segs, a, b) > _silent(segs_without, a, b) + slack]


def _pauses_found(segs, gaps, style, slack=0.25):
    """Every pause longer than the style's min_silence (plus slack) is
    found: all of it but `slack` seconds is silence."""
    ms = get_style(style)["min_silence_to_cut"]
    return [(a, b, round(_silent(segs, a, b), 2)) for a, b in gaps
            if b - a >= ms + slack and _silent(segs, a, b) < (b - a) - slack]


# ── a loud transient ─────────────────────────────────────────────────

def _with_and_without_clap(phrases, style, clap_db, seed, **kw):
    x, spans, gaps = _recording(phrases, PAUSES, seed=seed, **kw)
    _a, without = _detect(x, style)
    x, spans, gaps = _recording(phrases, PAUSES, clap_db=clap_db, seed=seed, **kw)
    a, segs = _detect(x, style)
    return a, segs, without, spans, gaps


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("clap_db", [12, 20])
def test_a_loud_transient_does_not_make_soft_speech_silence(style, clap_db):
    """A clap 12 or 20 dB over the speech peak: every phrase is still
    speech (before: the threshold followed the clap and cut the speech -
    at 20 dB all of it), cut as without the clap, and the pauses are
    still found."""
    a, segs, without, spans, gaps = _with_and_without_clap(PHRASES, style, clap_db, 1)
    assert _speech_kept(segs, spans, share=0.9) == [], (a.silence_levels, segs)
    assert _cut_as_without_clap(segs, without, spans) == [], (a.silence_levels, segs)
    assert _pauses_found(segs, gaps, style) == [], (a.silence_levels, segs)


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("clap_db", [12, 20])
def test_a_soft_aside_is_kept(style, clap_db):
    """A quiet aside (6 dB under the other phrases) in a recording with a
    clap 12 or 20 dB over the speech: the aside stays speech (before: cut
    as silence), cut no more than without the clap."""
    phrases = list(PHRASES)
    phrases[3] = (1.4, -6)
    a, segs, without, spans, gaps = _with_and_without_clap(
        phrases, style, clap_db, 2, spread_db=6.0)
    assert _speech_kept(segs, spans) == [], (a.silence_levels, segs)
    assert _cut_as_without_clap(segs, without, spans) == [], (a.silence_levels, segs)
    assert _pauses_found(segs, gaps, style) == [], (a.silence_levels, segs)


# ── noise ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("case", ["steady", "with_clap", "sparse_wandering"])
def test_noise_at_minus_40_db_is_still_silence(style, case):
    """Broadband noise 40 dB under the speech peak stays silence: steady
    noise; the same with a clap 20 dB over the speech (the threshold moves
    down by ~20 dB, but not into the noise); and noise that wanders by
    +-3 dB in a recording that is 95 % pause (a 95th percentile over all
    frames would sit in that noise and pull the threshold into it)."""
    if case == "sparse_wandering":
        x, spans, gaps = _recording([(1.5, 0), (1.2, 0)], [1.0], lead=25.0,
                                    tail=25.0, noise_db=-40, noise="pink",
                                    wander_db=3.0, seed=3)
        gaps = [(0.5, spans[0][0] - 0.5)] + gaps + [(spans[-1][1] + 0.5, len(x) / SR - 0.2)]
        a, segs = _detect(x, style)
        assert _speech_kept(segs, spans) == [], (a.silence_levels, segs)
    elif case == "with_clap":
        a, segs, without, spans, gaps = _with_and_without_clap(
            PHRASES, style, 20, 4, noise_db=-40)
        assert _speech_kept(segs, spans, share=0.9) == [], (a.silence_levels, segs)
        assert _cut_as_without_clap(segs, without, spans) == [], (a.silence_levels, segs)
    else:
        x, spans, gaps = _recording(PHRASES, PAUSES, noise_db=-40, seed=4)
        a, segs = _detect(x, style)
        assert _speech_kept(segs, spans) == [], (a.silence_levels, segs)
    assert _pauses_found(segs, gaps, style) == [], (a.silence_levels, segs)


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("noise_db", [-28, -32])
def test_noise_above_the_threshold_no_longer_reads_as_speech(style, noise_db):
    """White noise 28 or 32 dB under the speech peak - at or above the
    style threshold (-30.5 dB for fast, -34 dB for smooth). Before, the
    noise read as speech and not one pause was found; now the threshold
    sits 4 dB over the noise floor: the pauses are found and the speech
    (well over the noise) is kept."""
    x, spans, gaps = _recording(PHRASES, PAUSES, noise_db=noise_db, spread_db=8.0, seed=5)
    a, segs = _detect(x, style)
    assert _pauses_found(segs, gaps, style) == [], (a.silence_levels, segs)
    assert _speech_kept(segs, spans, share=0.9) == [], (a.silence_levels, segs)


@pytest.mark.parametrize("style", STYLES)
def test_speech_without_pauses_keeps_the_style_threshold(style):
    """Speech with no pause of 0.3 s (phrases 50 ms apart, compressed:
    syllables within 3 dB): its quietest frames are dips between words,
    not a noise floor, so the threshold must not be raised over them."""
    phrases = [(2.0, 0)] * 8
    x, spans, _gaps = _recording(phrases, [0.05] * 7, lead=0.05, tail=0.05,
                                 spread_db=3.0, seed=6)
    a, segs = _detect(x, style)
    assert a.silence_threshold_used == get_style(style)["silence_threshold"]
    assert _speech_kept(segs, spans, share=0.99) == [], segs


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("case", ["noise_and_clicks", "digital_silence_and_a_clap"])
def test_without_speech_the_threshold_does_not_move_down(style, case):
    """No speech: steady noise with single-sample clicks, or digital
    silence around one clap. Nothing held for 0.2 s stands clear of the
    floor, so there is no speech peak to move the threshold to: it stays
    where the style puts it and cuts as the old rule did (the clicks
    don't turn into speech, the clap's tail doesn't either)."""
    rng = np.random.default_rng(12)
    n = 20 * SR
    if case == "noise_and_clicks":
        x = _noise(rng, n, "pink") * 10 ** (-40 / 20)
        x[np.arange(SR // 2, n, int(1.3 * SR))] = 1.0
    else:
        x = np.zeros(n)
        i, m = 3 * SR, int(0.06 * SR)
        x[i:i + m] = rng.standard_normal(m) * np.exp(-np.arange(m) / (0.008 * SR))
    x /= np.max(np.abs(x))
    a, segs = _detect(x, style)
    cfg = get_style(style)
    assert a.silence_threshold_used >= cfg["silence_threshold"], a.silence_levels
    assert [(s.start, s.end, bool(s.has_speech)) for s in segs] == \
        _detect_as_before(x, cfg["silence_threshold"], cfg["min_silence_to_cut"])


# ── the normal case ──────────────────────────────────────────────────

def _detect_as_before(x, threshold, min_silence):
    """detect_silence as it was: the style threshold re the peak, as is."""
    window = int(SR * 0.1)
    hop = window // 2
    segs, cur, start = [], None, 0
    for i in range(0, len(x) - window, hop):
        is_speech = np.sqrt(np.mean(x[i:i + window] ** 2)) > threshold
        t = i / SR
        if cur is None:
            cur, start = is_speech, t
        elif is_speech != cur:
            if t - start >= min_silence or cur:
                segs.append((start, t, bool(cur)))
            start, cur = t, is_speech
    if start < len(x) / SR:
        segs.append((start, len(x) / SR, bool(cur)))
    return segs


@pytest.mark.parametrize("seed", [7, 8, 9])
@pytest.mark.parametrize("noise_db", [None, -48, -40])
def test_clean_speech_cuts_exactly_as_before(seed, noise_db):
    """A recording whose peak is speech and whose noise sits well under
    the threshold: every style threshold and min_silence give exactly
    the segments of the old rule (threshold re peak, unchanged)."""
    rng = np.random.default_rng(seed)
    phrases = [(float(rng.uniform(0.8, 2.2)), float(rng.uniform(-4, 0))) for _ in range(8)]
    pauses = [float(p) for p in rng.choice([0.2, 0.35, 0.5, 0.7, 1.0, 1.6], 7)]
    x, _spans, _gaps = _recording(phrases, pauses, noise_db=noise_db, seed=seed)
    for threshold in (0.02, 0.025, 0.03, 0.035):
        for min_silence in (0.3, 0.5, 0.9):
            a = audio.AudioAnalyzer("synthetic.mp4")
            a._sample_rate, a._audio_data = SR, x
            segs = a.detect_silence(threshold, min_silence)
            assert [(s.start, s.end, bool(s.has_speech)) for s in segs] == \
                _detect_as_before(x, threshold, min_silence), (threshold, min_silence)
            assert a.silence_threshold_used == threshold


# ── the rule itself ──────────────────────────────────────────────────

def test_the_threshold_follows_the_speech_peak_without_jumps():
    """Frames (RMS, peak re the file's peak) of 15 s of pause, 35 s of
    speech whose loudest sample lies `drop` dB under the file's peak, and
    a two-frame clap at that peak, for drop from -6 to 12 dB: up to
    PEAK_TOLERANCE_DB nothing moves; from twice that the threshold moves
    dB for dB; in between it ramps - never a jump, never up."""
    def db(v):
        return 20 * np.log10(v)
    drops = np.arange(-6.0, 12.01, 0.05)
    used = []
    for drop in drops:
        # every speech frame holds the same peak: its level is exactly
        # the speech's peak as estimated (held for 3 frames, + the gap)
        held = 10 ** ((-drop - audio.SPEECH_PEAK_GAP_DB) / 20)
        rms = np.concatenate([np.full(300, 10 ** (-65 / 20)), np.full(700, held / 4), [0.3, 0.3]])
        peak = np.concatenate([np.full(300, 10 ** (-55 / 20)), np.full(700, held), [1.0, 1.0]])
        used.append(db(audio.silence_threshold_for(rms, peak, 0.03)[0]) - db(0.03))
    used = np.array(used)
    assert np.all(used[drops <= audio.PEAK_TOLERANCE_DB] == 0.0)
    full = drops >= 2 * audio.PEAK_TOLERANCE_DB
    assert np.allclose(used[full], -drops[full], atol=1e-9)      # dB for dB
    assert np.all(np.diff(used) <= 1e-9)            # never up as the speech drops
    assert np.max(np.abs(np.diff(used))) < 0.11     # no jumps (0.05 dB steps)


def test_no_usable_frames_keep_the_style_threshold():
    for frames in ([], [0.0, 0.0, 0.0], [np.nan, np.nan]):
        f = np.array(frames)
        assert audio.silence_threshold_for(f, f, 0.03) == (0.03, {})


# ── the whole analysis ───────────────────────────────────────────────

WORDS = [("today", 0.8, 1.2), ("we", 1.24, 1.4), ("test", 1.44, 1.8), ("the", 1.84, 2.0),
         ("camera", 2.04, 2.6), ("then", 3.6, 3.9), ("I", 3.94, 4.1), ("open", 4.14, 4.5),
         ("the", 4.54, 4.7), ("menu", 4.74, 5.2), ("it", 6.4, 6.6), ("looks", 6.64, 7.0),
         ("bright", 7.04, 7.5)]


def _kept(segs, s: float, e: float) -> float:
    """Seconds of [s, e) inside the kept segments."""
    return sum(max(0.0, min(e, b) - max(s, a)) for a, b in segs)


def _clip(path, clap: bool) -> None:
    """A quiet talking-head clip (low gain): a voiced burst per word
    peaking at -30 dBFS over room noise 45 dB under it, a clap at 0.15 s
    near full scale (or none); black 64x64 video."""
    sr = 22050
    rng = np.random.default_rng(11)
    dur = WORDS[-1][2] + 1.0
    n = int(dur * sr)
    speech = np.zeros(n)
    t = np.arange(n) / sr
    for k, (_w, s, e) in enumerate(WORDS):
        i0, i1 = int(s * sr), int(e * sr)
        f0 = 115 + 10 * (k % 4)
        voice = sum(np.sin(2 * np.pi * f0 * h * t[i0:i1]) / h for h in range(1, 8))
        env = np.ones(i1 - i0)
        r = int(0.008 * sr)
        env[:r], env[-r:] = np.linspace(0, 1, r), np.linspace(1, 0, r)
        speech[i0:i1] += voice * env
    a = speech * 10 ** (-30 / 20) / np.max(np.abs(speech))
    a += rng.normal(0, 10 ** (-75 / 20), n)
    if clap:
        i, m = int(0.15 * sr), int(0.06 * sr)
        c = rng.standard_normal(m) * np.exp(-np.arange(m) / (0.008 * sr))
        a[i:i + m] += c / np.max(np.abs(c)) * 0.9
    wav = path.with_suffix(".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
    from backend import pipeline
    subprocess.run([pipeline.get_ffmpeg_path(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={dur}",
                    "-i", str(wav), "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", str(path)], check=True)


@pytest.mark.parametrize("style", STYLES)
def test_a_clap_before_quiet_speech_cuts_no_word(tmp_path, monkeypatch, style):
    """The real analysis (src.plugin_api.analyze_video, only Whisper
    mocked with the true word times) on quiet speech (-30 dBFS) after a
    clap near full scale: every word comes out whole, as without the
    clap. Before, the clap set the threshold and the analysis kept
    nothing."""
    from src import plugin_api
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    tr = {"language": "en", "segments": [
        {"start": seg[0][1], "end": seg[-1][2], "text": " ".join(w for w, _s, _e in seg),
         "words": [{"word": " " + w, "start": s, "end": e, "probability": 0.9}
                   for w, s, e in seg]}
        for seg in (WORDS[:5], WORDS[5:10], WORDS[10:])]}

    def transcribe(self):
        self._transcription = copy.deepcopy(tr)
        self._build_subtitles_from_transcription()
        return self._subtitles
    monkeypatch.setattr(audio.AudioAnalyzer, "transcribe", transcribe)
    for clap in (False, True):
        clip = tmp_path / f"clap{int(clap)}.mp4"
        _clip(clip, clap)
        res = plugin_api.analyze_video(str(clip), style=style)
        segs = [(float(s), float(e)) for s, e in res.segments]
        lost = [(w, s, e, round(e - s - _kept(segs, s, e), 3)) for w, s, e in WORDS
                if (e - s) - _kept(segs, s, e) > 0.012]
        assert lost == [], (clap, segs)
