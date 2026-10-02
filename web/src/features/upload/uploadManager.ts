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
 */
import { tEn } from "@/lib/errors";
import { addUploadRecord, liveUploads, projectsV2, recordUploadFailed, removeUploadRecord } from "./records";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { readSettings, type SettingsSource } from "./settings";
import { controllers, emit, live, moveThumb, retries, setPaywall, setThumb } from "./uploadState";

export {
  _version,
  dismissPaywall,
  getLiveUpload,
  getLiveUploads,
  getPaywall,
  subscribe,
  useLiveUpload,
  useLocalThumb,
  usePaywall,
  type LiveUpload,
} from "./uploadState";

// ── starting, cancelling, retrying ───────────────────────────────────


/** Put up the record of a new upload (its temporary id until POST /jobs
 *  names the job); marked as this page's (liveUploads). */
export function uploadCard(file: File, settings: SettingsSource, preset: PresetId | null): string {
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
  });
  live.set(tempId, { id: tempId, pct: 0, resuming: false });
  emit();
  // The tile's local thumbnail (v2 Projects only).
  if (projectsV2()) void import("./grabFrame").then((m) => m.grabFrame(file)).then((url) => {
    // Still this upload's (or its job's) tile.
    if (url) setThumb(tempId, url);
  });
  return tempId;
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

export function isUploading(file: File): boolean {
  return running.has(fileKey(file));
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
  {
    onCard,
    onCreated,
    onEnd,
  }: {
    /** The upload's card is up (its temporary id: useLiveUpload). */
    onCard?: (tempId: string) => void;
    /** The job exists (its card replaced the upload's). */
    onCreated?: (jobId: string) => void;
    /** The upload is over: `jobId` when the job was created, else null
     *  (it failed; the card says why). */
    onEnd?: (jobId: string | null) => void;
  } = {},
): Promise<void> {
  const fk = fileKey(file);
  if (running.has(fk)) return;
  // The tile goes up now, before anything is awaited: Projects shows it
  // the moment it opens.
  const tempId = uploadCard(file, settings, preset);
  running.set(fk, tempId);
  onCard?.(tempId);
  let created: string | null = null;
  const ctl = new AbortController();
  controllers.set(tempId, ctl);
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
    running.delete(fk);
    controllers.delete(tempId);
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    retries.set(tempId, { file, settings, preset });
    recordUploadFailed(tempId, { code: online ? "app_updated" : "connection_lost" });
    emit();
    onEnd?.(null);
    return;
  }
  return uploadJob(file, settings, preset, {
    tempId,
    signal: ctl.signal,
    onPaywall: (pw) => {
      setPaywall(pw);
    },
    onCreated: (jobId) => {
      created = jobId;
      moveThumb(tempId, jobId);
      onCreated?.(jobId);
    },
    onFailed: () => {
      retries.set(tempId, { file, settings, preset });
    },
    onProgress: (id, pct, resuming) => {
      const cur = live.get(id);
      if (cur && cur.pct === pct && cur.resuming === resuming) return;
      live.set(id, { id, pct, resuming });
      emit();
    },
    onEnd: (id) => {
      running.delete(fk);
      controllers.delete(id);
      if (live.delete(id)) emit();
      onEnd?.(created);
    },
  });
}
