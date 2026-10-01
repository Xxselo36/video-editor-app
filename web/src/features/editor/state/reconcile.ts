/**
 * v1 transcript edits into the edit document (UX8, review blockers 6/13).
 *
 * The v1 editor (and the v2 sentence fallback) saves the transcript as
 * sentences: POST /jobs/{id}/phrases → job.edited_phrases, which the doc
 * never sees. The owner switches between v1 and v2, so when v2 opens a
 * job, sentence edits that are NEWER than the doc are applied to it:
 *
 *   newer   GET /subtitles `phrases_rev` (the v1 save's ms timestamp) is
 *           later than the doc's rev (v2 saves with µs-timestamp revs,
 *           docSave uniqueRev; an analysis doc has rev 0). v2 itself
 *           also writes /phrases after each edit — sentences equal to
 *           the doc's captions, so applying them changes nothing; and a
 *           lost v2 /phrases save is older than the doc, so it's skipped.
 *   how     each saved sentence covers the shown (not hidden) words
 *           whose middle lies in its source range; a changed sentence
 *           text is a text edit of those words (applyTextEdit: unchanged
 *           words keep their timing). Shown words no sentence covers were
 *           deleted in v1: they are hidden from the captions (reversible).
 *
 * The result is saved by the autosave like any edit (not an undo step).
 */
import { applyTextEdit, tokenize } from "./textEdit";
import { captioned, wordTokens, type DocWord, type EditDoc, type IdPool } from "./doc";

export type V1Phrase = { original_start: number; original_end: number; text: string };
export type V1Edits = { phrases: V1Phrase[] | null; rev: number } | null;

const EPS = 0.05;

/** Whether the v1 save is newer than the doc (ms vs µs timestamps). */
export function v1IsNewer(v1: V1Edits, docRev: number): boolean {
  return !!v1?.phrases && v1.rev > 0 && v1.rev * 1000 > docRev;
}

export function reconcileV1(doc: EditDoc, docRev: number, v1: V1Edits, pool?: IdPool): EditDoc {
  if (!v1IsNewer(v1, docRev)) return doc;
  const phrases = [...v1!.phrases!].sort((a, b) => a.original_start - b.original_start);
  const words = doc.words;
  const covered = new Uint8Array(words.length);
  const shown: number[] = [];
  words.forEach((w, i) => {
    if (captioned(w)) shown.push(i);
  });
  // sentence → its shown words (each word in one sentence at most)
  const edits: { idx: number[]; text: string }[] = [];
  let j = 0;
  for (const p of phrases) {
    const lo = p.original_start - EPS;
    const hi = p.original_end + EPS;
    while (j < shown.length && (words[shown[j]].start + words[shown[j]].end) / 2 < lo) j++;
    const idx: number[] = [];
    for (let k = j; k < shown.length; k++) {
      const i = shown[k];
      const mid = (words[i].start + words[i].end) / 2;
      if (mid > hi) break;
      if (!covered[i]) {
        covered[i] = 1;
        idx.push(i);
      }
    }
    if (!idx.length) continue;
    const next = wordTokens(p.text).join(" ");
    if (idx.map((i) => words[i].text).join(" ") === tokenize(next).join(" ")) continue;
    edits.push({ idx, text: next });
  }
  const anyPhrases = phrases.length > 0;
  const taken = pool ?? new Set<string>();
  for (const w of words) taken.add(w.id);
  // later edits first, so earlier indices stay valid
  let out = words.slice();
  for (const e of edits.reverse()) {
    const first = e.idx[0];
    const last = e.idx[e.idx.length - 1];
    const edited = applyTextEdit(e.idx.map((i) => out[i]), e.text, taken);
    for (const w of edited) taken.add(w.id);
    const keepHidden = out.slice(first, last + 1).filter((w, k) => !e.idx.includes(first + k));
    const region = [...keepHidden, ...edited].sort((a, b) => a.start - b.start);
    out = [...out.slice(0, first), ...region, ...out.slice(last + 1)];
  }
  // shown words no saved sentence has: deleted in v1 → hidden
  if (anyPhrases) {
    const gone = new Set(words.filter((w, i) => captioned(w) && !covered[i]).map((w) => w.id));
    if (gone.size) out = out.map((w): DocWord => (gone.has(w.id) ? { ...w, hidden: true } : w));
  }
  if (!edits.length && out.every((w, i) => w === words[i])) return doc;
  return { ...doc, words: out };
}
