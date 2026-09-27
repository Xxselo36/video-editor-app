"""Sustained-vowel (filled-pause) detection inside Whisper word spans.

What
----
Finds German/English filled pauses ("äääh", "ööh", "uhhh") that Whisper did
NOT transcribe, and returns time ranges to cut. Pure function, numpy/scipy
only, no model and no network:

    cuts = detect_sustained_vowels(sample_rate, audio, transcription,
                                   silence_ranges=silences)

Why
---
Whisper (Groq whisper-large-v3 as well as local faster-whisper) regularly
swallows a filled pause and instead stretches the timestamps of the
neighbouring word over it: 'gut' becomes 1.40-2.20 s instead of 1.40-1.80 s
and the next word starts at 2.20 s. There is no filler token in the text and
no gap between the words, so text-based (filler_detection) and gap-based
(word_gap_detection) cleanup can't see it. Acoustically, though, a filled
pause is very distinctive: one vowel held for 0.3-1.5 s with a LEVEL pitch
and an unchanging spectrum, while normal speech changes vowel/consonant
every 60-170 ms.

How
---
1. Candidate words: Whisper bounds trimmed by `silence_ranges`. A word is
   "over-long" if its effective duration >= max(0.55 s, 0.30 s + 0.085 s per
   letter) -- a generous articulation budget, so a normally-timed word is
   never analysed. The analysis window is the effective span, extended up to
   0.25 s into the gap to the previous/next word (never into the neighbour).
2. Only those windows (plus +-3 s context for the loudness reference) are
   resampled to 16 kHz and band-passed 60-4000 Hz.
3. 32 ms frames / 10 ms hop: RMS, voicing (max normalised autocorrelation
   for F0 70-400 Hz), F0, a level-normalised 16-band log spectral envelope
   and its flux (mean |env[k] - env[k-2]| in dB).
4. A frame is "sustained" if voiced, not too quiet, spectrally steady and
   its pitch barely moves (see thresholds below). Glitches of <= 2 frames
   (octave jump, noise spike) are bridged when both sides match.
5. A run of sustained frames >= 0.30 s (0.45 s if the word is phrase-final,
   where speakers naturally lengthen the last vowel) with a level pitch and
   no slow spectral glide, touching the head or tail of the word, and
   leaving enough of the word (incl. some voiced audio) intact, is a
   filled pause.
6. At most one cut per word and ~6 cuts per minute of audio; each cut is
   the run padded by 20 ms, clamped to the analysis window.

Thresholds (tuned on synthetic speech and checked on real talking-head audio)
------------------------------------------------------------------------------
    VOICING_MIN        0.50   normalised autocorrelation peak
    RMS_REL_MIN        0.15   x median RMS of voiced frames within +-3 s
    FLUX_MAX_DB        3.0    mean band-envelope change over 20 ms
    F0_STEP_MAX        0.04   relative F0 change per 10 ms hop
    MAX_HOLE_FRAMES    2      bridged glitch length (20 ms)
    MIN_RUN_S          0.30   (MIN_RUN_FINAL_S 0.45 for phrase-final words)
    F0_SPREAD_MAX      0.15   (P90 - P10) / median F0 over the run
    DRIFT_MAX_DB       3.5    envelope change first vs last quarter of run
    EDGE_TOUCH_S       0.12   run must start/end this close to the word edge
    KEEP_MIN_S         0.12   word keeps max(0.12 s, 0.04 s x letters) ...
    KEEP_VOICED_MIN_S  0.05   ... of which >= 50 ms voiced speech
    MAX_RUN_S          2.0    longer held tones are sung notes, not fillers
    VOWEL_REMAINDER_S  0.06   left with the word when its vowel runs into
                              the filler without a break

Known limitations: a deliberately drawn-out word with a FLAT pitch and
steady vowel ("jaaaa" sung on one note, a held "sooo") is acoustically
identical to a filled pause -- the keep-rules stop us from deleting the
whole word, but the drawn-out part may be shortened. Short filled pauses
(< ~0.3 s), or ones glued to a word so short that the pair stays under
the over-long threshold, are not found.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Optional

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import butter, resample_poly, sosfiltfilt

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Signal analysis constants
# --------------------------------------------------------------------------

ANALYSIS_SR = 16000
FRAME_S = 0.032
HOP_S = 0.010
_FRAME_LEN = int(round(FRAME_S * ANALYSIS_SR))    # 512 samples
_HOP_LEN = int(round(HOP_S * ANALYSIS_SR))        # 160 samples
# Zero-padded FFT length: >= 2*frame-1 so the FFT autocorrelation is linear
# (not circular), and it halves the bin spacing (15.6 Hz) so even the
# narrowest low envelope band (100-126 Hz) contains two bins.
_NFFT = 1024

# Speech band. Below 60 Hz is rumble/handling noise, above 4 kHz there is
# nothing a vowel needs and fricative hiss would only add noise.
BAND_LO_HZ = 60.0
BAND_HI_HZ = 4000.0

# F0 search range covers deep male (70 Hz) to high female/child (400 Hz).
F0_MIN_HZ = 70.0
F0_MAX_HZ = 400.0
_LAG_LO = int(math.floor(ANALYSIS_SR / F0_MAX_HZ))  # 40
_LAG_HI = int(math.ceil(ANALYSIS_SR / F0_MIN_HZ))   # 229
# Octave-error guard: take the SHORTEST-lag autocorrelation peak that is
# within this factor of the best one (a periodic signal also correlates at
# 2x and 3x its period).
_OCTAVE_PEAK_FACTOR = 0.85

N_ENV_BANDS = 16
ENV_LO_HZ = 100.0
ENV_HI_HZ = 4000.0
_FLUX_LAG = 2   # compare envelopes 20 ms apart (1 hop is too smooth)

# --------------------------------------------------------------------------
# Candidate selection
# --------------------------------------------------------------------------

# A word is over-long when eff_dur >= max(OVERLONG_MIN_S, BASE + PER_LETTER
# x letters). German runs ~12-15 phones/s (~0.07 s per letter) in fluent
# speech; 0.085 s/letter + 0.30 s of slack means only a word that carries
# something extra (a swallowed äh, a pause Whisper glued on) qualifies.
OVERLONG_MIN_S = 0.55
OVERLONG_BASE_S = 0.30
OVERLONG_PER_LETTER_S = 0.085
# How far the analysis window may reach into the gap to a neighbour word
# (catches an äh that sits in a short gap right next to a stretched word).
GAP_EXTEND_S = 0.25
# Loudness reference: median RMS of voiced frames in +-3 s around the word.
CONTEXT_S = 3.0
# Neighbouring analysis contexts are merged into one block so shared audio
# is processed once; cap a block's length to bound memory on long files.
_MAX_BLOCK_S = 60.0

# --------------------------------------------------------------------------
# Frame / run decision thresholds
# --------------------------------------------------------------------------

# Normalised autocorrelation peak. Clean vowels reach 0.8-0.99; fricatives,
# breath and noise stay below ~0.3.
VOICING_MIN = 0.5
# -16.5 dB below the speaker's typical voiced level: excludes trailing
# decays / room tail that are still periodic but not a held vowel.
RMS_REL_MIN = 0.15
# Mean absolute change (dB) of the level-normalised 16-band envelope over
# 20 ms. A held vowel stays ~0.5-1.5 dB; formant transitions in running
# speech jump 4-10 dB.
FLUX_MAX_DB = 3.0
# Pitch may drift at most 4 % per 10 ms (vibrato-free held vowel ~0.5-1 %).
F0_STEP_MAX = 0.04
# A held vowel with a rough/creaky voice or background noise has isolated
# 10-20 ms glitches (octave jump, flux spike). Holes this short are bridged
# when the frames on both sides match; consonants last >= 30 ms.
MAX_HOLE_FRAMES = 2
# Minimum sustained run. Normal German vowels are 50-170 ms; long vowels
# (stressed 'aa', 'ie') reach ~250 ms.
MIN_RUN_S = 0.30
# Phrase-final lengthening: the last vowel before '.', '?', '!' or a
# >= 0.3 s pause is naturally 1.5-2x longer, so demand more there.
MIN_RUN_FINAL_S = 0.45
FINAL_SILENCE_S = 0.30
_PHRASE_FINAL_PUNCT = (".", "?", "!", "…")
# Filled pauses are sung on one level note; emphatic lengthening ("sooo
# gut") rises or falls by 20-40 %.
F0_SPREAD_MAX = 0.15
# Run-level spectral drift: mean |envelope of the first quarter - envelope
# of the last quarter| in dB. Frame flux only compares 20 ms apart, so a
# slow glide (diphthong, vowel into l/r/n) can pass it frame by frame.
# Held ähs measure 0.2-2 dB (3 dB for a deliberate ä->ə glide); the long
# glides found in real speech measured 4.4-6 dB.
DRIFT_MAX_DB = 3.5
# The run must sit at the word's head or tail (Whisper glues the äh on
# before or after the real word, never in the middle of it).
EDGE_TOUCH_S = 0.12
# After cutting, the word must keep this much audio so we never delete the
# word itself (0.04 s per letter ~ the fastest plausible articulation).
KEEP_MIN_S = 0.12
KEEP_PER_LETTER_S = 0.04
# ...and what is kept must still contain some voiced speech (the word's own
# vowel). Without this, a word Whisper stretched into a pause the silence
# detector missed would "keep" only that pause.
KEEP_VOICED_MIN_S = 0.05

# Caps.
MAX_CUTS_PER_MIN = 6.0
# A held tone longer than this is a sung/held note, not a filled pause.
MAX_RUN_S = 2.0
# When the word's own vowel runs straight into the held vowel (no
# consonant or unvoiced break), leave this much of the run with the word
# so 'eine:::' becomes 'eine', not 'ein'.
VOWEL_REMAINDER_S = 0.06
# How far before/after the run we look for the word's voiced audio.
CONTIG_LOOK_S = 0.025
CUT_PAD_S = 0.02

# Frames processed per vectorised FFT batch (bounds memory: ~2048 x 513
# complex values per array).
_CHUNK_FRAMES = 2048


def _band_matrix() -> np.ndarray:
    """(n_bins, N_ENV_BANDS) 0/1 matrix summing FFT bins into log bands."""
    freqs = np.fft.rfftfreq(_NFFT, 1.0 / ANALYSIS_SR)
    edges = np.geomspace(ENV_LO_HZ, ENV_HI_HZ, N_ENV_BANDS + 1)
    m = np.zeros((freqs.size, N_ENV_BANDS))
    for k in range(N_ENV_BANDS):
        m[(freqs >= edges[k]) & (freqs < edges[k + 1]), k] = 1.0
    return m


_BAND_M = _band_matrix()
_HANN = np.hanning(_FRAME_LEN)
# Lags incl. one neighbour on each side (for peak test + interpolation).
_LAGS = np.arange(_LAG_LO - 1, _LAG_HI + 2)
_BANDPASS_SOS = butter(4, [BAND_LO_HZ, BAND_HI_HZ], btype="bandpass",
                       fs=ANALYSIS_SR, output="sos")


# --------------------------------------------------------------------------
# Data holders
# --------------------------------------------------------------------------

@dataclass
class _Word:
    start: float
    end: float
    text: str


@dataclass
class _Frames:
    """Per-frame features of one contiguous audio block."""
    t0: float               # block start time (s); frame k starts at t0+k*hop
    rms: np.ndarray
    voicing: np.ndarray
    f0: np.ndarray
    flux: np.ndarray
    df0: np.ndarray         # |F0[k] - F0[k-1]| / F0[k]
    env: np.ndarray         # (n, N_ENV_BANDS) level-normalised envelope, dB

    @property
    def starts(self) -> np.ndarray:
        return self.t0 + np.arange(self.rms.size) * HOP_S

    def base_ok(self) -> np.ndarray:
        """Sustained-frame test without the (context-dependent) level check."""
        return ((self.voicing >= VOICING_MIN)
                & (self.flux <= FLUX_MAX_DB)
                & (self.df0 <= F0_STEP_MAX))


# --------------------------------------------------------------------------
# Signal processing
# --------------------------------------------------------------------------

def _to_analysis_rate(x: np.ndarray, sample_rate: int) -> np.ndarray:
    """Resample a block to 16 kHz (polyphase, zero phase) and band-pass."""
    x = np.asarray(x, dtype=np.float64)
    if sample_rate != ANALYSIS_SR:
        g = math.gcd(int(sample_rate), ANALYSIS_SR)
        up, down = ANALYSIS_SR // g, int(sample_rate) // g
        if up <= 1000 and down <= 1000:
            x = resample_poly(x, up, down)
        else:
            # Odd rate (e.g. 44056 Hz): polyphase factors would explode.
            # Anti-alias at the source rate, then interpolate.
            lp = butter(8, 0.45 * ANALYSIS_SR, btype="lowpass",
                        fs=sample_rate, output="sos")
            x = sosfiltfilt(lp, x)
            n_out = int(round(x.size * ANALYSIS_SR / sample_rate))
            x = np.interp(np.arange(n_out) * (sample_rate / ANALYSIS_SR),
                          np.arange(x.size), x)
    if x.size <= 27:   # sosfiltfilt needs > 3 * (2 * n_sections + 1) samples
        return x
    return sosfiltfilt(_BANDPASS_SOS, x)


def _frame_features(x16: np.ndarray, t0: float) -> Optional[_Frames]:
    """Vectorised frame features of a band-passed 16 kHz block."""
    n = _FRAME_LEN
    if x16.size < n + 2 * _HOP_LEN:
        return None
    n_fr = 1 + (x16.size - n) // _HOP_LEN
    frames = sliding_window_view(x16, n)[::_HOP_LEN][:n_fr]

    rms = np.empty(n_fr)
    voicing = np.empty(n_fr)
    f0 = np.empty(n_fr)
    env = np.empty((n_fr, N_ENV_BANDS))

    for a in range(0, n_fr, _CHUNK_FRAMES):
        fr = frames[a:a + _CHUNK_FRAMES]
        m = fr.shape[0]
        sq = fr * fr
        rms[a:a + m] = np.sqrt(sq.mean(axis=1))

        # --- normalised cross-correlation (NCCF) via FFT autocorrelation.
        # r(l) = sum x[i]x[i+l] / sqrt(E(x[0:n-l]) * E(x[l:n])): energy
        # normalised per lag, so a periodic frame scores ~1 at its period
        # regardless of how far the lag reaches into the 32 ms frame.
        spec = np.fft.rfft(fr, _NFFT, axis=1)
        ac = np.fft.irfft(spec.real ** 2 + spec.imag ** 2, _NFFT, axis=1)
        csum = np.zeros((m, n + 1))
        np.cumsum(sq, axis=1, out=csum[:, 1:])
        e_head = csum[:, n - _LAGS]
        e_tail = csum[:, n:n + 1] - csum[:, _LAGS]
        r = ac[:, _LAGS] / np.sqrt(np.maximum(e_head * e_tail, 1e-24))

        inner = r[:, 1:-1]                       # lags _LAG_LO.._LAG_HI
        vmax = inner.max(axis=1)
        is_peak = (inner >= r[:, :-2]) & (inner >= r[:, 2:])
        good = is_peak & (inner >= _OCTAVE_PEAK_FACTOR * vmax[:, None])
        pick = np.where(good.any(axis=1), good.argmax(axis=1),
                        inner.argmax(axis=1))
        rows = np.arange(m)
        y0, y1, y2 = r[rows, pick], r[rows, pick + 1], r[rows, pick + 2]
        denom = y0 - 2.0 * y1 + y2
        safe = np.where(np.abs(denom) > 1e-12, denom, 1.0)
        delta = np.where(np.abs(denom) > 1e-12, 0.5 * (y0 - y2) / safe, 0.0)
        lag = _LAG_LO + pick + np.clip(delta, -0.5, 0.5)
        voicing[a:a + m] = vmax
        f0[a:a + m] = ANALYSIS_SR / lag

        # --- level-normalised spectral envelope (shape, not loudness).
        wspec = np.fft.rfft(fr * _HANN, _NFFT, axis=1)
        bands = (wspec.real ** 2 + wspec.imag ** 2) @ _BAND_M
        e = 10.0 * np.log10(bands + 1e-20)
        env[a:a + m] = e - e.mean(axis=1, keepdims=True)

    flux = np.full(n_fr, np.inf)
    flux[_FLUX_LAG:] = np.abs(env[_FLUX_LAG:] - env[:-_FLUX_LAG]).mean(axis=1)
    df0 = np.full(n_fr, np.inf)
    df0[1:] = np.abs(np.diff(f0)) / f0[1:]
    return _Frames(t0=t0, rms=rms, voicing=voicing, f0=f0, flux=flux, df0=df0,
                   env=env)


def _analyse_block(audio: np.ndarray, sample_rate: int,
                   t_start: float, t_end: float) -> Optional[_Frames]:
    s0 = max(0, int(math.floor(t_start * sample_rate)))
    s1 = min(audio.size, int(math.ceil(t_end * sample_rate)))
    if s1 - s0 < int(0.1 * sample_rate):
        return None
    x16 = _to_analysis_rate(audio[s0:s1], sample_rate)
    return _frame_features(x16, s0 / sample_rate)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of consecutive True values."""
    if mask.size == 0:
        return []
    d = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1).tolist(),
                    np.flatnonzero(d == -1).tolist()))


def _sustained_runs(fr: _Frames, ok: np.ndarray,
                    offset: int = 0) -> list[tuple[int, int]]:
    """Runs of sustained frames, bridging short glitches.

    `ok` covers block frames offset..offset+len(ok); returned [a, b) pairs
    are block frame indices. A hole of <= MAX_HOLE_FRAMES is bridged only
    if the frames on either side have the same spectral shape and pitch,
    so a quick consonant between two DIFFERENT vowels never joins them.
    """
    merged: list[list[int]] = []
    for a, b in _runs(ok):
        a, b = a + offset, b + offset
        if merged and a - merged[-1][1] <= MAX_HOLE_FRAMES:
            i0, i1 = merged[-1][1] - 1, a        # last OK before, first after
            same_shape = float(np.abs(fr.env[i1] - fr.env[i0]).mean()) <= FLUX_MAX_DB
            same_pitch = (abs(fr.f0[i1] - fr.f0[i0]) / fr.f0[i1]
                          <= F0_STEP_MAX * (a - merged[-1][1] + 1))
            if same_shape and same_pitch:
                merged[-1][1] = b
                continue
        merged.append([a, b])
    return [(a, b) for a, b in merged]


def _f0_spread(f0: np.ndarray) -> float:
    """(P90 - P10) / median of an F0 track: 0 = perfectly level pitch."""
    p10, p50, p90 = np.percentile(f0, [10, 50, 90])
    return float((p90 - p10) / max(p50, 1e-9))


def _run_shape(fr: _Frames, a: int, b: int,
               ok: np.ndarray) -> tuple[float, float]:
    """(F0 spread, spectral drift dB) of block frames [a, b), computed on
    the genuinely sustained frames only (bridged glitches excluded)."""
    sel = ok[a:b]
    f0 = fr.f0[a:b][sel]
    env = fr.env[a:b][sel]
    q = max(3, env.shape[0] // 4)
    drift = float(np.abs(env[:q].mean(axis=0) - env[-q:].mean(axis=0)).mean())
    return _f0_spread(f0), drift


def _run_span(fr: _Frames, a: int, b: int) -> tuple[float, float]:
    """Time span covered by frames [a, b): first frame start..last frame end.

    A frame only passes the sustained test if (nearly) all of it lies in
    the held vowel, so the frame extents are the tightest estimate of the
    vowel itself.
    """
    return fr.t0 + a * HOP_S, fr.t0 + (b - 1) * HOP_S + FRAME_S


def _as_mono(audio_data) -> np.ndarray:
    audio = np.asarray(audio_data)
    if audio.ndim == 2:
        # Accept (n, ch) or (ch, n) defensively; the contract is mono.
        ch_axis = 0 if audio.shape[0] <= 8 < audio.shape[1] else 1
        audio = audio.mean(axis=ch_axis)
    return audio.reshape(-1)


# --------------------------------------------------------------------------
# Transcription helpers
# --------------------------------------------------------------------------

def _collect_words(transcription: dict) -> list[_Word]:
    """Flatten Whisper's segments[].words[] into time-sorted words."""
    out: list[_Word] = []
    for seg in (transcription or {}).get("segments") or []:
        for w in seg.get("words") or []:
            s, e = w.get("start"), w.get("end")
            if s is None or e is None:
                continue
            s, e = float(s), float(e)
            if e <= s:
                continue
            out.append(_Word(s, e, (w.get("word", "") or "").strip()))
    out.sort(key=lambda w: (w.start, w.end))
    return out


def _speech_parts(start: float, end: float,
                  silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """[start, end] minus all silence ranges (silences sorted by start)."""
    parts: list[tuple[float, float]] = []
    cur = start
    for s, e in silences:
        if e <= cur:
            continue
        if s >= end:
            break
        if s > cur:
            parts.append((cur, s))
        cur = max(cur, e)
        if cur >= end:
            break
    if cur < end:
        parts.append((cur, end))
    return [(s, e) for s, e in parts if e - s > 1e-6]


def _measure(parts: list[tuple[float, float]], cut: tuple[float, float]) -> float:
    """Total length of `parts` that lies OUTSIDE `cut`."""
    total = 0.0
    for s, e in parts:
        total += (e - s) - max(0.0, min(e, cut[1]) - max(s, cut[0]))
    return total


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def find_sustained_runs(
    sample_rate: int,
    audio_data,
    start: float = 0.0,
    end: Optional[float] = None,
    min_run_s: float = MIN_RUN_S,
) -> list[dict]:
    """Frame-level sustained-vowel finder over a whole region (no words).

    Diagnostic / calibration helper: returns every run of sustained frames
    lasting >= `min_run_s` in [start, end], with its pitch/spectrum
    statistics. `level` tells whether the run also passes the F0-spread
    and drift tests, i.e. whether it would count as a filled pause if it
    sat at the edge of an over-long word.
    """
    audio = _as_mono(audio_data)
    total = audio.size / float(sample_rate)
    end = total if end is None else min(end, total)
    fr = _analyse_block(audio, sample_rate, start, end)
    if fr is None:
        return []
    starts = fr.starts
    voiced = fr.voicing >= VOICING_MIN
    # Per-frame loudness reference = median voiced RMS within +-CONTEXT_S,
    # evaluated once per second (it changes slowly).
    ref = np.zeros(fr.rms.size)
    for sec in np.arange(start, end + 1.0, 1.0):
        sel = (starts >= sec) & (starts < sec + 1.0)
        if not sel.any():
            continue
        ctx = voiced & (np.abs(starts - (sec + 0.5)) <= CONTEXT_S + 0.5)
        ref[sel] = np.median(fr.rms[ctx]) if ctx.sum() >= 10 else np.median(fr.rms)
    ok = fr.base_ok() & (fr.rms >= RMS_REL_MIN * ref)
    out: list[dict] = []
    for a, b in _sustained_runs(fr, ok):
        rs, re_ = _run_span(fr, a, b)
        if re_ - rs < min_run_s:
            continue
        spread, drift = _run_shape(fr, a, b, ok)
        out.append({
            "start": round(rs, 3), "end": round(re_, 3),
            "dur": round(re_ - rs, 3),
            "f0_median": round(float(np.median(fr.f0[a:b][ok[a:b]])), 1),
            "f0_spread": round(spread, 3),
            "drift_db": round(drift, 2),
            "level": spread <= F0_SPREAD_MAX and drift <= DRIFT_MAX_DB,
        })
    return out


def detect_sustained_vowels(
    sample_rate: int,
    audio_data,
    transcription: dict,
    silence_ranges: list[tuple[float, float]] | None = None,
    debug: list | None = None,
) -> list[tuple[float, float]]:
    """Find filled pauses hidden inside over-long Whisper word spans.

    Args:
        sample_rate: sample rate of `audio_data` (44100, 48000, 16000, ...).
        audio_data: 1-D float array, mono, roughly in [-1, 1]. Only the
            analysed windows are copied/resampled, so passing a whole
            file is cheap.
        transcription: Whisper result dict with segments[].words[] carrying
            'word', 'start', 'end'.
        silence_ranges: optional (start, end) audio-silence regions in
            seconds. Used to trim word bounds Whisper stretched into
            silence and to recognise phrase-final words.
        debug: optional list; one dict per analysed word is appended
            (bounds, window, candidate runs and the verdict for each).

    Returns:
        Sorted, non-overlapping (start, end) ranges in seconds to cut.
    """
    if not transcription or not sample_rate or sample_rate <= 0:
        return []
    words = _collect_words(transcription)
    if not words:
        return []
    audio = _as_mono(audio_data)
    if audio.size == 0:
        return []
    total = audio.size / float(sample_rate)
    silences = sorted((float(s), float(e)) for s, e in (silence_ranges or [])
                      if e is not None and s is not None and float(e) > float(s))

    # ---- 1. over-long candidate words + their analysis windows
    candidates: list[dict] = []
    prev_end = 0.0
    for i, w in enumerate(words):
        prev_end_here = prev_end
        prev_end = max(prev_end, w.end)
        if w.start >= total:
            break
        parts = _speech_parts(w.start, min(w.end, total), silences)
        if not parts:
            continue
        eff_s, eff_e = parts[0][0], parts[-1][1]
        letters = sum(ch.isalnum() for ch in w.text)
        need = max(OVERLONG_MIN_S,
                   OVERLONG_BASE_S + OVERLONG_PER_LETTER_S * letters)
        if eff_e - eff_s < need:
            continue
        next_start = words[i + 1].start if i + 1 < len(words) else total
        # Extend only into the GAP next to the word, never into a neighbour.
        win_s = max(0.0, min(eff_s, max(eff_s - GAP_EXTEND_S, prev_end_here)))
        win_e = min(total, max(eff_e, min(eff_e + GAP_EXTEND_S, next_start)))
        phrase_final = (
            w.text.rstrip("\"'»«“”)").endswith(_PHRASE_FINAL_PUNCT)
            or i + 1 == len(words)
            or next_start - eff_e >= FINAL_SILENCE_S
            or any(eff_e - 0.05 <= s <= eff_e + GAP_EXTEND_S
                   and e - s >= FINAL_SILENCE_S for s, e in silences)
        )
        candidates.append({
            "word": w.text, "start": w.start, "end": w.end,
            "eff": (eff_s, eff_e), "parts": parts, "letters": letters,
            "window": (win_s, win_e), "phrase_final": phrase_final,
        })
    if not candidates:
        return []

    # ---- 2./3. analyse merged context blocks once (not per word)
    ctx = sorted((max(0.0, c["window"][0] - CONTEXT_S),
                  min(total, c["window"][1] + CONTEXT_S)) for c in candidates)
    blocks: list[list[float]] = []
    for s, e in ctx:
        if blocks and s <= blocks[-1][1] and e - blocks[-1][0] <= _MAX_BLOCK_S:
            blocks[-1][1] = max(blocks[-1][1], e)
        else:
            blocks.append([s, e])
    block_frames = [(s, e, _analyse_block(audio, sample_rate, s, e))
                    for s, e in blocks]

    # ---- 4.-6. per-word run search
    found: list[tuple[float, float, float]] = []   # (cut_s, cut_e, score)
    for c in candidates:
        win_s, win_e = c["window"]
        eff_s, eff_e = c["eff"]
        fr = next((f for s, e, f in block_frames
                   if s <= win_s and win_e <= e), None)
        info = {k: c[k] for k in ("word", "start", "end", "eff", "window",
                                  "phrase_final")}
        info.update(runs=[], cut=None)
        if debug is not None:
            debug.append(info)
        if fr is None:
            info["reason"] = "block too short"
            continue
        starts = fr.starts
        ends = starts + FRAME_S
        idx = np.flatnonzero((starts >= win_s - 1e-9) & (ends <= win_e + 1e-9))
        if idx.size < 3:
            info["reason"] = "window too short"
            continue
        voiced_ctx = ((fr.voicing >= VOICING_MIN)
                      & (starts >= win_s - CONTEXT_S) & (ends <= win_e + CONTEXT_S))
        ref = (np.median(fr.rms[voiced_ctx]) if voiced_ctx.sum() >= 10
               else np.median(fr.rms[idx]))
        loud = fr.rms >= RMS_REL_MIN * ref
        ok = fr.base_ok()[idx] & loud[idx]
        # Voiced speech-level frames whose centre lies inside the word.
        centres = starts + FRAME_S / 2
        in_word = np.zeros(centres.size, dtype=bool)
        for ps, pe in c["parts"]:
            in_word |= (centres >= ps) & (centres < pe)
        word_voiced = in_word & loud & (fr.voicing >= VOICING_MIN)
        # Phrase-final lengthening stretches the last vowel of the word;
        # in a monosyllable that vowel sits right at the head, so the
        # stricter minimum applies to any run in a phrase-final word.
        min_run = MIN_RUN_FINAL_S if c["phrase_final"] else MIN_RUN_S

        keep_need = max(KEEP_MIN_S, KEEP_PER_LETTER_S * c["letters"])
        best: Optional[tuple[float, float, float]] = None
        ok_blk = np.zeros(fr.rms.size, dtype=bool)
        ok_blk[idx] = ok
        for ga, gb in _sustained_runs(fr, ok, offset=int(idx[0])):
            rs, re_ = _run_span(fr, ga, gb)
            dur = re_ - rs
            run = {"start": round(rs, 3), "end": round(re_, 3),
                   "dur": round(dur, 3)}
            info["runs"].append(run)
            if dur < MIN_RUN_S:
                run["verdict"] = "short"
                continue
            if dur > MAX_RUN_S:
                run["verdict"] = "too long (held/sung note)"
                continue
            at_head = rs <= eff_s + EDGE_TOUCH_S
            at_tail = re_ >= eff_e - EDGE_TOUCH_S
            if not (at_head or at_tail):
                run["verdict"] = "mid-word"
                continue
            if dur < min_run:
                run["verdict"] = "phrase-final lengthening"
                continue
            spread, drift = _run_shape(fr, ga, gb, ok_blk)
            run["f0_spread"] = round(spread, 3)
            run["drift_db"] = round(drift, 2)
            if spread > F0_SPREAD_MAX:
                run["verdict"] = "pitch not level"
                continue
            if drift > DRIFT_MAX_DB:
                run["verdict"] = "spectrum drifts"
                continue
            cs, ce = rs - CUT_PAD_S, re_ + CUT_PAD_S
            # Voiced word audio directly next to the run means the word's
            # vowel flows into the filler — keep a natural vowel ending.
            # Only frames lying entirely outside the run count (32 ms
            # frames at a 10 ms hop overlap the run's own first frames).
            # "Contiguous" = every frame ending in the last CONTIG_LOOK_S
            # before the run (or starting in the first after it) is voiced
            # word audio — a consonant closure ('gut|äh') breaks that.
            fends = starts + FRAME_S
            before = (fends <= rs - 0.002) & (fends > rs - CONTIG_LOOK_S)
            after = (starts >= re_ + 0.002) & (starts < re_ + CONTIG_LOOK_S)
            contig_before = bool(before.any()) and bool(np.all(word_voiced[before]))
            contig_after = bool(after.any()) and bool(np.all(word_voiced[after]))
            if at_tail and not at_head and contig_before:
                cs = rs + VOWEL_REMAINDER_S
            elif at_head and not at_tail and contig_after:
                ce = re_ - VOWEL_REMAINDER_S
            cut = (max(win_s, cs), min(win_e, ce))
            kept = _measure(c["parts"], cut)
            kept_voiced = HOP_S * int(np.count_nonzero(
                word_voiced & ((centres < cut[0]) | (centres > cut[1]))))
            run["kept"] = round(kept, 3)
            run["kept_voiced"] = round(kept_voiced, 3)
            if kept < keep_need or kept_voiced < KEEP_VOICED_MIN_S:
                run["verdict"] = "would delete the word"
                continue
            run["verdict"] = "cut"
            # Strength: longer + more clearly voiced = more certain.
            score = dur * float(np.mean(fr.voicing[ga:gb]))
            if best is None or score > best[2]:
                best = (cut[0], cut[1], score)
        if best is not None:
            info["cut"] = (round(best[0], 3), round(best[1], 3))
            found.append(best)

    # ---- 7. caps + merge
    max_cuts = max(1, math.ceil(MAX_CUTS_PER_MIN * total / 60.0))
    if len(found) > max_cuts:
        logger.info("sustained-vowel: %d candidates, keeping strongest %d",
                    len(found), max_cuts)
        found = sorted(found, key=lambda t: -t[2])[:max_cuts]
    merged: list[tuple[float, float]] = []
    for s, e, _ in sorted(found):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    result = [(round(s, 3), round(e, 3)) for s, e in merged]
    if result:
        logger.info("sustained-vowel: %d cut(s): %s", len(result), result)
    return result
