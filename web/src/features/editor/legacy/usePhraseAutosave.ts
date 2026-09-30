// Moved verbatim from Home in app/app/page.tsx (UX4).
import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { trackSave } from "@/lib/pendingSaves";
import type { Phrase } from "./buildPhrases";

/**
 * Transcript edits are saved (debounced) so they survive leaving the
 * job; GET /subtitles hands them back as `phrases` on re-entry.
 * schedulePhraseSave debounces a job's edited transcript (800 ms);
 * flushPhraseSave sends a pending one now (also when the page hides).
 */
export function usePhraseAutosave(): {
  flushPhraseSave: (unloading?: boolean) => void;
  schedulePhraseSave: (jobId: string, list: Phrase[]) => void;
} {
  const phraseRevRef = useRef(0);
  const phraseSaveRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    jobId: string;
    phrases: Phrase[];
  } | null>(null);
  const sendPhrases = (jobId: string, list: Phrase[], unloading = false) => {
    // Increasing revision: the server ignores a save older than the
    // one it has, so out-of-order requests can't restore stale text.
    phraseRevRef.current = Math.max(phraseRevRef.current + 1, Date.now());
    const body = JSON.stringify({ phrases: list, rev: phraseRevRef.current });
    const p = apiFetch(`/jobs/${jobId}/phrases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: unloading && body.length < 60_000,
      unloading,
    }).catch(() => {});
    trackSave(jobId, p);
    return p;
  };
  const flushPhraseSave = (unloading = false) => {
    const pend = phraseSaveRef.current;
    if (!pend) return;
    if (pend.timer) clearTimeout(pend.timer);
    phraseSaveRef.current = null;
    void sendPhrases(pend.jobId, pend.phrases, unloading);
  };
  const schedulePhraseSave = (jobId: string, list: Phrase[]) => {
    const prev = phraseSaveRef.current;
    if (prev?.timer) clearTimeout(prev.timer);
    if (prev && prev.jobId !== jobId) void sendPhrases(prev.jobId, prev.phrases);
    phraseSaveRef.current = {
      jobId,
      phrases: list,
      timer: setTimeout(() => flushPhraseSave(), 800),
    };
  };
  useEffect(() => {
    const onHide = () => flushPhraseSave(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { flushPhraseSave, schedulePhraseSave };
}
