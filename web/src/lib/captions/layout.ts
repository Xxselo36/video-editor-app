/**
 * Paging and layout (captions.md §4.4), from metric tables only.
 *
 * 1. Chunks: the words are split at hard breaks — a cut, a sentence end
 *    (. ! ? … 。 ！ ？ । ॥), a pause longer than `maxGapSec`, a user
 *    `breakBefore`. A page never spans a chunk boundary.
 * 2. Pages: each chunk is filled greedily. A word joins the page if the
 *    page still fits in `maxLines` lines of at most `wordsPerLine` words and
 *    `maxWidth` (in em of the real font), and the page has fewer than
 *    `maxWords`. A clause end (, ; : 、 ，) closes a page once it is half full.
 * 3. Orphans: a chunk never ends on a one-word page while the page before
 *    has 3+ words — one word moves over (if it fits).
 * 4. Timing: a page runs from its first word's start to
 *    min(last word end + hold, next page start, next cut).
 * 5. Size: never shrink per page. The only exception is a single word
 *    wider than the line: it gets a page of its own, drawn smaller.
 *
 * Japanese and Chinese have no spaces: their tokens are merged per chunk
 * and re-cut into words with Intl.Segmenter (times interpolated by
 * characters inside a token), and no space is put between two CJK words.
 */
import { isEmphasis } from "./emphasis";
import { faceChain, stripUndrawable } from "./fonts";
import { measureText, requireFont } from "./metrics";
import { joinsWithoutSpace, scriptOfLang, segmentsWithoutSpaces, wordScript } from "./scripts";
import type { CaptionStyle, CaptionWord, LineBox, Page, PageLayout, PageWord, Script, WordBox } from "./types";

export type LayoutOptions = {
  W: number;
  H: number;
  /** Transcript language (case mapping, fonts, segmentation, emphasis). */
  lang?: string;
  /** Output times of cuts; a page never spans one. */
  breaks?: readonly number[];
};

const SENTENCE_END = /[.!?…。！？।॥‼⁇⁈⁉][)"'’”»›\]」』）】]*$/u;
const CLAUSE_END = /[,;:、，；：][)"'’”»›\]」』）]*$/u;

type Unit = {
  index: number;
  id?: string;
  source: string;
  start: number;
  end: number;
  breakBefore?: boolean;
};

export function caseText(text: string, mode: CaptionStyle["font"]["case"], lang?: string): string {
  if (mode !== "upper") return text;
  try {
    return text.toLocaleUpperCase(lang ? lang.split(/[-_]/)[0] : undefined);
  } catch {
    return text.toUpperCase();
  }
}

function clean(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Splits units into chunks at hard breaks (rule 1). */
function chunk(units: Unit[], maxGapSec: number, breaks: readonly number[]): Unit[][] {
  const chunks: Unit[][] = [];
  let cur: Unit[] = [];
  for (const u of units) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = u.start - prev.end;
      const cut = breaks.some((b) => b > prev.start + 1e-3 && b <= u.start + 1e-3);
      if (u.breakBefore || cut || gap > maxGapSec + 1e-9 || SENTENCE_END.test(prev.source)) {
        chunks.push(cur);
        cur = [];
      }
    }
    cur.push(u);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
const OPENING = /^[\p{Ps}\p{Pi}¿¡]+$/u;

/**
 * A token that is only punctuation or a symbol ("%", "–", "!", "«") never
 * stands alone on a line: it joins the word before it (opening marks: the
 * word after it) with a no-break space, as in "100 %" or "kommst –".
 */
function gluePunctuation(units: Unit[]): Unit[] {
  const out: Unit[] = [];
  let lead = null as Unit | null;
  for (const u of units) {
    if (PUNCT_ONLY.test(u.source)) {
      const prev = out[out.length - 1];
      if (prev && !OPENING.test(u.source) && !lead) {
        out[out.length - 1] = { ...prev, source: `${prev.source} ${u.source}`, end: Math.max(prev.end, u.end) };
      } else {
        lead = lead ? { ...lead, source: `${lead.source} ${u.source}`, end: u.end } : u;
      }
      continue;
    }
    if (lead) {
      out.push({ ...u, index: lead.index, id: lead.id ?? u.id, source: `${lead.source} ${u.source}`, start: lead.start });
      lead = null;
    } else out.push(u);
  }
  if (lead) {
    const prev = out[out.length - 1];
    if (prev) out[out.length - 1] = { ...prev, source: `${prev.source} ${lead.source}`, end: Math.max(prev.end, lead.end) };
    else out.push(lead);
  }
  return out;
}

type SegmenterLike = { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };

function segmenter(lang: string): SegmenterLike | null {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => SegmenterLike }).Segmenter;
  if (!Seg) return null;
  try {
    return new Seg(lang, { granularity: "word" });
  } catch {
    return null;
  }
}

/**
 * Japanese/Chinese: Whisper tokens are characters or fragments. Merge a
 * chunk's tokens and cut the text into words with Intl.Segmenter;
 * punctuation sticks to the word before it. A word's times come from the
 * tokens it covers, interpolated by character inside a split token.
 */
export function segmentChunk(units: Unit[], lang: string): Unit[] {
  const seg = segmenter(lang);
  if (!seg || units.length === 0) return units;
  const text = units.map((u) => u.source).join("");
  // character offset → unit
  const bounds: { from: number; to: number; u: Unit }[] = [];
  let pos = 0;
  for (const u of units) {
    const len = u.source.length;
    bounds.push({ from: pos, to: pos + len, u });
    pos += len;
  }
  const timeAt = (offset: number, isEnd: boolean): number => {
    const b =
      bounds.find((x) => (isEnd ? offset > x.from && offset <= x.to : offset >= x.from && offset < x.to)) ??
      bounds[isEnd ? bounds.length - 1 : 0];
    const f = b.to > b.from ? (offset - b.from) / (b.to - b.from) : 0;
    return b.u.start + (b.u.end - b.u.start) * Math.min(1, Math.max(0, f));
  };
  const pieces: { from: number; to: number; word: boolean }[] = [];
  for (const s of seg.segment(text)) {
    const from = s.index;
    const to = s.index + s.segment.length;
    if (!s.segment.trim()) continue;
    const word = s.isWordLike !== false;
    const last = pieces[pieces.length - 1];
    if (!word && last) last.to = to;
    else if (word && last && !last.word) {
      last.to = to;
      last.word = true;
    } else pieces.push({ from, to, word });
  }
  return pieces.map((p) => {
    const first = bounds.find((b) => p.from < b.to) ?? bounds[0];
    const covered = bounds.filter((b) => b.from < p.to && b.to > p.from);
    return {
      index: first.u.index,
      id: covered.map((b) => b.u.id).find(Boolean),
      source: text.slice(p.from, p.to),
      start: timeAt(p.from, false),
      end: timeAt(p.to, true),
      breakBefore: p.from === first.from ? first.u.breakBefore : undefined,
    };
  });
}

/** Everything paging and layout need about the style at this frame size. */
export type Geometry = {
  px: number;
  maxEm: number;
  spaceEm: number;
  langScript: Script;
};

/**
 * Font sizes are whole multiples of PX_STEP device pixels (UT5 parity):
 * Chromium and Skia in Node (the render worker) rasterise a fractional
 * size differently enough to show in the caption crop's SSIM; on the same
 * whole size they agree. 0 turns it off.
 */
export const PX_STEP = 1;

/** `px` on the PX_STEP grid (down: never larger, for sizes that must still fit). */
export function snapPx(px: number, down = false): number {
  if (!(PX_STEP > 0) || !(px > 0)) return px;
  const v = (down ? Math.floor(px / PX_STEP + 1e-9) : Math.round(px / PX_STEP)) * PX_STEP;
  return Math.max(PX_STEP, v);
}

export function geometry(style: CaptionStyle, W: number, H: number, lang?: string): Geometry {
  const font = requireFont(style.font.id);
  const px = snapPx(style.font.size * Math.min(W, H));
  const maxEm = (style.layout.maxWidth * W) / px;
  const space = (font.advance(0x20) ?? font.upm * 0.26) / font.upm;
  // a scaled active word needs room so it never touches its neighbours
  const grow = style.highlight.mode === "scale" ? ((style.highlight.scale ?? 1.12) - 1) * 2.2 : 0;
  return { px, maxEm, spaceEm: space * style.layout.wordSpacing + grow, langScript: scriptOfLang(lang) };
}

function toPageWords(units: Unit[], style: CaptionStyle, geo: Geometry, lang?: string): PageWord[] {
  const words = units.map((u): PageWord => {
    const text = caseText(u.source, style.font.case, lang);
    const script = wordScript(text, geo.langScript);
    const m = measureText(text, faceChain(style.font.id, lang, script));
    return {
      index: u.index,
      ...(u.id ? { id: u.id } : {}),
      source: u.source,
      text,
      start: u.start,
      end: Math.max(u.start, u.end),
      emphasis: isEmphasis(u.source),
      script,
      em: m.em,
      spaceAfterEm: geo.spaceEm,
      ...(m.approximate ? { approximate: true } : {}),
    };
  });
  for (let i = 0; i + 1 < words.length; i++) {
    if (joinsWithoutSpace(words[i].text, words[i + 1].text)) words[i].spaceAfterEm = 0;
  }
  return words;
}

/** Greedy line breaking; returns word counts per line. */
function breakLines(words: readonly PageWord[], wordsPerLine: number, maxEm: number): number[] {
  const lines: number[] = [];
  let n = 0;
  let cur = 0;
  words.forEach((w, i) => {
    const gap = n ? words[i - 1].spaceAfterEm : 0;
    if (n && (n >= wordsPerLine || cur + gap + w.em > maxEm + 1e-9)) {
      lines.push(n);
      n = 0;
      cur = 0;
    }
    cur += (n ? gap : 0) + w.em;
    n++;
  });
  if (n) lines.push(n);
  return lines;
}

function fits(words: readonly PageWord[], style: CaptionStyle, maxEm: number): boolean {
  const L = style.layout;
  if (L.maxWords && words.length > L.maxWords) return false;
  return breakLines(words, L.wordsPerLine, maxEm).length <= L.maxLines;
}

/** Rules 1–5: words (output time) → pages. */
export function buildPages(words: readonly CaptionWord[], style: CaptionStyle, opts: LayoutOptions): Page[] {
  const { W, H, lang, breaks = [] } = opts;
  const geo = geometry(style, W, H, lang);
  const L = style.layout;
  const units: Unit[] = [];
  words.forEach((w, index) => {
    const source = clean(stripUndrawable(w.text, style.font.id, lang).text);
    if (!source) return;
    units.push({ index, ...(w.id ? { id: w.id } : {}), source, start: w.start, end: w.end, breakBefore: w.breakBefore });
  });
  units.sort((a, b) => a.start - b.start || a.index - b.index);
  const segment = segmentsWithoutSpaces(lang);
  const capacity = L.maxWords ?? L.wordsPerLine * L.maxLines;
  const halfFull = Math.max(2, Math.ceil(capacity / 2));
  const pages: { words: PageWord[]; oversized: boolean }[] = [];
  for (const raw of chunk(units, L.maxGapSec, breaks)) {
    const ws = toPageWords(segment ? segmentChunk(raw, lang ?? "ja") : gluePunctuation(raw), style, geo, lang);
    const out: { words: PageWord[]; oversized: boolean }[] = [];
    let pg: PageWord[] = [];
    const flush = () => {
      if (pg.length) out.push({ words: pg, oversized: false });
      pg = [];
    };
    for (const w of ws) {
      if (w.em > geo.maxEm + 1e-9) {
        flush();
        out.push({ words: [w], oversized: true });
        continue;
      }
      const prev = pg[pg.length - 1];
      const clauseEnd = prev && CLAUSE_END.test(prev.source) && pg.length >= halfFull;
      if (pg.length && (clauseEnd || !fits([...pg, w], style, geo.maxEm))) flush();
      pg.push(w);
    }
    flush();
    // rule 3: no lonely last word after a full page
    const n = out.length;
    if (n >= 2 && capacity > 1 && L.wordsPerLine > 1) {
      const last = out[n - 1];
      const before = out[n - 2];
      if (!last.oversized && !before.oversized && last.words.length === 1 && before.words.length >= 3) {
        const moved = before.words[before.words.length - 1];
        const candidate = [moved, ...last.words];
        if (fits(candidate, style, geo.maxEm)) {
          before.words = before.words.slice(0, -1);
          last.words = candidate;
        }
      }
    }
    pages.push(...out);
  }
  const hold = style.timing.holdSec;
  const sortedBreaks = [...breaks].sort((a, b) => a - b);
  return pages.map((p, i): Page => {
    const start = p.words[0].start;
    const lastEnd = Math.max(...p.words.map((w) => w.end));
    const next = pages[i + 1];
    const cut = sortedBreaks.find((b) => b > start + 1e-3);
    const end = Math.min(lastEnd + hold, next ? next.words[0].start : Infinity, cut ?? Infinity);
    const page: Page = { index: i, words: p.words, start, end: Math.max(end, start + 1e-3), oversized: p.oversized };
    const adjust = pageAdjust(p.words, style);
    if (adjust) page.adjust = adjust;
    return page;
  });
}

/**
 * A page's own position / size (UT5): the adjustment of the first word on
 * it that has one (style.captions is keyed by the id of a caption's first
 * word; after a re-paging the word may sit further into a page).
 */
function pageAdjust(words: readonly PageWord[], style: CaptionStyle): Page["adjust"] | null {
  const map = style.captions;
  if (!map) return null;
  for (const w of words) {
    const a = w.id !== undefined && Object.prototype.hasOwnProperty.call(map, w.id) ? map[w.id] : undefined;
    if (a) return { id: w.id!, ...a };
  }
  return null;
}

/** Widest share of the frame width a caption may grow to (per-caption size). */
export const ADJUST_MAX_WIDTH = 0.96;

// ---------------------------------------------------------------- layout

// Layouts are cached per page object; styles are treated as immutable
// (resolveStyle returns a fresh object for every change).
const layoutCache = new WeakMap<Page, { key: string; layout: PageLayout }>();
const styleIds = new WeakMap<CaptionStyle, number>();
let nextStyleId = 1;
function styleKey(style: CaptionStyle): number {
  let id = styleIds.get(style);
  if (!id) {
    id = nextStyleId++;
    styleIds.set(style, id);
  }
  return id;
}

/** Positions of a page's lines and words, in px of a W×H frame. */
export function layoutPage(page: Page, style: CaptionStyle, opts: { W: number; H: number; lang?: string }): PageLayout {
  const { W, H } = opts;
  const key = `${W}x${H}|${styleKey(style)}`;
  const hit = layoutCache.get(page);
  if (hit && hit.key === key) return hit.layout;
  const L = style.layout;
  const font = requireFont(style.font.id);
  const geo = geometry(style, W, H, opts.lang);
  let px = geo.px;
  if (page.oversized) {
    const widest = Math.max(...page.words.map((w) => w.em));
    px = snapPx(px * Math.min(1, geo.maxEm / widest), true);
  }
  const counts = breakLines(page.words, L.wordsPerLine, (L.maxWidth * W) / px);
  // A caption's own size scales the page as broken at the style's size
  // (same lines), never wider than ADJUST_MAX_WIDTH of the frame.
  const adj = page.adjust;
  if (adj?.sizeScale !== undefined) {
    let f = adj.sizeScale / (style.sizeScale ?? 1);
    if (f > 1) {
      let widest = 0;
      let k0 = 0;
      for (const count of counts) {
        let em = 0;
        for (let j = 0; j < count; j++) em += page.words[k0 + j].em + (j ? page.words[k0 + j - 1].spaceAfterEm : 0);
        widest = Math.max(widest, em * px);
        k0 += count;
      }
      if (widest > 0) f = Math.min(f, Math.max(1, (ADJUST_MAX_WIDTH * W) / widest));
    }
    px = snapPx(px * f, f > 1);
  }
  const lineH = px * style.font.lineHeight;
  const capH = (font.capHeight / font.upm) * px;
  const blockH = lineH * counts.length;
  const cx = L.x * W;
  let top = (adj?.y ?? L.y) * H - blockH / 2;
  top = Math.min(Math.max(top, H * 0.02), H * 0.98 - blockH);
  const lines: LineBox[] = [];
  let k = 0;
  counts.forEach((count, li) => {
    const ws = page.words.slice(k, k + count);
    let width = 0;
    ws.forEach((w, j) => {
      width += w.em * px + (j ? ws[j - 1].spaceAfterEm * px : 0);
    });
    const baseline = top + lineH * li + (lineH + capH) / 2;
    let x = cx - width / 2;
    const boxes: WordBox[] = ws.map((w, j) => {
      const box: WordBox = { k: k + j, text: w.text, x, width: w.em * px, baseline, px };
      x += w.em * px + w.spaceAfterEm * px;
      return box;
    });
    lines.push({ words: boxes, left: cx - width / 2, right: cx + width / 2, baseline });
    k += count;
  });
  const approximate = page.words.some((w) => w.approximate === true);
  const layout: PageLayout = {
    W,
    H,
    px,
    lineH,
    capH,
    cx,
    cy: top + blockH / 2,
    lines,
    box: {
      left: Math.min(...lines.map((l) => l.left)),
      top: lines[0].baseline - capH,
      right: Math.max(...lines.map((l) => l.right)),
      bottom: lines[lines.length - 1].baseline + px * 0.22,
    },
    approximate,
  };
  layoutCache.set(page, { key, layout });
  return layout;
}

/** Rounded, JSON-friendly layout (parity suite, test page). */
export function layoutJSON(page: Page, layout: PageLayout) {
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    index: page.index,
    start: r(page.start),
    end: r(page.end),
    px: r(layout.px),
    lines: layout.lines.map((l) =>
      l.words.map((b) => ({
        k: b.k,
        id: page.words[b.k].id,
        text: b.text,
        x: r(b.x),
        w: r(b.width),
        y: r(b.baseline),
      })),
    ),
  };
}
