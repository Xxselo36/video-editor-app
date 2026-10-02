/**
 * Light reads of what the jobs store (./jobsStore) keeps, for screens
 * outside the v2 Projects page (/app/new, /app/p, the editor): no store,
 * no poll, no migration — just localStorage / sessionStorage.
 */
import { storageScope } from "@/lib/auth";
import { JOBS_KEY } from "@/lib/scopedStorage";
import type { LocalJob } from "./projects";

/** sessionStorage key: an export of this job was started in this tab. */
export const exportHintKey = (id: string) => `cleocuts.exporting.${id}`;

/** This device's v2 project list as stored (entries with an id; no
 *  cleaning — projects.ts parseLocal does that for the store). */
export function readLocalJobs(): LocalJob[] {
  try {
    const v = JSON.parse(localStorage.getItem(JOBS_KEY + storageScope()) ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((e): e is LocalJob => Boolean(e) && typeof (e as LocalJob).jobId === "string")
      : [];
  } catch {
    return [];
  }
}

/** Mark an export of `id` as started (a queued run is the export). */
export function setExportHint(id: string): void {
  try {
    sessionStorage.setItem(exportHintKey(id), "1");
  } catch {
    /* memory (jobsStore) is enough for this page */
  }
}

export function hasExportHint(id: string): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(exportHintKey(id)) === "1";
  } catch {
    return false;
  }
}
