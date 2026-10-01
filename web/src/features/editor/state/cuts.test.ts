import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { removedRanges } from "@/features/editor/v2/model";
import {
  aiCutsOf,
  countKinds,
  cutRange,
  cutWords,
  gapKind,
  labelRemoved,
  MIN_ISLAND_S,
  MIN_REMOVAL_S,
  restoreKind,
  restoreRange,
  restoreWord,
  textMarks,
  type Piece,
} from "./cuts";
import type { DocWord } from "./doc";
import { peaksFromBytes, snapEdge } from "./snap";

const seg = (id: string, start: number, end: number, x: Partial<EditorSeg> = {}): EditorSeg => ({ id, start, end, ...x });
const spans = (segs: EditorSeg[]) => segs.filter((s) => !s.disabled).map((s) => [+s.start.toFixed(3), +s.end.toFixed(3)]);

/** A tiny seeded PRNG (mulberry32), so property runs are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Removals and kept islands of a clip list (source order). */
function shapes(segs: EditorSeg[], duration: number) {
  const kept = segs.filter((s) => !s.disabled).map((s) => [s.start, s.end] as const).sort((a, b) => a[0] - b[0]);
  const removals = removedRanges(segs, duration, 1e-6).map((r) => r.end - r.start);
  const islands = kept.filter(([s, e]) => {
    const left = s > 1e-3 && !kept.some(([a, b]) => a < s - 1e-3 && b > s - 1e-3);
    const right = e < duration - 1e-3 && !kept.some(([a, b]) => b > e + 1e-3 && a < e + 1e-3);
    return left && right;
  });
  return { removals, islands: islands.map(([s, e]) => e - s) };
}

// ── snapping (testdata/snap_vectors.json, shared with the backend) ──

type SnapVector = { name: string; peaks: number[]; t: number; expected: number; window?: number };
const SNAP = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../../../../testdata/snap_vectors.json", import.meta.url)), "utf8"),
) as { window: number; rate: number; vectors: SnapVector[] };

describe("snapEdge (testdata/snap_vectors.json, twin of audio_analysis.snap_edge)", () => {
  it.each(SNAP.vectors.map((v) => [v.name, v] as const))("%s", (_n, v) => {
    expect(snapEdge(v.t, v.peaks, v.window ?? SNAP.window, SNAP.rate)).toBeCloseTo(v.expected, 9);
  });

  it("no peaks: unchanged", () => {
    expect(snapEdge(1.234, null)).toBe(1.234);
    expect(snapEdge(1.234, [])).toBe(1.234);
  });

  it("reads peaks.bin bytes", () => {
    expect([...peaksFromBytes(new Int8Array([0, 5, 127, -3]).buffer)]).toEqual([0, 5, 127, 0]);
  });

  it("a snapped edge lies within ±120 ms at a local energy minimum", () => {
    const r = rng(7);
    const peaks = Array.from({ length: 1000 }, () => Math.floor(r() * 128));
    for (let k = 0; k < 300; k++) {
      const t = 0.2 + r() * 9.5;
      const s = snapEdge(t, peaks);
      expect(Math.abs(s - t)).toBeLessThanOrEqual(0.12 + 1e-9);
      const i = Math.round(s * 100 - 0.5);
      for (let f = Math.max(0, Math.floor((t - 0.12) * 100 - 0.5)); f <= Math.ceil((t + 0.12) * 100 - 0.5); f++) {
        if (Math.abs((f + 0.5) / 100 - t) <= 0.12 + 1e-9) expect(peaks[i]).toBeLessThanOrEqual(peaks[f]);
      }
    }
  });
});

// ── kinds ───────────────────────────────────────────────────────────

describe("what was removed and why", () => {
  const words: DocWord[] = [
    { id: "w1", text: "Hello", start: 0.3, end: 0.7 },
    { id: "w2", text: "um", start: 1.2, end: 1.5, filler: true, hidden: true },
    { id: "w3", text: "world.", start: 2.0, end: 2.4 },
  ];

  it("old jobs: a cut with a filler word is a filler, else a pause", () => {
    const ai = aiCutsOf([{ id: 1, start: 0.9, end: 1.9 }, { id: 0, start: 0, end: 0.2 }], words);
    expect(ai).toEqual([
      { start: 0, end: 0.2, kind: "silence" },
      { start: 0.9, end: 1.9, kind: "filler" },
    ]);
    expect(aiCutsOf([{ id: 0, start: 3, end: 4, kind: "voice_cmd" }, { id: 1, start: 5, end: 4 }], words)).toEqual([
      { start: 3, end: 4, kind: "voice_cmd" },
    ]);
  });

  it("removed ranges split by the analysis cuts; the rest is the user's", () => {
    const ai = aiCutsOf(
      [
        { id: 0, start: 1, end: 2, kind: "silence" },
        { id: 1, start: 4, end: 6, kind: "voice_cmd" },
        { id: 2, start: 5, end: 7, kind: "silence" },
      ],
      [],
    );
    const pieces = labelRemoved([{ start: 0.5, end: 2 }, { start: 4, end: 8 }], ai);
    expect(pieces).toEqual([
      { start: 0.5, end: 1, kind: "user" },
      { start: 1, end: 2, kind: "silence" },
      { start: 4, end: 6, kind: "voice_cmd" }, // the stronger reason where they overlap
      { start: 6, end: 7, kind: "silence" },
      { start: 7, end: 8, kind: "user" },
    ]);
    expect(countKinds(pieces)).toEqual({ silence: 2, filler: 0, voice_cmd: 1, bad_take: 0, user: 2 });
    expect(gapKind(pieces, 4, 8)).toBe("voice_cmd");
    expect(gapKind(pieces, 9, 10)).toBe("user");
  });
});

// ── ops ─────────────────────────────────────────────────────────────

describe("cut and restore", () => {
  const D = 20;
  const clips = [seg("a", 0, 5), seg("b", 6, 12), seg("c", 13, 20)];

  it("cutting inside a clip splits it; restoring the range returns the original clips", () => {
    const cut = cutRange(clips, 7, 8.5, D);
    expect(spans(cut)).toEqual([
      [0, 5],
      [6, 7],
      [8.5, 12],
      [13, 20],
    ]);
    expect(new Set(cut.map((s) => s.id)).size).toBe(cut.length);
    expect(restoreRange(cut, 7, 8.5, D)).toEqual(clips);
  });

  it("a removal under MIN_REMOVAL_S is not made", () => {
    expect(cutRange(clips, 7, 7 + MIN_REMOVAL_S - 0.01, D)).toBe(clips);
    expect(restoreRange(clips, 1, 2, D)).toBe(clips); // nothing removed there
  });

  it("a kept island under MIN_ISLAND_S between two removals goes with them", () => {
    // 6–6.2 would stay between the cut and the gap before clip b
    expect(spans(cutRange(clips, 6.2, 8, D))).toEqual([
      [0, 5],
      [8, 12],
      [13, 20],
    ]);
  });

  it("a short removal left next to a restore closes", () => {
    // restoring 5.05–6 would leave 5–5.05 removed: the clips meet instead
    const cut = restoreRange(clips, 5.05, 6, D);
    expect(spans(cut)).toEqual([
      [0, 12],
      [13, 20],
    ]);
  });

  it("restoring a gap between two clips merges them (effects kept apart)", () => {
    expect(spans(restoreRange(clips, 5, 6, D))).toEqual([
      [0, 12],
      [13, 20],
    ]);
    const fx = [seg("a", 0, 5, { speed: 2 }), seg("b", 6, 12)];
    const out = restoreRange(fx, 5, 6, D);
    expect(out.map((s) => [s.id, s.start, s.end, s.speed])).toEqual([
      ["a", 0, 6, 2],
      ["b", 6, 12, undefined],
    ]);
  });

  it("restoring a hole no clip touches makes a clip of its own, in source order", () => {
    const out = restoreRange(clips, 5.3, 5.7, D);
    expect(spans(out)).toEqual([
      [0, 5],
      [5.3, 5.7],
      [6, 12],
      [13, 20],
    ]);
  });

  it("restoreWord pads a short word so it can't vanish as an island", () => {
    const um = { start: 5.4, end: 5.55 };
    const out = restoreWord(clips, um, D);
    const island = out.find((s) => s.start <= 5.4 && s.end >= 5.55)!;
    expect(island.end - island.start).toBeGreaterThanOrEqual(MIN_ISLAND_S);
  });

  it("never cuts the last clip away", () => {
    const one = [seg("a", 0, 5)];
    expect(cutRange(one, 0, 5, 5)).toBe(one);
  });

  it("cutWords snaps both edges to the quietest moment", () => {
    const words: DocWord[] = [
      { id: "w1", text: "one", start: 1.0, end: 1.4 },
      { id: "w2", text: "two", start: 1.5, end: 2.0 },
      { id: "w3", text: "three", start: 2.1, end: 2.6 },
    ];
    const peaks = new Array(400).fill(80);
    peaks[146] = 2; // 1.465 s: the quiet gap before "two"
    peaks[205] = 3; // 2.055 s: after it
    const out = cutWords([seg("a", 0, 4)], words, 1, 1, 4, peaks);
    expect(spans(out)).toEqual([
      [0, 1.465],
      [2.055, 4],
    ]);
    // without peaks: the word's own times
    expect(spans(cutWords([seg("a", 0, 4)], words, 1, 1, 4))).toEqual([
      [0, 1.5],
      [2, 4],
    ]);
  });
});

describe("bulk restore", () => {
  const D = 30;
  const ai = aiCutsOf(
    [
      { id: 0, start: 2, end: 3, kind: "silence" },
      { id: 1, start: 6, end: 6.6, kind: "filler" },
      { id: 2, start: 10, end: 14, kind: "voice_cmd" },
      { id: 3, start: 18, end: 19, kind: "silence" },
    ],
    [],
  );
  const clips = [seg("a", 0, 2), seg("b", 3, 6), seg("c", 6.6, 10), seg("d", 14, 18), seg("e", 19, 30)];
  // the user also cut 22–24
  const edited = cutRange(clips, 22, 24, D);
  const pieces = (segs: EditorSeg[]): Piece[] => labelRemoved(removedRanges(segs, D), ai);

  it.each(["silence", "filler", "voice_cmd"] as const)("restoreKind(%s) restores exactly that kind", (kind) => {
    const before = pieces(edited);
    const out = restoreKind(edited, before, kind, D);
    const after = pieces(out);
    expect(after.filter((p) => p.kind === kind)).toEqual([]);
    expect(after).toEqual(before.filter((p) => p.kind !== kind));
  });

  it("restore all AI cuts keeps the user's cut", () => {
    const out = restoreKind(edited, pieces(edited), "ai", D);
    expect(pieces(out)).toEqual([{ start: 22, end: 24, kind: "user" }]);
  });
});

// ── properties ──────────────────────────────────────────────────────

describe("properties (seeded random op sequences)", () => {
  const D = 60;
  function randomClips(r: () => number): EditorSeg[] {
    // clean like an analysis after C11: removals ≥ 0.3 s, clips ≥ 1 s
    const out: EditorSeg[] = [];
    let t = r() < 0.3 ? 0 : 0.3 + r() * 2;
    let i = 0;
    while (t < D - 2) {
      const len = 1 + r() * 6;
      let end = Math.min(D, t + len);
      if (D - end < 0.3) end = D;
      out.push(seg(`s${i++}`, +t.toFixed(3), +end.toFixed(3)));
      t += len + 0.3 + r() * 2;
    }
    return out;
  }

  it("cutRange then restoreRange returns the original clips", () => {
    const r = rng(1);
    for (let k = 0; k < 300; k++) {
      const clips = randomClips(r);
      const c = clips[Math.floor(r() * clips.length)];
      if (c.end - c.start < 1.5) continue;
      // strictly inside the clip, away from its edges (no C11 rule applies)
      const a = c.start + 0.3 + r() * (c.end - c.start - 1.2);
      const b = Math.min(c.end - 0.3, a + MIN_REMOVAL_S + r() * 2);
      if (b - a < MIN_REMOVAL_S) continue;
      const cut = cutRange(clips, a, b, D);
      expect(cut).not.toBe(clips);
      expect(restoreRange(cut, a, b, D)).toEqual(clips);
    }
  });

  it("no removal < MIN_REMOVAL_S and no island < MIN_ISLAND_S near what an op touched", () => {
    const r = rng(2);
    for (let run = 0; run < 60; run++) {
      let segs = randomClips(r);
      for (let step = 0; step < 25; step++) {
        const a = r() * (D - 1);
        const b = Math.min(D, a + 0.05 + r() * 3);
        segs = r() < 0.6 ? cutRange(segs, a, b, D) : restoreRange(segs, a, b, D);
        const { removals, islands } = shapes(segs, D);
        // the op's window is clean: the generator itself never makes short ones
        for (const x of removals) expect(x).toBeGreaterThanOrEqual(MIN_REMOVAL_S - 1e-6);
        for (const x of islands) expect(x).toBeGreaterThanOrEqual(MIN_ISLAND_S - 1e-6);
        expect(segs.length).toBeGreaterThan(0);
        expect(new Set(segs.map((s) => s.id)).size).toBe(segs.length);
      }
    }
  });
});

// ── the Text tab's marks ────────────────────────────────────────────

describe("textMarks", () => {
  const words: DocWord[] = [
    { id: "w1", text: "Hello", start: 0.5, end: 1.0 },
    { id: "w2", text: "um", start: 2.0, end: 2.3, filler: true, hidden: true },
    { id: "w3", text: "there.", start: 3.0, end: 3.5 },
    { id: "w4", text: "Cleo", start: 4.0, end: 4.3 },
    { id: "w5", text: "cut.", start: 4.3, end: 4.6 },
    { id: "w6", text: "Again.", start: 6.0, end: 6.5 },
  ];
  const pieces: Piece[] = [
    { start: 0, end: 0.45, kind: "silence" },
    { start: 1.2, end: 2.8, kind: "filler" },
    { start: 3.8, end: 5.8, kind: "voice_cmd" },
  ];

  it("struck words, words inside a take, take and pause chips", () => {
    const m = textMarks(words, pieces, 7);
    expect([...m.removed]).toEqual([0, 1, 0, 2, 2, 0]);
    const take = m.chips.get(3)!;
    expect(take).toHaveLength(1);
    expect(take[0]).toMatchObject({ kind: "take", reason: "voice_cmd", start: 3.8 });
    expect(take[0].len).toBeCloseTo(2);
    // before "um": 1.2–2.0 removed (0.8 s ≥ 0.4) · after it: 2.3–2.8 (0.5 s)
    expect(m.chips.get(1)![0]).toMatchObject({ kind: "pause", reason: "filler", ranges: [{ start: 1.2, end: 2.0 }] });
    expect(m.chips.get(2)![0].len).toBeCloseTo(0.5);
    // 0–0.45 before the first word: 0.45 s ≥ 0.4
    expect(m.chips.get(0)![0].len).toBeCloseTo(0.45);
    // nothing after the last word
    expect(m.chips.has(6)).toBe(false);
  });

  it("a chip restores what it stands for", () => {
    const D = 7;
    const clips = [seg("a", 0.45, 1.2), seg("b", 2.8, 3.8), seg("c", 5.8, 7)];
    const m = textMarks(words, labelRemoved(removedRanges(clips, D), aiCutsOf([], words)), D);
    const chip = m.chips.get(1)![0];
    let out = clips;
    for (const r of chip.ranges) out = restoreRange(out, r.start, r.end, D);
    expect(spans(out)[0]).toEqual([0.45, 2]);
  });
});
