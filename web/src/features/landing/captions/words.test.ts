import { describe, expect, it } from "vitest";
import { captionWords, splitWords, spokenUntil, wordDuration } from "./words";

describe("landing caption words", () => {
  it("drops the highlight brackets and splits on spaces", () => {
    expect(splitWords("3 tips for better [hooks]", "en")).toEqual(["3", "tips", "for", "better", "hooks"]);
  });

  it("segments Japanese into several words", () => {
    expect(splitWords("フックを良くする3つのコツ", "ja").length).toBeGreaterThan(1);
  });

  it("times words back to back with a gap", () => {
    const w = captionWords("a bb", "en");
    expect(w[0].end - w[0].start).toBeCloseTo(wordDuration("a"));
    expect(w[1].start - w[0].end).toBeCloseTo(0.06);
    expect(spokenUntil(w)).toBe(w[1].end);
  });
});
