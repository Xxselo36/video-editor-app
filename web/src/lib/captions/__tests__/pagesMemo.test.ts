/**
 * buildPages with a PagesMemo (the editor preview's CaptionRenderer, UX10:
 * a trim, split, cut or reorder only moves cuts) gives exactly the pages
 * of a call without it — over random sequences of breaks, and when the
 * words, the style or the size change in between.
 */
import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import { CaptionRenderer } from "../cache";
import { buildPages, pagesMemo } from "../layout";
import { resolveStyle } from "../presets";
import type { CaptionStyle, CaptionWord, Ctx2D, Surface } from "../types";
import { loadRealFonts, timed } from "./helpers";

const W = 1080;
const H = 1920;
const style = (id: string, o = {}) => resolveStyle(id, o, { W, H }) as CaptionStyle;

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const TEXT =
  "so today I want to show you the three mistakes that kill your reach. mistake number one: you start way too slow, " +
  "nobody waits ten seconds for you to get to the point! mistake number two is dead air, every pause you leave in, " +
  "people swipe away. and mistake number three: no captions at all, most people watch with the sound off";

function words(n: number): CaptionWord[] {
  const base = timed(TEXT);
  const out: CaptionWord[] = [];
  for (let i = 0; i < n; i++) {
    const w = base[i % base.length];
    const t = Math.floor(i / base.length) * 20;
    out.push({ ...w, id: `w${i}`, start: +(w.start + t).toFixed(3), end: +(w.end + t).toFixed(3) });
  }
  return out;
}

beforeAll(() => {
  loadRealFonts();
});

describe("PagesMemo", () => {
  it.each(["power", "karaoke", "subtitle", "minimal", "oneword"])("%s: same pages as without it, break after break", (id) => {
    const ws = words(600);
    const s = style(id);
    const memo = pagesMemo();
    const r = rng(id.length * 7919);
    let breaks: number[] = [];
    for (let step = 0; step < 40; step++) {
      // move, add or drop a cut, as timeline edits do
      const t = r() * 120;
      if (r() < 0.5 || !breaks.length) breaks = [...breaks, t];
      else if (r() < 0.5) breaks = breaks.filter((_, i) => i !== Math.floor(r() * breaks.length));
      else breaks = breaks.map((b, i) => (i === 0 ? b + (r() - 0.5) * 2 : b));
      const opts = { W, H, lang: "en", breaks };
      expect(buildPages(ws, s, opts, memo)).toEqual(buildPages(ws, s, opts));
    }
  });

  it("starts over for other words, another style or size", () => {
    const memo = pagesMemo();
    const a = words(200);
    const b = a.map((w, i) => (i === 50 ? { ...w, text: "changed" } : w));
    const opts = { W, H, lang: "en", breaks: [3.3, 12.1] };
    expect(buildPages(a, style("power"), opts, memo)).toEqual(buildPages(a, style("power"), opts));
    expect(buildPages(b, style("power"), opts, memo)).toEqual(buildPages(b, style("power"), opts));
    expect(buildPages(b, style("karaoke"), opts, memo)).toEqual(buildPages(b, style("karaoke"), opts));
    const small = { ...opts, W: 720, H: 1280 };
    const s720 = resolveStyle("karaoke", {}, { W: 720, H: 1280 }) as CaptionStyle;
    expect(buildPages(b, s720, small, memo)).toEqual(buildPages(b, s720, small));
  });

  it("a breaks-only update keeps the bitmaps of pages that stayed the same", () => {
    const surface = (w: number, h: number): Surface => {
      const c = createCanvas(w, h);
      return { canvas: c, ctx: c.getContext("2d") as unknown as Ctx2D };
    };
    const ws = words(300);
    const r = new CaptionRenderer({ words: ws, style: style("power"), W, H, lang: "en", breaks: [], surface });
    const target = createCanvas(W, H).getContext("2d") as unknown as Ctx2D;
    r.drawFrame(target, 1.0, { force: true });
    const n = r.stats.renders;
    r.update({ breaks: [50.5] }); // far from 1.0 s
    r.drawFrame(target, 1.0, { force: true });
    expect(r.stats.renders).toBe(n);
    r.update({ breaks: [0.9] }); // the page at 1.0 s changes
    r.drawFrame(target, 1.0, { force: true });
    expect(r.stats.renders).toBe(n + 1);
    r.update({ style: style("power", { sizeScale: 1.2 }) }); // not breaks only: all new
    r.drawFrame(target, 1.0, { force: true });
    expect(r.stats.renders).toBe(n + 2);
  });

  it("the renderer's breaks-only update keeps the pages a fresh renderer makes", () => {
    const ws = words(300);
    const s = style("power");
    const r = new CaptionRenderer({ words: ws, style: s, W, H, lang: "en", breaks: [] });
    for (const breaks of [[5.1], [5.1, 33.3], [6.0, 33.3], [], [60.2]]) {
      r.update({ breaks });
      expect(r.pages).toEqual(new CaptionRenderer({ words: ws, style: s, W, H, lang: "en", breaks }).pages);
    }
  });
});
