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
  cutWords,
  labelRemoved,
  restoreKind,
  restorePieces,
  restoreRange,
  restoreWord,
  type CutKind,
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
  /** Cut doc words first..last out of the video. False: nothing changed. */
  cutWords: (words: readonly DocWord[], first: number, last: number) => boolean;
  /** Bring ranges back (a chip, a seam, a selection). */
  restore: (ranges: readonly Range[]) => boolean;
  /** Bring one struck word back. */
  restoreWord: (w: Pick<DocWord, "start" | "end">) => boolean;
  /** Bulk restore: one kind, or every AI cut. */
  restoreKind: (kind: CutKind | "ai") => boolean;
};

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
  words: readonly DocWord[];
  /** removedOf(segs, duration), memoised by the shell. */
  removed: Range[];
  /** One timeline undo step (the shell's history.commit). */
  commit: (next: EditorSeg[]) => void;
}): CutsApi {
  const { jobId, segs, duration, cutRanges, words, removed, commit } = opts;
  const peaks = usePeaks(jobId);
  const ai = useMemo(() => aiCutsOf(cutRanges, words), [cutRanges, words]);
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
    cutWords: (ws, first, last) =>
      apply(cutWords(segs, ws, first, last, duration, peaks), "words_cut", { n: last - first + 1, snapped: peaks ? 1 : 0 }),
    restore: (ranges) => {
      let out = segs;
      for (const r of ranges) out = restoreRange(out, r.start, r.end, duration);
      return apply(out, "cuts_restored", { what: "range", n: ranges.length });
    },
    restoreWord: (w) => apply(restoreWord(segs, w, duration), "cuts_restored", { what: "word", n: 1 }),
    restoreKind: (kind) =>
      apply(
        kind === "ai" ? restoreKind(segs, pieces, "ai", duration) : restorePieces(segs, pieces, (p) => p.kind === kind, duration),
        "bulk_restore",
        { kind },
      ),
  };
}
