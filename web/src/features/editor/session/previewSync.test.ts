import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { sourceTimeOf } from "./useEditSession";
import { previewMatches, previewTimeOf, skipTarget, stalePlan, swapTime, type Segs } from "./previewSync";

const seg = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });

// the preview on screen was cut from these source ranges
const OLD: Segs = [
  [0, 5],
  [6, 12],
  [13, 20],
];

describe("preview mode follows the edit while the server rebuilds (preview-2/3/6)", () => {
  it("previewMatches: the file on screen shows exactly the clips (the chip stays until then)", () => {
    expect(previewMatches(OLD, [seg("a", 0, 5), seg("b", 6, 12), seg("c", 13, 20)])).toBe(true);
    // the server keeps ms / exact frame edges
    expect(previewMatches(OLD, [seg("a", 0, 5.0004), seg("b", 6, 12), seg("c", 13, 20)])).toBe(true);
    expect(previewMatches(OLD, [seg("a", 0, 3.6), seg("b", 6, 12), seg("c", 13, 20)])).toBe(false);
    // a clip too short to save (< 0.05 s) isn't in either
    expect(previewMatches(OLD, [seg("a", 0, 5), seg("t", 5.2, 5.22), seg("b", 6, 12), seg("c", 13, 20)])).toBe(true);
  });

  it("stalePlan: playing the old file skips what the edit removed", () => {
    // clip b trimmed: its end 12 → 10.6 (1.4 s removed)
    const edit = [seg("a", 0, 5), seg("b", 6, 10.6), seg("c", 13, 20)];
    const plan = stalePlan(OLD, edit);
    expect(plan.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([
      [0, 9.6],
      [11, 18],
    ]);
    // at old-file time 9.7 (source 10.7, now removed): jump to 11 (source 13)
    const to = skipTarget(plan, 9.7) as number;
    expect(to).toBeCloseTo(11, 2);
    expect(sourceTimeOf(to, "preview", OLD, [], 20)).toBeCloseTo(13, 2);
    expect(skipTarget(plan, 5)).toBeNull();
    expect(skipTarget(plan, 17.99)).toBe("end");
    // a cut inside clip c: [0, 9.6] stays, c's removed middle is skipped
    const cut = [seg("a", 0, 5), seg("b", 6, 12), seg("c", 13, 15), seg("c2", 16, 20)];
    expect(stalePlan(OLD, cut).map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([
      [0, 13],
      [14, 18],
    ]);
  });

  it("swapTime: the new file starts at the same SOURCE moment, not the old cut time", () => {
    // paused at old-file 9.489 = source 10.489 in clip b; clip a's end trimmed by 1.23 s
    const NEW: Segs = [
      [0, 3.77],
      [6, 12],
      [13, 20],
    ];
    const was = 9.489;
    const t = swapTime(was, OLD, NEW);
    expect(sourceTimeOf(t, "preview", NEW, [], 20)).toBeCloseTo(10.489, 6);
    // the old cut time would have shown source 11.719 (the bug)
    expect(sourceTimeOf(was, "preview", NEW, [], 20)).toBeCloseTo(11.719, 6);
    // the moment was cut by the edit: where the cut continues
    const cutB: Segs = [
      [0, 5],
      [6, 9],
      [13, 20],
    ];
    expect(sourceTimeOf(swapTime(was, OLD, cutB), "preview", cutB, [], 20)).toBeCloseTo(13, 2);
    // a seek into footage only the new file has: the swap lands there
    const ext: Segs = [
      [0, 5.8],
      [6, 12],
      [13, 20],
    ];
    expect(previewTimeOf(5.5, OLD)).toBeNull();
    expect(sourceTimeOf(swapTime(2, OLD, ext, 5.5), "preview", ext, [], 20)).toBeCloseTo(5.5, 6);
  });
});
