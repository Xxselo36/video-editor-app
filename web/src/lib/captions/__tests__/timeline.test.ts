import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapToOutput, outToSrc, outputDuration, srcToOut, type Clip, type SourceWord } from "../timeline";

type Vector = {
  name: string;
  clips: Clip[];
  words: SourceWord[];
  offsetMs?: number;
  expected: { words: [string, number, number][]; breaks: number[]; duration: number };
};

const VECTORS: Vector[] = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../../../../testdata/timeline_vectors.json", import.meta.url)), "utf8"),
).vectors;

describe("mapToOutput (testdata/timeline_vectors.json)", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const out = mapToOutput(v.clips, v.words, { offsetMs: v.offsetMs });
    expect(out.words.map((w) => w.id)).toEqual(v.expected.words.map((w) => w[0]));
    out.words.forEach((w, i) => {
      expect(w.start).toBeCloseTo(v.expected.words[i][1], 6);
      expect(w.end).toBeCloseTo(v.expected.words[i][2], 6);
    });
    expect(out.breaks.length).toBe(v.expected.breaks.length);
    out.breaks.forEach((b, i) => expect(b).toBeCloseTo(v.expected.breaks[i], 6));
    expect(out.duration).toBeCloseTo(v.expected.duration, 6);
  });
});

describe("mapToOutput invariants", () => {
  // deterministic pseudo-random edit (no RNG in the engine; a fixed LCG here)
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  it("is monotonic and keeps every word inside its clip, for many random edits", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = lcg(seed);
      const words: SourceWord[] = [];
      let t = 0;
      for (let i = 0; i < 120; i++) {
        t += 0.05 + rnd() * 0.3;
        const d = 0.08 + rnd() * 0.4;
        words.push({ id: `w${i}`, text: `w${i}`, start: t, end: t + d });
        t += d;
      }
      const clips: Clip[] = [];
      let c = 0;
      while (c < t) {
        const len = 0.5 + rnd() * 4;
        clips.push({ start: c, end: Math.min(t, c + len), speed: rnd() < 0.2 ? 1.5 : 1 });
        c += len + (rnd() < 0.6 ? rnd() * 1.2 : 0);
      }
      const out = mapToOutput(clips, words, { offsetMs: Math.round((rnd() - 0.5) * 600) });
      for (let i = 0; i < out.words.length; i++) {
        const w = out.words[i];
        expect(w.end).toBeGreaterThanOrEqual(w.start);
        if (i) expect(w.start).toBeGreaterThanOrEqual(out.words[i - 1].start - 1e-9);
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.end).toBeLessThanOrEqual(out.duration + 1e-9);
      }
      // a word never crosses a break
      for (const w of out.words) {
        for (const b of out.breaks) expect(w.start < b - 1e-9 && w.end > b + 1e-9).toBe(false);
      }
      // each word at most once
      expect(new Set(out.words.map((w) => w.id)).size).toBe(out.words.length);
    }
  });

  it("srcToOut / outToSrc round-trip inside clips", () => {
    const clips: Clip[] = [
      { start: 0, end: 2 },
      { start: 3, end: 5, speed: 2 },
    ];
    expect(outputDuration(clips)).toBeCloseTo(3);
    expect(srcToOut(clips, 2.5)).toBeNull();
    expect(srcToOut(clips, 4)).toBeCloseTo(2.5);
    expect(outToSrc(clips, 2.5)).toBeCloseTo(4);
    for (const t of [0, 0.7, 1.99, 3, 3.3, 4.9]) {
      const o = srcToOut(clips, t);
      expect(o).not.toBeNull();
      expect(outToSrc(clips, o!)).toBeCloseTo(t, 9);
    }
  });
});
