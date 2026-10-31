/**
 * The uploads of this page (UX5): a module-level singleton, so an upload
 * keeps running — and its tile keeps moving — while the user goes from
 * /app/new to Projects, into the editor of another project and back.
 * Nothing about an upload lives in a component.
 *
 * Two kinds of state:
 *   - live progress (percent, "resuming") and the local thumbnail, in
 *     memory only: subscribe() / useLiveUpload() re-render the tile on
 *     every tick;
 *   - the upload record (./records: the dashboard card of lib/activeJobs,
 *     or the jobs store on the v2 opt-in; localStorage): written
 *     once per state change — started, resuming, job created, failed —
 *     plus a heartbeat every UPLOAD_HEARTBEAT_MS (uploadJob.ts) so another
 *     tab (or this one after a reload) can tell a live upload from a dead
 *     one (markStaleUploads, 20 s). Never per progress tick.
 *   - the paywall a refused upload (402) asks for, shown wherever the
 *     user is by <UploadPaywall/> (app/app/layout.tsx).
 *
 * UX12: an upload can be cancelled (the multipart upload is aborted and
 * the record goes) and tried again — with the File still in this page at
 * once, after a reload by picking the same file (its resume record in
 * IndexedDB continues where it stopped).
 *
 * D1: the start screen's uploads wait for its gate ("Let's go") before
 * POST /jobs; until it opens they are "awaiting go" (uploadState), which
 * Projects shows with a way back to the start screen.
 */
import { tEn } from "@/lib/errors";
import type { Gate } from "./gate";
import {
  addUploadRecord,
  liveUploads,
  projectsV2,
  recordUploadFailed,
  recordUploadSettings,
  recordUploadStarting,
} from "./records";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { readSettings, type SettingsSource, type UploadSettings } from "./settings";
import {
  controllers,
  emit,
  live,
  moveThumb,
  retries,
  setAwaitingGo,
  setPaywall,
  setThumbWhenReady,
  type EndHow,
  type Retry,
} from "./uploadState";
import { isMobile } from "@/features/start/ios";
import { holdUploadLock } from "@/lib/uploadLock";

export {
  _version,
  dismissPaywall,
  getLiveUpload,
  getLiveUploads,
  getPaywall,
  isAwaitingGo,
  subscribe,
  useAwaitingGo,
  useLiveUpload,
  useLocalThumb,
  usePaywall,
  type EndHow,
  type LiveUpload,
} from "./uploadState";

// ── starting, cancelling, retrying ───────────────────────────────────

export type StartOpts = {
  /** "any": picked with the unfiltered iOS input ("Pick anyway"): kept
   *  with the upload, so a resume opens that input again. */
  source?: "any";
  /** POST /jobs waits until it opens (./gate, D1). None: it goes as soon
   *  as the bytes are up. */
  gate?: Gate;
  /** The tile's thumbnail (the start screen's frame) instead of a frame
   *  grabbed here. Its object URL is the upload's from then on: it goes
   *  with the job, and is revoked when the upload is given up. */
  thumb?: Promise<string | null>;
  /** The length as read when the file was picked (null: the browser
   *  couldn't); read again when not given. */
  duration?: number | null;
  /** The upload's card is up (its temporary id: useLiveUpload). */
  onCard?(tempId: string): void;
  /** POST /jobs read the settings: a change from now on wouldn't reach
   *  the job. On R2 right before onStarting; on the legacy upload the
   *  bytes still go up with the request meanwhile. */
  onSettingsRead?(): void;
  /** POST /jobs goes out: the settings are read now. */
  onStarting?(): void;
  /** The job exists (its card replaced the upload's). */
  onCreated?(jobId: string): void;
  /** The upload is over: `jobId` when the job was created, else null. */
  onEnd?(jobId: string | null, how: EndHow): void;
};

/** Put up the record of a new upload (its temporary id until POST /jobs
 *  names the job); marked as this page's (liveUploads). */
export function uploadCard(
  file: File,
  settings: SettingsSource,
  preset: PresetId | null,
  source?: "any",
  thumb?: Promise<string | null>,
): string {
  const tempId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const info = preset ? PRESETS[preset] : null;
  liveUploads.add(tempId);
  addUploadRecord(tempId, {
    filename: file.name,
    fileSize: file.size,
    presetId: preset,
    presetLabel: info ? tEn(info.labelKey) : null,
    // (Read now for the record: a later change still reaches POST /jobs.)
    settings: readSettings(settings),
    ...(source ? { source } : {}),
  });
  live.set(tempId, { id: tempId, pct: 0, resuming: false });
  emit();
  // The tile's local thumbnail: the start screen's frame, else one
  // grabbed here (v2 Projects only).
  const frame = thumb ?? (projectsV2() ? import("./grabFrame").then((m) => m.grabFrame(file)) : null);
  if (frame) setThumbWhenReady(tempId, frame);
  return tempId;
}

/** The start screen's choices changed (D7): the upload's record follows
 *  (POST /jobs reads the settings source itself, when it goes out). */
export function updateUploadSettings(tempId: string, settings: UploadSettings): void {
  recordUploadSettings(tempId, settings);
}

let uploadCode: Promise<typeof import("./uploadJob")> | null = null;

/** The upload code (its own chunk). /app/new loads it as it opens, so a
 *  deploy between opening the page and picking a file can't take it
 *  away; a failed load is tried again next time. */
export function loadUploadCode(): Promise<typeof import("./uploadJob")> {
  uploadCode ??= import("./uploadJob").catch((e) => {
    uploadCode = null;
    throw e;
  });
  return uploadCode;
}

/** The same file (as the browser describes it) as an upload running in
 *  this page: refused, so a double start can't make two jobs. */
const running = new Map<string, string>();
const fileKey = (f: File) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`;
// Running uploads that were cancelled and are still winding down (the
// parts stored so far are being discarded on the server), and who waits
// for their file to be free again.
const cancelling = new Set<string>();
const freeWaiters = new Map<string, Set<() => void>>();

export function isUploading(file: File): boolean {
  return running.has(fileKey(file));
}

/** The upload of this very file was cancelled a moment ago and is still
 *  winding down: picked again, the file waits for it (whenFree) instead
 *  of joining it. */
export function isCancelling(file: File): boolean {
  return cancelling.has(fileKey(file));
}

/** True once no upload of `file` runs in this page (at once if none
 *  does); false if one still runs after `ms`. A new upload must not start
 *  before: it would resume the parts being discarded. */
export function whenFree(file: File, ms: number): Promise<boolean> {
  const fk = fileKey(file);
  if (!running.has(fk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = freeWaiters.get(fk) ?? new Set<() => void>();
    freeWaiters.set(fk, waiters);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(done);
      resolve(false);
    }, ms);
    waiters.add(done);
  });
}

/** The upload of file key `fk` is over: the file is free again. */
function free(fk: string): void {
  running.delete(fk);
  cancelling.delete(fk);
  const waiters = freeWaiters.get(fk);
  freeWaiters.delete(fk);
  waiters?.forEach((f) => f());
}

// While an upload runs (also one waiting for "Let's go"), <html> has
// data-uploading on every device: no pull-to-refresh meanwhile
// (globals.css). Desktop: leaving the page (reload, closing the tab)
// asks first. Phones and tablets ignore beforeunload (isMobile); the
// listener is only there while something uploads (it may keep a page
// out of the bfcache). A download link (another origin: the browser
// navigates until the answer turns out to be an attachment) doesn't ask.
// (An error answer instead of the file then replaces the page — rare,
// and accepted: loading downloads in a hidden frame broke the API's
// attachments, which it serves with X-Frame-Options: DENY.)
let downloadClickAt = 0;
function onClickCapture(e: Event): void {
  if ((e.target as Element | null)?.closest?.("a[download]")) downloadClickAt = Date.now();
}
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!running.size || Date.now() - downloadClickAt < 1000) return;
  e.preventDefault();
  e.returnValue = "";
}
function guardUnload(): void {
  const on = running.size > 0;
  if (typeof document !== "undefined") document.documentElement?.toggleAttribute("data-uploading", on);
  if (typeof window === "undefined" || typeof navigator === "undefined" || isMobile(navigator)) return;
  if (on) {
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
  } else {
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("click", onClickCapture, true);
  }
}

/**
 * Upload `file` and create its job, in the background whatever route is
 * shown; resolves when that is over (callers don't wait for it). Never
 * throws: a failure ends on the record. `onCreated`: the job exists.
 */
export async function startUpload(
  file: File,
  settings: SettingsSource,
  preset: PresetId | null,
  { source, gate, thumb, duration, onCard, onSettingsRead, onStarting, onCreated, onEnd }: StartOpts = {},
): Promise<void> {
  const fk = fileKey(file);
  if (running.has(fk)) return;
  // The tile goes up now, before anything is awaited: Projects shows it
  // the moment it opens.
  const tempId = uploadCard(file, settings, preset, source, thumb);
  running.set(fk, tempId);
  guardUnload();
  // Awaiting go until the gate opens. A failure keeps the mark; giving
  // the upload up drops it (uploadControls).
  if (gate && !gate.isOpen) {
    setAwaitingGo(tempId, true);
    void gate.promise.then(() => setAwaitingGo(tempId, false));
  }
  // Other tabs: this record's upload runs (lib/uploadLock), until onEnd.
  const unlock = holdUploadLock(tempId);
  onCard?.(tempId);
  // What "Try again" needs, the start screen's part included (its tile's
  // "Try again" goes on with it: same gate, same callbacks).
  const retry = (): Retry => ({
    file,
    settings,
    preset,
    ...(source ? { source } : {}),
    ...(gate ? { start: { gate, duration, onCard, onSettingsRead, onStarting, onCreated, onEnd } } : {}),
  });
  let created: string | null = null;
  let failed = false;
  const ctl = new AbortController();
  controllers.set(tempId, ctl);
  // Cancelled: winding down until onEnd (see isCancelling).
  ctl.signal.addEventListener("abort", () => cancelling.add(fk), { once: true });
  // The upload code is its own chunk: pages that only show tiles don't
  // load it.
  let uploadJob: typeof import("./uploadJob").uploadJob;
  try {
    ({ uploadJob } = await loadUploadCode());
  } catch {
    // The chunk didn't load: offline, or — online — this build's chunk is
    // gone because a new version was deployed (a reload fixes that).
    liveUploads.delete(tempId);
    live.delete(tempId);
    free(fk);
    guardUnload();
    unlock();
    controllers.delete(tempId);
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    retries.set(tempId, retry());
    recordUploadFailed(tempId, { code: online ? "app_updated" : "connection_lost" });
    emit();
    onEnd?.(null, "failed");
    return;
  }
  return uploadJob(file, settings, preset, {
    tempId,
    signal: ctl.signal,
    source,
    ready: gate?.promise,
    duration,
    onPaywall: (pw) => {
      setPaywall(pw);
    },
    onSettingsRead,
    onCreated: (jobId) => {
      created = jobId;
      moveThumb(tempId, jobId);
      onCreated?.(jobId);
    },
    onStarting: () => {
      // The job may be created from here on: Cancel goes (uploadControls).
      controllers.delete(tempId);
      const cur = live.get(tempId);
      live.set(tempId, { id: tempId, pct: 100, resuming: false, ...cur, starting: true });
      recordUploadStarting(tempId);
      emit();
      onStarting?.();
    },
    onUploaded: (id) => {
      const cur = live.get(id);
      live.set(id, { id, resuming: false, ...cur, pct: 100, uploaded: true });
      emit();
    },
    onFailed: () => {
      failed = true;
      retries.set(tempId, retry());
    },
    onProgress: (id, pct, resuming) => {
      const cur = live.get(id);
      if (cur && cur.pct === pct && cur.resuming === resuming) return;
      live.set(id, { ...cur, id, pct, resuming });
      emit();
    },
    onPaused: (id, paused) => {
      const cur = live.get(id);
      if (!cur || Boolean(cur.paused) === paused) return;
      // POST /jobs waiting for the connection: Cancel is offered again
      // (it stops the waiting; uploadJob).
      if (cur.starting) {
        if (paused) controllers.set(id, ctl);
        else controllers.delete(id);
      }
      live.set(id, { ...cur, paused });
      emit();
    },
    onEnd: (id) => {
      free(fk);
      guardUnload();
      unlock();
      controllers.delete(id);
      if (live.delete(id)) emit();
      onEnd?.(created, created !== null ? "created" : failed ? "failed" : "cancelled");
    },
  });
}
