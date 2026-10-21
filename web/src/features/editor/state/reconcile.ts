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
 *           also writes /phrases after each edit, and its copy is
 *           usually saved a moment AFTER the doc's PATCH (so it looks
 *           newer): sentences equal to the doc's own captions are that
 *           copy and change nothing (returned as is — before, touching
 *           sentences re-applied it and re-timed / re-id'd words on every
 *           reopen). A lost v2 /phrases save is older than the doc: skipped.
 *   how     each shown (not hidden) word belongs to the saved sentence
 *           whose source range holds its middle; only a word no sentence
 *           holds goes to a sentence within EPS of it (never one taken
 *           from the next sentence). A changed sentence text is a text
 *           edit of its words (applyTextEdit: unchanged words keep their
 *           timing). Shown words no sentence covers were deleted in v1:
 *           they are hidden from the captions (reversible).
 *
 * The result is saved by the autosave like any edit (not an undo step).
 */
import { applyTextEdit, tokenize } from "./textEdit";
import { captioned, captionSource, wordTokens, type DocWord, type EditDoc, type IdPool } from "./doc";

export type V1Phrase = { original_start: number; original_end: number; text: string };
export type V1Edits = { phrases: V1Phrase[] | null; rev: number } | null;

const EPS = 0.05;

/** Whether the v1 save is newer than the doc (ms vs µs timestamps). */
export function v1IsNewer(v1: V1Edits, docRev: number): boolean {
  return !!v1?.phrases && v1.rev > 0 && v1.rev * 1000 > docRev;
}

/** The saved sentences are the doc's own captions (v2's /phrases copy):
 *  same texts at the same starts (ends aren't compared: older copies
 *  ended a sentence at its last word, not its latest one). */
function isOwnCopy(words: readonly DocWord[], phrases: readonly V1Phrase[]): boolean {
  const own = captionSource(words).phrases;
  if (own.length !== phrases.length) return false;
  return own.every(
    (p, i) => p.text === phrases[i].text && Math.abs(p.original_start - phrases[i].original_start) < 1e-3,
  );
}

export function reconcileV1(doc: EditDoc, docRev: number, v1: V1Edits, pool?: IdPool): EditDoc {
  if (!v1IsNewer(v1, docRev)) return doc;
  const phrases = [...v1!.phrases!].sort((a, b) => a.original_start - b.original_start);
  const words = doc.words;
  if (isOwnCopy(words, phrases)) return doc;
  const covered = new Uint8Array(words.length);
  const shown: number[] = [];
  words.forEach((w, i) => {
    if (captioned(w)) shown.push(i);
  });
  // shown word → its sentence: the one whose range holds its middle;
  // a word in none of them → the nearest within EPS (each word in one
  // sentence at most)
  const owner = new Int32Array(words.length).fill(-1);
  const mid = (i: number) => (words[i].start + words[i].end) / 2;
  const starts = phrases.map((p) => p.original_start);
  for (const i of shown) {
    const m = mid(i);
    // the last sentence starting at or before m + EPS, then a few before it
    let lo = 0;
    let hi = starts.length - 1;
    let top = -1;
    while (lo <= hi) {
      const c = (lo + hi) >> 1;
      if (starts[c] - EPS <= m) {
        top = c;
        lo = c + 1;
      } else hi = c - 1;
    }
    let best = -1;
    let bestD = EPS + 1e-9;
    for (let k = top; k >= 0 && k >= top - 4; k--) {
      const p = phrases[k];
      if (m >= p.original_start && m <= p.original_end) {
        best = k;
        bestD = -1;
        continue; // an earlier one holding it too wins
      }
      if (bestD < 0) continue;
      const d = m < p.original_start ? p.original_start - m : m - p.original_end;
      if (d < bestD) {
        best = k;
        bestD = d;
      }
    }
    if (best >= 0) {
      owner[i] = best;
      covered[i] = 1;
    }
  }
  const edits: { idx: number[]; text: string }[] = [];
  phrases.forEach((p, k) => {
    const idx = shown.filter((i) => owner[i] === k);
    if (!idx.length) return;
    const next = wordTokens(p.text).join(" ");
    if (idx.map((i) => words[i].text).join(" ") === tokenize(next).join(" ")) return;
    edits.push({ idx, text: next });
  });
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
