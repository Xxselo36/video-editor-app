"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/Logo";
import { getLibrary, saveEntry, type LibraryHookClip } from "@/lib/library";
import { clearActiveJob, saveActiveJob, updateActiveJob } from "@/lib/activeJob";
import { notifyIfHidden, requestNotificationPermission } from "@/lib/notify";
import { trackSave, waitForSaves } from "@/lib/pendingSaves";
import { phrasesToUnits } from "@/features/editor/legacy/phraseUnits";
import {
  readVideoDuration,
  resumableProgress,
  uploadLimitHit,
  uploadResumable,
  UPLOAD_STALL_MS,
  UPLOAD_STALLED_MSG,
} from "@/lib/chunkedUpload";
import {
  addActiveJob,
  getActiveJobs,
  removeActiveJob,
  updateActiveJob as updateActiveJobV2,
  liveUploads,
} from "@/lib/activeJobs";
import { LanguageSwitcher, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { AUTH_ENABLED } from "@/lib/auth";
import {
  ApiError,
  apiError,
  apiErrorFromText,
  apiFetch,
  authHeaders,
  backendUrl,
  notifyAuthRequired,
  whenMediaReady,
} from "@/lib/api";
import {
  fetchServerJobs,
  paywallFrom,
  planName,
  refreshMe,
  toMs,
  useBillingConfig,
  useMe,
  type Paywall,
} from "@/lib/account";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { PaywallDialog } from "@/components/billing/PaywallDialog";
import { track } from "@/lib/analytics";
import {
  FRIENDLY_EXPIRED_KEY,
  friendlyError,
  jobErrorText,
  REFUSAL_CODES,
  refusalMessage,
  tEn,
} from "@/lib/errors.legacy";
import {
  phrasesFromSubtitlesResponse,
  type Phrase,
  type Subtitle,
} from "@/features/editor/legacy/buildPhrases";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import type { CutRange, JobStatus, SceneEvent } from "@/features/jobs/types";
import { fmtTime } from "@/features/editor/format";
import { ReviewScreen } from "@/features/editor/legacy/ReviewScreen";
import { ErrorView } from "@/features/project/ErrorView";
import { ConfigureScreen } from "@/features/start/ConfigureScreen";
import { IdleScreen } from "@/features/start/IdleScreen";
import { PickerScreen } from "@/features/start/PickerScreen";

// POST /jobs after an upload to R2: waits between tries on a network
// error or a 5xx that isn't a refusal — about 75 s in all, so a backend
// restart (every deploy) or a 502 / 503 from the edge doesn't turn a
// finished multi-GB upload into an error.
const POST_JOBS_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000];

type Phase =
  | "picker"
  | "idle"
  | "configuring"
  | "uploading"
  | "analyzing"
  | "reviewing"
  | "rendering"
  | "done"
  | "error";

export default function Home() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("picker");
  const [selectedPreset, setSelectedPreset] = useState<PresetId | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [captionPreset, setCaptionPreset] = useState("clean");
  const [cutStyle, setCutStyle] = useState("balanced");
  const [voiceTriggers, setVoiceTriggers] = useState(true);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [uploadPct, setUploadPct] = useState(0);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  // The job's word units (GET /subtitles): what the render gets, matched to
  // the edited sentences by phrasesToUnits (UX2).
  const unitsRef = useRef<Subtitle[]>([]);
  // Opening a job from the dashboard (may wait for a last save).
  const [resuming, setResuming] = useState(false);
  // Short info toast (e.g. "this video is still rendering").
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  };
  const [disabledCuts, setDisabledCuts] = useState<number[]>([]);
  const [smartcamEnabled, setSmartcamEnabled] = useState(false);
  const [smartcamFormat, setSmartcamFormat] = useState<"portrait" | "landscape">(
    "portrait",
  );
  const [outputFormats, setOutputFormats] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Upload refused by billing (402): dialog with the way to a plan.
  const [paywall, setPaywall] = useState<Paywall | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mount: always land on picker. Active jobs render as cards there —
  // no need to jump users into a fullscreen wait or rehydrate state.

  const pickPreset = (id: PresetId) => {
    const p = PRESETS[id];
    setSelectedPreset(id);
    setCaptionPreset(p.settings.captionPreset);
    setCutStyle(p.settings.cutStyle);
    setVoiceTriggers(p.settings.voiceTriggers);
    setRemoveFillers(p.settings.removeFillers);
    setSmartcamEnabled(p.settings.smartcamEnabled);
    setSmartcamFormat(p.settings.smartcamFormat);
    setOutputFormats(p.settings.outputFormats);
    setPhase("idle");
    // Open the file picker right after the idle screen mounted (the
    // file <input> is re-created by the phase switch, so clicking the
    // old one would lose the chosen file). Still within the tap's user
    // activation, so the browser allows it. Saves a whole screen; the
    // idle screen stays as fallback if the picker is cancelled.
    setOpenPickerNext(true);
  };
  const [openPickerNext, setOpenPickerNext] = useState(false);
  useLayoutEffect(() => {
    if (phase === "idle" && openPickerNext) {
      setOpenPickerNext(false);
      fileInputRef.current?.click();
    }
  }, [phase, openPickerNext]);

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChange = (f: File | null) => {
    if (!f) return;
    track("file_chosen", {
      preset: selectedPreset ?? "custom",
      size_mb: Math.round(f.size / 1e6),
      video: f.type.startsWith("video/"),
    });
    setFile(f);
    // Skip Configure screen when a non-custom preset was picked — settings
    // are already applied. Custom preset shows the Configure UI so the
    // user can tinker with every knob.
    const skip = selectedPreset && PRESETS[selectedPreset].skipConfigure;
    if (skip) {
      onProcess(f);
    } else {
      setPhase("configuring");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onFileChange(f);
  };

  const [downscalePct, setDownscalePct] = useState<number | null>(null);
  const [downscaleLabel, setDownscaleLabel] = useState<string | null>(null);

  const onProcess = async (fileOverride?: File) => {
    // Guard: a click event must never be treated as the file.
    let targetFile = fileOverride instanceof File ? fileOverride : file;
    if (!targetFile) return;
    if (!fileOverride) setFile(targetFile);
    // Skip the fullscreen "Uploading…" screen entirely. Upload runs in
    // the background; the dashboard card shows progress. This lets the
    // user browse, start another upload, or check other jobs while
    // this one uploads.
    setPhase("picker");
    setErrorMsg(null);
    setDownscalePct(null);

    // Client-side downscale removed: WASM ffmpeg was slower for a
    // typical user (2-5 min transcode) than just uploading raw and
    // letting the server's native ffmpeg downscale (~30-60s). Kept
    // the helper module in case we ever bring it back for extreme
    // low-bandwidth scenarios.

    // Resolve settings from preset when we're on the skip-configure path
    // (state may not have flushed yet when pickPreset + onFileChange
    // fire in rapid succession).
    const p = selectedPreset ? PRESETS[selectedPreset] : null;
    const applyPreset = p?.skipConfigure ?? false;

    const settings = {
      caption_preset: applyPreset ? p!.settings.captionPreset : captionPreset,
      style: applyPreset ? p!.settings.cutStyle : cutStyle,
      voice_triggers: applyPreset ? p!.settings.voiceTriggers : voiceTriggers,
      remove_fillers: applyPreset ? p!.settings.removeFillers : removeFillers,
      whisper_model: "medium",
      smartcam_enabled: applyPreset
        ? p!.settings.smartcamEnabled
        : smartcamEnabled,
      smartcam_format: applyPreset
        ? p!.settings.smartcamFormat
        : smartcamFormat,
      resolution: "1080",
      output_formats: applyPreset ? p!.settings.outputFormats : outputFormats,
    };

    // Add a placeholder dashboard card while the upload is in flight.
    // The real backend job ID isn't known until POST /jobs returns, so
    // we use a temporary local ID and swap it in once the response
    // arrives. Poll loop skips uploading-phase cards so no ghost
    // requests are fired against a non-existent job.
    const tempId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const presetInfo = selectedPreset ? PRESETS[selectedPreset] : null;
    addActiveJob({
      jobId: tempId,
      phase: "uploading",
      timestamp: Date.now(),
      filename: targetFile.name,
      fileSize: targetFile.size,
      presetId: selectedPreset,
      presetLabel: presetInfo ? tEn(presetInfo.labelKey) : null,
      presetIcon: presetInfo?.icon ?? null,
      captionPreset: settings.caption_preset,
      uploadPct: 0,
      lastProgressAt: Date.now(),
    });
    liveUploads.add(tempId);

    // Throttle uploadPct updates to ~5/sec. On big files (multi-GB) we
    // get thousands of progress ticks; every one used to write to
    // localStorage + fire a re-render across the dashboard.
    let lastUiUpdate = 0;
    // Set while the card says "resuming" (an interrupted upload of this
    // file continues); cleared if it starts over after all.
    let resumingFrom: number | null = null;
    const setPct = (pct: number) => {
      setUploadPct(pct);
      const now = Date.now();
      if (now - lastUiUpdate > 200 || pct >= 100) {
        lastUiUpdate = now;
        const startedOver = resumingFrom !== null && pct + 1 < resumingFrom;
        if (startedOver) resumingFrom = null;
        updateActiveJobV2(tempId, {
          uploadPct: pct,
          lastProgressAt: now,
          ...(startedOver ? { resuming: false } : {}),
        });
      }
    };

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
        setUploadPct(resumedPct);
        updateActiveJobV2(tempId, { uploadPct: resumedPct, resuming: true, lastProgressAt: Date.now() });
      }

      // Over the size / length caps: say so now instead of after the
      // upload (the server would answer 413). The length is read from
      // the file's metadata; when the browser can't, the server probes.
      const duration = await readVideoDuration(targetFile);
      const limit = uploadLimitHit(targetFile.size, duration);
      if (limit) {
        throw new ApiError(413, limit.code, {
          detail: limit.code,
          [limit.code === "file_too_large" ? "max_gb" : "max_minutes"]: limit.max,
        });
      }
      // Stored with the job so the server-side project list has names.
      const appendJobFields = (form: FormData) => {
        form.append("filename", targetFile.name);
        form.append("settings", JSON.stringify(settings));
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
      // Single-job activeJob kept for backward compat in case any
      // legacy code still checks it.
      removeActiveJob(tempId);
      saveActiveJob({
        jobId: initial.id,
        phase: "analyzing",
        timestamp: Date.now(),
        filename: targetFile.name,
        presetId: selectedPreset,
        presetLabel: presetInfo ? tEn(presetInfo.labelKey) : null,
        presetIcon: presetInfo?.icon ?? null,
        captionPreset: settings.caption_preset,
      });
      addActiveJob({
        jobId: initial.id,
        phase: "analyzing",
        timestamp: Date.now(),
        filename: targetFile.name,
        fileSize: targetFile.size,
        presetId: selectedPreset,
        presetLabel: presetInfo ? tEn(presetInfo.labelKey) : null,
        presetIcon: presetInfo?.icon ?? null,
        captionPreset: settings.caption_preset,
      });

      // Reset local state — the job now lives as a card on the
      // dashboard, backend keeps processing regardless of where the
      // user goes next.
      setFile(null);
      setSelectedPreset(null);
      setJob(null);
      setUploadPct(0);
    } catch (err) {
      // Upload failed — mark the temp card with an error message so
      // the user can hit Retry from the dashboard. No fullscreen error
      // takeover, no scary redirect.
      let msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 401) {
        notifyAuthRequired();
        msg = tEn("app.errors.signInRequired");
      } else if (err instanceof ApiError) {
        // No plan / not enough minutes: explain it with a way out.
        const pw = paywallFrom(err.status, err.detail);
        if (pw) {
          setPaywall(pw);
          msg = tEn(
            pw.code === "quota_exceeded"
              ? "app.errors.quotaExceeded"
              : "app.errors.subscriptionRequired",
          );
        } else {
          // Too big / too long / too many jobs / servers busy.
          msg = refusalMessage(err) ?? msg;
        }
      }
      updateActiveJobV2(tempId, { error: msg });
    } finally {
      liveUploads.delete(tempId);
      // Release wake lock when upload path exits (success OR error).
      try {
        await _wakeLock?.release();
      } catch {
        // ignore
      }
    }
  };

  // Polls during analyzing and rendering. On awaiting_review, fetch
  // subtitles and switch to the editor phase.
  useEffect(() => {
    if ((phase !== "analyzing" && phase !== "rendering") || !job) return;
    const id = setInterval(async () => {
      try {
        const r = await apiFetch(`/jobs/${job.id}`);
        if (!r.ok) return;
        const s: JobStatus = await r.json();
        setJob(s);
        if (s.status === "done") {
          setPhase("done");
          notifyIfHidden(
            t("app.notify.readyTitle"),
            file?.name ?? t("app.notify.clickToView"),
          );
          // Job finished — remove from active tracking, promote to Library
          clearActiveJob();
          // Persist to library so the user can find this render later
          // even after tab-close. Backend keeps files for a while.
          try {
            const p = selectedPreset ? PRESETS[selectedPreset] : null;
            const withOutputs = s as JobStatus & {
              outputs?: string[];
              social_caption?: string;
              social_hashtags?: string[];
              hook_clips?: LibraryHookClip[];
            };
            saveEntry({
              jobId: s.id,
              timestamp: Date.now(),
              presetId: selectedPreset,
              presetIcon: p?.icon ?? null,
              presetLabel: p ? tEn(p.labelKey) : null,
              filename: file?.name ?? t("app.library.untitled"),
              outputs: withOutputs.outputs ?? ["primary"],
              hookClips: withOutputs.hook_clips ?? [],
              socialCaption: withOutputs.social_caption ?? "",
              socialHashtags: withOutputs.social_hashtags ?? [],
            });
          } catch {
            /* library-save failure is non-fatal */
          }
        }
        else if (s.status === "error") {
          setErrorMsg(jobErrorText(s, t));
          setPhase("error");
          clearActiveJob();
        } else if (s.status === "awaiting_review" && phase === "analyzing") {
          const subRes = await apiFetch(`/jobs/${job.id}/subtitles`);
          if (subRes.ok) {
            const data = await subRes.json();
            unitsRef.current = data.subtitles ?? [];
            setPhrases(phrasesFromSubtitlesResponse(data));
            setPhase("reviewing");
            updateActiveJob({ phase: "reviewing" });
            notifyIfHidden(
              t("app.notify.reviewTitle"),
              t("app.notify.reviewBody"),
            );
          }
        }
      } catch {
        // transient — keep polling
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase, job]);

  // Transcript edits are saved (debounced) so they survive leaving the
  // job; GET /subtitles hands them back as `phrases` on re-entry.
  const phraseRevRef = useRef(0);
  const phraseSaveRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    jobId: string;
    phrases: Phrase[];
  } | null>(null);
  const sendPhrases = (jobId: string, list: Phrase[], unloading = false) => {
    // Increasing revision: the server ignores a save older than the
    // one it has, so out-of-order requests can't restore stale text.
    phraseRevRef.current = Math.max(phraseRevRef.current + 1, Date.now());
    const body = JSON.stringify({ phrases: list, rev: phraseRevRef.current });
    const p = apiFetch(`/jobs/${jobId}/phrases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: unloading && body.length < 60_000,
      unloading,
    }).catch(() => {});
    trackSave(jobId, p);
    return p;
  };
  const flushPhraseSave = (unloading = false) => {
    const pend = phraseSaveRef.current;
    if (!pend) return;
    if (pend.timer) clearTimeout(pend.timer);
    phraseSaveRef.current = null;
    void sendPhrases(pend.jobId, pend.phrases, unloading);
  };
  const schedulePhraseSave = (jobId: string, list: Phrase[]) => {
    const prev = phraseSaveRef.current;
    if (prev?.timer) clearTimeout(prev.timer);
    if (prev && prev.jobId !== jobId) void sendPhrases(prev.jobId, prev.phrases);
    phraseSaveRef.current = {
      jobId,
      phrases: list,
      timer: setTimeout(() => flushPhraseSave(), 800),
    };
  };
  useEffect(() => {
    const onHide = () => flushPhraseSave(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onApplyRender = async () => {
    if (!job) return;
    flushPhraseSave();
    // Word units with their source times, not one subtitle per sentence:
    // the burn highlights each word at its own time (UX2).
    const subtitles: Subtitle[] = phrasesToUnits(phrases, unitsRef.current);
    try {
      const r = await apiFetch(`/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitles,
          disabled_cuts: disabledCuts,
        }),
      });
      // 409: the job isn't in review any more — already exporting (a
      // double click, another tab) or finished. Its dashboard card shows
      // which; go there instead of an error screen.
      if (r.status === 409) showNotice(t("app.notice.alreadyExporting"));
      else if (!r.ok) throw await apiError(r);
      else track("export_started", { caption_style: captionPreset, lines: phrases.length });
      // Send user back to the dashboard — the card takes over from
      // here. No fullscreen "rendering" screen anymore.
      updateActiveJob({ phase: "rendering" });
      updateActiveJobV2(job.id, { phase: "rendering", note: undefined });
      setFile(null);
      setJob(null);
      setPhrases([]);
      setDisabledCuts([]);
      setUploadPct(0);
      setSelectedPreset(null);
      setPhase("picker");
    } catch (err) {
      // Mapped, never the raw answer (tech.md T3). A 401 has opened the
      // sign-in already (apiFetch).
      const raw = err instanceof ApiError ? (err.code ?? err.message) : err instanceof Error ? err.message : String(err);
      setErrorMsg(err instanceof ApiError && err.status === 401 ? t("app.errors.signInRequired") : friendlyError(raw, t));
      setPhase("error");
    }
  };

  // Browser history: every screen gets its own entry so the phone's
  // back gesture returns to the dashboard instead of leaving the app,
  // and the editor has its own URL (/app?job=…) so a reload reopens it.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const resetRef = useRef<() => void>(() => {});
  // Job id from the URL at load time (reload / shared editor link).
  const initialJobRef = useRef<string | null>(
    typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("job")
      : null,
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    const wantJob = phase === "reviewing" && job ? job.id : null;
    const onScreen = phase === "idle" || phase === "configuring" || phase === "reviewing";
    const st = window.history.state as { cleo?: string } | null;
    if (onScreen && st?.cleo !== phase) {
      if (wantJob) url.searchParams.set("job", wantJob);
      else url.searchParams.delete("job");
      window.history.pushState({ cleo: phase }, "", url);
    } else if (phase === "picker" && url.searchParams.has("job") && !initialJobRef.current) {
      url.searchParams.delete("job");
      window.history.replaceState({ cleo: "picker" }, "", url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, job?.id]);
  // Analytics: the editor opened (after an analysis or reopened).
  useEffect(() => {
    if (phase === "reviewing" && job?.id) track("editor_opened", { lines: phrases.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, job?.id]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const target = (e.state as { cleo?: string } | null)?.cleo ?? "picker";
      const cur = phaseRef.current;
      if (cur === "configuring" && target === "idle") setPhase("idle");
      else if (cur !== "picker" && target !== cur) resetRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Reload / shared link on the editor URL → reopen that job.
  useEffect(() => {
    const id = initialJobRef.current;
    if (id) void resumeJob(id).finally(() => { initialJobRef.current = null; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resumeJob = async (jobId: string) => {
    setResuming(true);
    try {
      // A save from the last visit may still be in flight —
      // load the state the user actually left.
      await waitForSaves(jobId, 8_000);
      const r = await apiFetch(`/jobs/${jobId}`);
      if (r.status === 404) {
        updateActiveJobV2(jobId, { error: tEn(FRIENDLY_EXPIRED_KEY) });
        return;
      }
      if (!r.ok) {
        // 401: sign-in opens (apiFetch); the job itself is fine.
        showNotice(t(r.status === 401 ? "app.errors.signInRequired" : "app.notice.loadFailed"));
        return;
      }
      const s: JobStatus = await r.json();
      if (s.status !== "awaiting_review") {
        // Rendering / done / failed: the dashboard card shows
        // the state — don't switch to an empty screen.
        showNotice(
          s.status === "done"
            ? t("app.notice.done")
            : s.status === "error"
              ? jobErrorText(s, t)
              : t("app.notice.processing"),
        );
        return;
      }
      // The editor's <video> needs the media token (accounts on) —
      // a tokenless first load would fail for good. Usually there within
      // the wait; if not, the editor sets its src once it arrives.
      if (AUTH_ENABLED) await whenMediaReady();
      setJob(s);
      {
        const subsRes = await apiFetch(`/jobs/${jobId}/subtitles`);
        if (subsRes.ok) {
          const sd = await subsRes.json();
          unitsRef.current = sd.subtitles ?? [];
          setPhrases(phrasesFromSubtitlesResponse(sd));
        }
        // Show the caption style this job renders with, not
        // whatever was last picked in this tab.
        if (s.caption_preset) setCaptionPreset(s.caption_preset);
        setPhase("reviewing");
      }
    } catch {
      showNotice(t("app.notice.offline"));
    } finally {
      setResuming(false);
    }
  };

  const reset = () => {
    flushPhraseSave();
    setFile(null);
    setJob(null);
    setPhrases([]);
    setDisabledCuts([]);
    setErrorMsg(null);
    setUploadPct(0);
    setSelectedPreset(null);
    setPhase("picker");
    clearActiveJob();
  };
  resetRef.current = reset;

  // Accounts + billing (all null / off with auth off).
  const { me } = useMe();
  const billing = useBillingConfig();
  const planBadge = billing?.enabled && me?.plan ? planName(me.plan, billing) : null;

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      <header
        className="flex flex-wrap items-center justify-between gap-y-2 px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            aria-label={t("app.header.homeAria")}
          >
            <LogoMark size={24} />
            <span className="text-xl font-bold tracking-tight">CleoCuts</span>
          </Link>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <PricingLink className="hidden sm:inline" />
          <Link
            href="/app/library"
            className="text-xs transition-colors hover:opacity-70"
            style={{ color: "var(--text-body)" }}
          >
            {t("app.header.library")}
          </Link>
          <LanguageSwitcher />
          {planBadge ? (
            // Paid plans live: the "Beta" badge becomes the plan badge.
            <Link
              href="/app/account"
              className="hidden rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest sm:inline-block"
              style={{
                background: "var(--brand-tint)",
                color: "var(--brand-strong)",
              }}
            >
              {planBadge}
            </Link>
          ) : (
            <span
              className="hidden rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest sm:inline-block"
              style={{
                background: "var(--brand-tint)",
                color: "var(--brand-strong)",
              }}
            >
              {t("app.header.beta")}
            </span>
          )}
          <AccountMenu />
        </div>
      </header>

      <div
        key={phase}
        className={`phase-fade mx-auto w-full flex-1 px-5 py-8 ${
          phase === "picker" ? "max-w-2xl" : phase === "reviewing" ? "max-w-3xl" : "max-w-md"
        }`}
      >
        {resuming && (
          <div
            className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-semibold"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-strong)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {t("app.header.opening")}
          </div>
        )}
        {notice && (
          <div
            role="status"
            data-testid="notice"
            onClick={() => setNotice(null)}
            className="fixed left-1/2 top-4 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl px-4 py-3 text-sm"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-strong)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {notice}
          </div>
        )}
        {phase === "picker" && (
          <PickerScreen
            onPick={pickPreset}
            onResumeJob={resumeJob}
          />
        )}

        {phase === "idle" && (
          <IdleScreen onPick={onPickFile} onDrop={onDrop} onBack={() => setPhase("picker")} />
        )}

        {paywall && <PaywallDialog paywall={paywall} onClose={() => setPaywall(null)} />}

        {phase === "configuring" && file && (
          <ConfigureScreen
            file={file}
            captionPreset={captionPreset}
            setCaptionPreset={setCaptionPreset}
            cutStyle={cutStyle}
            setCutStyle={setCutStyle}
            voiceTriggers={voiceTriggers}
            setVoiceTriggers={setVoiceTriggers}
            removeFillers={removeFillers}
            setRemoveFillers={setRemoveFillers}
            smartcamEnabled={smartcamEnabled}
            setSmartcamEnabled={setSmartcamEnabled}
            smartcamFormat={smartcamFormat}
            setSmartcamFormat={setSmartcamFormat}
            outputFormats={outputFormats}
            setOutputFormats={setOutputFormats}
            onProcess={onProcess}
            onBack={reset}
          />
        )}

        {phase === "reviewing" && job && (
          <ReviewScreen
            key={job.id}
            jobId={job.id}
            savedSegments={job.edit_segments ?? []}
            previewSegments={job.preview_segments ?? []}
            previewVersion={job.preview_version ?? 0}
            hasProxy={job.has_proxy}
            phrases={phrases}
            units={unitsRef}
            captionPreset={captionPreset}
            audioWarnings={job.audio_warnings ?? []}
            cutRanges={job.cut_ranges ?? []}
            duration={job.duration ?? 0}
            disabledCuts={disabledCuts}
            setDisabledCuts={setDisabledCuts}
            sceneEvents={job.scene_events ?? []}
            onSceneEventsChange={async (evts) => {
              try {
                const r = await apiFetch(`/jobs/${job.id}/recompute-scenes`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ events: evts }),
                });
                if (r.ok) {
                  const updated = await r.json();
                  setJob(updated);
                }
              } catch {
                // ignore
              }
            }}
            onChange={(next) => {
              setPhrases(next);
              schedulePhraseSave(job.id, next);
            }}
            onApply={onApplyRender}
            onBack={reset}
          />
        )}

        {/* rendering / done fullscreens killed — cards on picker are
            the single source of truth for post-upload status. */}

        {phase === "error" && (
          <ErrorView
            message={errorMsg ?? t("app.errors.title")}
            onReset={reset}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          data-testid="upload-input"
          className="sr-only"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
      </div>
    </main>
  );
}

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

/* Named stages so the user sees WHAT is happening, not raw ffmpeg
 * messages. Percentages match the backend's _stage() reports:
 *   analyze pipeline: 1→10 prep, 10→80 whisper, 80→95 cuts+LLM, 95→100 preview
 *   render pipeline:  0→80 segment burn, 80→95 stitch+formats, 95→100 hooks+done
 */
type Stage = { key: string; labelKey: MessageKey; from: number; to: number };
const ANALYZE_STAGES: Stage[] = [
  { key: "prep", labelKey: "app.progress.stage.prep", from: 0, to: 10 },
  { key: "listen", labelKey: "app.progress.stage.listen", from: 10, to: 80 },
  { key: "polish", labelKey: "app.progress.stage.polish", from: 80, to: 95 },
  { key: "preview", labelKey: "app.progress.stage.preview", from: 95, to: 100 },
];

const RENDER_STAGES: Stage[] = [
  { key: "burn", labelKey: "app.progress.stage.burn", from: 0, to: 70 },
  { key: "stitch", labelKey: "app.progress.stage.stitch", from: 70, to: 90 },
  { key: "finish", labelKey: "app.progress.stage.finish", from: 90, to: 100 },
];

function ProgressScreen({
  label,
  pct,
  phase,
}: {
  label: string;
  pct: number;
  phase?: "analyzing" | "rendering" | "uploading";
}) {
  const t = useT();
  const stages =
    phase === "rendering" ? RENDER_STAGES
    : phase === "analyzing" ? ANALYZE_STAGES
    : null;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-8">
      {/* Big overall percentage */}
      <div className="text-center">
        <div
          className="text-5xl font-bold tabular-nums"
          style={{ color: "var(--brand)" }}
        >
          {Math.round(pct)}
          <span className="text-2xl" style={{ color: "var(--text-muted)" }}>
            %
          </span>
        </div>
        <div
          className="mt-1 text-xs uppercase tracking-[0.2em]"
          style={{ color: "var(--text-muted)" }}
        >
          {phase === "uploading"
            ? t("app.progress.uploading")
            : phase === "rendering"
              ? t("app.progress.rendering")
              : t("app.progress.processing")}
        </div>
        {/* Live message — tells the user WHAT is happening right now
            (e.g. 'Optimizing video (56%)…', 'Clip 3/12…'). Was passed
            in as label but never rendered — user only saw the phase
            name so long transcode steps looked frozen. */}
        {label && (
          <div
            className="mt-3 text-sm"
            style={{ color: "var(--text-body)" }}
          >
            {label}
          </div>
        )}
        {/* iOS Safari kills background tabs after ~30s, aborting the
            upload. Explicit warning so users don't switch apps mid-
            upload and lose their progress. Only shown for the upload
            phase — rendering runs on the server and doesn't care. */}
        {phase === "uploading" && (
          <div
            className="mt-5 flex items-start gap-2 rounded-xl px-3 py-2 text-left"
            style={{
              background: "var(--warn)/10",
              border: "1px solid var(--warn)/30",
              color: "var(--warn)",
              maxWidth: "320px",
            }}
          >
            <div className="mt-0.5 shrink-0 text-base">⚠️</div>
            <div className="text-[11px] leading-relaxed">
              {t("app.upload.keepTabOpen")}
            </div>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div
        className="h-2 w-full max-w-sm overflow-hidden rounded-full"
        style={{ background: "var(--surface-2)" }}
      >
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{
            width: `${Math.max(0, Math.min(100, pct))}%`,
            background:
              "linear-gradient(90deg, var(--brand) 0%, var(--brand-hover) 100%)",
            boxShadow: "0 0 12px var(--brand-glow)",
          }}
        />
      </div>

      {/* Named stages checklist */}
      {stages && (
        <div className="flex w-full max-w-sm flex-col gap-2">
          {stages.map((s) => {
            const done = pct >= s.to;
            const active = pct >= s.from && pct < s.to;
            return (
              <div
                key={s.key}
                className="flex items-center gap-3 rounded-lg px-3 py-2 transition-all"
                style={{
                  background: active ? "var(--brand-tint)" : "transparent",
                  border: active
                    ? "1px solid var(--brand-hover)"
                    : "1px solid transparent",
                  opacity: !done && !active ? 0.35 : 1,
                }}
              >
                <div
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{
                    background: done
                      ? "var(--brand-solid)"
                      : active
                        ? "var(--brand-tint)"
                        : "var(--surface-2)",
                    color: done ? "white" : "var(--text-muted)",
                    border: active ? "2px solid var(--brand)" : "none",
                  }}
                >
                  {done ? "✓" : active ? (
                    <span
                      className="pulse-dot inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--brand)" }}
                    />
                  ) : ""}
                </div>
                <span
                  className="text-sm"
                  style={{
                    color: active
                      ? "var(--text-strong)"
                      : done
                        ? "var(--text-body)"
                        : "var(--text-muted)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {t(s.labelKey)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Timeline({
  duration,
  cuts,
  disabled,
  onToggle,
  playhead,
}: {
  duration: number;
  cuts: CutRange[];
  disabled: number[];
  onToggle: (id: number) => void;
  playhead?: number;
}) {
  const t = useT();
  const disabledSet = new Set(disabled);
  const totalCutSeconds = cuts
    .filter((c) => !disabledSet.has(c.id))
    .reduce((acc, c) => acc + (c.end - c.start), 0);
  const playheadPct =
    playhead !== undefined && duration > 0
      ? Math.max(0, Math.min(100, (playhead / duration) * 100))
      : null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
        <span>{t("app.timeline.cuts")}</span>
        <span className="text-[var(--text-faint)]">
          {t("app.timeline.cutsRemoved", { sec: totalCutSeconds.toFixed(1) })}
          {disabled.length > 0 && t("app.timeline.cutsRestored", { count: disabled.length })}
        </span>
      </div>
      <div className="relative h-3 overflow-visible rounded-full bg-[var(--success)]/30">
        {cuts.map((c) => {
          const leftPct = (c.start / duration) * 100;
          const widthPct = Math.max(
            0.6, // never thinner than ~6px on 1000px-wide screens
            ((c.end - c.start) / duration) * 100,
          );
          const isOff = disabledSet.has(c.id);
          return (
            <button
              key={c.id}
              onClick={() => onToggle(c.id)}
              title={t(
                isOff ? "app.timeline.cutTitleRemoveAgain" : "app.timeline.cutTitleRestore",
                { from: fmtTime(c.start), to: fmtTime(c.end) },
              )}
              className={`absolute top-1/2 -translate-y-1/2 h-5 cursor-pointer rounded-sm border border-black/40 transition-colors ${
                isOff
                  ? "bg-[var(--success)]/70 hover:bg-[var(--success)]"
                  : "bg-[var(--danger)]/85 hover:bg-[var(--danger)]"
              }`}
              style={{
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                minWidth: "6px",
              }}
            />
          );
        })}
        {playheadPct !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: `${playheadPct}%`,
              top: "-6px",
              bottom: "-6px",
              width: "2px",
              background: "var(--brand-hover)",
              boxShadow: "0 0 8px var(--brand-glow)",
              transform: "translateX(-50%)",
              zIndex: 10,
              borderRadius: "1px",
            }}
          />
        )}
      </div>
      <div className="mt-1 text-[10px] text-[var(--text-faint)]">
        {t("app.timeline.cutsLegend")}
      </div>
    </div>
  );
}

// Scene commands panel — shown in the review screen. Lists every
// detected Cleo-command (start/cut/keep/finish) with its timestamp
// and the raw Whisper text that triggered it. User can:
//   - toggle each event off (false positive)
//   - add a missing command at any timestamp via 'Add command'
//   - click timestamps to seek the video preview
// Changes are debounced then POSTed to /jobs/:id/recompute-scenes.
function SceneCommandsPanel({
  events,
  duration,
  onChange,
  onSeek,
}: {
  events: SceneEvent[];
  duration: number;
  onChange: (evts: SceneEvent[]) => void | Promise<void>;
  onSeek: (t: number) => void;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean[]>(() =>
    events.map(() => true),
  );
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState(false);

  // Reset local state when incoming events change (e.g. after
  // recompute) so toggles stay in sync.
  useEffect(() => {
    setEnabled(events.map(() => true));
  }, [events]);

  const COLORS: Record<SceneEvent["type"], string> = {
    start: "#5A9FFF",
    keep: "#4ECC77",
    restart: "#F26E6E",
    finish: "#B979FF",
  };
  const LABELS: Record<SceneEvent["type"], string> = {
    start: t("app.voice.scene.type.start"),
    keep: t("app.voice.scene.type.keep"),
    restart: t("app.voice.scene.type.restart"),
    finish: t("app.voice.scene.type.finish"),
  };

  const commit = async (nextEnabled: boolean[]) => {
    setPending(true);
    try {
      const filtered = events.filter((_, i) => nextEnabled[i]);
      await onChange(filtered);
    } finally {
      setPending(false);
    }
  };

  const toggle = (i: number) => {
    const next = [...enabled];
    next[i] = !next[i];
    setEnabled(next);
    void commit(next);
  };

  const addAt = async (at: number, type: SceneEvent["type"]) => {
    const kept = events.filter((_, i) => enabled[i]);
    const added: SceneEvent = {
      type,
      start: at,
      end: Math.min(at + 0.5, duration || at + 0.5),
      source: "user",
    };
    const next: SceneEvent[] = [...kept, added].sort(
      (a, b) => a.start - b.start,
    );
    setPending(true);
    setAddOpen(false);
    try {
      await onChange(next);
    } finally {
      setPending(false);
    }
  };

  const fmtT = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
            {t("app.voice.scene.heading", {
              count: events.filter((_, i) => enabled[i]).length,
            })}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
            {t("app.voice.scene.hint")}
          </div>
        </div>
        <button
          onClick={() => setAddOpen(!addOpen)}
          disabled={pending}
          className="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
            border: "1px solid var(--brand)/30",
          }}
        >
          {t("app.voice.scene.add")}
        </button>
      </div>

      {addOpen && (
        <div
          className="border-b p-3"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-0)",
          }}
        >
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            {t("app.voice.scene.addAt")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["start", "keep", "restart", "finish"] as const).map((type) => (
              <button
                key={type}
                onClick={() => {
                  const videoEl = document.querySelector(
                    "video",
                  ) as HTMLVideoElement | null;
                  const now = videoEl?.currentTime ?? 0;
                  void addAt(now, type);
                }}
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  background: "var(--surface-1)",
                  color: COLORS[type],
                  border: `1px solid ${COLORS[type]}66`,
                }}
              >
                {LABELS[type]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-[220px] overflow-y-auto p-2">
        {events.length === 0 && (
          <div className="p-3 text-center text-xs text-[var(--text-muted)]">
            {t("app.voice.scene.none")}
          </div>
        )}
        {events.map((ev, i) => {
          const on = enabled[i];
          return (
            <div
              key={`${ev.type}-${ev.start}-${i}`}
              className="mb-1 flex items-center gap-2 rounded-lg p-2 transition-colors"
              style={{
                background: on ? "var(--surface-0)" : "transparent",
                border: `1px solid ${on ? COLORS[ev.type] + "40" : "var(--border)"}`,
                opacity: on ? 1 : 0.5,
              }}
            >
              <button
                onClick={() => toggle(i)}
                disabled={pending}
                aria-label={on ? t("app.voice.scene.disable") : t("app.voice.scene.enable")}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors disabled:opacity-50"
                style={{
                  background: on ? COLORS[ev.type] : "var(--surface-2)",
                  color: on ? "white" : "var(--text-muted)",
                  border: `1px solid ${on ? COLORS[ev.type] : "var(--border)"}`,
                }}
              >
                {on ? "✓" : "○"}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: on ? "var(--text-strong)" : "var(--text-muted)" }}
                  >
                    {LABELS[ev.type]}
                  </span>
                  <button
                    onClick={() => onSeek(ev.start)}
                    className="text-[10px] tabular-nums text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                  >
                    ▸ {fmtT(ev.start)}
                  </button>
                </div>
                {ev.raw_text && (
                  <div className="mt-0.5 truncate text-[10px] text-[var(--text-faint)]">
                    {t("app.voice.scene.heard", { text: ev.raw_text })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
