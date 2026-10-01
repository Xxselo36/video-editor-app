/**
 * Pure parts of the interim preview captions (UT1): where the caption
 * canvas sits over the <video>, which source time the playing frame shows,
 * and which words the engine gets. InterimOverlay.tsx wires them to the
 * DOM; the tests (interim.test.ts) cover them without one.
 */
import { migratePresetId, type CaptionStyle, type CaptionWord, type StyleRef } from "@/lib/captions";
import { phrasesToUnits, type TimedText } from "@/features/editor/legacy/phraseUnits";

export type Box = { x: number; y: number; w: number; h: number };

/**
 * The picture's box inside a video element of elW × elH showing a
 * vidW × vidH video with `object-fit: contain` (the <video> default):
 * scaled to fit, centred, letterboxed. Unknown video size → the element.
 */
export function contentBox(elW: number, elH: number, vidW: number, vidH: number): Box {
  if (!(elW > 0 && elH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  if (!(vidW > 0 && vidH > 0)) return { x: 0, y: 0, w: elW, h: elH };
  // The fitting side is the element's own (no rounding error there).
  const wide = elW / elH > vidW / vidH;
  const w = wide ? (vidW * elH) / vidH : elW;
  const h = wide ? elH : (vidH * elW) / vidW;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/** Canvas backing size in device pixels for a CSS box: × min(DPR, 2). */
export function canvasPixels(box: Box, dpr: number): { W: number; H: number; scale: number } {
  const scale = Math.min(Math.max(dpr || 1, 1), 2);
  return { W: Math.max(1, Math.round(box.w * scale)), H: Math.max(1, Math.round(box.h * scale)), scale };
}

export type PlaybackMode = "probing" | "proxy" | "preview";

/**
 * Source time of the playing frame — the review screen's `originalTime`:
 * the proxy's timeline IS the source; the server-built preview plays the
 * kept `segments` back to back, so its time maps back through them.
 */
export function videoToSource(
  t: number,
  mode: PlaybackMode,
  segments: readonly (readonly [number, number])[],
  duration: number,
): number {
  if (mode === "proxy" || !segments.length) return t;
  let acc = 0;
  for (const [s, e] of segments) {
    const d = e - s;
    if (acc + d >= t) return s + (t - acc);
    acc += d;
  }
  return duration;
}

/**
 * Cuts as page breaks on the source timeline: a caption page never holds
 * words from both sides of a cut (the v1 burn assigns each caption to one
 * clip too). Every edge of a played segment is a break.
 */
export function sourceBreaks(segments: readonly (readonly [number, number])[]): number[] {
  const out = new Set<number>();
  for (const [s, e] of segments) {
    out.add(s);
    out.add(e);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The words the engine draws, on the SOURCE timeline: the edited
 * sentences mapped back to the job's word units (phrasesToUnits, the same
 * units the render gets), each unit split into its words over the unit's
 * time proportional to their length (Whisper units hold 1–3 words; the
 * grid clip's hold a sentence).
 */
export function interimWords(phrases: readonly TimedText[], units: readonly TimedText[]): CaptionWord[] {
  const out: CaptionWord[] = [];
  const renderUnits = phrasesToUnits([...phrases], [...units]).sort(
    (a, b) => a.original_start - b.original_start || a.original_end - b.original_end,
  );
  renderUnits.forEach((u, ui) => {
    const words = u.text.split(/\s+/).filter(Boolean);
    const start = u.original_start;
    const dur = Math.max(0, u.original_end - start);
    const total = words.reduce((n, w) => n + [...w].length, 0) || 1;
    let at = 0;
    words.forEach((text, wi) => {
      const len = [...text].length;
      const s = start + (dur * at) / total;
      at += len;
      const e = wi === words.length - 1 ? u.original_end : start + (dur * at) / total;
      out.push({ id: `u${ui}w${wi}`, text, start: round(s), end: round(Math.max(s, e)) });
    });
  });
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Caption centre (0..1 of the frame) of the web's v1 presets (backend/pipeline.py WEB_SUB_POS, UX2). */
export const WEB_SUB_POS: Readonly<Record<string, number>> = { clean: 0.7, classic: 0.72, subtle: 0.76 };

/** The v2 style of a v1 job's caption preset, at the position the export uses. */
export function interimStyleRef(v1Preset: string | null | undefined): StyleRef {
  const ref = migratePresetId(v1Preset);
  const y = WEB_SUB_POS[(v1Preset ?? "").trim().toLowerCase()];
  if (y !== undefined) ref.overrides = { ...ref.overrides, y };
  return ref;
}

/**
 * The engine geometry a v1 preset's interim preview keeps although its v2
 * preset changed since (UT5 grew Power to the approved mock size). The
 * customer's export is still the v1 burn, so their preview must not grow
 * with it.
 */
const V1_GEOMETRY: Readonly<Record<string, { size: number; maxWidth: number }>> = {
  classic: { size: 0.09, maxWidth: 0.8 },
};

/** `style` with the font size / line width the v1 preset's preview had. */
export function pinV1Geometry<T extends CaptionStyle | null>(style: T, v1Preset: string | null | undefined): T {
  const g = V1_GEOMETRY[(v1Preset ?? "").trim().toLowerCase()];
  if (!style || !g) return style;
  return { ...style, font: { ...style.font, size: g.size }, layout: { ...style.layout, maxWidth: g.maxWidth } };
}

/** Text of a drawn page (test hook, change detection). */
export const pageText = (words: readonly { text: string }[]): string => words.map((w) => w.text).join(" ");
