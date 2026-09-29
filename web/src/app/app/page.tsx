"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LogoMark } from "@/components/Logo";
import {
  IconArrowRight,
  IconCaptions,
  IconCheck,
  IconMic,
  IconPhone,
  IconSliders,
  IconVlog,
} from "@/components/Icons";
import {
  formatRelativeTime,
  getLibrary,
  saveEntry,
  type LibraryEntry,
  type LibraryHookClip,
} from "@/lib/library";
import {
  clearActiveJob,
  getActiveJob,
  saveActiveJob,
  updateActiveJob,
} from "@/lib/activeJob";
import { VideoModal } from "@/components/VideoModal";
import { notifyIfHidden, requestNotificationPermission } from "@/lib/notify";
import { trackSave, waitForSaves } from "@/lib/pendingSaves";
import { buildPlan, EditPlayer, probeProxy } from "@/lib/editPlayback";
import { sameTimeline, saveOutcome, type SaveOutcome, type TimelineSeg } from "@/lib/editSave";
import {
  MAX_MINUTES,
  MAX_UPLOAD_GB,
  readVideoDuration,
  uploadLimitHit,
  uploadResumable,
  UPLOAD_STALL_MS,
  UPLOAD_STALLED_MSG,
} from "@/lib/chunkedUpload";
import { fetchFullJob, JobStatusPoller, type StatusPollResult } from "@/lib/jobStatus";
import {
  addActiveJob,
  getActiveJobs,
  removeActiveJob,
  subscribeActiveJobs,
  updateActiveJob as updateActiveJobV2,
  liveUploads,
  markStaleUploads,
  type ActiveJobV2,
} from "@/lib/activeJobs";
import { LanguageSwitcher, translate, useLang, useT, type TFn } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { AUTH_ENABLED } from "@/lib/auth";
import {
  ApiError,
  apiErrorFromText,
  apiFetch,
  authHeaders,
  backendUrl,
  isMediaReady,
  mediaUrl,
  notifyAuthRequired,
  publicUrl,
  useMediaReady,
  useMediaUrl,
  whenMediaReady,
} from "@/lib/api";
import {
  fetchServerJobs,
  fmtMinutes,
  paywallFrom,
  planName,
  refreshMe,
  serverJobToLibraryEntry,
  toMs,
  useBillingConfig,
  useMe,
  type Paywall,
} from "@/lib/account";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { PaywallDialog } from "@/components/billing/PaywallDialog";

// English translator for text that gets PERSISTED (localStorage job
// cards / library entries). Stored text stays English and is mapped
// back to the viewer's language at render time (see localizeKnown).
const tEn: TFn = (key, vars) => translate("en", key, vars);

const FRIENDLY_EXPIRED_KEY = "app.errors.expired" as const;

// Messages we may have stored in English; shown translated on render.
const STORED_MESSAGE_KEYS: MessageKey[] = [
  "app.errors.expired",
  "app.errors.generic",
  "app.errors.connection",
  "app.errors.interrupted",
  "app.errors.tooLarge",
  "app.errors.noAudio",
  "app.errors.renderFailed",
  "app.errors.serverNoResponse",
  "app.errors.serverBusy",
  "app.errors.signInRequired",
  "app.errors.subscriptionRequired",
  "app.errors.quotaExceeded",
  "app.errors.unreadableVideo",
  "app.errors.fileTooLarge",
  "app.errors.videoTooLong",
  "app.errors.tooManyJobs",
  "app.card.renderFailedNote",
];
function localizeKnown(text: string, t: TFn): string {
  for (const key of STORED_MESSAGE_KEYS) {
    const vars = matchTemplate(translate("en", key), text);
    if (vars) return t(key, vars);
  }
  return text;
}

// The placeholder values when `text` is the English template `tpl`
// filled in ("…larger than {max} GB…" ↔ "…larger than 4 GB…"), else null.
function matchTemplate(tpl: string, text: string): Record<string, string> | null {
  if (!tpl.includes("{")) return tpl === text ? {} : null;
  const names: string[] = [];
  const src = tpl
    .split(/\{(\w+)\}/)
    .map((part, i) => {
      if (i % 2) {
        names.push(part);
        return "(.+?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const m = new RegExp(`^${src}$`).exec(text);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : null;
}

// Upload refusals the backend answers with a code (+ the limit), as the
// English text a card stores. Null for anything else.
const REFUSAL_CODES = new Set([
  "server_busy",
  "server_storage_full",
  "too_many_active_jobs",
  "file_too_large",
  "video_too_long",
]);
function refusalMessage(err: ApiError): string | null {
  switch (err.code) {
    case "server_busy":
    case "server_storage_full":
      return tEn("app.errors.serverBusy");
    case "too_many_active_jobs":
      return tEn("app.errors.tooManyJobs");
    case "file_too_large":
      return tEn("app.errors.fileTooLarge", { max: err.num("max_gb") ?? MAX_UPLOAD_GB });
    case "video_too_long":
      return tEn("app.errors.videoTooLong", { max: err.num("max_minutes") ?? MAX_MINUTES });
    default:
      return null;
  }
}

// Turn raw server/network errors into something a creator can act on.
// The technical text still goes to the console for debugging.
function friendlyError(raw: unknown, t: TFn): string {
  const txt = String(raw ?? "").trim();
  if (txt) console.warn("[cleocuts] error detail:", txt.slice(0, 500));
  const l = txt.toLowerCase();
  if (!txt) return t("app.errors.generic");
  // One of our own (stored in English) → current language.
  const known = localizeKnown(txt, t);
  if (known !== txt) return known;
  // Already a user-facing message (ours or the backend's).
  if (txt.endsWith(".") && /\b(Please|please)\b/.test(txt)) return txt;
  // transcription_unavailable: the speech service failed even after
  // retries (the minutes were refunded) — a "try again later" case too.
  if (l.includes("server_storage_full") || l.includes("507") || l.includes("server_busy")
      || l.includes("transcription_unavailable"))
    return t("app.errors.serverBusy");
  if (l.includes("too_many_active_jobs"))
    return t("app.errors.tooManyJobs");
  if (l.includes("file_too_large") || l.includes("video_too_long")) {
    // Raw answer text, e.g. `{"detail":"file_too_large","max_gb":4}`.
    const lim = (f: string) => Number(new RegExp(`"${f}"\\s*:\\s*([\\d.]+)`).exec(txt)?.[1]) || null;
    return l.includes("file_too_large")
      ? t("app.errors.fileTooLarge", { max: lim("max_gb") ?? MAX_UPLOAD_GB })
      : t("app.errors.videoTooLong", { max: lim("max_minutes") ?? MAX_MINUTES });
  }
  if (l.includes("unreadable_video"))
    return t("app.errors.unreadableVideo");
  // Accounts / billing (backend codes; only sent when switched on)
  if (l.includes("auth_required"))
    return t("app.errors.signInRequired");
  if (l.includes("subscription_required"))
    return t("app.errors.subscriptionRequired");
  if (l.includes("quota_exceeded"))
    return t("app.errors.quotaExceeded");
  if (l.includes("stalled") || l.includes("network") || l.includes("failed to fetch"))
    return t("app.errors.connection");
  if (l.includes("interrupted"))
    return t("app.errors.interrupted");
  if (l.includes("not found") || l.includes("404") || l.includes("no longer"))
    return t(FRIENDLY_EXPIRED_KEY);
  if (l.includes("413") || l.includes("too large"))
    return t("app.errors.tooLarge");
  if (l.includes("no audio") || l.includes("audio"))
    return t("app.errors.noAudio");
  if (l.includes("render"))
    return t("app.errors.renderFailed");
  return t("app.errors.generic");
}

const CAPTION_PRESETS: { id: string; labelKey: MessageKey }[] = [
  { id: "clean", labelKey: "app.captions.clean" },
  { id: "classic", labelKey: "app.captions.classic" },
  { id: "clipper", labelKey: "app.captions.clipper" },
  { id: "highlight", labelKey: "app.captions.highlight" },
  { id: "flash", labelKey: "app.captions.flash" },
  { id: "punch", labelKey: "app.captions.punch" },
  { id: "elegant", labelKey: "app.captions.elegant" },
  { id: "subtle", labelKey: "app.captions.subtle" },
  { id: "none", labelKey: "app.captions.none" },
];

// Display name of a caption preset id (falls back to the raw id).
function captionLabel(id: string, t: TFn): string {
  const c = CAPTION_PRESETS.find((x) => x.id === id);
  return c ? t(c.labelKey) : id;
}

const CUT_STYLES: { id: string; labelKey: MessageKey; descKey: MessageKey }[] = [
  { id: "tight", labelKey: "app.cutStyle.tight.label", descKey: "app.cutStyle.tight.desc" },
  { id: "balanced", labelKey: "app.cutStyle.balanced.label", descKey: "app.cutStyle.balanced.desc" },
  { id: "smooth", labelKey: "app.cutStyle.smooth.label", descKey: "app.cutStyle.smooth.desc" },
];

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

// Workflow presets — Tool-Picker cards on the /app landing.
// Each preset pre-loads a bundle of settings tuned for a use case.
// "custom" opens the full Configure screen for tinkerers.
type PresetId = "tiktok" | "podcast" | "captions" | "vlog" | "custom";

const PRESETS: Record<
  PresetId,
  {
    labelKey: MessageKey;
    icon: string;
    taglineKey: MessageKey;
    descKey: MessageKey;
    settings: {
      captionPreset: string;
      cutStyle: string;
      voiceTriggers: boolean;
      removeFillers: boolean;
      smartcamEnabled: boolean;
      smartcamFormat: "portrait" | "landscape";
      outputFormats: string[];
    };
    skipConfigure: boolean;
  }
> = {
  tiktok: {
    labelKey: "app.preset.tiktok.label",
    icon: "📱",
    taglineKey: "app.preset.tiktok.tagline",
    descKey: "app.preset.tiktok.desc",
    settings: {
      captionPreset: "clipper",
      cutStyle: "tight",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: true,
      smartcamFormat: "portrait",
      outputFormats: ["9:16"],
    },
    skipConfigure: true,
  },
  podcast: {
    labelKey: "app.preset.podcast.label",
    icon: "🎙",
    taglineKey: "app.preset.podcast.tagline",
    descKey: "app.preset.podcast.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "smooth",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "landscape",
      outputFormats: ["16:9", "9:16"],
    },
    skipConfigure: true,
  },
  vlog: {
    labelKey: "app.preset.vlog.label",
    icon: "✂️",
    taglineKey: "app.preset.vlog.tagline",
    descKey: "app.preset.vlog.desc",
    settings: {
      captionPreset: "subtle",
      cutStyle: "balanced",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: true,
  },
  captions: {
    labelKey: "app.preset.captions.label",
    icon: "💬",
    taglineKey: "app.preset.captions.tagline",
    descKey: "app.preset.captions.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "smooth",
      voiceTriggers: false,
      removeFillers: false,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: true,
  },
  custom: {
    labelKey: "app.preset.custom.label",
    icon: "🎛",
    taglineKey: "app.preset.custom.tagline",
    descKey: "app.preset.custom.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "balanced",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: false,
  },
};

// Label shown for a stored job/library entry: translated when the
// preset id is known, else whatever label was stored.
function presetLabelFor(
  presetId: string | null | undefined,
  stored: string | null | undefined,
  t: TFn,
): string | null {
  if (presetId && presetId in PRESETS) return t(PRESETS[presetId as PresetId].labelKey);
  return stored ?? null;
}

// What a dashboard card shows of its job (from GET /jobs/status).
type CardStatus = {
  progress: number;
  message: string;
  status: string;
  /** Place in line while waiting for a free server slot. */
  queuePosition: number | null;
};

// Dashboard status poll: every 2 s, every 5 s after a minute unchanged.
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 5000;
const POLL_BACKOFF_AFTER_MS = 60_000;

type JobStatus = {
  id: string;
  status:
    | "pending"
    | "processing"
    | "awaiting_review"
    | "done"
    | "error"
    | "cancelled";
  message: string;
  progress: number;
  error: string | null;
  has_output: boolean;
  audio_warnings?: string[];
  audio_levels?: { mean_db?: number | null; max_db?: number | null };
  duration?: number;
  cut_ranges?: CutRange[];
  scene_events?: SceneEvent[];
  // The user's saved timeline (job.segments + effects). Seed the editor
  // from this — cut_ranges only describe the automatic cuts.
  edit_segments?: SavedSeg[];
  // Segments the served preview.mp4 was built from + its version.
  preview_segments?: [number, number][];
  preview_version?: number;
  // GET /jobs/{id}/proxy-video exists: the editor plays it and applies
  // the edit itself (lib/editPlayback). Missing = unknown, probed.
  has_proxy?: boolean;
  caption_preset?: string | null;
};

type SavedSeg = {
  start: number;
  end: number;
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  volume?: number;
};

// Transcript as returned by GET /subtitles: the user's saved edits when
// present, otherwise sentences grouped from Whisper's fragments.
function phrasesFromSubtitlesResponse(data: {
  subtitles?: Subtitle[];
  phrases?: Phrase[] | null;
}): Phrase[] {
  if (Array.isArray(data.phrases)) return data.phrases;
  return buildPhrases(data.subtitles ?? []);
}

type SceneEvent = {
  type: "start" | "restart" | "keep" | "finish";
  start: number;
  end: number;
  raw_text?: string;
  source?: "exact" | "phonetic" | "llm" | "user";
};

type Subtitle = {
  start: number;
  end: number;
  text: string;
  original_start?: number;
  original_end?: number;
  confidence?: number;
};

type Phrase = {
  start: number;
  end: number;
  original_start: number;
  original_end: number;
  text: string;
  confidence: number;
};

type CutRange = {
  id: number;
  start: number;
  end: number;
};

type HookClip = {
  key: string;
  title: string;
  reason: string;
  start: number;
  end: number;
};

// Group Whisper's short fragments (1-3 words each) into readable
// sentences. Mirrors plugins/premiere/panel/index.html:buildPhrases.
const SENTENCE_END = /[.!?…]["'»)\]]*\s*$/;
const MAX_WORDS_PER_PHRASE = 10;
const MAX_GAP_SECONDS = 1.5;

function buildPhrases(subs: Subtitle[]): Phrase[] {
  const phrases: Phrase[] = [];
  let curIndices: number[] = [];

  const wordCount = (text: string) =>
    (text || "").trim().split(/\s+/).filter(Boolean).length;

  const flush = () => {
    if (curIndices.length === 0) return;
    const first = subs[curIndices[0]];
    const last = subs[curIndices[curIndices.length - 1]];
    const confSum = curIndices.reduce(
      (acc, i) => acc + (subs[i].confidence ?? 1),
      0,
    );
    phrases.push({
      start: first.start,
      end: last.end,
      original_start: first.original_start ?? first.start,
      original_end: last.original_end ?? last.end,
      confidence: confSum / curIndices.length,
      text: curIndices
        .map((i) => (subs[i].text || "").trim())
        .join(" "),
    });
    curIndices = [];
  };

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.text || !s.text.trim()) continue;
    if (curIndices.length === 0) {
      curIndices.push(i);
      continue;
    }
    const prev = subs[curIndices[curIndices.length - 1]];
    const gap = s.start - prev.end;
    const endsSentence = SENTENCE_END.test((prev.text || "").trim());
    const wordsSoFar = curIndices.reduce(
      (n, idx) => n + wordCount(subs[idx].text),
      0,
    );
    if (
      endsSentence ||
      gap > MAX_GAP_SECONDS ||
      wordsSoFar + wordCount(s.text) > MAX_WORDS_PER_PHRASE
    ) {
      flush();
    }
    curIndices.push(i);
  }
  flush();
  return phrases;
}

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
    const setPct = (pct: number) => {
      setUploadPct(pct);
      const now = Date.now();
      if (now - lastUiUpdate > 200 || pct >= 100) {
        lastUiUpdate = now;
        updateActiveJobV2(tempId, { uploadPct: pct, lastProgressAt: now });
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
      //   - presigned R2 PUT direct from browser → then POST /jobs with
      //     the storage_key so backend fetches from R2. For >90MB
      //     (Railway's edge caps HTTP bodies around 100MB) and, with
      //     accounts on, for every size: the ~60 s session token would
      //     expire during a slow multipart upload (the backend checks it
      //     after the body), and presign answers 402 before any bytes.
      //   - otherwise legacy multipart POST /jobs (through Railway),
      //     also when this deployment has no R2 (presign 503).
      const R2_THRESHOLD = 90 * 1024 * 1024; // 90MB
      let res: XMLHttpRequest | null = null;

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
      if (targetFile.size > R2_THRESHOLD || AUTH_ENABLED) {
        try {
          // Single presigned PUT to R2 (see lib/chunkedUpload).
          ({ storage_key: storageKey } = await uploadResumable({
            file: targetFile,
            onProgress: (pct) => setPct(pct),
            duration,
          }));
        } catch (e) {
          // 503 without R2 here → legacy upload; 503 server_busy is a
          // full queue and means "later", not "another way".
          const noR2 = e instanceof ApiError && e.status === 503 && e.code !== "server_busy";
          if (!(noR2 && targetFile.size <= R2_THRESHOLD)) throw e;
        }
      }
      // Fetched now, i.e. after the R2 PUT: the token is short-lived.
      const auth = AUTH_ENABLED ? await authHeaders() : {};

      // Set when POST /jobs gave no usable answer but created the job.
      let createdJobId: string | null = null;
      if (storageKey) {
        // Create the job with the completed storage_key.
        const form = new FormData();
        form.append("storage_key", storageKey);
        appendJobFields(form);
        const postedAt = Date.now();
        const post = new Promise<XMLHttpRequest>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${backendUrl()}/jobs`);
          for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
          // The server answers after pulling the file from R2 and probing
          // it — minutes for multi-GB files — and with accounts on it has
          // charged the minutes by then: don't give up early.
          xhr.timeout = AUTH_ENABLED ? 30 * 60_000 : 120_000;
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.ontimeout = () => reject(new Error(tEn("app.errors.serverNoResponse")));
          xhr.send(form);
        });
        if (!AUTH_ENABLED) {
          res = await post;
        } else {
          // No answer (timeout, dropped connection) or a proxy 5xx doesn't
          // mean no job: look for it in the account's project list before
          // reporting a failure — a retry would charge the minutes again.
          let failure: unknown = null;
          try {
            res = await post;
            // 503 server_busy / 507 are refusals: no job to look for.
            if (res.status >= 500 && !REFUSAL_CODES.has(apiErrorFromText(res.status, res.responseText).code ?? "")) {
              failure = new Error(`Upload failed: ${res.responseText}`);
            }
          } catch (e) {
            failure = e;
          }
          if (failure !== null) {
            createdJobId = await findJobCreatedFor(targetFile.name, postedAt);
            if (!createdJobId) throw failure;
          }
        }
      } else {
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
          setErrorMsg(s.error ?? s.message);
          setPhase("error");
          clearActiveJob();
        } else if (s.status === "awaiting_review" && phase === "analyzing") {
          const subRes = await apiFetch(`/jobs/${job.id}/subtitles`);
          if (subRes.ok) {
            const data = await subRes.json();
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
    // Flatten phrases back to the subtitle shape the renderer expects.
    // One subtitle per phrase, spanning its original time range.
    const subtitles: Subtitle[] = phrases
      .filter((p) => p.text.trim().length > 0)
      .map((p) => ({
        start: p.start,
        end: p.end,
        text: p.text.trim(),
        original_start: p.original_start,
        original_end: p.original_end,
      }));
    try {
      const r = await apiFetch(`/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitles,
          disabled_cuts: disabledCuts,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
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
      setErrorMsg(err instanceof Error ? err.message : String(err));
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
              ? friendlyError(s.error ?? s.message, t)
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

  const currentPreset = selectedPreset ? PRESETS[selectedPreset] : null;
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
          {currentPreset && phase !== "picker" && (
            <>
              <span style={{ color: "var(--text-faint)" }}>/</span>
              <button
                onClick={reset}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
                style={{
                  color: "var(--brand-strong)",
                  background: "var(--brand-tint)",
                }}
              >
                <span>{t(currentPreset.labelKey)}</span>
                <span style={{ color: "var(--brand-strong)", opacity: 0.6 }}>✕</span>
              </button>
            </>
          )}
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
          <ErrorScreen
            message={errorMsg ?? t("app.errors.title")}
            onReset={reset}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
      </div>
    </main>
  );
}

// Maps preset ids → icon component. Emoji-free so the picker reads
// professional instead of like a Notion doc.
const PRESET_ICONS: Record<PresetId, (p: { size?: number; className?: string; strokeWidth?: number }) => React.ReactNode> = {
  tiktok: IconPhone,
  podcast: IconMic,
  vlog: IconVlog,
  captions: IconCaptions,
  custom: IconSliders,
};

// What each preset actually does — used as feature bullets in the card
// so the user sees the value up front, not just a vague label.
const PRESET_BULLETS: Record<PresetId, MessageKey[]> = {
  tiktok: [
    "app.preset.tiktok.bullet1",
    "app.preset.tiktok.bullet2",
    "app.preset.tiktok.bullet3",
  ],
  podcast: [
    "app.preset.podcast.bullet1",
    "app.preset.podcast.bullet2",
    "app.preset.podcast.bullet3",
  ],
  vlog: [
    "app.preset.vlog.bullet1",
    "app.preset.vlog.bullet2",
    "app.preset.vlog.bullet3",
  ],
  captions: [
    "app.preset.captions.bullet1",
    "app.preset.captions.bullet2",
    "app.preset.captions.bullet3",
  ],
  custom: [
    "app.preset.custom.bullet1",
    "app.preset.custom.bullet2",
    "app.preset.custom.bullet3",
  ],
};

// Per-preset ambient accent — colored radial glow on each card's
// top-right corner. Gives each workflow a distinct visual identity
// without changing the base surface color.
const PRESET_ACCENTS: Record<PresetId, string> = {
  tiktok: "rgba(236, 72, 153, 0.55)",   // pink — TikTok energy
  podcast: "rgba(139, 92, 246, 0.55)",  // violet — brand
  vlog: "rgba(56, 189, 248, 0.45)",     // sky — outdoor / camera
  captions: "rgba(168, 85, 247, 0.5)",  // purple — text focus
  custom: "rgba(139, 92, 246, 0.35)",
};

function getPresetChips(p: (typeof PRESETS)[PresetId], t: TFn): string[] {
  const chips: string[] = [];

  // Aspect ratios — primary is smartcam format if enabled, else outputs
  const ratios = new Set<string>();
  if (p.settings.smartcamEnabled) {
    ratios.add(p.settings.smartcamFormat === "portrait" ? "9:16" : "16:9");
  }
  p.settings.outputFormats.forEach((f) => ratios.add(f));
  if (ratios.size > 0) {
    chips.push(Array.from(ratios).join(" · "));
  }

  // Caption style
  const capKey = CAPTION_PRESETS.find(
    (c) => c.id === p.settings.captionPreset,
  )?.labelKey;
  if (capKey && p.settings.captionPreset !== "none") {
    chips.push(t("app.picker.chipCaptions", { style: t(capKey) }));
  } else if (p.settings.captionPreset === "none") {
    chips.push(t("app.captions.none"));
  }

  // Voice triggers indicator
  if (p.settings.voiceTriggers) {
    chips.push(t("app.picker.chipVoice"));
  }

  return chips;
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

/** Billing on: minutes left this period (→ account), or — when uploads
 *  need a plan — the way to one (→ pricing). Null otherwise. */
function useBillingHint(): { href: string; text: string } | null {
  const t = useT();
  const lang = useLang();
  const { me } = useMe();
  const billing = useBillingConfig();
  if (!billing?.enabled || !me?.billing?.enabled) return null;
  if (me.minutes) {
    return {
      href: "/app/account",
      text: t("app.billing.minutesLeft", { n: fmtMinutes(Math.max(0, me.minutes.remaining), lang) }),
    };
  }
  if (!me.plan && me.billing.enforce) return { href: "/pricing", text: t("app.billing.choosePlan") };
  return null;
}

function PickerScreen({
  onPick,
  onResumeJob,
}: {
  onPick: (id: PresetId) => void;
  onResumeJob?: (jobId: string) => void;
}) {
  const t = useT();
  const billingHint = useBillingHint();
  const featured: PresetId[] = ["tiktok", "podcast", "vlog", "captions"];
  const [recent, setRecent] = useState<LibraryEntry[] | null>(null);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  const [showVoiceOnboarding, setShowVoiceOnboarding] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJobV2[]>([]);
  const [jobStatuses, setJobStatuses] = useState<Record<string, CardStatus>>({});
  // Dashboard (jobs + recent) is the home for returning users. The
  // workflow picker is its own screen — reached via "+ New video" and
  // returned from via ← Back. First-time users skip the empty
  // dashboard and land straight on the picker.
  const [view, setView] = useState<"dashboard" | "picker">("picker");

  useEffect(() => {
    const rec = getLibrary().slice(0, 3);
    const jobs = getActiveJobs();
    setRecent(rec);
    setActiveJobs(jobs);
    if (jobs.length > 0 || rec.length > 0) setView("dashboard");
    // The voice test (camera + mic) is NOT opened automatically any
    // more — it scared off people who only want to upload a video.
    // It's one tap away via the "Cleo" hint chip.
  }, []);

  // Accounts on: the server knows this user's projects from every
  // device. Finished ones join "Recent", unfinished ones get a card
  // (the poll below keeps it current).
  useEffect(() => {
    if (!AUTH_ENABLED) return;
    let cancelled = false;
    void fetchServerJobs().then((list) => {
      if (cancelled || !list) return;
      const known = new Set(getActiveJobs().map((j) => j.jobId));
      // Oldest first: addActiveJob puts each new card on top.
      for (const s of [...list].reverse()) {
        if (known.has(s.id)) continue;
        if (!["pending", "processing", "awaiting_review"].includes(s.status)) continue;
        addActiveJob({
          jobId: s.id,
          phase:
            s.status === "awaiting_review"
              ? "reviewing"
              : s.message?.toLowerCase().includes("render")
                ? "rendering"
                : "analyzing",
          timestamp: (s.created_at ?? Date.now() / 1000) * 1000,
          filename: s.filename || tEn("app.library.untitled"),
          presetId: s.preset_id ?? null,
          presetLabel: s.preset_label ?? null,
          presetIcon: null,
          captionPreset: "clean",
        });
      }
      const done = list.filter((s) => s.has_output).map(serverJobToLibraryEntry);
      if (done.length > 0) {
        const ids = new Set(done.map((e) => e.jobId));
        setRecent(
          [...done, ...getLibrary().filter((e) => !ids.has(e.jobId))]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 3),
        );
        setView("dashboard");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // React to add/update/remove from anywhere in the app (uploads
  // starting, progress ticks, jobs finishing). Bumps to dashboard only
  // when a job is ADDED so the user sees their upload land — progress
  // ticks used to bump too, which threw the user out of the workflow
  // picker ("+ New video") while another job was running. Counting
  // (not ids) because an upload card swaps its temp id for the real one.
  const jobCountRef = useRef(0);
  useEffect(() => {
    jobCountRef.current = getActiveJobs().length;
    const refresh = () => {
      const jobs = getActiveJobs();
      setActiveJobs(jobs);
      if (jobs.length > jobCountRef.current) setView("dashboard");
      jobCountRef.current = jobs.length;
    };
    return subscribeActiveJobs(refresh);
  }, []);

  // Upload cards left over from a reload / closed tab never finish —
  // flip them to error cards so the user can clear them and retry.
  useEffect(() => {
    markStaleUploads();
    const id = setInterval(() => markStaleUploads(), 10_000);
    return () => clearInterval(id);
  }, []);

  // Live status for the cards: ONE GET /jobs/status for all of them per
  // tick (lib/jobStatus — 304 while nothing changed), with chained
  // timeouts so ticks never pile up behind a slow backend. Not polled:
  // uploading cards (no job yet), error cards and cards in review —
  // nothing changes there until the user acts. Review cards are checked
  // once when the dashboard opens, so an expired project or a render
  // started on another device still shows. Paused while the tab is
  // hidden; every 2 s, every 5 s after a minute without any change.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const poller = new JobStatusPoller();
    let cancelled = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastChange = Date.now();
    let checkReview = true;
    const polled = (j: ActiveJobV2) =>
      j.phase !== "uploading" && j.phase !== "reviewing" && !j.error;
    const polledIds = () => getActiveJobs().filter(polled).map((j) => j.jobId);
    let known = new Set(polledIds());

    const apply = async (cards: ActiveJobV2[], res: StatusPollResult) => {
      const missing = new Set(res.missing);
      const rows = new Map(res.rows.map((r) => [r.id, r]));
      const updates: typeof jobStatuses = {};
      for (const j of cards) {
        if (missing.has(j.jobId)) {
          // Server no longer knows the job (redeploy / expired).
          updateActiveJobV2(j.jobId, { error: tEn(FRIENDLY_EXPIRED_KEY) });
          continue;
        }
        const s = rows.get(j.jobId);
        if (!s) continue;
        updates[j.jobId] = {
          progress: s.progress,
          message: s.message,
          status: s.status,
          queuePosition: s.queue_position,
        };
        if (s.status === "awaiting_review" && (j.phase !== "reviewing" || (s.error && !j.note))) {
          updateActiveJobV2(j.jobId, {
            phase: "reviewing",
            note: s.error
              ? tEn("app.card.renderFailedNote")
              : undefined,
          });
        } else if (
          s.status === "processing" &&
          (j.phase === "reviewing" ||
            (j.phase === "analyzing" && s.message.toLowerCase().includes("render")))
        ) {
          // Rendering (a review card: started on another device / tab).
          updateActiveJobV2(j.jobId, { phase: "rendering" });
        } else if (s.status === "done") {
          // The status rows are minimal: the library entry needs the
          // outputs, captions and hook clips of the full job.
          const full = s.full ?? (await fetchFullJob(j.jobId));
          if (cancelled) return;
          if (!full) continue; // next tick retries
          try {
            const withOutputs = full as {
              outputs?: string[] | Record<string, string>;
              social_caption?: string;
              social_hashtags?: string[];
              hook_clips?: LibraryHookClip[];
            };
            const outputKeys = Array.isArray(withOutputs.outputs)
              ? withOutputs.outputs
              : withOutputs.outputs && typeof withOutputs.outputs === "object"
                ? Object.keys(withOutputs.outputs)
                : ["primary"];
            saveEntry({
              jobId: j.jobId,
              timestamp: Date.now(),
              presetId: j.presetId,
              presetIcon: j.presetIcon,
              presetLabel: j.presetLabel,
              filename: j.filename,
              outputs: outputKeys,
              hookClips: withOutputs.hook_clips ?? [],
              socialCaption: withOutputs.social_caption ?? "",
              socialHashtags: withOutputs.social_hashtags ?? [],
            });
            notifyIfHidden(tRef.current("app.notify.readyTitle"), j.filename);
          } catch {
            /* library save is non-fatal */
          }
          removeActiveJob(j.jobId);
          // Show the finished video right away under "Zuletzt".
          setRecent(getLibrary().slice(0, 3));
        } else if (s.status === "error") {
          updateActiveJobV2(j.jobId, {
            error: friendlyError(s.error ?? s.message, tEn),
          });
        }
      }
      if (!cancelled && res.changed) setJobStatuses((prev) => ({ ...prev, ...updates }));
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (cancelled || document.hidden || polledIds().length === 0) return;
      const quiet = Date.now() - lastChange > POLL_BACKOFF_AFTER_MS;
      timer = setTimeout(() => void tick(), quiet ? POLL_SLOW_MS : POLL_FAST_MS);
    };

    const tick = async (): Promise<void> => {
      clearTimeout(timer);
      timer = undefined;
      if (cancelled || document.hidden) return;
      if (running) {
        again = true; // right after the request in flight
        return;
      }
      const cards = getActiveJobs().filter(
        (j) => polled(j) || (checkReview && j.phase === "reviewing" && !j.error),
      );
      checkReview = false;
      if (cards.length > 0) {
        running = true;
        try {
          const res = await poller.poll(cards.map((j) => j.jobId));
          if (res && !cancelled) {
            if (res.changed) lastChange = Date.now();
            await apply(cards, res);
          }
        } catch {
          /* offline / transient — next tick retries */
        } finally {
          running = false;
        }
      }
      if (again) {
        again = false;
        return tick();
      }
      schedule();
    };

    // A card joined the polled set (upload finished, render started):
    // its status right away, and quick ticks again.
    const unsubscribe = subscribeActiveJobs(() => {
      const ids = polledIds();
      const added = ids.some((id) => !known.has(id));
      known = new Set(ids);
      if (added) {
        lastChange = Date.now();
        void tick();
      }
    });
    // Hidden tab: no requests. Back: fresh status now, quick ticks again.
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      lastChange = Date.now();
      void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Runs for the dashboard's lifetime; reads the cards on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissVoiceOnboarding = () => {
    setShowVoiceOnboarding(false);
    try {
      localStorage.setItem("cleocuts.voiceOnboardingSeen.v1", "1");
    } catch {
      // ignore
    }
  };

  if (view === "dashboard") {
    return (
      <div className="relative z-10 flex flex-col">
        {/* Dashboard header — logo/tagline on the left, primary CTA on
            the right. This screen is deliberately jobs-only; the
            workflow picker lives on its own screen. */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.15em]"
              style={{ color: "var(--text-muted)" }}
            >
              {t("app.dashboard.workspace")}
            </div>
            <h1
              className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl"
              style={{ color: "var(--text-strong)" }}
            >
              {activeJobs.length > 0
                ? t(
                    activeJobs.length === 1
                      ? "app.dashboard.inProgressCountOne"
                      : "app.dashboard.inProgressCountOther",
                    { count: activeJobs.length },
                  )
                : t("app.dashboard.readyWhenYouAre")}
            </h1>
          </div>
          <button
            onClick={() => setView("picker")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-0.5"
            style={{
              background: "var(--brand)",
              color: "#0f0f0f",
            }}
          >
            <span className="text-base leading-none">+</span>
            {t("app.dashboard.newVideo")}
          </button>
        </div>

        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div className="mb-10">
            <div
              className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em]"
              style={{ color: "var(--text-muted)" }}
            >
              {t("app.dashboard.inProgress")}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {activeJobs.map((j) => (
                <ActiveJobCard
                  key={j.jobId}
                  job={j}
                  status={jobStatuses[j.jobId]}
                  onOpen={() => onResumeJob?.(j.jobId)}
                  onRetry={() => {
                    removeActiveJob(j.jobId);
                    setActiveJobs(getActiveJobs());
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Recent projects */}
        {recent && recent.length > 0 && (
          <div className="mb-10">
            <div className="mb-3 flex items-center justify-between">
              <div
                className="text-[11px] font-semibold uppercase tracking-[0.15em]"
                style={{ color: "var(--text-muted)" }}
              >
                {t("app.dashboard.recentProjects")}
              </div>
              <Link
                href="/app/library"
                className="text-xs transition-opacity hover:opacity-70"
                style={{ color: "var(--brand-strong)" }}
              >
                {t("app.dashboard.viewAll")}
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {recent.map((entry) => (
                <RecentProjectCard
                  key={entry.jobId}
                  entry={entry}
                  onPlay={setPlayingJobId}
                />
              ))}
            </div>
          </div>
        )}

        {/* Empty state — no jobs and no library entries yet */}
        {activeJobs.length === 0 && (!recent || recent.length === 0) && (
          <button
            onClick={() => setView("picker")}
            className="flex items-center gap-4 rounded-2xl p-6 text-left transition-colors"
            style={{
              background: "var(--surface-1)",
              border: "1px dashed var(--border-hover)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--brand)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border-hover)";
            }}
          >
            <div
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "var(--brand-tint)", color: "var(--brand)" }}
            >
              <IconArrowRight size={22} strokeWidth={2.5} />
            </div>
            <div>
              <div
                className="text-base font-bold"
                style={{ color: "var(--text-strong)" }}
              >
                {t("app.dashboard.startFirst")}
              </div>
              <div
                className="text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {t("app.dashboard.startFirstSub")}
              </div>
            </div>
          </button>
        )}

        {/* Voice teaser pinned at the bottom of the dashboard so it
            stays a reminder without competing with the CTA. */}
        <button
          onClick={() => setShowVoiceOnboarding(true)}
          className="mt-2 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
            border: "1px solid var(--brand)/30",
          }}
        >
          <IconMic size={14} strokeWidth={2.5} />
          {t("app.dashboard.voiceTeaser")}
          <span className="opacity-70">→</span>
        </button>

        {playingJobId && (
          <VideoModal
            jobId={playingJobId}
            onClose={() => setPlayingJobId(null)}
          />
        )}
        {showVoiceOnboarding && (
          <VoiceCommandsModal onClose={dismissVoiceOnboarding} />
        )}
      </div>
    );
  }

  return (
    <div className="relative z-10 flex flex-col">
      {/* Back to dashboard — only rendered when there's a dashboard to
          go back to (existing jobs or library entries). Fresh users
          land here directly and don't see the back button. */}
      {(activeJobs.length > 0 || (recent && recent.length > 0)) && (
        <button
          onClick={() => setView("dashboard")}
          className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="text-base leading-none">←</span>
          {t("app.picker.backToDashboard")}
        </button>
      )}

      {/* Hero */}
      <div className="mb-10">
        {billingHint ? (
          // Paid plans live: minutes left (or the way to a plan) instead
          // of "Free during beta".
          <Link
            href={billingHint.href}
            className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium transition-opacity hover:opacity-80"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-hover)",
              color: "var(--text-body)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {billingHint.text}
          </Link>
        ) : (
          <div
            className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-hover)",
              color: "var(--text-body)",
            }}
          >
            <span
              className="pulse-dot inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {t("app.picker.freeDuringBeta")}
          </div>
        )}

        <h1
          className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl"
          style={{ color: "var(--text-strong)" }}
        >
          {t("app.picker.title")}
        </h1>
        <p
          className="max-w-md text-base leading-relaxed"
          style={{ color: "var(--text-body)" }}
        >
          {t("app.picker.subtitle")}
        </p>

        {/* Voice-commands teaser — link to the onboarding modal so
            users can always re-open the cheat sheet. */}
        <button
          onClick={() => setShowVoiceOnboarding(true)}
          className="mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
            border: "1px solid var(--brand)/30",
          }}
        >
          <IconMic size={14} strokeWidth={2.5} />
          {t("app.dashboard.voiceTeaser")}
          <span className="opacity-70">→</span>
        </button>
      </div>

      {/* Preset grid — big cards with per-preset accent glow + config chips */}
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {featured.map((id) => {
          const p = PRESETS[id];
          const Icon = PRESET_ICONS[id];
          const accent = PRESET_ACCENTS[id];
          const chips = getPresetChips(p, t);
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              className="group relative flex flex-col overflow-hidden rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5"
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                minHeight: "180px",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--brand-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {/* Ambient accent glow — top-right corner */}
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-40 blur-2xl transition-opacity group-hover:opacity-70"
                style={{ background: accent }}
              />

              {/* Icon + hover-arrow */}
              <div className="relative z-10 mb-4 flex items-start justify-between">
                <div
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    background: "var(--brand-tint)",
                    color: "var(--brand)",
                  }}
                >
                  <Icon size={24} strokeWidth={2} />
                </div>
                <span
                  className="translate-x-0 opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100"
                  style={{ color: "var(--brand)" }}
                >
                  <IconArrowRight size={18} strokeWidth={2.5} />
                </span>
              </div>

              {/* Title + tagline */}
              <div className="relative z-10 mb-4 flex-1">
                <div
                  className="mb-1 text-base font-bold"
                  style={{ color: "var(--text-strong)" }}
                >
                  {t(p.labelKey)}
                </div>
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t(p.taglineKey)}
                </div>
              </div>

              {/* Config chips — actual settings this preset applies */}
              <div className="relative z-10 flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--text-body)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom setup — separated, distinct dashed treatment */}
      <button
        onClick={() => onPick("custom")}
        className="mt-4 flex items-center gap-3 rounded-2xl p-4 text-left transition-colors"
        style={{
          background: "transparent",
          border: "1px dashed var(--border-hover)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
          e.currentTarget.style.background = "var(--surface-1)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border-hover)";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <div
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
        >
          <IconSliders size={18} strokeWidth={2} />
        </div>
        <div className="flex-1">
          <div
            className="text-sm font-semibold"
            style={{ color: "var(--text-strong)" }}
          >
            {t("app.picker.customTitle")}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {t("app.picker.customSub")}
          </div>
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          <IconArrowRight size={14} strokeWidth={2} />
        </span>
      </button>

      {playingJobId && (
        <VideoModal
          jobId={playingJobId}
          onClose={() => setPlayingJobId(null)}
        />
      )}

      {showVoiceOnboarding && (
        <VoiceCommandsModal onClose={dismissVoiceOnboarding} />
      )}
    </div>
  );
}

/* Recent-project tile: thumbnail on top, meta below. Click plays the
 * video in the shared modal — same UX as the Library cards. */
function RecentProjectCard({
  entry,
  onPlay,
}: {
  entry: LibraryEntry;
  onPlay: (jobId: string) => void;
}) {
  const t = useT();
  const [thumbFailed, setThumbFailed] = useState(false);
  // null until the media token is known (accounts on).
  const thumbSrc = useMediaUrl(entry.jobId, "thumbnail");
  return (
    <button
      onClick={() => onPlay(entry.jobId)}
      className="group flex flex-col overflow-hidden rounded-xl text-left transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="relative w-full overflow-hidden"
        style={{
          aspectRatio: "9 / 16",
          background: "var(--surface-2)",
        }}
      >
        {!thumbFailed && thumbSrc && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={thumbSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
            loading="lazy"
          />
        )}
        {thumbFailed && (
          <div
            className="flex h-full w-full items-center justify-center text-[9px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--text-faint)" }}
          >
            {t("app.card.noPreview")}
          </div>
        )}
        {/* Preset chip pinned bottom-left over the thumbnail */}
        <div className="absolute bottom-1.5 left-1.5">
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            style={{
              background: "rgba(0,0,0,0.7)",
              color: "var(--brand-strong)",
              backdropFilter: "blur(4px)",
            }}
          >
            {presetLabelFor(entry.presetId, entry.presetLabel, t) ?? t("app.preset.custom.label")}
          </span>
        </div>
        {/* Play triangle on hover */}
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        >
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{
              background: "rgba(0,0,0,0.7)",
              backdropFilter: "blur(4px)",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </div>
      <div className="p-2">
        <div
          className="mb-0.5 truncate text-xs font-semibold"
          style={{ color: "var(--text-strong)" }}
        >
          {entry.filename || t("app.library.untitled")}
        </div>
        <div
          className="text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          {formatRelativeTime(entry.timestamp)}
        </div>
      </div>
    </button>
  );
}

function IdleScreen({
  onPick,
  onDrop,
  onBack,
}: {
  onPick: () => void;
  onDrop: (e: React.DragEvent) => void;
  onBack: () => void;
}) {
  const t = useT();
  const billingHint = useBillingHint();
  return (
    <div className="relative z-10 flex flex-col">
      <button
        onClick={onBack}
        className="mb-4 -ml-2 w-fit rounded-lg px-2 py-2 text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        {t("app.upload.back")}
      </button>
      <h1
        className="mb-2 text-4xl font-bold tracking-tight sm:text-5xl"
        style={{ color: "var(--text-strong)" }}
      >
        {t("app.upload.title")}
      </h1>
      <p className="mb-8 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("app.upload.hint")}
      </p>
      {billingHint && (
        <Link
          href={billingHint.href}
          className="-mt-5 mb-6 w-fit text-xs font-medium transition-opacity hover:opacity-80"
          style={{ color: "var(--brand-strong)" }}
        >
          {billingHint.text} →
        </Link>
      )}

      <button
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="group w-full rounded-2xl px-6 py-16 text-center transition-all hover:scale-[1.01]"
        style={{
          background: "var(--surface-1)",
          border: "2px dashed var(--border-strong)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--brand)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
        }}
      >
        <div
          className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl transition-transform group-hover:scale-110"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand)",
          }}
        >
          <IconPhone size={26} strokeWidth={2} />
        </div>
        <div
          className="text-base font-bold"
          style={{ color: "var(--text-strong)" }}
        >
          {t("app.upload.tapToChoose")}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("app.upload.orDrag")}
        </div>
      </button>
    </div>
  );
}

// Labels are aspect ratios (not translated); descriptions are keys.
const EXPORT_FORMAT_OPTIONS: { id: string; label: string; descKey: MessageKey }[] = [
  { id: "9:16", label: "9:16", descKey: "app.format.9x16.desc" },
  { id: "1:1", label: "1:1", descKey: "app.format.1x1.desc" },
  { id: "16:9", label: "16:9", descKey: "app.format.16x9.desc" },
];

function ConfigureScreen(props: {
  file: File;
  captionPreset: string;
  setCaptionPreset: (s: string) => void;
  cutStyle: string;
  setCutStyle: (s: string) => void;
  voiceTriggers: boolean;
  setVoiceTriggers: (b: boolean) => void;
  removeFillers: boolean;
  setRemoveFillers: (b: boolean) => void;
  smartcamEnabled: boolean;
  setSmartcamEnabled: (b: boolean) => void;
  smartcamFormat: "portrait" | "landscape";
  setSmartcamFormat: (f: "portrait" | "landscape") => void;
  outputFormats: string[];
  setOutputFormats: (f: string[]) => void;
  onProcess: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const sizeMB = (props.file.size / 1024 / 1024).toFixed(1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button
          onClick={props.onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          {t("app.configure.back")}
        </button>
        <div className="truncate text-xs text-[var(--text-body)]">
          {t("app.configure.fileInfo", { name: props.file.name, size: sizeMB })}
        </div>
      </div>

      <Section title={t("app.configure.captionStyle")}>
        <div className="grid grid-cols-2 gap-2">
          {CAPTION_PRESETS.map((p) => {
            const selected = props.captionPreset === p.id;
            return (
              <button
                key={p.id}
                onClick={() => props.setCaptionPreset(p.id)}
                className={`overflow-hidden rounded-xl border text-left transition-colors ${
                  selected
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={publicUrl(`/caption-previews/${p.id}.png?w=320&h=110`)}
                  alt={t("app.configure.captionPreviewAlt", { style: t(p.labelKey) })}
                  className="block h-[64px] w-full bg-[var(--surface-1)] object-cover"
                  loading="lazy"
                />
                <div className="px-3 py-2 text-xs font-medium">{t(p.labelKey)}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t("app.configure.cutStyle")}>
        <div className="grid grid-cols-3 gap-2">
          {CUT_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => props.setCutStyle(s.id)}
              className={`rounded-xl border px-2 py-3 text-left transition-colors ${
                props.cutStyle === s.id
                  ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                  : "border-[var(--border)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="text-xs font-medium">{t(s.labelKey)}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{t(s.descKey)}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title={t("app.configure.cleanup")}>
        <ToggleRow
          label={t("app.configure.voiceTriggers")}
          desc={t("app.configure.voiceTriggersDesc")}
          checked={props.voiceTriggers}
          onChange={props.setVoiceTriggers}
        />
        <ToggleRow
          label={t("app.configure.removeFillers")}
          desc={t("app.configure.removeFillersDesc")}
          checked={props.removeFillers}
          onChange={props.setRemoveFillers}
        />
      </Section>

      <Section title={t("app.configure.smartReframe")}>
        <ToggleRow
          label={t("app.configure.smartcam")}
          desc={t("app.configure.smartcamDesc")}
          checked={props.smartcamEnabled}
          onChange={props.setSmartcamEnabled}
        />
        {props.smartcamEnabled && (
          <div className="grid grid-cols-2 gap-2">
            {(["portrait", "landscape"] as const).map((f) => (
              <button
                key={f}
                onClick={() => props.setSmartcamFormat(f)}
                className={`rounded-xl border px-3 py-3 text-left text-xs transition-colors ${
                  props.smartcamFormat === f
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                <div className="font-medium capitalize">
                  {f === "portrait" ? t("app.configure.portrait") : t("app.configure.landscape")}
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {f === "portrait" ? t("app.configure.portraitDesc") : t("app.configure.landscapeDesc")}
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("app.configure.extraFormats")}>
        <div className="text-[10px] text-[var(--text-muted)] -mt-1">
          {t("app.configure.extraFormatsHint")}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {EXPORT_FORMAT_OPTIONS.map((f) => {
            const on = props.outputFormats.includes(f.id);
            return (
              <button
                key={f.id}
                onClick={() =>
                  props.setOutputFormats(
                    on
                      ? props.outputFormats.filter((x) => x !== f.id)
                      : [...props.outputFormats, f.id],
                  )
                }
                className={`rounded-xl border px-2 py-3 text-left transition-colors ${
                  on
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                <div className="text-xs font-medium">{f.label}</div>
                <div className="text-[10px] text-[var(--text-muted)]">{t(f.descKey)}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <button
        onClick={() => props.onProcess()}
        // Sticky on phones: the options list is ~2 screens tall.
        className="sticky bottom-3 z-20 mt-2 w-full rounded-xl bg-[var(--brand)] px-6 py-4 text-base font-semibold shadow-lg hover:bg-[var(--brand-hover)] active:scale-[0.99]"
      >
        {t("app.configure.process")}
      </button>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-left hover:border-[var(--border-strong)]"
    >
      <div>
        <div className="text-sm">{label}</div>
        {desc && <div className="text-[10px] text-[var(--text-muted)]">{desc}</div>}
      </div>
      <div
        className={`h-6 w-10 rounded-full p-0.5 transition-colors ${
          checked ? "bg-[var(--brand)]" : "bg-[var(--surface-tint)]"
        }`}
      >
        <div
          className={`h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </div>
    </button>
  );
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
                      ? "var(--brand)"
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

function DoneScreen({
  jobId,
  outputs,
  socialCaption,
  socialHashtags,
  hookClips,
  onReset,
}: {
  jobId: string;
  outputs: string[];
  socialCaption: string;
  socialHashtags: string[];
  hookClips: HookClip[];
  onReset: () => void;
}) {
  const t = useT();
  const formatLabel = (f: string) =>
    f === "primary" ? t("app.done.downloadPrimary") : t("app.done.downloadFormat", { format: f });
  const formatSub = (f: string) => {
    const opt = EXPORT_FORMAT_OPTIONS.find((o) => o.id === f);
    return opt ? t(opt.descKey) : t("app.done.mainEdit");
  };

  const watchSrc = useMediaUrl(jobId, "watch");
  const posterSrc = useMediaUrl(jobId, "thumbnail");
  const hashtagLine = socialHashtags
    .map((h) => `#${h.replace(/^#/, "")}`)
    .join(" ");
  const copyText = (text: string) => {
    if (!text) return;
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center gap-5 py-4">
      {/* Peak-moment preview: user sees their finished video inline
          before scrolling to Download. Autoplay muted + playsInline
          works in iOS Safari; poster falls back to the thumbnail. */}
      <div
        className="w-full max-w-[360px] overflow-hidden rounded-2xl"
        style={{
          background: "#000",
          border: "1px solid var(--border-hover)",
          boxShadow:
            "0 0 0 1px rgba(139,92,246,0.25), 0 12px 40px rgba(139,92,246,0.28)",
        }}
      >
        {watchSrc && (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <video
            src={watchSrc}
            poster={posterSrc ?? undefined}
            controls
            autoPlay
            muted
            loop
            playsInline
            className="block w-full"
            style={{ maxHeight: "60vh" }}
          />
        )}
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--brand-strong)" }}>
        <span className="text-base">✨</span> {t("app.done.readyToPost")}
      </div>

      {(socialCaption || hashtagLine) && (
        <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
              {t("app.done.captionSuggestion")}
            </span>
            <button
              onClick={() => copyText(`${socialCaption}\n\n${hashtagLine}`.trim())}
              className="text-[10px] uppercase tracking-wider text-[var(--brand)] hover:text-[var(--brand-hover)]"
            >
              {t("app.done.copy")}
            </button>
          </div>
          {socialCaption && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-strong)]">
              {socialCaption}
            </div>
          )}
          {hashtagLine && (
            <div className="mt-2 text-xs text-[var(--brand-hover)]">{hashtagLine}</div>
          )}
        </div>
      )}

      <div className="flex w-full max-w-xs flex-col gap-2">
        {outputs
          .filter((f) => !f.startsWith("hook_"))
          .map((f) => (
            <a
              key={f}
              href={mediaUrl(jobId, "download", { format: f })}
              download
              className={`rounded-xl px-5 py-3 text-center font-semibold ${
                f === "primary"
                  ? "bg-[var(--brand)] hover:bg-[var(--brand-hover)]"
                  : "border border-[var(--brand)] text-[var(--brand-strong)] hover:bg-[var(--brand)]/10"
              }`}
            >
              <div className="text-sm">{formatLabel(f)}</div>
              <div className="text-[10px] font-normal text-[var(--text-strong)]/70">
                {formatSub(f)}
              </div>
            </a>
          ))}
      </div>

      {hookClips.length > 0 && (
        <div className="w-full max-w-md">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
            <span>{t("app.done.bonusClips")}</span>
            <span className="rounded bg-[var(--brand)]/15 px-1.5 py-0.5 text-[var(--brand-hover)]">
              {t("app.done.aiPicked")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {hookClips.map((h) => {
              const dur = h.end - h.start;
              return (
                <a
                  key={h.key}
                  href={mediaUrl(jobId, "download", { format: h.key })}
                  download
                  className="block rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 hover:border-[var(--brand)]"
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[var(--text-strong)]">
                      {h.title}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                      {dur.toFixed(0)}s
                    </div>
                  </div>
                  {h.reason && (
                    <div className="line-clamp-2 text-xs text-[var(--text-muted)]">
                      {h.reason}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      )}
      <button
        onClick={onReset}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
      >
        {t("app.done.processAnother")}
      </button>
    </div>
  );
}

function ReviewScreen({
  jobId,
  savedSegments,
  previewSegments,
  previewVersion,
  hasProxy,
  phrases,
  captionPreset,
  audioWarnings,
  cutRanges,
  duration,
  disabledCuts,
  setDisabledCuts,
  sceneEvents,
  onSceneEventsChange,
  onChange,
  onApply,
  onBack,
}: {
  jobId: string;
  savedSegments: SavedSeg[];
  previewSegments: [number, number][];
  previewVersion: number;
  /** GET /jobs/{id} has_proxy: true / false, undefined = not reported. */
  hasProxy: boolean | undefined;
  phrases: Phrase[];
  captionPreset: string;
  audioWarnings: string[];
  cutRanges: CutRange[];
  duration: number;
  disabledCuts: number[];
  setDisabledCuts: (ids: number[]) => void;
  sceneEvents: SceneEvent[];
  onSceneEventsChange: (evts: SceneEvent[]) => void | Promise<void>;
  onChange: (p: Phrase[]) => void;
  onApply: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  // How the player shows the edit:
  //   proxy   — plays the job's full-source proxy and follows the edit
  //             list itself (lib/editPlayback): edits show instantly and
  //             nothing waits for the server's preview rebuild.
  //   preview — backend without a proxy: plays the server-built cut
  //             preview.mp4 and swaps in each rebuild.
  //   probing — has_proxy not reported: one small request decides.
  //             The preview already loads meanwhile (no extra round
  //             trip before the video shows); a "yes" swaps to the proxy
  //             unless the user has already started playing.
  const [mode, setMode] = useState<"probing" | "proxy" | "preview">(
    hasProxy === true ? "proxy" : hasProxy === false ? "preview" : "probing",
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const mediaReady = useMediaReady();
  // Frozen for the element's lifetime, like every media src.
  const proxySrc = useMediaUrl(jobId, "proxy-video");
  useEffect(() => {
    if (mode !== "probing" || !mediaReady) return;
    let live = true;
    void probeProxy(mediaUrl(jobId, "proxy-video")).then((ok) => {
      if (!live) return;
      const v = videoRef.current;
      // Already playing (or played) the preview: don't yank the src.
      const started = !!v && (!v.paused || v.played.length > 0);
      setMode(ok && !started ? "proxy" : "preview");
    });
    return () => {
      live = false;
    };
  }, [mode, mediaReady, jobId]);
  // Preview mode — set once: a changing src would restart playback.
  // Later previews are swapped in imperatively (swapPreviewSrc), only
  // while paused. With accounts on, not before the media token is known
  // (/me can be slow): a tokenless src would fail for good.
  const [waitingVersion, setWaitingVersion] = useState(previewVersion);
  const [initialPreviewSrc, setInitialPreviewSrc] = useState<string | null>(null);
  if (initialPreviewSrc === null && mediaReady && mode !== "proxy") {
    setInitialPreviewSrc(mediaUrl(jobId, "preview-video", { v: waitingVersion }));
  }
  const videoSrc = mode === "proxy" ? proxySrc : initialPreviewSrc;
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const phraseRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Poll video.currentTime every animation frame while playing.
  // onTimeUpdate only fires ~4x/sec (browser throttle) which lags the
  // active-phrase highlight visibly behind the spoken word. rAF hits
  // ~60fps so the highlight lands on the syllable.
  // Throttled to ~12 updates/s: every update re-renders the whole
  // editor (timeline, transcript), and 60/s pegged phone CPUs on long
  // videos. 80 ms is still well under a spoken syllable.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId = 0;
    let last = -1;
    const tick = () => {
      if (!video.paused && !video.ended) {
        const t = video.currentTime;
        if (Math.abs(t - last) >= 0.08) {
          last = t;
          setCurrentTime(t);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Video plays the cut-preview (concatenated kept segments), so
  // currentTime lives on the CUT timeline. We map it back to the
  // original timeline for the strip playhead so the cursor lines up
  // with the right original-time position.
  const keptSegments = useMemo<[number, number][]>(() => {
    if (!duration) return [];
    const sorted = [...cutRanges].sort((a, b) => a.start - b.start);
    const kept: [number, number][] = [];
    let cursor = 0;
    for (const c of sorted) {
      if (c.start > cursor) kept.push([cursor, c.start]);
      cursor = c.end;
    }
    if (cursor < duration) kept.push([cursor, duration]);
    return kept;
  }, [cutRanges, duration]);

  // Segments the CURRENT preview MP4 was rendered from. Kept in sync
  // with what's actually playing, NOT with the user's in-progress
  // edits — otherwise the playhead jumps around wildly while the
  // rebuild is still pending.
  const [videoSegments, setVideoSegments] = useState<[number, number][]>(
    () => previewSegments,
  );
  useEffect(() => {
    if (videoSegments.length === 0 && keptSegments.length > 0) {
      setVideoSegments(keptSegments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptSegments.length]);

  const originalTime = useMemo(() => {
    // The proxy's timeline IS the source timeline.
    if (mode === "proxy") return currentTime;
    const src = videoSegments.length ? videoSegments : keptSegments;
    if (!src.length) return currentTime;
    let acc = 0;
    for (const [s, e] of src) {
      const segDur = e - s;
      if (acc + segDur >= currentTime) return s + (currentTime - acc);
      acc += segDur;
    }
    return duration;
  }, [mode, currentTime, videoSegments, keptSegments, duration]);

  // Editable segments — starts from keptSegments and can be trimmed,
  // split, deleted, or reordered by the user in the timeline editor.
  // Changes debounce-POST to /jobs/:id/edit-segments so the preview
  // video rebuilds and the player reflects the new timeline.
  type EditableSeg = {
    id: string;
    start: number;
    end: number;
    disabled?: boolean;
    speed?: number;
    fadeIn?: number;
    fadeOut?: number;
    volume?: number;
  };
  // Seeded from the user's SAVED timeline (earlier visits included);
  // only a job that was never edited falls back to the automatic cuts.
  const [editSegs, setEditSegs] = useState<EditableSeg[]>(() =>
    savedSegments.map((s, i) => ({
      id: `seg-${i}-${s.start.toFixed(3)}`,
      start: s.start,
      end: s.end,
      speed: s.speed,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      volume: s.volume,
    })),
  );
  // "retrying": transient failure, the edit is re-sent. "failed": the
  // server refused it for good (job gone / no longer in review).
  const [saveError, setSaveError] = useState<"retrying" | "failed" | null>(null);
  // Set when the editor unmounts: nothing may re-queue or retry after
  // that — a late retry would overwrite the edit flushed on leave.
  const closedRef = useRef(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "timeline" | "transcript" | "style"
  >("timeline");
  useEffect(() => {
    // Seed from keptSegments the first time they arrive
    if (editSegs.length === 0 && keptSegments.length > 0) {
      setEditSegs(
        keptSegments.map(([s, e], i) => ({
          id: `seg-${i}-${s.toFixed(3)}`,
          start: s,
          end: e,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptSegments.length]);


  // Edits update local state instantly (strip re-renders in the same
  // frame). A debounced POST rebuilds the server preview 800ms after
  // the last edit — long enough that rapid trims coalesce into one
  // rebuild, short enough that the user doesn't wait when they stop.
  //
  // The src swap that follows is gated: if the video is currently
  // playing we defer until the next pause. That's what killed the
  // 'flow' before — the browser reloaded mid-playback and jumped
  // back to the start of the clip.
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRebuildRef = useRef<EditableSeg[] | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const swapWhenPausedRef = useRef(false);
  const pendingSwapRef = useRef<{ segs: [number, number][]; version: number } | null>(null);
  // The save on the wire (its request answers only after the preview
  // rebuild), so proxy mode can wait for it to be STORED instead.
  const inflightSaveRef = useRef<{ payload: TimelineSeg[]; response: Promise<Response> } | null>(null);
  const applyingRef = useRef(false);

  const editPath = `/jobs/${jobId}/edit-segments`;
  const toPayload = (segs: EditableSeg[]) =>
    segs
      .filter((s) => !s.disabled && s.end - s.start > 0.05)
      .map((s) => ({
        start: s.start,
        end: s.end,
        speed: s.speed,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        volume: s.volume,
      }));

  const swapPreviewSrc = (version: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!isMediaReady()) {
      // No media token yet: the first src, set once it arrives, is this one.
      setWaitingVersion(version);
      return;
    }
    const wasTime = v.currentTime;
    v.src = mediaUrl(jobId, "preview-video", { v: version });
    const restore = () => {
      v.removeEventListener("loadedmetadata", restore);
      try {
        const dur = isFinite(v.duration) ? v.duration : 0;
        v.currentTime = Math.min(wasTime, Math.max(0, dur - 0.1));
      } catch {
        /* ignore */
      }
    };
    v.addEventListener("loadedmetadata", restore, { once: true });
  };

  // Switch the player to a rebuilt preview together with the segment
  // list it was built from (the server's, not ours), so the playhead
  // mapping always matches the file that is playing.
  const applyPreview = (segs: [number, number][], version: number) => {
    if (modeRef.current === "proxy") {
      // Proxy: nothing to reload. Only remember the newest preview, in
      // case the player falls back to preview mode. (Probing plays the
      // preview until the probe answers, so it swaps like preview.)
      setVideoSegments(segs);
      setWaitingVersion(version);
      return;
    }
    const v = videoRef.current;
    if (v && v.paused) {
      setVideoSegments(segs);
      swapPreviewSrc(version);
    } else {
      // Defer the src swap until the user pauses — we DO NOT
      // interrupt playback in flight. The pause listener below
      // performs the swap when they stop.
      pendingSwapRef.current = { segs, version };
      swapWhenPausedRef.current = true;
    }
  };

  const scheduleRebuild = (delay: number) => {
    if (closedRef.current) return;
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      void doRebuild();
    }, delay);
  };

  // One save at a time, always sending the latest edit (with effects —
  // sending only start/end used to reset speed/volume/fades on every
  // autosave). A failed save stays pending and is retried.
  const doRebuild = async (): Promise<void> => {
    while (inflightRef.current) await inflightRef.current;
    const next = pendingRebuildRef.current;
    if (!next) return;
    pendingRebuildRef.current = null;
    const active = toPayload(next);
    if (active.length === 0) return;
    const run = (async () => {
      setEditSaving(true);
      const request = apiFetch(editPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: active }),
      });
      inflightSaveRef.current = { payload: active, response: request };
      if (modeRef.current === "proxy") {
        // The answer only comes after the preview rebuild, which proxy
        // mode never uses: end "saving" once the edit is stored (unless a
        // newer edit is already waiting). Errors are still handled below.
        void saveOutcome(jobId, active, duration, request).then((o) => {
          if (o === "stored" && !pendingRebuildRef.current && !closedRef.current) {
            setEditSaving(false);
          }
        });
      }
      try {
        const r = await request;
        if ([400, 404, 409, 410].includes(r.status)) {
          // Permanent: retrying can't help.
          setSaveError("failed");
          return;
        }
        if (!r.ok) throw new Error(`save failed (${r.status})`);
        const data: JobStatus & { preview_ok?: boolean } = await r.json();
        setSaveError(null);
        if (data.preview_ok && data.preview_segments && !closedRef.current) {
          applyPreview(data.preview_segments, data.preview_version ?? Date.now());
        }
      } catch {
        // Apply & render already sent the timeline on screen.
        if (closedRef.current || applyingRef.current) return;
        // Keep the edit unless a newer one replaced it, and retry.
        if (!pendingRebuildRef.current) pendingRebuildRef.current = next;
        setSaveError("retrying");
        scheduleRebuild(3000);
      } finally {
        if (inflightSaveRef.current?.response === request) inflightSaveRef.current = null;
        setEditSaving(false);
      }
    })();
    inflightRef.current = run;
    // Reopening the job waits for this save — in proxy mode only until
    // it is stored, not for the preview rebuild (see flushOnLeave).
    if (modeRef.current !== "proxy") trackSave(jobId, run);
    try {
      await run;
    } finally {
      if (inflightRef.current === run) inflightRef.current = null;
    }
  };

  // Leaving the editor (in-app navigation, tab close, reload) must not
  // drop an edit that is still waiting for its debounce.
  const flushOnLeave = (unloading: boolean) => {
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    const proxy = modeRef.current === "proxy";
    const inflight = inflightSaveRef.current;
    const next = pendingRebuildRef.current;
    pendingRebuildRef.current = null;
    const active = next ? toPayload(next) : [];
    // Only when no newer save goes out now: that one replaces the
    // in-flight timeline on the server, so the in-flight one would never
    // be seen stored and reopening would wait for its rebuild.
    if (proxy && inflight && !unloading && active.length === 0) {
      trackSave(jobId, saveOutcome(jobId, inflight.payload, duration, inflight.response, { timeoutMs: 10_000 }));
    }
    if (active.length === 0) return;
    const body = JSON.stringify({ segments: active });
    const request = apiFetch(editPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive only while the page unloads (in-app navigation keeps
      // the page alive), and only under the browser's 64 KB cap.
      keepalive: unloading && body.length < 60_000,
      unloading,
    });
    trackSave(
      jobId,
      proxy && !unloading
        ? saveOutcome(jobId, active, duration, request, { timeoutMs: 10_000 })
        : request.catch(() => {}),
    );
  };
  useEffect(() => {
    // Re-armed on (re)mount — React dev mode mounts effects twice.
    closedRef.current = false;
    const onHide = () => flushOnLeave(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      closedRef.current = true;
      flushOnLeave(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reopened while the last save's preview was still rendering: the
  // saved edit is newer than the preview we loaded. Poll until the
  // server has the matching preview, then switch to it. (Proxy mode
  // plays the edit itself and never needs it.)
  useEffect(() => {
    if (mode !== "preview") return;
    const key = (xs: [number, number][]) =>
      JSON.stringify(xs.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]));
    const want = key(savedSegments.map((x) => [x.start, x.end]));
    if (!savedSegments.length || key(previewSegments) === want) return;
    let tries = 0;
    const id = setInterval(async () => {
      if (closedRef.current || ++tries > 45) return clearInterval(id);
      try {
        const r = await apiFetch(`/jobs/${jobId}`);
        if (!r.ok) return;
        const j: JobStatus = await r.json();
        if ((j.preview_version ?? 0) > previewVersion && j.preview_segments) {
          clearInterval(id);
          // Only if the user hasn't produced a newer preview meanwhile.
          if (!inflightRef.current && !pendingRebuildRef.current) {
            applyPreview(j.preview_segments, j.preview_version ?? Date.now());
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => {
      if (swapWhenPausedRef.current) {
        swapWhenPausedRef.current = false;
        const sw = pendingSwapRef.current;
        pendingSwapRef.current = null;
        if (sw) {
          setVideoSegments(sw.segs);
          swapPreviewSrc(sw.version);
        }
      }
    };
    v.addEventListener("pause", onPause);
    return () => v.removeEventListener("pause", onPause);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitEditSegs = (next: EditableSeg[]) => {
    setEditSegs(next);
    pendingRebuildRef.current = next;
    scheduleRebuild(800);
  };

  // Proxy mode: the player follows the edit list client-side — the
  // timeline shows on the next frame, no preview rebuild involved.
  const playerRef = useRef<EditPlayer | null>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const [playingSegId, setPlayingSegId] = useState<string | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    // Only once the element has its src (the media token may still be
    // loading): loading a src resets the element's rate and position.
    if (mode !== "proxy" || !v || !proxySrc) return;
    const player = new EditPlayer(v, { onSegment: setPlayingSegId, fadeEl: fadeRef.current });
    player.setPlan(buildPlan(editSegs, duration));
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
      setPlayingSegId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, proxySrc]);
  useEffect(() => {
    playerRef.current?.setPlan(buildPlan(editSegs, duration));
  }, [editSegs, duration]);

  // The preview follows the user's edited timeline, so phrases are
  // matched on SOURCE time (original_start / original_end) against the
  // playhead mapped back through the segments of the playing preview.
  useEffect(() => {
    const idx = phrases.findIndex(
      (p) => originalTime >= p.original_start && originalTime <= p.original_end,
    );
    setActiveIdx(idx === -1 ? null : idx);
  }, [originalTime, phrases]);

  // Keep the active phrase visible in the transcript container. Uses
  // getBoundingClientRect (not offsetTop) so it works regardless of
  // the container's positioned ancestor, and always scrolls so the
  // active block sits at ~30% from the top — upcoming lines stay in
  // sight, past lines fall off cleanly.
  useEffect(() => {
    if (activeIdx === null) return;
    if (videoRef.current?.paused) return;
    const container = transcriptScrollRef.current;
    const el = phraseRefs.current[activeIdx];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const relativeTop = (eRect.top - cRect.top) + container.scrollTop;
    const desiredOffset = container.clientHeight * 0.3;
    container.scrollTo({
      top: Math.max(0, relativeTop - desiredOffset),
      behavior: "smooth",
    });
  }, [activeIdx]);

  const updateText = (idx: number, text: string) => {
    const next = phrases.slice();
    next[idx] = { ...next[idx], text };
    onChange(next);
  };
  // Deleting a line is instant, with a few seconds to undo it.
  const [lastRemoved, setLastRemoved] = useState<{ idx: number; phrase: Phrase } | null>(null);
  const removedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remove = (idx: number) => {
    setLastRemoved({ idx, phrase: phrases[idx] });
    if (removedTimer.current) clearTimeout(removedTimer.current);
    removedTimer.current = setTimeout(() => setLastRemoved(null), 6000);
    onChange(phrases.filter((_, i) => i !== idx));
  };
  const undoRemove = () => {
    if (!lastRemoved) return;
    const next = phrases.slice();
    next.splice(Math.min(lastRemoved.idx, next.length), 0, lastRemoved.phrase);
    onChange(next);
    setLastRemoved(null);
  };

  // Source time → time in the playing preview (null if cut out).
  const previewTimeFor = (t: number): number | null => {
    const src = videoSegments.length ? videoSegments : keptSegments;
    let acc = 0;
    for (const [s, e] of src) {
      if (t >= s && t <= e) return acc + (t - s);
      acc += e - s;
    }
    return null;
  };
  const seekToPhrase = (p: Phrase) => {
    if (!videoRef.current) return;
    if (mode === "proxy") {
      if (playerRef.current?.seekRange(p.original_start, p.original_end)) {
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    // A phrase may start inside a removed stretch — jump to its first
    // moment that is still in the cut.
    let t = previewTimeFor(p.original_start);
    if (t === null) {
      const src = videoSegments.length ? videoSegments : keptSegments;
      let acc = 0;
      for (const [s, e] of src) {
        if (s >= p.original_start && s <= p.original_end) {
          t = acc;
          break;
        }
        acc += e - s;
      }
    }
    if (t === null) return;
    videoRef.current.currentTime = t;
    videoRef.current.play().catch(() => {});
  };


  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          {t("app.review.backToDashboard")}
        </button>
        <div className="text-xs text-[var(--text-body)]">
          {t(
            phrases.length === 1 ? "app.review.sentencesOne" : "app.review.sentencesOther",
            { count: phrases.length },
          )}
        </div>
      </div>

      {audioWarnings.length > 0 && (
        <div className="rounded-xl border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]">
          <div className="mb-1 font-semibold uppercase tracking-wider">
            {t("app.review.audioHeadsUp")}
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {audioWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Server-rendered cut preview — continuous MP4 with all
          enabled segments concatenated, so playback is always smooth
          (no client-side seek hops). Rebuild happens in the background
          via a debounced POST; we swap src only while paused so the
          user never sees a reload mid-playback. */}
      <div className="group relative overflow-hidden rounded-xl bg-[var(--surface-1)]">
        <video
          ref={videoRef}
          src={videoSrc ?? undefined}
          data-playback={mode}
          // The proxy can't be played after all (gone, codec): fall back
          // to the server-built preview.
          onError={() => {
            if (modeRef.current === "proxy") setMode("preview");
          }}
          controls
          // Proxy mode: no native speed menu — it would show the clip's
          // effective rate, not the user's speed (EditPlayer still copes
          // with browsers that ignore this).
          controlsList={mode === "proxy" ? "noplaybackrate" : undefined}
          playsInline
          // metadata only: don't pull the whole preview over mobile data
          // before the user presses play.
          preload="metadata"
          // Seeks while paused (rAF loop only runs while playing).
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-[var(--surface-0)]"
        />
        {/* Live caption preview: the current transcript line, so the
            user sees their text on the video before rendering. (The
            exact caption style is applied in the final render.) */}
        {captionPreset !== "none" && activeIdx !== null && phrases[activeIdx]?.text.trim() && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-3 bottom-12 flex justify-center"
          >
            <span
              className="max-w-[90%] rounded-md px-2 py-1 text-center text-base font-extrabold leading-tight sm:text-lg"
              style={{
                color: "#fff",
                background: "rgba(0,0,0,0.35)",
                textShadow: "0 2px 6px rgba(0,0,0,0.9)",
              }}
            >
              {phrases[activeIdx].text}
            </span>
          </div>
        )}
        {/* Clip fades (proxy mode), faded in and out by EditPlayer. Drawn
            over the captions, as the render fades burned-in subtitles
            too. Hidden while the pointer is over the video so the native
            control bar under it stays readable. */}
        {mode === "proxy" && (
          <div
            ref={fadeRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-black opacity-0 group-hover:opacity-0!"
          />
        )}
        <PlaybackDebug videoRef={videoRef} mode={mode} />
        {/* Proxy mode has no preview to update: the edit already plays. */}
        {editSaving && mode !== "proxy" && (
          <div
            className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold backdrop-blur-md"
            style={{
              background: "rgba(0,0,0,0.55)",
              color: "var(--brand-strong)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {t("app.review.updatingPreview")}
          </div>
        )}
      </div>

      {captionPreset !== "none" && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={publicUrl(`/caption-previews/${captionPreset}.png?w=200&h=72`)}
            alt={t("app.review.captionSampleAlt", { style: captionPreset })}
            className="h-10 w-28 rounded-md object-cover"
          />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              {t("app.review.captionsLookLike")}
            </div>
            <div className="text-sm font-medium capitalize">{captionLabel(captionPreset, t)}</div>
          </div>
        </div>
      )}
      {/* Tab bar — clean 3-way switch for the editor */}
      <div
        className="flex overflow-hidden rounded-xl"
        style={{
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
        }}
      >
        {(
          [
            { id: "timeline" as const, labelKey: "app.review.tabTimeline" as const, icon: "⏱" },
            { id: "transcript" as const, labelKey: "app.review.tabTranscript" as const, icon: "T" },
            { id: "style" as const, labelKey: "app.review.tabCaptions" as const, icon: "✎" },
          ]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex-1 px-3 py-2.5 text-sm font-medium transition-colors"
              style={{
                background: isActive
                  ? "var(--brand-tint)"
                  : "transparent",
                color: isActive
                  ? "var(--brand-strong)"
                  : "var(--text-muted)",
                borderRight: tab.id !== "style" ? "1px solid var(--border)" : "none",
              }}
            >
              <span className="mr-1.5">{tab.icon}</span>
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Timeline tab — everything for cut/trim/effects lives here */}
      {/* Stays mounted when another tab is open (just hidden), so undo
          history, zoom and scroll position survive tab switches. */}
      {editSegs.length > 0 && duration > 0 && (
        <div style={{ display: activeTab === "timeline" ? undefined : "none" }}>
        <TimelineEditor
          segments={editSegs}
          duration={duration}
          playhead={originalTime}
          playheadSegId={mode === "proxy" ? playingSegId : null}
          open={activeTab === "timeline"}
          saving={editSaving}
          saveError={saveError}
          onToggleOpen={() => {}}
          onCommit={(next) => void commitEditSegs(next)}
          onSeekOriginal={(time, segId) => {
            if (mode === "proxy") {
              playerRef.current?.seek(time, segId);
              return;
            }
            // time comes in on the ORIGINAL timeline; map it through the
            // segments of the preview that is actually playing (an edit
            // may not be rebuilt into it yet).
            const pt = previewTimeFor(time);
            if (pt !== null && videoRef.current) {
              videoRef.current.currentTime = pt;
            }
          }}
          getVideoTime={() => originalTime}
          onPlayPauseKey={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) v.play().catch(() => {});
            else v.pause();
          }}
        />
        </div>
      )}

      {/* Transcript tab — phrase-level text editing */}
      {activeTab === "transcript" && lastRemoved && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-body)" }}>{t("app.transcript.lineDeleted")}</span>
          <button
            onClick={undoRemove}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
          >
            {t("app.transcript.undo")}
          </button>
        </div>
      )}
      {activeTab === "transcript" && (
        <div
          className="overflow-hidden rounded-2xl"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
          }}
        >
          <div
            className="border-b px-4 pt-3 pb-2"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-1)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
              {t(
                phrases.length === 1 ? "app.transcript.headingOne" : "app.transcript.headingOther",
                { count: phrases.length },
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              {t("app.transcript.hint")}
            </div>
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-3"
          >
            {phrases.length === 0 && (
              <div className="rounded-xl border border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
                {t("app.transcript.empty")}
              </div>
            )}
            {phrases.map((p, i) => {
              const isActive = i === activeIdx;
              const lowConfidence = p.confidence < 0.6;
              let extraClass = "border border-[var(--border)]";
              if (isActive) {
                extraClass =
                  "border border-[var(--brand)] bg-[var(--brand-tint)] " +
                  "ring-2 ring-[var(--brand-hover)]/50 shadow-[0_0_20px_var(--brand-glow)]";
              } else if (lowConfidence) {
                extraClass = "border border-[var(--warn)]/60 bg-[var(--warn)]/[0.04]";
              }
              return (
                <div
                  key={i}
                  ref={(el) => {
                    phraseRefs.current[i] = el;
                  }}
                  onClick={() => seekToPhrase(p)}
                  className={`relative cursor-pointer rounded-xl p-3 transition-all ${extraClass}`}
                >
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute -left-1 top-1/2 -translate-y-1/2 h-8 w-1 rounded-full"
                      style={{
                        background: "var(--brand-hover)",
                        boxShadow: "0 0 8px var(--brand-glow)",
                      }}
                    />
                  )}
                  <div className="mb-1.5 flex items-center justify-between">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        seekToPhrase(p);
                      }}
                      className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    >
                      ▸ {fmtTime(p.original_start)}
                    </button>
                    <div className="flex items-center gap-2">
                      {lowConfidence && (
                        <span className="text-[9px] uppercase tracking-wider text-[var(--warn)]">
                          {t("app.transcript.verify")}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(i);
                        }}
                        className="-m-2 flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-faint)] hover:text-[var(--danger)]"
                        aria-label={t("app.transcript.deleteSentence")}
                        title={t("app.transcript.deleteSentence")}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={p.text}
                    onChange={(e) => updateText(i, e.target.value)}
                    rows={Math.min(4, Math.max(1, Math.ceil(p.text.length / 38)))}
                    className="w-full resize-none bg-transparent text-base leading-snug text-[var(--text-strong)] focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Captions tab — style picker */}
      {activeTab === "style" && (
        <div
          className="overflow-hidden rounded-2xl p-4"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
          }}
        >
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
            {t("app.captions.styleHeading", { style: captionPreset })}
          </div>
          {captionPreset !== "none" ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3"
              style={{ background: "var(--surface-0)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(`/caption-previews/${captionPreset}.png?w=240&h=90`)}
                alt={t("app.configure.captionPreviewAlt", { style: captionPreset })}
                className="h-14 w-40 rounded-md object-cover"
              />
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {t("app.captions.appliedToOutput")}
                </div>
                <div className="text-sm font-medium capitalize">{captionLabel(captionPreset, t)}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">
              {t("app.captions.disabled")}
            </div>
          )}
        </div>
      )}

      <button
        onClick={async () => {
          // Push the user's edited segments (with effects) to the
          // backend before we hit /render — the render reads them from
          // the job. Cancel the pending autosave and wait for one in
          // flight first, so neither can land after this save.
          if (rebuildTimerRef.current) {
            clearTimeout(rebuildTimerRef.current);
            rebuildTimerRef.current = null;
          }
          pendingRebuildRef.current = null;
          setApplying(true);
          if (modeRef.current === "proxy") {
            // The player already shows this edit, so render as soon as
            // the server has STORED it — not after its preview rebuild.
            applyingRef.current = true;
            setApplyError(null);
            const active = toPayload(editSegs);
            let outcome: SaveOutcome = "stored";
            // An autosave on the wire lands first, so it can't overwrite
            // this save; when it already carries this edit, that's it.
            const prev = inflightSaveRef.current;
            const prevOutcome = prev
              ? await saveOutcome(jobId, prev.payload, duration, prev.response, {
                  settleOnAnswer: true,
                  timeoutMs: 8_000,
                })
              : null;
            const covered =
              prev && prevOutcome === "stored" && sameTimeline(prev.payload, active, duration);
            if (active.length > 0 && !covered) {
              const request = apiFetch(editPath, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ segments: active }),
              });
              outcome = await saveOutcome(jobId, active, duration, request);
            }
            if (outcome !== "stored") {
              // Never render an older cut than the one on screen.
              setApplyError(t("app.errors.saveEditsFailed"));
              pendingRebuildRef.current = editSegs;
              applyingRef.current = false;
              setApplying(false);
              return;
            }
            onApply();
            return;
          }
          while (inflightRef.current) await inflightRef.current;
          setApplyError(null);
          try {
            const active = toPayload(editSegs);
            if (active.length > 0) {
              const r = await apiFetch(editPath, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ segments: active }),
              });
              if (!r.ok) throw new Error(`save failed (${r.status})`);
            }
          } catch {
            // Never render an older cut than the one on screen.
            setApplyError(t("app.errors.saveEditsFailed"));
            pendingRebuildRef.current = editSegs;
            setApplying(false);
            return;
          }
          onApply();
        }}
        // Only the render itself blocks the button — autosaves no
        // longer flip it to "Preparing…" every few seconds.
        disabled={applying}
        className="mt-1 w-full rounded-xl bg-[var(--brand)] px-6 py-4 text-base font-semibold hover:bg-[var(--brand-hover)] active:scale-[0.99] disabled:opacity-60"
      >
        {applying ? t("app.review.preparing") : t("app.review.applyRender")}
      </button>
      {applyError && (
        <div className="text-center text-xs" style={{ color: "var(--danger)" }}>
          {applyError}
        </div>
      )}
    </div>
  );
}

// Temporary playback diagnostics, shown only with ?debug=1 in the URL.
// Distinguishes network stalls (waiting events), decoder drops and
// main-thread jank so we know which layer causes the hitches.
function PlaybackDebug({
  videoRef,
  mode,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).has("debug"));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const v = videoRef.current;
    if (!v) return;
    let waits = 0;
    let janks = 0;
    let worstJank = 0;
    const log: string[] = [];
    const push = (s: string) => {
      log.unshift(`${v.currentTime.toFixed(2)}s ${s}`);
      log.length = Math.min(log.length, 5);
    };
    const onWaiting = () => {
      waits++;
      push("WAITING (buffer)");
    };
    const onStalled = () => push("STALLED (network)");
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onStalled);
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      if (!v.paused && dt > 120) {
        janks++;
        worstJank = Math.max(worstJank, dt);
        push(`JANK ${Math.round(dt)}ms (UI)`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const iv = setInterval(() => {
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
          ahead = v.buffered.end(i) - v.currentTime;
        }
      }
      const q = v.getVideoPlaybackQuality?.();
      setText(
        [
          `${modeRef.current ?? ""} ${v.paused ? "paused" : "playing"} · ready=${v.readyState} · buffer +${ahead.toFixed(1)}s · ${v.playbackRate}×`,
          `waits=${waits} · janks=${janks} (max ${Math.round(worstJank)}ms)`,
          `dropped=${q?.droppedVideoFrames ?? "?"}/${q?.totalVideoFrames ?? "?"}`,
          ...log,
        ].join("\n"),
      );
    }, 300);
    return () => {
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onStalled);
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, [enabled, videoRef]);
  if (!enabled) return null;
  return (
    <pre className="pointer-events-none absolute left-2 top-2 z-30 whitespace-pre rounded-md bg-black/75 p-2 font-mono text-[10px] leading-tight text-green-300">
      {text}
    </pre>
  );
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
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

function ErrorScreen({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <div className="text-5xl">⚠️</div>
      <div className="text-base font-semibold">{t("app.errors.title")}</div>
      <div className="max-w-xs text-center text-xs text-[var(--text-muted)]">{message}</div>
      <button
        onClick={onReset}
        className="mt-2 rounded-xl border border-[var(--border-hover)] px-5 py-2 text-sm hover:border-[var(--brand)]"
      >
        {t("app.errors.tryAgain")}
      </button>
    </div>
  );
}

// Single-screen onboarding: live mic test + command list on one modal.
// Cheat sheet and test collapsed into one screen so the user doesn't
// need to click through. On first open, we don't force mic permission —
// user clicks 'Start test' when ready. All processing local, no backend.
function VoiceCommandsModal({ onClose }: { onClose: () => void }) {
  return <VoiceCommandsTestStep onDone={onClose} />;
}

// Live mic + camera test. User grants permissions, sees themselves,
// says commands, gets real-time feedback. Uses the browser's Web
// Speech API (webkitSpeechRecognition) — no backend, no cost,
// works in Safari + Chrome on macOS/iOS/Android.
function VoiceCommandsTestStep({ onDone }: { onDone: () => void }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const [permStatus, setPermStatus] = useState<
    "idle" | "requesting" | "granted" | "denied" | "unsupported"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [detected, setDetected] = useState<Record<string, number>>({});
  const [lastHitAt, setLastHitAt] = useState(0);

  // `phrase` is the spoken command itself — not translated.
  const targets: { id: string; phrase: string; descKey: MessageKey; color: string }[] = [
    { id: "start", phrase: "Cleo start", descKey: "app.voice.cmd.start", color: "#5A9FFF" },
    { id: "cut", phrase: "Cleo cut", descKey: "app.voice.cmd.cut", color: "#F26E6E" },
    { id: "keep", phrase: "Cleo keep", descKey: "app.voice.cmd.keep", color: "#4ECC77" },
    { id: "finish", phrase: "Cleo finish", descKey: "app.voice.cmd.finish", color: "#B979FF" },
    { id: "stop", phrase: "Cleo stop", descKey: "app.voice.cmd.stop", color: "#F5B54D" },
    { id: "go", phrase: "Cleo go", descKey: "app.voice.cmd.go", color: "#F5B54D" },
  ];

  // Match keywords + common mishears. \s* (not \s+) so 'cleokeep',
  // 'cleogo' etc. (Web Speech often concatenates fast speech) match
  // the same as 'cleo keep'.
  const matchers: Record<string, RegExp> = {
    start: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(start|starts|starte|istab|isab)\b/i,
    cut: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(cut|cuts|kot|kutt|schnitt)\b/i,
    keep: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(keep|kip|kiep|behalten)\b/i,
    finish: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(finish|finnisch|fenish|ende|fertig)\b/i,
    stop: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(stop|stopp|halt)\b/i,
    go: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(go|los|weiter)\b/i,
  };

  const startTest = async () => {
    setPermStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }

      // Web Speech API
      const SR =
        (typeof window !== "undefined" &&
          ((window as any).SpeechRecognition ||
            (window as any).webkitSpeechRecognition)) ||
        null;
      if (!SR) {
        setPermStatus("unsupported");
        return;
      }
      const recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "de-DE";
      recognition.onresult = (event: any) => {
        let text = "";
        for (let i = 0; i < event.results.length; i++) {
          text += event.results[i][0].transcript + " ";
        }
        setTranscript(text.trim());
        const newDetected: Record<string, number> = {};
        for (const [id, re] of Object.entries(matchers)) {
          const matches = text.match(new RegExp(re, "gi"));
          if (matches) newDetected[id] = matches.length;
        }
        if (Object.keys(newDetected).length > 0) {
          setLastHitAt(Date.now());
        }
        setDetected(newDetected);
      };
      recognition.onerror = (event: any) => {
        if (event.error === "not-allowed") setPermStatus("denied");
      };
      recognition.onend = () => {
        // Auto-restart while modal is open
        try {
          recognition.start();
        } catch {
          // ignore
        }
      };
      recognition.start();
      recognitionRef.current = recognition;
      setPermStatus("granted");
    } catch {
      setPermStatus("denied");
    }
  };

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const pulseActive = Date.now() - lastHitAt < 800;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={onDone}
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl"
        style={{
          background: "var(--surface-0)",
          border: "1px solid var(--border)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Compact header — one line title, one line explanation */}
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex-1">
            <div
              className="text-base font-bold"
              style={{ color: "var(--text-strong)" }}
            >
              {t("app.voice.title")}
            </div>
            <div
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {t("app.voice.subtitle")}
            </div>
          </div>
          <button
            onClick={onDone}
            aria-label={t("app.voice.close")}
            className="ml-3 shrink-0 rounded-lg p-1.5 transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Camera preview OR permission prompt */}
          <div
            className="relative overflow-hidden"
            style={{
              background: "var(--surface-1)",
              aspectRatio: "16 / 10",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              style={{ transform: "scaleX(-1)" }}
              muted
              playsInline
            />
            {permStatus === "granted" && (
              <>
                <div
                  className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{
                    background: "rgba(0,0,0,0.7)",
                    color: pulseActive ? "#4ECC77" : "#fff",
                    backdropFilter: "blur(4px)",
                  }}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: pulseActive ? "#4ECC77" : "#F26E6E",
                      boxShadow: pulseActive ? "0 0 8px #4ECC77" : "none",
                    }}
                  />
                  {pulseActive ? t("app.voice.heardYou") : t("app.voice.listening")}
                </div>
                {/* Live transcript strip */}
                {transcript && (
                  <div
                    className="absolute bottom-0 left-0 right-0 p-2 text-[10px]"
                    style={{
                      background: "rgba(0,0,0,0.65)",
                      color: "#fff",
                      backdropFilter: "blur(4px)",
                    }}
                  >
                    <span style={{ color: "#aaa" }}>{t("app.voice.heardPrefix")}</span>
                    {transcript.slice(-100)}
                  </div>
                )}
              </>
            )}
            {permStatus !== "granted" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
                {(permStatus === "idle" || permStatus === "requesting") && (
                  <>
                    <div
                      className="text-center text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("app.voice.permissionHint")}
                    </div>
                    <button
                      onClick={startTest}
                      disabled={permStatus === "requesting"}
                      className="rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-60"
                      style={{ background: "var(--brand)", color: "white" }}
                    >
                      {permStatus === "requesting" ? t("app.voice.requesting") : t("app.voice.start")}
                    </button>
                  </>
                )}
                {permStatus === "denied" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    {t("app.voice.denied")}
                  </div>
                )}
                {permStatus === "unsupported" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    {t("app.voice.unsupported")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Command list — always visible, doubles as cheat sheet.
              Single-column with phrase + one-line explanation so the
              user sees what each command DOES, not just its name. */}
          <div className="flex flex-col gap-1.5 p-3">
            {targets.map((cmd) => {
              const count = detected[cmd.id] || 0;
              const hit = count > 0;
              return (
                <div
                  key={cmd.id}
                  className="flex items-center gap-2.5 rounded-lg p-2 transition-all"
                  style={{
                    background: "var(--surface-1)",
                    border: `1px solid ${hit ? cmd.color : "var(--border)"}`,
                    boxShadow: hit ? `0 0 12px ${cmd.color}55` : "none",
                  }}
                >
                  <div
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all"
                    style={{
                      background: hit ? cmd.color : "var(--surface-2)",
                      color: hit ? "white" : "var(--text-muted)",
                    }}
                  >
                    {hit ? "✓" : "○"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="font-mono text-[12px] font-semibold leading-tight"
                      style={{ color: "var(--text-strong)" }}
                    >
                      {cmd.phrase}
                    </div>
                    <div
                      className="text-[10px] leading-tight"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t(cmd.descKey)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          className="p-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <button
            onClick={onDone}
            className="w-full rounded-xl py-2.5 text-sm font-semibold transition-transform hover:scale-[0.99]"
            style={{
              background: "var(--brand)",
              color: "white",
            }}
          >
            {t("app.voice.done")}
          </button>
        </div>
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

// Compact card for an in-progress job. The copy is deliberately warm
// and non-technical — we translate the backend's phase into a plain
// "we're doing X" sentence instead of dumping ffmpeg / whisper jargon
// on the user. Progress bar shows movement; the % lives in the corner
// as a small tabular number.
function ActiveJobCard({
  job,
  status,
  onOpen,
  onRetry,
}: {
  job: ActiveJobV2;
  status?: CardStatus;
  onOpen: () => void;
  onRetry?: () => void;
}) {
  const t = useT();
  const isError = status?.status === "error" || Boolean(job.error);
  // Waiting for a free analysis / render slot (backend admission queue).
  const queued =
    !isError &&
    (job.phase === "analyzing" || job.phase === "rendering") &&
    status?.status === "processing" &&
    status.message === "queued";
  const phaseCopy: Record<ActiveJobV2["phase"], { title: string; sub: string; icon: string }> = {
    uploading: {
      title: t("app.card.uploading.title"),
      sub: t("app.card.uploading.sub"),
      icon: "↑",
    },
    analyzing: {
      title: t("app.card.analyzing.title"),
      sub: t("app.card.analyzing.sub"),
      icon: "✦",
    },
    reviewing: {
      title: t("app.card.reviewing.title"),
      sub: t("app.card.reviewing.sub"),
      icon: "▸",
    },
    rendering: {
      title: t("app.card.rendering.title"),
      sub: t("app.card.rendering.sub"),
      icon: "✦",
    },
  };
  const presetLabel = presetLabelFor(job.presetId, job.presetLabel, t);
  const phaseAccent: Record<ActiveJobV2["phase"], string> = {
    uploading: "#5A9FFF",
    analyzing: "#F5B54D",
    reviewing: "#4ECC77",
    rendering: "#B979FF",
  };
  const pct =
    job.phase === "uploading" ? job.uploadPct ?? 0 : status?.progress ?? 0;
  const canOpen = job.phase === "reviewing" && !isError;
  const copy = phaseCopy[job.phase];
  const accent = phaseAccent[job.phase];

  return (
    <button
      onClick={canOpen ? onOpen : undefined}
      // Error cards stay enabled: a disabled <button> swallows clicks on
      // its children, which made the "Try again" chip below dead.
      disabled={!canOpen && !isError}
      className={`group relative flex flex-col overflow-hidden rounded-2xl p-4 text-left transition-all ${
        canOpen ? "cursor-pointer hover:-translate-y-0.5" : "cursor-default"
      }`}
      style={{
        background: "var(--surface-1)",
        border: `1px solid ${
          isError
            ? "#F26E6E55"
            : canOpen
              ? accent + "80"
              : "var(--border)"
        }`,
        boxShadow: canOpen ? `0 4px 24px ${accent}20` : "none",
      }}
    >
      {/* Ambient accent glow — same treatment as preset cards */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-30 blur-2xl"
        style={{ background: isError ? "#F26E6E" : accent }}
      />

      {/* Header row: filename + preset chip */}
      <div className="relative z-10 mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-bold"
            style={{ color: "var(--text-strong)" }}
          >
            {job.filename}
          </div>
          {presetLabel && (
            <div
              className="mt-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-faint)" }}
            >
              {presetLabel}
            </div>
          )}
        </div>
        {canOpen ? (
          <div
            className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-transform group-hover:translate-x-0.5"
            style={{ background: accent, color: "#0f0f0f" }}
          >
            {t("app.card.open")}
          </div>
        ) : (
          <div
            className="shrink-0 text-lg leading-none opacity-70"
            style={{ color: isError ? "#F26E6E" : accent }}
          >
            {isError ? "!" : copy.icon}
          </div>
        )}
      </div>

      {/* Status line */}
      {isError ? (
        <div
          className="relative z-10 mb-3 text-xs"
          style={{ color: "#F26E6E" }}
        >
          {friendlyError(job.error ?? status?.message, t)}
        </div>
      ) : (
        <div
          className="relative z-10 mb-3 text-xs leading-relaxed"
          style={{ color: job.note ? "var(--warn)" : "var(--text-body)" }}
        >
          {job.note ? localizeKnown(job.note, t) : queued ? t("app.card.queued.sub") : copy.sub}
        </div>
      )}

      {/* Progress bar for non-review phases */}
      {job.phase !== "reviewing" && !isError && (
        <div className="relative z-10">
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: "var(--surface-2)" }}
          >
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${Math.max(3, Math.min(100, pct))}%`,
                background: accent,
                boxShadow: `0 0 12px ${accent}80`,
              }}
            />
          </div>
          <div
            className="mt-1.5 flex items-center justify-between text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span>
              {queued
                ? status?.queuePosition
                  ? t("app.card.queued.title", { n: status.queuePosition })
                  : t("app.card.queued.titleNoPos")
                : copy.title}
            </span>
            {!queued && <span className="tabular-nums">{Math.round(pct)}%</span>}
          </div>
        </div>
      )}

      {/* Error retry */}
      {isError && onRetry && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="relative z-10 mt-1 inline-flex w-fit cursor-pointer items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
          }}
        >
          {t("app.card.remove")}
        </span>
      )}
    </button>
  );
}

// Timeline editor with per-segment trim, split, delete, reorder.
// Segments are rendered as blocks in a horizontal strip proportional
// to their duration. Handles on the left/right edges let the user drag
// to trim; a Delete button removes a segment (soft-disable so it can
// be restored); Split at playhead splits the current block into two;
// drag-and-drop reorders. All edits POST to the backend which rebuilds
// the preview MP4.
type EditorSeg = {
  id: string;
  start: number;
  end: number;
  disabled?: boolean;
  speed?: number;      // 0.25 – 4.0, default 1
  fadeIn?: number;     // seconds
  fadeOut?: number;    // seconds
  volume?: number;     // 0 – 2.5, default 1
};

const TIMELINE_DEFAULT_PPS = 40; // px per second on open
// Trimming snaps onto a neighbouring clip's footage when it would leave
// less than this much of the removed gap between them.
const TRIM_SNAP_S = 0.3;
const TIMELINE_MAX_PPS = 400; // 0.1s = 40px

// m:ss.t — for the playhead readout and sub-second ruler labels.
function fmtTimecode(t: number): string {
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${s.toString().padStart(2, "0")}.${tenths % 10}`;
}

// Ruler marks for the visible part of the strip only (it can be many
// thousands of px wide). Owns its scroll listener so scrolling
// re-renders just the ruler, not the whole editor.
//   - labelled major marks, spaced >= 56px
//   - 0.5s marks (medium) and 0.1s marks (short) once there's room
function RulerTicks({
  scrollRef,
  contentW,
  totalDur,
  viewW,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentW: number;
  totalDur: number;
  viewW: number;
}) {
  const [scrollLeft, setScrollLeft] = useState(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrollLeft(sc.scrollLeft));
    };
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, contentW]);

  const pps = contentW / totalDur;
  const labelSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const labelStep = labelSteps.find((st) => st * pps >= 56) ?? 600;
  // Finest step that still leaves >= 4px between marks.
  const minorStep =
    0.1 * pps >= 4 ? 0.1 : 0.5 * pps >= 4 && labelStep > 0.5 ? 0.5 : labelStep / 2;

  // Work in tenths of a second to avoid float drift.
  const minorT = Math.max(1, Math.round(minorStep * 10));
  const labelT = Math.round(labelStep * 10);
  const from = Math.max(0, scrollLeft - 100) / pps;
  const to = Math.min(contentW, scrollLeft + viewW + 100) / pps;
  const first = Math.ceil((from * 10) / minorT) * minorT;
  const labelFmt = labelStep < 1 ? fmtTimecode : (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const marks = [];
  for (let k = first; k <= to * 10 + 1e-6 && k <= totalDur * 10 + 1e-6; k += minorT) {
    const t = k / 10;
    const x = t * pps;
    const isMajor = k % labelT === 0;
    const isSecond = !isMajor && k % 10 === 0;
    const isHalf = !isMajor && !isSecond && k % 5 === 0;
    marks.push(
      <div
        key={k}
        className="pointer-events-none absolute bottom-0"
        style={{
          left: `${x}px`,
          width: "1px",
          height: isMajor ? "10px" : isSecond ? "7px" : isHalf ? "5px" : "3px",
          background: isMajor || isSecond
            ? "var(--text-muted)"
            : isHalf
              ? "var(--border-strong)"
              : "var(--border-hover)",
        }}
      />,
    );
    if (isMajor && x < contentW - 28) {
      marks.push(
        <span
          key={`l${k}`}
          className="pointer-events-none absolute top-1 pl-1 text-[9px] tabular-nums"
          style={{ left: `${x}px`, color: "var(--text-muted)" }}
        >
          {labelFmt(t)}
        </span>,
      );
    }
  }
  return <>{marks}</>;
}

function TimelineEditor({
  segments,
  duration,
  playhead,
  playheadSegId,
  open,
  saving,
  saveError,
  onToggleOpen,
  onCommit,
  onSeekOriginal,
  getVideoTime,
  onPlayPauseKey,
}: {
  segments: EditorSeg[];
  duration: number;
  playhead: number;
  /** The clip playing (proxy mode): a split point or a clip moved away
   *  from its footage's neighbours can't be told apart by time alone. */
  playheadSegId?: string | null;
  open: boolean;
  saving: boolean;
  saveError?: "retrying" | "failed" | null;
  onToggleOpen: () => void;
  onCommit: (next: EditorSeg[]) => void;
  onSeekOriginal: (t: number, segId?: string) => void;
  getVideoTime: () => number;
  onPlayPauseKey?: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragMode, setDragMode] = useState<"start" | "end" | null>(null);
  // Zoom as pixels per second. Starts zoomed in so the strip scrolls
  // and the 0.5s / 0.1s ruler marks are readable; "Fit" shows it all.
  const [pps, setPps] = useState(TIMELINE_DEFAULT_PPS);
  const [history, setHistory] = useState<EditorSeg[][]>([]);
  const [future, setFuture] = useState<EditorSeg[][]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragPreviewRef = useRef<EditorSeg[] | null>(null);
  const scrubbingRef = useRef(false);
  const [, forceRender] = useState({});

  // While the user is dragging a trim handle, use the live preview
  // for measurements so the visible strip stays in sync with the
  // dragging cursor. Otherwise fall back to committed props.
  const displaySegs = dragPreviewRef.current ?? segments;
  // During a trim drag the strip keeps the scale it had when the drag
  // started — otherwise shrinking a clip rescales every block under the
  // cursor and the trim runs away.
  const dragTotalRef = useRef<number | null>(null);
  const totalDur =
    dragTotalRef.current ??
    (displaySegs.reduce((acc, s) => acc + (s.end - s.start), 0) || 1);
  const activeCount = displaySegs.filter((s) => !s.disabled).length;

  const fmt = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Wrap onCommit to push history state
  // `coalesce` groups rapid changes of the same control (a slider being
  // dragged fires dozens of changes) into ONE undo step.
  const lastCommitRef = useRef<{ key: string; t: number } | null>(null);
  const commit = (next: EditorSeg[], coalesce?: string) => {
    const now = Date.now();
    const last = lastCommitRef.current;
    const merge = coalesce && last && last.key === coalesce && now - last.t < 1000;
    lastCommitRef.current = coalesce ? { key: coalesce, t: now } : null;
    if (!merge) {
      setHistory((h) => [...h, segments].slice(-50));
    }
    setFuture([]);
    onCommit(next);
  };
  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setFuture((f) => [segments, ...f].slice(0, 30));
    onCommit(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setHistory((h) => [...h, segments].slice(-30));
    onCommit(next);
  };

  // Trim drag — during the gesture we mutate a LOCAL preview so the
  // strip resizes visually without spamming the backend. Only on
  // release do we call onCommit ONCE with the final state. Without
  // this, every mousemove pixel used to fire an /edit-segments POST
  // which triggered concurrent preview MP4 rebuilds and crashed the
  // video element mid-playback.
  useEffect(() => {
    if (!draggingId || !dragMode || !stripRef.current) return;
    const strip = stripRef.current;
    const stripRect = strip.getBoundingClientRect();
    const pxPerSec = stripRect.width / totalDur;
    dragTotalRef.current = totalDur;
    // Every move is computed from this snapshot (not the previous
    // move's result) so offsets don't accumulate.
    const startSegs = segments.map((s) => ({ ...s }));
    dragPreviewRef.current = startSegs;
    // Growing a clip brings back removed source footage, but never
    // footage another clip already uses — that would play it twice.
    const bounds = (() => {
      const self = startSegs.find((x) => x.id === draggingId);
      const others = startSegs.filter((x) => x.id !== draggingId && !x.disabled);
      if (!self) return { prev: 0, next: duration };
      return {
        prev: Math.max(0, ...others.filter((o) => o.end <= self.start + 1e-6).map((o) => o.end)),
        next: Math.min(duration, ...others.filter((o) => o.start >= self.end - 1e-6).map((o) => o.start)),
      };
    })();

    const handleMove = (e: MouseEvent | TouchEvent) => {
      // Touch: keep the page / strip from scrolling under the finger.
      if (e.cancelable && "touches" in e) e.preventDefault();
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX;
      const relX = clientX - stripRect.left;
      // May be negative: dragging the first clip's start handle past the
      // strip's left edge brings back footage before it.
      const seconds = relX / pxPerSec;

      let acc = 0;
      const next = startSegs.map((s) => {
        if (s.disabled) return s;
        const sDur = s.end - s.start;
        if (s.id === draggingId) {
          if (dragMode === "start") {
            const target = s.start + (seconds - acc);
            let clamped = Math.max(bounds.prev, Math.min(s.end - 0.1, target));
            // Snap onto the neighbouring clip's footage instead of
            // leaving a sliver of the removed gap.
            if (clamped < s.start && clamped - bounds.prev < TRIM_SNAP_S) clamped = bounds.prev;
            return { ...s, start: clamped };
          } else if (dragMode === "end") {
            const target = s.start + Math.max(0.1, seconds - acc);
            let clamped = Math.min(bounds.next, Math.max(s.start + 0.1, target));
            if (clamped > s.end && bounds.next - clamped < TRIM_SNAP_S) clamped = bounds.next;
            return { ...s, end: clamped };
          }
        }
        acc += sDur;
        return s;
      });
      dragPreviewRef.current = next;
      forceRender({});
    };

    const handleUp = () => {
      const final = dragPreviewRef.current;
      dragTotalRef.current = null;
      setDraggingId(null);
      setDragMode(null);
      if (final) {
        // Through commit() so ⌘Z can undo a trim.
        commit(final);
      }
      dragPreviewRef.current = null;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingId, dragMode]);

  const del = (id: string) => {
    // Refuse to remove the last clip — the backend would have nothing
    // to render. Undo (⌘Z / ↶) brings anything back.
    const active = segments.filter((s) => !s.disabled);
    if (active.length <= 1 && active.some((s) => s.id === id)) {
      setSelected(id);
      return;
    }
    commit(segments.filter((s) => s.id !== id));
    setSelected(null);
  };
  const splitAtPlayhead = () => {
    const at = getVideoTime();
    const idx = segments.findIndex(
      (s) => !s.disabled && at > s.start + 0.1 && at < s.end - 0.1,
    );
    if (idx === -1) return;
    const cur = segments[idx];
    const first: EditorSeg = { ...cur, end: at, id: `${cur.id}-a` };
    const second: EditorSeg = {
      ...cur,
      start: at,
      id: `${cur.id}-b-${Date.now()}`,
    };
    commit([...segments.slice(0, idx), first, second, ...segments.slice(idx + 1)]);
  };
  const moveLeft = (id: string) => {
    const idx = segments.findIndex((s) => s.id === id);
    if (idx <= 0) return;
    const next = [...segments];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    commit(next);
  };
  const moveRight = (id: string) => {
    const idx = segments.findIndex((s) => s.id === id);
    if (idx === -1 || idx >= segments.length - 1) return;
    const next = [...segments];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    commit(next);
  };
  const patchSeg = (id: string, patch: Partial<EditorSeg>) => {
    commit(
      segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      `${id}:${Object.keys(patch).sort().join(",")}`,
    );
  };

  // Keyboard shortcuts: Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo),
  // Delete (remove selected), Space (play/pause via callback).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (inField) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        meta &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        del(selected);
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        onPlayPauseKey?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected, history, future, segments]);

  const selectedSeg = selected ? segments.find((x) => x.id === selected) : null;

  // Playhead position on the CUT timeline (what the strip lays out).
  const playheadCut = (() => {
    if (playheadSegId) {
      let acc = 0;
      for (const s of segments) {
        if (s.disabled) continue;
        if (s.id === playheadSegId && playhead >= s.start - 0.05 && playhead <= s.end + 0.05) {
          return acc + Math.min(s.end - s.start, Math.max(0, playhead - s.start));
        }
        acc += s.end - s.start;
      }
    }
    let acc = 0;
    for (const s of segments) {
      if (s.disabled) continue;
      if (playhead >= s.start && playhead <= s.end) return acc + (playhead - s.start);
      acc += s.end - s.start;
    }
    return null;
  })();
  const playheadPct =
    playheadCut !== null ? Math.min(100, (playheadCut / totalDur) * 100) : null;

  // Visible strip width, so ruler density adapts to phone vs desktop.
  const [viewW, setViewW] = useState(640);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth || 640));
    ro.observe(sc);
    return () => ro.disconnect();
  }, [open]);

  // Effective zoom: never narrower than the view ("fit"), and capped
  // so very long videos don't produce absurdly wide elements.
  const fitPps = viewW / totalDur;
  const maxPps = Math.max(fitPps, Math.min(TIMELINE_MAX_PPS, 200_000 / totalDur));
  const effPps = Math.min(maxPps, Math.max(fitPps, pps));
  const contentW = Math.max(viewW, Math.round(totalDur * effPps));
  const canZoomOut = contentW > viewW + 1;
  const canZoomIn = effPps < maxPps - 1e-6;

  // Zoom while keeping the time under `anchorX` (px from the left edge
  // of the visible strip) in place. The scroll correction is applied
  // after the new width has been laid out.
  const pendingAnchorRef = useRef<{ t: number; x: number } | null>(null);
  const zoomStateRef = useRef({ effPps, contentW, totalDur, fitPps, maxPps });
  zoomStateRef.current = { effPps, contentW, totalDur, fitPps, maxPps };
  const zoomTo = (nextPps: number, anchorX: number) => {
    const sc = scrollRef.current;
    const z = zoomStateRef.current;
    const clamped = Math.min(z.maxPps, Math.max(z.fitPps, nextPps));
    if (sc) {
      pendingAnchorRef.current = {
        t: ((sc.scrollLeft + anchorX) / z.contentW) * z.totalDur,
        x: anchorX,
      };
    }
    setPps(clamped);
  };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const a = pendingAnchorRef.current;
    if (!sc || !a) return;
    pendingAnchorRef.current = null;
    sc.scrollLeft = Math.max(0, (a.t / totalDur) * contentW - a.x);
  }, [contentW, totalDur]);

  // Mouse wheel scrolls the strip sideways (Ctrl/⌘ + wheel or a
  // trackpad pinch zooms); two-finger pinch zooms on touch screens.
  const lastUserScrollRef = useRef(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      const rect = sc.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        lastUserScrollRef.current = Date.now();
        zoomToRef.current(
          zoomStateRef.current.effPps * Math.exp(-e.deltaY * 0.01),
          e.clientX - rect.left,
        );
        return;
      }
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        lastUserScrollRef.current = Date.now();
        return; // native horizontal scroll (trackpad, shift+wheel)
      }
      const max = sc.scrollWidth - sc.clientWidth;
      // At either end, let the page scroll as usual.
      if (max <= 0 || (e.deltaY < 0 && sc.scrollLeft <= 0) || (e.deltaY > 0 && sc.scrollLeft >= max - 1)) return;
      e.preventDefault();
      lastUserScrollRef.current = Date.now();
      sc.scrollLeft += e.deltaY;
    };
    let pinch: { dist: number; pps: number } | null = null;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      lastUserScrollRef.current = Date.now();
      if (e.touches.length === 2) {
        pinch = { dist: dist(e.touches), pps: zoomStateRef.current.effPps };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      lastUserScrollRef.current = Date.now();
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      zoomToRef.current((pinch.pps * dist(e.touches)) / pinch.dist, midX);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    sc.addEventListener("touchstart", onTouchStart, { passive: true });
    sc.addEventListener("touchmove", onTouchMove, { passive: false });
    sc.addEventListener("touchend", onTouchEnd);
    sc.addEventListener("touchcancel", onTouchEnd);
    return () => {
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("touchstart", onTouchStart);
      sc.removeEventListener("touchmove", onTouchMove);
      sc.removeEventListener("touchend", onTouchEnd);
      sc.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [open]);

  // Click on the ruler → seek. Converts cut-timeline x into the
  // original time of whichever clip sits there.
  const seekFromRuler = (clientX: number) => {
    const el = stripRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cut = Math.max(0, Math.min(totalDur, ((clientX - rect.left) / rect.width) * totalDur));
    let acc = 0;
    for (const s of segments) {
      if (s.disabled) continue;
      const d = s.end - s.start;
      if (cut <= acc + d) {
        onSeekOriginal(Math.min(s.end, s.start + (cut - acc)), s.id);
        return;
      }
      acc += d;
    }
  };

  // Keep the playhead in view while it moves — unless the user just
  // scrolled or zoomed by hand, so we don't yank the strip away.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || playheadPct === null || !canZoomOut || draggingId) return;
    if (Date.now() - lastUserScrollRef.current < 2500) return;
    const x = (playheadPct / 100) * contentW;
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) {
      sc.scrollTo({ left: Math.max(0, x - sc.clientWidth / 3), behavior: "smooth" });
    }
  }, [playheadPct, contentW, canZoomOut, draggingId]);

  const toolBtn = {
    background: "var(--surface-2)",
    color: "var(--text-body)",
    border: "1px solid var(--border)",
  } as const;

  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <button
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        style={{ borderBottom: open ? "1px solid var(--border)" : "none" }}
      >
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
            {t("app.timeline.title")}
            <span
              className="rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal tabular-nums"
              style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
            >
              {t(activeCount === 1 ? "app.timeline.clipsOne" : "app.timeline.clipsOther", {
                count: activeCount,
                dur: fmt(totalDur),
              })}
            </span>
            {saving && (
              <span
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal"
                style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--brand)", animation: "soft-pulse 1.2s ease-in-out infinite" }}
                />
                {t("app.timeline.saving")}
              </span>
            )}
            {saveError && !saving && (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal"
                style={{ background: "rgba(239,107,87,0.14)", color: "var(--danger)" }}
                title={
                  saveError === "failed"
                    ? t("app.timeline.saveFailedTitle")
                    : t("app.timeline.saveRetryingTitle")
                }
              >
                {saveError === "failed" ? t("app.timeline.notSaved") : t("app.timeline.notSavedRetrying")}
              </span>
            )}
          </div>
          <div className="mt-1 hidden text-[11px] text-[var(--text-faint)] sm:block">
            {t("app.timeline.hintDesktop")}
          </div>
          <div className="mt-1 text-[11px] text-[var(--text-faint)] sm:hidden">
            {t("app.timeline.hintMobile")}
          </div>
        </div>

      </button>

      {open && (
        <div className="p-3">
          {/* Toolbar */}
          <div className="mb-3 flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
              <button
                onClick={undo}
                disabled={history.length === 0}
                className="px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 disabled:hover:bg-transparent sm:px-2.5 sm:py-1"
                style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
                title={t("app.timeline.undoTitle")}
                aria-label={t("app.timeline.undoAria")}
              >
                ↶
              </button>
              <button
                onClick={redo}
                disabled={future.length === 0}
                className="px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 disabled:hover:bg-transparent sm:px-2.5 sm:py-1"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  borderLeft: "1px solid var(--border)",
                }}
                title={t("app.timeline.redoTitle")}
                aria-label={t("app.timeline.redoAria")}
              >
                ↷
              </button>
            </div>
            <button
              onClick={splitAtPlayhead}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:border-[var(--brand)] sm:px-2.5 sm:py-1"
              style={{ ...toolBtn, color: "var(--text-strong)" }}
              title={t("app.timeline.splitTitle")}
            >
              {t("app.timeline.split")}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <span
                className="rounded-md px-2 py-1 font-mono text-[11px] tabular-nums"
                style={{ background: "var(--surface-0)", color: "var(--text-strong)" }}
              >
                {fmtTimecode(playheadCut ?? 0)}
                <span className="hidden sm:inline" style={{ color: "var(--text-faint)" }}>
                  {" "}/ {fmt(totalDur)}
                </span>
              </span>
              <div className="flex items-center overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
                <button
                  onClick={() => zoomTo(effPps / 1.5, viewW / 2)}
                  disabled={!canZoomOut}
                  className="px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:px-2 sm:py-1"
                  style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
                  title={t("app.timeline.zoomOutTitle")}
                  aria-label={t("app.timeline.zoomOutAria")}
                >
                  −
                </button>
                <button
                  onClick={() => zoomTo(fitPps, 0)}
                  disabled={!canZoomOut}
                  className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:py-1"
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text-muted)",
                    borderLeft: "1px solid var(--border)",
                  }}
                  title={t("app.timeline.fitTitle")}
                >
                  {t("app.timeline.fit")}
                </button>
                <button
                  onClick={() => zoomTo(effPps * 1.5, viewW / 2)}
                  disabled={!canZoomIn}
                  className="px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:px-2 sm:py-1"
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text-body)",
                    borderLeft: "1px solid var(--border)",
                  }}
                  title={t("app.timeline.zoomInTitle")}
                  aria-label={t("app.timeline.zoomInAria")}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* Ruler + clip strip — width scales with zoom, in a scroll container */}
          <div
            ref={scrollRef}
            className="overflow-x-auto rounded-xl"
            style={{
              background: "var(--surface-0)",
              border: "1px solid var(--border)",
              // Native swipe/scroll; pinch is handled above instead of
              // zooming the whole page.
              touchAction: "pan-x pan-y",
              scrollbarWidth: "thin",
              scrollbarColor: "var(--border-strong) transparent",
            }}
          >
            <div
              className="relative select-none"
              style={{ width: `${contentW}px` }}
            >
              {/* Time ruler */}
              <div
                className="relative h-7 cursor-pointer sm:h-6"
                style={{ borderBottom: "1px solid var(--border)", touchAction: "none" }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  scrubbingRef.current = true;
                  seekFromRuler(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (scrubbingRef.current) seekFromRuler(e.clientX);
                }}
                onPointerUp={() => {
                  scrubbingRef.current = false;
                }}
                onPointerCancel={() => {
                  scrubbingRef.current = false;
                }}
              >
                <RulerTicks scrollRef={scrollRef} contentW={contentW} totalDur={totalDur} viewW={viewW} />
              </div>

              {/* Clips */}
              <div
                ref={stripRef}
                className="relative flex h-20 items-stretch py-2"
              >
                {(dragPreviewRef.current ?? segments).map((s, i) => {
                  const dur = s.end - s.start;
                  const width = (dur / totalDur) * 100;
                  const isSel = selected === s.id;
                  const isDragging = draggingId === s.id;
                  const fadeInPct = s.fadeIn ? Math.min(50, (s.fadeIn / Math.max(dur, 0.01)) * 100) : 0;
                  const fadeOutPct = s.fadeOut ? Math.min(50, (s.fadeOut / Math.max(dur, 0.01)) * 100) : 0;
                  return (
                    <div
                      key={s.id}
                      className="relative shrink-0 px-[1.5px]"
                      style={{ width: `${width}%`, minWidth: "14px" }}
                    >
                      <div
                        onClick={() => {
                          setSelected(s.id);
                          onSeekOriginal(s.start, s.id);
                        }}
                        className="@container group relative flex h-full cursor-pointer flex-col justify-between overflow-clip rounded-md transition-[box-shadow,border-color] duration-150"
                        style={{
                          background: s.disabled
                            ? "var(--surface-2)"
                            : isSel
                              ? "linear-gradient(180deg, rgba(139,92,246,0.45) 0%, rgba(139,92,246,0.22) 100%)"
                              : i % 2 === 0
                                ? "linear-gradient(180deg, rgba(139,92,246,0.24) 0%, rgba(139,92,246,0.10) 100%)"
                                : "linear-gradient(180deg, rgba(167,139,250,0.20) 0%, rgba(167,139,250,0.08) 100%)",
                          border: isSel
                            ? "1px solid var(--brand-hover)"
                            : "1px solid rgba(139,92,246,0.28)",
                          boxShadow: isSel || isDragging ? "var(--shadow-glow)" : "none",
                          opacity: s.disabled ? 0.35 : 1,
                        }}
                      >
                        {/* Fade ramps */}
                        {fadeInPct > 0 && (
                          <div
                            className="pointer-events-none absolute inset-y-0 left-0"
                            style={{
                              width: `${fadeInPct}%`,
                              background: "linear-gradient(90deg, rgba(11,10,16,0.85), rgba(11,10,16,0.15))",
                            }}
                          />
                        )}
                        {fadeOutPct > 0 && (
                          <div
                            className="pointer-events-none absolute inset-y-0 right-0"
                            style={{
                              width: `${fadeOutPct}%`,
                              background: "linear-gradient(270deg, rgba(11,10,16,0.85), rgba(11,10,16,0.15))",
                            }}
                          />
                        )}

                        {!s.disabled && (
                          <>
                            {(["start", "end"] as const).map((mode) => (
                              // Hit area is wider than the visible bar on
                              // touch screens. Without hover, handles only
                              // react on the selected clip so a tap near an
                              // edge selects instead of trimming.
                              <div
                                key={mode}
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setDraggingId(s.id);
                                  setDragMode(mode);
                                }}
                                onTouchStart={(e) => {
                                  e.stopPropagation();
                                  setDraggingId(s.id);
                                  setDragMode(mode);
                                }}
                                className={`absolute top-0 bottom-0 z-10 w-5 cursor-ew-resize transition-opacity [@media(hover:hover)]:w-2 ${
                                  mode === "start" ? "left-0" : "right-0"
                                } ${
                                  isSel || isDragging
                                    ? "opacity-100"
                                    : "pointer-events-none opacity-0 [@media(hover:hover)]:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100"
                                }`}
                                style={{ touchAction: "none" }}
                              >
                                <div
                                  className={`absolute top-0 bottom-0 flex w-2.5 items-center justify-center [@media(hover:hover)]:w-2 ${
                                    mode === "start" ? "left-0" : "right-0"
                                  }`}
                                  style={{
                                    background: isSel ? "var(--brand)" : "var(--border-strong)",
                                  }}
                                >
                                  <span
                                    className="h-4 w-px rounded-full"
                                    style={{ background: "rgba(255,255,255,0.7)" }}
                                  />
                                </div>
                              </div>
                            ))}
                          </>
                        )}

                        <div className="pointer-events-none relative hidden items-center justify-between gap-1 px-2.5 pt-1 @min-[30px]:flex">
                          {/* Sticky so the labels stay visible when the
                              clip's start is scrolled out of view. */}
                          <span
                            className="sticky left-2.5 text-[9px] font-semibold tabular-nums"
                            style={{ color: isSel ? "var(--brand-strong)" : "var(--text-muted)" }}
                          >
                            {i + 1}
                          </span>
                          {!s.disabled && (
                            <div className="sticky right-2.5 hidden gap-0.5 @min-[64px]:flex">
                              {s.speed && s.speed !== 1 && (
                                <span
                                  className="rounded px-1 text-[8px] font-semibold"
                                  style={{ background: "var(--brand)", color: "white" }}
                                >
                                  {s.speed}×
                                </span>
                              )}
                              {s.volume !== undefined && s.volume !== 1 && (
                                <span
                                  className="rounded px-1 text-[8px] font-semibold"
                                  style={{
                                    background: s.volume === 0 ? "var(--danger)" : "var(--warn)",
                                    color: "white",
                                  }}
                                >
                                  {s.volume === 0 ? t("app.timeline.muteBadge") : `${Math.round(s.volume * 100)}%`}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="pointer-events-none relative hidden px-2.5 pb-1 @min-[40px]:block">
                          <span
                            className="sticky left-2.5 inline-block text-[10px] tabular-nums"
                            style={{
                              color: s.disabled ? "var(--text-faint)" : "var(--text-strong)",
                            }}
                          >
                            {fmt(dur)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Playhead — spans ruler + strip */}
              {playheadPct !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20"
                  style={{ left: `${playheadPct}%`, transform: "translateX(-50%)" }}
                >
                  <div
                    className="absolute left-1/2 top-0 -translate-x-1/2"
                    style={{
                      width: 0,
                      height: 0,
                      borderLeft: "5px solid transparent",
                      borderRight: "5px solid transparent",
                      borderTop: "7px solid var(--accent)",
                    }}
                  />
                  <div
                    className="mx-auto h-full w-0.5"
                    style={{
                      background: "var(--accent)",
                      boxShadow: "0 0 8px rgba(236,72,153,0.55)",
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Effects panel — only when a segment is selected */}
          {selectedSeg && !selectedSeg.disabled && (
            <div
              className="mt-3 grid grid-cols-1 gap-2 rounded-lg p-3 text-[11px] sm:grid-cols-2"
              style={{
                background: "var(--surface-0)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="col-span-1 flex flex-wrap items-center gap-x-3 gap-y-2 sm:col-span-2">
                <span
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
                >
                  {t("app.timeline.clipLabel", {
                    n: segments.findIndex((x) => x.id === selectedSeg.id) + 1,
                  })}
                </span>
                <span className="tabular-nums" style={{ color: "var(--text-strong)" }}>
                  {fmt(selectedSeg.start)} → {fmt(selectedSeg.end)}
                  <span className="ml-1.5" style={{ color: "var(--text-faint)" }}>
                    ({(selectedSeg.end - selectedSeg.start).toFixed(1)}s)
                  </span>
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => moveLeft(selectedSeg.id)}
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] sm:px-2.5 sm:py-1"
                    style={toolBtn}
                    title={t("app.timeline.moveLeft")}
                    aria-label={t("app.timeline.moveLeft")}
                  >
                    ←
                  </button>
                  <button
                    onClick={() => moveRight(selectedSeg.id)}
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] sm:px-2.5 sm:py-1"
                    style={toolBtn}
                    title={t("app.timeline.moveRight")}
                    aria-label={t("app.timeline.moveRight")}
                  >
                    →
                  </button>
                  <button
                    onClick={() => del(selectedSeg.id)}
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[rgba(239,107,87,0.12)] sm:px-2.5 sm:py-1"
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--danger)",
                      border: "1px solid rgba(239,107,87,0.3)",
                    }}
                    title={t("app.timeline.deleteTitle")}
                  >
                    {t("app.timeline.delete")}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.speed")}</span>
                <select
                  value={selectedSeg.speed ?? 1}
                  onChange={(e) => patchSeg(selectedSeg.id, { speed: Number(e.target.value) })}
                  className="flex-1 rounded-md px-2 py-1 text-base sm:text-xs"
                  style={{
                    background: "var(--surface-1)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={0.75}>0.75×</option>
                  <option value={1}>{t("app.timeline.speedNormal")}</option>
                  <option value={1.25}>1.25×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2}>2×</option>
                  <option value={3}>3×</option>
                  <option value={4}>4×</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.volume")}</span>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.05}
                  value={selectedSeg.volume ?? 1}
                  onChange={(e) => patchSeg(selectedSeg.id, { volume: Number(e.target.value) })}
                  className="flex-1"
                  style={{ accentColor: "var(--brand)" }}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {Math.round(((selectedSeg.volume ?? 1) * 100))}%
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.fadeIn")}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeIn ?? 0}
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeIn: Number(e.target.value) })}
                  className="flex-1"
                  style={{ accentColor: "var(--brand)" }}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {(selectedSeg.fadeIn ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.fadeOut")}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeOut ?? 0}
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeOut: Number(e.target.value) })}
                  className="flex-1"
                  style={{ accentColor: "var(--brand)" }}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {(selectedSeg.fadeOut ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="col-span-1 sm:col-span-2 flex justify-end">
                <button
                  onClick={() =>
                    patchSeg(selectedSeg.id, {
                      speed: 1,
                      volume: 1,
                      fadeIn: 0,
                      fadeOut: 0,
                    })
                  }
                  className="rounded-md px-2 py-1 text-[10px]"
                  style={{
                    background: "transparent",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {t("app.timeline.resetEffects")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
