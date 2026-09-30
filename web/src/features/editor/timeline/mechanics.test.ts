import { describe, expect, it } from "vitest";
import {
  canDelete,
  playheadCutOf,
  rulerMarks,
  sourceAtCut,
  splitAt,
  splittableIndex,
  stripDuration,
  trimBounds,
  trimTo,
  zoomLimits,
  type EditorSeg,
} from "./mechanics";

// Two clips with a removed pause (2–3 s) between them.
const segs: EditorSeg[] = [
  { id: "a", start: 0, end: 2 },
  { id: "b", start: 3, end: 6 },
];

describe("timeline mechanics", () => {
  it("lays the clips end to end", () => {
    expect(stripDuration(segs)).toBe(5);
    expect(stripDuration([])).toBe(1);
  });

  it("maps source time to the cut timeline and back", () => {
    expect(playheadCutOf(segs, 1)).toBe(1);
    expect(playheadCutOf(segs, 4)).toBe(3);
    expect(playheadCutOf(segs, 2.5)).toBeNull(); // cut out
    expect(sourceAtCut(segs, 3)).toEqual({ t: 4, segId: "b" });
    expect(sourceAtCut(segs, 0.5)).toEqual({ t: 0.5, segId: "a" });
    expect(sourceAtCut([], 1)).toBeNull();
  });

  it("prefers the playing clip at a split point", () => {
    const split: EditorSeg[] = [
      { id: "x", start: 0, end: 2 },
      { id: "y", start: 2, end: 4 },
    ];
    expect(playheadCutOf(split, 2)).toBe(2);
    expect(playheadCutOf(split, 2, "y")).toBe(2);
    // A clip moved before its neighbour: the playing clip decides.
    const moved: EditorSeg[] = [
      { id: "y", start: 2, end: 4 },
      { id: "x", start: 0, end: 2 },
    ];
    expect(playheadCutOf(moved, 2, "x")).toBe(4);
    expect(playheadCutOf(moved, 2)).toBe(0);
  });

  it("splits only inside a clip, 0.1 s from its edges", () => {
    expect(splittableIndex(segs, 1)).toBe(0);
    expect(splittableIndex(segs, 2.05)).toBe(-1);
    expect(splittableIndex(segs, 3.05)).toBe(-1);
    expect(splittableIndex(segs, 2.5)).toBe(-1);
    const next = splitAt(segs, 1, 4.5, 123);
    expect(next.map((s) => [s.id, s.start, s.end])).toEqual([
      ["a", 0, 2],
      ["b-a", 3, 4.5],
      ["b-b-123", 4.5, 6],
    ]);
  });

  it("never deletes the last clip", () => {
    expect(canDelete(segs, "a")).toBe(true);
    expect(canDelete([segs[0]], "a")).toBe(false);
  });

  it("trims within the removed footage and snaps onto a neighbour", () => {
    const bounds = trimBounds(segs, "b", 8);
    expect(bounds).toEqual({ prev: 2, next: 8 });
    // Grow b's start back by 0.5 s (strip seconds: b starts at 2).
    expect(trimTo(segs, "b", "start", 1.5, bounds)[1].start).toBeCloseTo(2.5);
    // Within TRIM_SNAP_S of a's footage: snaps onto it.
    expect(trimTo(segs, "b", "start", 1.1, bounds)[1].start).toBe(2);
    // Shrinking never goes below 0.1 s.
    expect(trimTo(segs, "b", "end", 2.01, bounds)[1].end).toBeCloseTo(3.1);
    // Growing the end stops at the source end.
    expect(trimTo(segs, "b", "end", 9, bounds)[1].end).toBe(8);
  });

  it("zooms between fit and the cap", () => {
    expect(zoomLimits(1000, 20)).toEqual({ fitPps: 50, maxPps: 400 });
    // Very long video: the cap shrinks, never below fit.
    expect(zoomLimits(1000, 3600).maxPps).toBeCloseTo(200_000 / 3600);
    expect(zoomLimits(1000, 10_000).maxPps).toBe(20);
    expect(zoomLimits(300_000, 100).maxPps).toBe(3000);
  });

  it("puts ruler labels at least minLabelPx apart", () => {
    const { marks, labelStep } = rulerMarks(0, 1400, 28, 1400);
    expect(labelStep).toBe(2); // 50 px/s → 2 s = 100 px ≥ 56
    const majors = marks.filter((m) => m.kind === "major").map((m) => m.t);
    expect(majors.slice(0, 4)).toEqual([0, 2, 4, 6]);
    expect(marks.every((m) => m.x === m.t * 50)).toBe(true);
  });
});
