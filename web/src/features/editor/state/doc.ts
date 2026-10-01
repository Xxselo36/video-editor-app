/**
 * The edit document (UT3, backend/doc.py) on the web side, and its pure
 * ops (UX8, PLAN_TECH UX8): editWord, hideWords, setBreak, setStyle,
 * setFormat, find & replace. Ops never change a doc or a word in place:
 * they return a new doc (the same object when nothing changed), so the
 * history keeps snapshots with structural sharing and the autosave
 * diffs words by reference.
 *
 * Times are SOURCE seconds. Text edits run through applyTextEdit
 * (textEdit.ts, the twin of the backend's apply_text_edit): unchanged
 * tokens keep their timing, typed extra words split a word's time,
 * a deleted word's time goes to the word before it (else after it).
 */
import { applyTextEdit, tokenize, type EditWord } from "./textEdit";

export type DocWord = EditWord;
export type DocStyle = { presetId: string; overrides: Record<string, unknown> };
export type DocFormat = { aspect: "9:16" | "16:9" | "original" };
export type EditDoc = {
  v: number;
  language: string | null;
  words: DocWord[];
  clips: unknown;
  style: DocStyle;
  format: DocFormat;
  rev: number;
};

/** Ids of every word ever seen by this editor: new words never reuse an
 *  id the server may still hold (backend merge_words places new ids). */
export type IdPool = Set<string>;

const withWords = (doc: EditDoc, words: DocWord[]): EditDoc => ({ ...doc, words });

function indexOfId(words: readonly DocWord[], id: string): number {
  for (let i = 0; i < words.length; i++) if (words[i].id === id) return i;
  return -1;
}

/**
 * Words first..last (inclusive) get the text `text`. The span is edited
 * together with one unchanged neighbour on each side, so a word deleted
 * by the edit hands its time to the word before it (else the one after
 * it) instead of losing it (captions.md §4.2).
 */
// ── what the server accepts (backend/doc.py validate_word) ─────────

/** backend/doc.py MAX_WORD_TEXT (code points, as Python's len). */
export const MAX_WORD_TEXT = 200;

/**
 * Characters Python's str.strip() / str.isspace() treat as whitespace
 * but JavaScript's \s doesn't: a token made of them is "empty" to the
 * server (400 bad_word). They become spaces here.
 */
const PY_ONLY_SPACE = /[\u001c-\u001f\u0085]/g;

/**
 * Tokens of typed text the server accepts as words: Python-only
 * whitespace splits like a space, and a token over MAX_WORD_TEXT code
 * points (a long CJK run without spaces) is cut into pieces of that size.
 */
export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const tok of tokenize(text.replace(PY_ONLY_SPACE, " "))) {
    const cps = [...tok];
    for (let i = 0; i < cps.length; i += MAX_WORD_TEXT) out.push(cps.slice(i, i + MAX_WORD_TEXT).join(""));
  }
  return out;
}

/** A word's text the server accepts as it is. */
export const validWordText = (text: string) => {
  const t = wordTokens(text);
  return t.length === 1 && t[0] === text;
};

export function editRange(doc: EditDoc, first: number, last: number, text: string, pool?: IdPool): EditDoc {
  const words = doc.words;
  if (first < 0 || last >= words.length || first > last) return doc;
  const old = words.slice(first, last + 1);
  const toks = wordTokens(text);
  if (old.map((w) => w.text).join(" ") === toks.join(" ") && old.every((w) => validWordText(w.text))) return doc;
  const a = first > 0 ? first - 1 : first;
  const b = last < words.length - 1 ? last + 1 : last;
  const before = a < first ? [words[a].text] : [];
  const after = b > last ? [words[b].text] : [];
  const next = [...before, ...toks, ...after].join(" ");
  const taken = pool ?? new Set(words.map((w) => w.id));
  for (const w of words) taken.add(w.id);
  const edited = applyTextEdit(words.slice(a, b + 1), next, taken);
  for (const w of edited) taken.add(w.id);
  return withWords(doc, [...words.slice(0, a), ...edited, ...words.slice(b + 1)]);
}

/** One word's text (empty: the word goes, its time to a neighbour). */
export function editWord(doc: EditDoc, id: string, text: string, pool?: IdPool): EditDoc {
  const i = indexOfId(doc.words, id);
  if (i < 0) return doc;
  return editRange(doc, i, i, text, pool);
}

/** Hide words from the captions (they stay in the transcript), or show them. */
export function hideWords(doc: EditDoc, ids: Iterable<string>, hidden: boolean): EditDoc {
  const set = new Set(ids);
  let changed = false;
  const words = doc.words.map((w) => {
    if (!set.has(w.id) || !!w.hidden === hidden) return w;
    changed = true;
    const nw = { ...w };
    if (hidden) nw.hidden = true;
    else delete nw.hidden;
    return nw;
  });
  return changed ? withWords(doc, words) : doc;
}

/** A forced caption break before a word (a new caption page starts there). */
export function setBreak(doc: EditDoc, id: string, on: boolean): EditDoc {
  const i = indexOfId(doc.words, id);
  if (i < 0 || !!doc.words[i].breakBefore === on) return doc;
  const nw = { ...doc.words[i] };
  if (on) nw.breakBefore = true;
  else delete nw.breakBefore;
  const words = doc.words.slice();
  words[i] = nw;
  return withWords(doc, words);
}

export function setStyle(doc: EditDoc, style: DocStyle): EditDoc {
  return JSON.stringify(style) === JSON.stringify(doc.style) ? doc : { ...doc, style };
}

export function setFormat(doc: EditDoc, format: DocFormat): EditDoc {
  return format.aspect === doc.format?.aspect ? doc : { ...doc, format };
}

// ── rows (the Text tab) and caption phrases (preview / export) ───────

const SENTENCE_END = /[.!?…。！？]["'»”)\]]*$/;

export type Row = { first: number; last: number };

/**
 * Transcript rows: sentences. A new row starts after a sentence end, at
 * a pause over `maxGap` seconds, at a forced break, or after `maxWords`.
 */
export function rowsOf(words: readonly DocWord[], maxWords = 24, maxGap = 1.5): Row[] {
  const rows: Row[] = [];
  let first = 0;
  for (let i = 1; i <= words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (
      i === words.length ||
      w.breakBefore ||
      SENTENCE_END.test(prev.text) ||
      w.start - prev.end > maxGap ||
      i - first >= maxWords
    ) {
      rows.push({ first, last: i - 1 });
      first = i;
    }
  }
  return rows;
}

/** Shown in the captions: not hidden (the analysis hides fillers; a
 *  filler the user shows again is captioned). */
export const captioned = (w: DocWord) => !w.hidden;

export type CaptionPhrase = {
  start: number;
  end: number;
  original_start: number;
  original_end: number;
  text: string;
  confidence: number;
};
export type CaptionUnit = {
  start: number;
  end: number;
  text: string;
  original_start: number;
  original_end: number;
  confidence?: number;
};

/** A unit this short is dropped by the burn (video_editor_premiere.py
 *  _subs_for skips ≤ 0.05 s): it is joined to a neighbour instead. */
export const MIN_UNIT_S = 0.05;

type GluedUnit = CaptionUnit & { n: number; breakBefore: boolean };

/**
 * The caption units of the doc, glued like v1 (src/audio.py
 * _build_subtitles_from_transcription): inside a segment a word of ≤ 3
 * characters takes the next word with it. The doc has no Whisper
 * segments; a segment ends at a sentence end, a pause over 1.5 s or a
 * forced break. Hidden words (fillers, the user's) are left out first,
 * as v1 drops fillers before gluing. A unit of ≤ MIN_UNIT_S joins its
 * neighbour in the segment (a word squeezed by a split), so the burn
 * never drops it. For an unedited doc this gives v1's units
 * (testdata/caption_units_vectors.json).
 *
 * `cut` (UX10): words cut from the video are left out too, and no unit
 * glues across them (the clips either side are rendered apart).
 */
export function captionUnits(words: readonly DocWord[], cut?: (w: DocWord) => boolean): GluedUnit[] {
  const segs: DocWord[][] = [];
  let seg: DocWord[] = [];
  let forced = false;
  const breaks = new Set<DocWord>();
  for (const w of words) {
    if (cut?.(w)) {
      forced ||= !!w.breakBefore;
      if (seg.length) segs.push(seg);
      seg = [];
      continue;
    }
    if (!captioned(w)) {
      forced ||= !!w.breakBefore;
      continue;
    }
    const prev = seg[seg.length - 1];
    const brk = forced || !!w.breakBefore;
    forced = false;
    if (prev && (brk || SENTENCE_END.test(prev.text) || w.start - prev.end > 1.5)) {
      segs.push(seg);
      seg = [];
    }
    if (brk && (prev || segs.length)) breaks.add(w);
    seg.push(w);
  }
  if (seg.length) segs.push(seg);
  const out: GluedUnit[] = [];
  const unit = (ws: DocWord[]): GluedUnit => {
    const a = ws[0];
    const z = ws[ws.length - 1];
    const u: GluedUnit = {
      start: a.start,
      end: z.end,
      text: ws.map((w) => w.text.trim()).join(" "),
      original_start: a.start,
      original_end: z.end,
      n: ws.length,
      breakBefore: breaks.has(a),
    };
    const confs = ws.filter((w) => w.conf !== undefined).map((w) => w.conf!);
    if (confs.length) u.confidence = Math.min(...confs);
    return u;
  };
  for (const sw of segs) {
    const groups: DocWord[][] = [];
    for (let i = 0; i < sw.length; ) {
      if ([...sw[i].text.trim()].length <= 3 && i + 1 < sw.length) {
        groups.push([sw[i], sw[i + 1]]);
        i += 2;
      } else groups.push([sw[i++]]);
    }
    // no unit the burn would drop: a too-short one joins its neighbour
    for (let k = 0; k < groups.length && groups.length > 1; ) {
      const g = groups[k];
      if (g[g.length - 1].end - g[0].start > MIN_UNIT_S) {
        k++;
        continue;
      }
      if (k + 1 < groups.length) groups.splice(k, 2, [...g, ...groups[k + 1]]);
      else {
        groups.splice(k - 1, 2, [...groups[k - 1], ...g]);
        k--;
      }
    }
    for (const g of groups) out.push(unit(g));
  }
  return out;
}

const PHRASE_END = /[.!?…]["'»)\]]*\s*$/;

/**
 * What the preview and — until UT4 renders from the doc itself — the v1
 * render payload get from the doc: the glued units of captionUnits
 * (source times) and the editor sentences over them, built like v1's
 * buildPhrases (sentence end, a pause over 1.5 s, at most 10 words) plus
 * a forced break. Hidden words are in neither, nor (UX10) words `cut`
 * from the video.
 */
export function captionSource(
  words: readonly DocWord[],
  cut?: (w: DocWord) => boolean,
): { phrases: CaptionPhrase[]; units: CaptionUnit[] } {
  const glued = captionUnits(words, cut);
  const phrases: CaptionPhrase[] = [];
  let cur: GluedUnit[] = [];
  let n = 0;
  const flush = () => {
    if (!cur.length) return;
    const a = cur[0];
    const b = cur[cur.length - 1];
    phrases.push({
      start: a.start,
      end: b.end,
      original_start: a.original_start,
      original_end: b.original_end,
      text: cur.map((u) => u.text).join(" "),
      confidence: cur.reduce((x, u) => x + (u.confidence ?? 1), 0) / cur.length,
    });
    cur = [];
    n = 0;
  };
  for (const u of glued) {
    const prev = cur[cur.length - 1];
    if (prev && (u.breakBefore || PHRASE_END.test(prev.text) || u.start - prev.end > 1.5 || n + u.n > 10)) flush();
    cur.push(u);
    n += u.n;
  }
  flush();
  const units = glued.map((g) => {
    const u: CaptionUnit = { start: g.start, end: g.end, text: g.text, original_start: g.original_start, original_end: g.original_end };
    if (g.confidence !== undefined) u.confidence = g.confidence;
    return u;
  });
  return { phrases, units };
}

/** Index of the word at source time t (the last word starting at or
 *  before t, if t is before its end + 0.25 s), else -1. */
export function wordAt(starts: readonly number[], ends: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t + 1e-6) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  return t <= ends[found] + 0.25 ? found : -1;
}

// ── find & replace ──────────────────────────────────────────────────

export type Match = {
  /** First and last word of the hit. */
  first: number;
  last: number;
  /** Offsets of the hit inside the text of words first..last joined by spaces. */
  from: number;
  to: number;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a case-insensitive pattern; whitespace matches the word gap. */
export function queryPattern(query: string): RegExp | null {
  const toks = tokenize(query);
  if (!toks.length) return null;
  return new RegExp(toks.map(escapeRe).join("\\s+"), "giu");
}

/** Every (non-overlapping) hit of `query` in the words, in order. */
export function findMatches(words: readonly DocWord[], query: string, limit = 5000): Match[] {
  const re = queryPattern(query);
  if (!re || !words.length) return [];
  const offs: number[] = [];
  let pos = 0;
  const parts: string[] = [];
  for (const w of words) {
    offs.push(pos);
    parts.push(w.text);
    pos += w.text.length + 1;
  }
  const text = parts.join(" ");
  const wordOf = (off: number) => {
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: Match[] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0].length) continue;
    const s = m.index;
    const e = s + m[0].length;
    const first = wordOf(s);
    const last = wordOf(e - 1);
    out.push({ first, last, from: s - offs[first], to: e - offs[first] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Replace the given hits (from findMatches on this doc's words) by
 * `replacement`. Hits that share a word (two in "banana", or a phrase
 * hit ending where the next starts) are one text edit of their joined
 * words, replaced right to left; each edit follows the applyTextEdit
 * rules. Later groups first, so earlier indices stay valid. Every hit
 * is replaced.
 */
export function replaceMatches(doc: EditDoc, matches: readonly Match[], replacement: string, pool?: IdPool): EditDoc {
  const sorted = [...matches].sort((a, b) => a.first - b.first || a.from - b.from);
  const groups: { first: number; last: number; hits: Match[] }[] = [];
  for (const m of sorted) {
    const g = groups[groups.length - 1];
    if (g && m.first <= g.last) {
      g.last = Math.max(g.last, m.last);
      g.hits.push(m);
    } else groups.push({ first: m.first, last: m.last, hits: [m] });
  }
  let out = doc;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const texts = out.words.slice(g.first, g.last + 1).map((w) => w.text);
    // offset of each word inside the joined span
    const offs: number[] = [];
    let pos = 0;
    for (const t of texts) {
      offs.push(pos);
      pos += t.length + 1;
    }
    let text = texts.join(" ");
    const hits = g.hits
      .map((h) => ({ from: offs[h.first - g.first] + h.from, to: offs[h.first - g.first] + h.to }))
      .sort((a, b) => b.from - a.from);
    let limit = Infinity;
    for (const h of hits) {
      if (h.to > limit) continue; // overlapping hits (can't come from findMatches)
      text = text.slice(0, h.from) + replacement + text.slice(h.to);
      limit = h.from;
    }
    out = editRange(out, g.first, g.last, text, pool);
  }
  return out;
}

// ── PATCH diff (autosave) ───────────────────────────────────────────

const sameWord = (a: DocWord, b: DocWord) =>
  a === b ||
  (a.id === b.id &&
    a.text === b.text &&
    a.start === b.start &&
    a.end === b.end &&
    a.conf === b.conf &&
    !!a.filler === !!b.filler &&
    !!a.hidden === !!b.hidden &&
    !!a.breakBefore === !!b.breakBefore);

export type WordsPatch = { upsert: DocWord[]; delete: string[] };

/** The words part of a PATCH /jobs/{id}/doc that turns `base` into `next`. */
export function diffWords(base: readonly DocWord[], next: readonly DocWord[]): WordsPatch {
  const old = new Map<string, DocWord>();
  for (const w of base) old.set(w.id, w);
  const upsert: DocWord[] = [];
  const keep = new Set<string>();
  for (const w of next) {
    keep.add(w.id);
    const o = old.get(w.id);
    if (!o || !sameWord(o, w)) upsert.push(w);
  }
  const del: string[] = [];
  for (const w of base) if (!keep.has(w.id)) del.push(w.id);
  return { upsert, delete: del };
}

/** The server's merge of a words PATCH (backend/doc.py merge_words),
 *  mirrored for the tests and the autosave's self-check. */
export function mergeWords(words: readonly DocWord[], upsert: readonly DocWord[], del: readonly string[]): DocWord[] {
  const gone = new Set(del);
  const byId = new Map<string, DocWord>();
  for (const w of upsert) if (!gone.has(w.id)) byId.set(w.id, w);
  const out: DocWord[] = [];
  for (const w of words) {
    if (gone.has(w.id)) continue;
    const u = byId.get(w.id);
    if (u) byId.delete(w.id);
    out.push(u ?? w);
  }
  const present = new Set([...out.map((w) => w.id), ...byId.keys()]);
  const children = new Map<string, DocWord[]>();
  const free: DocWord[] = [];
  for (const w of byId.values()) {
    const dot = w.id.lastIndexOf(".");
    const parent = dot >= 0 ? w.id.slice(0, dot) : null;
    if (parent !== null && present.has(parent) && parent !== w.id) {
      const list = children.get(parent) ?? [];
      list.push(w);
      children.set(parent, list);
    } else free.push(w);
  }
  free.sort((a, b) => a.start - b.start);
  const merged: DocWord[] = [];
  const emit = (w: DocWord) => {
    const kids = children.get(w.id) ?? [];
    children.delete(w.id);
    for (const c of kids) if (c.start < w.start) emit(c);
    merged.push(w);
    for (const c of kids) if (!(c.start < w.start)) emit(c);
  };
  let i = 0;
  for (const w of out) {
    while (i < free.length && free[i].start < w.start) emit(free[i++]);
    emit(w);
  }
  while (i < free.length) emit(free[i++]);
  for (const kids of children.values()) merged.push(...kids);
  return merged;
}
