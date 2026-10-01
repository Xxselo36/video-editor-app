/**
 * The render worker's caption layer (UT4): the editor's caption engine,
 * drawn frame by frame with @napi-rs/canvas into a band of the output
 * frame, for ffmpeg's `overlay` (backend/captions_v2.py).
 *
 * - Same code as the editor: resolveStyle → buildPages → CaptionRenderer
 *   (bitmap cache) → drawFrame, the same fonts.json metrics and the same
 *   font files (web/public/fonts/captions, plus the job's CJK subset .ttf
 *   from UT3), so pages, line breaks and word positions are the preview's.
 * - Output time `t` of frame n is n / fps: the time of the frame the
 *   browser presents (requestVideoFrameCallback mediaTime) on a CFR video.
 * - Only the BAND is emitted: the union of every page's bounds
 *   (draw.ts pageBounds, which covers animations and effects), rounded to
 *   even rows. A frame whose state did not change re-sends the previous
 *   buffer (no draw, no readback).
 * - Pixels are `canvas.data()`: RGBA, premultiplied alpha (ffmpeg
 *   `overlay=…:alpha=premultiplied`).
 *
 * No process / stdin / stdout here: render-layer.ts is the CLI around it,
 * and the vitest suites drive these functions directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CaptionRenderer } from "../cache";
import { pageBounds } from "../draw";
import { frameState } from "../engine";
import { ensureFonts, registerCaptionFont, setDefaultFontLoader, stripUndrawable, type FontStatus } from "../fonts";
import { layoutJSON } from "../layout";
import { setFontTables, type FontJson, type FontTables } from "../metrics";
import { resolveStyle } from "../presets";
import type { CaptionStyle, CaptionWord, Ctx2D, PageWord, StyleOverrides, Surface } from "../types";
import fontsJson from "../fonts.json";
import { nodeFontLoader, type GlobalFontsLike } from "./fonts";

export const LAYER_VERSION = 1;

export type Band = { top: number; height: number };

export type LayerInput = {
  /** Words on the OUTPUT timeline (backend/timeline_map.py map_to_output). */
  words: CaptionWord[];
  /** Output times of cuts: hard page breaks. */
  breaks?: number[];
  /** {presetId, overrides}; presetId "none" (or null) draws nothing. */
  style: { presetId: string; overrides?: StyleOverrides } | null;
  lang?: string;
  W: number;
  H: number;
  fps: number;
  /** Number of output frames. */
  frames: number;
  /** Band to emit (render mode); the plan computes it. */
  band?: Band | null;
  /** Directory of the shipped caption fonts (web/public/fonts/captions). */
  fontsDir: string;
  /** The job's CJK subsets (UT3): metrics JSON and the .ttf to draw with. */
  fonts?: { id: string; json: string; file: string }[];
  /** Write a trace JSON here (frame ranges → page, active word). */
  trace?: string;
};

export type LayerPlan = {
  v: number;
  band: Band | null;
  pages: number;
  presetId: string | null;
  fonts: FontStatus | null;
  approximate: boolean;
  /** Emoji / symbols no caption font has, stripped from the drawn text (fonts.ts stripUndrawable). */
  stripped: number;
  layout: ReturnType<typeof layoutJSON>[];
};

export type CanvasLike = {
  getContext(type: "2d"): unknown;
  data(): Uint8Array;
};

export type LayerDeps = {
  createCanvas(width: number, height: number): CanvasLike;
  GlobalFonts: GlobalFontsLike;
};

export type Prepared = {
  input: LayerInput;
  style: CaptionStyle | null;
  renderer: CaptionRenderer | null;
  plan: LayerPlan;
};

const YIELD_EVERY = 16;

/**
 * What the layer can't draw with its own fonts: characters no face
 * covers, or a CJK font that isn't registered (the job's subset is
 * missing). "" when everything is covered. The CLI exits 4 on it.
 */
export function missingGlyphs(fonts: FontStatus | null): string {
  if (!fonts) return "";
  const parts = [...fonts.uncovered];
  for (const id of fonts.deferred) parts.push(`(font ${id} not loaded)`);
  return parts.join(" ");
}

const even = (v: number, up: boolean) => (up ? Math.ceil(v / 2) * 2 : Math.floor(v / 2) * 2);

/** Loads tables and fonts, builds the pages and the band. */
export async function prepare(input: LayerInput, deps: LayerDeps): Promise<Prepared> {
  setFontTables(fontsJson as unknown as FontTables);
  for (const f of input.fonts ?? []) {
    const json = JSON.parse(readFileSync(f.json, "utf8")) as FontJson;
    // Draw with the .ttf (same glyphs as the browser's woff2): the face's
    // file becomes the absolute path nodeFontLoader registers.
    for (const sub of Object.values(json.subsets)) sub.file = f.file;
    registerCaptionFont(f.id, json);
  }
  const loader = nodeFontLoader(deps.GlobalFonts, { fontsDir: input.fontsDir });
  setDefaultFontLoader(loader);
  const { W, H, lang } = input;
  const style = input.style ? resolveStyle(input.style.presetId, input.style.overrides ?? {}, { W, H }) : null;
  const empty: LayerPlan = {
    v: LAYER_VERSION,
    band: null,
    pages: 0,
    presetId: style?.presetId ?? null,
    fonts: null,
    approximate: false,
    stripped: 0,
    layout: [],
  };
  if (!style || !input.words.length) return { input, style, renderer: null, plan: empty };
  const fonts = await ensureFonts(style, { lang, text: input.words.map((w) => w.text), loader });
  const stripped = input.words.reduce((n, w) => n + stripUndrawable(w.text, style.font.id, lang).removed, 0);
  const surface = (w: number, h: number): Surface => {
    const canvas = deps.createCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d") as Ctx2D };
  };
  const renderer = new CaptionRenderer({ words: input.words, breaks: input.breaks, style, W, H, lang, surface });
  let top = Infinity;
  let bottom = -Infinity;
  let approximate = false;
  const layout: LayerPlan["layout"] = [];
  renderer.pages.forEach((page, i) => {
    const l = renderer.layout(i);
    const b = pageBounds(l, style);
    top = Math.min(top, b.y);
    bottom = Math.max(bottom, b.y + b.h);
    approximate ||= l.approximate;
    layout.push(layoutJSON(page, l));
  });
  let band: Band | null = null;
  if (renderer.pages.length) {
    const t = Math.max(0, even(top, false));
    const b = Math.min(even(H, false), even(bottom, true));
    if (b > t) band = { top: t, height: b - t };
  }
  return {
    input,
    style,
    renderer,
    plan: { ...empty, band, pages: renderer.pages.length, fonts, approximate, layout, stripped },
  };
}

type TraceRow = { from: number; to: number; page: number; active: number; id: string | null; text: string | null };

function bandSurface(W: number, band: Band, deps: LayerDeps) {
  const canvas = deps.createCanvas(W, band.height);
  const ctx = canvas.getContext("2d") as Ctx2D;
  // Frame coordinates: the band is rows band.top … band.top + height.
  ctx.setTransform(1, 0, 0, 1, 0, -band.top);
  return { canvas, ctx };
}

/** The band at output time `t` (RGBA premultiplied), as renderFrames emits it. */
export function bandAt(prep: Prepared, deps: LayerDeps, t: number): Uint8Array | null {
  const band = prep.input.band ?? prep.plan.band;
  if (!band || !prep.renderer) return null;
  const { canvas, ctx } = bandSurface(prep.input.W, band, deps);
  prep.renderer.drawFrame(ctx, t, { force: true });
  return canvas.data();
}

/**
 * Emits `input.frames` band frames through `write` (each W × band.height
 * × 4 bytes). `write` must have consumed (copied or written out) a buffer
 * before it returns. Returns counters.
 */
export async function renderFrames(
  prep: Prepared,
  deps: LayerDeps,
  write: (buf: Uint8Array) => void,
): Promise<{ frames: number; drawn: number; reused: number; trace: TraceRow[] }> {
  const { input, renderer } = prep;
  const band = input.band ?? prep.plan.band;
  const stats = { frames: 0, drawn: 0, reused: 0, trace: [] as TraceRow[] };
  if (!band || !renderer) return stats;
  const { canvas, ctx } = bandSurface(input.W, band, deps);
  let buf: Uint8Array | null = null;
  let lastKey: string | null = null;
  let row: TraceRow | null = null;
  // canvas.data() buffers are freed by N-API finalizers, which only run
  // when the event loop turns: a synchronous loop kept every one of them
  // (karaoke, a new buffer per frame: 2.6 GB for 60 s, and 6× slower from
  // page faults). Yielding every few draws keeps the process at ~0.2 GB.
  for (let n = 0; n < input.frames; n++) {
    const t = n / input.fps;
    const key = renderer.frameKey(t);
    if (key !== lastKey || !buf) {
      renderer.drawFrame(ctx, t, { force: true });
      buf = canvas.data();
      lastKey = key;
      stats.drawn++;
      if (stats.drawn % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    } else stats.reused++;
    write(buf);
    stats.frames++;
    if (input.trace) {
      const s = key === "none" ? null : frameState(renderer.pages, t, renderer.style);
      const page = s ? s.page : -1;
      const active = s ? s.active : -1;
      if (!row || row.page !== page || row.active !== active) {
        const w: PageWord | null = s && active >= 0 ? renderer.pages[page].words[active] : null;
        row = { from: n, to: n, page, active, id: w?.id ?? null, text: w?.source ?? null };
        stats.trace.push(row);
      } else row.to = n;
    }
  }
  if (input.trace) {
    writeFileSync(
      input.trace,
      JSON.stringify({ v: LAYER_VERSION, fps: input.fps, band, plan: prep.plan, frames: stats.trace }),
    );
  }
  return stats;
}
