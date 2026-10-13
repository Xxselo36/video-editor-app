/**
 * The landing's sample caption as timed words, as if spoken: each word
 * lasts 0.16 s plus 0.045 s per character, with 0.06 s between words.
 * The same timing everywhere on the page (hero, player, clips, final), so
 * the engine pages every frame the same way.
 *
 * "[word]" marks the highlighted word in the CSS posters; it is removed
 * here. "|" splits a line into phrases, as the bonus clips' captions do
 * ("My best [tip] | for more [views] | hook them [fast]"): each phrase is
 * its own caption page (its first word breaks the page), said after a
 * short breath, like real subtitles. A line without "|" is one phrase,
 * timed exactly as before phrases existed. (A phrased line's still lives
 * with the tiles, clipCaptions.ts stillAt: this file is in the hero's
 * first load.) Japanese and Chinese have no
 * spaces: they are split into words with Intl.Segmenter (the engine joins
 * them back without spaces), and a particle or counter is timed with the
 * word before it, as spoken.
 */
import { normLang, segmentsWithoutSpaces } from "@/lib/captions/scripts";
import type { CaptionWord } from "@/lib/captions/types";

export const WORD_GAP = 0.06;
export const FIRST_WORD_AT = 0.15;
/** The breath before a new phrase (s, after the last word of the one
 *  before). Shorter than the engine's page hold (0.35 s), so the page
 *  before stays up until the next one pops in and the caption never goes
 *  blank; and shorter than a pause that breaks a page by itself (0.6 s in
 *  Power), so the "|" alone decides where pages break. */
export const PHRASE_GAP = 0.3;

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

/** A line's phrases, in order ("|" between them), each with its [mark]. */
export function splitPhrases(text: string): string[] {
  return text
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function captionWords(text: string, lang: string): CaptionWord[] {
  const out: CaptionWord[] = [];
  let t = FIRST_WORD_AT;
  splitPhrases(text).forEach((phrase, k) => {
    splitWords(phrase, lang).forEach((w, i) => {
      const opens = k > 0 && i === 0;
      // a new phrase: a breath, then its own page
      if (opens) t += PHRASE_GAP - WORD_GAP;
      const start = t;
      const end = start + wordDuration(w);
      t = end + WORD_GAP;
      const id = `w${out.length}`;
      out.push(opens ? { id, text: w, start, end, breakBefore: true } : { id, text: w, start, end });
    });
  });
  return out;
}

/** When the last word ends. */
export function spokenUntil(words: readonly CaptionWord[]): number {
  return words.length ? words[words.length - 1].end : 0;
}

/**
 * A still of word `i` spoken (s): its entrance done and its karaoke fill
 * (nearly) full, before the next word starts. For the last word, the
 * settled caption.
 */
export function spokenAt(words: readonly CaptionWord[], i: number): number {
  const w = words[i];
  const at = Math.max(w.start + 0.3, w.end - 0.02);
  const next = words[i + 1];
  return next ? Math.min(at, next.start - 0.02) : at;
}
