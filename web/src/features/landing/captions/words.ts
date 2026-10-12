/**
 * The landing's sample caption as timed words, as if spoken: each word
 * lasts 0.16 s plus 0.045 s per character, with 0.06 s between words.
 * The same timing everywhere on the page (hero, player, clips, final), so
 * the engine pages every frame the same way.
 *
 * "[word]" marks the highlighted word in the CSS posters; it is removed
 * here. Japanese and Chinese have no spaces: they are split into words
 * with Intl.Segmenter (the engine joins them back without spaces), and a
 * particle or counter is timed with the word before it, as spoken.
 */
import { normLang, segmentsWithoutSpaces } from "@/lib/captions/scripts";
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
    const prev = out[out.length - 1];
    // punctuation, particles and counters stick to the word before it
    if (prev !== undefined && (!s.isWordLike || joinsPrevious(s.segment, prev, lang))) out[out.length - 1] += s.segment;
    else out.push(s.segment);
  }
  return out;
}

/**
 * A fragment the segmenter cuts off: a counter after a number (3|つ, 3|个),
 * a Japanese particle or verb ending (フック|を, 3つ|の, 始め|よう: one or
 * two kana) or a Chinese particle (开头|的).
 */
function joinsPrevious(segment: string, prev: string, lang: string): boolean {
  if (/\p{Nd}$/u.test(prev)) return true;
  return normLang(lang) === "ja" ? /^[ぁ-ゖ]{1,2}$/.test(segment) : /^[的了吗呢吧啊]$/.test(segment);
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
