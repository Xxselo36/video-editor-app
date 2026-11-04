/**
 * The analysis as ProcessingView's checklist (UX12, plan D11): the steps
 * and the job stages (backend/errors.py STAGES) each one covers. A job
 * shows only the steps it goes through: "Nur Untertitel" (no_cuts)
 * cuts nothing, "Ohne Untertitel" (captions_off) writes no captions.
 */
import type { MessageKey } from "@/i18n/messages/en";
import type { JobStatus } from "@/features/jobs/types";

export type Step = { id: string; key: MessageKey; stages: string[] };

/** Uploaded ✓ → Listening → Cutting → Captions → Ready. */
const ANALYSIS_STEPS: Step[] = [
  { id: "uploaded", key: "app.processing.step.uploaded", stages: [] },
  { id: "listening", key: "app.processing.step.listening", stages: ["queued", "analyze.normalize", "analyze.smartcam", "analyze.transcribe"] },
  { id: "cutting", key: "app.processing.step.cutting", stages: ["analyze.cleanup", "analyze.cuts"] },
  { id: "captions", key: "app.processing.step.captions", stages: ["analyze.captions"] },
  { id: "ready", key: "app.processing.step.ready", stages: ["analyze.done"] },
];

/** The analysis steps of this job. A skipped step's stages still run
 *  (the transcript is polished, the preview built): they count for the
 *  step before it, so the list never steps back. */
export function stepsFor(job: Pick<JobStatus, "no_cuts" | "captions_off">): Step[] {
  const skipped = (id: string) => (id === "cutting" && job.no_cuts) || (id === "captions" && job.captions_off);
  const steps: Step[] = [];
  for (const s of ANALYSIS_STEPS) {
    if (!skipped(s.id)) steps.push(s);
    else {
      const prev = steps[steps.length - 1];
      steps[steps.length - 1] = { ...prev, stages: [...prev.stages, ...s.stages] };
    }
  }
  return steps;
}
