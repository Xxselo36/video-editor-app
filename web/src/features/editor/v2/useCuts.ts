"use client";
/**
 * Cuts in the text and the AI's cuts, for the v2 shell (UX10): what is
 * removed and why (state/cuts.ts pieces), and the cut / restore ops as
 * timeline commits — one undo step each, in the one undo order of text
 * and timeline (EditOrder). The export reads the same clip list
 * (/edit-segments), so what the preview skips is what the export cuts.
 *
 * Peaks (GET /jobs/{id}/peaks, ≈ 6 KB a minute, the body from the API
 * itself) load with the editor for
 * clean cut edges; without them (an old job, an error) edges aren't
 * snapped.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { mediaUrl, useMediaReady } from "@/lib/api";
import { track, type AnalyticsEvent } from "@/lib/analytics";
import {
  aiCutsOf,
  cutRange,
  labelRemoved,
  planCutWords,
  restoreKind,
  restorePieces,
  restoreRange,
  restoreWord,
  restoreWords,
  splitSuggestions,
  wordSafeEdge,
  type CutKind,
  type CutRefusal,
  type Piece,
  type Range,
} from "@/features/editor/state/cuts";
import type { DocWord } from "@/features/editor/state/doc";
import { peaksFromBytes } from "@/features/editor/state/snap";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { CutRange } from "@/features/jobs/types";
import { removedRanges } from "./model";

export type CutsApi = {
  /** What no clip plays, by reason (sorted). */
  pieces: Piece[];
  /** Source ranges no clip plays (none while the clips aren't known yet). */
  removed: Range[];
  /** Cut doc words first..last out of the video: null when cut, else why
   *  nothing changed (the Text tab says so, F9). */
  cutWords: (words: readonly DocWord[], first: number, last: number) => CutRefusal | null;
  /** Bring ranges back (a chip, a seam, a selection). */
  restore: (ranges: readonly Range[]) => boolean;
  /** Bring a struck word (or the struck words from w.start to w.end) back;
   *  `span`: their doc indices when the caller knows them. */
  restoreWord: (w: Pick<DocWord, "start" | "end">, span?: [number, number]) => boolean;
  /** Bulk restore: one kind, or every AI cut. */
  restoreKind: (kind: CutKind | "ai") => boolean;
  /** Where a trim edge released at source time t goes: into the nearest
   *  gap between words within `radius` s (state/cuts.ts wordSafeEdge). */
  safeEdge: (t: number, radius: number) => number;
  /** The analysis' suggested cuts still playing (job.cut_suggestions: a
   *  long "Cleo cut" without "Cleo start"; state/cuts.ts splitSuggestions). */
  suggestions: Range[];
  /** Cut a suggestion (one undo step): false when nothing changed. */
  takeSuggestion: (r: Range) => boolean;
};

const NO_RANGES: Range[] = [];

/** Doc indices of the words a restore of [w.start, w.end] means (the
 *  word itself, or a selection's first word's start to its last word's
 *  end): the first word starting at w.start and the first one from there
 *  that ends at w.end (F12: not a later word that happens to end at the
 *  same time); null when they aren't doc words. */
export function wordSpan(words: readonly DocWord[], w: Pick<DocWord, "start" | "end">): [number, number] | null {
  const first = words.findIndex((x) => Math.abs(x.start - w.start) < 1e-6);
  if (first < 0) return null;
  for (let i = first; i < words.length; i++) if (Math.abs(words[i].end - w.end) < 1e-6) return [first, i];
  return null;
}

/** The removed source ranges of a clip list; none while it's empty
 *  (not seeded yet: nothing is known to be removed). */
export function removedOf(segs: EditorSeg[], duration: number): Range[] {
  return segs.some((s) => !s.disabled && s.end > s.start) ? removedRanges(segs, duration) : [];
}

function usePeaks(jobId: string): Uint8Array | null {
  const ready = useMediaReady();
  const [peaks, setPeaks] = useState<{ job: string; data: Uint8Array } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    // The API sends the body itself (also for R2 jobs). A redirect is not
    // followed: a cross-origin fetch that follows one to R2 is refused by
    // the bucket's CORS (Origin: null) — no peaks then, never a CORS error.
    void fetch(mediaUrl(jobId, "peaks"), { redirect: "manual" })
      .then((r) => (r.ok && r.type !== "opaqueredirect" ? r.arrayBuffer() : null))
      .then((buf) => {
        if (live && buf && buf.byteLength) setPeaks({ job: jobId, data: peaksFromBytes(buf) });
      })
      .catch(() => {
        /* no peaks: edges aren't snapped */
      });
    return () => {
      live = false;
    };
  }, [jobId, ready]);
  return peaks?.job === jobId ? peaks.data : null;
}

export function useCuts(opts: {
  jobId: string;
  segs: EditorSeg[];
  duration: number;
  cutRanges: CutRange[];
  /** job.cut_suggestions: not cut by the analysis, offered (none on old jobs). */
  cutSuggestions?: CutRange[];
  words: readonly DocWord[];
  /** removedOf(segs, duration), memoised by the shell. */
  removed: Range[];
  /** One timeline undo step (the shell's history.commit). */
  commit: (next: EditorSeg[]) => void;
}): CutsApi {
  const { jobId, segs, duration, cutRanges, cutSuggestions, words, removed, commit } = opts;
  const peaks = usePeaks(jobId);
  const suggested = useMemo(() => splitSuggestions(cutSuggestions, removed), [cutSuggestions, removed]);
  const analysisCuts = useMemo(() => aiCutsOf(cutRanges, words), [cutRanges, words]);
  // a taken suggestion is a Cleo-cut take like the analysis' own
  const ai = useMemo(
    () =>
      suggested.taken.length
        ? [...analysisCuts, ...suggested.taken].sort((a, b) => a.start - b.start)
        : analysisCuts,
    [analysisCuts, suggested.taken],
  );
  const pieces = useMemo(() => labelRemoved(removed, ai), [removed, ai]);
  const apply = useCallback(
    (next: EditorSeg[], event: AnalyticsEvent, props: Record<string, string | number>) => {
      if (next === segs) return false;
      commit(next);
      track(event, props);
      return true;
    },
    [segs, commit],
  );
  return {
    pieces,
    removed,
    cutWords: (ws, first, last) => {
      const r = planCutWords(segs, ws, first, last, duration, peaks);
      if (r.refusal) return r.refusal;
      apply(r.segs, "words_cut", { n: last - first + 1, snapped: peaks ? 1 : 0 });
      return null;
    },
    restore: (ranges) => {
      let out = segs;
      for (const r of ranges) out = restoreRange(out, r.start, r.end, duration);
      return apply(out, "cuts_restored", { what: "range", n: ranges.length });
    },
    restoreWord: (w, given) => {
      // the doc words: the same edges cutting them takes (useCuts peaks)
      const span =
        given && words[given[0]]?.start === w.start && words[given[1]]?.end === w.end ? given : wordSpan(words, w);
      const next = span
        ? restoreWords(segs, words, span[0], span[1], duration, peaks)
        : restoreWord(segs, w, duration);
      return apply(next, "cuts_restored", { what: "word", n: span ? span[1] - span[0] + 1 : 1 });
    },
    restoreKind: (kind) =>
      apply(
        kind === "ai" ? restoreKind(segs, pieces, "ai", duration) : restorePieces(segs, pieces, (p) => p.kind === kind, duration),
        "bulk_restore",
        { kind },
      ),
    safeEdge: (t, radius) => wordSafeEdge(t, words, radius, peaks),
    // none while the clips aren't known yet (a taken one would flash)
    suggestions: segs.some((s) => !s.disabled && s.end > s.start) ? suggested.open : NO_RANGES,
    // its edges are on the audio already (the analysis snapped them)
    takeSuggestion: (r) => apply(cutRange(segs, r.start, r.end, duration), "words_cut", { what: "suggestion" }),
  };
}
