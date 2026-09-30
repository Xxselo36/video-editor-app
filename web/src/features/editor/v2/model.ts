/**
 * Pure helpers of the v2 shell (UX7a): what the header, the transcript
 * gutter and the timeline seams show about the edit. Times are SOURCE
 * seconds unless named "cut" (the clips laid end to end, like the strip
 * and the player clock). Speed is not applied, as in the v1 clock.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";

/** Clips that play, in timeline order. */
export function activeClips(segs: EditorSeg[]): EditorSeg[] {
  return segs.filter((s) => !s.disabled && s.end - s.start > 0);
}

/** Length of the edit (cut timeline). */
export function cutDuration(segs: EditorSeg[]): number {
  return activeClips(segs).reduce((a, s) => a + (s.end - s.start), 0);
}

export type RemovedRange = { start: number; end: number };

/**
 * Source ranges no clip plays (the AI's and the user's cuts), ≥ `min`
 * seconds, sorted. A range another clip still plays (a moved clip) is
 * not removed.
 */
export function removedRanges(segs: EditorSeg[], duration: number, min = 0.05): RemovedRange[] {
  const kept = activeClips(segs)
    .map((s) => [Math.max(0, s.start), Math.min(duration || s.end, s.end)] as const)
    .sort((a, b) => a[0] - b[0]);
  const out: RemovedRange[] = [];
  let cursor = 0;
  for (const [s, e] of kept) {
    if (s - cursor >= min) out.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (duration - cursor >= min) out.push({ start: cursor, end: duration });
  return out;
}

export type Seam = {
  /** Cut-timeline position of the boundary. */
  at: number;
  /** Removed source footage between the two clips (0 for a split). */
  gap: number;
  /** The clips' source isn't contiguous. */
  cut: boolean;
};

/** The boundaries between consecutive clips of the strip. */
export function seams(segs: EditorSeg[]): Seam[] {
  const clips = activeClips(segs);
  const out: Seam[] = [];
  let acc = 0;
  for (let i = 0; i < clips.length - 1; i++) {
    acc += clips[i].end - clips[i].start;
    const gap = clips[i + 1].start - clips[i].end;
    out.push({ at: acc, gap: Math.max(0, gap), cut: Math.abs(gap) > 0.02 });
  }
  return out;
}

/**
 * Where source time t lands on the cut timeline: inside a clip, else the
 * start of the next clip that plays after it (its footage is cut), else
 * the end. For the transcript's time gutter.
 */
export function cutTimeOfSource(segs: EditorSeg[], t: number): number {
  let acc = 0;
  let next: number | null = null;
  let bestStart = Infinity;
  for (const s of activeClips(segs)) {
    if (t >= s.start && t <= s.end) return acc + (t - s.start);
    if (s.start > t && s.start < bestStart) {
      bestStart = s.start;
      next = acc;
    }
    acc += s.end - s.start;
  }
  return next ?? acc;
}

/** m:ss for labels. */
export function fmtClock(s: number): string {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** m:ss,t / m:ss.t with the language's decimal separator (player clock). */
export function fmtClockTenths(s: number, decimal: string): string {
  const tenths = Math.round(Math.max(0, s) * 10);
  const m = Math.floor(tenths / 600);
  const sec = Math.floor((tenths % 600) / 10);
  return `${m}:${sec.toString().padStart(2, "0")}${decimal}${tenths % 10}`;
}

/** Seconds with one decimal ("0,9 s" / "0.9 s"). */
export function fmtSeconds(s: number, decimal: string): string {
  return `${(Math.round(s * 10) / 10).toFixed(1).replace(".", decimal)} s`;
}

/** The decimal separator of a language ("," for de, "." for en). */
export function decimalSeparator(lang: string): string {
  try {
    return (1.5).toLocaleString(lang).charAt(1) || ".";
  } catch {
    return ".";
  }
}

/** Largest frame of `aspect` (w/h) inside availW × availH, integer px. */
export function fitFrame(availW: number, availH: number, aspect: number): { w: number; h: number } {
  if (!(availW > 0) || !(availH > 0) || !(aspect > 0)) return { w: 0, h: 0 };
  let h = availH;
  let w = h * aspect;
  if (w > availW) {
    w = availW;
    h = w / aspect;
  }
  return { w: Math.floor(w), h: Math.floor(h) };
}

/** The phone's preview: 186×330 at most (DF round 3), smaller when the
 *  screen is short, so the dock keeps this much height. */
export const PHONE_FRAME_MAX = { w: 186, h: 330 };
export const PHONE_DOCK_MIN = 150;

/**
 * Preview frame size of the phone layout from the editor's size.
 *   portrait   top bar 44 · 12 + frame + 12 + player row 44 · dock ≥ 150 ·
 *              tab bar; with a sheet open the frame fits above the sheet
 *              (54 % of the height) instead, the player row hidden.
 *   landscape  the frame and player row fill the left column between the
 *              top bar and the tab bar.
 */
export function phoneFrame(
  rootW: number,
  rootH: number,
  opts: { landscape: boolean; sheetOpen: boolean; tabH: number },
): { w: number; h: number } {
  let h: number;
  if (opts.landscape) h = rootH - 44 - opts.tabH - 8 - 4 - 44 - 8;
  else if (opts.sheetOpen) h = rootH * 0.46 - 44 - 14;
  else h = rootH - 44 - opts.tabH - PHONE_DOCK_MIN - (12 + 12 + 44);
  h = Math.max(96, Math.min(PHONE_FRAME_MAX.h, Math.floor(h)));
  let w = Math.min(PHONE_FRAME_MAX.w, Math.round((h * 9) / 16));
  if (!opts.landscape && w > rootW - 32) {
    w = Math.max(54, rootW - 32);
    h = Math.round((w * 16) / 9);
  }
  return { w, h };
}

/**
 * Where the video's picture sits in the output frame: "contain" pads it
 * (black bars), like the export's pad for a non-reframed video;
 * "cover" crops it, like a SmartCam reframe (centre crop as the preview's
 * approximation).
 */
export function videoBox(
  frameW: number,
  frameH: number,
  videoW: number,
  videoH: number,
  fit: "contain" | "cover",
): { x: number; y: number; w: number; h: number } {
  if (!(videoW > 0) || !(videoH > 0)) return { x: 0, y: 0, w: frameW, h: frameH };
  const scale = fit === "contain" ? Math.min(frameW / videoW, frameH / videoH) : Math.max(frameW / videoW, frameH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h };
}
