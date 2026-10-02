/**
 * Caption engine v2 — shared types (UT2).
 *
 * The engine is pure TypeScript: no DOM and no Node imports. It draws
 * through the small `Ctx2D` interface, which both the browser's
 * CanvasRenderingContext2D and @napi-rs/canvas (render worker, UT4)
 * satisfy. Everything is relative to the frame: sizes × the frame's short
 * side, positions 0..1 of the frame, so 1080×1920, 540×960 and 1920×1080
 * give the same look.
 */

/** A word on the OUTPUT timeline (seconds), as the engine consumes it. */
export type CaptionWord = {
  /** Stable word id (EditDoc `Word.id`); carried into pages and hit tests. */
  id?: string;
  text: string;
  start: number;
  end: number;
  /** User-forced page break before this word. */
  breakBefore?: boolean;
};

/** Writing systems the engine and the font set know about. */
export type Script = "latin" | "cyrillic" | "devanagari" | "cjk" | "rtl";

export type Aspect = "9:16" | "16:9" | "original";

export type PresetId =
  | "power"
  | "mega"
  | "clipper"
  | "karaoke"
  | "boxed"
  | "punch"
  | "reveal"
  | "neon"
  | "gradient"
  | "elegant"
  | "subtitle"
  | "minimal"
  | "none";

export type HighlightMode = "none" | "color" | "box" | "scale" | "karaoke";
export type AnimationKind = "none" | "pop" | "fade";

/**
 * A fully resolved style. Sizes are × the frame's short side (font.size)
 * or × the font size (stroke, shadow, glow, boxes, paddings).
 */
export type CaptionStyle = {
  /** The preset this style was resolved from. */
  presetId: PresetId;
  font: {
    /** Font id from fonts.json (e.g. "montserrat-900"). */
    id: string;
    size: number;
    case: "none" | "upper";
    lineHeight: number;
  };
  fill: { color: string; gradient?: readonly [string, string] };
  stroke?: { color: string; width: number };
  shadow?: { color: string; opacity: number; dx: number; dy: number; blur: number };
  glow?: { color: string; blur: number; passes: number };
  box?: { mode: "line" | "page"; color: string; opacity: number; radius: number; padX: number; padY: number };
  /** How the ACTIVE word (the one being spoken) is marked. */
  highlight: {
    mode: HighlightMode;
    color?: string;
    boxColor?: string;
    textColor?: string;
    scale?: number;
    radius?: number;
    padX?: number;
    padY?: number;
  };
  /** Words not spoken yet (e.g. dimmed). */
  upcoming?: { opacity: number };
  /** "word": words appear one by one as they are spoken. */
  reveal: "page" | "word";
  /** Colour for numbers (emphasis.ts); null = numbers look like any word. */
  emphasis: { color: string } | null;
  animation: { pageIn: AnimationKind; pageInSec: number; wordIn: AnimationKind; wordInSec: number };
  transform?: { skewDeg: number };
  layout: {
    /** Centre of the text block, 0..1 of the frame. */
    x: number;
    y: number;
    /** × frame width. */
    maxWidth: number;
    wordsPerLine: number;
    maxLines: number;
    /** Hard cap per page (the "words per caption" override); default wordsPerLine × maxLines. */
    maxWords?: number;
    /** × the primary font's space advance. */
    wordSpacing: number;
    /** A pause longer than this always starts a new page. */
    maxGapSec: number;
  };
  timing: { holdSec: number };
  /** The size scale the style's own "size" override applied (1 when unset). */
  sizeScale?: number;
  /**
   * Per-caption position and size (UT5), by caption id: the id of the
   * caption page's first word. Only present when some caption has one.
   */
  captions?: Readonly<Record<string, CaptionAdjust>>;
};

/**
 * One caption's own position and size (UT5, "Nur hier"): `y` is the centre
 * of its text block (0..1 of the frame), `sizeScale` its size against the
 * preset (0.6–1.6), replacing the style's own y / sizeScale for that caption.
 */
export type CaptionAdjust = { y?: number; sizeScale?: number };

/** Per-video overrides (EditDoc `style.overrides`, launch set, review G3). */
export type StyleOverrides = Partial<{
  y: number;
  sizeScale: number;
  wordsPerPage: 1 | 2 | 3 | "auto";
  case: "none" | "upper";
  textColor: string;
  highlightColor: string;
  animation: AnimationKind;
  offsetMs: number;
  /** Per-caption position / size by caption id (UT5; backend/doc.py validate_overrides). */
  captions: Record<string, CaptionAdjust>;
}>;

export type StyleRef = { presetId: string; overrides: StyleOverrides };

/** A word placed on a page (display text already cased). */
export type PageWord = {
  /** Index into the words the pages were built from. */
  index: number;
  id?: string;
  /** Original text (emphasis, hit tests). */
  source: string;
  /** Text as drawn (case mapping applied, NFC). */
  text: string;
  start: number;
  end: number;
  emphasis: boolean;
  /** Script used to pick the font face order for this word. */
  script: Script;
  /** Width in em of the style's font size (metric tables). */
  em: number;
  /** Space before the NEXT word in em (0 between two CJK words). */
  spaceAfterEm: number;
  /** Some character had no metrics: `em` is an estimate. */
  approximate?: boolean;
};

export type Page = {
  index: number;
  words: PageWord[];
  start: number;
  end: number;
  /** A single word wider than the line: this page alone gets a smaller font. */
  oversized: boolean;
  /** The caption's own position / size (style.captions), keyed by `id`. */
  adjust?: CaptionAdjust & { id: string };
};

export type WordBox = {
  /** Index within the page. */
  k: number;
  text: string;
  x: number;
  width: number;
  baseline: number;
  /** Font size in px for this word. */
  px: number;
};

export type LineBox = {
  words: WordBox[];
  left: number;
  right: number;
  baseline: number;
};

export type PageLayout = {
  W: number;
  H: number;
  /** Font size in px (the style's size, or smaller on an oversized page). */
  px: number;
  lineH: number;
  /** Cap height in px (primary font) — used to place boxes. */
  capH: number;
  cx: number;
  cy: number;
  lines: LineBox[];
  /** Text block bounds (no effects), in px. */
  box: { left: number; top: number; right: number; bottom: number };
  /** True if some character had no metrics (deferred CJK font, emoji): widths are estimates. */
  approximate: boolean;
};

/**
 * The subset of CanvasRenderingContext2D the engine uses. Structural, so
 * the DOM context, OffscreenCanvasRenderingContext2D and @napi-rs/canvas's
 * SKRSContext2D all fit.
 */
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fill(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  /**
   * Optional: draw.ts measures each word at its draw font and compresses a
   * word the rasterizer draws wider than its layout box (fitScale).
   */
  measureText?(text: string): { width: number };
  /** Optional: draw.ts snaps text baselines to device pixels with it. */
  getTransform?(): { a: number; b: number; c: number; d: number; e: number; f: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike;
  // drawImage is typed loosely: every backend has its own image types.
  drawImage(image: never, dx: number, dy: number): void;
  globalAlpha: number;
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  miterLimit: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  textBaseline: string;
  textAlign: string;
}

export interface GradientLike {
  addColorStop(offset: number, color: string): void;
}

/** An offscreen surface for the bitmap cache (cache.ts). */
export type Surface = { canvas: unknown; ctx: Ctx2D };
/** Creates offscreen surfaces: document canvas / OffscreenCanvas in the browser, createCanvas in Node. */
export type SurfaceFactory = (width: number, height: number) => Surface;
