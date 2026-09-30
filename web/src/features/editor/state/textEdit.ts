/**
 * Text edits on transcript words (UT3; used by UX8's editWord): the web
 * twin of backend/doc.py apply_text_edit. Both run
 * testdata/text_edit_vectors.json — change one, change the other and the
 * vectors.
 *
 * A span of words gets a new text; a token diff against the words' texts
 * decides what happens to the timing (captions.md §4.2):
 * - an unchanged token keeps its word (id, times, flags);
 * - a changed run of as many tokens as words: each word keeps its id,
 *   times and flags and takes the new text;
 * - otherwise the run's time [first start, last end] is shared by the new
 *   tokens in proportion to their characters; they take the run's ids in
 *   order (extra tokens get "<last id>.<k>"), hidden only if every old
 *   word was, breakBefore from the first old word;
 * - a deleted run merges its time into the word before it (its end
 *   grows), else the word after it (its start moves back);
 * - inserted tokens split the time of the word before them (else the
 *   word after them) in proportion to characters; the new ones get ids
 *   "<that word's id>.<k>".
 * Times are SOURCE seconds; computed boundaries are rounded to ms.
 */

export type EditWord = {
  id: string;
  text: string;
  start: number;
  end: number;
  conf?: number;
  filler?: boolean;
  hidden?: boolean;
  breakBefore?: boolean;
};

// JavaScript's \s — the backend tokenizes with exactly this set.
const TOKEN = /[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Python's math.floor(x * 1000 + 0.5) / 1000. */
export function roundMs(x: number): number {
  return Math.floor(x * 1000 + 0.5) / 1000;
}

const chars = (s: string) => [...s].length;

/** LCS index pairs: common prefix and suffix, then a DP over the middle (none above `cap` cells). */
function lcsPairs(a: readonly string[], b: readonly string[], cap = 250_000): [number, number][] {
  const n = a.length;
  const m = b.length;
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < p; i++) pairs.push([i, i]);
  const x = n - s - p;
  const y = m - s - p;
  if (x > 0 && y > 0 && x * y <= cap) {
    const L: Int32Array[] = [];
    for (let i = 0; i <= x; i++) L.push(new Int32Array(y + 1));
    for (let i = x - 1; i >= 0; i--) {
      for (let j = y - 1; j >= 0; j--) {
        L[i][j] = a[p + i] === b[p + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x && j < y) {
      if (a[p + i] === b[p + j]) {
        pairs.push([p + i, p + j]);
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < s; k++) pairs.push([n - s + k, m - s + k]);
  return pairs;
}

function newId(base: string, taken: Set<string>): string {
  let k = 1;
  while (taken.has(`${base}.${k}`)) k++;
  const id = `${base}.${k}`;
  taken.add(id);
  return id;
}

/** [t0, t1] shared by the tokens in proportion to their characters. */
function spread(t0: number, t1: number, tokens: readonly string[]): [number, number][] {
  const weights = tokens.map((t) => Math.max(1, chars(t)));
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds = [t0];
  let acc = 0;
  for (const w of weights.slice(0, -1)) {
    acc += w;
    bounds.push(roundMs(t0 + ((t1 - t0) * acc) / total));
  }
  bounds.push(t1);
  return tokens.map((_, k) => [bounds[k], bounds[k + 1]]);
}

/** The words of a span after its text became `newText` (rules above). */
export function applyTextEdit(
  words: readonly EditWord[],
  newText: string,
  takenIds: Iterable<string> = [],
): EditWord[] {
  if (!words.length) return [];
  const old = words.map((w) => w.text);
  const next = tokenize(newText);
  const taken = new Set<string>([...takenIds, ...words.map((w) => w.id)]);
  const out: EditWord[] = [];
  let pendingStart: number | null = null;
  let pendingBreak = false;
  let pendingInsert: string[] = [];

  const emit = (w0: EditWord) => {
    const w: EditWord = { ...w0 };
    if (pendingStart !== null) {
      w.start = Math.min(w.start, pendingStart);
      pendingStart = null;
    }
    if (pendingBreak) {
      w.breakBefore = true;
      pendingBreak = false;
    }
    if (pendingInsert.length) {
      const toks = [...pendingInsert, w.text];
      const spans = spread(w.start, w.end, toks);
      pendingInsert.forEach((tok, k) => {
        const nw: EditWord = { id: newId(w.id, taken), text: tok, start: spans[k][0], end: spans[k][1] };
        if (w.hidden) nw.hidden = true;
        if (k === 0 && w.breakBefore) nw.breakBefore = true;
        out.push(nw);
      });
      delete w.breakBefore;
      [w.start, w.end] = spans[spans.length - 1];
      pendingInsert = [];
    }
    out.push(w);
  };

  const block = (o: readonly EditWord[], n: readonly string[]) => {
    if (!o.length && !n.length) return;
    if (o.length && o.length === n.length) {
      o.forEach((w, k) => emit({ ...w, text: n[k] }));
      return;
    }
    if (o.length && n.length) {
      const t0 = o[0].start;
      const t1 = Math.max(t0, Math.max(...o.map((w) => w.end)));
      const spans = spread(t0, t1, n);
      const hidden = o.every((w) => w.hidden);
      n.forEach((tok, k) => {
        const id = k < o.length ? o[k].id : newId(o[o.length - 1].id, taken);
        const nw: EditWord = { id, text: tok, start: spans[k][0], end: spans[k][1] };
        if (hidden) nw.hidden = true;
        if (k === 0 && o[0].breakBefore) nw.breakBefore = true;
        emit(nw);
      });
      return;
    }
    if (o.length) {
      // deleted
      const end = Math.max(...o.map((w) => w.end));
      if (out.length) {
        const prev = out[out.length - 1];
        out[out.length - 1] = { ...prev, end: Math.max(prev.end, end) };
      } else {
        pendingStart = o[0].start;
        pendingBreak = pendingBreak || !!o[0].breakBefore;
      }
      return;
    }
    // inserted
    if (out.length) {
      const prev = out.pop()!;
      const spans = spread(prev.start, prev.end, [prev.text, ...n]);
      out.push({ ...prev, start: spans[0][0], end: spans[0][1] });
      n.forEach((tok, k) => {
        const nw: EditWord = { id: newId(prev.id, taken), text: tok, start: spans[k + 1][0], end: spans[k + 1][1] };
        if (prev.hidden) nw.hidden = true;
        out.push(nw);
      });
    } else {
      pendingInsert = [...pendingInsert, ...n];
    }
  };

  let i = 0;
  let j = 0;
  for (const [pi, pj] of lcsPairs(old, next)) {
    block(words.slice(i, pi), next.slice(j, pj));
    emit(words[pi]);
    i = pi + 1;
    j = pj + 1;
  }
  block(words.slice(i), next.slice(j));
  return out;
}
