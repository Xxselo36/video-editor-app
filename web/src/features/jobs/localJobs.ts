/**
 * Light reads of what the jobs store (./jobsStore) keeps, for screens
 * outside the v2 Projects page (/app/new, /app/p, the editor): no store,
 * no poll, no migration — just localStorage / sessionStorage.
 */
import { storageScope } from "@/lib/auth";
import { JOBS_KEY } from "@/lib/scopedStorage";
import { parseLocal, type LocalJob } from "./projects";

/** sessionStorage key: an export of this job was started in this tab. */
export const exportHintKey = (id: string) => `cleocuts.exporting.${id}`;

/** This device's v2 project list as stored. */
export function readLocalJobs(): LocalJob[] {
  try {
    return parseLocal(localStorage.getItem(JOBS_KEY + storageScope()));
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
