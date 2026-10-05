"use client";
/**
 * Text for footage that comes back without any (backlog #20): when ONE
 * deliberate action on one clip — a trim / extension, restoring one
 * seam, one chip, one word or a selection — brings a span of footage
 * into the clips that has no words in the doc (the analysis cut it, so
 * Whisper never heard it as speech, or its only words are a hidden
 * silence hallucination), the editor quietly asks the server to
 * transcribe just that span (POST /jobs/{id}/transcribe-span,
 * useDocSession.transcribeSpan). The Text tab shows "Adding text…"
 * there; the words then appear and the captions follow.
 *
 * Which spans (planSpans):
 * - The shell says when an action was deliberate (note(), right after
 *   it committed). Bulk restores ("Restore all pauses / AI cuts"), undo
 *   and redo note nothing: they never ask. What the analysis cut as
 *   silence is very likely silent; a bulk restore would be one call per
 *   pause.
 * - Spans less than COALESCE_GAP_S apart with no word between them are
 *   one request (≤ MAX_SPAN_S).
 * - A span the analysis cut as silence is asked for only from
 *   SILENCE_MIN_S on, or when a hidden hallucination lies in it (Whisper
 *   heard something there). Fillers, voice commands and the user's own
 *   cuts are asked for first.
 *
 * The queue (SpanFiller): one request at a time; each span once per
 * session. A 429 (rate limit), a 409 busy or a save waiting for its
 * retry pause the queue for the wait asked ({ later }): nothing failed,
 * the span stays "busy". A real failure leaves one quiet retry chip per
 * span (no toast).
 */
import { useCallback, useEffect, useState } from "react";
import { gapKind, type Piece } from "@/features/editor/state/cuts";
import type { DocWord } from "@/features/editor/state/doc";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { SpanResult } from "./useDocSession";

/** Shortest span without words worth a transcription (s). */
export const MIN_GAP_S = 0.5;
/** A span cut as silence: asked for only from this long (s). */
export const SILENCE_MIN_S = 1.5;
/** Spans closer than this (and no word between) are one request (s). */
export const COALESCE_GAP_S = 1;
/** Longest span per request: the server's cap is 60 s, less a margin for rounding. */
export const MAX_SPAN_S = 59.5;
/** Automatic requests per editor session (a video with no speech at all…). */
export const MAX_AUTO = 40;
/** note() counts for the clip change within this long (ms). */
export const INTENT_MS = 1500;

type Range = { start: number; end: number };

export type SpanMark = Range & { key: string; state: "busy" | "failed" };

/** The source ranges the clips play, merged and sorted. */
export function keptRanges(segs: readonly EditorSeg[]): Range[] {
  const r = segs
    .filter((s) => !s.disabled && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end + 1e-6) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/** `next` minus `prev` (both merged and sorted). */
export function addedRanges(prev: readonly Range[], next: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const n of next) {
    let cur = n.start;
    for (const p of prev) {
      if (p.end <= cur || p.start >= n.end) continue;
      if (p.start > cur) out.push({ start: cur, end: p.start });
      cur = Math.max(cur, p.end);
      if (cur >= n.end) break;
    }
    if (cur < n.end) out.push({ start: cur, end: n.end });
  }
  return out.filter((r) => r.end - r.start > 1e-3);
}

const sameRanges = (a: readonly Range[], b: readonly Range[]) =>
  a.length === b.length && a.every((r, i) => Math.abs(r.start - b[i].start) < 1e-6 && Math.abs(r.end - b[i].end) < 1e-6);

/** A hidden silence hallucination: not text there. */
const isGhost = (w: DocWord) => !!(w.hidden && w.nospeech);
/** A word that counts as text there. */
const isText = (w: DocWord) => !isGhost(w);
const mid = (w: DocWord) => (w.start + w.end) / 2;

/**
 * The parts of `ranges` without any word (≥ minGap), split into pieces
 * of at most maxSpan. Words are sorted by start (doc order).
 */
export function wordlessSpans(
  ranges: readonly Range[],
  words: readonly DocWord[],
  minGap = MIN_GAP_S,
  maxSpan = MAX_SPAN_S,
): Range[] {
  const text = words.filter(isText);
  const out: Range[] = [];
  const push = (a: number, b: number) => {
    if (b - a < minGap) return;
    const n = Math.ceil((b - a) / maxSpan);
    const d = (b - a) / n;
    for (let k = 0; k < n; k++) out.push({ start: round(a + k * d), end: round(k === n - 1 ? b : a + (k + 1) * d) });
  };
  for (const r of ranges) {
    let cur = r.start;
    for (const w of text) {
      if (w.end <= cur) continue;
      if (w.start >= r.end) break;
      if (w.start > cur) push(cur, w.start);
      cur = Math.max(cur, w.end);
      if (cur >= r.end) break;
    }
    if (cur < r.end) push(cur, r.end);
  }
  return out;
}

/**
 * Neighbouring spans as one request: less than `gap` apart, no text
 * word between them (the server answers a span with words in it from
 * the doc, without transcribing), at most maxSpan long.
 */
export function coalesceSpans(
  spans: readonly Range[],
  words: readonly DocWord[],
  gap = COALESCE_GAP_S,
  maxSpan = MAX_SPAN_S,
): Range[] {
  const text = words.filter(isText);
  const out: Range[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (
      last &&
      s.start - last.end < gap &&
      s.end - last.start <= maxSpan &&
      !text.some((w) => mid(w) > last.end && mid(w) < s.start)
    )
      last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Fillers, voice commands, the user's own cuts: likely speech. */
const LIKELY_SPEECH = new Set(["filler", "voice_cmd", "user"]);

/**
 * What one deliberate action brought back that is worth a request:
 * the wordless parts of `added`, coalesced, without short silences
 * (pieces: what was removed BEFORE the action, by reason), the likely
 * speech first.
 */
export function planSpans(added: readonly Range[], words: readonly DocWord[], pieces: readonly Piece[]): Range[] {
  const spans = coalesceSpans(wordlessSpans(added, words), words);
  const scored = spans.flatMap((r) => {
    const ghost = words.some((w) => isGhost(w) && mid(w) >= r.start && mid(w) <= r.end);
    const kind = gapKind(pieces, r.start, r.end);
    if (kind === "silence" && !ghost && r.end - r.start < SILENCE_MIN_S - 1e-3) return [];
    return [{ r, first: ghost || LIKELY_SPEECH.has(kind) ? 0 : 1 }];
  });
  return scored.sort((a, b) => a.first - b.first || a.r.start - b.r.start).map((x) => x.r);
}

const round = (t: number) => Math.round(t * 1000) / 1000;
const keyOf = (r: Range) => `${r.start.toFixed(3)}-${r.end.toFixed(3)}`;

export type SpanFillerDeps = {
  onMarks: (marks: SpanMark[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
};

/** The queue and the decisions of useSpanFill, without React (spanFill.test.ts). */
export class SpanFiller {
  private transcribe: ((start: number, end: number) => Promise<SpanResult>) | null = null;
  private prevKept: Range[] | null = null;
  private prevPieces: readonly Piece[] = [];
  private intent: number | null = null;
  private asked = new Set<string>();
  private queue: Range[] = [];
  private marks = new Map<string, SpanMark>();
  private running = false;
  private pause: unknown = null;
  private stopped = false;
  private autoCount = 0;
  private readonly d: Required<SpanFillerDeps>;

  constructor(deps: SpanFillerDeps) {
    this.d = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      ...deps,
    };
  }

  /** The request (null: none now; the queue waits). */
  setTranscribe(fn: ((start: number, end: number) => Promise<SpanResult>) | null): void {
    this.transcribe = fn;
    if (fn && this.queue.length) void this.pump();
  }

  /** The action that just committed was one deliberate edit of a clip. */
  note = (): void => {
    this.intent = this.d.now();
  };

  /** The clips (and the removed pieces, the words) as they are now. */
  update(segs: readonly EditorSeg[], pieces: readonly Piece[], words: readonly DocWord[]): void {
    const kept = keptRanges(segs);
    const prev = this.prevKept;
    const prevPieces = this.prevPieces;
    this.prevPieces = pieces;
    if (prev && sameRanges(prev, kept)) return; // words or labels changed, not the clips
    this.prevKept = kept;
    const intent = this.intent;
    this.intent = null;
    // the first clips of the session are the analysis' (or the last save's): nothing revealed
    if (!prev || intent === null || this.d.now() - intent > INTENT_MS) return;
    let queued = false;
    for (const span of planSpans(addedRanges(prev, kept), words, prevPieces)) {
      const key = keyOf(span);
      if (this.asked.has(key) || this.autoCount >= MAX_AUTO) continue;
      this.asked.add(key);
      this.autoCount++;
      this.enqueue(span);
      queued = true;
    }
    if (queued) void this.pump();
  }

  /** Ask again for a span whose request failed (its chip). */
  retry = (key: string): void => {
    const m = this.marks.get(key);
    if (!m || m.state !== "failed") return;
    this.enqueue({ start: m.start, end: m.end });
    void this.pump();
  };

  start(): void {
    this.stopped = false;
    if (this.queue.length) void this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.pause !== null) this.d.clearTimer(this.pause);
    this.pause = null;
  }

  private enqueue(span: Range) {
    const key = keyOf(span);
    if (!this.queue.some((q) => keyOf(q) === key)) this.queue.push(span);
    this.mark(key, { ...span, key, state: "busy" });
  }

  private mark(key: string, m: SpanMark | null) {
    if (m) this.marks.set(key, m);
    else this.marks.delete(key);
    this.d.onMarks([...this.marks.values()]);
  }

  private async pump(): Promise<void> {
    if (this.running || this.pause !== null || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const run = this.transcribe;
        if (!run) return;
        const span = this.queue[0];
        const key = keyOf(span);
        const res = await run(span.start, span.end).catch((): SpanResult => "error");
        if (typeof res === "object") {
          // not now (rate limit, busy): the span waits at the head, nothing failed
          this.pause = this.d.setTimer(() => {
            this.pause = null;
            void this.pump();
          }, res.later);
          return;
        }
        this.queue.shift();
        this.mark(key, res === "error" ? { ...span, key, state: "failed" } : null);
      }
    } finally {
      this.running = false;
    }
  }
}

export function useSpanFill({
  segs,
  pieces,
  words,
  ready,
  transcribe,
}: {
  segs: readonly EditorSeg[];
  /** What no clip plays, by reason (useCuts pieces). */
  pieces: readonly Piece[];
  words: readonly DocWord[];
  /** The doc is loaded and editable. */
  ready: boolean;
  transcribe: ((start: number, end: number) => Promise<SpanResult>) | null;
}): { spans: SpanMark[]; retry: (key: string) => void; note: () => void } {
  const [marks, setMarks] = useState<SpanMark[]>([]);
  const [filler] = useState(() => new SpanFiller({ onMarks: setMarks }));
  useEffect(() => {
    filler.setTranscribe(ready ? transcribe : null);
  }, [filler, ready, transcribe]);
  useEffect(() => {
    filler.start();
    return () => filler.stop();
  }, [filler]);
  useEffect(() => {
    if (!ready || !transcribe) return;
    filler.update(segs, pieces, words);
  }, [filler, segs, pieces, words, ready, transcribe]);
  const retry = useCallback((key: string) => filler.retry(key), [filler]);
  return { spans: marks, retry, note: filler.note };
}
