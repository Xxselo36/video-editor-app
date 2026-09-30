/**
 * Bitmap cache for drawing captions every frame (UT2, review C2).
 *
 * Each caption state — page × active word × page-in step × word-in step
 * (engine.ts quantizes animations to ANIM_STEPS keyframes) — is drawn once
 * into an offscreen surface the size of the page's bounds, with glow,
 * shadow blur and strokes baked in, and then only blitted. Nothing is
 * redrawn while the page and the active word stay the same; drawFrame()
 * even skips the blit when the frame would not change. Karaoke adds one
 * clipped blit of the active word's highlight layer.
 *
 * Output equals engine.drawCaptions() (same states, same code; the layer
 * sits on integer pixel offsets), so the editor (cached) and a render that
 * draws directly produce the same pixels. The render worker (UT4) uses this
 * class too, with a @napi-rs/canvas surface factory, and reuses a frame's
 * buffer while `frameKey` stays the same.
 */
import { drawPage, drawSweep, pageBounds, sweepRect } from "./draw";
import { frameState, hitTest, type FrameState } from "./engine";
import { buildPages, layoutPage } from "./layout";
import type { CaptionStyle, CaptionWord, Ctx2D, Page, PageLayout, Surface, SurfaceFactory } from "./types";

export type RendererInput = {
  words: readonly CaptionWord[];
  style: CaptionStyle;
  /** Canvas size in device pixels (CSS size × min(devicePixelRatio, 2)). */
  W: number;
  H: number;
  lang?: string;
  /** Output times of cuts. */
  breaks?: readonly number[];
};

export type RendererOptions = RendererInput & {
  surface?: SurfaceFactory;
  /** Cache budget in pixels (default 12 MP ≈ 48 MB of RGBA). */
  maxPixels?: number;
};

type Entry = { surface: Surface; x: number; y: number; w: number; h: number };

type CanvasLike = { width: number; height: number; getContext(type: "2d"): unknown };

/** Browser surfaces: a detached <canvas> (uses document.fonts), else OffscreenCanvas. */
export function browserSurface(width: number, height: number): Surface {
  const g = globalThis as unknown as {
    document?: { createElement(tag: "canvas"): CanvasLike };
    OffscreenCanvas?: new (w: number, h: number) => CanvasLike;
  };
  let canvas: CanvasLike;
  if (g.document) {
    canvas = g.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  } else if (g.OffscreenCanvas) {
    canvas = new g.OffscreenCanvas(width, height);
  } else {
    throw new Error("no canvas available: pass a surface factory (Node: @napi-rs/canvas createCanvas)");
  }
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("2d context unavailable");
  return { canvas, ctx };
}

function release(surface: Surface) {
  const c = surface.canvas as Partial<CanvasLike>;
  try {
    if (typeof c.width === "number") {
      c.width = 0;
      c.height = 0;
    }
  } catch {
    /* read-only in some backends */
  }
}

export class CaptionRenderer {
  pages: Page[] = [];
  private input: RendererInput;
  private readonly factory: SurfaceFactory;
  private readonly maxPixels: number;
  private readonly cache = new Map<string, Entry>();
  private readonly bounds = new Map<number, { x: number; y: number; w: number; h: number }>();
  private pixels = 0;
  private last: { key: string; sweep: number | null } | null = null;
  /** Counters for tests and the micro-benchmark. */
  readonly stats = { renders: 0, blits: 0, skipped: 0 };

  constructor(opts: RendererOptions) {
    this.factory = opts.surface ?? browserSurface;
    this.maxPixels = opts.maxPixels ?? 12_000_000;
    this.input = { words: opts.words, style: opts.style, W: opts.W, H: opts.H, lang: opts.lang, breaks: opts.breaks };
    this.rebuild();
  }

  /** New words, style, size or language: rebuild pages, drop bitmaps. */
  update(changes: Partial<RendererInput>): void {
    this.input = { ...this.input, ...changes };
    this.rebuild();
  }

  get style(): CaptionStyle {
    return this.input.style;
  }

  private rebuild() {
    const { words, style, W, H, lang, breaks } = this.input;
    this.pages = buildPages(words, style, { W, H, lang, breaks });
    this.clear();
  }

  /** Drops every cached bitmap (keeps the pages). */
  clear(): void {
    for (const e of this.cache.values()) release(e.surface);
    this.cache.clear();
    this.bounds.clear();
    this.pixels = 0;
    this.last = null;
  }

  dispose(): void {
    this.clear();
    this.pages = [];
  }

  state(t: number): FrameState | null {
    return frameState(this.pages, t, this.input.style);
  }

  layout(pageIndex: number): PageLayout {
    const { style, W, H, lang } = this.input;
    return layoutPage(this.pages[pageIndex], style, { W, H, lang });
  }

  /** Changes whenever the frame's pixels change (the render worker reuses buffers while it stays equal). */
  frameKey(t: number): string {
    const s = this.state(t);
    if (!s) return "none";
    return s.sweep === null ? s.key : `${s.key}:${Math.round(s.sweep * 1000)}`;
  }

  private pageBoundsOf(i: number) {
    let b = this.bounds.get(i);
    if (!b) {
      b = pageBounds(this.layout(i), this.input.style);
      this.bounds.set(i, b);
    }
    return b;
  }

  private entry(s: FrameState, sweep: boolean): Entry {
    const key = sweep ? `${s.key}:sweep` : s.key;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU: move to the end
      this.cache.set(key, hit);
      return hit;
    }
    const b = this.pageBoundsOf(s.page);
    const surface = this.factory(b.w, b.h);
    surface.ctx.setTransform(1, 0, 0, 1, -b.x, -b.y);
    const page = this.pages[s.page];
    const layout = this.layout(s.page);
    if (sweep) drawSweep(surface.ctx, page, layout, this.input.style, s, this.input.lang);
    else drawPage(surface.ctx, page, layout, this.input.style, s, this.input.lang);
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stats.renders++;
    const e: Entry = { surface, ...b };
    this.cache.set(key, e);
    this.pixels += b.w * b.h;
    for (const [k, old] of this.cache) {
      if (this.pixels <= this.maxPixels || old === e) break;
      this.cache.delete(k);
      this.pixels -= old.w * old.h;
      release(old.surface);
    }
    return e;
  }

  /**
   * Blits the caption for output time `t` onto `ctx` (no clear), e.g. over
   * a video frame. Returns the state drawn, or null.
   */
  draw(ctx: Ctx2D, t: number): FrameState | null {
    const s = this.state(t);
    if (!s) return null;
    const e = this.entry(s, false);
    ctx.drawImage(e.surface.canvas as never, e.x, e.y);
    this.stats.blits++;
    if (s.sweep !== null) {
      const rect = sweepRect(this.layout(s.page), s.active, s.sweep);
      if (rect) {
        const sw = this.entry(s, true);
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        ctx.drawImage(sw.surface.canvas as never, sw.x, sw.y);
        ctx.restore();
      }
    }
    return s;
  }

  /**
   * For an overlay canvas of W×H: redraws only when the frame changes
   * (page, active word, animation step, karaoke sweep, or `force`).
   */
  drawFrame(ctx: Ctx2D, t: number, opts: { force?: boolean } = {}): { changed: boolean; state: FrameState | null } {
    const s = this.state(t);
    const key = s ? s.key : "none";
    const sweep = s?.sweep ?? null;
    if (!opts.force && this.last && this.last.key === key && this.last.sweep === sweep) {
      this.stats.skipped++;
      return { changed: false, state: s };
    }
    ctx.clearRect(0, 0, this.input.W, this.input.H);
    if (s) this.draw(ctx, t);
    this.last = { key, sweep };
    return { changed: true, state: s };
  }

  /** Renders the bitmaps the next page-in will need (call when idle). */
  prefetch(t: number): number {
    const style = this.input.style;
    const idx = this.pages.findIndex((p) => p.end > t);
    if (idx < 0) return 0;
    const page = this.pages[idx];
    const span = Math.max(style.animation.pageInSec, style.animation.wordInSec, 0) + 1 / 60;
    let n = 0;
    for (let x = page.start; x <= page.start + span; x += 1 / 120) {
      const s = this.state(x);
      if (s && !this.cache.has(s.key)) {
        this.entry(s, false);
        n++;
      }
    }
    return n;
  }

  /** The word under canvas point (x, y) at time t. */
  hitTest(t: number, x: number, y: number) {
    const s = this.state(t);
    if (!s) return null;
    return hitTest(this.pages[s.page], this.layout(s.page), this.input.style, x, y);
  }
}
