"use client";
/**
 * Fertigstellen on the Vorschau (plan D12): the server renders the edit
 * as stored (POST /render, source "stored"), without the editor. The
 * steps are finish.ts runFinish:
 *
 *   saving     the editor's last saves for this job are still out: the
 *              render waits for them (8 s at most); still out then →
 *              nothing renders (never an older cut) and the error says
 *              to try again in a moment, until they settle (`settled`)
 *   checking   right before every POST: changes this device keeps that
 *              the server doesn't have (the editor's copies, `unsaved`)
 *              → nothing renders; the Vorschau offers Feinschliff for
 *              them
 *   starting   POST /render is out
 *   then       200: the answered job is shown (finishing, or done at
 *              once for an instant export); 409 (already exporting or
 *              finished): the job as it is now; 422 needs_editor
 *              (sentence edits without an edit document: only the
 *              editor's export has them) → `needsEditor`; a refusal
 *              (429 caps, 503 busy) or offline: the error
 *
 * From the tap until the render runs or didn't start, `busy`: the
 * Vorschau offers no Feinschliff meanwhile. Leaving the page before the
 * POST went out cancels it: nothing starts rendering behind the user's
 * back (e.g. while Feinschliff is open).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { ApiError, apiFetch } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { hasPendingSaves, waitForSaves } from "@/lib/pendingSaves";
import { readCaptionsV2 } from "@/features/captions-ui/flag";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";
import { runFinish, type FinishStep } from "./finish";
import { finishJob } from "./projectApi";

export type Finish = {
  /** Waiting for this job's last saves ("Änderungen werden gespeichert…"). */
  saving: boolean;
  /** POST /render is out: the button can show the working state. */
  starting: boolean;
  /** Tapped, until the render runs or didn't start (saves, this
   *  device's copies, the POST). */
  busy: boolean;
  /** The server can't render the edit as stored (422 needs_editor):
   *  its export is made in Feinschliff. */
  needsEditor: boolean;
  /** Why it didn't start, worded (preview-error); null otherwise. */
  error: string | null;
  /** Fertigstellen (a second call while one runs does nothing). */
  finish: () => void;
};

/** `unsaved`: changes on this device the server doesn't have (finish.ts
 *  unsavedOnDevice; null: can't tell now), asked right before each POST.
 *  `settled`: useJobPoll's, grows when this job's pending saves settled. */
export function useFinish(
  job: JobStatus,
  setJob: (job: JobStatus) => void,
  unsaved: () => Promise<boolean | null>,
  settled: number,
): Finish {
  const t = useT();
  const id = job.id;
  const [phase, setPhase] = useState<"idle" | FinishStep>("idle");
  // `whileSaving`: the saves it waited for were still out (the `settled` of then).
  const [error, setError] = useState<{ text: string; whileSaving?: number } | null>(null);
  const [needsEditor, setNeedsEditor] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const unsavedRef = useRef(unsaved);
  const settledRef = useRef(settled);
  useEffect(() => {
    unsavedRef.current = unsaved;
    settledRef.current = settled;
  });
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
        const run = await runFinish({
          pending: () => hasPendingSaves(id),
          waitForSaves: (ms) => waitForSaves(id, ms),
          unsaved: () => unsavedRef.current(),
          live: () => mounted.current,
          step: setPhase,
          post: () =>
            finishJob(id, {
              client: "v2",
              source: "stored",
              disabled_cuts: [],
              // This browser opted in to the v2 export captions (captions-ui/flag).
              ...(readCaptionsV2() ? { caption_engine: "v2" } : {}),
            }),
        });
        if (run.kind === "stillSaving") setError({ text: t("app.preview.stillSaving"), whileSaving: settledRef.current });
        else if (run.kind === "unknown") setError({ text: t("app.notice.loadFailed") });
        // (unsaved: the Vorschau says so and offers Feinschliff)
        if (run.kind !== "posted") return;
        const { outcome, job: answer } = run.answer;
        // A queued run of it is the export, here and on Projects (also
        // for an instant export: it shows up as finished there).
        setExportHint(id);
        void import("@/features/jobs/jobsStore").then((m) => m.noteExporting(id));
        if (outcome === "started") track("export_started", { from: "preview", instant: Boolean(answer?.instant) });
        const now = answer ?? (await currentJob(id));
        if (now) setJob(now);
        else setError({ text: t("app.notice.loadFailed") });
      } catch (e) {
        if (e instanceof ApiError && e.code === "needs_editor") setNeedsEditor(true);
        else setError({ text: describeError(e, t) });
      } finally {
        busy.current = false;
        setPhase("idle");
      }
    })();
  }, [id, setJob, t]);

  // "Still being saved" holds until those saves settle: then it is no longer so.
  const stale = error?.whileSaving !== undefined && settled !== error.whileSaving;
  return {
    saving: phase === "saving",
    starting: phase === "starting",
    busy: phase !== "idle",
    needsEditor,
    error: error && !stale ? error.text : null,
    finish,
  };
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
