/**
 * Render payload for the v1 caption burn: word units, not sentences (UX2).
 *
 * The editor shows and edits the transcript as sentences (buildPhrases in
 * app/app/page.tsx). The render used to get one subtitle per sentence and
 * spread its words evenly over the sentence's duration, so the highlighted
 * word drifted, and a sentence crossing a cut was burned in both clips
 * (audit clip: 74 of 86 words highlighted right, 2 groups burned twice).
 * With the analysis' word units: 86 of 86, none twice
 * (backend/tests/captions/test_caption_sync.py).
 *
 * phrasesToUnits maps every sentence back to the units it was built from:
 * - unchanged sentence (its text is the join of its units): those units;
 * - edited sentence: words that are still there keep their own unit; the
 *   changed or added words are split over the unit slots between them,
 *   proportional to character position (an added word with no slot left
 *   joins the previous word's unit); units left without words are dropped;
 * - deleted sentence (empty text): nothing;
 * - sentence without units (none loaded): the sentence itself, as before.
 * Every unit keeps its original_start / original_end (source seconds), which
 * is what the burn places captions by. A unit the analysis mapped into two
 * clips (it spans a cut) is sent once.
 *
 * Pure: the UT1 preview overlay uses the same function, so the preview shows
 * exactly the units the render gets.
 */

export type TimedText = {
  start: number;
  end: number;
  text: string;
  original_start?: number;
  original_end?: number;
};

export type RenderUnit = {
  start: number;
  end: number;
  text: string;
  original_start: number;
  original_end: number;
};

/** Source-time tolerance when matching units to a sentence (seconds). */
const EPS = 1e-3;
/** Above this many word pairs an edit is split proportionally only. */
const MAX_ALIGN_CELLS = 250_000;

const wordsOf = (text: string): string[] =>
  (text || "").trim().split(/\s+/).filter(Boolean);
const normalized = (text: string): string => wordsOf(text).join(" ");
/** Word identity for matching edits: case and outer punctuation ignored. */
const bare = (word: string): string =>
  word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const keyOf = (u: RenderUnit): string =>
  `${u.original_start}|${u.original_end}|${u.text}`;

function renderUnit(u: TimedText, text: string): RenderUnit {
  return {
    start: u.start,
    end: u.end,
    text,
    original_start: u.original_start ?? u.start,
    original_end: u.original_end ?? u.end,
  };
}

/** Longest common subsequence of two word lists, as index pairs. */
function commonWords(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_ALIGN_CELLS) return [];
  const len: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] =
        a[i] === b[j]
          ? len[i + 1][j + 1] + 1
          : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Slot (index into `slots`) for every edited word. */
function slotsForEdit(tokens: string[], slots: RenderUnit[]): number[] {
  const orig: Array<{ word: string; slot: number }> = [];
  slots.forEach((s, slot) => {
    for (const word of wordsOf(s.text)) orig.push({ word, slot });
  });
  const target = new Array<number>(tokens.length).fill(-1);
  const anchors = commonWords(
    orig.map((o) => bare(o.word)),
    tokens.map(bare),
  );
  for (const [i, j] of anchors) target[j] = orig[i].slot;
  // Runs of changed words between two anchors (or the sentence's ends)
  // share the original words between those anchors.
  const bounds: Array<[number, number]> = [[-1, -1], ...anchors, [orig.length, tokens.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [ia, ja] = bounds[k];
    const [ib, jb] = bounds[k + 1];
    if (jb - ja <= 1) continue; // no changed words here
    const run = tokens.slice(ja + 1, jb);
    const gap = orig.slice(ia + 1, ib);
    if (gap.length === 0) {
      // Pure insertion: joins the previous word's unit (or the next one's).
      const slot = ia >= 0 ? orig[ia].slot : orig[Math.min(ib, orig.length - 1)].slot;
      for (let j = ja + 1; j < jb; j++) target[j] = slot;
      continue;
    }
    const starts: number[] = [];
    let pos = 0;
    for (const o of gap) {
      starts.push(pos);
      pos += o.word.length + 1;
    }
    const gapLen = Math.max(1, pos - 1);
    const runLen = Math.max(1, run.join(" ").length);
    let at = 0;
    run.forEach((word, r) => {
      const x = ((at + word.length / 2) / runLen) * gapLen;
      let g = gap.length - 1;
      while (g > 0 && starts[g] > x) g--;
      target[ja + 1 + r] = gap[g].slot;
      at += word.length + 1;
    });
  }
  return target;
}

export function phrasesToUnits(
  phrases: TimedText[],
  units: TimedText[],
): RenderUnit[] {
  const pool = units.filter((u) => normalized(u.text) !== "");
  const out: RenderUnit[] = [];
  const sent = new Set<string>();
  const send = (u: RenderUnit) => {
    const key = keyOf(u);
    if (sent.has(key)) return;
    sent.add(key);
    out.push(u);
  };

  for (const p of phrases) {
    const text = normalized(p.text);
    if (!text) continue; // deleted sentence
    const from = (p.original_start ?? p.start) - EPS;
    const to = (p.original_end ?? p.end) + EPS;
    const members = pool.filter(
      (u) => (u.original_start ?? u.start) >= from && (u.original_end ?? u.end) <= to,
    );
    if (members.length === 0) {
      send(renderUnit(p, text)); // no units: the sentence, as before
      continue;
    }
    const slots: RenderUnit[] = [];
    const inPhrase = new Set<string>();
    for (const u of members) {
      const r = renderUnit(u, normalized(u.text));
      if (inPhrase.has(keyOf(r))) continue;
      inPhrase.add(keyOf(r));
      slots.push(r);
    }
    const unchanged =
      text === normalized(members.map((u) => u.text).join(" ")) ||
      text === slots.map((s) => s.text).join(" ");
    if (unchanged) {
      slots.forEach(send);
      continue;
    }
    const tokens = wordsOf(text);
    const target = slotsForEdit(tokens, slots);
    const bySlot = new Map<number, string[]>();
    tokens.forEach((word, j) => {
      const slot = target[j];
      const list = bySlot.get(slot);
      if (list) list.push(word);
      else bySlot.set(slot, [word]);
    });
    slots.forEach((s, slot) => {
      const list = bySlot.get(slot);
      if (list) send({ ...s, text: list.join(" ") });
    });
  }
  return out;
}
