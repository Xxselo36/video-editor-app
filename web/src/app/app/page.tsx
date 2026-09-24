"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { downscaleVideo, shouldDownscale } from "@/lib/videoDownscale";
import { notifyIfHidden, requestNotificationPermission } from "@/lib/notify";
import { uploadResumable } from "@/lib/chunkedUpload";
import {
  addActiveJob,
  getActiveJobs,
  removeActiveJob,
  subscribeActiveJobs,
  updateActiveJob as updateActiveJobV2,
  type ActiveJobV2,
} from "@/lib/activeJobs";

// Backend host: explicit env wins, else use the page's hostname on
// port 8000. This way iPhone (192.168.178.155:3000) hits
// 192.168.178.155:8000 — not its own localhost.
// Called lazily so it runs in the browser, not during SSR.
function backendUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  if (typeof window === "undefined") return "http://localhost:8000";
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

const CAPTION_PRESETS = [
  { id: "clean", label: "Clean" },
  { id: "classic", label: "Classic" },
  { id: "clipper", label: "Clipper" },
  { id: "highlight", label: "Highlight" },
  { id: "flash", label: "Flash" },
  { id: "punch", label: "Punch" },
  { id: "elegant", label: "Elegant" },
  { id: "subtle", label: "Subtle" },
  { id: "none", label: "No captions" },
];

const CUT_STYLES = [
  { id: "tight", label: "Tight", desc: "Aggressive" },
  { id: "balanced", label: "Balanced", desc: "Default" },
  { id: "smooth", label: "Smooth", desc: "Keep pauses" },
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
    label: string;
    icon: string;
    tagline: string;
    desc: string;
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
    label: "TikTok / Reels",
    icon: "📱",
    tagline: "Vertical short-form",
    desc: "Voice-triggers, Clipper captions, auto-vertical crop",
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
    label: "Podcast Long-Form",
    icon: "🎙",
    tagline: "Full episode + clips",
    desc: "AI cleanup, hook detection, multi-format export",
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
    label: "Vlog Cleanup",
    icon: "✂️",
    tagline: "Solo talking-head",
    desc: "Remove fillers, subtle captions, keep aspect",
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
    label: "Just Captions",
    icon: "💬",
    tagline: "Add captions only",
    desc: "Burn captions on your video — no cuts, no cleanup",
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
    label: "Custom",
    icon: "🎛",
    tagline: "Configure everything",
    desc: "Full settings — pick every knob yourself",
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
};

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
  const [disabledCuts, setDisabledCuts] = useState<number[]>([]);
  const [smartcamEnabled, setSmartcamEnabled] = useState(false);
  const [smartcamFormat, setSmartcamFormat] = useState<"portrait" | "landscape">(
    "portrait",
  );
  const [outputFormats, setOutputFormats] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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
  };

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
    let targetFile = fileOverride ?? file;
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
      presetLabel: presetInfo?.label ?? null,
      presetIcon: presetInfo?.icon ?? null,
      captionPreset: settings.caption_preset,
      uploadPct: 0,
    });

    // Throttle uploadPct updates to ~5/sec. On big files (multi-GB) we
    // get thousands of progress ticks; every one used to write to
    // localStorage + fire a re-render across the dashboard.
    let lastUiUpdate = 0;
    const setPct = (pct: number) => {
      setUploadPct(pct);
      const now = Date.now();
      if (now - lastUiUpdate > 200 || pct >= 100) {
        lastUiUpdate = now;
        updateActiveJobV2(tempId, { uploadPct: pct });
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
      // Two upload paths depending on file size:
      //   - <=90MB: legacy multipart POST /jobs (through Railway).
      //   - >90MB:  presigned R2 PUT direct from browser → then POST
      //             /jobs with the storage_key so backend fetches from R2.
      //             Railway's edge caps HTTP bodies around 100MB.
      const R2_THRESHOLD = 90 * 1024 * 1024; // 90MB
      let res: XMLHttpRequest;

      if (targetFile.size > R2_THRESHOLD) {
        // Chunked resumable upload via S3 multipart on R2. Splits the
        // file into 25MB parts, uploads in parallel with bounded
        // concurrency, and persists progress to localStorage so an
        // interrupted upload can resume from where it left off.
        const { storage_key } = await uploadResumable({
          file: targetFile,
          backendUrl: backendUrl(),
          onProgress: (pct) => setPct(pct),
        });

        // Create the job with the completed storage_key.
        const form = new FormData();
        form.append("storage_key", storage_key);
        form.append("filename", targetFile.name);
        form.append("settings", JSON.stringify(settings));
        res = await new Promise<XMLHttpRequest>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${backendUrl()}/jobs`);
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.send(form);
        });
      } else {
        // Legacy path — direct multipart upload to Railway.
        const form = new FormData();
        form.append("file", targetFile);
        form.append("settings", JSON.stringify(settings));
        res = await new Promise<XMLHttpRequest>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${backendUrl()}/jobs`);
          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
              setPct(Math.round((ev.loaded / ev.total) * 100));
            }
          };
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.send(form);
        });
      }

      if (res.status >= 400) {
        throw new Error(`Upload failed: ${res.responseText}`);
      }
      const initial: JobStatus = JSON.parse(res.responseText);

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
        presetLabel: presetInfo?.label ?? null,
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
        presetLabel: presetInfo?.label ?? null,
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
      const msg = err instanceof Error ? err.message : String(err);
      updateActiveJobV2(tempId, { error: msg });
    } finally {
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
        const r = await fetch(`${backendUrl()}/jobs/${job.id}`);
        if (!r.ok) return;
        const s: JobStatus = await r.json();
        setJob(s);
        if (s.status === "done") {
          setPhase("done");
          notifyIfHidden(
            "CleoCuts — your video is ready",
            file?.name ?? "Click to view",
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
              presetLabel: p?.label ?? null,
              filename: file?.name ?? "Untitled",
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
          const subRes = await fetch(
            `${backendUrl()}/jobs/${job.id}/subtitles`,
          );
          if (subRes.ok) {
            const data = await subRes.json();
            const subs: Subtitle[] = data.subtitles ?? [];
            setPhrases(buildPhrases(subs));
            setPhase("reviewing");
            updateActiveJob({ phase: "reviewing" });
            notifyIfHidden(
              "CleoCuts — ready for your review",
              "Cuts + transcript are done. Tap to review.",
            );
          }
        }
      } catch {
        // transient — keep polling
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase, job]);

  const onApplyRender = async () => {
    if (!job) return;
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
      const r = await fetch(`${backendUrl()}/jobs/${job.id}/render`, {
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
      updateActiveJobV2(job.id, { phase: "rendering" });
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

  const reset = () => {
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

  const currentPreset = selectedPreset ? PRESETS[selectedPreset] : null;

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            aria-label="CleoCuts home"
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
                <span>{currentPreset.label}</span>
                <span style={{ color: "var(--brand-strong)", opacity: 0.6 }}>✕</span>
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/app/library"
            className="text-xs transition-colors hover:opacity-70"
            style={{ color: "var(--text-body)" }}
          >
            Library
          </Link>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
            style={{
              background: "var(--brand-tint)",
              color: "var(--brand-strong)",
            }}
          >
            Beta
          </span>
        </div>
      </header>

      <div
        key={phase}
        className={`phase-fade mx-auto w-full flex-1 px-5 py-8 ${
          phase === "picker" ? "max-w-2xl" : "max-w-md"
        }`}
      >
        {phase === "picker" && (
          <PickerScreen
            onPick={pickPreset}
            onResumeJob={async (jobId) => {
              try {
                const r = await fetch(`${backendUrl()}/jobs/${jobId}`);
                if (!r.ok) return;
                const s: JobStatus = await r.json();
                setJob(s);
                if (s.status === "awaiting_review") {
                  const subsRes = await fetch(
                    `${backendUrl()}/jobs/${jobId}/subtitles`,
                  );
                  if (subsRes.ok) {
                    const sd = await subsRes.json();
                    setPhrases(buildPhrases(sd.subtitles ?? []));
                  }
                  setPhase("reviewing");
                } else if (s.status === "done") {
                  setPhase("done");
                } else {
                  setPhase("analyzing");
                }
              } catch {
                /* ignore */
              }
            }}
          />
        )}

        {phase === "idle" && <IdleScreen onPick={onPickFile} onDrop={onDrop} />}

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
            jobId={job.id}
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
                const r = await fetch(
                  `${backendUrl()}/jobs/${job.id}/recompute-scenes`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ events: evts }),
                  },
                );
                if (r.ok) {
                  const updated = await r.json();
                  setJob(updated);
                }
              } catch {
                // ignore
              }
            }}
            onChange={setPhrases}
            onApply={onApplyRender}
            onBack={reset}
          />
        )}

        {/* rendering / done fullscreens killed — cards on picker are
            the single source of truth for post-upload status. */}

        {phase === "error" && (
          <ErrorScreen
            message={errorMsg ?? "Something went wrong"}
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
const PRESET_BULLETS: Record<PresetId, string[]> = {
  tiktok: [
    "Voice-triggers on: say &ldquo;Cleo cut&rdquo; to redo",
    "Bold Clipper-style captions",
    "Auto vertical 9:16 with face tracking",
  ],
  podcast: [
    "AI cleanup on your transcript",
    "3 hook clips picked automatically",
    "Full episode + 9:16 clips exported",
  ],
  vlog: [
    "Removes &ldquo;ähm&rdquo;, &ldquo;uh&rdquo;, long pauses",
    "Subtle captions that don&apos;t distract",
    "Keeps your original aspect",
  ],
  captions: [
    "Burns captions in your picked style",
    "No cuts, no cleanup",
    "Fastest — just captions",
  ],
  custom: [
    "Every setting exposed",
    "Pick captions, cuts, format yourself",
    "For when you know what you want",
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

function getPresetChips(p: (typeof PRESETS)[PresetId]): string[] {
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
  const captionLabel = CAPTION_PRESETS.find(
    (c) => c.id === p.settings.captionPreset,
  )?.label;
  if (captionLabel && p.settings.captionPreset !== "none") {
    chips.push(`${captionLabel} captions`);
  } else if (p.settings.captionPreset === "none") {
    chips.push("No captions");
  }

  // Voice triggers indicator
  if (p.settings.voiceTriggers) {
    chips.push('"Cleo cut" on');
  }

  return chips;
}

function PickerScreen({
  onPick,
  onResumeJob,
}: {
  onPick: (id: PresetId) => void;
  onResumeJob?: (jobId: string) => void;
}) {
  const featured: PresetId[] = ["tiktok", "podcast", "vlog", "captions"];
  const [recent, setRecent] = useState<LibraryEntry[] | null>(null);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  const [showVoiceOnboarding, setShowVoiceOnboarding] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJobV2[]>([]);
  const [jobStatuses, setJobStatuses] = useState<
    Record<string, { progress: number; message: string; status: string }>
  >({});
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
    try {
      const seen = localStorage.getItem("cleocuts.voiceOnboardingSeen.v1");
      if (!seen) setShowVoiceOnboarding(true);
    } catch {
      // localStorage may be blocked; that's fine, don't nag.
    }
  }, []);

  // React to add/update/remove from anywhere in the app (uploads
  // starting, progress ticks, jobs finishing). Bumps to dashboard
  // when a job first appears so the user sees their upload land.
  useEffect(() => {
    const refresh = () => {
      const jobs = getActiveJobs();
      setActiveJobs(jobs);
      if (jobs.length > 0) setView("dashboard");
    };
    return subscribeActiveJobs(refresh);
  }, []);

  // Poll all active jobs every 2s so the cards show live status
  useEffect(() => {
    const active = activeJobs.filter((j) => j.phase !== "uploading");
    if (active.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const updates: typeof jobStatuses = {};
      for (const j of active) {
        try {
          const r = await fetch(`${backendUrl()}/jobs/${j.jobId}`);
          if (!r.ok) continue;
          const s = await r.json();
          updates[j.jobId] = {
            progress: s.progress ?? 0,
            message: s.message ?? "",
            status: s.status,
          };
          // Promote to matching phase if backend advanced
          if (
            s.status === "awaiting_review" &&
            j.phase !== "reviewing"
          ) {
            updateActiveJobV2(j.jobId, { phase: "reviewing" });
          } else if (
            s.status === "processing" &&
            j.phase === "analyzing" &&
            s.message?.toLowerCase().includes("render")
          ) {
            updateActiveJobV2(j.jobId, { phase: "rendering" });
          } else if (s.status === "done") {
            // Persist the finished render to the library so the user
            // can find it later. Backend keeps the files on Railway's
            // volume for the retention window.
            try {
              const withOutputs = s as typeof s & {
                outputs?: string[] | Record<string, string>;
                social_caption?: string;
                social_hashtags?: string[];
                hook_clips?: LibraryHookClip[];
              };
              // Backend returns outputs as a list of format keys
              // (["primary", "9:16"]). Older versions returned an
              // object — handle both shapes so we never save numeric
              // indices as format identifiers.
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
              notifyIfHidden(
                "CleoCuts — your video is ready",
                j.filename,
              );
            } catch {
              /* library save is non-fatal */
            }
            removeActiveJob(j.jobId);
          } else if (s.status === "error") {
            updateActiveJobV2(j.jobId, { phase: j.phase });
          }
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) {
        setJobStatuses((prev) => ({ ...prev, ...updates }));
        setActiveJobs(getActiveJobs());
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeJobs]);

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
              Your workspace
            </div>
            <h1
              className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl"
              style={{ color: "var(--text-strong)" }}
            >
              {activeJobs.length > 0
                ? `${activeJobs.length} video${activeJobs.length === 1 ? "" : "s"} in progress`
                : "Ready when you are"}
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
            New video
          </button>
        </div>

        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div className="mb-10">
            <div
              className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em]"
              style={{ color: "var(--text-muted)" }}
            >
              In progress
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
                Recent projects
              </div>
              <Link
                href="/app/library"
                className="text-xs transition-opacity hover:opacity-70"
                style={{ color: "var(--brand-strong)" }}
              >
                View all →
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
                Start your first video
              </div>
              <div
                className="text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Pick a workflow — CleoCuts handles captions, format, cleanup
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
          Say &ldquo;Cleo&rdquo; while recording — save hours of editing
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
          Back to dashboard
        </button>
      )}

      {/* Hero */}
      <div className="mb-10">
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
          Free during beta
        </div>

        <h1
          className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl"
          style={{ color: "var(--text-strong)" }}
        >
          What are you shipping?
        </h1>
        <p
          className="max-w-md text-base leading-relaxed"
          style={{ color: "var(--text-body)" }}
        >
          Pick a workflow — CleoCuts pre-configures captions, format, and
          cleanup for the platform.
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
          Say &ldquo;Cleo&rdquo; while recording — save hours of editing
          <span className="opacity-70">→</span>
        </button>
      </div>

      {/* Preset grid — big cards with per-preset accent glow + config chips */}
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {featured.map((id) => {
          const p = PRESETS[id];
          const Icon = PRESET_ICONS[id];
          const accent = PRESET_ACCENTS[id];
          const chips = getPresetChips(p);
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
                  {p.label}
                </div>
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {p.tagline}
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
            Custom setup
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Pick every knob yourself — captions, cuts, formats
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
  const [thumbFailed, setThumbFailed] = useState(false);
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
        {!thumbFailed && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`${backendUrl()}/jobs/${entry.jobId}/thumbnail`}
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
            no preview
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
            {entry.presetLabel ?? "Custom"}
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
          {entry.filename}
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
}: {
  onPick: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div className="relative z-10 flex flex-col">
      <h1
        className="mb-8 text-4xl font-bold tracking-tight sm:text-5xl"
        style={{ color: "var(--text-strong)" }}
      >
        Drop the video.
      </h1>

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
          Tap to choose
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          Or drag one in
        </div>
      </button>
    </div>
  );
}

const EXPORT_FORMAT_OPTIONS = [
  { id: "9:16", label: "9:16", desc: "TikTok / Reels / Shorts" },
  { id: "1:1", label: "1:1", desc: "Instagram feed" },
  { id: "16:9", label: "16:9", desc: "YouTube / desktop" },
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
  const sizeMB = (props.file.size / 1024 / 1024).toFixed(1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button
          onClick={props.onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          ← back
        </button>
        <div className="truncate text-xs text-[var(--text-body)]">
          {props.file.name} · {sizeMB} MB
        </div>
      </div>

      <Section title="Caption style">
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
                  src={`${backendUrl()}/caption-previews/${p.id}.png?w=320&h=110`}
                  alt={`${p.label} caption preview`}
                  className="block h-[64px] w-full bg-[var(--surface-1)] object-cover"
                  loading="lazy"
                />
                <div className="px-3 py-2 text-xs font-medium">{p.label}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Cut style">
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
              <div className="text-xs font-medium">{s.label}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{s.desc}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Cleanup">
        <ToggleRow
          label='Listen for "Cleo cut" / "Cleo go"'
          desc="Auto-removes failed takes"
          checked={props.voiceTriggers}
          onChange={props.setVoiceTriggers}
        />
        <ToggleRow
          label="Remove filler words"
          desc='Cuts out "ähm", "uh", "like"…'
          checked={props.removeFillers}
          onChange={props.setRemoveFillers}
        />
      </Section>

      <Section title="Smart reframe">
        <ToggleRow
          label="SmartCam face-tracking"
          desc="Auto-reframe for vertical/horizontal output"
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
                <div className="font-medium capitalize">{f}</div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {f === "portrait" ? "Vertical 9:16" : "Horizontal 16:9"}
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Extra output formats">
        <div className="text-[10px] text-[var(--text-muted)] -mt-1">
          Primary export is your SmartCam format (or original aspect). Pick
          extra letterbox-padded versions for other platforms.
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
                <div className="text-[10px] text-[var(--text-muted)]">{f.desc}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <button
        onClick={props.onProcess}
        className="mt-2 w-full rounded-xl bg-[var(--brand)] px-6 py-4 text-base font-semibold hover:bg-[var(--brand-hover)] active:scale-[0.99]"
      >
        Process video
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
const ANALYZE_STAGES = [
  { key: "prep", label: "Preparing your video", from: 0, to: 10 },
  { key: "listen", label: "Listening to your voice", from: 10, to: 80 },
  { key: "polish", label: "Finding the good takes", from: 80, to: 95 },
  { key: "preview", label: "Almost ready", from: 95, to: 100 },
];

const RENDER_STAGES = [
  { key: "burn", label: "Applying your edits", from: 0, to: 70 },
  { key: "stitch", label: "Stitching it together", from: 70, to: 90 },
  { key: "finish", label: "Final touches", from: 90, to: 100 },
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
          {phase === "uploading" ? "Uploading" : phase === "rendering" ? "Rendering" : "Processing"}
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
              Keep this tab open until the upload finishes. Switching apps
              or locking your phone will cancel the upload.
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
                  {s.label}
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
  const formatLabel = (f: string) =>
    f === "primary" ? "Download primary" : `Download ${f}`;
  const formatSub = (f: string) => {
    if (f === "9:16") return "TikTok / Reels / Shorts";
    if (f === "1:1") return "Instagram feed";
    if (f === "16:9") return "YouTube / desktop";
    return "Main edit";
  };

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
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={`${backendUrl()}/jobs/${jobId}/watch`}
          poster={`${backendUrl()}/jobs/${jobId}/thumbnail`}
          controls
          autoPlay
          muted
          loop
          playsInline
          className="block w-full"
          style={{ maxHeight: "60vh" }}
        />
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--brand-strong)" }}>
        <span className="text-base">✨</span> Ready to post
      </div>

      {(socialCaption || hashtagLine) && (
        <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
              Caption suggestion
            </span>
            <button
              onClick={() => copyText(`${socialCaption}\n\n${hashtagLine}`.trim())}
              className="text-[10px] uppercase tracking-wider text-[var(--brand)] hover:text-[var(--brand-hover)]"
            >
              copy
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
              href={`${backendUrl()}/jobs/${jobId}/download?format=${encodeURIComponent(f)}`}
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
            <span>Bonus clips</span>
            <span className="rounded bg-[var(--brand)]/15 px-1.5 py-0.5 text-[var(--brand-hover)]">
              AI-picked
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {hookClips.map((h) => {
              const dur = h.end - h.start;
              return (
                <a
                  key={h.key}
                  href={`${backendUrl()}/jobs/${jobId}/download?format=${encodeURIComponent(h.key)}`}
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
        Process another
      </button>
    </div>
  );
}

function ReviewScreen({
  jobId,
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const phraseRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Poll video.currentTime every animation frame while playing.
  // onTimeUpdate only fires ~4x/sec (browser throttle) which lags the
  // active-phrase highlight visibly behind the spoken word. rAF hits
  // ~60fps so the highlight lands on the syllable.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId = 0;
    const tick = () => {
      if (!video.paused && !video.ended) {
        setCurrentTime(video.currentTime);
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

  const originalTime = useMemo(() => {
    if (!keptSegments.length) return currentTime;
    let acc = 0;
    for (const [s, e] of keptSegments) {
      const segDur = e - s;
      if (acc + segDur >= currentTime) return s + (currentTime - acc);
      acc += segDur;
    }
    return duration;
  }, [currentTime, keptSegments, duration]);

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
  const [editSegs, setEditSegs] = useState<EditableSeg[]>([]);
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
  const swapWhenPausedRef = useRef(false);

  const swapPreviewSrc = () => {
    const v = videoRef.current;
    if (!v) return;
    const base = `${backendUrl()}/jobs/${jobId}/preview-video`;
    const wasTime = v.currentTime;
    v.src = `${base}?v=${Date.now()}`;
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

  const doRebuild = async () => {
    const next = pendingRebuildRef.current;
    if (!next) return;
    pendingRebuildRef.current = null;
    const active = next
      .filter((s) => !s.disabled && s.end - s.start > 0.05)
      .map((s) => ({ start: s.start, end: s.end }));
    if (active.length === 0) return;
    setEditSaving(true);
    try {
      const r = await fetch(`${backendUrl()}/jobs/${jobId}/edit-segments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: active }),
      });
      if (r.ok) {
        const v = videoRef.current;
        if (v && v.paused) {
          swapPreviewSrc();
        } else {
          // Defer the src swap until the user pauses — we DO NOT
          // interrupt playback in flight. The pause listener below
          // performs the swap when they stop.
          swapWhenPausedRef.current = true;
        }
      }
    } catch {
      /* transient — the next edit will retry */
    } finally {
      setEditSaving(false);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => {
      if (swapWhenPausedRef.current) {
        swapWhenPausedRef.current = false;
        swapPreviewSrc();
      }
    };
    v.addEventListener("pause", onPause);
    return () => v.removeEventListener("pause", onPause);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitEditSegs = (next: EditableSeg[]) => {
    setEditSegs(next);
    pendingRebuildRef.current = next;
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      void doRebuild();
    }, 800);
  };

  // Video runs on the RAW source, so we match phrases via their
  // original_start / original_end fields.
  useEffect(() => {
    const idx = phrases.findIndex(
      (p) => currentTime >= p.start && currentTime <= p.end,
    );
    setActiveIdx(idx === -1 ? null : idx);
  }, [currentTime, phrases]);

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
  const remove = (idx: number) => {
    onChange(phrases.filter((_, i) => i !== idx));
  };

  const seekToPhrase = (p: Phrase) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = p.start;
    videoRef.current.play().catch(() => {});
  };


  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          ← cancel
        </button>
        <div className="text-xs text-[var(--text-body)]">
          {phrases.length} sentence{phrases.length === 1 ? "" : "s"}
        </div>
      </div>

      {audioWarnings.length > 0 && (
        <div className="rounded-xl border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]">
          <div className="mb-1 font-semibold uppercase tracking-wider">
            Audio heads-up
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
      <div className="relative overflow-hidden rounded-xl bg-[var(--surface-1)]">
        <video
          ref={videoRef}
          src={`${backendUrl()}/jobs/${jobId}/preview-video`}
          controls
          playsInline
          preload="auto"
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-[var(--surface-0)]"
        />
        {editSaving && (
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
            Updating preview…
          </div>
        )}
      </div>

      {captionPreset !== "none" && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${backendUrl()}/caption-previews/${captionPreset}.png?w=200&h=72`}
            alt={`${captionPreset} caption sample`}
            className="h-10 w-28 rounded-md object-cover"
          />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Captions will look like
            </div>
            <div className="text-sm font-medium capitalize">{captionPreset}</div>
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
            { id: "timeline" as const, label: "Timeline", icon: "⏱" },
            { id: "transcript" as const, label: "Transcript", icon: "T" },
            { id: "style" as const, label: "Captions", icon: "✎" },
          ]
        ).map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className="flex-1 px-3 py-2.5 text-sm font-medium transition-colors"
              style={{
                background: isActive
                  ? "var(--brand-tint)"
                  : "transparent",
                color: isActive
                  ? "var(--brand-strong)"
                  : "var(--text-muted)",
                borderRight: t.id !== "style" ? "1px solid var(--border)" : "none",
              }}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Timeline tab — everything for cut/trim/effects lives here */}
      {activeTab === "timeline" && editSegs.length > 0 && duration > 0 && (
        <TimelineEditor
          segments={editSegs}
          duration={duration}
          playhead={originalTime}
          open={true}
          saving={editSaving}
          onToggleOpen={() => {}}
          onCommit={(next) => void commitEditSegs(next)}
          onSeekOriginal={(t) => {
            // t comes in on the ORIGINAL timeline; map into the
            // cut-timeline the preview video plays on.
            let acc = 0;
            for (const s of editSegs.filter((x) => !x.disabled)) {
              if (t >= s.start && t <= s.end) {
                if (videoRef.current) {
                  videoRef.current.currentTime = acc + (t - s.start);
                }
                return;
              }
              acc += s.end - s.start;
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
      )}

      {/* Transcript tab — phrase-level text editing */}
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
              Transcript · {phrases.length} line{phrases.length === 1 ? "" : "s"}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              Fix typos, drop a line with ✕, tap a card to jump to that moment.
            </div>
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-3"
          >
            {phrases.length === 0 && (
              <div className="rounded-xl border border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
                No captions. Output will be video only.
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
                          verify
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(i);
                        }}
                        className="text-[var(--text-faint)] hover:text-[var(--danger)]"
                        aria-label="delete sentence"
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
            Caption style · {captionPreset}
          </div>
          {captionPreset !== "none" ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3"
              style={{ background: "var(--surface-0)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${backendUrl()}/caption-previews/${captionPreset}.png?w=240&h=90`}
                alt={`${captionPreset} caption preview`}
                className="h-14 w-40 rounded-md object-cover"
              />
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  Applied to output
                </div>
                <div className="text-sm font-medium capitalize">{captionPreset}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">
              Captions disabled for this render.
            </div>
          )}
        </div>
      )}

      <button
        onClick={async () => {
          // Push the user's edited segments to the backend before we
          // hit /render. During editing we kept everything local for
          // instant feedback; render needs the segment list on the
          // server. Fire-and-forget the effects too if the user
          // touched them.
          setEditSaving(true);
          try {
            const active = editSegs
              .filter((s) => !s.disabled && s.end - s.start > 0.05)
              .map((s) => ({
                start: s.start,
                end: s.end,
                speed: s.speed,
                fadeIn: s.fadeIn,
                fadeOut: s.fadeOut,
                volume: s.volume,
              }));
            if (active.length > 0) {
              await fetch(`${backendUrl()}/jobs/${jobId}/edit-segments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ segments: active }),
              });
            }
          } catch {
            /* non-fatal — backend falls back to the pre-edit cuts */
          } finally {
            setEditSaving(false);
          }
          onApply();
        }}
        disabled={editSaving}
        className="mt-1 w-full rounded-xl bg-[var(--brand)] px-6 py-4 text-base font-semibold hover:bg-[var(--brand-hover)] active:scale-[0.99] disabled:opacity-60"
      >
        {editSaving ? "Preparing…" : "Apply & render"}
      </button>
    </div>
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
        <span>Cuts</span>
        <span className="text-[var(--text-faint)]">
          {totalCutSeconds.toFixed(1)}s removed
          {disabled.length > 0 && ` · ${disabled.length} restored`}
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
              title={`Cut ${fmtTime(c.start)}–${fmtTime(c.end)} (tap to ${
                isOff ? "remove again" : "restore"
              })`}
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
        Red = removed · tap to restore. Green dashes = kept.
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
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <div className="text-5xl">⚠️</div>
      <div className="text-base font-semibold">Something went wrong</div>
      <div className="max-w-xs text-center text-xs text-[var(--text-muted)]">{message}</div>
      <button
        onClick={onReset}
        className="mt-2 rounded-xl border border-[var(--border-hover)] px-5 py-2 text-sm hover:border-[var(--brand)]"
      >
        Try again
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const [permStatus, setPermStatus] = useState<
    "idle" | "requesting" | "granted" | "denied" | "unsupported"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [detected, setDetected] = useState<Record<string, number>>({});
  const [lastHitAt, setLastHitAt] = useState(0);

  const targets = [
    { id: "start", phrase: "Cleo start", desc: "Begin your take", color: "#5A9FFF" },
    { id: "cut", phrase: "Cleo cut", desc: "Redo, discard current take", color: "#F26E6E" },
    { id: "keep", phrase: "Cleo keep", desc: "Confirm take, next scene", color: "#4ECC77" },
    { id: "finish", phrase: "Cleo finish", desc: "End video, cut everything after", color: "#B979FF" },
    { id: "stop", phrase: "Cleo stop", desc: "Skip one bad sentence (pair with 'go')", color: "#F5B54D" },
    { id: "go", phrase: "Cleo go", desc: "Resume after 'stop'", color: "#F5B54D" },
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
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
              Test your voice
            </div>
            <div
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Say the commands — see if Cleo hears you.
            </div>
          </div>
          <button
            onClick={onDone}
            aria-label="Close"
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
                  {pulseActive ? "Heard you!" : "Listening…"}
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
                    <span style={{ color: "#aaa" }}>heard: </span>
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
                      Uses your camera + mic. Everything stays in your browser.
                    </div>
                    <button
                      onClick={startTest}
                      disabled={permStatus === "requesting"}
                      className="rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-60"
                      style={{ background: "var(--brand)", color: "white" }}
                    >
                      {permStatus === "requesting" ? "Requesting…" : "Start"}
                    </button>
                  </>
                )}
                {permStatus === "denied" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    Permission denied. Enable in browser settings + reload.
                  </div>
                )}
                {permStatus === "unsupported" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    Not supported in this browser. Try Safari or Chrome.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Command list — always visible, doubles as cheat sheet.
              Single-column with phrase + one-line explanation so the
              user sees what each command DOES, not just its name. */}
          <div className="flex flex-col gap-1.5 p-3">
            {targets.map((t) => {
              const count = detected[t.id] || 0;
              const hit = count > 0;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-2.5 rounded-lg p-2 transition-all"
                  style={{
                    background: "var(--surface-1)",
                    border: `1px solid ${hit ? t.color : "var(--border)"}`,
                    boxShadow: hit ? `0 0 12px ${t.color}55` : "none",
                  }}
                >
                  <div
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all"
                    style={{
                      background: hit ? t.color : "var(--surface-2)",
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
                      {t.phrase}
                    </div>
                    <div
                      className="text-[10px] leading-tight"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t.desc}
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
            Done
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
    start: "Start",
    keep: "Keep",
    restart: "Cut / Restart",
    finish: "Finish",
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

  const addAt = async (t: number, type: SceneEvent["type"]) => {
    const kept = events.filter((_, i) => enabled[i]);
    const added: SceneEvent = {
      type,
      start: t,
      end: Math.min(t + 0.5, duration || t + 0.5),
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
            Voice commands · {events.filter((_, i) => enabled[i]).length} active
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
            Uncheck false detections, add missing ones. Cuts update
            automatically.
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
          + Add
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
            Add command at current video time
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["start", "keep", "restart", "finish"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  const videoEl = document.querySelector(
                    "video",
                  ) as HTMLVideoElement | null;
                  const now = videoEl?.currentTime ?? 0;
                  void addAt(now, t);
                }}
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  background: "var(--surface-1)",
                  color: COLORS[t],
                  border: `1px solid ${COLORS[t]}66`,
                }}
              >
                {LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-[220px] overflow-y-auto p-2">
        {events.length === 0 && (
          <div className="p-3 text-center text-xs text-[var(--text-muted)]">
            No voice commands detected.
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
                aria-label={on ? "Disable" : "Enable"}
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
                    heard: &ldquo;{ev.raw_text}&rdquo;
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
  status?: { progress: number; message: string; status: string };
  onOpen: () => void;
  onRetry?: () => void;
}) {
  const isError = status?.status === "error" || Boolean(job.error);
  const phaseCopy: Record<ActiveJobV2["phase"], { title: string; sub: string; icon: string }> = {
    uploading: {
      title: "Uploading",
      sub: "Sending your video over — hang tight.",
      icon: "↑",
    },
    analyzing: {
      title: "Analyzing",
      sub: "Reading your speech and finding the best moments.",
      icon: "✦",
    },
    reviewing: {
      title: "Ready to edit",
      sub: "Tap to open the editor and fine-tune the cut.",
      icon: "▸",
    },
    rendering: {
      title: "Rendering",
      sub: "Putting your final video together.",
      icon: "✦",
    },
  };
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
      disabled={!canOpen}
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
          {job.presetLabel && (
            <div
              className="mt-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-faint)" }}
            >
              {job.presetLabel}
            </div>
          )}
        </div>
        {canOpen ? (
          <div
            className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-transform group-hover:translate-x-0.5"
            style={{ background: accent, color: "#0f0f0f" }}
          >
            Open →
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
          Something went wrong. {job.error ?? status?.message ?? "Try again."}
        </div>
      ) : (
        <div
          className="relative z-10 mb-3 text-xs leading-relaxed"
          style={{ color: "var(--text-body)" }}
        >
          {copy.sub}
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
            <span>{copy.title}</span>
            <span className="tabular-nums">{Math.round(pct)}%</span>
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
          ↻ Try again
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

function TimelineEditor({
  segments,
  duration,
  playhead,
  open,
  saving,
  onToggleOpen,
  onCommit,
  onSeekOriginal,
  getVideoTime,
  onPlayPauseKey,
}: {
  segments: EditorSeg[];
  duration: number;
  playhead: number;
  open: boolean;
  saving: boolean;
  onToggleOpen: () => void;
  onCommit: (next: EditorSeg[]) => void;
  onSeekOriginal: (t: number) => void;
  getVideoTime: () => number;
  onPlayPauseKey?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragMode, setDragMode] = useState<"start" | "end" | null>(null);
  const [zoom, setZoom] = useState(1); // 1 – 4×
  const [history, setHistory] = useState<EditorSeg[][]>([]);
  const [future, setFuture] = useState<EditorSeg[][]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragPreviewRef = useRef<EditorSeg[] | null>(null);
  const [, forceRender] = useState({});

  // While the user is dragging a trim handle, use the live preview
  // for measurements so the visible strip stays in sync with the
  // dragging cursor. Otherwise fall back to committed props.
  const displaySegs = dragPreviewRef.current ?? segments;
  const totalDur =
    displaySegs.reduce((acc, s) => acc + (s.end - s.start), 0) || 1;
  const activeCount = displaySegs.filter((s) => !s.disabled).length;

  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Wrap onCommit to push history state
  const commit = (next: EditorSeg[]) => {
    setHistory((h) => [...h, segments].slice(-30));
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
    // Start local preview from the current committed state
    dragPreviewRef.current = segments.map((s) => ({ ...s }));

    const handleMove = (e: MouseEvent | TouchEvent) => {
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX;
      const relX = clientX - stripRect.left;
      const seconds = Math.max(0, relX / pxPerSec);

      let acc = 0;
      const base = dragPreviewRef.current ?? segments;
      const next = base.map((s) => {
        if (s.disabled) return s;
        const sDur = s.end - s.start;
        if (s.id === draggingId) {
          if (dragMode === "start") {
            const target = s.end - (sDur - Math.max(0, seconds - acc));
            const clamped = Math.min(s.end - 0.1, Math.max(0, target));
            return { ...s, start: clamped };
          } else if (dragMode === "end") {
            const target = s.start + Math.max(0.1, seconds - acc);
            const clamped = Math.min(duration, Math.max(s.start + 0.1, target));
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
      setDraggingId(null);
      setDragMode(null);
      if (final) {
        onCommit(final);
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
  }, [draggingId, dragMode, totalDur]);

  const del = (id: string) => {
    // Refuse to disable the last active clip — the backend would have
    // nothing to render and the video element would go blank.
    const activeIds = segments.filter((s) => !s.disabled).map((s) => s.id);
    if (activeIds.length <= 1 && activeIds.includes(id)) {
      setSelected(id);
      return;
    }
    commit(segments.map((s) => (s.id === id ? { ...s, disabled: true } : s)));
    setSelected(null);
  };
  const restore = (id: string) => {
    commit(segments.map((s) => (s.id === id ? { ...s, disabled: false } : s)));
  };
  const splitAtPlayhead = () => {
    const t = getVideoTime();
    const idx = segments.findIndex(
      (s) => !s.disabled && t > s.start + 0.1 && t < s.end - 0.1,
    );
    if (idx === -1) return;
    const cur = segments[idx];
    const first: EditorSeg = { ...cur, end: t, id: `${cur.id}-a` };
    const second: EditorSeg = {
      ...cur,
      start: t,
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
    commit(segments.map((s) => (s.id === id ? { ...s, ...patch } : s)));
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

  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      <button
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        style={{ borderBottom: open ? "1px solid var(--border)" : "none" }}
      >
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Timeline editor · {activeCount} clip{activeCount === 1 ? "" : "s"}
            {saving && (
              <span
                className="ml-2 text-[10px] normal-case"
                style={{ color: "var(--brand-strong)" }}
              >
                saving…
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
            Trim / Split / Delete / Reorder · Speed · Fade · Volume · Undo (⌘Z)
          </div>
        </div>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {open ? "Hide ▲" : "Show ▼"}
        </span>
      </button>

      {open && (
        <div className="p-3">
          {/* Toolbar */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <button
              onClick={undo}
              disabled={history.length === 0}
              className="rounded-lg px-2 py-1 text-xs disabled:opacity-40"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-body)",
                border: "1px solid var(--border)",
              }}
              title="Undo (⌘Z)"
            >
              ↶
            </button>
            <button
              onClick={redo}
              disabled={future.length === 0}
              className="rounded-lg px-2 py-1 text-xs disabled:opacity-40"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-body)",
                border: "1px solid var(--border)",
              }}
              title="Redo (⌘⇧Z)"
            >
              ↷
            </button>
            <button
              onClick={splitAtPlayhead}
              className="rounded-lg px-2.5 py-1 text-xs font-semibold"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-strong)",
                border: "1px solid var(--border)",
              }}
            >
              ⧉ Split
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
                className="rounded-lg px-2 py-1 text-xs"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  border: "1px solid var(--border)",
                }}
              >
                −
              </button>
              <span
                className="text-[10px] tabular-nums"
                style={{ color: "var(--text-muted)", minWidth: "34px", textAlign: "center" }}
              >
                {zoom.toFixed(1)}×
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(6, z * 1.5))}
                className="rounded-lg px-2 py-1 text-xs"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  border: "1px solid var(--border)",
                }}
              >
                +
              </button>
            </div>
          </div>

          {selected && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => moveLeft(selected)}
                className="rounded-lg px-2.5 py-1 text-xs"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  border: "1px solid var(--border)",
                }}
              >
                ← Move
              </button>
              <button
                onClick={() => moveRight(selected)}
                className="rounded-lg px-2.5 py-1 text-xs"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  border: "1px solid var(--border)",
                }}
              >
                Move →
              </button>
              <button
                onClick={() => del(selected)}
                className="rounded-lg px-2.5 py-1 text-xs"
                style={{
                  background: "var(--surface-2)",
                  color: "#F26E6E",
                  border: "1px solid #F26E6E44",
                }}
              >
                ✕ Delete
              </button>
            </div>
          )}

          {/* Segment strip — width scales with zoom, in a scroll container */}
          <div
            ref={scrollRef}
            className="overflow-x-auto rounded-lg"
            style={{ background: "var(--surface-0)" }}
          >
            <div
              ref={stripRef}
              className="relative flex h-16 items-stretch gap-0.5 select-none"
              style={{ width: `${100 * zoom}%`, minWidth: "100%" }}
            >
              {(dragPreviewRef.current ?? segments).map((s) => {
                const width = ((s.end - s.start) / totalDur) * 100;
                const isSel = selected === s.id;
                const hasFx =
                  (s.speed && s.speed !== 1) ||
                  (s.volume && s.volume !== 1) ||
                  (s.fadeIn && s.fadeIn > 0) ||
                  (s.fadeOut && s.fadeOut > 0);
                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      setSelected(s.id);
                      onSeekOriginal(s.start);
                    }}
                    className="group relative flex cursor-pointer flex-col items-stretch justify-between"
                    style={{
                      width: `${width}%`,
                      minWidth: "14px",
                      background: s.disabled
                        ? "var(--surface-2)"
                        : isSel
                          ? "var(--brand-tint)"
                          : "var(--surface-1)",
                      border: isSel
                        ? "1px solid var(--brand)"
                        : "1px solid var(--border)",
                      opacity: s.disabled ? 0.35 : 1,
                    }}
                  >
                    {!s.disabled && (
                      <>
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDraggingId(s.id);
                            setDragMode("start");
                          }}
                          onTouchStart={(e) => {
                            e.stopPropagation();
                            setDraggingId(s.id);
                            setDragMode("start");
                          }}
                          className="absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-ew-resize"
                          style={{
                            background: isSel
                              ? "var(--brand-strong)"
                              : "var(--border-hover)",
                          }}
                        />
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDraggingId(s.id);
                            setDragMode("end");
                          }}
                          onTouchStart={(e) => {
                            e.stopPropagation();
                            setDraggingId(s.id);
                            setDragMode("end");
                          }}
                          className="absolute right-0 top-0 bottom-0 z-10 w-1.5 cursor-ew-resize"
                          style={{
                            background: isSel
                              ? "var(--brand-strong)"
                              : "var(--border-hover)",
                          }}
                        />
                      </>
                    )}
                    <div className="pointer-events-none flex flex-1 flex-col items-center justify-center gap-0.5 px-1">
                      <span
                        className="text-[10px] tabular-nums"
                        style={{
                          color: s.disabled
                            ? "var(--text-faint)"
                            : "var(--text-strong)",
                        }}
                      >
                        {fmt(s.end - s.start)}
                      </span>
                      {hasFx && !s.disabled && (
                        <div className="flex gap-0.5">
                          {s.speed && s.speed !== 1 && (
                            <span
                              className="rounded px-0.5 text-[8px]"
                              style={{
                                background: "var(--brand)",
                                color: "white",
                              }}
                            >
                              {s.speed}×
                            </span>
                          )}
                          {(s.fadeIn || s.fadeOut) && (
                            <span
                              className="rounded px-0.5 text-[8px]"
                              style={{ background: "#B979FF", color: "white" }}
                            >
                              ⋅⋅⋅
                            </span>
                          )}
                          {s.volume && s.volume !== 1 && (
                            <span
                              className="rounded px-0.5 text-[8px]"
                              style={{
                                background: s.volume === 0 ? "#F26E6E" : "#F5B54D",
                                color: "white",
                              }}
                            >
                              {s.volume === 0
                                ? "M"
                                : `${Math.round(s.volume * 100)}%`}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {s.disabled && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          restore(s.id);
                        }}
                        className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                );
              })}

              {/* Playhead */}
              {(() => {
                let acc = 0;
                for (const s of segments) {
                  if (s.disabled) continue;
                  if (playhead >= s.start && playhead <= s.end) {
                    const pct = ((acc + (playhead - s.start)) / totalDur) * 100;
                    return (
                      <div
                        key="playhead"
                        className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5"
                        style={{
                          left: `${pct}%`,
                          background: "var(--brand)",
                          boxShadow: "0 0 8px var(--brand-glow)",
                        }}
                      />
                    );
                  }
                  acc += s.end - s.start;
                }
                return null;
              })()}
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
              <div className="col-span-1 sm:col-span-2 flex items-center gap-3">
                <span style={{ color: "var(--text-muted)" }}>Selected:</span>
                <span
                  className="tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {fmt(selectedSeg.start)} → {fmt(selectedSeg.end)}
                </span>
                <span style={{ color: "var(--text-faint)" }}>
                  ({(selectedSeg.end - selectedSeg.start).toFixed(2)}s)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Speed</span>
                <select
                  value={selectedSeg.speed ?? 1}
                  onChange={(e) => patchSeg(selectedSeg.id, { speed: Number(e.target.value) })}
                  className="flex-1 rounded-md px-2 py-1 text-xs"
                  style={{
                    background: "var(--surface-1)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={0.75}>0.75×</option>
                  <option value={1}>1× (normal)</option>
                  <option value={1.25}>1.25×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2}>2×</option>
                  <option value={3}>3×</option>
                  <option value={4}>4×</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.05}
                  value={selectedSeg.volume ?? 1}
                  onChange={(e) => patchSeg(selectedSeg.id, { volume: Number(e.target.value) })}
                  className="flex-1"
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {Math.round(((selectedSeg.volume ?? 1) * 100))}%
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Fade in</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeIn ?? 0}
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeIn: Number(e.target.value) })}
                  className="flex-1"
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {(selectedSeg.fadeIn ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Fade out</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeOut ?? 0}
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeOut: Number(e.target.value) })}
                  className="flex-1"
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
                  Reset effects
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
