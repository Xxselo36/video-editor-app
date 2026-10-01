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
import { snapEdge, type Peaks } from "./snap";

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
  return tidy(out, a, b, duration);
}

/** Cut words first..last (doc indices) out of the video, edges snapped. */
export function cutWords(
  segs: EditorSeg[],
  words: readonly DocWord[],
  first: number,
  last: number,
  duration: number,
  peaks?: Peaks | null,
): EditorSeg[] {
  if (first < 0 || last >= words.length || first > last) return segs;
  const [sa, sb] = cutEdges(words, first, last, peaks);
  return sb > sa ? cutRange(segs, Math.max(0, sa), Math.min(duration, sb), duration) : segs;
}

/**
 * The source range cutting words first..last removes: each edge snapped
 * to the quietest moment within ±120 ms (review C10), but only inside
 * the gap to the neighbouring word — never into the word before or
 * after (its sound would be clipped, and a short one struck), never
 * back into the cut words (their tail would stay audible).
 */
export function cutEdges(words: readonly DocWord[], first: number, last: number, peaks?: Peaks | null): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (let i = first; i <= last; i++) {
    a = Math.min(a, words[i].start);
    b = Math.max(b, words[i].end);
  }
  const prevEnd = first > 0 ? Math.min(a, words[first - 1].end) : -Infinity;
  const nextStart = last + 1 < words.length ? Math.max(b, words[last + 1].start) : Infinity;
  const sa = snapEdge(a, peaks, undefined, undefined, { min: prevEnd, max: a });
  const sb = snapEdge(b, peaks, undefined, undefined, { min: b, max: nextStart });
  return [sa, sb];
}

/** Bring source [a, b] back: clips grow into it, neighbours merge. */
export function restoreRange(segs: EditorSeg[], a: number, b: number, duration: number): EditorSeg[] {
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
      // between clips that don't touch it: a clip of its own, in source order
      const at = out.findIndex((s) => active(s) && s.start > h0);
      const seg: EditorSeg = { id: freshId(out, `seg-r${Math.round(h0 * 1000)}`), start: h0, end: h1 };
      out = at < 0 ? [...out, seg] : [...out.slice(0, at), seg, ...out.slice(at)];
    }
  }
  return tidy(out, a, b, duration);
}

/** One struck word back (padded to MIN_ISLAND_S, so it can't be an island). */
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

/**
 * Around [a, b] (± MIN_ISLAND_S + MIN_REMOVAL_S): close removals shorter
 * than MIN_REMOVAL_S (the clips meet or merge), then drop kept islands
 * shorter than MIN_ISLAND_S that have a removal on both sides. Never
 * drops the last clip. Clips outside the window are left as they are.
 */
export function tidy(segs: EditorSeg[], a: number, b: number, duration: number): EditorSeg[] {
  const W = MIN_ISLAND_S + MIN_REMOVAL_S;
  const lo = a - W;
  const hi = b + W;
  const near = (s: number, e: number) => e >= lo && s <= hi;
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
      if (gap > EPS && gap < MIN_REMOVAL_S && near(p.end, q.start)) {
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
      if (first.start > EPS && first.start < MIN_REMOVAL_S && near(0, first.start)) {
        out = out.map((s) => (s === first ? { ...s, start: 0 } : s));
        changed = true;
      }
      const last = act.reduce((x, y) => (y.end > x.end ? y : x));
      if (duration - last.end > EPS && duration - last.end < MIN_REMOVAL_S && near(last.end, duration)) {
        out = out.map((s) => (s === last ? { ...s, end: duration } : s));
        changed = true;
      }
    }
    // 2. short islands with a removal on both sides
    const act2 = out.filter(active);
    for (const s of act2) {
      if (s.end - s.start >= MIN_ISLAND_S || !near(s.start, s.end)) continue;
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

/** A word whose middle lies in one of `ranges` (sorted, disjoint). */
export function cutBy(ranges: readonly Range[]): ((w: DocWord) => boolean) | undefined {
  if (!ranges.length) return undefined;
  return (w) => {
    const m = (w.start + w.end) / 2;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].end < m) lo = mid + 1;
      else if (ranges[mid].start > m) hi = mid - 1;
      else return true;
    }
    return false;
  };
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
 */
export function exportCaptionSource(
  words: readonly DocWord[],
  removed: readonly Range[],
): { phrases: CaptionPhrase[]; units: CaptionUnit[] } {
  return captionSource(words, cutBy(removed));
}

// ── the Text tab's marks ────────────────────────────────────────────

export type Chip = {
  kind: "pause" | "take";
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
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < pieces.length && pieces[j].end < mids[i]) j++;
    const p = pieces[j];
    if (p && p.start <= mids[i]) removed[i] = TAKE_KINDS.has(p.kind) ? 2 : 1;
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
