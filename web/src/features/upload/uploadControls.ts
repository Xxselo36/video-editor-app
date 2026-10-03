/**
 * Cancel and "Try again" of an upload (UX12, v2 Projects tiles). Its own
 * module: only the Projects page (its own chunk) imports it, so the start
 * screen stays light.
 */
import { removeUploadRecord } from "./records";
import type { SettingsSource } from "./settings";
import { startUpload } from "./uploadManager";
import { controllers, live, retries, setThumb } from "./uploadState";
import type { PresetId } from "@/features/start/presets.legacy";

/** This page still has the File of the failed upload `id` ("Try again"
 *  goes at once; else the file is picked again). */
export function canRetryInPlace(id: string): boolean {
  return retries.has(id);
}

/**
 * Cancel an upload: the request stops, the multipart upload is aborted on
 * the server (abortResumable) and its record goes. A failed upload is
 * just removed (its resume record too: the user gave it up).
 */
export async function cancelUpload(id: string): Promise<void> {
  // POST /jobs went out: the job may exist and can't be stopped — the
  // record stays (the tile no longer offers Cancel).
  if (live.get(id)?.starting) return;
  const ctl = controllers.get(id);
  const retry = retries.get(id);
  retries.delete(id);
  setThumb(id, null);
  removeUploadRecord(id);
  if (ctl) {
    // uploadJob sees the abort, aborts the multipart upload and forgets
    // the record itself.
    ctl.abort();
    return;
  }
  if (retry) {
    try {
      const { abortResumable } = await import("@/lib/chunkedUpload");
      await abortResumable({ file: retry.file });
    } catch {
      /* the bucket's lifecycle rule aborts it anyway */
    }
  }
}

/** "Try again" with the File this page still has: a new upload of the
 *  same file, which resumes where the failed one stopped. False when the
 *  file isn't here any more (the caller asks for it). */
export function retryUpload(id: string): boolean {
  const r = retries.get(id);
  if (!r) return false;
  retries.delete(id);
  removeUploadRecord(id);
  setThumb(id, null);
  void startUpload(r.file, r.settings, r.preset);
  return true;
}

/** "Try again" after a reload: the user picked `file` again. */
export function retryUploadWith(id: string, file: File, settings: SettingsSource, preset: PresetId | null): void {
  retries.delete(id);
  removeUploadRecord(id);
  setThumb(id, null);
  void startUpload(file, settings, preset);
}
