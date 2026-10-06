/**
 * Where an upload keeps its record (UX12 gate): browsers on the v2
 * opt-in (features/editor/v2/flag: `?editor=v2` / NEXT_PUBLIC_EDITOR_V2=1)
 * use the jobs store of the Projects page (features/jobs/jobsStore:
 * codes, no English text); everyone else keeps the dashboard cards of
 * lib/activeJobs exactly as before (card + English sentence for older
 * tabs). The upload code calls only these.
 *
 * The store is loaded on demand (its own chunk: /app/new stays light for
 * everyone off the opt-in); its calls run in order on the loaded module.
 */
import { addActiveJob, getActiveJobs, liveUploads, removeActiveJob, updateActiveJob } from "@/lib/activeJobs";
import { cardError, toCoded, type CodedError } from "@/lib/errors";
import { getLibrary } from "@/lib/library";
import { readChoice } from "@/features/editor/v2/flag";
type Store = typeof import("@/features/jobs/jobsStore");
import type { UploadSettings } from "./settings";

export { liveUploads };

/** This browser shows the v2 Projects page (read per call: a test or a
 *  `?editor=` switch takes effect at once). */
export const projectsV2 = (): boolean => readChoice();

let storeP: Promise<Store> | null = null;
function loadStore(): Promise<Store> {
  storeP ??= import("@/features/jobs/jobsStore");
  return storeP;
}
/** Run `fn` on the store, after every call queued before it. */
let chain: Promise<unknown> = Promise.resolve();
function withStore(fn: (s: Store) => void): void {
  chain = chain.then(() => loadStore()).then(fn, () => {});
}
// On the opt-in the store is fetched as the upload code loads.
if (typeof window !== "undefined" && projectsV2()) void loadStore().catch(() => {});

export type UploadInfo = {
  filename: string;
  fileSize: number;
  presetId: string | null;
  presetLabel: string | null;
  settings: UploadSettings;
};

export function addUploadRecord(tempId: string, info: UploadInfo): void {
  if (projectsV2()) {
    withStore((store) =>
      store.addUpload(
        tempId,
        { filename: info.filename, fileSize: info.fileSize, presetId: info.presetId, presetLabel: info.presetLabel },
        { settings: info.settings },
      ),
    );
    return;
  }
  addActiveJob({
    jobId: tempId,
    phase: "uploading",
    timestamp: Date.now(),
    filename: info.filename,
    fileSize: info.fileSize,
    presetId: info.presetId,
    presetLabel: info.presetLabel,
    presetIcon: null,
    captionPreset: info.settings.caption_preset ?? "",
    uploadPct: 0,
    lastProgressAt: Date.now(),
  });
}

/** A heartbeat / state change of a running upload. */
export function uploadProgress(tempId: string, p: { pct: number; lastProgressAt: number; resuming?: boolean }): void {
  const resuming = p.resuming === undefined ? {} : { resuming: p.resuming };
  if (projectsV2()) withStore((store) => store.updateUpload(tempId, { pct: p.pct, lastProgressAt: p.lastProgressAt, ...resuming }));
  else updateActiveJob(tempId, { uploadPct: p.pct, lastProgressAt: p.lastProgressAt, ...resuming });
}

/** The file is stored and POST /jobs went out (v2 tile: "Starting…",
 *  no cancel). */
export function recordUploadStarting(tempId: string): void {
  if (projectsV2()) withStore((store) => store.updateUpload(tempId, { starting: true, pct: 100, lastProgressAt: Date.now() }));
}

/** The upload failed: `e` an error, or a code ({code}). */
export function recordUploadFailed(tempId: string, e: unknown): void {
  const coded = toCoded(e);
  if (pageGone) return writeFailed(tempId, INTERRUPTED);
  if (CUT_CODES.has(coded.code ?? "")) cutAt.set(tempId, Date.now());
  writeFailed(tempId, coded);
}

function writeFailed(tempId: string, coded: CodedError): void {
  if (projectsV2()) withStore((store) => store.uploadFailed(tempId, coded));
  else updateActiveJob(tempId, cardError(coded));
}

// ── the page going away ──────────────────────────────────────────────
// A document load — a reload, a closed tab, or Next's fallback to a full
// page load when a client-side navigation can't be done (its RSC fetch
// failed, or a deploy since this page loaded: version skew) — ends this
// page's uploads: the browser cuts their requests. Safari reports that
// to the request as a network error or an abort, which read as
// "connection_lost" ("check your internet") on the next page. What
// happened is "upload_interrupted": the stopped tile (a multipart upload
// continues where it stopped once the file is picked again).
const INTERRUPTED: CodedError = { code: "upload_interrupted", params: null };
/** Codes of a request the browser itself ended (no server answer). */
const CUT_CODES = new Set(["connection_lost", "server_no_response", "processing_failed", "app_updated"]);
/** A failure this long before the page went may have been its doing
 *  (Safari cuts the requests as the navigation starts, before pagehide). */
export const PAGE_CUT_MS = 10_000;
const cutAt = new Map<string, number>();
let pageGone = false;

/** pagehide (exported for the unit test): this page's uploads, and the
 *  ones it just saw cut, are interrupted. Not when the page goes into the
 *  back/forward cache (`persisted`): it may come back as it was. */
export function pageHidden(persisted: boolean, now = Date.now()): void {
  if (persisted) return;
  pageGone = true;
  const cut = [...cutAt].filter(([, at]) => now - at < PAGE_CUT_MS).map(([id]) => id);
  for (const id of new Set([...liveUploads, ...cut])) writeFailed(id, INTERRUPTED);
}

/** pageshow: the page is shown again (exported for the unit test). */
export function pageShown(): void {
  pageGone = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", (e) => pageHidden(e.persisted));
  window.addEventListener("pageshow", pageShown);
}

/** POST /jobs created the job: the record becomes the project. */
export function recordJobCreated(
  tempId: string,
  jobId: string,
  info: Omit<UploadInfo, "settings"> & { captionPreset: string },
  opts: { cancelTooLate?: boolean } = {},
): void {
  if (projectsV2()) {
    withStore((store) => store.uploadCreated(tempId, jobId, info, opts));
    return;
  }
  removeActiveJob(tempId);
  addActiveJob({
    jobId,
    phase: "analyzing",
    timestamp: Date.now(),
    filename: info.filename,
    fileSize: info.fileSize,
    presetId: info.presetId,
    presetLabel: info.presetLabel,
    presetIcon: null,
    captionPreset: info.captionPreset,
  });
}

/** An upload that continues an interrupted one: the stopped tiles of the
 *  same file (same byte count) go — v2 only; the v1 dashboard keeps its
 *  cards exactly as before. */
export function removeStoppedUploads(fileSize: number, exceptId: string): void {
  if (!projectsV2()) return;
  withStore((store) => {
    for (const j of store.getLocalJobs()) {
      if (j.jobId !== exceptId && j.jobId.startsWith("upl-") && j.upload?.errorCode && j.fileSize === fileSize) {
        store.removeJob(j.jobId);
      }
    }
  });
}

export function removeUploadRecord(tempId: string): void {
  cutAt.delete(tempId);
  if (projectsV2()) withStore((store) => store.removeJob(tempId));
  else removeActiveJob(tempId);
}

/** Every project id this device knows. */
export async function knownJobIds(): Promise<Set<string>> {
  if (projectsV2()) {
    const store = await loadStore();
    return new Set(store.getLocalJobs().map((j) => j.jobId));
  }
  return new Set([...getActiveJobs().map((j) => j.jobId), ...getLibrary().map((e) => e.jobId)]);
}
