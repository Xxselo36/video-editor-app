"""Acoustic edges for the analysis' text-made cuts (S5: clipped words).

Fillers, stutters, hesitations, mumbles, word gaps, Whisper loops and the
"Cleo …" commands are cut on Whisper's word times. Real Whisper words
touch in most pairs and drift by about 100 ms (the end of a word before
a pause often 150 ms early), so a cut on those times clips the kept
neighbour ('we' loses 57 ms before a cut 'um') or leaves part of the cut
word audible ('…eep' after "Cleo keep").

snap_removals moves each edge of a removal to the quietest spot of the
audio near it — never past the middle of a neighbouring word, and only
when that spot is clearly quieter than the edge as it was (on flat audio,
e.g. inside a silence, the edge stays). The envelope is the RMS per
10 ms frame in dB (as backend/audio_analysis.py's peaks); a spot is
scored by the loudest frame within ±QUIET_RADIUS frames of it, so the
gap between two words wins over the 30-40 ms closure of a 't' or 'k'
inside one.
"""
from __future__ import annotations

import math
from bisect import bisect_left
from typing import Iterable, Sequence

RATE = 100            # frames per second (10 ms)
FLOOR_DB = -120.0
# How far an edge may move: commands drift more (and are longer) than
# filler words.
WINDOW_FILLER_S = 0.2
WINDOW_COMMAND_S = 0.25
# An edge moves only to a frame at least this much quieter.
MIN_GAIN_DB = 3.0
MIN_REMOVAL_S = 0.02
QUIET_RADIUS = 2      # frames each side (a 50 ms quiet run scores best)


def frame_db(sample_rate: int, samples, rate: int = RATE):
    """RMS level per 1 / `rate` s frame in dB (full scale 1.0) of mono
    `samples` (numpy array); frame i covers [i, i + 1) / rate."""
    import numpy as np
    x = np.asarray(samples)
    if x.ndim > 1:
        x = x.mean(axis=1)
    hop = max(1, int(round(sample_rate / rate)))
    n = len(x) // hop
    if n == 0:
        return np.zeros(0)
    sq = np.empty(n)
    step = 6000  # frames per block (a minute): no copy of the whole audio
    for a in range(0, n, step):
        b = min(n, a + step)
        blk = np.asarray(x[a * hop:b * hop], dtype=np.float64)
        sq[a:b] = (blk * blk).reshape(b - a, hop).mean(axis=1)
    return np.maximum(10.0 * np.log10(np.maximum(sq, 1e-30)), FLOOR_DB)


def quiet_score(env):
    """Per frame: the loudest frame within ±QUIET_RADIUS of it."""
    import numpy as np
    x = np.asarray(env, dtype=np.float64)
    if x.size == 0 or QUIET_RADIUS <= 0:
        return x
    pad = np.pad(x, QUIET_RADIUS, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, 2 * QUIET_RADIUS + 1)
    return win.max(axis=1)


def _level(env: Sequence[float], t: float, rate: int) -> float | None:
    i = int(math.floor(t * rate))
    if 0 <= i < len(env):
        return float(env[i])
    return None


def quietest(env: Sequence[float], t: float, lo: float, hi: float,
             rate: int = RATE, min_gain_db: float = MIN_GAIN_DB) -> float:
    """The centre of the quietest frame whose centre lies in [lo, hi]
    (ties: the one closest to t), if it is at least `min_gain_db`
    quieter than the frame at t; else t."""
    here = _level(env, t, rate)
    if here is None or hi < lo:
        return t
    a = max(0, math.ceil(lo * rate - 0.5))
    b = min(len(env) - 1, math.floor(hi * rate - 0.5))
    best, best_key = -1, None
    for i in range(a, b + 1):
        c = (i + 0.5) / rate
        key = (float(env[i]), abs(c - t))
        if best_key is None or key < best_key:
            best, best_key = i, key
    if best < 0 or best_key[0] > here - min_gain_db:
        return t
    return (best + 0.5) / rate


def _mids(words: Iterable[dict]) -> list[float]:
    out = []
    for w in words or ():
        try:
            s, e = float(w["start"]), float(w["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(s) and math.isfinite(e) and e >= s:
            out.append((s + e) / 2)
    return sorted(out)


def snap_removal(a: float, b: float, mids: list[float], env: Sequence[float],
                 window: float, rate: int = RATE,
                 duration: float | None = None) -> tuple[float, float]:
    """The removal [a, b] with both edges on the audio (module doc);
    `env`: quiet_score of the envelope.
    `mids`: sorted word middles. A word counts as removed when its middle
    is inside [a, b]; an edge never passes the middle of the word on
    either side of it, so every removed word stays removed and every
    kept one kept. A removal holding no word whose edges meet comes back
    empty (na, na); one holding words stays [a, b] then."""
    if not len(env) or not (b > a):
        return a, b
    end = len(env) / rate if duration is None else min(duration, len(env) / rate)
    j = bisect_left(mids, a)            # first middle at or after a
    k = bisect_left(mids, b)            # first middle at or after b
    prev_mid = mids[j - 1] if j > 0 else -math.inf
    first_in = mids[j] if j < len(mids) and mids[j] <= b else math.inf
    last_in = mids[k - 1] if k > 0 and mids[k - 1] >= a else -math.inf
    next_mid = mids[k] if k < len(mids) else math.inf
    # The start / end of the recording stays where it is.
    na = a if a <= 0 else quietest(env, a, max(a - window, prev_mid, 0.0),
                                   min(a + window, first_in, b), rate)
    nb = b if b >= end - 1e-6 else quietest(env, b, max(b - window, last_in, a),
                                            min(b + window, next_mid, end), rate)
    # The bounds keep every removed word's middle inside; a removal
    # without words (a gap) may shrink to the silence that is really
    # there — or to nothing, when its edges meet in the one pause
    # between the words around it (Whisper's "gap" was their sound).
    if nb - na < MIN_REMOVAL_S:
        if first_in == math.inf:
            return na, na
        return a, b
    return na, nb


def snap_removals(ranges: Iterable[tuple[float, float]], words: Iterable[dict],
                  env: Sequence[float] | None, window: float = WINDOW_FILLER_S,
                  rate: int = RATE, duration: float | None = None
                  ) -> list[tuple[float, float]]:
    """snap_removal for every range (in order); unchanged without an
    envelope."""
    ranges = [(float(a), float(b)) for a, b in ranges or ()]
    if env is None or not len(env):
        return ranges
    mids = _mids(words)
    score = quiet_score(env)
    return [snap_removal(a, b, mids, score, window, rate, duration)
            for a, b in ranges]


# word_envelope: a word's middle, its edges, and no word at all (dB).
_WORD_PEAK_DB = 0.0
_WORD_EDGE_DB = -60.0


def word_envelope(words: Iterable[dict], duration: float | None = None,
                  rate: int = RATE):
    """A stand-in envelope from word times alone, for cuts made without
    the audio (POST /recompute-scenes): loudest at each word's middle,
    falling to _WORD_EDGE_DB at its edges, FLOOR_DB between words — so
    snap_removals moves an edge into the gap between two words, or onto
    the boundary of two touching ones, never into a word."""
    import numpy as np
    spans = []
    for w in words or ():
        try:
            s, e = float(w["start"]), float(w["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(s) and math.isfinite(e) and e > s:
            spans.append((s, e))
    end = max([duration or 0.0] + [e for _s, e in spans])
    n = int(math.ceil(end * rate)) + 1
    env = np.full(n, FLOOR_DB)
    for s, e in spans:
        a, b = int(math.floor(s * rate)), min(n, int(math.ceil(e * rate)))
        c = (np.arange(a, b) + 0.5) / rate
        mid, half = (s + e) / 2, (e - s) / 2
        level = _WORD_EDGE_DB + (_WORD_PEAK_DB - _WORD_EDGE_DB) * np.clip(
            1.0 - np.abs(c - mid) / half, 0.0, 1.0)
        env[a:b] = np.maximum(env[a:b], level)
    return env


def peaks_envelope(values: Sequence[int], floor_db: float = -96.0):
    """backend/audio_analysis.py's peaks (0..127 per 10 ms frame, 0 =
    floor_db) as dB frames for snap_removals."""
    import numpy as np
    v = np.asarray(values, dtype=np.float64)
    return v * (-floor_db / 127.0) + floor_db


def merge_touching(ranges: Iterable[tuple[float, float]], gap: float = 1e-6
                   ) -> list[tuple[float, float]]:
    """Sorted ranges with overlapping or touching ones merged (adjacent
    command cuts share an edge: snapping it twice could leave a sliver)."""
    out: list[list[float]] = []
    for a, b in sorted((float(a), float(b)) for a, b in ranges or ()):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]
