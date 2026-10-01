import { describe, expect, it } from "vitest";
import {
  canDelete,
  dropIndex,
  frameEdge,
  frameTimes,
  moveSeg,
  playheadCutOf,
  roundToStep,
  rulerMarks,
  snapTrimToFrame,
  tickShown,
  trimFrameGrid,
  trimToStep,
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

describe("UX10: 0.1 s ruler marks, precise trims, the frame grid, reordering", () => {
  it("draws 0.1 s and 0.5 s marks once they are 6 px apart; labels keep their step", () => {
    expect(tickShown("tenth", 59)).toBe(false);
    expect(tickShown("tenth", 60)).toBe(true);
    expect(tickShown("half", 12)).toBe(true);
    expect(tickShown("half", 11)).toBe(false);
    expect(tickShown("major", 1)).toBe(true);
    // 80 px/s on a phone: every 0.1 s mark is there, the labels every second
    const { marks, labelStep } = rulerMarks(0, 800, 10, 358, 48);
    expect(labelStep).toBe(1);
    const shown = marks.filter((m) => tickShown(m.kind, 80));
    expect(shown.filter((m) => m.t < 1).map((m) => m.t)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    // only the visible window (+100 px) is generated
    expect(Math.max(...marks.map((m) => m.x))).toBeLessThanOrEqual(358 + 100);
  });

  it("trims move the edge on a 0.01 s grid and keep a snapped edge exact", () => {
    const clips: EditorSeg[] = [
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 3.123, end: 6 },
    ];
    const bounds = trimBounds(clips, "b", 10);
    expect(roundToStep(3.4749999)).toBe(3.47);
    expect(roundToStep(3.475)).toBe(3.48);
    // drag b's start handle to 2.5373 s of the strip → source 3.123 + (2.5373 - 2) = 3.6603
    const out = trimToStep(clips, "b", "start", 2.5373, bounds);
    expect(out[1].start).toBe(3.66);
    // snapped onto clip a's footage: exactly a's end, not rounded
    expect(trimToStep(clips, "b", "start", 0.95, bounds)[1].start).toBe(2);
    // end handle: 0.01 grid, clamped to the source end
    expect(trimToStep(clips, "b", "end", 2 + 4.0049, trimBounds(clips, "b", 7.5))[1].end).toBe(7.13);
    expect(trimToStep(clips, "b", "end", 50, trimBounds(clips, "b", 7.234))[1].end).toBe(7.234);
  });

  it("puts a released edge on the frame both exports cut at", () => {
    for (const fps of [24, 25, 30000 / 1001, 30, 60]) {
      for (let k = 0; k < 400; k++) {
        const t = roundToStep(k * 0.0137 + 0.004);
        const e = frameEdge(t, fps);
        const frame = Math.round(t * fps);
        // v2 (captions_v2.clip_plan): the nearest frame
        expect(Math.round(e * fps)).toBe(frame);
        // v1 (ffmpeg per clip): the first frame at or after a start, the
        // frames before an end — the same frame boundary
        expect(Math.ceil(e * fps - 1e-9) || 0).toBe(frame);
        // never more than half a frame (+ the margin) from what was shown
        expect(Math.abs(e - t)).toBeLessThanOrEqual(0.5 / fps + 0.0005 + 1e-9);
        // the server keeps ms (/edit-segments rounds to 3 decimals): still that frame
        const ms = Math.round(e * 1000) / 1000;
        expect(Math.round(ms * fps)).toBe(frame);
        expect(Math.ceil(ms * fps - 1e-9) || 0).toBe(frame);
      }
    }
    expect(frameEdge(3.47, null)).toBe(3.47);
    expect(frameEdge(0.01, 30)).toBe(0);
    const clips: EditorSeg[] = [
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 3.47, end: 6.11 },
    ];
    const b = trimBounds(clips, "b", 10);
    expect(snapTrimToFrame(clips, "b", "start", b, 30)[1].start).toBeCloseTo(104 / 30 - 0.0005, 9);
    expect(snapTrimToFrame(clips, "b", "end", b, 30)[1].end).toBeCloseTo(183 / 30 - 0.0005, 9);
    expect(snapTrimToFrame(clips, "b", "start", b, null)).toBe(clips);
    // an edge on the neighbour's footage stays exact
    const joined: EditorSeg[] = [clips[0], { id: "b", start: 2, end: 6.11 }];
    expect(snapTrimToFrame(joined, "b", "start", trimBounds(joined, "b", 10), 30)[1].start).toBe(2);
  });

  it("lists the frame grid (k / fps) inside a range", () => {
    expect(frameTimes(1, 1.1, 30).map((x) => +x.toFixed(4))).toEqual([1, 1.0333, 1.0667, 1.1]);
    expect(frameTimes(0.01, 0.05, 25)).toEqual([0.04]);
    expect(frameTimes(0, 100, 30, 10)).toHaveLength(10);
    expect(frameTimes(1, 0, 30)).toEqual([]);
    // an edge rounded to 0.01 is never more than half a frame from the frame the v2 export picks
    for (const t of [3.47, 0.01, 12.35, 7.99]) {
      const f = Math.round(t * 30) / 30;
      expect(Math.abs(f - t)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    }
  });

  it("the trim grid is counted from the visible window: the end handle of a long clip has it (review 3/10)", () => {
    // a 30 s clip (10–40 s source) at strip 5 s, 30 fps, magnified around its end handle
    const clip = { left: 5, start: 10, end: 40 };
    const lo = 5 + 29.6;
    const hi = 5 + 30.4;
    const end = trimFrameGrid(clip, "end", lo, hi, 30);
    expect(end.length).toBeGreaterThanOrEqual(23);
    expect(Math.min(...end)).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(Math.max(...end)).toBeLessThanOrEqual(hi + 1e-9);
    // the handle itself (strip 35 = source 40) is a grid line
    expect(end.some((x) => Math.abs(x - 35) < 1e-9)).toBe(true);
    // 60 fps, past the end: what a trim grows into (up to 2 s)
    const grow = trimFrameGrid(clip, "end", 5 + 31, 5 + 31.5, 60);
    expect(grow.length).toBe(31);
    expect(trimFrameGrid(clip, "end", 5 + 32.5, 5 + 33, 60)).toEqual([]);
    // the start handle: 2 s before the clip, none after the window
    const start = trimFrameGrid(clip, "start", 4, 5.5, 30);
    expect(Math.min(...start)).toBeCloseTo(4, 9);
    expect(Math.max(...start)).toBeCloseTo(5.5, 9);
    // the old cap counted from the clip start: nothing here
    const capped = frameTimes(10, 42, 30, 600).map((f) => 5 + (f - 10)).filter((x) => x >= lo && x <= hi);
    expect(capped).toEqual([]);
  });

  it("moves a clip to a drop index; the others make room", () => {
    const clips: EditorSeg[] = [
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 3, end: 4 },
      { id: "c", start: 5, end: 8 },
    ];
    // a's centre dragged to 2.6 s: past b's middle (0.5 s), before c's (2.5 s)
    expect(dropIndex(clips, "a", 2.6)).toBe(2);
    expect(moveSeg(clips, "a", 2).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(dropIndex(clips, "a", 0.4)).toBe(0);
    expect(moveSeg(clips, "a", 0)).toBe(clips); // stays: same array, no undo step
    expect(dropIndex(clips, "c", 0.2)).toBe(0);
    expect(moveSeg(clips, "c", 0).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(moveSeg(clips, "zz", 1)).toBe(clips);
    // a disabled clip has no place in the layout
    const withOff = [...clips.slice(0, 1), { id: "x", start: 9, end: 9.5, disabled: true }, ...clips.slice(1)];
    expect(dropIndex(withOff, "c", 2.4)).toBe(2);
  });
});
