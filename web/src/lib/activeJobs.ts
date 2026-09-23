/**
 * Tracks MULTIPLE in-flight jobs so users can upload → dashboard-card
 * → keep browsing / upload another video / open review for another
 * job — all concurrently. Backend already handles parallel jobs; this
 * lets the frontend catch up.
 *
 * Coexists with the older single-job activeJob.ts for backward compat;
 * new code should use this list-based API.
 */

const KEY = "cleocuts.activeJobs.v1";

export type ActiveJobPhase =
  | "uploading"
  | "analyzing"
  | "reviewing"
  | "rendering";

export type ActiveJobV2 = {
  jobId: string;
  phase: ActiveJobPhase;
  timestamp: number;
  filename: string;
  fileSize?: number;
  presetId: string | null;
  presetLabel: string | null;
  presetIcon: string | null;
  captionPreset: string;
  // Client-side upload progress 0-100. Only used during 'uploading' phase.
  uploadPct?: number;
};

export function getActiveJobs(): ActiveJobV2[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActiveJobV2[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((j) => j?.jobId && j?.phase);
  } catch {
    return [];
  }
}

export function saveActiveJobs(jobs: ActiveJobV2[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {
    /* quota errors — non-fatal */
  }
}

export function addActiveJob(entry: ActiveJobV2): void {
  const jobs = getActiveJobs();
  const filtered = jobs.filter((j) => j.jobId !== entry.jobId);
  filtered.unshift(entry); // newest first
  saveActiveJobs(filtered.slice(0, 20)); // cap
}

export function updateActiveJob(
  jobId: string,
  patch: Partial<ActiveJobV2>,
): void {
  const jobs = getActiveJobs();
  const next = jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j));
  saveActiveJobs(next);
}

export function removeActiveJob(jobId: string): void {
  const jobs = getActiveJobs().filter((j) => j.jobId !== jobId);
  saveActiveJobs(jobs);
}

export function getActiveJob(jobId: string): ActiveJobV2 | null {
  return getActiveJobs().find((j) => j.jobId === jobId) ?? null;
}
