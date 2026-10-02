/**
 * Upload a video and create its job, in the background (moved
 * from Home's onProcess in app/app/page.tsx, UX4). A dashboard card shows
 * the upload and then the job; a failed upload leaves the card with its
 * error. Never throws.
 */
import { refreshMe, fetchServerJobs, paywallFrom, toMs, type Paywall } from "@/lib/account";
import { addActiveJob, getActiveJobs, liveUploads, removeActiveJob, updateActiveJob as updateActiveJobV2 } from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { ApiError, apiErrorFromText, authHeaders, backendUrl, notifyAuthRequired } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import {
  readVideoDuration,
  resumableProgress,
  uploadLimitHit,
  uploadResumable,
  UPLOAD_STALL_MS,
  UPLOAD_STALLED_MSG,
} from "@/lib/chunkedUpload";
import { getConfig } from "@/lib/config";
import { cardError, REFUSAL_CODES, tEn } from "@/lib/errors";
import { getLibrary } from "@/lib/library";
import { requestNotificationPermission } from "@/lib/notify";
import type { JobStatus } from "@/features/jobs/types";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { readSettings, type SettingsSource } from "./settings";

export type { UploadSettings } from "./settings";

// POST /jobs after an upload to R2: waits between tries on a network
// error or a 5xx that isn't a refusal — about 75 s in all, so a backend
// restart (every deploy) or a 502 / 503 from the edge doesn't turn a
// finished multi-GB upload into an error.
/** How often a running upload refreshes its stored card (lastProgressAt:
 *  markStaleUploads tells a live upload from a dead one by it). */
export const UPLOAD_HEARTBEAT_MS = 10_000;

const POST_JOBS_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000];

/**
 * POST /jobs (storage_key) gave no usable answer, but the server may
 * have created — and charged — the job anyway: the newest job in the
 * account's list with this file name, created since the request went
 * out (10 min of clock slack) and not tracked on this device yet.
 */
async function findJobCreatedFor(filename: string, sinceMs: number): Promise<string | null> {
  const jobs = await fetchServerJobs();
  if (!jobs) return null;
  const known = new Set([
    ...getActiveJobs().map((j) => j.jobId),
    ...getLibrary().map((e) => e.jobId),
  ]);
  const hit = jobs.find(
    (j) =>
      j.filename === filename &&
      !known.has(j.id) &&
      (toMs(j.created_at) ?? 0) >= sinceMs - 10 * 60_000,
  );
  return hit?.id ?? null;
}

export async function uploadJob(
  targetFile: File,
  settings: SettingsSource,
  selectedPreset: PresetId | null,
  { tempId, onPaywall, onCreated, onProgress, onEnd }: {
    /** The upload card's temporary id (uploadCard). */
    tempId: string;
    /** Billing refused the upload (402): the dialog with a way to a plan. */
    onPaywall: (pw: Paywall) => void;
    /** The job exists (its card replaced the upload's). */
    onCreated: (jobId: string) => void;
    /** Live progress of the upload card (memory only: uploadManager). */
    onProgress?: (tempId: string, pct: number, resuming: boolean) => void;
    /** The upload is over (job created or failed). */
    onEnd?: (tempId: string) => void;
  },
): Promise<void> {
  // Add a placeholder dashboard card while the upload is in flight.
  // The real backend job ID isn't known until POST /jobs returns, so
  // we use a temporary local ID and swap it in once the response
  // arrives. Poll loop skips uploading-phase cards so no ghost
  // requests are fired against a non-existent job.
  // (The caller — uploadManager — put the card up already: at once, so
  // the dashboard shows it the moment it opens.)
  const presetInfo = selectedPreset ? PRESETS[selectedPreset] : null;
  liveUploads.add(tempId);

  // Progress ticks (thousands on a multi-GB file) only go to the live
  // state (uploadManager, ~5/s); the stored card gets a heartbeat every
  // UPLOAD_HEARTBEAT_MS and every state change, never a tick.
  let lastUiUpdate = 0;
  let lastBeat = Date.now();
  // Set while the card says "resuming" (an interrupted upload of this
  // file continues); cleared if it starts over after all.
  let resumingFrom: number | null = null;
  const setPct = (pct: number) => {
    const now = Date.now();
    if (now - lastUiUpdate > 200 || pct >= 100) {
      lastUiUpdate = now;
      const startedOver = resumingFrom !== null && pct + 1 < resumingFrom;
      if (startedOver) resumingFrom = null;
      onProgress?.(tempId, pct, resumingFrom !== null);
      if (startedOver || now - lastBeat >= UPLOAD_HEARTBEAT_MS) {
        lastBeat = now;
        updateActiveJobV2(tempId, {
          uploadPct: pct,
          lastProgressAt: now,
          ...(startedOver ? { resuming: false } : {}),
        });
      }
    }
  };
  onProgress?.(tempId, 0, false);

  // Acquire a Wake Lock so the OS doesn't put the tab to sleep
  // mid-upload. iOS 16.4+ / Android Chrome 84+ / desktop most.
  // Silent no-op if unsupported (older iOS, private mode).
  let _wakeLock: { release: () => Promise<void> } | null = null;
  try {
    const nav = navigator as unknown as {
      wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
    };
    if (nav.wakeLock?.request) {
      _wakeLock = await nav.wakeLock.request("screen");
    }
  } catch {
    // ignore — unsupported, permission denied, or lost focus
  }

  try {
    // Two upload paths:
    //   - straight to R2 (lib/chunkedUpload: resumable multipart, or
    //     the single presigned PUT where the backend says so), then
    //     POST /jobs with the storage_key — for every size whenever
    //     this deployment has R2: a reload or a lost connection
    //     resumes, and the backend refuses (402 / 413 / 429 / 503)
    //     before any bytes are sent.
    //   - the legacy multipart POST /jobs through Railway, only when
    //     the backend has no R2 (503 that isn't server_busy) and the
    //     file fits its body limit (Railway's edge caps ~100 MB).
    const R2_THRESHOLD = 90 * 1024 * 1024; // 90MB
    let res: XMLHttpRequest | null = null;

    // An interrupted upload of this very file (same name, size, first
    // and last MiB): the card starts where it stopped.
    const resumedPct = await resumableProgress(targetFile);
    if (resumedPct !== null) {
      resumingFrom = resumedPct;
      onProgress?.(tempId, resumedPct, true);
      updateActiveJobV2(tempId, { uploadPct: resumedPct, resuming: true, lastProgressAt: Date.now() });
    }

    // An audio file: refused now, not after the upload (the server
    // answers 400 no_video once it probed it).
    if (targetFile.type.startsWith("audio/")) {
      throw new ApiError(400, "no_video", { detail: "no_video", code: "no_video", params: {} });
    }
    // Over the size / length limits (the deployment's, GET /config): say
    // so now instead of after the upload (the server would refuse it).
    // The length is read from the file's metadata; when the browser
    // can't, the server probes.
    const duration = await readVideoDuration(targetFile);
    const { limits } = await getConfig();
    const limit = uploadLimitHit(targetFile.size, duration, limits);
    if (limit) {
      throw new ApiError(limit.code === "video_too_short" ? 400 : 413, limit.code, {
        detail: limit.code,
        ...limit.params,
        code: limit.code,
        params: limit.params,
      });
    }
    // Stored with the job so the server-side project list has names.
    const appendJobFields = (form: FormData) => {
      form.append("filename", targetFile.name);
      // Read now — the moment the job is created (a change made during
      // the upload counts).
      form.append("settings", JSON.stringify(readSettings(settings)));
      if (selectedPreset) form.append("preset_id", selectedPreset);
      if (presetInfo) form.append("preset_label", tEn(presetInfo.labelKey));
    };

    let storageKey: string | null = null;
    // Forgets the upload's resume record — only once POST /jobs has
    // settled the upload (job created, or refused for good).
    let releaseUpload: (() => Promise<void>) | undefined;
    // The backend has no multipart API (a build from before WP3): its
    // POST /jobs downloads the object inside the request.
    let legacyApi = false;
    try {
      const up = await uploadResumable({
        file: targetFile,
        onProgress: (pct) => setPct(pct),
        duration,
      });
      storageKey = up.storage_key;
      releaseUpload = up.release;
      legacyApi = Boolean(up.legacyApi);
    } catch (e) {
      // 503 without R2 here → legacy upload; 503 server_busy is a
      // full queue and means "later", not "another way".
      const noR2 = e instanceof ApiError && e.status === 503 && e.code !== "server_busy";
      if (!(noR2 && targetFile.size <= R2_THRESHOLD)) throw e;
    }

    // Set when POST /jobs gave no usable answer but created the job.
    let createdJobId: string | null = null;
    if (storageKey) {
      // Create the job with the completed storage_key. The server
      // answers in about a second whatever the size (it only checks
      // and probes the object; the analysis downloads it), and POST
      // /jobs is idempotent on the key: a network error or a 5xx is
      // retried with the same key — never a second job or charge —
      // for about 75 s (a deploy restart, a 502 / 503 from the edge).
      // A backend from before WP3 (legacyApi) downloads the object
      // inside the request and isn't idempotent: one try, 30 min.
      const form = new FormData();
      form.append("storage_key", storageKey);
      appendJobFields(form);
      // The browser's reading of the length: charged when the file's
      // header has none (streamed WebM).
      if (duration) form.append("duration", String(duration));
      const postedAt = Date.now();
      const post = async () => {
        // Fetched per try: the token is short-lived.
        const auth = AUTH_ENABLED ? await authHeaders() : {};
        return new Promise<XMLHttpRequest>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${backendUrl()}/jobs`);
          for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
          xhr.timeout = legacyApi ? 30 * 60_000 : 120_000;
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.ontimeout = () => reject(new Error(tEn("app.errors.serverNoResponse")));
          xhr.send(form);
        });
      };
      let failure: unknown = null;
      const retryDelays = legacyApi ? [] : POST_JOBS_RETRY_MS;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
        failure = null;
        try {
          res = await post();
          // 503 server_busy / 507 are refusals (and 503
          // storage_unavailable a short outage: retried).
          if (res.status >= 500 && !REFUSAL_CODES.has(apiErrorFromText(res.status, res.responseText).code ?? "")) {
            failure = new Error(`Upload failed: ${res.responseText}`);
          }
        } catch (e) {
          failure = e;
        }
        if (failure === null) break;
      }
      if (failure !== null) {
        // Still no answer: with accounts on the job may exist anyway —
        // look for it in the account's project list.
        createdJobId = AUTH_ENABLED ? await findJobCreatedFor(targetFile.name, postedAt) : null;
        if (!createdJobId) throw failure;
      }
    } else {
      // Fetched now, i.e. after the upload attempt: the token is short-lived.
      const auth = AUTH_ENABLED ? await authHeaders() : {};
      // Legacy path — direct multipart upload to Railway.
      const form = new FormData();
      form.append("file", targetFile);
      appendJobFields(form);
      res = await new Promise<XMLHttpRequest>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${backendUrl()}/jobs`);
        for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
        // Abort when no upload progress arrives for a while, so a
        // dropped connection shows an error instead of hanging.
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const armStall = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            // Reject first: abort() fires onabort synchronously.
            reject(new Error(UPLOAD_STALLED_MSG));
            xhr.abort();
          }, UPLOAD_STALL_MS);
        };
        xhr.upload.onprogress = (ev) => {
          armStall();
          if (ev.lengthComputable) {
            setPct(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.upload.onload = () => clearTimeout(stallTimer);
        xhr.onload = () => {
          clearTimeout(stallTimer);
          resolve(xhr);
        };
        xhr.onerror = () => {
          clearTimeout(stallTimer);
          reject(new Error("Network error"));
        };
        xhr.onabort = () => {
          clearTimeout(stallTimer);
          reject(new Error("Upload aborted"));
        };
        armStall();
        xhr.send(form);
      });
    }

    if (releaseUpload) {
      // The upload's resume record goes once the job exists or the
      // server refused the upload for good (it deleted it: 400 / 402
      // / 413, or it's gone: 409 / 410). Kept for a network failure,
      // a 5xx, 401 (sign in again) and 429 (later): picking the file
      // again goes straight to POST /jobs.
      const s = createdJobId !== null ? 200 : (res?.status ?? 0);
      if ((s >= 200 && s < 300) || (s >= 400 && s < 500 && s !== 401 && s !== 429)) {
        try {
          await releaseUpload();
        } catch {
          /* the record expires with its ticket anyway */
        }
      }
    }
    if (createdJobId === null && res && res.status >= 400) {
      // 401 / 402 (plan, minutes) and the refusals (413 too big / too
      // long, 429 too many jobs, 503 busy, 507 full) get their own
      // handling below.
      const e = apiErrorFromText(res.status, res.responseText);
      if (res.status === 401 || res.status === 402 || REFUSAL_CODES.has(e.code ?? "")) throw e;
      throw new Error(`Upload failed: ${res.responseText}`);
    }
    const initial: Pick<JobStatus, "id"> =
      createdJobId !== null ? { id: createdJobId } : JSON.parse(res!.responseText);
    // Minutes were charged: the "min left" hints should follow.
    if (AUTH_ENABLED) void refreshMe();
    track("upload_done", {
      preset: selectedPreset ?? "custom",
      size_mb: Math.round(targetFile.size / 1e6),
      minutes: duration ? Math.round(duration / 6) / 10 : null,
      r2: storageKey !== null,
    });

    // Ask for notification permission on job start — user won't be
    // interrupted mid-task, and gets pinged when the render is done
    // even if the tab is in the background.
    requestNotificationPermission();

    // Swap the temporary uploading card for the real backend job.
    removeActiveJob(tempId);
    addActiveJob({
      jobId: initial.id,
      phase: "analyzing",
      timestamp: Date.now(),
      filename: targetFile.name,
      fileSize: targetFile.size,
      presetId: selectedPreset,
      presetLabel: presetInfo ? tEn(presetInfo.labelKey) : null,
      presetIcon: null,
      captionPreset: readSettings(settings).caption_preset ?? "",
    });

    // The job now lives as a card on the dashboard; the backend keeps
    // processing regardless of where the user goes next.
    onCreated(initial.id);
  } catch (err) {
    // Upload failed — mark the temp card with an error message so
    // the user can hit Retry from the dashboard. No fullscreen error
    // takeover, no scary redirect.
    // The card stores the code (lib/errors.ts words it): the backend's
    // (too big / too long / no sound / too many jobs / busy …) or the
    // browser's own (connection_lost, …).
    let failure = cardError(err);
    if (err instanceof ApiError && err.status === 401) {
      notifyAuthRequired();
      failure = cardError({ code: "auth_required" });
    } else if (err instanceof ApiError) {
      // No plan / not enough minutes: explain it with a way out.
      const pw = paywallFrom(err.status, err.detail);
      if (pw) {
        onPaywall(pw);
        failure = cardError({ code: pw.code });
      }
    }
    updateActiveJobV2(tempId, failure);
  } finally {
    liveUploads.delete(tempId);
    onEnd?.(tempId);
    // Release wake lock when upload path exits (success OR error).
    try {
      await _wakeLock?.release();
    } catch {
      // ignore
    }
  }
}
