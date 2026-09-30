// buildPhrases (features/editor/legacy/buildPhrases, moved from
// app/app/page.tsx in UX4).
import { describe, expect, it } from "vitest";
import { buildPhrases, type Subtitle } from "./buildPhrases";

const sub = (start: number, end: number, text: string, extra: Partial<Subtitle> = {}): Subtitle => ({
  start,
  end,
  text,
  ...extra,
});

describe("buildPhrases", () => {
  it("joins fragments up to the end of a sentence", () => {
    const p = buildPhrases([sub(0, 0.4, "Hello"), sub(0.4, 1, "world."), sub(1.2, 1.6, "Next"), sub(1.6, 2, "one")]);
    expect(p.map((x) => x.text)).toEqual(["Hello world.", "Next one"]);
    expect(p[0]).toMatchObject({ start: 0, end: 1 });
    expect(p[1]).toMatchObject({ start: 1.2, end: 2 });
  });

  it("ends a sentence at ?, ! and … and closing quotes", () => {
    const p = buildPhrases([
      sub(0, 1, "Really?"),
      sub(1, 2, "Yes!"),
      sub(2, 3, "Well…"),
      sub(3, 4, 'He said "stop."'),
      sub(4, 5, "Done"),
    ]);
    expect(p.map((x) => x.text)).toEqual(["Really?", "Yes!", "Well…", 'He said "stop."', "Done"]);
  });

  it("splits on a pause longer than 1.5 s", () => {
    expect(buildPhrases([sub(0, 1, "a"), sub(2.5, 3, "b")]).length).toBe(1);
    expect(buildPhrases([sub(0, 1, "a"), sub(2.6, 3, "b")]).length).toBe(2);
  });

  it("caps a phrase at 10 words (counting words inside fragments)", () => {
    const words = Array.from({ length: 11 }, (_, i) => sub(i * 0.3, i * 0.3 + 0.25, `w${i}`));
    expect(buildPhrases(words).map((x) => x.text.split(" ").length)).toEqual([10, 1]);
    const chunks = [sub(0, 1, "one two three four"), sub(1, 2, "five six seven"), sub(2, 3, "eight nine ten eleven")];
    expect(buildPhrases(chunks).map((x) => x.text)).toEqual([
      "one two three four five six seven",
      "eight nine ten eleven",
    ]);
  });

  it("keeps source times and averages the confidence", () => {
    const [p] = buildPhrases([
      sub(0, 1, "a", { original_start: 10, original_end: 11, confidence: 0.5 }),
      sub(1, 2, "b.", { original_start: 11.5, original_end: 12.5 }),
    ]);
    expect(p).toEqual({ start: 0, end: 2, original_start: 10, original_end: 12.5, confidence: 0.75, text: "a b." });
  });

  it("falls back to output times without source times", () => {
    const [p] = buildPhrases([sub(3, 4, "x.")]);
    expect(p).toMatchObject({ original_start: 3, original_end: 4, confidence: 1 });
  });

  it("skips empty fragments and trims text", () => {
    expect(buildPhrases([sub(0, 1, "  hi "), sub(1, 1.1, "   "), sub(1.1, 2, "there. ")])).toEqual([
      { start: 0, end: 2, original_start: 0, original_end: 2, confidence: 1, text: "hi there." },
    ]);
    expect(buildPhrases([])).toEqual([]);
  });
});
