/**
 * Source ↔ output time mapping for captions (UT2; mirrored by
 * backend/timeline_map.py in UT3/UT4, shared vectors in
 * testdata/timeline_vectors.json).
 *
 * Words carry SOURCE times (the recording); the edit keeps a list of clips
 * (source ranges, in output order, optionally sped up). mapToOutput turns
 * words into OUTPUT-time words for the engine:
 * - words outside every clip are dropped (and hidden words, by default);
 * - inside a clip: t_out = clipOutStart + (t_src − clip.start) / speed;
 * - consecutive clips that continue each other in the source (a split, a
 *   speed change) form one run; every other boundary is a cut and becomes
 *   a hard page break (`breaks`, output seconds);
 * - a word straddling a cut belongs to the run holding most of it and is
 *   clipped to that run, so no word — and no page — shows in two clips;
 * - `offsetMs` (the global sync nudge, −300..300) shifts words after
 *   mapping, clamped to their run.
 */
import type { CaptionWord } from "./types";

export type Clip = { id?: string; start: number; end: number; speed?: number };

export type SourceWord = {
  id: string;
  text: string;
  start: number;
  end: number;
  hidden?: boolean;
  breakBefore?: boolean;
};

export type OutputWord = CaptionWord & {
  id: string;
  srcStart: number;
  srcEnd: number;
  /** Index of the run (group of source-contiguous clips) the word belongs to. */
  run: number;
};

export type OutputTimeline = {
  words: OutputWord[];
  /** Output times of the cuts (run boundaries), ascending. */
  breaks: number[];
  duration: number;
};

const EPS = 1e-3;
export const OFFSET_LIMIT_MS = 300;

type PlacedClip = { start: number; end: number; speed: number; outStart: number; outEnd: number };
type Run = { clips: PlacedClip[]; srcStart: number; srcEnd: number; outStart: number; outEnd: number };

function place(clips: readonly Clip[]): PlacedClip[] {
  const out: PlacedClip[] = [];
  let t = 0;
  for (const c of clips) {
    if (!(c.end - c.start > EPS)) continue;
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const d = (c.end - c.start) / speed;
    out.push({ start: c.start, end: c.end, speed, outStart: t, outEnd: t + d });
    t += d;
  }
  return out;
}

function runsOf(placed: PlacedClip[]): Run[] {
  const runs: Run[] = [];
  for (const c of placed) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(c.start - last.srcEnd) <= EPS) {
      last.clips.push(c);
      last.srcEnd = c.end;
      last.outEnd = c.outEnd;
    } else {
      runs.push({ clips: [c], srcStart: c.start, srcEnd: c.end, outStart: c.outStart, outEnd: c.outEnd });
    }
  }
  return runs;
}

function mapInRun(run: Run, t: number): number {
  const x = Math.min(run.srcEnd, Math.max(run.srcStart, t));
  for (const c of run.clips) {
    if (x <= c.end + 1e-9) return c.outStart + (Math.max(x, c.start) - c.start) / c.speed;
  }
  const c = run.clips[run.clips.length - 1];
  return c.outEnd;
}

export function outputDuration(clips: readonly Clip[]): number {
  const placed = place(clips);
  return placed.length ? placed[placed.length - 1].outEnd : 0;
}

/** Output time of a source time, or null if it is cut away. */
export function srcToOut(clips: readonly Clip[], t: number): number | null {
  for (const c of place(clips)) {
    if (t >= c.start - 1e-9 && t < c.end) return c.outStart + (t - c.start) / c.speed;
  }
  return null;
}

/** Source time of an output time (clamped to the edit). */
export function outToSrc(clips: readonly Clip[], t: number): number | null {
  const placed = place(clips);
  if (!placed.length) return null;
  for (const c of placed) if (t < c.outEnd) return c.start + Math.max(0, t - c.outStart) * c.speed;
  const last = placed[placed.length - 1];
  return last.end;
}

export function mapToOutput(
  clips: readonly Clip[],
  words: readonly SourceWord[],
  opts: { offsetMs?: number; includeHidden?: boolean } = {},
): OutputTimeline {
  const placed = place(clips);
  const runs = runsOf(placed);
  const duration = placed.length ? placed[placed.length - 1].outEnd : 0;
  const shift = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, opts.offsetMs ?? 0)) / 1000;
  const perRun: { w: SourceWord; order: number }[][] = runs.map(() => []);
  words.forEach((w, order) => {
    if ((w.hidden && !opts.includeHidden) || !w.text.trim()) return;
    const s = Math.min(w.start, w.end);
    const e = Math.max(w.start, w.end);
    let best = -1;
    let bestScore = 0;
    runs.forEach((r, i) => {
      const overlap = Math.min(e, r.srcEnd) - Math.max(s, r.srcStart);
      const score = overlap > 0 ? overlap : s >= r.srcStart && s < r.srcEnd ? 1e-9 : 0;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best >= 0) perRun[best].push({ w, order });
  });
  const out: OutputWord[] = [];
  perRun.forEach((list, i) => {
    const r = runs[i];
    list.sort((a, b) => a.w.start - b.w.start || a.order - b.order);
    for (const { w } of list) {
      const s = Math.min(w.start, w.end);
      const e = Math.max(w.start, w.end);
      const os = Math.min(r.outEnd, Math.max(r.outStart, mapInRun(r, s) + shift));
      const oe = Math.min(r.outEnd, Math.max(r.outStart, mapInRun(r, e) + shift));
      out.push({
        id: w.id,
        text: w.text,
        start: os,
        end: Math.max(os, oe),
        srcStart: w.start,
        srcEnd: w.end,
        run: i,
        ...(w.breakBefore ? { breakBefore: true } : {}),
      });
    }
  });
  const breaks = runs.slice(1).map((r) => r.outStart);
  return { words: out, breaks, duration };
}
