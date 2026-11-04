"use client";
/**
 * The export's files (the editor's Done view, the Vorschau's done state)
 * and saving the main one through the share sheet (../share.ts): "Save /
 * Share…" in the Done view, "Video sichern" on the Vorschau (plan D21).
 *
 * iOS opens the share sheet only from a tap with no await before
 * navigator.share(): the file is fetched ahead and shared from the tap.
 *
 *   off        this device doesn't save through the share sheet, or the
 *              file is too big for it: the caller offers Download
 *   idle       nothing fetched yet: the first tap fetches it
 *   preparing  fetching ("Preparing…")
 *   ready      fetched: a tap opens the share sheet
 *   failed     the fetch failed: Download instead
 *
 * `prefetch`: fetch as soon as media URLs work (the Done view; the
 * Vorschau as prefetchAhead says). A tap on "idle" fetches, then shares
 * if the browser still counts the tap (a quick fetch; else the next tap
 * shares); a fetch it asked for that fails downloads instead. A share
 * that fails downloads the file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { mediaUrl, useMediaReady } from "@/lib/api";
import type { JobStatus } from "@/features/jobs/types";
import { downloadUrl, prefetchFile, shareFile, shareMode } from "../share";

export type ExportFile = { format: string; bytes: number | null };

/** One file per distinct format (the bonus clips are job.hook_clips);
 *  `primary` the main one. A server before UX11 lists outputs only. */
export function exportFiles(job: Pick<JobStatus, "downloads" | "outputs">): {
  all: ExportFile[];
  primary: ExportFile | undefined;
} {
  const all = job.downloads?.length
    ? job.downloads
    : (job.outputs ?? ["primary"]).filter((f) => !f.startsWith("hook_")).map((f) => ({ format: f, bytes: null }));
  return { all, primary: all.find((d) => d.format === "primary") ?? all[0] };
}

/** GET /download of one of the export's files; name=v2: the backend
 *  names it after the project (UX11). v: the export's generation
 *  (renders_ok, as /watch?v=): every export's link is its own, so no
 *  browser answers it with an earlier export's from its cache (the
 *  backend ignores it). */
export function downloadHref(job: Pick<JobStatus, "id" | "renders_ok">, format: string): string {
  return mediaUrl(job.id, "download", { format, name: "v2", v: job.renders_ok ?? 0 });
}

/** navigator.connection's hints (Chromium only). */
export type Connection = { saveData?: boolean; type?: string };

/** Whether the Vorschau fetches the export before the tap (D21): only one
 *  that finished while the page was open, and not on a connection that
 *  says it is metered (Data Saver, mobile data): the file can be large.
 *  A browser that says nothing about its connection still fetches it:
 *  Safari and every iOS browser have no navigator.connection, and the
 *  share path runs only there. The share sheet must open inside the tap
 *  with the file ready, and the creator just finished this video to save
 *  it. */
export function prefetchAhead(finishedHere: boolean, connection: Connection | undefined): boolean {
  return finishedHere && !connection?.saveData && connection?.type !== "cellular";
}

export type ShareState = "off" | "idle" | "preparing" | "ready" | "failed";

export function useShareFile(
  job: Pick<JobStatus, "id" | "renders_ok" | "download_names">,
  file: ExportFile | undefined,
  { on, prefetch }: { on: boolean; prefetch: boolean },
): { state: ShareState; share: () => void } {
  const mediaReady = useMediaReady();
  const jobId = job.id;
  const gen = job.renders_ok ?? 0;
  const format = file?.format ?? "primary";
  const name = job.download_names?.[format] ?? "video.mp4";
  // One fetch per export and format (a new export starts over).
  const key = `${jobId}:${gen}:${format}`;
  const usable = on && file !== undefined && shareMode(file.bytes) === "share";
  // The export a tap asked to fetch.
  const [tapped, setTapped] = useState<string | null>(null);
  const [fetched, setFetched] = useState<{ key: string; state: "ready" | "failed" } | null>(null);
  const fileRef = useRef<{ key: string; file: File } | null>(null);
  const want = usable && mediaReady && (prefetch || tapped === key);
  const result = fetched?.key === key ? fetched.state : null;
  const state: ShareState = !usable ? "off" : (result ?? (want ? "preparing" : "idle"));

  // Synchronously from the tap: iOS opens the sheet only then.
  const send = useCallback(
    (f: File) => {
      void shareFile(f).then((outcome) => {
        if (outcome === "shared") track("share_used", { bytes: f.size });
        if (outcome === "failed") {
          track("share_failed", {});
          downloadUrl(downloadHref({ id: jobId, renders_ok: gen }, format), name);
        }
      });
    },
    [jobId, gen, format, name],
  );

  useEffect(() => {
    if (!want) return;
    const byTap = !prefetch;
    const ctrl = new AbortController();
    const href = downloadHref({ id: jobId, renders_ok: gen }, format);
    prefetchFile(href, name, ctrl.signal)
      .then((f) => {
        fileRef.current = { key, file: f };
        setFetched({ key, state: "ready" });
        // Still the tap's turn (a quick fetch): the sheet opens now.
        if (byTap && navigator.userActivation?.isActive) send(f);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setFetched({ key, state: "failed" });
        if (byTap) downloadUrl(href, name);
      });
    return () => ctrl.abort();
  }, [want, prefetch, key, jobId, gen, format, name, send]);

  const share = () => {
    const ready = fileRef.current?.key === key ? fileRef.current.file : null;
    if (ready) send(ready);
    else if (state === "idle") setTapped(key);
  };

  return { state, share };
}
