/**
 * The hero headline's parts (hero/HeroTitle.tsx): one line per sentence,
 * the loop's two acts, and in it the word that does the cutting
 * (site.hero.cutWord), which the headline inks in the brand gradient.
 *
 * The parts join back to the title exactly, so the heading reads, copies
 * and selects as the one sentence it is. Pure and tiny: it runs in the
 * first load (heroFit.ts, the size estimate, never does).
 */

/** A sentence ends after ".", "!", "?", "。" or "।"; the space after it
 *  stays in its line, so the heading still reads as one. */
export const SENTENCE_BREAK = /(?<=[.!?。।]\s*)(?=\S)/;

/** One line of the headline: `cut` is the highlighted word, empty on a
 *  line without it. */
export type HeadlineLine = { before: string; cut: string; after: string };

/**
 * The title as lines, with the cut word marked in the line that holds
 * it. No highlight when the word is missing, empty, not in the title, or
 * would straddle two lines (a translation that changed only one of the
 * two keys).
 */
export function headlineLines(title: string, cutWord: string): HeadlineLine[] {
  const at = cutWord ? title.indexOf(cutWord) : -1;
  let start = 0;
  return title.split(SENTENCE_BREAK).map((line) => {
    const from = at - start;
    start += line.length;
    if (at < 0 || from < 0 || from + cutWord.length > line.length) return { before: line, cut: "", after: "" };
    return { before: line.slice(0, from), cut: cutWord, after: line.slice(from + cutWord.length) };
  });
}
