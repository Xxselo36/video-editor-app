/**
 * Clean cut edges (UX10, review C10): a cut made in the text snaps each
 * edge to the quietest moment within ±120 ms, so no syllable is clipped.
 * The twin of backend/audio_analysis.py snap_edge; both run
 * testdata/snap_vectors.json.
 *
 * peaks: the job's peaks.bin (GET /jobs/{id}/peaks), the mezz audio's
 * 100 Hz RMS envelope, one byte per 10 ms (0 = −96 dBFS … 127 = full
 * scale). Frame i covers [i, i + 1) / rate; its centre is (i + 0.5) / rate.
 */

export const PEAKS_RATE = 100;
export const SNAP_WINDOW_S = 0.12;

export type Peaks = ArrayLike<number>;

/**
 * The centre of the quietest frame within ±window s of t. Ties go to the
 * frame closest to t, then to the earlier one. t unchanged when no frame
 * centre is in reach (no peaks, t outside the audio).
 */
export function snapEdge(t: number, peaks: Peaks | null | undefined, window = SNAP_WINDOW_S, rate = PEAKS_RATE): number {
  const n = peaks?.length ?? 0;
  if (!peaks || n === 0 || !Number.isFinite(t) || rate <= 0) return t;
  const lo = Math.max(0, Math.floor((t - window) * rate - 0.5));
  const hi = Math.min(n - 1, Math.ceil((t + window) * rate - 0.5));
  let best = -1;
  let bestPeak = 0;
  let bestD = 0;
  for (let i = lo; i <= hi; i++) {
    const c = (i + 0.5) / rate;
    const d = Math.abs(c - t);
    if (d > window + 1e-9) continue;
    const p = peaks[i];
    // (peak, distance, index): lexicographic, like the Python tuple key
    if (best < 0 || p < bestPeak || (p === bestPeak && d < bestD)) {
      best = i;
      bestPeak = p;
      bestD = d;
    }
  }
  return best < 0 ? t : (best + 0.5) / rate;
}

/** peaks.bin as bytes (int8, 0..127; a negative byte reads as 0). */
export function peaksFromBytes(buf: ArrayBuffer): Uint8Array {
  const raw = new Int8Array(buf);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] < 0 ? 0 : raw[i];
  return out;
}
