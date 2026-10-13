/**
 * How wide the hero headline sets, in em, per language: the source of the
 * --h1-em table in Landing.module.css (.h1:lang(…)). The page itself never
 * imports this file (the table is plain CSS, so the first load carries no
 * estimate and the size is right from the first paint); heroFit.test.ts
 * recomputes the table from site.hero.title in every language and fails,
 * printing the new table, when the two drift apart.
 *
 * The estimate is a rough width per character for a heavy system sans at
 * -0.04em tracking, calibrated on DejaVu Sans Bold. That face is wider
 * than SF Pro and Roboto, so phones get a little room to spare; the CSS
 * adds 4% on top. A sentence that still comes out too wide wraps to a
 * balanced extra line, never past the edge.
 */
import { SENTENCE_BREAK } from "./hero/headline";

const CJK = /[ᄀ-ᇿ　-ヿ㐀-鿿가-힯＀-￯]/; // CJK, kana, Hangul
const DEVANAGARI = /[ऀ-ॣ०-ॿ]/; // letters and digits, not the danda
const MARK = /\p{M}/u; // combining marks (Devanagari vowel signs) take no width of their own
const PUNCT = /[.,;:!'’।]/;
const NARROW = /[fijlrtI]/;
const WIDE = /[mwMWшщжмыюфШЩЖМЫЮФ]/;
const UPPER = /\p{Lu}/u;

/** The width of one line of headline text, in em. */
export function headlineEms(text: string): number {
  let w = 0;
  for (const c of text.trim()) {
    if (MARK.test(c)) continue;
    if (CJK.test(c)) w += 1;
    else if (DEVANAGARI.test(c)) w += 0.78;
    else if (/\s/.test(c)) w += 0.3;
    else if (PUNCT.test(c)) w += 0.36;
    else if (NARROW.test(c)) w += 0.42;
    else if (WIDE.test(c)) w += 0.98;
    else if (UPPER.test(c)) w += 0.74;
    else w += 0.66;
  }
  return w;
}

/**
 * The em the headline is fitted to, to two decimals: its widest sentence
 * (each sets on a line of its own). A one-sentence title (ko, tr) is
 * fitted to half its width plus about a word, so it sets as two balanced
 * lines like the others.
 */
export function titleEms(title: string): number {
  const lines = title.split(SENTENCE_BREAK);
  const em = lines.length === 1 ? headlineEms(lines[0]) / 2 + 0.5 : Math.max(...lines.map(headlineEms));
  return Number(em.toFixed(2));
}

/** The CSS table for Landing.module.css: English on `.h1` (also the
 *  value for any language without a rule), the rest by :lang(). */
export function fitCss(titles: Record<string, string>): string {
  const rows = [`.h1 { --h1-em: ${titleEms(titles.en)}; }`];
  for (const [lang, title] of Object.entries(titles)) {
    if (lang !== "en") rows.push(`.h1:lang(${lang}) { --h1-em: ${titleEms(title)}; }`);
  }
  return rows.join("\n");
}
