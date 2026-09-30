import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import { CaptionRenderer } from "../cache";
import { ANIM_STEPS, activeIndex, frameState, hitTest, pageIndexAt } from "../engine";
import { ensureFonts, setDefaultFontLoader } from "../fonts";
import { buildPages, layoutPage } from "../layout";
import { nodeFontLoader } from "../node/fonts";
import { resolveStyle } from "../presets";
import { mapToOutput, type SourceWord } from "../timeline";
import type { CaptionStyle, Ctx2D, Surface } from "../types";
import { AUDIT_WORDS, FONTS_DIR, useRealFonts } from "./helpers";

const W = 540;
const H = 960;
const style = (id: string, o = {}) => resolveStyle(id, o, { W, H }) as CaptionStyle;
useRealFonts();

beforeAll(async () => {
  setDefaultFontLoader(nodeFontLoader(GlobalFonts, { fontsDir: FONTS_DIR }));
  for (const id of ["power", "karaoke", "neon"]) await ensureFonts(style(id), { lang: "en", text: "Nobody waits" });
});

describe("active word", () => {
  const s = style("subtitle"); // one page holds the whole sentence
  const pages = buildPages(AUDIT_WORDS, s, { W, H, lang: "en" });

  it("is the last word with start <= t, exactly at the boundaries", () => {
    const p = pages[0];
    for (let i = 0; i < p.words.length; i++) {
      const w = p.words[i];
      expect(activeIndex(p, w.start)).toBe(i);
      if (i) expect(activeIndex(p, w.start - 1e-6)).toBe(i - 1);
      // between two words (after w.end, before the next start) w stays active
      if (i + 1 < p.words.length) expect(activeIndex(p, (w.end + p.words[i + 1].start) / 2)).toBe(i);
    }
  });

  it("pages are half-open [start, end)", () => {
    expect(pageIndexAt(pages, -0.01)).toBe(-1);
    expect(pageIndexAt(pages, 0)).toBe(0);
    const last = pages[pages.length - 1];
    expect(pageIndexAt(pages, last.end - 1e-6)).toBe(pages.length - 1);
    expect(pageIndexAt(pages, last.end)).toBe(-1);
    expect(frameState(pages, last.end, s)).toBeNull();
  });

  it("offsetMs shifts it", () => {
    const src: SourceWord[] = AUDIT_WORDS.map((w, i) => ({ id: `w${i}`, text: w.text, start: w.start, end: w.end }));
    const clips = [{ start: 0, end: 10 }];
    const at = (offsetMs: number, t: number) => {
      const { words, breaks } = mapToOutput(clips, src, { offsetMs });
      const ps = buildPages(words, s, { W, H, lang: "en", breaks });
      const st = frameState(ps, t, s)!;
      return ps[st.page].words[st.active].source;
    };
    // "seconds" starts at 0.924, "for" at 1.34
    expect(at(0, 0.95)).toBe("seconds");
    expect(at(100, 0.95)).toBe("ten"); // captions 100 ms later: "seconds" not yet
    expect(at(0, 1.1)).toBe("seconds");
    expect(at(-300, 1.1)).toBe("for"); // 300 ms earlier: "for" from 1.04
  });
});

describe("animation steps", () => {
  it("quantizes page-in and word-in to ANIM_STEPS keyframes, then settles", () => {
    const s = style("neon"); // page fade 0.1 s, word pop 0.1 s
    const pages = buildPages(AUDIT_WORDS, s, { W, H, lang: "en" });
    const keys = new Set<string>();
    for (let t = 0; t < 0.1; t += 0.001) keys.add(frameState(pages, t, s)!.key);
    expect(keys.size).toBe(ANIM_STEPS);
    const settled = frameState(pages, 0.2, s)!;
    expect(settled.pageP).toBe(1);
    expect(settled.wordP).toBe(1);
    expect(frameState(pages, 0.2, s)!.key).toBe(frameState(pages, 0.3, s)!.key);
  });

  it("karaoke sweeps the active word continuously", () => {
    const s = style("karaoke");
    const pages = buildPages(AUDIT_WORDS, s, { W, H, lang: "en" });
    const w = AUDIT_WORDS[3];
    expect(frameState(pages, w.start, s)!.sweep).toBe(0);
    expect(frameState(pages, (w.start + w.end) / 2, s)!.sweep).toBeCloseTo(0.5, 9);
    expect(frameState(pages, w.end + 0.01, s)!.sweep).toBe(1);
    expect(frameState(pages, 1.0, style("power"))!.sweep).toBeNull();
  });
});

describe("CaptionRenderer (bitmap cache)", () => {
  const surface = (w: number, h: number): Surface => {
    const c = createCanvas(w, h);
    return { canvas: c, ctx: c.getContext("2d") as unknown as Ctx2D };
  };

  it("draws each state once and skips unchanged frames", () => {
    const s = style("power");
    const r = new CaptionRenderer({ words: AUDIT_WORDS, style: s, W, H, lang: "en", surface });
    const target = createCanvas(W, H).getContext("2d") as unknown as Ctx2D;
    const states = new Set<string>();
    let changed = 0;
    for (let f = 0; f < 3.5 * 30; f++) {
      const t = f / 30;
      const res = r.drawFrame(target, t);
      if (res.changed) changed++;
      states.add(res.state?.key ?? "none");
    }
    expect(r.stats.renders).toBeLessThanOrEqual(states.size);
    expect(changed).toBeLessThan(40); // 105 frames, the rest reuse the canvas
    expect(r.stats.skipped).toBeGreaterThan(60);
    // seeking back reuses bitmaps
    const before = r.stats.renders;
    r.drawFrame(target, 0.5, { force: true });
    expect(r.stats.renders).toBe(before);
  });

  it("rebuilds on a style change", () => {
    const r = new CaptionRenderer({ words: AUDIT_WORDS, style: style("power"), W, H, lang: "en", surface });
    const target = createCanvas(W, H).getContext("2d") as unknown as Ctx2D;
    r.drawFrame(target, 1);
    r.update({ style: style("power", { sizeScale: 1.3 }) });
    expect(r.drawFrame(target, 1).changed).toBe(true);
    expect(r.layout(r.state(1)!.page).px).toBeCloseTo(0.09 * 1.3 * W, 6);
  });

  it("stays within its pixel budget", () => {
    const r = new CaptionRenderer({ words: AUDIT_WORDS, style: style("karaoke"), W, H, lang: "en", surface, maxPixels: 200_000 });
    const target = createCanvas(W, H).getContext("2d") as unknown as Ctx2D;
    for (let f = 0; f < 90; f++) r.drawFrame(target, f / 30);
    const internal = r as unknown as { pixels: number; cache: Map<string, unknown> };
    expect(internal.pixels).toBeLessThanOrEqual(200_000 + 150_000); // one oversize entry may remain
    expect(internal.cache.size).toBeGreaterThan(0);
  });

  it("hit-tests words on the canvas", () => {
    const s = style("power");
    const r = new CaptionRenderer({ words: AUDIT_WORDS, style: s, W, H, lang: "en", surface });
    const st = r.state(1.0)!;
    const l = r.layout(st.page);
    const b = l.lines[1].words[1]; // "SECONDS"
    const hit = r.hitTest(1.0, b.x + b.width / 2, b.baseline - l.capH / 2);
    expect(hit).toMatchObject({ text: "seconds", id: "a3" });
    expect(hitTest(r.pages[st.page], layoutPage(r.pages[st.page], s, { W, H }), s, 2, 2)).toBeNull();
  });
});
