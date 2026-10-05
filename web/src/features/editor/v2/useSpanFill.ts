"use client";
/**
 * Text for footage that comes back without any (backlog #20): when a
 * restore, an extension or a trim brings a span of ≥ MIN_GAP_S into the
 * clips that has no words in the doc — the analysis cut it (Whisper took
 * it for silence) or its only words are a hidden silence hallucination —
 * the editor quietly asks the server to transcribe just that span (POST
 * /jobs/{id}/transcribe-span, useDocSession.transcribeSpan). Meanwhile
 * the Text tab shows "Adding text…" there; the words then appear and the
 * captions follow. A failure leaves the span without captions and a
 * small retry chip. One request at a time; a span is asked for once per
 * session (the server answers a repeat from the doc anyway).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocWord } from "@/features/editor/state/doc";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { SpanResult } from "./useDocSession";

/** Shortest span without words worth a transcription (s). */
export const MIN_GAP_S = 0.5;
/** Longest span per request (the server's cap is 60 s). */
export const MAX_SPAN_S = 55;
/** Automatic requests per editor session (a video with no speech at all…). */
export const MAX_AUTO = 40;

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

/** A word that counts as text there: not a hidden silence hallucination. */
const isText = (w: DocWord) => !(w.hidden && w.nospeech);

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

const round = (t: number) => Math.round(t * 1000) / 1000;
const keyOf = (r: Range) => `${r.start.toFixed(3)}-${r.end.toFixed(3)}`;

export function useSpanFill({
  segs,
  words,
  ready,
  transcribe,
}: {
  segs: readonly EditorSeg[];
  words: readonly DocWord[];
  /** The doc is loaded and editable. */
  ready: boolean;
  transcribe: ((start: number, end: number) => Promise<SpanResult>) | null;
}): { spans: SpanMark[]; retry: (key: string) => void } {
  const [marks, setMarks] = useState<SpanMark[]>([]);
  const prevKept = useRef<Range[] | null>(null);
  const asked = useRef(new Set<string>());
  const queue = useRef<Range[]>([]);
  const running = useRef(false);
  const autoCount = useRef(0);
  const transcribeRef = useRef(transcribe);
  const wordsRef = useRef(words);
  useEffect(() => {
    transcribeRef.current = transcribe;
    wordsRef.current = words;
  });

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        const span = next;
        const key = keyOf(span);
        const run = transcribeRef.current;
        if (!run) break;
        setMarks((m) => [...m.filter((x) => x.key !== key), { ...span, key, state: "busy" }]);
        const res = await run(span.start, span.end).catch((): SpanResult => "error");
        setMarks((m) =>
          res === "error" ? m.map((x) => (x.key === key ? { ...x, state: "failed" } : x)) : m.filter((x) => x.key !== key),
        );
      }
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready || !transcribe) return;
    const kept = keptRanges(segs);
    const prev = prevKept.current;
    prevKept.current = kept;
    // the first clips of the session are the analysis' (or the last save's): nothing revealed
    if (!prev) return;
    const added = addedRanges(prev, kept);
    if (!added.length) return;
    let queued = false;
    for (const span of wordlessSpans(added, wordsRef.current)) {
      const key = keyOf(span);
      if (asked.current.has(key) || autoCount.current >= MAX_AUTO) continue;
      asked.current.add(key);
      autoCount.current++;
      queue.current.push(span);
      queued = true;
    }
    if (queued) void pump();
  }, [segs, ready, transcribe, pump]);

  const retry = useCallback(
    (key: string) => {
      const m = marks.find((x) => x.key === key && x.state === "failed");
      if (!m) return;
      queue.current.push({ start: m.start, end: m.end });
      void pump();
    },
    [marks, pump],
  );

  return { spans: marks, retry };
}
