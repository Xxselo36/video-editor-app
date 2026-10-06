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
import { readChoice } from "@/features/editor/v2/flag";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";
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
  opts: { captionsV2?: boolean } = {},
): Promise<"started" | "not_in_review"> {
  return (await startRender(jobId, phrases, units, captionPreset, opts)).outcome;
}

/**
 * applyRender with the answer (UX11): the job as POST /render returned
 * it — `instant: true` and status done when a speculative render was
 * taken, `cost_seconds` the minutes this export recorded. job is null
 * for "not_in_review".
 */
export async function startRender(
  jobId: string,
  phrases: Phrase[],
  units: Subtitle[],
  captionPreset: string,
  opts: { captionsV2?: boolean; client?: "v2" } = {},
): Promise<{ outcome: "started" | "not_in_review"; job: JobStatus | null }> {
  // Word units with their source times, not one subtitle per sentence:
  // the burn highlights each word at its own time (UX2).
  const subtitles: Subtitle[] = phrasesToUnits(phrases, units);
  const r = await apiFetch(`/jobs/${jobId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subtitles,
      disabled_cuts: [],
      // This browser opted in to the v2 export captions (?captions=v2,
      // captions-ui/flag.ts); only CLEO_CAPTION_ENGINE=optin reads it
      // (the default v2 gives every eligible job v2 anyway; v1/off ignore it).
      ...(opts.captionsV2 ? { caption_engine: "v2" } : {}),
      // UX11: the v2 export sheet — only then the UX11 rules apply on the
      // server (fair use, caps, instant export); a v1 export is unchanged.
      ...(opts.client ? { client: opts.client } : {}),
    }),
  });
  if (r.status !== 409 && !r.ok) throw await apiError(r);
  let job: JobStatus | null = null;
  if (r.ok) {
    try {
      job = (await r.json()) as JobStatus;
    } catch {
      job = null;
    }
    track(
      "export_started",
      opts.client
        ? {
            caption_style: captionPreset,
            lines: phrases.length,
            instant: Boolean(job?.instant),
            reexport: (job?.renders_ok ?? 0) > 0,
          }
        : { caption_style: captionPreset, lines: phrases.length },
    );
  }
  // The Projects page (v2 opt-in, UX12) or the dashboard card — also for
  // an instant export (it shows up as finished there).
  if (readChoice()) {
    setExportHint(jobId);
    void import("@/features/jobs/jobsStore").then((m) => m.noteExporting(jobId));
  } else updateActiveJobV2(jobId, { phase: "rendering", note: undefined, noteCode: undefined });
  return { outcome: r.status === 409 ? "not_in_review" : "started", job };
}

/** The error screen's text for a render that didn't start: mapped, never
 *  the raw answer (tech.md T3). A 401 has opened the sign-in already
 *  (apiFetch). */
export function applyRenderErrorText(err: unknown, t: TFn): string {
  return describeError(err, t);
}
