import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import {
  getActiveJobs,
  removeActiveJob,
  subscribeActiveJobs,
  updateActiveJob as updateActiveJobV2,
  type ActiveJobV2,
} from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { FRIENDLY_EXPIRED_KEY, jobErrorText, tEn } from "@/lib/errors.legacy";
import { fetchFullJob, JobStatusPoller, type StatusPollResult } from "@/lib/jobStatus";
import { getLibrary, saveEntry, type LibraryEntry, type LibraryHookClip } from "@/lib/library";
import { notifyIfHidden } from "@/lib/notify";
import type { CardStatus } from "./types";

// Dashboard status poll: every 2 s, every 5 s after a minute unchanged.
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 5000;
const POLL_BACKOFF_AFTER_MS = 60_000;

/**
 * Live status for the dashboard cards: ONE GET /jobs/status for all of them per
 * tick (lib/jobStatus — 304 while nothing changed), with chained
 * timeouts so ticks never pile up behind a slow backend. Not polled:
 * uploading cards (no job yet), error cards and cards in review —
 * nothing changes there until the user acts. Review cards are checked
 * once when the dashboard opens, so an expired project or a render
 * started on another device still shows. Paused while the tab is
 * hidden; every 2 s, every 5 s after a minute without any change.
 *
 * Runs for the caller's lifetime and returns the cards' statuses; a
 * finished job moves to the library and `setRecent` shows it at once.
 * (Moved from PickerScreen in app/app/page.tsx, UX4.)
 */
export function useJobStatusPoller(setRecent: (recent: LibraryEntry[]) => void): Record<string, CardStatus> {
  const t = useT();
  const [jobStatuses, setJobStatuses] = useState<Record<string, CardStatus>>({});
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const poller = new JobStatusPoller();
    let cancelled = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastChange = Date.now();
    let checkReview = true;
    const polled = (j: ActiveJobV2) =>
      j.phase !== "uploading" && j.phase !== "reviewing" && !j.error;
    const polledIds = () => getActiveJobs().filter(polled).map((j) => j.jobId);
    let known = new Set(polledIds());

    const apply = async (cards: ActiveJobV2[], res: StatusPollResult) => {
      const missing = new Set(res.missing);
      const rows = new Map(res.rows.map((r) => [r.id, r]));
      const updates: typeof jobStatuses = {};
      for (const j of cards) {
        if (missing.has(j.jobId)) {
          // Server no longer knows the job (redeploy / expired).
          updateActiveJobV2(j.jobId, { error: tEn(FRIENDLY_EXPIRED_KEY) });
          continue;
        }
        const s = rows.get(j.jobId);
        if (!s) continue;
        updates[j.jobId] = {
          progress: s.progress,
          message: s.message,
          status: s.status,
          queuePosition: s.queue_position,
        };
        if (s.status === "awaiting_review" && (j.phase !== "reviewing" || (s.error && !j.note))) {
          updateActiveJobV2(j.jobId, {
            phase: "reviewing",
            note: s.error
              ? tEn("app.card.renderFailedNote")
              : undefined,
          });
        } else if (
          s.status === "processing" &&
          (j.phase === "reviewing" ||
            (j.phase === "analyzing" && s.message.toLowerCase().includes("render")))
        ) {
          // Rendering (a review card: started on another device / tab).
          updateActiveJobV2(j.jobId, { phase: "rendering" });
        } else if (s.status === "done") {
          // The status rows are minimal: the library entry needs the
          // outputs, captions and hook clips of the full job.
          const full = s.full ?? (await fetchFullJob(j.jobId));
          if (cancelled) return;
          if (!full) continue; // next tick retries
          try {
            const withOutputs = full as {
              outputs?: string[] | Record<string, string>;
              social_caption?: string;
              social_hashtags?: string[];
              hook_clips?: LibraryHookClip[];
            };
            const outputKeys = Array.isArray(withOutputs.outputs)
              ? withOutputs.outputs
              : withOutputs.outputs && typeof withOutputs.outputs === "object"
                ? Object.keys(withOutputs.outputs)
                : ["primary"];
            track("export_done", {
              outputs: outputKeys.length,
              hooks: withOutputs.hook_clips?.length ?? 0,
            });
            saveEntry({
              jobId: j.jobId,
              timestamp: Date.now(),
              presetId: j.presetId,
              presetIcon: j.presetIcon,
              presetLabel: j.presetLabel,
              filename: j.filename,
              outputs: outputKeys,
              hookClips: withOutputs.hook_clips ?? [],
              socialCaption: withOutputs.social_caption ?? "",
              socialHashtags: withOutputs.social_hashtags ?? [],
            });
            notifyIfHidden(tRef.current("app.notify.readyTitle"), j.filename);
          } catch {
            /* library save is non-fatal */
          }
          removeActiveJob(j.jobId);
          // Show the finished video right away under "Zuletzt".
          setRecent(getLibrary().slice(0, 3));
        } else if (s.status === "error") {
          updateActiveJobV2(j.jobId, {
            error: jobErrorText(s, tEn),
          });
        }
      }
      if (!cancelled && res.changed) setJobStatuses((prev) => ({ ...prev, ...updates }));
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (cancelled || document.hidden || polledIds().length === 0) return;
      const quiet = Date.now() - lastChange > POLL_BACKOFF_AFTER_MS;
      timer = setTimeout(() => void tick(), quiet ? POLL_SLOW_MS : POLL_FAST_MS);
    };

    const tick = async (): Promise<void> => {
      clearTimeout(timer);
      timer = undefined;
      if (cancelled || document.hidden) return;
      if (running) {
        again = true; // right after the request in flight
        return;
      }
      const cards = getActiveJobs().filter(
        (j) => polled(j) || (checkReview && j.phase === "reviewing" && !j.error),
      );
      checkReview = false;
      if (cards.length > 0) {
        running = true;
        try {
          const res = await poller.poll(cards.map((j) => j.jobId));
          if (res && !cancelled) {
            if (res.changed) lastChange = Date.now();
            await apply(cards, res);
          }
        } catch {
          /* offline / transient — next tick retries */
        } finally {
          running = false;
        }
      }
      if (again) {
        again = false;
        return tick();
      }
      schedule();
    };

    // A card joined the polled set (upload finished, render started):
    // its status right away, and quick ticks again.
    const unsubscribe = subscribeActiveJobs(() => {
      const ids = polledIds();
      const added = ids.some((id) => !known.has(id));
      known = new Set(ids);
      if (added) {
        lastChange = Date.now();
        void tick();
      }
    });
    // Hidden tab: no requests. Back: fresh status now, quick ticks again.
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      lastChange = Date.now();
      void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Runs for the dashboard's lifetime; reads the cards on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return jobStatuses;
}
