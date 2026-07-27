"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

  const onProcess = async (fileOverride?: File) => {
    const targetFile = fileOverride ?? file;
    if (!targetFile) return;
    if (!fileOverride) setFile(targetFile);
    setPhase("uploading");
    setErrorMsg(null);

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
      whisper_model: "small",
      smartcam_enabled: applyPreset
        ? p!.settings.smartcamEnabled
        : smartcamEnabled,
      smartcam_format: applyPreset
        ? p!.settings.smartcamFormat
        : smartcamFormat,
      resolution: "1080",
      output_formats: applyPreset ? p!.settings.outputFormats : outputFormats,
    };

    const form = new FormData();
    form.append("file", targetFile);
    form.append("settings", JSON.stringify(settings));

    try {
      const res = await new Promise<XMLHttpRequest>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${backendUrl()}/jobs`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setUploadPct(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.onload = () => resolve(xhr);
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(form);
      });

      if (res.status >= 400) {
        throw new Error(`Upload failed: ${res.responseText}`);
      }
      const initial: JobStatus = JSON.parse(res.responseText);
      setJob(initial);
      setPhase("analyzing");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
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
        } else if (s.status === "awaiting_review" && phase === "analyzing") {
          const subRes = await fetch(
            `${backendUrl()}/jobs/${job.id}/subtitles`,
          );
          if (subRes.ok) {
            const data = await subRes.json();
            const subs: Subtitle[] = data.subtitles ?? [];
            setPhrases(buildPhrases(subs));
            setPhase("reviewing");
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
      setPhase("rendering");
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
        {phase === "picker" && <PickerScreen onPick={pickPreset} />}

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

        {phase === "uploading" && (
          <ProgressScreen label="Uploading…" pct={uploadPct} />
        )}

        {phase === "analyzing" && job && (
          <ProgressScreen label={job.message} pct={job.progress} />
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
            onChange={setPhrases}
            onApply={onApplyRender}
            onBack={reset}
          />
        )}

        {phase === "rendering" && job && (
          <ProgressScreen label={job.message} pct={job.progress} />
        )}

        {phase === "done" && job && (
          <DoneScreen
            jobId={job.id}
            outputs={(job as JobStatus & { outputs?: string[] }).outputs ?? ["primary"]}
            socialCaption={
              (job as JobStatus & { social_caption?: string }).social_caption ?? ""
            }
            socialHashtags={
              (job as JobStatus & { social_hashtags?: string[] }).social_hashtags ?? []
            }
            hookClips={
              (job as JobStatus & { hook_clips?: HookClip[] }).hook_clips ?? []
            }
            onReset={reset}
          />
        )}

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

function PickerScreen({ onPick }: { onPick: (id: PresetId) => void }) {
  const featured: PresetId[] = ["tiktok", "podcast", "vlog", "captions"];
  const [recent, setRecent] = useState<LibraryEntry[] | null>(null);

  useEffect(() => {
    setRecent(getLibrary().slice(0, 3));
  }, []);

  return (
    <div className="relative z-10 flex flex-col">
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

      {/* Recent projects — only shown if the user has library entries */}
      {recent && recent.length > 0 && (
        <div className="mt-10">
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {recent.map((entry) => (
              <Link
                key={entry.jobId}
                href="/app/library"
                className="flex flex-col rounded-xl p-3 transition-colors hover:border-[var(--border-hover)]"
                style={{
                  background: "var(--surface-1)",
                  border: "1px solid var(--border)",
                }}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                    style={{
                      background: "var(--brand-tint)",
                      color: "var(--brand-strong)",
                    }}
                  >
                    {entry.presetLabel ?? "Custom"}
                  </span>
                </div>
                <div
                  className="mb-1 truncate text-xs font-semibold"
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
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
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

function ProgressScreen({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center">
      <div className="mb-8 text-base text-[var(--text-body)]">{label}</div>
      <div className="mb-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div
          className="h-full bg-[var(--brand)] transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="text-xs text-[var(--text-faint)]">{Math.round(pct)}%</div>
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
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 py-4">
      <div className="text-5xl">✨</div>
      <div className="text-2xl font-semibold">Ready</div>

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
  onChange: (p: Phrase[]) => void;
  onApply: () => void;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const phraseRefs = useRef<Array<HTMLDivElement | null>>([]);

  // The preview video is the SOURCE already cut to the kept segments,
  // so phrase.start / phrase.end (cut-timeline) match video.currentTime
  // directly. The original_* fields are kept only for the render step.
  useEffect(() => {
    const idx = phrases.findIndex(
      (p) => currentTime >= p.start && currentTime <= p.end,
    );
    setActiveIdx(idx === -1 ? null : idx);
  }, [currentTime, phrases]);

  // Auto-scroll the active phrase into view (only when video is playing,
  // so manual editing doesn't yank focus around).
  useEffect(() => {
    if (activeIdx === null) return;
    if (videoRef.current?.paused) return;
    phraseRefs.current[activeIdx]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
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

      {/* Cut video preview — captions will be burned in by the final
          render, not approximated here. The style sample below shows
          the user what to expect visually. */}
      <div className="overflow-hidden rounded-xl bg-[var(--surface-1)]">
        <video
          ref={videoRef}
          src={`${backendUrl()}/jobs/${jobId}/preview-video`}
          controls
          playsInline
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-[var(--surface-0)]"
        />
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

      {cutRanges.length > 0 && duration > 0 && (
        <Timeline
          duration={duration}
          cuts={cutRanges}
          disabled={disabledCuts}
          onToggle={(id) =>
            setDisabledCuts(
              disabledCuts.includes(id)
                ? disabledCuts.filter((x) => x !== id)
                : [...disabledCuts, id],
            )
          }
        />
      )}

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
          Review captions
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          Play the video, fix typos as they go by. Tap ✕ to drop a line, tap a
          card to jump to that moment.
        </div>
      </div>

      <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto pr-1">
        {phrases.length === 0 && (
          <div className="rounded-xl border border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
            No captions. Output will be video only.
          </div>
        )}
        {phrases.map((p, i) => {
          const isActive = i === activeIdx;
          const lowConfidence = p.confidence < 0.6;
          let borderClass = "border-[var(--border)]";
          if (isActive) borderClass = "border-[var(--brand)] bg-[var(--brand-tint)]";
          else if (lowConfidence) borderClass = "border-[var(--warn)]/60 bg-[var(--warn)]/[0.04]";
          return (
            <div
              key={i}
              ref={(el) => {
                phraseRefs.current[i] = el;
              }}
              className={`rounded-xl border p-3 transition-colors ${borderClass}`}
            >
              <div className="mb-1.5 flex items-center justify-between">
                <button
                  onClick={() => seekToPhrase(p)}
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
                    onClick={() => remove(i)}
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

      <button
        onClick={onApply}
        className="mt-1 w-full rounded-xl bg-[var(--brand)] px-6 py-4 text-base font-semibold hover:bg-[var(--brand-hover)] active:scale-[0.99]"
      >
        Apply &amp; render
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
}: {
  duration: number;
  cuts: CutRange[];
  disabled: number[];
  onToggle: (id: number) => void;
}) {
  const disabledSet = new Set(disabled);
  const totalCutSeconds = cuts
    .filter((c) => !disabledSet.has(c.id))
    .reduce((acc, c) => acc + (c.end - c.start), 0);
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
