/**
 * The launch caption styles (UT2; PLAN 3.5, owner decisions 2026-09-30).
 *
 * Twelve presets plus "none". Default for new users: power. Values come
 * from the audited lab presets (G1 gallery). Sizes are × the frame's short
 * side; stroke, shadow, glow and boxes are × the font size; y is the centre
 * of the text block (0 top, 1 bottom) for portrait frames.
 *
 * Display names are i18n keys (`captions.preset.<id>.name` / `.desc`);
 * presetNames.ts holds interim German/English names until UT5 wires i18n.
 *
 * `status` comes from the live list (CLEO_CAPTION_PRESETS_LIVE, served by
 * GET /config after UX5): only live presets are offered in the Style panel
 * and accepted by the v2 render; the rest are "preview" (test page only).
 */
import type { CaptionAdjust, CaptionStyle, PresetId, StyleOverrides } from "./types";

export const DEFAULT_PRESET: PresetId = "power";

/** Tile order in the Style panel (UT5 puts recommended ones first). */
export const LAUNCH_PRESETS = [
  "power",
  "mega",
  "clipper",
  "karaoke",
  "boxed",
  "punch",
  "reveal",
  "neon",
  "gradient",
  "elegant",
  "subtitle",
  "minimal",
] as const satisfies readonly PresetId[];

export const PRESET_IDS: readonly PresetId[] = [...LAUNCH_PRESETS, "none"];

/**
 * Live by default: all twelve (UT5 — every preset is in the parity suite,
 * __tests__/parity.test.ts). CLEO_CAPTION_PRESETS_LIVE narrows it on the
 * server; the editor gets the server's list with the doc.
 */
export const DEFAULT_LIVE_PRESETS = "power,mega,clipper,karaoke,boxed,punch,reveal,neon,gradient,elegant,subtitle,minimal";

type PresetDef = Omit<CaptionStyle, "presetId">;

const layout = (o: Partial<CaptionStyle["layout"]> = {}): CaptionStyle["layout"] => ({
  x: 0.5,
  y: 0.68,
  maxWidth: 0.8,
  wordsPerLine: 3,
  maxLines: 2,
  wordSpacing: 1,
  maxGapSec: 0.6,
  ...o,
});
const anim = (o: Partial<CaptionStyle["animation"]>): CaptionStyle["animation"] => ({
  pageIn: "none",
  pageInSec: 0.12,
  wordIn: "none",
  wordInSec: 0.12,
  ...o,
});
const HOLD = { holdSec: 0.35 };

const PRESETS: Record<Exclude<PresetId, "none">, PresetDef> = {
  // Bold upper case, thick black outline, the spoken word yellow, numbers green.
  power: {
    font: { id: "montserrat-900", size: 0.09, case: "upper", lineHeight: 1.08 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.11 },
    shadow: { color: "#000000", opacity: 0.8, dx: 0, dy: 0.05, blur: 0 },
    highlight: { mode: "color", color: "#FFE600" },
    reveal: "page",
    emphasis: { color: "#22E55B" },
    animation: anim({ pageIn: "pop", pageInSec: 0.12 }),
    layout: layout({ wordsPerLine: 3, maxLines: 2, wordSpacing: 1.25 }),
    timing: HOLD,
  },
  // Loud comic capitals, slightly slanted, hard shadow; the active word jumps bigger.
  mega: {
    font: { id: "luckiest-guy-400", size: 0.105, case: "upper", lineHeight: 1.05 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.13 },
    shadow: { color: "#000000", opacity: 1, dx: 0.04, dy: 0.07, blur: 0 },
    highlight: { mode: "scale", color: "#FFE14D", scale: 1.14 },
    reveal: "page",
    emphasis: null,
    transform: { skewDeg: -6 },
    animation: anim({ pageIn: "pop", pageInSec: 0.14, wordIn: "pop", wordInSec: 0.1 }),
    layout: layout({ wordsPerLine: 2, maxLines: 2 }),
    timing: HOLD,
  },
  // The existing TikTok style, fixed: Bangers, active word neon green, one
  // line, fixed size (pages are cut by width, never shrunk).
  clipper: {
    font: { id: "bangers-400", size: 0.1, case: "upper", lineHeight: 1.05 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.1 },
    highlight: { mode: "color", color: "#39FF14" },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "pop", pageInSec: 0.15 }),
    layout: layout({ wordsPerLine: 3, maxLines: 1, wordSpacing: 1.4 }),
    timing: HOLD,
  },
  // The whole line is visible; spoken words fill with yellow.
  karaoke: {
    font: { id: "poppins-800", size: 0.078, case: "none", lineHeight: 1.15 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.1 },
    shadow: { color: "#000000", opacity: 0.5, dx: 0, dy: 0.04, blur: 0.08 },
    highlight: { mode: "karaoke", color: "#FFD400" },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "fade", pageInSec: 0.1 }),
    layout: layout({ wordsPerLine: 4, maxLines: 2, maxGapSec: 0.8, wordSpacing: 1.3 }),
    timing: HOLD,
  },
  // The active word sits on a rounded box in brand violet.
  boxed: {
    font: { id: "montserrat-800", size: 0.1, case: "upper", lineHeight: 1.22 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.06 },
    highlight: { mode: "box", boxColor: "#7C3AED", textColor: "#FFFFFF", radius: 0.2, padX: 0.16, padY: 0.1 },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "pop", pageInSec: 0.12 }),
    layout: layout({ wordsPerLine: 3, maxLines: 2 }),
    timing: HOLD,
  },
  // One big word after the other; numbers yellow.
  punch: {
    font: { id: "anton-400", size: 0.15, case: "upper", lineHeight: 1 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.07 },
    shadow: { color: "#000000", opacity: 0.6, dx: 0, dy: 0.04, blur: 0.12 },
    highlight: { mode: "none" },
    reveal: "page",
    emphasis: { color: "#FFE600" },
    animation: anim({ pageIn: "pop", pageInSec: 0.09 }),
    layout: layout({ y: 0.62, wordsPerLine: 1, maxLines: 1 }),
    timing: { holdSec: 0.15 },
  },
  // Words appear as they are spoken; the active word is turquoise.
  reveal: {
    font: { id: "poppins-800", size: 0.09, case: "none", lineHeight: 1.12 },
    fill: { color: "#FFFFFF" },
    stroke: { color: "#000000", width: 0.08 },
    shadow: { color: "#000000", opacity: 0.45, dx: 0, dy: 0.04, blur: 0.1 },
    highlight: { mode: "color", color: "#7CF3FF" },
    reveal: "word",
    emphasis: null,
    animation: anim({ pageIn: "none", wordIn: "pop", wordInSec: 0.11 }),
    layout: layout({ wordsPerLine: 3, maxLines: 2 }),
    timing: HOLD,
  },
  // Cyan glow; the active word pale yellow with a pop.
  neon: {
    font: { id: "rubik-800", size: 0.095, case: "upper", lineHeight: 1.1 },
    fill: { color: "#FFFFFF" },
    glow: { color: "#00E5FF", blur: 0.28, passes: 2 },
    highlight: { mode: "color", color: "#FFF36B" },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "fade", pageInSec: 0.1, wordIn: "pop", wordInSec: 0.1 }),
    layout: layout({ wordsPerLine: 3, maxLines: 2 }),
    timing: HOLD,
  },
  // "Sunset": yellow-to-coral gradient in heavy capitals.
  gradient: {
    font: { id: "poppins-900", size: 0.085, case: "upper", lineHeight: 1.05 },
    fill: { color: "#FFFFFF", gradient: ["#FFD36E", "#FF5E62"] },
    stroke: { color: "#1A0B2E", width: 0.09 },
    shadow: { color: "#000000", opacity: 0.55, dx: 0, dy: 0.05, blur: 0.06 },
    highlight: { mode: "scale", scale: 1.1 },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "pop", pageInSec: 0.12 }),
    layout: layout({ wordsPerLine: 2, maxLines: 2 }),
    timing: HOLD,
  },
  // Serif italic, soft fade-in word by word, numbers in gold.
  elegant: {
    font: { id: "playfair-display-800i", size: 0.088, case: "none", lineHeight: 1.15 },
    fill: { color: "#FFFFFF" },
    shadow: { color: "#000000", opacity: 0.6, dx: 0, dy: 0.03, blur: 0.2 },
    highlight: { mode: "none" },
    reveal: "word",
    emphasis: { color: "#E8B04A" },
    animation: anim({ pageIn: "none", wordIn: "fade", wordInSec: 0.14 }),
    layout: layout({ wordsPerLine: 4, maxLines: 2 }),
    timing: HOLD,
  },
  // Classic subtitles on a translucent black bar, 1–2 lines, normal case.
  subtitle: {
    font: { id: "inter-display-700", size: 0.056, case: "none", lineHeight: 1.3 },
    fill: { color: "#FFFFFF" },
    box: { mode: "line", color: "#000000", opacity: 0.72, radius: 0.25, padX: 0.35, padY: 0.12 },
    highlight: { mode: "none" },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "fade", pageInSec: 0.08 }),
    layout: layout({ y: 0.72, wordsPerLine: 7, maxLines: 2, maxGapSec: 1 }),
    timing: { holdSec: 0.6 },
  },
  // Plain white text with a soft shadow, no effects.
  minimal: {
    font: { id: "inter-display-700", size: 0.058, case: "none", lineHeight: 1.2 },
    fill: { color: "#FFFFFF" },
    shadow: { color: "#000000", opacity: 0.75, dx: 0, dy: 0.03, blur: 0.25 },
    highlight: { mode: "none" },
    reveal: "page",
    emphasis: null,
    animation: anim({ pageIn: "fade", pageInSec: 0.1 }),
    layout: layout({ y: 0.74, wordsPerLine: 6, maxLines: 2, maxGapSec: 1 }),
    timing: { holdSec: 0.5 },
  },
};

export function isPresetId(id: unknown): id is PresetId {
  return typeof id === "string" && (PRESET_IDS as readonly string[]).includes(id);
}

/** The preset's own style (no overrides, portrait position). */
export function getPreset(id: PresetId): CaptionStyle | null {
  if (id === "none") return null;
  const def = PRESETS[id];
  return structuredCloneStyle({ presetId: id, ...def });
}

function structuredCloneStyle(s: CaptionStyle): CaptionStyle {
  return JSON.parse(JSON.stringify(s)) as CaptionStyle;
}

export type PresetStatus = "live" | "preview";

/** "clipper,power" → ["clipper", "power"]; "all" / "*" → every launch preset. */
export function parseLiveList(value: string | null | undefined): PresetId[] {
  const raw = (value ?? DEFAULT_LIVE_PRESETS).trim();
  if (raw === "all" || raw === "*") return [...PRESET_IDS];
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(isPresetId);
  return ids.includes("none") ? ids : [...ids, "none"];
}

export function presetStatus(id: PresetId, live: readonly string[]): PresetStatus {
  return id === "none" || live.includes(id) ? "live" : "preview";
}

export type PresetInfo = {
  id: PresetId;
  status: PresetStatus;
  nameKey: `captions.preset.${PresetId}.name`;
  descKey: `captions.preset.${PresetId}.desc`;
  /** Does "highlight colour" change anything for this preset? */
  hasHighlight: boolean;
  /** Does the preset colour numbers? */
  hasEmphasis: boolean;
};

export function listPresets(live: readonly string[] = parseLiveList(undefined)): PresetInfo[] {
  return PRESET_IDS.map((id) => ({
    id,
    status: presetStatus(id, live),
    nameKey: `captions.preset.${id}.name` as const,
    descKey: `captions.preset.${id}.desc` as const,
    hasHighlight: id !== "none" && PRESETS[id].highlight.mode !== "none",
    hasEmphasis: id !== "none" && PRESETS[id].emphasis !== null,
  }));
}

/** Frame shape → default block centre y (review: 9:16 → 0.68, 16:9 → 0.85). */
export function defaultY(presetY: number, W: number, H: number): number {
  const r = W / H;
  if (r >= 1.25) return 0.85;
  if (r > 0.8) return 0.8;
  return presetY;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Per-caption adjustments, clamped like the style's own y / sizeScale; null when there are none. */
export function captionAdjusts(value: unknown): Record<string, CaptionAdjust> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, CaptionAdjust> = {};
  let n = 0;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const adj: CaptionAdjust = {};
    if (finite(a.y)) adj.y = clamp(a.y, 0.05, 0.95);
    if (finite(a.sizeScale)) adj.sizeScale = clamp(a.sizeScale, 0.6, 1.6);
    if (adj.y === undefined && adj.sizeScale === undefined) continue;
    out[id] = adj;
    n++;
  }
  return n ? out : null;
}
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The style to draw: preset + per-video overrides, for a frame of W×H.
 * Returns null for "none". Unknown preset ids fall back to the default.
 * (offsetMs is a timing override: see timeline.ts `mapToOutput`.)
 */
export function resolveStyle(
  presetId: string,
  overrides: StyleOverrides = {},
  frame: { W: number; H: number } = { W: 1080, H: 1920 },
): CaptionStyle | null {
  const id: PresetId = isPresetId(presetId) ? presetId : DEFAULT_PRESET;
  const s = getPreset(id);
  if (!s) return null;
  const o = overrides ?? {};
  s.layout.y = typeof o.y === "number" && Number.isFinite(o.y) ? clamp(o.y, 0.05, 0.95) : defaultY(s.layout.y, frame.W, frame.H);
  if (typeof o.sizeScale === "number" && Number.isFinite(o.sizeScale)) {
    s.sizeScale = clamp(o.sizeScale, 0.6, 1.6);
    s.font.size *= s.sizeScale;
  }
  const captions = captionAdjusts(o.captions);
  if (captions) s.captions = captions;
  if (o.wordsPerPage === 1 || o.wordsPerPage === 2 || o.wordsPerPage === 3) {
    s.layout.maxWords = o.wordsPerPage;
    if (o.wordsPerPage === 1) {
      s.layout.wordsPerLine = 1;
      s.layout.maxLines = 1;
    }
  }
  if (o.case === "none" || o.case === "upper") s.font.case = o.case;
  if (o.textColor && HEX.test(o.textColor)) s.fill = { color: o.textColor };
  if (o.highlightColor && HEX.test(o.highlightColor)) {
    const h = s.highlight;
    if (h.mode === "box") h.boxColor = o.highlightColor;
    else if (h.mode !== "none") h.color = o.highlightColor;
  }
  if (o.animation === "none" || o.animation === "pop" || o.animation === "fade") {
    const a = s.animation;
    if (s.reveal === "word") {
      // words appear one by one: the choice is how each word comes in
      a.pageIn = "none";
      a.wordIn = o.animation;
    } else {
      // the page comes in; an active-word pop stays only with "pop"
      a.wordIn = a.wordIn === "pop" && o.animation === "pop" ? "pop" : "none";
      a.pageIn = o.animation;
      a.pageInSec = o.animation === "pop" ? Math.max(a.pageInSec, 0.12) : 0.1;
    }
  }
  return s;
}
