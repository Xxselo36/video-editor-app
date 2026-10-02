/**
 * Pure parts of the live captions in the v2 editor (UT5): which words the
 * engine draws and on which timeline, the output time of the playing
 * frame, where a dragged caption snaps to, which captions have their own
 * position or size, and the Style panel's tile order. CaptionLayer.tsx and
 * StylePanel.tsx wire them to the DOM; live.test.ts covers them.
 *
 * The preview draws exactly what the export draws (backend/captions_v2.py):
 * the doc's shown words (a forced break of a hidden word carried to the
 * next shown one, as _visible_words does) mapped through the edit's clips
 * onto the OUTPUT timeline (timeline.ts mapToOutput = timeline_map.py), so
 * pages, cut breaks and the sync offset are the export's.
 */
import { LAUNCH_PRESETS, presetSupport, type Clip, type PresetId, type SourceWord } from "@/lib/captions";
import type { DocWord } from "@/features/editor/state/doc";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";

/** The doc's captioned words for the engine, with forced breaks of hidden words carried over. */
export function shownWords(words: readonly DocWord[]): SourceWord[] {
  const out: SourceWord[] = [];
  let carry = false;
  for (const w of words) {
    if (w.hidden || !w.text.trim()) {
      carry ||= !!w.breakBefore;
      continue;
    }
    const sw: SourceWord = { id: w.id, text: w.text, start: w.start, end: w.end };
    if (w.breakBefore || carry) sw.breakBefore = true;
    carry = false;
    out.push(sw);
  }
  return out;
}

/** The clips the export renders: the enabled segments in play order. */
export function clipsOf(segs: readonly EditorSeg[]): (Clip & { id: string })[] {
  return segs
    .filter((s) => !s.disabled && s.end - s.start > 1e-3)
    .map((s) => ({ id: s.id, start: s.start, end: s.end, speed: s.speed && s.speed > 0 ? s.speed : 1 }));
}

/**
 * Output time of source time `src`: in clip `segId` when given (the clip
 * the player is in — a source moment can be in two clips), else the first
 * clip holding it. Null when it is cut away.
 */
export function outputTime(clips: readonly (Clip & { id?: string })[], src: number, segId?: string | null): number | null {
  let acc = 0;
  let first: number | null = null;
  for (const c of clips) {
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const d = (c.end - c.start) / speed;
    const inside = src >= c.start - 1e-6 && src <= c.end + 1e-6;
    if (inside) {
      const t = acc + Math.min(d, Math.max(0, (src - c.start) / speed));
      if (segId && c.id === segId) return t;
      if (first === null && src < c.end) first = t;
    }
    acc += d;
  }
  return first;
}

/**
 * Snap lines of a dragged caption (DF mock: 56 / 70 / 79 % of the frame,
 * 70 % being the style's own position there): the style's own y takes the
 * place of a mock line near it, else joins them.
 */
export function snapLines(styleY: number): number[] {
  const ys = [0.56, 0.7, 0.79].filter((y) => Math.abs(y - styleY) >= 0.03);
  return [...ys, styleY].sort((a, b) => a - b);
}

/** y snapped to the nearest line within `within` (0..1 of the frame), clamped to the frame. */
export function snapY(y: number, lines: readonly number[], within = 0.015): { y: number; line: number | null } {
  let best: number | null = null;
  for (const l of lines) if (Math.abs(l - y) <= within && (best === null || Math.abs(l - y) < Math.abs(best - y))) best = l;
  return { y: Math.min(0.95, Math.max(0.05, best ?? y)), line: best };
}

/** The next snap line below (click on the move handle cycles through them). */
export function nextLine(y: number, lines: readonly number[]): number {
  const i = lines.findIndex((l) => l > y + 0.005);
  return i >= 0 ? lines[i] : lines[0];
}

/** Size steps a click on the corner handle cycles through (DF mock). */
export const SIZE_STEPS = [0.9, 1, 1.15] as const;
export function nextSize(scale: number): number {
  const i = SIZE_STEPS.findIndex((s) => s > scale + 0.005);
  return i >= 0 ? SIZE_STEPS[i] : SIZE_STEPS[0];
}

export type TileInfo = { id: PresetId; available: boolean; fallback: boolean };

/**
 * The Style panel's tiles: up to three recommended ones on top (the
 * server's order), the rest in the launch order. Only live presets; a
 * preset that can't caption the transcript's script is greyed, never
 * recommended.
 */
export function tileOrder(live: readonly string[] | null, recommended: readonly string[], lang: string | null | undefined) {
  const isLive = (id: string) => !live || live.includes(id);
  const info = (id: PresetId): TileInfo => {
    const level = presetSupport(id, lang).level;
    return { id, available: level !== "unavailable", fallback: level === "fallback" };
  };
  const all = LAUNCH_PRESETS.filter(isLive).map(info);
  const rec = recommended
    .map((id) => all.find((t) => t.id === id && t.available))
    .filter((t): t is TileInfo => !!t)
    .slice(0, 3);
  const rest = all.filter((t) => !rec.includes(t));
  return { recommended: rec, rest };
}

/**
 * The frame the style is resolved on: the video's own size (its aspect
 * picks the default position, presets.ts defaultY), as the export does —
 * not the rounded canvas size, which can land on the other side of an
 * aspect threshold (4:5 → 0.8001). The canvas until the metadata is in.
 */
export function frameOf(L: { W: number; H: number; vw: number; vh: number }): { W: number; H: number } {
  return L.vw > 0 && L.vh > 0 ? { W: L.vw, H: L.vh } : { W: L.W, H: L.H };
}

/**
 * "Überall" writes only what the user changed (review 6/11): a resize
 * doesn't pin the style's y (another preset keeps its own position), a
 * move doesn't pin its size.
 */
export function changedOf(
  next: { y?: number; sizeScale?: number },
  now: { y: number; sizeScale: number },
): { y?: number; sizeScale?: number } {
  const out: { y?: number; sizeScale?: number } = {};
  if (next.y !== undefined && Math.abs(next.y - now.y) >= 5e-4) out.y = next.y;
  if (next.sizeScale !== undefined && Math.abs(next.sizeScale - now.sizeScale) >= 5e-3) out.sizeScale = next.sizeScale;
  return out;
}

/**
 * Does Escape belong to the caption layer (review 8)? Only while a drag
 * runs, or when focus is inside the layer (its handles, its bar): an
 * Escape in the Text tab, the title or a menu is theirs.
 */
export function ownsEscape(
  dragging: boolean,
  active: unknown,
  layer: { contains(node: never): boolean } | null,
  bar: { contains(node: never): boolean } | null = null,
): boolean {
  if (dragging) return true;
  if (!active) return false;
  return !!(layer?.contains(active as never) || bar?.contains(active as never));
}
