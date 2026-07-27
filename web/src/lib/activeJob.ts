/**
 * Tracks the single currently-in-flight job across navigations.
 *
 * The backend runs jobs independently of the browser — once it hands
 * back a jobId, processing continues on Railway even if the tab
 * closes. This helper persists just enough state (jobId + presentation
 * metadata) so the /app page can re-poll and drop the user back into
 * the right phase after they navigate away and return.
 *
 * Only one active job at a time — new job overwrites. When a job
 * terminates (done, error, user-cancelled), the entry is removed and
 * the Library takes over for the historical record.
 */

const KEY = "cleocuts.activeJob.v1";

// Phases that mean "backend is doing something" — worth resuming.
// Upload isn't resumable (the XHR must run in the current tab).
export type ActiveJobPhase = "analyzing" | "reviewing" | "rendering";

export type ActiveJob = {
  jobId: string;
  phase: ActiveJobPhase;
  timestamp: number;
  filename: string;
  presetId: string | null;
  presetLabel: string | null;
  presetIcon: string | null;
  captionPreset: string;
};

export function getActiveJob(): ActiveJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveJob;
    if (!parsed?.jobId || !parsed?.phase) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveActiveJob(entry: ActiveJob): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    /* quota errors — non-fatal */
  }
}

export function updateActiveJob(patch: Partial<ActiveJob>): void {
  const current = getActiveJob();
  if (!current) return;
  saveActiveJob({ ...current, ...patch });
}

export function clearActiveJob(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
