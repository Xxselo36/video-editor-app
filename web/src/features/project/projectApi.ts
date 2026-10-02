/**
 * UX11 calls of a finished project: edit it again, save the post text,
 * answer the survey. Errors come back as codes (lib/errors).
 */
import { apiError, apiFetch } from "@/lib/api";
import { track } from "@/lib/analytics";
import type { JobStatus } from "@/features/jobs/types";

/** POST /jobs/{id}/reopen: done → in review; the export stays
 *  downloadable until the next one. Throws ApiError (409 busy /
 *  media_unavailable, 410 media_expired). */
export async function reopenJob(jobId: string, from: "done_view" | "export_sheet"): Promise<JobStatus> {
  const r = await apiFetch(`/jobs/${jobId}/reopen`, { method: "POST" });
  if (!r.ok) throw await apiError(r);
  const job = (await r.json()) as JobStatus;
  track("reedit_started", { from, renders: job.renders_ok ?? 0 });
  return job;
}

/** POST /jobs/{id}/social-caption (save only, no regenerate). */
export async function saveSocialCaption(jobId: string, text: string): Promise<string> {
  const r = await apiFetch(`/jobs/${jobId}/social-caption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw await apiError(r);
  return ((await r.json()) as { text: string }).text;
}

/** POST /feedback {kind: "post_export"}: best effort. */
export function sendSurvey(jobId: string, answer: "yes" | "no", text?: string): void {
  track("post_export_survey", { answer, has_text: Boolean(text) });
  void apiFetch("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "post_export", job_id: jobId, answer, ...(text ? { text } : {}) }),
  }).catch(() => {});
}
