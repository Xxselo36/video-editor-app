// Moved from Home in app/app/page.tsx (UX4).
import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { trackSave } from "@/lib/pendingSaves";
import type { Phrase } from "./buildPhrases";

/**
 * The POST of a phrase save. `keepalive` only while the page unloads,
 * only under 60 000 bytes, and only when allowed: the browser's 64 KiB
 * keepalive budget is shared by every request of the unload, and in the
 * v2 editor with an edit doc the doc's own keepalive PATCH carries the
 * edit (UX8) — the phrase copy must not crowd it out.
 */
export function phraseSaveInit(list: Phrase[], rev: number, unloading: boolean, allowKeepalive = true) {
  const body = JSON.stringify({ phrases: list, rev });
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: unloading && allowKeepalive && body.length < 60_000,
    unloading,
  };
}

/**
 * Transcript edits are saved (debounced) so they survive leaving the
 * job; GET /subtitles hands them back as `phrases` on re-entry.
 * schedulePhraseSave debounces a job's edited transcript (800 ms);
 * flushPhraseSave sends a pending one now (also when the page hides).
 */
export function usePhraseAutosave(): {
  flushPhraseSave: (unloading?: boolean) => void;
  schedulePhraseSave: (jobId: string, list: Phrase[], opts?: { keepalive?: boolean }) => void;
} {
  const phraseRevRef = useRef(0);
  const phraseSaveRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    jobId: string;
    phrases: Phrase[];
    keepalive: boolean;
  } | null>(null);
  const sendPhrases = (jobId: string, list: Phrase[], unloading = false, allowKeepalive = true) => {
    // Increasing revision: the server ignores a save older than the
    // one it has, so out-of-order requests can't restore stale text.
    phraseRevRef.current = Math.max(phraseRevRef.current + 1, Date.now());
    const p = apiFetch(
      `/jobs/${jobId}/phrases`,
      phraseSaveInit(list, phraseRevRef.current, unloading, allowKeepalive),
    ).catch(() => {});
    trackSave(jobId, p);
    return p;
  };
  const flushPhraseSave = (unloading = false) => {
    const pend = phraseSaveRef.current;
    if (!pend) return;
    if (pend.timer) clearTimeout(pend.timer);
    phraseSaveRef.current = null;
    void sendPhrases(pend.jobId, pend.phrases, unloading, pend.keepalive);
  };
  const schedulePhraseSave = (jobId: string, list: Phrase[], opts: { keepalive?: boolean } = {}) => {
    const prev = phraseSaveRef.current;
    if (prev?.timer) clearTimeout(prev.timer);
    if (prev && prev.jobId !== jobId) void sendPhrases(prev.jobId, prev.phrases, false, prev.keepalive);
    phraseSaveRef.current = {
      jobId,
      phrases: list,
      keepalive: opts.keepalive !== false,
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
