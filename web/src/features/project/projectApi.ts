/**
 * Calls of the project page: Fertigstellen (the Vorschau), and of a
 * finished project (UX11): edit it again, save the post text, answer the
 * survey. Errors come back as codes (lib/errors).
 */
import { apiError, apiFetch } from "@/lib/api";
import { track } from "@/lib/analytics";
import type { JobStatus } from "@/features/jobs/types";

/** POST /render from the Vorschau: the server renders the edit as stored
 *  (its timeline and caption doc), no captions sent along. */
export type FinishBody = { client: "v2"; source: "stored"; disabled_cuts: []; caption_engine?: "v2" };

/** POST /jobs/{id}/render without the editor (plan D12). "not_in_review"
 *  (409): already exporting (another tab) or finished. job: the answer
 *  (`instant: true` and done when a speculative render was taken), null
 *  for "not_in_review" or an answer that can't be read. Throws ApiError
 *  for a refusal (429 caps, 503 busy, 400 from a server before PR2) and
 *  the browser's error offline. */
export async function finishJob(
  jobId: string,
  body: FinishBody,
): Promise<{ outcome: "started" | "not_in_review"; job: JobStatus | null }> {
  const r = await apiFetch(`/jobs/${jobId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) return { outcome: "not_in_review", job: null };
  if (!r.ok) throw await apiError(r);
  const job = (await r.json().catch(() => null)) as JobStatus | null;
  return { outcome: "started", job };
}

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
