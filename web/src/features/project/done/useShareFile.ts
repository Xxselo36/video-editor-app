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
 *              file is too big for it (share.ts shareCap): the caller
 *              offers Download
 *   idle       nothing fetched yet, or the fetch ahead waits while the
 *              video plays: a tap fetches it (on from where it stopped)
 *   preparing  fetching ("Preparing… 42 %": `progress`, null while the
 *              size is unknown); a failed try is followed by two more
 *              (2 s, then 6 s later; a hidden page's try waits until it
 *              shows again: iOS cuts its requests), each going on from
 *              where the last one stopped (FileFetch)
 *   ready      fetched: a tap opens the share sheet
 *   failed     the fetch failed three times, or the browser can't share
 *              this file: the caller offers Download with a note
 *
 * `prefetch`: fetch as soon as media URLs work (the Done view; the
 * Vorschau as prefetchAhead says, once its frame has its picture, and
 * not while its video plays: a fetch ahead that started holds then, the
 * video comes first). A tap on "idle" fetches, then shares if the
 * browser still counts the tap (a quick fetch; else the next tap
 * shares). Nothing downloads by itself (the owner's iPhone, 2026-11: the
 * download landed in Files instead of Photos): a share the user closed,
 * or one while a sheet is open, leaves the file ready for the next tap;
 * one the browser refused although it counted the tap (Chromium over
 * its 50 MiB), or couldn't read, fails; a tap while a share is still
 * open does nothing.
 */
import { useEffect, useRef, useState } from "react";
import type { TFn } from "@/i18n";
import { track } from "@/lib/analytics";
import { mediaUrl, useMediaReady } from "@/lib/api";
import { formatPct } from "@/lib/percent";
import type { JobStatus } from "@/features/jobs/types";
import { FileFetch, RETRY_WAITS_MS, shareFile, shareMode, waitToRetry, type OnProgress, type PageVisibility } from "../share";

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
 *  it. (The Vorschau also waits for its frame's picture and holds the
 *  fetch while its video plays: PreviewScreen.) */
export function prefetchAhead(finishedHere: boolean, connection: Connection | undefined): boolean {
  return finishedHere && !connection?.saveData && connection?.type !== "cellular";
}

export type ShareState = "off" | "idle" | "preparing" | "ready" | "failed";

/** A ShareSession's state: how much of the file is here while it is
 *  fetched (whole percent / 100; null: unknown). */
export type Prepared = { state: "preparing" | "ready" | "failed"; progress: number | null };

export type ShareSessionOptions = {
  /** One try at the file, on from where the last one stopped (FileFetch.next of the export's link). */
  load: (signal: AbortSignal, onProgress: OnProgress) => Promise<File>;
  /** Ends the session and its tries (the export changed, the page went). */
  signal: AbortSignal;
  onChange: (p: Prepared) => void;
  /** navigator (share, userActivation); tests pass their own. */
  nav?: Partial<Pick<Navigator, "share" | "userActivation">>;
  /** document's visibility (waitToRetry); tests pass their own. */
  page?: PageVisibility;
  /** The waits before the second and third try. */
  waits?: readonly number[];
};

/** Why a try was stopped by hold(): a pause, not a failure. */
const HELD = "held";

/**
 * One export's file for the share sheet (useShareFile, plain TS so the
 * tests drive it): fetched by `load` in tries, three at most (a try
 * stopped by hold() doesn't count: it goes on when the hold ends), its
 * progress told in whole percent (onChange at most once each); then
 * shared from a tap. While a share is open a tap does nothing: a second
 * navigator.share() would cancel the first one's reading of the file in
 * WebKit, and neither sheet would open.
 */
export class ShareSession {
  private readonly o: ShareSessionOptions;
  private file: File | null = null;
  private sharing = false;
  private now: Prepared = { state: "preparing", progress: null };
  private byTap = false;
  private held = false;
  private attempt: AbortController | null = null;
  private resume: (() => void) | null = null;

  constructor(o: ShareSessionOptions) {
    this.o = o;
  }

  /** Ready or failed: nothing more to fetch for this export. */
  get settled(): boolean {
    return this.now.state !== "preparing";
  }

  private set(p: Prepared) {
    if (p.state === this.now.state && p.progress === this.now.progress) return;
    this.now = p;
    this.o.onChange(p);
  }

  /** Stop the fetch where it is (`on`: the video plays) or go on from
   *  there (a try stopped meanwhile is not a failure). */
  hold(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    if (on) this.attempt?.abort(HELD);
    else {
      this.resume?.();
      this.resume = null;
    }
  }

  /** A tap asked for the file (it fetches): shared at once if the browser
   *  still counts that tap when the file is in (a quick fetch). */
  ask(): void {
    this.byTap = true;
  }

  /** Until no hold is on; rejects when the session ends. */
  private unheld(): Promise<void> {
    const { signal } = this.o;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.held) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const end = () => reject(signal.reason);
      signal.addEventListener("abort", end, { once: true });
      this.resume = () => {
        signal.removeEventListener("abort", end);
        resolve();
      };
    });
  }

  /** Fetch the file. `byTap`: a tap asked for it (ask()). */
  async start(byTap: boolean): Promise<void> {
    if (byTap) this.ask();
    const { load, signal, nav = globalThis.navigator, waits = RETRY_WAITS_MS } = this.o;
    const onProgress: OnProgress = (loaded, total) => {
      const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
      this.set({ state: "preparing", progress: pct === null ? null : pct / 100 });
    };
    for (let failures = 0; ; ) {
      try {
        await this.unheld();
      } catch {
        return;
      }
      if (signal.aborted) return;
      const ctrl = new AbortController();
      const end = () => ctrl.abort(signal.reason);
      signal.addEventListener("abort", end, { once: true });
      this.attempt = ctrl;
      try {
        this.file = await load(ctrl.signal, onProgress);
        this.set({ state: "ready", progress: null });
        if (this.byTap && nav?.userActivation?.isActive) this.tap();
        return;
      } catch {
        if (signal.aborted) return;
        if (ctrl.signal.reason === HELD) continue;
        failures++;
      } finally {
        signal.removeEventListener("abort", end);
        this.attempt = null;
      }
      if (failures > waits.length) {
        track("share_failed", { step: "fetch" });
        this.set({ state: "failed", progress: null });
        return;
      }
      try {
        await waitToRetry(waits[failures - 1], signal, this.o.page);
      } catch {
        return;
      }
    }
  }

  /** A tap on "ready": the share sheet, synchronously (iOS opens it only
   *  from the tap itself). A refusal of the file itself fails it. */
  tap(): void {
    const f = this.file;
    if (!f || this.now.state !== "ready" || this.sharing) return;
    this.sharing = true;
    const nav = this.o.nav ?? globalThis.navigator;
    // Read before share() uses the activation up. A browser without
    // userActivation (Safari before 16.4) is in the tap itself here.
    const counted = nav?.userActivation ? nav.userActivation.isActive : true;
    void shareFile(f, nav).then((outcome) => {
      this.sharing = false;
      if (outcome === "shared") track("share_used", { bytes: f.size });
      if (outcome !== "failed" && !(outcome === "denied" && counted)) return;
      track("share_failed", { step: "share" });
      this.file = null;
      this.set({ state: "failed", progress: null });
    });
  }
}

/** The share button's label while the file comes in: "Preparing… 42 %"
 *  (`progress` 0..1), "Preparing…" while its size is unknown. */
export function preparingLabel(t: TFn, lang: string, progress: number | null): string {
  return progress === null ? t("app.done.preparing") : t("app.done.preparingPct", { pct: formatPct(progress * 100, lang) });
}

export function useShareFile(
  job: Pick<JobStatus, "id" | "renders_ok" | "download_names">,
  file: ExportFile | undefined,
  { on, prefetch }: { on: boolean; prefetch: boolean },
): { state: ShareState; progress: number | null; share: () => void } {
  const mediaReady = useMediaReady();
  const jobId = job.id;
  const gen = job.renders_ok ?? 0;
  const format = file?.format ?? "primary";
  const bytes = file?.bytes ?? null;
  const name = job.download_names?.[format] ?? "video.mp4";
  // One fetch per export and format (a new export starts over).
  const key = `${jobId}:${gen}:${format}`;
  const usable = on && file !== undefined && shareMode(file.bytes) === "share";
  // The export a tap asked to fetch.
  const [tapped, setTapped] = useState<string | null>(null);
  const asked = tapped === key;
  const live = usable && mediaReady;
  // Fetch now; else not yet, or held where it is (`prefetch` turned off
  // again: the Vorschau's video plays). A tap's fetch is never held.
  const go = prefetch || asked;
  const want = live && go;
  const [prep, setPrep] = useState<(Prepared & { key: string }) | null>(null);
  const session = useRef<{ key: string; s: ShareSession; ctrl: AbortController } | null>(null);
  const mine = prep?.key === key ? prep : null;
  const result = mine && mine.state !== "preparing" ? mine.state : null;
  const state: ShareState = !usable ? "off" : (result ?? (want ? "preparing" : "idle"));
  const progress = state === "preparing" && mine ? mine.progress : null;

  // The session ends with its export, when sharing goes off, and with the page.
  useEffect(() => {
    if (!live) return;
    return () => {
      const cur = session.current;
      if (cur?.key !== key) return;
      cur.ctrl.abort();
      session.current = null;
    };
  }, [live, key]);

  // Started when first wanted; held while not, and on again when wanted.
  useEffect(() => {
    if (!live) return;
    const cur = session.current?.key === key ? session.current : null;
    if (!go) {
      cur?.s.hold(true);
      return;
    }
    if (cur) {
      if (asked) cur.s.ask();
      cur.s.hold(false);
      return;
    }
    const ctrl = new AbortController();
    const fetcher = new FileFetch(downloadHref({ id: jobId, renders_ok: gen }, format), name, bytes);
    const s = new ShareSession({
      load: (signal, onProgress) => fetcher.next(signal, onProgress),
      signal: ctrl.signal,
      onChange: (p) => setPrep({ ...p, key }),
    });
    session.current = { key, s, ctrl };
    void s.start(asked);
  }, [live, go, asked, key, jobId, gen, format, name, bytes]);

  const share = () => {
    if (state === "ready") {
      if (session.current?.key === key) session.current.s.tap();
    } else if (state === "idle") setTapped(key);
  };

  return { state, progress, share };
}
