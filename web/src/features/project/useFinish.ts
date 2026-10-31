"use client";
/**
 * Fertigstellen on the Vorschau (plan D12): the server renders the edit
 * as stored (POST /render, source "stored"), without the editor.
 *
 *   saving     the editor's last saves for this job are still out: the
 *              render waits for them (8 s at most); still out then →
 *              nothing renders (never an older cut) and the error says
 *              to try again in a moment; a timeline save that failed
 *              (its changes stay on this device) → nothing renders
 *              either: the Vorschau offers Feinschliff for them
 *   starting   POST /render is out
 *   then       200: the answered job is shown (finishing, or done at
 *              once for an instant export); 409 (already exporting or
 *              finished): the job as it is now; a refusal (429 caps,
 *              503 busy) or offline: the error
 *
 * Leaving the page before the POST went out cancels it: nothing starts
 * rendering behind the user's back (e.g. while Feinschliff is open).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { apiFetch } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { hasPendingSaves, waitForSaves } from "@/lib/pendingSaves";
import { readCaptionsV2 } from "@/features/captions-ui/flag";
import { hasUnsavedTimeline } from "@/features/editor/session/unsavedKey";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";
import { finishJob } from "./projectApi";

const SAVES_WAIT_MS = 8000;

export type Finish = {
  /** Waiting for this job's last saves ("Änderungen werden gespeichert…"). */
  saving: boolean;
  /** POST /render is out: the button can show the working state. */
  starting: boolean;
  /** Why it didn't start, worded (preview-error); null otherwise. */
  error: string | null;
  /** Fertigstellen (a second call while one runs does nothing). */
  finish: () => void;
};

export function useFinish(job: JobStatus, setJob: (job: JobStatus) => void): Finish {
  const t = useT();
  const id = job.id;
  const [phase, setPhase] = useState<"idle" | "saving" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    void (async () => {
      try {
        if (hasPendingSaves(id)) {
          setPhase("saving");
          if (!(await waitForSaves(id, SAVES_WAIT_MS))) {
            setError(t("app.preview.stillSaving"));
            return;
          }
          // A failed timeline save: never an older cut (see above).
          if (hasUnsavedTimeline(id)) return;
        }
        if (!mounted.current) return;
        setPhase("starting");
        const { outcome, job: answer } = await finishJob(id, {
          client: "v2",
          source: "stored",
          disabled_cuts: [],
          // This browser opted in to the v2 export captions (captions-ui/flag).
          ...(readCaptionsV2() ? { caption_engine: "v2" } : {}),
        });
        // A queued run of it is the export, here and on Projects (also
        // for an instant export: it shows up as finished there).
        setExportHint(id);
        void import("@/features/jobs/jobsStore").then((m) => m.noteExporting(id));
        if (outcome === "started") track("export_started", { from: "preview", instant: Boolean(answer?.instant) });
        const now = answer ?? (await currentJob(id));
        if (now) setJob(now);
        else setError(t("app.notice.loadFailed"));
      } catch (e) {
        setError(describeError(e, t));
      } finally {
        busy.current = false;
        setPhase("idle");
      }
    })();
  }, [id, setJob, t]);

  return { saving: phase === "saving", starting: phase === "starting", error, finish };
}

/** GET /jobs/{id} once; null when it can't be read now. */
async function currentJob(jobId: string): Promise<JobStatus | null> {
  try {
    const r = await apiFetch(`/jobs/${jobId}`);
    return r.ok ? ((await r.json()) as JobStatus) : null;
  } catch {
    return null;
  }
}
