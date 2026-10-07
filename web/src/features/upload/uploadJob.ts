/**
 * Upload a video and create its job, in the background (moved
 * from Home's onProcess in app/app/page.tsx, UX4). A dashboard card (or,
 * on the v2 opt-in, a Projects tile — ./records.ts) shows the upload and
 * then the job; a failed upload leaves the record with its error. A
 * cancelled one (UX12, `signal`) aborts the multipart upload and leaves
 * nothing. Never throws.
 */
import { refreshMe, fetchServerJobs, paywallFrom, toMs, type Paywall } from "@/lib/account";
import { track } from "@/lib/analytics";
import { ApiError, apiErrorFromText, authHeaders, backendUrl, notifyAuthRequired } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import {
  abortResumable,
  readVideoDuration,
  resumableProgress,
  uploadLimitHit,
  uploadResumable,
  UPLOAD_STALL_MS,
  UPLOAD_STALLED_MSG,
  waitRetry,
} from "@/lib/chunkedUpload";
import { getConfig } from "@/lib/config";
import { REFUSAL_CODES, tEn } from "@/lib/errors";
import { requestNotificationPermission } from "@/lib/notify";
import type { JobStatus } from "@/features/jobs/types";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { isMobile } from "@/features/start/ios";
import { readSettings, type SettingsSource } from "./settings";
import {
  knownJobIds,
  liveUploads,
  recordJobCreated,
  recordUploadFailed,
  removeStoppedUploads,
  removeUploadRecord,
  uploadProgress,
} from "./records";

export type { UploadSettings } from "./settings";

// POST /jobs after an upload to R2: waits between tries on a network
// error or a 5xx that isn't a refusal — about 75 s in all, so a backend
// restart (every deploy) or a 502 / 503 from the edge doesn't turn a
// finished multi-GB upload into an error.
/** How often a running upload refreshes its stored card (lastProgressAt:
 *  markStaleUploads tells a live upload from a dead one by it). */
export const UPLOAD_HEARTBEAT_MS = 10_000;

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const POST_JOBS_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000];
/** POST /jobs without an answer while the page is online and visible —
 *  a server bug can look like that (a 500 without CORS headers, a
 *  timeout) — is tried for this long, then the upload fails. */
export const POST_JOBS_NET_CAP_MS = 10 * 60_000;

/** POST /jobs' tries, as postJobsWithRetry ends them. `stopped`: Cancel
 *  while it waited for the connection — `inflight`, the try that was out
 *  then (its answer may still be a job). */
export type PostTried = {
  res: XMLHttpRequest | null;
  failure: unknown;
  stopped: boolean;
  inflight?: Promise<XMLHttpRequest>;
};

/** `p`, unless `signal` aborts first (an AbortError; `p` goes on). */
function unlessAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    const off = () => signal.removeEventListener("abort", onAbort);
    p.then(
      (v) => (off(), resolve(v)),
      (e) => (off(), reject(e)),
    );
  });
}

/** `p`, or a "Network error" after `ms` (a token fetch iOS left hanging
 *  is a failed try, not a stuck upload). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Network error")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * POST /jobs with retries (exported for the unit test). A 5xx: the ~75 s
 * of POST_JOBS_RETRY_MS. No answer at all: waited out for as long as the
 * connection or the page was really gone (`lost`: offline, or a phone's
 * page hidden since the last try — the key makes POST /jobs idempotent);
 * the time without an answer while nothing was gone adds up to
 * POST_JOBS_NET_CAP_MS, then it gives up (`failure`). Cancel (`signal`,
 * offered while it waits for the connection) stops it at once, also
 * during a try, and an answer that came after Cancel is the cancel's
 * unless it is the job (2xx: "couldn't be cancelled any more").
 */
export async function postJobsWithRetry(
  post: () => Promise<XMLHttpRequest>,
  {
    legacyApi = false,
    signal,
    setPaused,
    lost,
  }: {
    legacyApi?: boolean;
    signal?: AbortSignal;
    setPaused: (paused: boolean) => void;
    /** Was the connection or the page gone since the last try? (Asked
     *  once per failure.) */
    lost: () => boolean;
  },
): Promise<PostTried> {
  let res: XMLHttpRequest | null = null;
  let failure: unknown = null;
  let serverFails = 0;
  let netFails = 0;
  // The cap's clock: time between failures while nothing was gone.
  let onlineMs = 0;
  let lastFail = 0;
  let paused = false;
  const pause = (on: boolean) => {
    if (on !== paused) setPaused((paused = on));
  };
  for (;;) {
    failure = null;
    let net = false;
    let answer: XMLHttpRequest | null = null;
    const attempt = post();
    attempt.catch(() => {});
    try {
      answer = res = await unlessAborted(attempt, signal);
      pause(false);
      netFails = 0;
      onlineMs = lastFail = 0;
      // 503 server_busy / 507 are refusals (and 503
      // storage_unavailable a short outage: retried).
      if (res.status >= 500 && !REFUSAL_CODES.has(apiErrorFromText(res.status, res.responseText).code ?? "")) {
        failure = new Error(`Upload failed: ${res.responseText}`);
      }
    } catch (e) {
      if (signal?.aborted) return { res: null, failure: e, stopped: true, inflight: attempt };
      failure = e;
      net = true;
    }
    if (signal?.aborted && !(answer && answer.status >= 200 && answer.status < 300)) {
      return { res, failure, stopped: true };
    }
    if (failure === null || legacyApi) break;
    let wait: number;
    if (net) {
      netFails++;
      const now = Date.now();
      if (!lost()) {
        if (lastFail) onlineMs += now - lastFail;
        if (onlineMs >= POST_JOBS_NET_CAP_MS) break;
      }
      lastFail = now;
      if (netFails > 1) pause(true);
      wait = POST_JOBS_RETRY_MS[Math.min(netFails, POST_JOBS_RETRY_MS.length) - 1];
    } else {
      if (serverFails >= POST_JOBS_RETRY_MS.length) break;
      wait = POST_JOBS_RETRY_MS[serverFails++];
    }
    try {
      // (Waiting for the connection: at once when it is back.)
      await (net ? waitRetry(wait, signal) : sleep(wait));
    } catch {
      return { res, failure, stopped: true };
    }
  }
  pause(false);
  return { res, failure, stopped: false };
}

/** Wait `ms` — or less, when `signal` aborts meanwhile. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * POST /jobs (storage_key) gave no usable answer, but the server may
 * have created — and charged — the job anyway: the newest job in the
 * account's list with this file name, created since the request went
 * out (10 min of clock slack) and not tracked on this device yet. Asked
 * a few times (`delays`, ms between tries: ~5 s in all) — a job the
 * request created a moment ago may not be listed yet.
 */
export async function findJobCreatedFor(
  filename: string,
  sinceMs: number,
  delays: number[] = [1_500, 3_500],
): Promise<string | null> {
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    const jobs = await fetchServerJobs();
    if (!jobs) continue;
    const known = await knownJobIds();
    const hit = jobs.find(
      (j) =>
        j.filename === filename &&
        !known.has(j.id) &&
        (toMs(j.created_at) ?? 0) >= sinceMs - 10 * 60_000,
    );
    if (hit) return hit.id;
  }
  return null;
}

export async function uploadJob(
  targetFile: File,
  settings: SettingsSource,
  selectedPreset: PresetId | null,
  { tempId, signal, onPaywall, onCreated, onFailed, onStarting, onProgress, onPaused, onEnd }: {
    /** The upload record's temporary id (uploadCard). */
    tempId: string;
    /** Cancel (UX12): stops the upload and aborts it on the server. */
    signal?: AbortSignal;
    /** Billing refused the upload (402): the dialog with a way to a plan. */
    onPaywall: (pw: Paywall) => void;
    /** The job exists (its project replaced the upload record). */
    onCreated: (jobId: string) => void;
    /** The upload failed (not cancelled): its record says why. */
    onFailed?: () => void;
    /** The file is stored and POST /jobs goes out (UX12): from here on
     *  the job may exist on the server, so Cancel is no longer offered
     *  and `signal` is ignored. */
    onStarting?: () => void;
    /** Live progress of the upload card (memory only: uploadManager). */
    onProgress?: (tempId: string, pct: number, resuming: boolean) => void;
    /** Waiting for the connection (it continues by itself) / going again. */
    onPaused?: (tempId: string, paused: boolean) => void;
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
  // POST /jobs went out (or the legacy body is sent): see onStarting.
  let started = false;
  // Cancel came while POST /jobs waited for the connection (the tile
  // offers it then): no job from here.
  let stoppedWaiting = false;
  let lastBeat = Date.now();
  // Set while the card says "resuming" (an interrupted upload of this
  // file continues); cleared if it starts over after all.
  let resumingFrom: number | null = null;
  let lastPct = 0;
  // The stored card's heartbeat also while no bytes move (waiting for the
  // connection): another tab must not take it for a dead upload.
  // (Checked twice a period: a beat is never more than 1.5 periods old.)
  const beat = setInterval(() => {
    if (Date.now() - lastBeat < UPLOAD_HEARTBEAT_MS) return;
    lastBeat = Date.now();
    uploadProgress(tempId, { pct: lastPct, lastProgressAt: lastBeat, resuming: resumingFrom !== null });
  }, UPLOAD_HEARTBEAT_MS / 2);
  const setPaused = (paused: boolean) => onPaused?.(tempId, paused);
  const setPct = (pct: number) => {
    lastPct = pct;
    const now = Date.now();
    if (now - lastUiUpdate > 200 || pct >= 100) {
      lastUiUpdate = now;
      const startedOver = resumingFrom !== null && pct + 1 < resumingFrom;
      if (startedOver) resumingFrom = null;
      onProgress?.(tempId, pct, resumingFrom !== null);
      if (startedOver || now - lastBeat >= UPLOAD_HEARTBEAT_MS) {
        lastBeat = now;
        uploadProgress(tempId, {
          pct,
          lastProgressAt: now,
          resuming: resumingFrom !== null,
        });
      }
    }
  };
  onProgress?.(tempId, 0, false);

  // Acquire a Wake Lock so the OS doesn't put the tab to sleep
  // mid-upload. iOS 16.4+ / Android Chrome 84+ / desktop most.
  // Silent no-op if unsupported (older iOS, private mode). The browser
  // drops it when the page is hidden: taken again when it is back.
  type Lock = { release: () => Promise<void>; released?: boolean };
  let _wakeLock: Lock | null = null;
  let over = false;
  const lock = async () => {
    try {
      const nav = navigator as unknown as { wakeLock?: { request: (t: string) => Promise<Lock> } };
      if (over || !nav.wakeLock?.request || (_wakeLock && !_wakeLock.released)) return;
      if (document.visibilityState !== "visible") return;
      _wakeLock = await nav.wakeLock.request("screen");
      if (over) void _wakeLock.release().catch(() => {});
    } catch {
      // ignore — unsupported, permission denied, or lost focus
    }
  };
  // The page was hidden since POST /jobs' last try (iOS: Safari in the
  // background cuts it): a lost connection, not a server bug.
  let wasHidden = false;
  const onVisible = () => {
    if (document.visibilityState !== "visible") wasHidden = true;
    void lock();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  await lock();

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

    // An interrupted upload of these very bytes (size + first and last
    // 2 MiB, whatever the file is called now): the card starts where it
    // stopped, and the stopped tile of it goes (v2).
    const resumedPct = await resumableProgress(targetFile);
    if (resumedPct !== null) {
      resumingFrom = resumedPct;
      // The heartbeat and "waiting" writes carry it until bytes move.
      lastPct = resumedPct;
      lastBeat = Date.now();
      onProgress?.(tempId, resumedPct, true);
      uploadProgress(tempId, { pct: resumedPct, resuming: true, lastProgressAt: lastBeat });
      removeStoppedUploads(targetFile.size, tempId);
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
    // The project's record once the job exists.
    const jobInfo = () => ({
      filename: targetFile.name,
      fileSize: targetFile.size,
      presetId: selectedPreset,
      presetLabel: presetInfo ? tEn(presetInfo.labelKey) : null,
      captionPreset: readSettings(settings).caption_preset ?? "",
    });
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
        onPaused: (paused) => {
          setPaused(paused);
          lastBeat = Date.now();
          uploadProgress(tempId, { pct: lastPct, lastProgressAt: lastBeat, resuming: resumingFrom !== null });
        },
        signal,
        duration,
      });
      storageKey = up.storage_key;
      releaseUpload = up.release;
      legacyApi = Boolean(up.legacyApi);
    } catch (e) {
      if (signal?.aborted) throw e;
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
      // Cancelled as the upload finished: no POST at all.
      if (signal?.aborted) throw new Error("Upload aborted");
      // From here on the job may be created: no cancel any more.
      started = true;
      onStarting?.();
      const post = async () => {
        // Fetched per try (the token is short-lived), within 30 s.
        const auth = AUTH_ENABLED ? await withTimeout(authHeaders(), 30_000) : {};
        // Cancelled while it waited for the token: nothing goes out.
        if (signal?.aborted) throw new Error("Upload aborted");
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
      wasHidden = false;
      const tried = await postJobsWithRetry(post, {
        legacyApi,
        signal,
        setPaused,
        // A phone cuts a hidden page's requests; a desktop doesn't.
        lost: () => {
          const hidden = wasHidden || document.visibilityState !== "visible";
          wasHidden = false;
          return offline() || (hidden && isMobile(navigator));
        },
      });
      res = tried.res;
      const failure = tried.failure;
      if (tried.stopped) {
        // Cancel while it waited for the connection. The job may exist
        // anyway — made by the try still out, or by an earlier one whose
        // answer was lost: then it shows as "couldn't be cancelled any
        // more". Else the finished upload's record stays (it expires with
        // its ticket): picking the file again goes straight to POST /jobs
        // with the same key — never a second upload or job.
        stoppedWaiting = true;
        void (async () => {
          const late = await tried.inflight?.catch(() => null);
          let id: string | null = null;
          if (late && late.status >= 200 && late.status < 300) {
            try {
              id = (JSON.parse(late.responseText) as { id?: string }).id ?? null;
            } catch {
              /* not a job */
            }
          }
          if (!id && AUTH_ENABLED) id = await findJobCreatedFor(targetFile.name, postedAt);
          if (!id) return;
          recordJobCreated(tempId, id, jobInfo(), { cancelTooLate: true });
          await releaseUpload?.().catch(() => {});
          onCreated(id);
        })();
        throw new Error("Upload aborted");
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
        xhr.upload.onload = () => {
          clearTimeout(stallTimer);
          // The body is sent: the server creates the job now.
          started = true;
          onStarting?.();
        };
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
        signal?.addEventListener(
          "abort",
          () => {
            if (!started) xhr.abort();
          },
          { once: true },
        );
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

    // A cancel that came as the job was being created (the tile still
    // offered it): the backend can't stop a job, so it is shown under its
    // name with a note that it couldn't be cancelled any more.
    const cancelTooLate = Boolean(signal?.aborted);
    // The upload record becomes the project (the backend keeps
    // processing regardless of where the user goes next).
    recordJobCreated(tempId, initial.id, jobInfo(), { cancelTooLate });
    onCreated(initial.id);
  } catch (err) {
    if (signal?.aborted && (!started || stoppedWaiting)) {
      // Cancelled (UX12): the multipart upload goes too — the user gave
      // the file up; nothing is left on the list.
      removeUploadRecord(tempId);
      try {
        if (!started) await abortResumable({ file: targetFile });
      } catch {
        /* the bucket's lifecycle rule aborts it anyway */
      }
      return;
    }
    // Upload failed — the record keeps the code (lib/errors.ts words
    // it): the backend's (too big / too long / no sound / too many jobs /
    // busy …) or the browser's own (connection_lost, …), so the user can
    // try again.
    let failure: unknown = err;
    if (err instanceof ApiError && err.status === 401) {
      notifyAuthRequired();
      failure = { code: "auth_required" };
    } else if (err instanceof ApiError) {
      // No plan / not enough minutes: explain it with a way out.
      const pw = paywallFrom(err.status, err.detail);
      if (pw) {
        onPaywall(pw);
        failure = { code: pw.code };
      }
    }
    recordUploadFailed(tempId, failure);
    onFailed?.();
  } finally {
    over = true;
    clearInterval(beat);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    liveUploads.delete(tempId);
    onEnd?.(tempId);
    // Release wake lock when upload path exits (success OR error).
    try {
      await (_wakeLock as Lock | null)?.release();
    } catch {
      // ignore
    }
  }
}
