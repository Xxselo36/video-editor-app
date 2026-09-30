import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyTextEdit, roundMs, tokenize, type EditWord } from "./textEdit";

type Vector = { name: string; words: EditWord[]; text: string; taken?: string[]; expected: EditWord[] };

const VECTORS: Vector[] = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../../../../testdata/text_edit_vectors.json", import.meta.url)), "utf8"),
).vectors;

describe("applyTextEdit (testdata/text_edit_vectors.json, shared with backend/doc.py)", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const out = applyTextEdit(v.words, v.text, v.taken ?? []);
    const untimed = (w: EditWord) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== "start" && k !== "end"));
    expect(out.map(untimed)).toEqual(v.expected.map(untimed));
    out.forEach((w, i) => {
      expect(w.start).toBeCloseTo(v.expected[i].start, 6);
      expect(w.end).toBeCloseTo(v.expected[i].end, 6);
    });
  });

  it("never touches its input", () => {
    const words: EditWord[] = [
      { id: "a", text: "one", start: 0, end: 0.5 },
      { id: "b", text: "two", start: 0.5, end: 1 },
    ];
    const copy = JSON.parse(JSON.stringify(words));
    applyTextEdit(words, "one and a half two");
    expect(words).toEqual(copy);
  });

  it("keeps times inside the span and ordered", () => {
    const words: EditWord[] = ["so", "we", "are", "gonna", "win", "this"].map((t, i) => ({
      id: `w${i}`,
      text: t,
      start: i * 0.3,
      end: i * 0.3 + 0.25,
    }));
    for (const text of ["so we will win", "we are going to win this one", "", "gonna gonna gonna", "this so"]) {
      const out = applyTextEdit(words, text);
      out.forEach((w, i) => {
        expect(w.end).toBeGreaterThanOrEqual(w.start);
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.end).toBeLessThanOrEqual(1.75);
        if (i) expect(w.start).toBeGreaterThanOrEqual(out[i - 1].start);
      });
      expect(new Set(out.map((w) => w.id)).size).toBe(out.length);
      expect(out.map((w) => w.text)).toEqual(tokenize(text));
    }
  });

  it("rounds like the backend", () => {
    expect(roundMs(1.0005)).toBe(1.001);
    expect(roundMs(2.4444)).toBe(2.444);
    expect(tokenize(" a\u00a0b\tc ")).toEqual(["a", "b", "c"]);
  });
});
