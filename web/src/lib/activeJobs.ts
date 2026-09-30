/**
 * Tracks MULTIPLE in-flight jobs so users can upload → dashboard-card
 * → keep browsing / upload another video / open review for another
 * job — all concurrently. Backend already handles parallel jobs; this
 * lets the frontend catch up.
 */

import { storageScope } from "@/lib/auth";
import { foldScopedKeys } from "@/lib/scopedStorage";

export const ACTIVE_JOBS_KEY = "cleocuts.activeJobs.v1";
// Per user when accounts are on (shared devices); unchanged when off.
const key = () => {
  foldScopedKeys(ACTIVE_JOBS_KEY);
  return ACTIVE_JOBS_KEY + storageScope();
};
const CHANGE_EVENT = "cleocuts.activeJobs.change";

function emitChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

export function subscribeActiveJobs(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

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
  // Last time the uploading tab reported progress (ms epoch). Lets
  // other tabs / a reloaded page tell a live upload from a dead one.
  lastProgressAt?: number;
  // The upload continues an interrupted one of the same file (resume
  // state in IndexedDB, lib/chunkedUpload): the card says so.
  resuming?: boolean;
  // Populated when the upload or a later phase fails. Card renders a
  // retry button instead of the normal progress bar when set.
  error?: string;
  // Non-fatal hint on a card that still works (e.g. render failed →
  // back in review, edits kept).
  note?: string;
};

export function getActiveJobs(): ActiveJobV2[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key());
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
    localStorage.setItem(key(), JSON.stringify(jobs));
  } catch {
    /* quota errors — non-fatal */
  }
  emitChange();
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

// Uploads running in THIS page. Module state, so it is empty again
// after a reload — which is exactly when an 'uploading' card from
// localStorage has lost its XHR and can never finish.
export const liveUploads = new Set<string>();

// Turn 'uploading' cards whose upload no longer exists into error
// cards (with "Try again"), instead of leaving them frozen at their
// last percentage forever. A card is dead when this page doesn't own
// it and no other tab has reported progress for `idleMs`.
export function markStaleUploads(idleMs = 20_000): void {
  const now = Date.now();
  const jobs = getActiveJobs();
  let changed = false;
  const next = jobs.map((j) => {
    if (j.phase !== "uploading" || j.error || liveUploads.has(j.jobId)) return j;
    if (now - (j.lastProgressAt ?? j.timestamp) < idleMs) return j;
    changed = true;
    return {
      ...j,
      error:
        "Upload was interrupted (page reloaded or connection lost). Please upload the video again.",
    };
  });
  if (changed) saveActiveJobs(next);
}

export function getActiveJob(jobId: string): ActiveJobV2 | null {
  return getActiveJobs().find((j) => j.jobId === jobId) ?? null;
}

// The single-job "v1" store (lib/activeJob, removed in UX4): older builds
// wrote it, nothing ever read it.
const LEGACY_ACTIVE_JOB_KEY = "cleocuts.activeJob.v1";

/**
 * Drops what older builds left of the v1 store, under the plain key and
 * the per-user keys (`<key>:<user id>`). Its jobs are on the cards or in
 * the library as well. One release after UX4 this goes too.
 */
export function dropLegacyActiveJob(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k === LEGACY_ACTIVE_JOB_KEY || k.startsWith(`${LEGACY_ACTIVE_JOB_KEY}:`))) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}
