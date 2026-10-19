/**
 * Cuts in the text, visible AI cuts (UX10; editor.md §4.4–4.5, §7.2).
 *
 * The timeline's clip list (EditorSeg[], SOURCE seconds) is what plays
 * and what the export renders (/edit-segments → job.segments, read by the
 * v1 and the v2 render alike). Cutting words is a clip operation: the
 * words stay in the edit document and show struck through; restoring
 * grows or merges clips again. Every op here is pure and returns the same
 * array when nothing changed (no undo step), a new one otherwise (one
 * undo step, through the editor's one history).
 *
 *   cutRange / cutWords   remove [a, b] (word edges snapped to the
 *                         quietest moment within ±120 ms, state/snap.ts)
 *   restoreRange          bring [a, b] back (clips grow, neighbours merge)
 *   restoreWord           one struck word (at least MIN_ISLAND_S of it)
 *   restorePieces / restoreKind   bulk restore: every pause, every "um",
 *                         every Cleo-cut take or every AI cut — never a
 *                         cut the user made
 *
 * No micro-clips (review C11), applied by every op around what it
 * touched, so preview and export agree: a removal shorter than
 * MIN_REMOVAL_S is not made (or is closed), and a kept island shorter
 * than MIN_ISLAND_S between two removals is removed with them.
 *
 * What was removed, and why: the removed ranges of the clip list
 * (model.removedRanges) labelled by the job's analysis cuts
 * (cut_ranges[].kind, backend/cut_kinds.py); removed time no analysis
 * cut covers is the user's ("user"). Jobs from before UX10 have no kind:
 * a cut with a filler word in it is a filler, else a pause — the
 * backend's fallback rule.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { CutRange } from "@/features/jobs/types";
import { captionSource, type CaptionPhrase, type CaptionUnit, type DocWord } from "./doc";
import { PEAKS_RATE, SNAP_WINDOW_S, snapEdge, type Peaks } from "./snap";

export type CutKind = "silence" | "filler" | "voice_cmd" | "bad_take";
export type PieceKind = CutKind | "user";
export const CUT_KINDS: readonly CutKind[] = ["silence", "filler", "voice_cmd", "bad_take"];
/** Kinds shown as one take chip in the text (their words collapse into it). */
export const TAKE_KINDS: ReadonlySet<PieceKind> = new Set(["voice_cmd", "bad_take"]);

/** A removal shorter than this is not made (C11). */
export const MIN_REMOVAL_S = 0.12;
/** A kept island shorter than this between two removals goes too (C11). */
export const MIN_ISLAND_S = 0.25;
/** Removed time between two words from this long shows as a pause chip. */
export const PAUSE_CHIP_S = 0.4;
/**
 * Whisper stretches a word over the pause it ends in (or starts after):
 * 69 of the owner's 1001 words are longer than 1.5 s, up to 17.6 s. A
 * word longer than this has its sound at one end only: it plays when its
 * head or its tail plays (wordProbes, WORD_SOUND_S), and restoring it
 * brings back that end only (at most this long), never the whole pause
 * (restoreWords).
 */
export const LONG_WORD_S = 1.2;
/** A long word's sound at one end: about a word's length (its probe is the middle of it). */
const WORD_SOUND_S = 0.4;
/** Words this close (or overlapping) touch: Whisper's contiguous times leave no gap to snap in. */
const TOUCH_S = 0.015;
/** How far a cut edge may move into a touching word: this share of it (never up to its middle). */
const INTO_WORD = 0.4;
const EPS = 1e-3;

export type Range = { start: number; end: number };
export type AiCut = Range & { kind: CutKind };
export type Piece = Range & { kind: PieceKind };

const isKind = (k: unknown): k is CutKind => typeof k === "string" && (CUT_KINDS as readonly string[]).includes(k);
// the stronger reason wins where analysis cuts overlap
const RANK: Record<PieceKind, number> = { voice_cmd: 4, bad_take: 3, filler: 2, silence: 1, user: 0 };

/** The analysis cuts with their kinds (the fallback rule for old jobs), sorted. */
export function aiCutsOf(ranges: readonly CutRange[] | null | undefined, words: readonly DocWord[]): AiCut[] {
  const mids = words.filter((w) => w.filler || w.cut === "filler").map((w) => (w.start + w.end) / 2);
  const out: AiCut[] = [];
  for (const r of ranges ?? []) {
    const start = Number(r.start);
    const end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const kind = isKind(r.kind) ? r.kind : mids.some((m) => m >= start && m <= end) ? "filler" : "silence";
    out.push({ start, end, kind });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The removed ranges split into pieces by reason: the analysis cut that
 * covers each part (the stronger one where they overlap), else "user".
 * Touching pieces of the same kind are one; slivers under 10 ms dropped.
 */
export function labelRemoved(removed: readonly Range[], ai: readonly AiCut[]): Piece[] {
  const out: Piece[] = [];
  const push = (start: number, end: number, kind: PieceKind) => {
    if (end - start < 0.01) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && start - last.end < EPS) last.end = end;
    else out.push({ start, end, kind });
  };
  for (const r of removed) {
    const inside = ai.filter((c) => c.end > r.start && c.start < r.end);
    const cuts = new Set<number>([r.start, r.end]);
    for (const c of inside) {
      cuts.add(Math.max(r.start, c.start));
      cuts.add(Math.min(r.end, c.end));
    }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mid = (a + b) / 2;
      let kind: PieceKind = "user";
      for (const c of inside) if (c.start <= mid && c.end >= mid && RANK[c.kind] > RANK[kind]) kind = c.kind;
      push(a, b, kind);
    }
  }
  return out;
}

/** How many pieces of each kind (the bulk restore menu). */
export function countKinds(pieces: readonly Piece[]): Record<PieceKind, number> {
  const n: Record<PieceKind, number> = { silence: 0, filler: 0, voice_cmd: 0, bad_take: 0, user: 0 };
  for (const p of pieces) n[p.kind]++;
  return n;
}

/** The reason that removed most of [a, b] (a seam's gap), "user" if none. */
export function gapKind(pieces: readonly Piece[], a: number, b: number): PieceKind {
  const by = new Map<PieceKind, number>();
  for (const p of pieces) {
    const o = Math.min(b, p.end) - Math.max(a, p.start);
    if (o > 0) by.set(p.kind, (by.get(p.kind) ?? 0) + o);
  }
  let best: PieceKind = "user";
  let len = 0;
  for (const [k, v] of by) if (v > len + 1e-9 || (Math.abs(v - len) <= 1e-9 && RANK[k] > RANK[best])) [best, len] = [k, v];
  return best;
}

/**
 * Whether the gap of a seam (source a = the clip before's end, b = the
 * clip after's start) is removed footage: b > a and no clip plays any of
 * it. After a reorder a seam can jump forward across a clip that still
 * plays elsewhere — that is a move, not a cut (review 2/8): no kind, no
 * length, no Restore.
 */
export function seamIsCut(segs: readonly EditorSeg[], a: number, b: number): boolean {
  if (!(b - a > EPS)) return false;
  return !segs.some((s) => active(s) && s.start < b - EPS && s.end > a + EPS);
}

// ── clip ops ────────────────────────────────────────────────────────

const active = (s: EditorSeg) => !s.disabled && s.end - s.start > 0;

function freshId(segs: readonly EditorSeg[], base: string): string {
  const ids = new Set(segs.map((s) => s.id));
  let id = `${base}~c`;
  for (let k = 2; ids.has(id); k++) id = `${base}~c${k}`;
  return id;
}

/** Two clips that may become one: same speed and volume, no fade at the seam. */
const joinable = (a: EditorSeg, b: EditorSeg) =>
  (a.speed ?? 1) === (b.speed ?? 1) && (a.volume ?? 1) === (b.volume ?? 1) && !a.fadeOut && !b.fadeIn;

function withoutKey(s: EditorSeg, key: "fadeIn" | "fadeOut"): EditorSeg {
  if (s[key] === undefined) return s;
  const n = { ...s };
  delete n[key];
  return n;
}

/** Remove source [a, b] from every clip (C11 rules around it). */
export function cutRange(segs: EditorSeg[], a: number, b: number, duration: number): EditorSeg[] {
  if (!(b - a >= MIN_REMOVAL_S)) return segs;
  const out: EditorSeg[] = [];
  let changed = false;
  for (const s of segs) {
    if (!active(s) || s.end <= a + EPS || s.start >= b - EPS) {
      out.push(s);
      continue;
    }
    changed = true;
    if (s.start < a - EPS) out.push(withoutKey({ ...s, end: a }, "fadeOut"));
    if (s.end > b + EPS) out.push(withoutKey({ ...s, start: b, id: freshId([...segs, ...out], s.id) }, "fadeIn"));
  }
  if (!changed || !out.some(active)) return segs;
  return tidy(out, a, b, duration, segs);
}

/**
 * Cut words first..last (doc indices) out of the video, edges snapped. A
 * removal shorter than MIN_REMOVAL_S (a single short word between
 * touching neighbours) grows into the neighbours up to INTO_WORD of each,
 * else nothing is cut (the caller says so: cutting it alone isn't
 * possible).
 */
export function cutWords(
  segs: EditorSeg[],
  words: readonly DocWord[],
  first: number,
  last: number,
  duration: number,
  peaks?: Peaks | null,
): EditorSeg[] {
  if (first < 0 || last >= words.length || first > last) return segs;
  let [sa, sb] = cutEdges(words, first, last, peaks);
  if (sb - sa < MIN_REMOVAL_S) {
    // grow evenly, as far as the neighbours allow (never to their middles)
    const lo = first > 0 ? deepest(words[first - 1], "end") : 0;
    const hi = last + 1 < words.length ? deepest(words[last + 1], "start") : duration;
    const need = MIN_REMOVAL_S + 1e-4 - (sb - sa);
    let left = Math.min(need / 2, Math.max(0, sa - lo));
    const right = Math.min(need - left, Math.max(0, hi - sb));
    left = Math.min(need - right, Math.max(0, sa - lo));
    sa -= left;
    sb += right;
  }
  return sb > sa ? cutRange(segs, Math.max(0, sa), Math.min(duration, sb), duration) : segs;
}

/** How far into word `w` an edge may go from its `side`: INTO_WORD of it. */
function deepest(w: Pick<DocWord, "start" | "end">, side: "start" | "end"): number {
  const len = Math.max(0, w.end - w.start);
  return side === "end" ? w.end - INTO_WORD * len : w.start + INTO_WORD * len;
}

/**
 * The edge between touching (or overlapping) words l and r: the quietest
 * moment within ±120 ms of their join, at most INTO_WORD of either word
 * away from it — Whisper's boundary between joined words drifts (17–227
 * ms measured), and its own time left word tails audible or clipped the
 * neighbour. `fallback` when the words overlap so far no edge parts them.
 */
function joinEdge(l: DocWord, r: DocWord, peaks: Peaks | null | undefined, fallback: number): number {
  const join = (l.end + r.start) / 2;
  const lo = Math.max(join - SNAP_WINDOW_S, deepest(l, "end"));
  const hi = Math.min(join + SNAP_WINDOW_S, deepest(r, "start"));
  if (!(hi >= lo)) return fallback;
  const t = Math.min(hi, Math.max(lo, join));
  return snapEdge(t, peaks, SNAP_WINDOW_S, PEAKS_RATE, { min: lo, max: hi });
}

/** The start edge of a range beginning at word i (source start a). */
function startEdge(words: readonly DocWord[], i: number, a: number, peaks: Peaks | null | undefined): number {
  if (i === 0) return snapEdge(a, peaks, undefined, undefined, { min: -Infinity, max: a });
  const prev = words[i - 1];
  // a real gap: snap in it, never into the word before (review 14)
  if (a - prev.end > TOUCH_S) return snapEdge(a, peaks, undefined, undefined, { min: prev.end, max: a });
  return joinEdge(prev, words[i], peaks, a);
}

/** The end edge of a range ending at word j (source end b). */
function endEdge(words: readonly DocWord[], j: number, b: number, peaks: Peaks | null | undefined): number {
  if (j === words.length - 1) return snapEdge(b, peaks, undefined, undefined, { min: b, max: Infinity });
  const next = words[j + 1];
  if (next.start - b > TOUCH_S) return snapEdge(b, peaks, undefined, undefined, { min: b, max: next.start });
  return joinEdge(words[j], next, peaks, b);
}

/**
 * The source range cutting words first..last removes: each edge snapped
 * to the quietest moment within ±120 ms (review C10). Next to a real gap
 * only inside that gap — never into the word before or after, never back
 * into the cut words. Between touching words (94 % of Whisper's pairs,
 * no gap at all) around their join, at most INTO_WORD into either word,
 * so a neighbour's middle always stays and the cut words' go.
 */
export function cutEdges(words: readonly DocWord[], first: number, last: number, peaks?: Peaks | null): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (let i = first; i <= last; i++) {
    a = Math.min(a, words[i].start);
    b = Math.max(b, words[i].end);
  }
  return [startEdge(words, first, a, peaks), endEdge(words, last, b, peaks)];
}

/**
 * Bring source [a, b] back: clips grow into it, neighbours merge. With
 * `protect`, a kept island inside that range (a word the user asked
 * back) is never removed as a micro-clip.
 */
export function restoreRange(
  segs: EditorSeg[],
  a: number,
  b: number,
  duration: number,
  protect?: Range,
): EditorSeg[] {
  a = Math.max(0, a);
  b = Math.min(duration, b);
  if (!(b - a > EPS)) return segs;
  const kept = segs
    .filter(active)
    .map((s) => [s.start, s.end] as const)
    .sort((x, y) => x[0] - y[0]);
  const holes: [number, number][] = [];
  let cursor = a;
  for (const [s, e] of kept) {
    if (e <= cursor) continue;
    if (s >= b) break;
    if (s > cursor + EPS) holes.push([cursor, Math.min(s, b)]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < b - EPS) holes.push([cursor, b]);
  if (!holes.length) return segs;
  let out = segs.slice();
  for (const [h0, h1] of holes) {
    const L = out.findIndex((s) => active(s) && Math.abs(s.end - h0) < EPS);
    const R = out.findIndex((s) => active(s) && Math.abs(s.start - h1) < EPS);
    const nextOfL = L >= 0 ? out.findIndex((s, i) => i > L && active(s)) : -1;
    if (L >= 0 && R >= 0 && nextOfL === R && joinable(out[L], out[R])) {
      const merged: EditorSeg = { ...out[L], end: out[R].end };
      if (out[R].fadeOut !== undefined) merged.fadeOut = out[R].fadeOut;
      out = [...out.slice(0, L), merged, ...out.slice(L + 1, R), ...out.slice(R + 1)];
    } else if (L >= 0) {
      out[L] = { ...out[L], end: h1 };
    } else if (R >= 0) {
      out[R] = { ...out[R], start: h0 };
    } else {
      // between clips that don't touch it: a clip of its own, right after
      // the clip playing the footage before it (its source predecessor —
      // after a reorder that isn't the list's first later clip), else
      // before its source successor
      const seg: EditorSeg = { id: freshId(out, `seg-r${Math.round(h0 * 1000)}`), start: h0, end: h1 };
      let pred = -1;
      out.forEach((s, i) => {
        if (active(s) && s.end <= h0 + EPS && (pred < 0 || s.end > out[pred].end)) pred = i;
      });
      let at: number;
      if (pred >= 0) at = pred + 1;
      else {
        let succ = -1;
        out.forEach((s, i) => {
          if (active(s) && s.start >= h1 - EPS && (succ < 0 || s.start < out[succ].start)) succ = i;
        });
        at = succ >= 0 ? succ : out.length;
      }
      out = [...out.slice(0, at), seg, ...out.slice(at)];
    }
  }
  return tidy(out, a, b, duration, segs, protect);
}

/** One struck word back (padded to MIN_ISLAND_S, so it can't be an island) — the
 *  time range alone; with the doc words, restoreWords. */
export function restoreWord(segs: EditorSeg[], w: Pick<DocWord, "start" | "end">, duration: number): EditorSeg[] {
  let a = w.start;
  let b = w.end;
  const want = MIN_ISLAND_S + 0.05;
  if (b - a < want) {
    const pad = (want - (b - a)) / 2;
    a -= pad;
    b += pad;
  }
  return restoreRange(segs, a, b, duration);
}

/** Whether clip list `segs` plays source time t. */
const plays = (segs: readonly EditorSeg[], t: number) => segs.some((s) => active(s) && s.start <= t + EPS && s.end >= t - EPS);

/**
 * Where a long word's sound is (LONG_WORD_S): at the end a playing clip
 * touches, else the louder end (peaks), else its head.
 */
function soundAtHead(segs: readonly EditorSeg[], w: DocWord, peaks: Peaks | null | undefined): boolean {
  const head = plays(segs, w.start - 0.02);
  const tail = plays(segs, w.end + 0.02);
  if (head !== tail) return head;
  if (peaks && peaks.length) {
    const mean = (a: number, b: number) => {
      const i0 = Math.max(0, Math.floor(a * PEAKS_RATE));
      const i1 = Math.min(peaks.length, Math.ceil(b * PEAKS_RATE));
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += peaks[i];
      return i1 > i0 ? sum / (i1 - i0) : 0;
    };
    const h = mean(w.start, w.start + LONG_WORD_S);
    const t = mean(w.end - LONG_WORD_S, w.end);
    if (h !== t) return h > t;
  }
  return true;
}

/**
 * Struck words first..last back into the video (a click on a struck word,
 * Delete on a struck selection): exactly what cutting them removes (the
 * same snapped edges, so no fragment of a struck neighbour plays and the
 * restored word keeps its drifted onset), minus the silent part of a long
 * word (LONG_WORD_S: Whisper stretched it over a pause — only the end its
 * sound is at comes back, never seconds of removed pause or a Cleo take).
 * A short restored word may stay a clip of its own (the user asked for it).
 */
export function restoreWords(
  segs: EditorSeg[],
  words: readonly DocWord[],
  first: number,
  last: number,
  duration: number,
  peaks?: Peaks | null,
): EditorSeg[] {
  if (first < 0 || last >= words.length || first > last) return segs;
  const [a, b] = cutEdges(words, first, last, peaks);
  // the silent parts of long words, left out
  const silent: Range[] = [];
  for (let i = first; i <= last; i++) {
    const w = words[i];
    if (w.end - w.start <= LONG_WORD_S) continue;
    if (soundAtHead(segs, w, peaks)) {
      const from = snapEdge(w.start + LONG_WORD_S, peaks);
      silent.push({ start: Math.max(a, from), end: i === last ? b : w.end });
    } else {
      const to = snapEdge(w.end - LONG_WORD_S, peaks);
      silent.push({ start: i === first ? a : w.start, end: Math.min(b, to) });
    }
  }
  silent.sort((x, y) => x.start - y.start);
  const ranges: Range[] = [];
  let cur = a;
  for (const r of silent) {
    if (r.start > cur + EPS) ranges.push({ start: cur, end: Math.min(b, r.start) });
    cur = Math.max(cur, r.end);
  }
  if (b > cur + EPS) ranges.push({ start: cur, end: b });
  let out = segs;
  for (const r of ranges) out = restoreRange(out, r.start, r.end, duration, r);
  return out;
}

/** Every piece in `pieces` that `which` accepts back, as ONE op. */
export function restorePieces(
  segs: EditorSeg[],
  pieces: readonly Piece[],
  which: (p: Piece) => boolean,
  duration: number,
): EditorSeg[] {
  let out = segs;
  for (const p of pieces) if (which(p)) out = restoreRange(out, p.start, p.end, duration);
  return out;
}

/** Bulk restore by reason; "ai" = every analysis cut. User cuts never. */
export function restoreKind(segs: EditorSeg[], pieces: readonly Piece[], kind: CutKind | "ai", duration: number): EditorSeg[] {
  return restorePieces(segs, pieces, (p) => (kind === "ai" ? p.kind !== "user" : p.kind === kind), duration);
}

// ── no micro-clips (C11) ────────────────────────────────────────────

/** Edges key (0.1 ms) of a gap or a clip, for "was it there before the op". */
const edgeKey = (x: number, y: number) => `${Math.round(x * 1e4)}:${Math.round(y * 1e4)}`;

/** The short removals and short islands a clip list already has (tidy leaves those alone). */
function shortShapes(segs: readonly EditorSeg[], duration: number): { gaps: Set<string>; islands: Set<string> } {
  const gaps = new Set<string>();
  const islands = new Set<string>();
  const act = segs.filter(active);
  for (let i = 0; i + 1 < act.length; i++) {
    const gap = act[i + 1].start - act[i].end;
    if (gap > EPS && gap < MIN_REMOVAL_S) gaps.add(edgeKey(act[i].end, act[i + 1].start));
  }
  if (act.length) {
    const first = act.reduce((x, y) => (y.start < x.start ? y : x));
    if (first.start > EPS && first.start < MIN_REMOVAL_S) gaps.add(edgeKey(0, first.start));
    const last = act.reduce((x, y) => (y.end > x.end ? y : x));
    if (duration - last.end > EPS && duration - last.end < MIN_REMOVAL_S) gaps.add(edgeKey(last.end, duration));
  }
  for (const s of act) {
    if (s.end - s.start >= MIN_ISLAND_S) continue;
    const leftCut = s.start > EPS && !act.some((o) => o !== s && o.end > s.start - EPS && o.start < s.start - EPS);
    const rightCut = s.end < duration - EPS && !act.some((o) => o !== s && o.start < s.end + EPS && o.end > s.end + EPS);
    if (leftCut && rightCut) islands.add(edgeKey(s.start, s.end));
  }
  return { gaps, islands };
}

/**
 * Around [a, b] (± MIN_ISLAND_S + MIN_REMOVAL_S): close removals shorter
 * than MIN_REMOVAL_S (the clips meet or merge), then drop kept islands
 * shorter than MIN_ISLAND_S that have a removal on both sides. Never
 * drops the last clip. Clips outside the window are left as they are, and
 * so is what `before` (the list before the op) already had: a short
 * removal or a short clip the user trimmed on purpose is not the op's
 * micro-clip (a breath trimmed 0.08 s off a clip stays cut when the next
 * words are cut). Nor is an island inside `protect` (a word asked back).
 */
export function tidy(
  segs: EditorSeg[],
  a: number,
  b: number,
  duration: number,
  before?: readonly EditorSeg[],
  protect?: Range,
): EditorSeg[] {
  const W = MIN_ISLAND_S + MIN_REMOVAL_S;
  const lo = a - W;
  const hi = b + W;
  const near = (s: number, e: number) => e >= lo && s <= hi;
  const had = before ? shortShapes(before, duration) : { gaps: new Set<string>(), islands: new Set<string>() };
  const keepIsland = (s: EditorSeg) =>
    had.islands.has(edgeKey(s.start, s.end)) || (!!protect && s.start < protect.end - EPS && s.end > protect.start + EPS);
  let out = segs.slice();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    // 1. short removals between list neighbours
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      if (!active(p)) continue;
      const j = out.findIndex((s, k) => k > i && active(s));
      if (j < 0) break;
      const q = out[j];
      const gap = q.start - p.end;
      if (gap > EPS && gap < MIN_REMOVAL_S && near(p.end, q.start) && !had.gaps.has(edgeKey(p.end, q.start))) {
        if (joinable(p, q)) {
          const merged: EditorSeg = { ...p, end: q.end };
          if (q.fadeOut !== undefined) merged.fadeOut = q.fadeOut;
          else delete merged.fadeOut;
          out = [...out.slice(0, i), merged, ...out.slice(i + 1, j), ...out.slice(j + 1)];
        } else out[i] = { ...p, end: q.start };
        changed = true;
      }
    }
    // the very start and end of the video
    const act = out.filter(active);
    if (act.length) {
      const first = act.reduce((x, y) => (y.start < x.start ? y : x));
      if (
        first.start > EPS &&
        first.start < MIN_REMOVAL_S &&
        near(0, first.start) &&
        !had.gaps.has(edgeKey(0, first.start))
      ) {
        out = out.map((s) => (s === first ? { ...s, start: 0 } : s));
        changed = true;
      }
      const last = act.reduce((x, y) => (y.end > x.end ? y : x));
      if (
        duration - last.end > EPS &&
        duration - last.end < MIN_REMOVAL_S &&
        near(last.end, duration) &&
        !had.gaps.has(edgeKey(last.end, duration))
      ) {
        out = out.map((s) => (s === last ? { ...s, end: duration } : s));
        changed = true;
      }
    }
    // 2. short islands with a removal on both sides
    const act2 = out.filter(active);
    for (const s of act2) {
      if (s.end - s.start >= MIN_ISLAND_S || !near(s.start, s.end) || keepIsland(s)) continue;
      if (out.filter(active).length <= 1) break;
      const leftCut = s.start > EPS && !act2.some((o) => o !== s && o.end > s.start - EPS && o.start < s.start - EPS);
      const rightCut = s.end < duration - EPS && !act2.some((o) => o !== s && o.start < s.end + EPS && o.end > s.end + EPS);
      if (leftCut && rightCut) {
        out = out.filter((x) => x !== s);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

// ── what the export captions ────────────────────────────────────────

/**
 * The source moments that decide whether a word plays: its middle; a
 * long word (LONG_WORD_S): the middles of a word's length at its head
 * and at its tail — it plays when either does (Whisper stretched it over
 * a pause, its sound is at one end). The Text tab's struck words and the export's captions
 * use the same rule.
 */
export function wordProbes(w: Pick<DocWord, "start" | "end">): number[] {
  if (w.end - w.start > LONG_WORD_S) return [w.start + WORD_SOUND_S / 2, w.end - WORD_SOUND_S / 2];
  return [(w.start + w.end) / 2];
}

/** The range of `ranges` (sorted, disjoint) holding t, or -1. */
function rangeAt(ranges: readonly Range[], t: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].end < t) lo = mid + 1;
    else if (ranges[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/** A word cut by `ranges` (sorted, disjoint): every probe of it removed (wordProbes). */
export function cutBy(ranges: readonly Range[]): ((w: DocWord) => boolean) | undefined {
  if (!ranges.length) return undefined;
  return (w) => wordProbes(w).every((t) => rangeAt(ranges, t) >= 0);
}

/**
 * The render payload's caption source: the doc's caption source without
 * the words cut from the video (`removed`), and no unit glued across a
 * cut — so the v1 burn (which shows a unit's whole text in every clip it
 * overlaps) and the v2 render (which maps the units onto the doc words)
 * both caption exactly the words that play. Built once, when the export
 * starts. The preview doesn't need it: its overlay never plays cut time
 * and breaks pages at every cut (sourceBreaks), so a timeline change
 * never re-lays out every caption (the owner's "brief hang").
 *
 * With `segs`, no unit glues across a reorder boundary either (review
 * 15): footage that continues in the source but not in the play order
 * (reorderBreaks) gets a forced break, so a unit never carries a word to
 * the other place in the video.
 */
export function exportCaptionSource(
  words: readonly DocWord[],
  removed: readonly Range[],
  segs?: readonly EditorSeg[],
): { phrases: CaptionPhrase[]; units: CaptionUnit[] } {
  const breaks = segs ? reorderBreaks(segs) : [];
  if (!breaks.length) return captionSource(words, cutBy(removed));
  const marked = words.slice();
  let k = 0;
  for (const b of breaks) {
    // the first word that plays from b on (by its middle)
    while (k < marked.length && (marked[k].start + marked[k].end) / 2 < b) k++;
    if (k < marked.length && !marked[k].breakBefore) marked[k] = { ...marked[k], breakBefore: true };
  }
  return captionSource(marked, cutBy(removed));
}

/**
 * Source times where footage continues in the source but not in the
 * play order (a reordered clip list): the start of each clip whose
 * source predecessor (the clip ending right before it, in the source) is
 * not the clip playing right before it. Sorted. None for a list in
 * source order (cuts only), so exports without a reorder are unchanged.
 */
export function reorderBreaks(segs: readonly EditorSeg[]): number[] {
  const act = segs.filter(active);
  const playNext = new Map<EditorSeg, EditorSeg | undefined>();
  act.forEach((s, i) => playNext.set(s, act[i + 1]));
  const bySource = act.slice().sort((a, b) => a.start - b.start);
  const out: number[] = [];
  for (let i = 1; i < bySource.length; i++) {
    const p = bySource[i - 1];
    const q = bySource[i];
    if (playNext.get(p) !== q) out.push(q.start);
  }
  return out;
}

// ── the Text tab's marks ────────────────────────────────────────────

export type Chip = {
  /** span: footage brought back without words, its text on the way
   *  (busy) or failed (a retry); v2/useSpanFill.ts, not textMarks. */
  kind: "pause" | "take" | "span";
  /** span chips: the request's state and key. */
  span?: { state: "busy" | "failed"; key: string };
  /** The reason (a take chip: voice_cmd / bad_take; a pause chip: the main one). */
  reason: PieceKind;
  /** Removed seconds it stands for. */
  len: number;
  /** What a click restores. */
  ranges: Range[];
  /** Source time of its start (seek). */
  start: number;
};

export type TextMarks = {
  /** Per word: 0 plays, 1 removed (struck), 2 inside a take chip (not shown). */
  removed: Uint8Array;
  /** Chips before word i (i = words.length: after the last word). */
  chips: Map<number, Chip[]>;
};

/**
 * Struck words, take chips and pause chips (removed gaps between words
 * of ≥ PAUSE_CHIP_S, takes not counted) for the Text tab. Words are in
 * doc order (sorted by start).
 */
export function textMarks(words: readonly DocWord[], pieces: readonly Piece[], duration: number): TextMarks {
  const n = words.length;
  const removed = new Uint8Array(n);
  const chips = new Map<number, Chip[]>();
  const add = (i: number, c: Chip) => {
    const list = chips.get(i);
    if (list) list.push(c);
    else chips.set(i, [c]);
  };
  if (!pieces.length) return { removed, chips };
  const mids = words.map((w) => (w.start + w.end) / 2);
  for (let i = 0; i < n; i++) {
    // struck when every probe is removed (a long word: head and tail)
    let kind: PieceKind | null = null;
    for (const t of wordProbes(words[i])) {
      const k = rangeAt(pieces, t);
      if (k < 0) {
        kind = null;
        break;
      }
      kind ??= pieces[k].kind;
    }
    if (kind) removed[i] = TAKE_KINDS.has(kind) ? 2 : 1;
  }
  // take chips: where the take starts (its words collapse into it)
  for (const p of pieces) {
    if (!TAKE_KINDS.has(p.kind)) continue;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mids[mid] < p.start) lo = mid + 1;
      else hi = mid;
    }
    add(lo, { kind: "take", reason: p.kind, len: p.end - p.start, ranges: [{ start: p.start, end: p.end }], start: p.start });
  }
  // pause chips: removed (non-take) time in each gap between words
  const plain = pieces.filter((p) => !TAKE_KINDS.has(p.kind));
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const g0 = i === 0 ? 0 : words[i - 1].end;
    const g1 = i === n ? Math.max(duration, g0) : words[i].start;
    if (g1 - g0 < PAUSE_CHIP_S) continue;
    while (k < plain.length && plain[k].end <= g0) k++;
    const ranges: Range[] = [];
    let len = 0;
    let main: PieceKind = "silence";
    let mainLen = 0;
    for (let q = k; q < plain.length && plain[q].start < g1; q++) {
      const s = Math.max(g0, plain[q].start);
      const e = Math.min(g1, plain[q].end);
      if (e - s <= 0) continue;
      ranges.push({ start: s, end: e });
      len += e - s;
      if (e - s > mainLen) [main, mainLen] = [plain[q].kind, e - s];
    }
    if (len >= PAUSE_CHIP_S) add(i, { kind: "pause", reason: main, len, ranges, start: ranges[0].start });
  }
  return { removed, chips };
}
