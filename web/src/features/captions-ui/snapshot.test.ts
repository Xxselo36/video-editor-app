import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptionRenderer } from "@/lib/captions/cache";
import { ensureFonts, setDefaultFontLoader } from "@/lib/captions/fonts";
import { nodeFontLoader } from "@/lib/captions/node/fonts";
import { resolveStyle } from "@/lib/captions/presets";
import { FONTS_DIR, loadRealFonts } from "@/lib/captions/__tests__/helpers";
import { bandCrop, coverRect, drawCaptionSnapshot, sampleWords, type SnapshotEngine } from "./snapshot";

describe("sampleWords: the tile's sample", () => {
  it("the first two words, spoken half a second apart", () => {
    expect(sampleWords(["Hallo", "zusammen", "heute"], "power")).toEqual([
      { id: "s0", text: "Hallo", start: 0, end: 0.45 },
      { id: "s1", text: "zusammen", start: 0.5, end: 0.95 },
    ]);
  });

  it("one word for One Word (punch), and Aa without words", () => {
    expect(sampleWords(["Hallo", "zusammen"], "punch")).toEqual([{ id: "s0", text: "Hallo", start: 0, end: 0.45 }]);
    expect(sampleWords([], "karaoke")).toEqual([{ id: "s0", text: "Aa", start: 0, end: 0.45 }]);
  });
});

describe("bandCrop: the caption band of the frame", () => {
  const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom });

  it("a short caption: 55 % of the frame wide, the canvas's shape, centred on the caption", () => {
    const c = bandCrop(box(170, 370, 600, 660), 540, 960, 100, 72);
    expect(c.sw).toBeCloseTo(297);
    expect(c.sh).toBeCloseTo(213.84);
    expect(c.sx).toBeCloseTo(121.5);
    expect(c.sy).toBeCloseTo(523.08);
  });

  it("a wide caption widens the band to 1.12× its width, at most the whole frame", () => {
    expect(bandCrop(box(70, 470, 600, 660), 540, 960, 100, 72).sw).toBeCloseTo(448);
    const whole = bandCrop(box(20, 520, 600, 660), 540, 960, 100, 72);
    expect(whole.sw).toBe(540);
    expect(whole.sx).toBe(0);
  });

  it("stays inside the frame at its edges", () => {
    const low = bandCrop(box(440, 540, 900, 960), 540, 960, 100, 72);
    expect(low.sx).toBeCloseTo(540 - 297);
    expect(low.sy).toBeCloseTo(960 - 213.84);
    const high = bandCrop(box(0, 100, 0, 40), 540, 960, 100, 72);
    expect([high.sx, high.sy]).toEqual([0, 0]);
  });

  it("a band taller than the frame starts at its top", () => {
    const c = bandCrop(box(400, 560, 300, 400), 960, 540, 100, 400);
    expect(c.sw).toBeCloseTo(528); // 55 % of a wide frame
    expect(c.sh).toBeCloseTo(2112);
    expect(c.sy).toBe(0);
  });
});

describe("coverRect: the picture under the caption", () => {
  it("a picture of the frame's own shape fills it exactly, whatever the rounding", () => {
    expect(coverRect(1080, 1920, 540, 960)).toEqual({ x: 0, y: 0, w: 540, h: 960 });
    expect(coverRect(886, 1920, 540, 1170)).toEqual({ x: 0, y: 0, w: 540, h: 1170 }); // 1170.2 rounded
    expect(coverRect(1349, 1080, 675, 540)).toEqual({ x: 0, y: 0, w: 675, h: 540 });
  });

  it("a wide picture in an upright frame shows its middle", () => {
    const r = coverRect(1920, 1080, 540, 960);
    expect(r.w).toBeCloseTo(1706.67);
    expect(r.h).toBeCloseTo(960);
    expect(r.x).toBeCloseTo(-583.33);
    expect(r.y).toBeCloseTo(0);
  });

  it("an upright picture in a wide frame shows its middle", () => {
    const r = coverRect(1080, 1920, 960, 540);
    expect(r.w).toBeCloseTo(960);
    expect(r.h).toBeCloseTo(1706.67);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(-583.33);
  });
});

describe("drawCaptionSnapshot (the real engine on @napi-rs/canvas)", { timeout: 30_000 }, () => {
  const ENGINE: SnapshotEngine = { CaptionRenderer, resolveStyle, ensureFonts };
  const WORDS = sampleWords(["Hallo", "zusammen"], "power");
  const yellow = ([r, g, b]: number[]) => r > 200 && g > 200 && b < 90; // Power's active word

  /** A canvas on the page: its layout box and its rounded client size. */
  const onPage = (w: number, h: number) =>
    Object.assign(createCanvas(1, 1), {
      clientWidth: Math.round(w),
      clientHeight: Math.round(h),
      getBoundingClientRect: () => ({ width: w, height: h }),
    }) as unknown as HTMLCanvasElement;

  /** A picture in vertical stripes; with `readyState`, a video showing it. */
  function picture(w: number, h: number, stripes: string[], readyState?: number): CanvasImageSource {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    stripes.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect((i * w) / stripes.length, 0, w / stripes.length, h);
    });
    const video = readyState === undefined ? {} : { readyState, videoWidth: w, videoHeight: h };
    return Object.assign(c, video) as unknown as CanvasImageSource;
  }

  /** The canvas's pixels as [r, g, b]. */
  const pixels = (c: HTMLCanvasElement) => {
    const n = c as unknown as Canvas;
    const d = n.getContext("2d").getImageData(0, 0, n.width, n.height).data;
    const rgb = (i: number) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    return { at: (x: number, y: number) => rgb(y * n.width + x), all: () => Array.from({ length: d.length / 4 }, (_, i) => rgb(i)) };
  };

  beforeAll(() => {
    loadRealFonts();
    setDefaultFontLoader(nodeFontLoader(GlobalFonts, { fontsDir: FONTS_DIR }));
  });

  beforeEach(() => {
    vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("band: the caption over the video's frame, at the canvas's size and at most 2× sharp", async () => {
    const canvas = onPage(100, 72);
    const video = picture(1080, 1920, ["#336699"], 4);
    const res = await drawCaptionSnapshot(canvas, { engine: ENGINE, presetId: "power", frame: video, frameW: 1080, frameH: 1920, words: WORDS, lang: "de", crop: "band" });
    expect(res).toEqual({ ok: true, withFrame: true });
    expect([canvas.width, canvas.height]).toEqual([200, 144]);
    const px = pixels(canvas);
    expect(px.at(0, 0)).toEqual([0x33, 0x66, 0x99]);
    expect(px.all().filter(yellow).length).toBeGreaterThan(100);
  });

  it("band: laid out on the shape the video gets, a wide picture covering it with its middle", async () => {
    const canvas = onPage(100, 72);
    const resolve = vi.fn(resolveStyle);
    const wide = picture(1920, 1080, ["#ff0000", "#00ff00", "#0000ff"]);
    const input = { presetId: "power", frame: wide, frameW: 1920, frameH: 1080, words: WORDS, crop: "band" as const };
    const res = await drawCaptionSnapshot(canvas, { ...input, engine: { ...ENGINE, resolveStyle: resolve }, shape: { width: 9, height: 16 } });
    expect(res).toEqual({ ok: true, withFrame: true });
    expect(resolve).toHaveBeenCalledWith("power", undefined, { W: 540, H: 960 });
    const px = pixels(canvas);
    expect(px.at(0, 0)).toEqual([0, 255, 0]);
    expect(px.at(199, 143)).toEqual([0, 255, 0]);
    expect(px.all().filter(yellow).length).toBeGreaterThan(100);
    // Without a shape: the picture's own.
    await drawCaptionSnapshot(onPage(100, 72), { ...input, engine: { ...ENGINE, resolveStyle: resolve } });
    expect(resolve).toHaveBeenLastCalledWith("power", undefined, { W: 960, H: 540 });
  });

  it("band: a video without a frame yet leaves the backdrop, so the tile draws again later", async () => {
    const canvas = onPage(100, 72);
    const video = picture(1080, 1920, ["#336699"], 1);
    const res = await drawCaptionSnapshot(canvas, { engine: ENGINE, presetId: "power", frame: video, frameW: 1080, frameH: 1920, words: WORDS, crop: "band" });
    expect(res).toEqual({ ok: true, withFrame: false });
    expect(pixels(canvas).at(0, 0)).toEqual([0x1b, 0x1b, 0x21]);
  });

  it("frame: the whole frame in the canvas's shape, a wide picture covering it with its middle", async () => {
    const canvas = onPage(90, 160);
    const resolve = vi.fn(resolveStyle);
    const wide = picture(1920, 1080, ["#ff0000", "#00ff00", "#0000ff"]);
    const res = await drawCaptionSnapshot(canvas, { engine: { ...ENGINE, resolveStyle: resolve }, presetId: "power", frame: wide, frameW: 1920, frameH: 1080, words: WORDS, crop: "frame" });
    expect(res).toEqual({ ok: true, withFrame: true });
    expect(resolve).toHaveBeenCalledWith("power", undefined, { W: 540, H: 960 });
    expect([canvas.width, canvas.height]).toEqual([180, 320]);
    const px = pixels(canvas);
    expect(px.at(0, 0)).toEqual([0, 255, 0]);
    expect(px.at(179, 319)).toEqual([0, 255, 0]);
    expect(px.all().filter(yellow).length).toBeGreaterThan(100);
  });

  it("frame: the layout box keeps the output format exact (4:5) where the client size is rounded", async () => {
    const resolve = vi.fn(resolveStyle);
    await drawCaptionSnapshot(onPage(298, 372.5), { engine: { ...ENGINE, resolveStyle: resolve }, presetId: "karaoke", overrides: { wordsPerPage: 2 }, frame: null, frameW: 0, frameH: 0, words: WORDS, crop: "frame" });
    expect(resolve).toHaveBeenCalledWith("karaoke", { wordsPerPage: 2 }, { W: 540, H: 675 });
  });

  it("onFontsLoading runs before the fonts are awaited; after an abort nothing is drawn", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const engine: SnapshotEngine = { ...ENGINE, ensureFonts: (style, o) => held.then(() => ensureFonts(style, o)) };
    const canvas = onPage(100, 72);
    const ac = new AbortController();
    const onFontsLoading = vi.fn();
    const drawing = drawCaptionSnapshot(canvas, { engine, presetId: "power", frame: null, frameW: 0, frameH: 0, words: WORDS, crop: "band" }, { onFontsLoading, signal: ac.signal });
    expect(onFontsLoading).toHaveBeenCalledTimes(1);
    ac.abort();
    release();
    expect(await drawing).toEqual({ ok: false, withFrame: false });
    expect(canvas.width).toBe(1);
  });

  it("Off (none) and fonts that fail draw nothing", async () => {
    const onFontsLoading = vi.fn();
    const off = await drawCaptionSnapshot(onPage(100, 72), { engine: ENGINE, presetId: "none", frame: null, frameW: 0, frameH: 0, words: WORDS, crop: "band" }, { onFontsLoading });
    expect(off).toEqual({ ok: false, withFrame: false });
    expect(onFontsLoading).not.toHaveBeenCalled();
    const failing: SnapshotEngine = { ...ENGINE, ensureFonts: () => Promise.reject(new Error("offline")) };
    const canvas = onPage(100, 72);
    expect(await drawCaptionSnapshot(canvas, { engine: failing, presetId: "power", frame: null, frameW: 0, frameH: 0, words: WORDS, crop: "band" })).toEqual({ ok: false, withFrame: false });
    expect(canvas.width).toBe(1);
  });
});
