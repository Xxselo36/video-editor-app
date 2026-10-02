/**
 * Timeline mechanics shared by the v1 TimelineEditor and the v2 dock
 * (UX7): moved out of TimelineEditor unchanged, as pure functions over the
 * clip list. Times are SOURCE seconds; the "cut" timeline is the clips
 * laid end to end (what the strip shows).
 */

export type EditorSeg = {
  id: string;
  start: number;
  end: number;
  disabled?: boolean;
  speed?: number; // 0.25 – 4.0, default 1
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
  volume?: number; // 0 – 2.5, default 1
};

// Trimming snaps onto a neighbouring clip's footage when it would leave
// less than this much of the removed gap between them.
export const TRIM_SNAP_S = 0.3;
export const TIMELINE_MAX_PPS = 400; // 0.1s = 40px

/** Length of the strip in seconds (every clip, as the strip lays them out). */
export function stripDuration(segs: EditorSeg[]): number {
  return segs.reduce((acc, s) => acc + (s.end - s.start), 0) || 1;
}

export type TrimBounds = { prev: number; next: number };

/**
 * How far a trimmed clip may grow: growing brings back removed source
 * footage, but never footage another clip already uses — that would play
 * it twice.
 */
export function trimBounds(startSegs: EditorSeg[], id: string, duration: number): TrimBounds {
  const self = startSegs.find((x) => x.id === id);
  const others = startSegs.filter((x) => x.id !== id && !x.disabled);
  if (!self) return { prev: 0, next: duration };
  return {
    prev: Math.max(0, ...others.filter((o) => o.end <= self.start + 1e-6).map((o) => o.end)),
    next: Math.min(duration, ...others.filter((o) => o.start >= self.end - 1e-6).map((o) => o.start)),
  };
}

/**
 * The clip list while a trim handle sits at `seconds` of the strip (as laid
 * out when the drag started). Computed from the drag's start snapshot, so
 * offsets don't accumulate. `seconds` may be negative: dragging the first
 * clip's start handle past the strip's left edge brings back footage
 * before it.
 */
export function trimTo(
  startSegs: EditorSeg[],
  id: string,
  mode: "start" | "end",
  seconds: number,
  bounds: TrimBounds,
): EditorSeg[] {
  let acc = 0;
  return startSegs.map((s) => {
    if (s.disabled) return s;
    const sDur = s.end - s.start;
    if (s.id === id) {
      if (mode === "start") {
        const target = s.start + (seconds - acc);
        let clamped = Math.max(bounds.prev, Math.min(s.end - 0.1, target));
        // Snap onto the neighbouring clip's footage instead of
        // leaving a sliver of the removed gap.
        if (clamped < s.start && clamped - bounds.prev < TRIM_SNAP_S) clamped = bounds.prev;
        return { ...s, start: clamped };
      } else if (mode === "end") {
        const target = s.start + Math.max(0.1, seconds - acc);
        let clamped = Math.min(bounds.next, Math.max(s.start + 0.1, target));
        if (clamped > s.end && bounds.next - clamped < TRIM_SNAP_S) clamped = bounds.next;
        return { ...s, end: clamped };
      }
    }
    acc += sDur;
    return s;
  });
}

/** Index of the clip a split at source time `at` would cut: inside a clip,
 *  at least 0.1 s from its edges. -1 when it can't split there. */
export function splittableIndex(segs: EditorSeg[], at: number): number {
  return segs.findIndex((s) => !s.disabled && at > s.start + 0.1 && at < s.end - 0.1);
}

/** The clip list with clip `idx` split at `at` (see splittableIndex). */
export function splitAt(segs: EditorSeg[], idx: number, at: number, now = Date.now()): EditorSeg[] {
  const cur = segs[idx];
  const first: EditorSeg = { ...cur, end: at, id: `${cur.id}-a` };
  const second: EditorSeg = {
    ...cur,
    start: at,
    id: `${cur.id}-b-${now}`,
  };
  return [...segs.slice(0, idx), first, second, ...segs.slice(idx + 1)];
}

/** False for the last clip left: the backend would have nothing to render. */
export function canDelete(segs: EditorSeg[], id: string): boolean {
  const active = segs.filter((s) => !s.disabled);
  return !(active.length <= 1 && active.some((s) => s.id === id));
}

export function patchSeg(segs: EditorSeg[], id: string, patch: Partial<EditorSeg>): EditorSeg[] {
  return segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/**
 * The playhead's place on the cut timeline (what the strip lays out), or
 * null when source time `playhead` is cut out. `playheadSegId` (proxy
 * mode: the clip playing) decides at a split point or for a clip moved
 * away from its footage's neighbours.
 */
export function playheadCutOf(segs: EditorSeg[], playhead: number, playheadSegId?: string | null): number | null {
  if (playheadSegId) {
    let acc = 0;
    for (const s of segs) {
      if (s.disabled) continue;
      if (s.id === playheadSegId && playhead >= s.start - 0.05 && playhead <= s.end + 0.05) {
        return acc + Math.min(s.end - s.start, Math.max(0, playhead - s.start));
      }
      acc += s.end - s.start;
    }
  }
  let acc = 0;
  for (const s of segs) {
    if (s.disabled) continue;
    if (playhead >= s.start && playhead <= s.end) return acc + (playhead - s.start);
    acc += s.end - s.start;
  }
  return null;
}

/** Cut-timeline time → the source time (and clip) shown there; null when
 *  there are no clips. */
export function sourceAtCut(segs: EditorSeg[], cut: number): { t: number; segId: string } | null {
  let acc = 0;
  for (const s of segs) {
    if (s.disabled) continue;
    const d = s.end - s.start;
    if (cut <= acc + d) return { t: Math.min(s.end, s.start + (cut - acc)), segId: s.id };
    acc += d;
  }
  return null;
}

/** Zoom limits in px per second: never narrower than the view ("fit"),
 *  capped so very long videos don't produce absurdly wide elements. */
export function zoomLimits(viewW: number, totalDur: number): { fitPps: number; maxPps: number } {
  const fitPps = viewW / totalDur;
  const maxPps = Math.max(fitPps, Math.min(TIMELINE_MAX_PPS, 200_000 / totalDur));
  return { fitPps, maxPps };
}

export type RulerMark = { t: number; x: number; kind: "major" | "second" | "half" | "tenth" };

/**
 * Ruler marks for the visible part of the strip only (it can be many
 * thousands of px wide): labelled major marks spaced ≥ `minLabelPx`, then
 * 0.5 s and 0.1 s marks once there's room. Worked in tenths of a second to
 * avoid float drift.
 */
export function rulerMarks(
  scrollLeft: number,
  contentW: number,
  totalDur: number,
  viewW: number,
  minLabelPx = 56,
): { marks: RulerMark[]; labelStep: number } {
  const pps = contentW / totalDur;
  const labelSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const labelStep = labelSteps.find((st) => st * pps >= minLabelPx) ?? 600;
  // Finest step that still leaves >= 4px between marks.
  const minorStep = 0.1 * pps >= 4 ? 0.1 : 0.5 * pps >= 4 && labelStep > 0.5 ? 0.5 : labelStep / 2;
  const minorT = Math.max(1, Math.round(minorStep * 10));
  const labelT = Math.round(labelStep * 10);
  const from = Math.max(0, scrollLeft - 100) / pps;
  const to = Math.min(contentW, scrollLeft + viewW + 100) / pps;
  const first = Math.ceil((from * 10) / minorT) * minorT;
  const marks: RulerMark[] = [];
  for (let k = first; k <= to * 10 + 1e-6 && k <= totalDur * 10 + 1e-6; k += minorT) {
    const t = k / 10;
    const isMajor = k % labelT === 0;
    const isSecond = !isMajor && k % 10 === 0;
    const isHalf = !isMajor && !isSecond && k % 5 === 0;
    marks.push({ t, x: t * pps, kind: isMajor ? "major" : isSecond ? "second" : isHalf ? "half" : "tenth" });
  }
  return { marks, labelStep };
}

// ── UX10 (v2 dock): precise trims, the frame grid, reordering ─────────

/** Trim edges sit on a 0.01 s grid (what the readout shows). */
export const TRIM_STEP_S = 0.01;
/** Minor ruler marks (0.1 s, 0.5 s) show from this far apart. */
export const MINOR_TICK_MIN_PX = 6;

/** t on the TRIM_STEP_S grid (2 decimals, no float tail). */
export const roundToStep = (t: number) => Math.round(t / TRIM_STEP_S) / Math.round(1 / TRIM_STEP_S);

/**
 * trimTo with the moved edge on the TRIM_STEP_S grid (the handle while
 * dragging). An edge snapped onto a neighbour's footage (or held at a
 * bound) stays exactly there. On release snapTrimToFrame puts the edge
 * on the frame both exports cut at; the frame grid the dock draws while
 * zoomed in shows where those are.
 */
export function trimToStep(
  startSegs: EditorSeg[],
  id: string,
  mode: "start" | "end",
  seconds: number,
  bounds: TrimBounds,
): EditorSeg[] {
  return trimTo(startSegs, id, mode, seconds, bounds).map((s) => {
    if (s.id !== id) return s;
    if (mode === "start") {
      if (s.start === bounds.prev) return s;
      const v = Math.max(bounds.prev, Math.min(s.end - 0.1, roundToStep(s.start)));
      return v === s.start ? s : { ...s, start: v };
    }
    if (s.end === bounds.next) return s;
    const v = Math.min(bounds.next, Math.max(s.start + 0.1, roundToStep(s.end)));
    return v === s.end ? s : { ...s, end: v };
  });
}

/**
 * The exact frame rate of a stored one (GET /jobs/{id} fps is rounded to
 * 4 decimals): 29.97 → 30000/1001, 23.976 → 24000/1001, 59.94 →
 * 60000/1001; 30.0002 → 30. Frame k starts at exactly k / exactFps — the
 * backend's /edit-segments uses the same rule (main._exact_fps).
 */
export function exactFps(fps: number): number {
  const ntsc = Math.round(fps * 1.001);
  if ([24, 30, 48, 60, 120].includes(ntsc) && Math.abs(fps * 1.001 - ntsc) < 0.002 && Math.abs(fps - ntsc) > 0.01) {
    return (ntsc * 1000) / 1001;
  }
  const whole = Math.round(fps);
  return Math.abs(fps - whole) < 0.002 ? whole : fps;
}

/**
 * The edge the export uses for `t`: the nearest frame boundary, exactly
 * k / fps (review 13). The handle moves on the 0.01 s grid while
 * dragging; on release the edge moves to this (≤ half a frame) and the
 * readout shows it, so the value shown is the one both export paths cut
 * at. `t` unchanged without a known frame rate.
 *
 * Why exactly k / fps (measured, backend/tests/captions/
 * test_frame_edges.py renders both): v2 rounds each edge to the nearest
 * frame (captions_v2.clip_plan). The v1 burn (MoviePy per clip) reads a
 * start near the beginning frame by frame — int(fps·t + 1e-5), frame k
 * only from t ≥ (k − 1e-5) / fps — and further in by an ffmpeg seek that
 * keeps frames at or after t — frame k only up to t ≤ k / fps. The
 * window between is under a microsecond: only k / fps itself is frame k
 * on both. So /edit-segments keeps such an edge as sent (other edges it
 * rounds to ms), where k / fps − 0.5 ms (the old rule) gave v1 frame
 * k − 1 near a clip's start, and ms rounding either neighbour.
 */
export function frameEdge(t: number, fps: number | null | undefined): number {
  if (!(fps && fps > 0) || !Number.isFinite(t)) return t;
  const f = exactFps(fps);
  const k = Math.round(t * f);
  return k <= 0 ? 0 : k / f;
}

/** The trimmed edge of clip `id` moved to its frameEdge (a bound or a
 *  snapped neighbour's edge stays exact). Same array without a frame rate. */
export function snapTrimToFrame(
  segs: EditorSeg[],
  id: string,
  mode: "start" | "end",
  bounds: TrimBounds,
  fps: number | null | undefined,
): EditorSeg[] {
  if (!(fps && fps > 0)) return segs;
  return segs.map((s) => {
    if (s.id !== id) return s;
    if (mode === "start") {
      if (s.start === bounds.prev) return s;
      const v = Math.max(bounds.prev, Math.min(s.end - 0.1, frameEdge(s.start, fps)));
      return v === s.start ? s : { ...s, start: v };
    }
    if (s.end === bounds.next) return s;
    const v = Math.min(bounds.next, Math.max(s.start + 0.1, frameEdge(s.end, fps)));
    return v === s.end ? s : { ...s, end: v };
  });
}

/** Video frame boundaries (k / fps) inside [a, b], at most `max` of them. */
export function frameTimes(a: number, b: number, fps: number, max = 1000): number[] {
  if (!(fps > 0) || !(b > a)) return [];
  const out: number[] = [];
  for (let k = Math.ceil(a * fps - 1e-9); k / fps <= b + 1e-9 && out.length < max; k++) out.push(k / fps);
  return out;
}

/**
 * The frame grid a trim shows (strip seconds): the frames of the trimmed
 * clip plus the 2 s it can grow into on the moving side, only inside the
 * visible window [lo, hi] (strip seconds) — counted from the window, not
 * from the clip's start, so the end handle of a long clip has its grid too.
 */
export function trimFrameGrid(
  clip: { left: number; start: number; end: number },
  mode: "start" | "end",
  lo: number,
  hi: number,
  fps: number,
  max = 600,
): number[] {
  const a = clip.start - (mode === "start" ? 2 : 0);
  const b = clip.end + (mode === "end" ? 2 : 0);
  // the visible window in source seconds of this clip
  const wa = Math.max(a, clip.start + (lo - clip.left));
  const wb = Math.min(b, clip.start + (hi - clip.left));
  return frameTimes(wa, wb, fps, max).map((ft) => clip.left + (ft - clip.start));
}

/** Whether a ruler mark of this kind is drawn at `pps` px per second. */
export function tickShown(kind: RulerMark["kind"], pps: number): boolean {
  if (kind === "tenth") return 0.1 * pps >= MINOR_TICK_MIN_PX;
  if (kind === "half") return 0.5 * pps >= MINOR_TICK_MIN_PX;
  return true;
}

/** Clip `id` moved to `index` of the list without it (same array if it stays). */
export function moveSeg(segs: EditorSeg[], id: string, index: number): EditorSeg[] {
  const from = segs.findIndex((s) => s.id === id);
  if (from < 0) return segs;
  const rest = segs.filter((s) => s.id !== id);
  const to = Math.max(0, Math.min(rest.length, index));
  if (to === from) return segs;
  return [...rest.slice(0, to), segs[from], ...rest.slice(to)];
}

/**
 * Where clip `id` drops when dragged so its centre is at cut time
 * `center`: before the first other clip whose middle lies right of it
 * (the others laid end to end without it). An index for moveSeg.
 */
export function dropIndex(segs: EditorSeg[], id: string, center: number): number {
  const rest = segs.filter((s) => s.id !== id);
  let acc = 0;
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i];
    if (s.disabled) continue;
    const d = s.end - s.start;
    if (center < acc + d / 2) return i;
    acc += d;
  }
  return rest.length;
}
