/**
 * The landing's sample caption as timed words, as if spoken: each word
 * lasts 0.16 s plus 0.045 s per character, with 0.06 s between words.
 * The same timing everywhere on the page (hero, player, clips, final), so
 * the engine pages every frame the same way.
 *
 * "[word]" marks the highlighted word in the CSS posters; it is removed
 * here. Japanese and Chinese have no spaces: they are split into words
 * with Intl.Segmenter (the engine joins them back without spaces).
 */
import { segmentsWithoutSpaces } from "@/lib/captions/scripts";
import type { CaptionWord } from "@/lib/captions/types";

export const WORD_GAP = 0.06;
export const FIRST_WORD_AT = 0.15;

export function wordDuration(text: string): number {
  return 0.16 + 0.045 * [...text].length;
}

export function splitWords(text: string, lang: string): string[] {
  const clean = text.replace(/[[\]]/g, "").trim();
  if (!segmentsWithoutSpaces(lang) || typeof Intl === "undefined" || !("Segmenter" in Intl)) {
    return clean.split(/\s+/).filter(Boolean);
  }
  const out: string[] = [];
  for (const s of new Intl.Segmenter(lang, { granularity: "word" }).segment(clean)) {
    if (!s.segment.trim()) continue;
    // punctuation sticks to the word before it
    if (!s.isWordLike && out.length) out[out.length - 1] += s.segment;
    else out.push(s.segment);
  }
  return out;
}

export function captionWords(text: string, lang: string): CaptionWord[] {
  let t = FIRST_WORD_AT;
  return splitWords(text, lang).map((w, i) => {
    const start = t;
    const end = start + wordDuration(w);
    t = end + WORD_GAP;
    return { id: `w${i}`, text: w, start, end };
  });
}

/** When the last word ends. */
export function spokenUntil(words: readonly CaptionWord[]): number {
  return words.length ? words[words.length - 1].end : 0;
}
