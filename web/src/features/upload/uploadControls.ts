/**
 * Cancel and "Try again" of an upload (UX12, v2 Projects tiles; the start
 * screen's X and "Try again", D2). Its own module: only screens with
 * those controls import it.
 */
import { removeUploadRecord } from "./records";
import type { SettingsSource } from "./settings";
import { startUpload, type StartOpts } from "./uploadManager";
import { controllers, live, retries, setAwaitingGo, setThumb, takeThumb } from "./uploadState";
import type { PresetId } from "@/features/start/presets.legacy";
import { runningUploads } from "@/lib/uploadLock";

/** The upload of record `id` runs in another tab (its Web Lock): its
 *  record is not this tab's to remove or to upload again. */
export async function runsElsewhere(id: string): Promise<boolean> {
  if (controllers.has(id) || live.has(id)) return false;
  return Boolean((await runningUploads())?.has(id));
}

/** This page still has the File of the failed upload `id` ("Try again"
 *  goes at once; else the file is picked again). */
export function canRetryInPlace(id: string): boolean {
  return retries.has(id);
}

/**
 * Cancel an upload: the request stops, the multipart upload is aborted on
 * the server (abortResumable) and its record goes. A failed upload is
 * just removed (its resume record too: the user gave it up). Also one
 * waiting for "Let's go": no job, and the server deletes the stored file.
 */
export async function cancelUpload(id: string): Promise<void> {
  // POST /jobs went out: the job may exist and can't be stopped — the
  // record stays (the tile no longer offers Cancel) — unless it waits
  // for the connection: then Cancel stops the waiting.
  const cur = live.get(id);
  if (cur?.starting && !cur.paused) return;
  const ctl = controllers.get(id);
  const retry = retries.get(id);
  if (!ctl && !retry && (await runsElsewhere(id))) return;
  retries.delete(id);
  setThumb(id, null);
  removeUploadRecord(id);
  setAwaitingGo(id, false);
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
 *  same file, which resumes where the failed one stopped. With `opts`
 *  (the start screen's gate, length and callbacks), or without them for
 *  an upload the start screen started (its Projects tile: the same gate
 *  and callbacks go on), the new upload keeps the thumbnail too, unless
 *  `opts.thumb` brings another. False when the file isn't here any more
 *  (the caller asks for it). */
export function retryUpload(id: string, opts?: StartOpts): boolean {
  const r = retries.get(id);
  if (!r) return false;
  retries.delete(id);
  removeUploadRecord(id);
  setAwaitingGo(id, false);
  const o: StartOpts | undefined = opts ?? r.start;
  if (!o) {
    setThumb(id, null);
    void startUpload(r.file, r.settings, r.preset, { source: r.source });
    return true;
  }
  // (The start screen draws its tiles with that frame: not revoked.)
  const thumb = o.thumb ?? takeThumb(id);
  if (o.thumb) setThumb(id, null);
  void startUpload(r.file, r.settings, r.preset, { ...o, source: r.source, thumb });
  return true;
}

/** "Try again" after a reload: the user picked `file` again (`source`
 *  "any": with the unfiltered iOS input). False (and nothing happens)
 *  while the upload still runs in another tab. */
export async function retryUploadWith(
  id: string,
  file: File,
  settings: SettingsSource,
  preset: PresetId | null,
  source?: "any",
): Promise<boolean> {
  if (await runsElsewhere(id)) return false;
  retries.delete(id);
  removeUploadRecord(id);
  setThumb(id, null);
  void startUpload(file, settings, preset, { source });
  return true;
}
