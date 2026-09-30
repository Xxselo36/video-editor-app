/**
 * Export the edit (moved from Home's onApplyRender in app/app/page.tsx,
 * UX4): POST /jobs/{id}/render with the edited transcript, then the job's
 * dashboard card shows the export.
 */
import type { TFn } from "@/i18n";
import { updateActiveJob as updateActiveJobV2 } from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { apiError, apiFetch } from "@/lib/api";
import { describeError } from "@/lib/errors";
import type { Phrase, Subtitle } from "./buildPhrases";
import { phrasesToUnits } from "./phraseUnits";

/**
 * "not_in_review" (409): the job isn't in review any more — already
 * exporting (a double click, another tab) or finished. Throws when the
 * render can't be started.
 */
export async function applyRender(
  jobId: string,
  phrases: Phrase[],
  units: Subtitle[],
  captionPreset: string,
): Promise<"started" | "not_in_review"> {
  // Word units with their source times, not one subtitle per sentence:
  // the burn highlights each word at its own time (UX2).
  const subtitles: Subtitle[] = phrasesToUnits(phrases, units);
  const r = await apiFetch(`/jobs/${jobId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subtitles,
      disabled_cuts: [],
    }),
  });
  if (r.status !== 409 && !r.ok) throw await apiError(r);
  if (r.ok) track("export_started", { caption_style: captionPreset, lines: phrases.length });
  updateActiveJobV2(jobId, { phase: "rendering", note: undefined });
  return r.status === 409 ? "not_in_review" : "started";
}

/** The error screen's text for a render that didn't start: mapped, never
 *  the raw answer (tech.md T3). A 401 has opened the sign-in already
 *  (apiFetch). */
export function applyRenderErrorText(err: unknown, t: TFn): string {
  return describeError(err, t);
}
