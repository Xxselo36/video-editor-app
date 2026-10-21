import { describe, expect, it } from "vitest";
import type { DocWord } from "@/features/editor/state/doc";
import { wordSpan } from "./useCuts";

describe("wordSpan (F12)", () => {
  it("takes the first word from the start that ends at the end, not a later one ending at the same time", () => {
    const words: DocWord[] = [
      { id: "a", text: "one", start: 1, end: 1.4 },
      { id: "b", text: "two", start: 1.4, end: 1.8 },
      // Whisper repeats: a later word with the very same end time
      { id: "c", text: "two", start: 1.6, end: 1.8 },
      { id: "d", text: "three", start: 1.8, end: 2.2 },
    ];
    expect(wordSpan(words, { start: 1, end: 1.8 })).toEqual([0, 1]);
    expect(wordSpan(words, { start: 1.4, end: 1.8 })).toEqual([1, 1]);
    expect(wordSpan(words, { start: 1, end: 9 })).toBeNull();
  });
});
