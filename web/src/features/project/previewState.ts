/**
 * The Vorschau's states (plan D11, §5.2): what /app/p/[jobId] shows for
 * the job as GET /jobs/{id} answers it.
 *
 *   processing   the analysis runs (pending / processing): ProcessingView
 *   finishing    the export runs (Fertigstellen): the working button
 *   ready        in review, never exported: Fertigstellen, Feinschliff
 *   edited       in review again after an export (reopened): ready, and
 *                the previous version stays downloadable
 *   done         exported: Video sichern / Herunterladen
 *   failed       the analysis failed (error) or was cancelled
 *
 * A failed export is no state of its own: the job is back in review
 * (ready or edited) with the render's code (renderFailed).
 */
import { hasExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";

export type PreviewState = "processing" | "finishing" | "ready" | "edited" | "done" | "failed";

/** A running job is an export (not the analysis): its stage says so, or
 *  (waiting for a render slot, "queued") it has an export already or
 *  was in review before (`exportHint`, features/jobs/localJobs). */
export function isExport(job: Pick<JobStatus, "stage" | "message" | "has_output">, exportHint: boolean): boolean {
  if (job.stage?.startsWith("render.")) return true;
  if (job.stage?.startsWith("analyze.")) return false;
  return exportHint || Boolean(job.has_output) || /render/i.test(job.message ?? "");
}

/** `exportHint`: this tab's hint unless given (the unit tests pass it). */
export function previewStateOf(
  job: Pick<JobStatus, "id" | "status" | "stage" | "message" | "has_output">,
  exportHint = hasExportHint(job.id),
): PreviewState {
  switch (job.status) {
    case "pending":
    case "processing":
      return isExport(job, exportHint) ? "finishing" : "processing";
    case "awaiting_review":
      return job.has_output ? "edited" : "ready";
    case "done":
      return "done";
    default:
      return "failed";
  }
}

/** The code of the export that failed (render_failed, render_timeout,
 *  render_unavailable, …): back in review with an error. null when the
 *  last export didn't fail or the job isn't in review. */
export function renderFailed(job: Pick<JobStatus, "status" | "error" | "error_code">): string | null {
  if (job.status !== "awaiting_review") return null;
  // A job from before UX5 carries the text only.
  return job.error_code || (job.error ? "render_failed" : null);
}
