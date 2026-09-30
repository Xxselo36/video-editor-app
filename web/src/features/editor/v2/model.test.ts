import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import {
  cutDuration,
  cutTimeOfSource,
  decimalSeparator,
  fitFrame,
  phoneFrame,
  fmtClock,
  fmtClockTenths,
  fmtSeconds,
  removedRanges,
  seams,
  videoBox,
} from "./model";

const clips: EditorSeg[] = [
  { id: "a", start: 0.5, end: 3 },
  { id: "b", start: 3.9, end: 6 },
  { id: "c", start: 6, end: 8 }, // split of the same footage
  { id: "d", start: 9, end: 10, disabled: true },
];

describe("v2 model", () => {
  it("measures the edit without disabled clips", () => {
    expect(cutDuration(clips)).toBeCloseTo(6.6);
  });

  it("lists removed source ranges, head and tail included", () => {
    expect(removedRanges(clips, 10)).toEqual([
      { start: 0, end: 0.5 },
      { start: 3, end: 3.9 },
      { start: 8, end: 10 },
    ]);
    expect(removedRanges([{ id: "x", start: 0, end: 10 }], 10)).toEqual([]);
  });

  it("doesn't count footage a moved clip still plays", () => {
    const moved: EditorSeg[] = [
      { id: "b", start: 5, end: 10 },
      { id: "a", start: 0, end: 5 },
    ];
    expect(removedRanges(moved, 10)).toEqual([]);
  });

  it("marks seams between clips: cut or split", () => {
    const s = seams(clips);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ cut: true });
    expect(s[0].at).toBeCloseTo(2.5);
    expect(s[0].gap).toBeCloseTo(0.9);
    expect(s[1]).toMatchObject({ cut: false, gap: 0 });
    expect(s[1].at).toBeCloseTo(4.6);
  });

  it("maps source time to the cut timeline, cut-out time to the next clip", () => {
    expect(cutTimeOfSource(clips, 1)).toBeCloseTo(0.5);
    expect(cutTimeOfSource(clips, 3.5)).toBeCloseTo(2.5); // in the pause → b's start
    expect(cutTimeOfSource(clips, 0.1)).toBe(0); // before a
    expect(cutTimeOfSource(clips, 9.5)).toBeCloseTo(6.6); // after the end
  });

  it("formats clocks with the language's decimal separator", () => {
    expect(fmtClock(65.9)).toBe("1:05");
    expect(fmtClockTenths(3.24, ",")).toBe("0:03,2");
    expect(fmtClockTenths(59.96, ".")).toBe("1:00.0");
    expect(fmtSeconds(0.94, ",")).toBe("0,9 s");
    expect(decimalSeparator("de")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
  });

  it("fits the 9:16 frame into the stage", () => {
    // 1440×900: stage cell 1060×698 minus player row and padding
    expect(fitFrame(1012, 602, 9 / 16)).toEqual({ w: 338, h: 602 });
    // width-bound
    expect(fitFrame(300, 900, 9 / 16)).toEqual({ w: 300, h: 533 });
    expect(fitFrame(0, 100, 9 / 16)).toEqual({ w: 0, h: 0 });
  });

  it("places the picture: contain pads, cover crops", () => {
    // 16:9 video in a 9:16 frame
    const c = videoBox(180, 320, 1920, 1080, "contain");
    expect(c.w).toBe(180);
    expect(c.h).toBeCloseTo(101.25);
    expect(c.y).toBeCloseTo(109.375);
    const v = videoBox(180, 320, 1920, 1080, "cover");
    expect(v.h).toBe(320);
    expect(v.w).toBeCloseTo(568.9, 1);
    expect(v.x).toBeCloseTo(-194.4, 1);
    // same aspect: both fill the frame
    expect(videoBox(180, 320, 1080, 1920, "contain")).toEqual({ x: 0, y: 0, w: 180, h: 320 });
  });
});

describe("phoneFrame", () => {
  it("is 186×330 on a 390×844 phone, with and without a sheet", () => {
    expect(phoneFrame(390, 844, { landscape: false, sheetOpen: false, tabH: 56 })).toEqual({ w: 186, h: 330 });
    expect(phoneFrame(390, 844, { landscape: false, sheetOpen: true, tabH: 56 })).toEqual({ w: 186, h: 330 });
  });

  it("shrinks on a short portrait screen so the dock keeps ≥ 150 px", () => {
    const f = phoneFrame(375, 550, { landscape: false, sheetOpen: false, tabH: 56 });
    expect(f.h).toBeLessThan(330);
    expect(550 - 44 - 56 - (12 + f.h + 12 + 44)).toBeGreaterThanOrEqual(150);
    // above a 54 % sheet
    const g = phoneFrame(375, 550, { landscape: false, sheetOpen: true, tabH: 56 });
    expect(44 + g.h + 14).toBeLessThanOrEqual(550 * 0.46 + 0.5);
  });

  it("fills the left column in landscape", () => {
    const f = phoneFrame(844, 390, { landscape: true, sheetOpen: false, tabH: 48 });
    expect(f.h).toBe(390 - 44 - 48 - 64);
    expect(f.w).toBe(Math.round((f.h * 9) / 16));
  });
});
