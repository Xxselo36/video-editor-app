import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { firstMode, sourceTimeOf } from "./useEditSession";
import {
  landOf,
  previewMatches,
  previewSpeedAt,
  previewTimeOf,
  proxyPlays,
  skipTarget,
  stalePlan,
  swapTime,
  type Segs,
} from "./previewSync";
import { playheadCutOf } from "@/features/editor/timeline/mechanics";

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
    // at old-file time 9.7 (source 10.7, now removed): jump to 11 (source 13), a frame in
    const to = skipTarget(plan, 9.7) as number;
    expect(to).toBeGreaterThan(11);
    expect(to).toBeLessThan(11.05);
    expect(sourceTimeOf(to, "preview", OLD, [], 20)).toBeCloseTo(13 + (to - 11), 6);
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

describe("round 2: the frame after a skip, the speed of a preview segment", () => {
  it("the frame at a join is the next segment's first frame: playhead and caption after a skip (F11)", () => {
    // the old file's join at 5 (end of [0,5], start of [6,12])
    expect(sourceTimeOf(5, "preview", OLD, [], 20)).toBe(6);
    expect(sourceTimeOf(5 - 0.00005, "preview", OLD, [], 20)).toBe(6);
    expect(sourceTimeOf(4.99, "preview", OLD, [], 20)).toBeCloseTo(4.99, 6);
    // the end of the file is the last segment's end
    expect(sourceTimeOf(18, "preview", OLD, [], 20)).toBe(20);
    // clip a trimmed to 0–3.6 (3.6–5 removed): playing the old file skips to the join;
    // the frame there (its timestamp IS the join) has a playhead on the new clips
    const edit = [seg("a", 0, 3.6), seg("b", 6, 12), seg("c", 13, 20)];
    const plan = stalePlan(OLD, edit);
    const to = skipTarget(plan, 3.58, 0.03, landOf(30)) as number;
    expect(to).toBeGreaterThan(5);
    // the frame a seek to `to` shows (the last one starting at or before it, a
    // 30 fps file whose frames don't start at the join) is the next part's
    const shown = Math.floor(to * 30 + 1e-9) / 30;
    expect(shown).toBeGreaterThanOrEqual(5 - 1e-9);
    for (const frame of [5, shown, to]) expect(playheadCutOf(edit, sourceTimeOf(frame, "preview", OLD, [], 20))).not.toBeNull();
    // a seek to just past the join (what it did) can show the frame before it: cut footage
    expect(playheadCutOf(edit, sourceTimeOf(Math.floor((5 + 1e-3) * 30 - 0.5) / 30, "preview", OLD, [], 20))).toBeNull();
  });

  it("previewSpeedAt: each preview segment plays at its clip's speed (the file has none baked in)", () => {
    const edit = [seg("a", 0, 5), { ...seg("b", 6, 12), speed: 1.5 }, seg("c", 13, 20)];
    expect(previewSpeedAt(OLD, edit, 2)).toBe(1);
    expect(previewSpeedAt(OLD, edit, 5)).toBe(1.5); // the join: b's first frame
    expect(previewSpeedAt(OLD, edit, 10.9)).toBe(1.5);
    expect(previewSpeedAt(OLD, edit, 11)).toBe(1);
    // a file older than the edit: the clip that plays that source moment
    const trimmed = [seg("a", 0, 5), { ...seg("b", 6, 10), speed: 2 }, seg("c", 13, 20)];
    expect(previewSpeedAt(OLD, trimmed, 6)).toBe(2);
    expect(previewSpeedAt(OLD, trimmed, 9.5)).toBe(1); // source 10.5: cut, played at 1x
    // clamped like the export
    expect(previewSpeedAt(OLD, [seg("a", 0, 5), { ...seg("b", 6, 12), speed: 9 }, seg("c", 13, 20)], 6)).toBe(4);
  });
});

describe("firstMode (round 9: the proxy only for a known rate up to 30 fps)", () => {
  it("plays the proxy of a 24, 25, 29.97 or 30 fps job", () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 30.03]) expect(firstMode(true, fps), `${fps}`).toBe("proxy");
    expect(proxyPlays(30)).toBe(true);
  });

  it("plays the server's cut preview of a 50, 59.94 or 60 fps job, and of one without its frame rate", () => {
    for (const fps of [50, 59.94, 60, 48, 30.1, 120]) expect(firstMode(true, fps), `${fps}`).toBe("preview");
    for (const fps of [null, undefined, 0, -30, NaN]) expect(firstMode(true, fps), `${fps}`).toBe("preview");
    expect(proxyPlays(60)).toBe(false);
    expect(proxyPlays(null)).toBe(false);
  });

  it("no proxy: the preview; has_proxy not reported: asked (GET /proxy-video) only where the proxy would play", () => {
    expect(firstMode(false, 30)).toBe("preview");
    expect(firstMode(false, null)).toBe("preview");
    expect(firstMode(undefined, 30)).toBe("probing");
    expect(firstMode(undefined, 25)).toBe("probing");
    expect(firstMode(undefined, 60)).toBe("preview");
    expect(firstMode(undefined, null)).toBe("preview");
  });
});
