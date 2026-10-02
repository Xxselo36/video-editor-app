import { beforeAll, describe, expect, it } from "vitest";
import fontsJson from "@/lib/captions/fonts.json";
import { buildPages, frameState, resolveStyle, setFontTables, type FontTables } from "@/lib/captions";
import {
  WEB_SUB_POS,
  canvasPixels,
  contentBox,
  interimStyleRef,
  interimWords,
  pageText,
  sourceBreaks,
  videoToSource,
} from "./interim";

// The stub's grid clip (backend/tests/stub_media.py grid_data): clips
// [0,6] [7,14] [15,22] [23,30], "Satz N hier." at clip start +0.5 … +2.5.
const GRID: [number, number][] = [
  [0, 6],
  [7, 14],
  [15, 22],
  [23, 30],
];
const gridUnits = GRID.map(([s], i) => {
  const out = GRID.slice(0, i).reduce((n, [a, b]) => n + b - a, 0);
  return { start: out + 0.5, end: out + 2.5, original_start: s + 0.5, original_end: s + 2.5, text: `Satz ${i + 1} hier.` };
});
const gridPhrases = gridUnits.map((u) => ({ ...u, original_start: u.original_start, original_end: u.original_end }));

describe("contentBox (object-fit: contain)", () => {
  it("pillarboxes a portrait video in a wide element", () => {
    expect(contentBox(1000, 500, 1080, 1920)).toEqual({ x: (1000 - 281.25) / 2, y: 0, w: 281.25, h: 500 });
  });
  it("letterboxes a landscape video in a tall element", () => {
    const b = contentBox(390, 500, 1920, 1080);
    expect(b.w).toBe(390);
    expect(b.h).toBeCloseTo(219.375, 6);
    expect(b.y).toBeCloseTo((500 - 219.375) / 2, 6);
    expect(b.x).toBe(0);
  });
  it("fills an element of the same aspect", () => {
    expect(contentBox(360, 640, 1080, 1920)).toEqual({ x: 0, y: 0, w: 360, h: 640 });
  });
  it("uses the element before the video size is known, nothing without a size", () => {
    expect(contentBox(300, 200, 0, 0)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    expect(contentBox(0, 0, 1080, 1920)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it("backs the canvas at × min(DPR, 2)", () => {
    const b = { x: 0, y: 0, w: 281.25, h: 500 };
    expect(canvasPixels(b, 1)).toEqual({ W: 281, H: 500, scale: 1 });
    expect(canvasPixels(b, 1.5)).toEqual({ W: 422, H: 750, scale: 1.5 });
    expect(canvasPixels(b, 3)).toEqual({ W: 563, H: 1000, scale: 2 });
    expect(canvasPixels(b, 0)).toEqual({ W: 281, H: 500, scale: 1 });
  });
});

describe("videoToSource (the review screen's originalTime)", () => {
  it("proxy: the video's time is the source time", () => {
    expect(videoToSource(8.25, "proxy", GRID, 30)).toBe(8.25);
  });
  it("preview: maps back through the played segments", () => {
    expect(videoToSource(0.5, "preview", GRID, 30)).toBe(0.5);
    expect(videoToSource(6, "preview", GRID, 30)).toBe(6); // end of clip 1
    expect(videoToSource(6.5, "preview", GRID, 30)).toBe(7.5); // after the 6–7 cut
    expect(videoToSource(13.5, "preview", GRID, 30)).toBeCloseTo(15.5, 9);
    expect(videoToSource(99, "preview", GRID, 30)).toBe(30); // past the end
  });
  it("preview: a reordered preview follows its own order", () => {
    expect(videoToSource(1, "preview", [[7, 14], [0, 6]], 30)).toBe(8);
    expect(videoToSource(8, "preview", [[7, 14], [0, 6]], 30)).toBe(1);
  });
  it("probing plays the preview; no segments → identity", () => {
    expect(videoToSource(6.5, "probing", GRID, 30)).toBe(7.5);
    expect(videoToSource(6.5, "preview", [], 30)).toBe(6.5);
  });
  it("cuts become page breaks", () => {
    expect(sourceBreaks([[7, 14], [0, 6], [14, 20]])).toEqual([0, 6, 7, 14, 20]);
  });
});

describe("interimWords (phrase → words feed)", () => {
  it("splits a unit into its words by length, on source time", () => {
    const words = interimWords(gridPhrases.slice(0, 2), gridUnits);
    expect(words.map((w) => w.text)).toEqual(["Satz", "1", "hier.", "Satz", "2", "hier."]);
    // "Satz"(4) "1"(1) "hier."(5) over 0.5–2.5 s
    expect(words.slice(0, 3).map((w) => [w.start, w.end])).toEqual([
      [0.5, 1.3],
      [1.3, 1.5],
      [1.5, 2.5],
    ]);
    expect(words[3].start).toBe(7.5);
    expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
  });

  it("shows an edited sentence right away, on its unit's time", () => {
    const edited = gridPhrases.map((p, i) => (i === 1 ? { ...p, text: "Ganz neuer Text" } : p));
    const words = interimWords(edited, gridUnits);
    expect(pageText(words.filter((w) => w.start >= 7 && w.end <= 14))).toBe("Ganz neuer Text");
    expect(words.filter((w) => w.start >= 7 && w.end <= 14).at(-1)!.end).toBe(9.5);
  });

  it("drops a deleted sentence, keeps word units of Whisper-like jobs", () => {
    const deleted = gridPhrases.map((p, i) => (i === 0 ? { ...p, text: "  " } : p));
    expect(interimWords(deleted, gridUnits)[0].text).toBe("Satz");
    expect(interimWords(deleted, gridUnits)[0].start).toBe(7.5);
    const units = [
      { start: 0, end: 0.4, original_start: 10, original_end: 10.4, text: "Hey," },
      { start: 0.4, end: 0.9, original_start: 10.4, original_end: 10.9, text: "so today" },
    ];
    const phrase = { start: 0, end: 0.9, original_start: 10, original_end: 10.9, text: "Hey, so today" };
    const words = interimWords([phrase], units);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["Hey,", 10, 10.4],
      ["so", 10.4, 10.543], // "so"(2) "today"(5) over 0.5 s
      ["today", 10.543, 10.9],
    ]);
  });

  it("orders by source time and keeps a sentence without units", () => {
    const words = interimWords([gridPhrases[2], gridPhrases[0]], []);
    expect(words[0].text).toBe("Satz");
    expect(words[0].start).toBe(0.5);
  });
});

describe("interimStyleRef (v1 preset → v2 style at the export's position)", () => {
  it("maps the v1 presets and places Clean / Classic / Subtle like UX2", () => {
    expect(interimStyleRef("clipper")).toEqual({ presetId: "clipper", overrides: {} });
    expect(interimStyleRef("clean")).toEqual({ presetId: "minimal", overrides: { y: 0.7 } });
    expect(interimStyleRef("subtle")).toEqual({ presetId: "minimal", overrides: { y: 0.76 } });
    expect(interimStyleRef("classic")).toEqual({ presetId: "power", overrides: { highlightColor: "#FFFFFF", y: 0.72 } });
    expect(interimStyleRef("highlight").presetId).toBe("boxed");
    expect(interimStyleRef("none").presetId).toBe("none");
    expect(WEB_SUB_POS).toEqual({ clean: 0.7, classic: 0.72, subtle: 0.76 });
  });
  it("resolves to a style with that centre", () => {
    const r = interimStyleRef("clean");
    expect(resolveStyle(r.presetId, r.overrides, { W: 360, H: 640 })!.layout.y).toBe(0.7);
  });
});

describe("the engine on the interim feed", () => {
  beforeAll(() => setFontTables(fontsJson as unknown as FontTables));

  it("the active word changes at the stub's word times; no page across a cut", () => {
    const ref = interimStyleRef("clipper");
    const style = resolveStyle(ref.presetId, ref.overrides, { W: 360, H: 640 })!;
    const words = interimWords(gridPhrases, gridUnits);
    const pages = buildPages(words, style, { W: 360, H: 640, lang: "de", breaks: sourceBreaks(GRID) });
    const at = (t: number) => {
      const s = frameState(pages, t, style);
      return s && s.active >= 0 ? pages[s.page].words[s.active].source : null;
    };
    expect(at(0.3)).toBeNull();
    expect(at(0.9)).toBe("Satz");
    expect(at(1.4)).toBe("1");
    expect(at(2.0)).toBe("hier.");
    expect(at(7.9)).toBe("Satz");
    for (const p of pages) {
      const clip = GRID.findIndex(([s, e]) => p.words[0].start >= s && p.words[0].start < e);
      expect(p.words.every((w) => w.start >= GRID[clip][0] && w.end <= GRID[clip][1])).toBe(true);
    }
  });
});

describe("pinV1Geometry", () => {
  it("keeps the classic preview at its pre-UT5 size (the export is still the v1 burn)", async () => {
    const { resolveStyle } = await import("@/lib/captions");
    const { pinV1Geometry } = await import("./interim");
    const ref = interimStyleRef("classic");
    const style = pinV1Geometry(resolveStyle(ref.presetId, ref.overrides, { W: 1080, H: 1920 }), "classic");
    expect(style?.font.size).toBe(0.09);
    expect(style?.layout.maxWidth).toBe(0.8);
    expect(style?.presetId).toBe("power");
  });
  it("leaves other presets and null alone", async () => {
    const { resolveStyle } = await import("@/lib/captions");
    const { pinV1Geometry } = await import("./interim");
    const s = resolveStyle("power", {}, { W: 1080, H: 1920 });
    expect(pinV1Geometry(s, "clipper")).toBe(s);
    expect(pinV1Geometry(null, "classic")).toBeNull();
  });
});

