/**
 * Per-caption position and size (UT5): resolveStyle → buildPages →
 * layoutPage with `overrides.captions`, and the overrides ops of the
 * caption layer (adjust.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { captionIdOf, effectiveAdjust, resetAdjust, setCaptionAdjust, setStyleAdjust } from "../adjust";
import { ADJUST_MAX_WIDTH, buildPages, layoutJSON, layoutPage } from "../layout";
import { captionAdjusts, resolveStyle } from "../presets";
import type { CaptionStyle, StyleOverrides } from "../types";
import { loadRealFonts, timed } from "./helpers";

const W = 540;
const H = 960;
const words = timed("first page here. second page now. third page ends.");
const style = (o: StyleOverrides = {}, id = "power") => resolveStyle(id, o, { W, H }) as CaptionStyle;
const pagesOf = (s: CaptionStyle) => buildPages(words, s, { W, H, lang: "en" });

beforeAll(() => {
  loadRealFonts();
});

describe("per-caption overrides in the engine", () => {
  it("resolveStyle keeps valid entries, clamped like the style's own", () => {
    expect(captionAdjusts({ w0: { y: 2, sizeScale: 0.1 }, w1: {}, w2: { y: "x" }, w3: null })).toEqual({
      w0: { y: 0.95, sizeScale: 0.6 },
    });
    expect(captionAdjusts({})).toBeNull();
    expect(captionAdjusts([1])).toBeNull();
    expect(style().captions).toBeUndefined();
    expect(style({ captions: { w3: { y: 0.3 } } }).captions).toEqual({ w3: { y: 0.3 } });
  });

  it("only the adjusted page moves; the others keep the style's y", () => {
    const base = pagesOf(style());
    const s = style({ captions: { [captionIdOf(base[1])!]: { y: 0.3 } } });
    const pages = pagesOf(s);
    expect(pages.map((p) => p.words.map((w) => w.source))).toEqual(base.map((p) => p.words.map((w) => w.source)));
    expect(pages[1].adjust).toEqual({ id: "w3", y: 0.3 });
    expect(pages[0].adjust).toBeUndefined();
    const l0 = layoutPage(pages[0], s, { W, H });
    const l1 = layoutPage(pages[1], s, { W, H });
    expect(l0.cy).toBeCloseTo(style().layout.y * H, 3);
    expect(l1.cy).toBeCloseTo(0.3 * H, 3);
    // same size and line breaks as before
    expect(l1.px).toBeCloseTo(layoutPage(base[1], style(), { W, H }).px, 6);
  });

  it("a caption's size scales its page (same lines), relative to the preset", () => {
    const s0 = style();
    const p0 = pagesOf(s0)[0];
    const big = style({ captions: { w0: { sizeScale: 1.2 } } });
    const l = layoutPage(pagesOf(big)[0], big, { W, H });
    const l0 = layoutPage(p0, s0, { W, H });
    // up to 1.2 × on the whole-pixel grid (layout.ts snapPx; a grown page
    // never rounds up, nor grows past 96 % of the frame width)
    expect(l.px).toBeGreaterThan(l0.px);
    expect(l.px).toBeLessThanOrEqual(Math.floor(l0.px * 1.2));
    expect(l.lines.map((x) => x.words.length)).toEqual(l0.lines.map((x) => x.words.length));
    // with the style at 80 %, this caption's 120 % is still 1.2 × the preset
    // (short words: the grown page stays inside the frame)
    const short = timed("Hi. Yes. Go.");
    const both = style({ sizeScale: 0.8, captions: { w0: { sizeScale: 1.2 } } });
    const preset = layoutPage(buildPages(short, s0, { W, H })[0], s0, { W, H });
    const grown = layoutPage(buildPages(short, both, { W, H })[0], both, { W, H }).px;
    expect(Math.abs(grown - 1.2 * preset.px)).toBeLessThanOrEqual(1);
    expect(effectiveAdjust(both, pagesOf(both)[0])).toEqual({ y: both.layout.y, sizeScale: 1.2, own: true });
    expect(effectiveAdjust(both, pagesOf(both)[1])).toEqual({ y: both.layout.y, sizeScale: 0.8, own: false });
  });

  it("a caption never grows wider than the frame allows", () => {
    const long = timed("Reichweitenmaximierung Begrüßungsworte");
    const s = style({ captions: { w0: { sizeScale: 1.6 } } }, "subtitle");
    const page = buildPages(long, s, { W, H, lang: "de" })[0];
    const l = layoutPage(page, s, { W, H, lang: "de" });
    const widest = Math.max(...l.lines.map((x) => x.right - x.left));
    expect(widest).toBeLessThanOrEqual(ADJUST_MAX_WIDTH * W + 1e-6);
  });

  it("a key on a later word of a page (after re-paging) still applies; the first one wins", () => {
    const s = style({ captions: { w1: { y: 0.4 }, w2: { y: 0.2 } } });
    const p = pagesOf(s)[0];
    expect(p.words.map((w) => w.id)).toEqual(["w0", "w1", "w2"]);
    expect(p.adjust).toEqual({ id: "w1", y: 0.4 });
  });

  it("layout JSON (parity) carries the moved and scaled positions", () => {
    const s = style({ captions: { w3: { y: 0.25, sizeScale: 1.3 } } });
    const pages = pagesOf(s);
    const j = pages.map((p) => layoutJSON(p, layoutPage(p, s, { W, H })));
    expect(j[1].px).toBeGreaterThan(j[0].px);
    expect(j[1].lines[0][0].y).toBeLessThan(j[0].lines[0][0].y);
  });
});

describe("overrides ops (Nur hier | Überall | Zurücksetzen)", () => {
  const pages = () => pagesOf(style());

  it("Nur hier writes the caption under its first word's id, rounded", () => {
    const p1 = pages()[1];
    const o = setCaptionAdjust({ case: "upper" }, p1, { y: 0.31234, sizeScale: 1.234 });
    expect(o).toEqual({ case: "upper", captions: { w3: { y: 0.312, sizeScale: 1.23 } } });
    // stale keys of the same page's words go
    const o2 = setCaptionAdjust({ captions: { w4: { y: 0.1 }, w0: { y: 0.9 } } }, p1, { y: 0.5 });
    expect(o2.captions).toEqual({ w0: { y: 0.9 }, w3: { y: 0.5 } });
    // null: the caption follows the style; an empty map is dropped
    expect(setCaptionAdjust(o, p1, null)).toEqual({ case: "upper" });
  });

  it("Überall moves the style and drops the caption's own values", () => {
    const p1 = pages()[1];
    const o = setStyleAdjust({ captions: { w3: { y: 0.2 }, w0: { y: 0.9 } } }, p1, { y: 0.4, sizeScale: 1.1 });
    expect(o).toEqual({ captions: { w0: { y: 0.9 } }, y: 0.4, sizeScale: 1.1 });
    expect(setStyleAdjust({ sizeScale: 1.2 }, p1, { sizeScale: 1 })).toEqual({});
  });

  it("Zurücksetzen: the caption's own values, and everywhere the style's too", () => {
    const p1 = pages()[1];
    const o: StyleOverrides = { y: 0.4, sizeScale: 1.2, captions: { w3: { y: 0.2 } }, textColor: "#FFFFFF" };
    expect(resetAdjust(o, p1, false)).toEqual({ y: 0.4, sizeScale: 1.2, textColor: "#FFFFFF" });
    expect(resetAdjust(o, p1, true)).toEqual({ textColor: "#FFFFFF" });
  });

  it("round trip: what the ops write is what the engine draws", () => {
    const o = setCaptionAdjust({}, pages()[1], { y: 0.3, sizeScale: 1.25 });
    const s2 = style(o);
    expect(effectiveAdjust(s2, pagesOf(s2)[1])).toEqual({ y: 0.3, sizeScale: 1.25, own: true });
  });
});
