/**
 * Preview mode (no proxy: the server builds a cut preview.mp4 for every
 * timeline save — production today): keeping what plays in step with the
 * timeline while a rebuild runs, and across the swap to the new file.
 * Pure functions over the preview's segment list (`videoSegs`: the source
 * ranges the playing file was cut from, back to back) and the edit's
 * clips; useEditSession wires them to the <video>.
 *
 *   previewMatches  the file on screen shows exactly the edit (else the
 *                   "updating preview" state stays: not just while a save
 *                   is open, until the matching file is on screen)
 *   stalePlan       what of the old file the new edit still plays: playing
 *                   skips the rest (removed footage never plays with no
 *                   caption and a hidden playhead while the rebuild runs)
 *   swapTime        the new file's time for the source moment on screen —
 *                   a swap restored the OLD cut-timeline time into the new
 *                   file, a jump to other content by what was trimmed
 *                   before the playhead
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";

export type Segs = [number, number][];

/** Edges the server keeps (ms, or an exact frame): equal within this. */
const SAME_S = 0.002;
const EPS = 1e-6;
/**
 * An element time this close before a join is the join: the frame there
 * (its timestamp IS the join, the preview's segments are frame-exact) is
 * the NEXT segment's first frame (F11: it mapped to the previous
 * segment's end — footage the edit cut — and showed no playhead and no
 * caption right after every skip).
 */
export const JOIN_S = 1e-4;

/** The clips a timeline save sends (enabled, over 0.05 s: useEditSession toPayload). */
export function savedSpans(segs: readonly EditorSeg[]): Segs {
  return segs.filter((s) => !s.disabled && s.end - s.start > 0.05).map((s) => [s.start, s.end]);
}

/** The preview built from `videoSegs` shows exactly the edit's clips (in order). */
export function previewMatches(videoSegs: Segs, editSegs: readonly EditorSeg[]): boolean {
  const want = savedSpans(editSegs);
  return (
    want.length === videoSegs.length &&
    want.every(([a, b], i) => Math.abs(a - videoSegs[i][0]) < SAME_S && Math.abs(b - videoSegs[i][1]) < SAME_S)
  );
}

/** Source time → time in the preview built from `segs`; null when cut out. */
export function previewTimeOf(src: number, segs: Segs): number | null {
  let acc = 0;
  for (const [s, e] of segs) {
    if (src >= s - EPS && src <= e + EPS) return acc + Math.min(e - s, Math.max(0, src - s));
    acc += e - s;
  }
  return null;
}

/** Preview time → source time (the preview's own segments); a join is the next segment's start (JOIN_S). */
export function sourceOfPreview(t: number, segs: Segs): number {
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const [s, e] = segs[i];
    if (t < acc + (e - s) - JOIN_S || i === segs.length - 1) return s + Math.min(e - s, Math.max(0, t - acc));
    acc += e - s;
  }
  return t;
}

/** Index of the preview segment showing element time t (a join: the next one), -1 without segments. */
export function previewSegAt(t: number, segs: Segs): number {
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i][1] - segs[i][0];
    if (t < acc + d - JOIN_S) return i;
    acc += d;
  }
  return segs.length - 1;
}

const speedOf = (s: EditorSeg | undefined) => {
  const v = s?.speed;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1;
};

/**
 * The speed the cut preview plays at element time t (preview-5): the
 * server bakes the clips' volume and fades into the file but not their
 * speed, so the player applies it — the speed of the clip that segment
 * is: the k-th clip saved when the file shows the edit, else (a file older
 * than the edit) the edit's clip that plays that source moment.
 */
export function previewSpeedAt(videoSegs: Segs, editSegs: readonly EditorSeg[], t: number): number {
  const k = previewSegAt(t, videoSegs);
  if (k < 0) return 1;
  const saved = editSegs.filter((s) => !s.disabled && s.end - s.start > 0.05);
  if (previewMatches(videoSegs, editSegs)) return speedOf(saved[k]);
  const src = sourceOfPreview(t, videoSegs);
  return speedOf(saved.find((s) => src >= s.start - EPS && src < s.end));
}

/**
 * Where the new preview (`newSegs`) should start after a swap: the source
 * moment the old one showed (`wasTime` in `oldSegs`) — or `want`, a source
 * time the user asked for that the old file didn't have — else, when the
 * edit cut it, where the cut continues after it (the next clip in source
 * order), else the end.
 */
export function swapTime(wasTime: number, oldSegs: Segs, newSegs: Segs, want?: number | null): number {
  const src = want ?? (oldSegs.length ? sourceOfPreview(wasTime, oldSegs) : wasTime);
  const at = previewTimeOf(src, newSegs);
  if (at !== null) return at;
  let best: number | null = null;
  let bestStart = Infinity;
  let acc = 0;
  for (const [s, e] of newSegs) {
    if (s >= src && s < bestStart) {
      best = acc;
      bestStart = s;
    }
    acc += e - s;
  }
  // just past the join: the element time of a join maps to the clip before it
  return best !== null ? best + 1e-3 : Math.max(0, acc - 0.1);
}

/**
 * The parts of the old preview (element time) that the new edit still
 * plays — what playing it shows until the rebuild arrives. Footage the
 * edit removed is skipped; footage it revealed isn't in the old file.
 */
export function stalePlan(videoSegs: Segs, editSegs: readonly EditorSeg[]): Segs {
  const keep = editSegs.filter((s) => !s.disabled && s.end > s.start);
  const out: Segs = [];
  let acc = 0;
  for (const [s, e] of videoSegs) {
    const parts: [number, number][] = [];
    for (const k of keep) {
      const a = Math.max(s, k.start);
      const b = Math.min(e, k.end);
      if (b - a > EPS) parts.push([a, b]);
    }
    parts.sort((x, y) => x[0] - y[0]);
    for (const [a, b] of parts) {
      const ta = acc + (a - s);
      const tb = acc + (b - s);
      const last = out[out.length - 1];
      if (last && ta <= last[1] + 1e-3) last[1] = Math.max(last[1], tb);
      else out.push([ta, tb]);
    }
    acc += e - s;
  }
  return out;
}

/**
 * Playing the old preview at element time `t`: the time to jump to so
 * removed footage doesn't play (`lead` s early, like the proxy player's
 * seek), "end" when nothing the edit plays comes after it, null to play on.
 * The jump lands `land` s into the part (about a frame, F11): the frame a
 * seek to the join itself shows can be the one before it — removed
 * footage, with no playhead and no caption — where the file's frames
 * don't start exactly at its segments' joins.
 */
export function skipTarget(plan: Segs, t: number, lead = 0.03, land = 0.045): number | "end" | null {
  for (const [a, b] of plan) {
    if (t < a - lead) return Math.min(a + (b - a) / 2, a + land);
    if (t < b - lead) return null;
  }
  return "end";
}

/**
 * The fastest video the editor plays the proxy of (round 9): 24, 25, 29.97
 * and 30 fps. A 50 / 59.94 / 60 fps job, and one whose frame rate is not
 * known, plays the server's cut preview, as with CLEO_PROXY_VIDEO off: the
 * proxy player's joins showed cut frames at 50 and 60 fps (rounds 7 and 8:
 * a 90 Hz screen, 1.25x, late timers, the browser's decoder leaping over
 * kept frames), and without the rate it has no frame grid to join
 * on (the frame callbacks as Chromium runs them read a 50 fps proxy at 2x
 * as 25 fps). The proxy has the mezz's frames and rate: GET /jobs/{id} fps.
 */
export const PROXY_MAX_FPS = 30.03;

/** Does the editor play the proxy of a video at `fps` (GET /jobs/{id} fps)? */
export function proxyPlays(fps: number | null | undefined): boolean {
  return typeof fps === "number" && fps > 0 && fps <= PROXY_MAX_FPS;
}

/** How far into a part a skip lands: one frame of the file (30 fps when unknown) and a hair. */
export function landOf(fps: number | null | undefined): number {
  return (fps && fps > 0 ? 1 / fps : 1 / 24) + 0.002;
}
