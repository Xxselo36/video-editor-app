/**
 * Words the rasterizer draws wider than the metric tables (Linux Chromium
 * rounds glyph advances up) are compressed into their layout box, so ink
 * never crosses into the space; layout (positions, breaks) is unchanged.
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import { drawPage, fitScale } from "../draw";
import { buildPages, layoutPage } from "../layout";
import { resolveStyle } from "../presets";
import type { CaptionStyle, Ctx2D } from "../types";
import { ensureFonts } from "../fonts";
import { nodeFontLoader } from "../node/fonts";
import { FONTS_DIR, loadRealFonts, timed } from "./helpers";

const TEXT = "Hey, so today I want to show you the three mistakes that";

describe("fitScale", () => {
  it("is 1 when the drawn text fits its box (or within sub-pixel noise)", () => {
    expect(fitScale(50, 50)).toBe(1);
    expect(fitScale(40, 50)).toBe(1);
    expect(fitScale(50.2, 50)).toBe(1);
  });
  it("compresses wider text exactly into the box", () => {
    expect(fitScale(61, 58.2)).toBeCloseTo(58.2 / 61, 12);
    expect(fitScale(100, 50) * 100).toBe(50);
  });
  it("ignores unusable measurements", () => {
    expect(fitScale(0, 50)).toBe(1);
    expect(fitScale(NaN, 50)).toBe(1);
    expect(fitScale(60, 0)).toBe(1);
  });
});

describe("drawPage keeps every word inside its layout box", () => {
  // The caption faces themselves, registered with @napi-rs/canvas: without
  // them ctx.font fell back to whatever system font the machine (or an
  // earlier test file in the same worker) had, and on CI one word's 1.08×
  // width landed within fitScale's 0.25 px sub-pixel tolerance of its box,
  // so it wasn't compressed (0.23 px over). With the real faces every
  // widened word is ≥ 0.48 px over and is fitted exactly.
  beforeAll(async () => {
    loadRealFonts();
    const style = resolveStyle("minimal", {}, { W, H }) as CaptionStyle;
    const loader = nodeFontLoader(GlobalFonts, { fontsDir: FONTS_DIR });
    const st = await ensureFonts(style, { lang: "en", text: TEXT.split(" "), loader });
    expect(st.ok).toBe(true);
  }, 30_000);

  const W = 728;
  const H = 410;

  function run(widen: number) {
    const style = resolveStyle("minimal", { y: 0.7 }, { W, H }) as CaptionStyle;
    const words = timed(TEXT);
    const page = buildPages(words, style, { W, H })[0];
    const layout = layoutPage(page, style, { W, H });
    const ctx = createCanvas(W, H).getContext("2d");
    const measure = ctx.measureText.bind(ctx);
    const fill = ctx.fillText.bind(ctx);
    const drawn: { text: string; left: number; right: number }[] = [];
    // A rasterizer that draws `widen` × the canvas width of every word.
    Object.assign(ctx, {
      measureText: (t: string) => ({ width: measure(t).width * widen }),
      fillText: (t: string, x: number, y: number) => {
        const m = ctx.getTransform();
        const w = measure(t).width * widen;
        drawn.push({ text: t, left: m.a * x + m.e, right: m.a * (x + w) + m.e });
        fill(t, x, y);
      },
    });
    drawPage(ctx as unknown as Ctx2D, page, layout, style, { active: 0, pageP: 1, wordP: 1 });
    const boxes = layout.lines.flatMap((l) => l.words);
    return { drawn, boxes };
  }

  it("compresses a word drawn wider than the tables into its box", () => {
    const { drawn, boxes } = run(1.08);
    const fills = drawn.slice(-boxes.length); // the fill pass
    expect(fills.map((d) => d.text)).toEqual(boxes.map((b) => b.text));
    fills.forEach((d, i) => {
      expect(d.left).toBeCloseTo(boxes[i].x, 3);
      expect(d.right).toBeLessThanOrEqual(boxes[i].x + boxes[i].width + 1e-3);
    });
    // the words the "rasterizer" overdraws end exactly at their box
    expect(fills.filter((d, i) => Math.abs(d.right - (boxes[i].x + boxes[i].width)) < 1e-3).length).toBeGreaterThan(3);
    // so neighbours never touch: the space stays
    for (let i = 1; i < fills.length; i++) {
      if (boxes[i].baseline === boxes[i - 1].baseline) expect(fills[i].left).toBeGreaterThan(fills[i - 1].right + 1);
    }
  });

  it("draws unchanged where the canvas agrees with the tables", () => {
    const { drawn, boxes } = run(1);
    const fills = drawn.slice(-boxes.length);
    fills.forEach((d, i) => expect(d.left).toBeCloseTo(boxes[i].x, 3));
  });
});
