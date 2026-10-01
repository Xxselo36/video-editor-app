import { describe, expect, it } from "vitest";
import { mapToOutput, resolveStyle } from "@/lib/captions";
import type { DocWord } from "@/features/editor/state/doc";
import { adjustedWordIds } from "./adjusted";
import { clipsOf, frameOf, nextLine, nextSize, outputTime, shownWords, snapLines, snapY, tileOrder } from "./live";

const W = (id: string, text: string, start: number, end: number, extra: Partial<DocWord> = {}): DocWord => ({
  id,
  text,
  start,
  end,
  ...extra,
});

describe("live captions: words and time (the export's, backend/captions_v2.py)", () => {
  it("drops hidden words and carries their forced break to the next shown word", () => {
    const words = [
      W("w1", "Nobody", 0, 0.3),
      W("w2", "äh", 0.35, 0.5, { hidden: true, filler: true, breakBefore: true }),
      W("w3", "waits", 0.55, 0.8),
      W("w4", " ", 0.85, 0.9),
      W("w5", "ten", 0.95, 1.1, { breakBefore: true }),
    ];
    expect(shownWords(words)).toEqual([
      { id: "w1", text: "Nobody", start: 0, end: 0.3 },
      { id: "w3", text: "waits", start: 0.55, end: 0.8, breakBefore: true },
      { id: "w5", text: "ten", start: 0.95, end: 1.1, breakBefore: true },
    ]);
  });

  it("clips: enabled segments in play order, with speed", () => {
    const clips = clipsOf([
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 2, end: 3, disabled: true },
      { id: "c", start: 5, end: 7, speed: 2 },
    ]);
    expect(clips).toEqual([
      { id: "a", start: 0, end: 2, speed: 1 },
      { id: "c", start: 5, end: 7, speed: 2 },
    ]);
  });

  it("output time of the playing frame agrees with mapToOutput's word times", () => {
    const clips = clipsOf([
      { id: "a", start: 0, end: 2 },
      { id: "c", start: 5, end: 7, speed: 2 },
      { id: "d", start: 1, end: 1.5 }, // a repeat of a moment of "a"
    ]);
    expect(outputTime(clips, 1, null)).toBeCloseTo(1);
    expect(outputTime(clips, 6, null)).toBeCloseTo(2.5);
    expect(outputTime(clips, 3, null)).toBeNull(); // cut away
    expect(outputTime(clips, 1.2, "d")).toBeCloseTo(3.2); // the player is in the repeat
    const tl = mapToOutput(clips, [{ id: "x", text: "six", start: 6, end: 6.4 }]);
    expect(tl.words[0].start).toBeCloseTo(outputTime(clips, 6, null)!);
  });
});

describe("dragging", () => {
  it("snaps to the mock's lines and the style's own y", () => {
    expect(snapLines(0.68)).toEqual([0.56, 0.68, 0.79]); // Power: its own y is the middle line
    expect(snapLines(0.85)).toEqual([0.56, 0.7, 0.79, 0.85]); // 16:9
    expect(snapY(0.69, snapLines(0.68))).toEqual({ y: 0.68, line: 0.68 });
    expect(snapY(0.4, snapLines(0.68))).toEqual({ y: 0.4, line: null });
    expect(snapY(1.2, [])).toEqual({ y: 0.95, line: null });
  });

  it("a click on a handle steps through the lines and the sizes", () => {
    const lines = snapLines(0.68);
    expect(nextLine(0.68, lines)).toBe(0.79);
    expect(nextLine(0.79, lines)).toBe(0.56);
    expect(nextSize(1)).toBe(1.15);
    expect(nextSize(1.15)).toBe(0.9);
    expect(nextSize(0.9)).toBe(1);
  });
});

describe("Text tab marker and Style panel", () => {
  it("marks the words with their own caption values", () => {
    expect([...adjustedWordIds({ captions: { w3: { y: 0.3 } }, y: 0.5 })]).toEqual(["w3"]);
    expect(adjustedWordIds({}).size).toBe(0);
    expect(adjustedWordIds(null).size).toBe(0);
  });

  it("tiles: recommended first (live and available only), the rest in launch order", () => {
    const en = tileOrder(null, ["power", "punch", "karaoke"], "en");
    expect(en.recommended.map((t) => t.id)).toEqual(["power", "punch", "karaoke"]);
    expect(en.rest).toHaveLength(9);
    expect(en.rest.every((t) => t.available)).toBe(true);
    // Russian: Mega, Clipper and One Word can't caption Cyrillic — greyed, never recommended
    const ru = tileOrder(null, ["clipper", "power"], "ru");
    expect(ru.recommended.map((t) => t.id)).toEqual(["power"]);
    expect(ru.rest.filter((t) => !t.available).map((t) => t.id)).toEqual(["mega", "clipper", "punch"]);
    // only live presets
    const narrow = tileOrder(["power", "clipper", "none"], [], "en");
    expect([...narrow.recommended, ...narrow.rest].map((t) => t.id)).toEqual(["power", "clipper"]);
  });
});

describe("the style's frame (review 5)", () => {
  it("is the video's own size, so a 4:5 video gets the export's position", () => {
    // 337×421 canvas (desktop frame at DPR 1) over a 1080×1350 (4:5) video
    const L = { W: 337, H: 421, vw: 1080, vh: 1350 };
    const preview = resolveStyle("power", {}, frameOf(L))!;
    const exported = resolveStyle("power", {}, { W: 1080, H: 1350 })!;
    expect(preview.layout.y).toBe(exported.layout.y);
    expect(resolveStyle("power", {}, { W: 337, H: 421 })!.layout.y).not.toBe(exported.layout.y); // the old bug
    expect(frameOf({ W: 337, H: 421, vw: 0, vh: 0 })).toEqual({ W: 337, H: 421 });
  });
});
