"use client";

import { useEffect, useRef, useState } from "react";

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
  | "idle"
  | "configuring"
  | "uploading"
  | "analyzing"
  | "reviewing"
  | "rendering"
  | "done"
  | "error";

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
  const [phase, setPhase] = useState<Phase>("idle");
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

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChange = (f: File | null) => {
    if (!f) return;
    setFile(f);
    setPhase("configuring");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onFileChange(f);
  };

  const onProcess = async () => {
    if (!file) return;
    setPhase("uploading");
    setErrorMsg(null);

    const settings = {
      caption_preset: captionPreset,
      style: cutStyle,
      voice_triggers: voiceTriggers,
      remove_fillers: removeFillers,
      whisper_model: "small",
      smartcam_enabled: smartcamEnabled,
      smartcam_format: smartcamFormat,
      resolution: "1080",
      output_formats: outputFormats,
    };

    const form = new FormData();
    form.append("file", file);
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
        if (s.status === "done") setPhase("done");
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
    setPhase("idle");
  };

  return (
    <main className="flex min-h-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-zinc-900 px-6 py-4">
        <span className="text-xl font-bold tracking-tight">Cleo</span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-600">
          beta
        </span>
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-5 py-8">
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

function IdleScreen({
  onPick,
  onDrop,
}: {
  onPick: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="mb-2 text-xs uppercase tracking-[0.3em] text-zinc-500">
        Voice-first video editing
      </div>
      <h1 className="mb-3 text-5xl font-bold tracking-tight">Cleo</h1>
      <p className="mb-12 max-w-sm text-center text-base text-zinc-400">
        Talk freely. Say{" "}
        <span className="text-white">&ldquo;Cleo cut&rdquo;</span> when you mess
        up, <span className="text-white">&ldquo;Cleo go&rdquo;</span> to start
        over.
      </p>

      <button
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="w-full rounded-2xl border-2 border-dashed border-zinc-700 px-6 py-12 text-center transition-colors hover:border-violet-400 hover:bg-zinc-950/50 active:scale-[0.99]"
      >
        <div className="mb-3 text-3xl">📹</div>
        <div className="text-base font-medium">Pick a video</div>
        <div className="mt-1 text-xs text-zinc-500">or drag and drop here</div>
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
          className="text-xs text-zinc-500 hover:text-white"
        >
          ← back
        </button>
        <div className="truncate text-xs text-zinc-400">
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
                    ? "border-violet-400 bg-violet-400/10"
                    : "border-zinc-800 hover:border-zinc-600"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${backendUrl()}/caption-previews/${p.id}.png?w=320&h=110`}
                  alt={`${p.label} caption preview`}
                  className="block h-[64px] w-full bg-zinc-950 object-cover"
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
                  ? "border-violet-400 bg-violet-400/10"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              <div className="text-xs font-medium">{s.label}</div>
              <div className="text-[10px] text-zinc-500">{s.desc}</div>
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
                    ? "border-violet-400 bg-violet-400/10"
                    : "border-zinc-800 hover:border-zinc-600"
                }`}
              >
                <div className="font-medium capitalize">{f}</div>
                <div className="text-[10px] text-zinc-500">
                  {f === "portrait" ? "Vertical 9:16" : "Horizontal 16:9"}
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Extra output formats">
        <div className="text-[10px] text-zinc-500 -mt-1">
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
                    ? "border-violet-400 bg-violet-400/10"
                    : "border-zinc-800 hover:border-zinc-600"
                }`}
              >
                <div className="text-xs font-medium">{f.label}</div>
                <div className="text-[10px] text-zinc-500">{f.desc}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <button
        onClick={props.onProcess}
        className="mt-2 w-full rounded-xl bg-violet-500 px-6 py-4 text-base font-semibold hover:bg-violet-400 active:scale-[0.99]"
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
      <div className="mb-2 text-[11px] uppercase tracking-[0.15em] text-zinc-500">
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
      className="flex w-full items-center justify-between rounded-xl border border-zinc-800 px-4 py-3 text-left hover:border-zinc-600"
    >
      <div>
        <div className="text-sm">{label}</div>
        {desc && <div className="text-[10px] text-zinc-500">{desc}</div>}
      </div>
      <div
        className={`h-6 w-10 rounded-full p-0.5 transition-colors ${
          checked ? "bg-violet-500" : "bg-zinc-800"
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
      <div className="mb-8 text-base text-zinc-400">{label}</div>
      <div className="mb-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-zinc-900">
        <div
          className="h-full bg-violet-500 transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="text-xs text-zinc-600">{Math.round(pct)}%</div>
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
        <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-left">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Caption suggestion
            </span>
            <button
              onClick={() => copyText(`${socialCaption}\n\n${hashtagLine}`.trim())}
              className="text-[10px] uppercase tracking-wider text-violet-400 hover:text-violet-300"
            >
              copy
            </button>
          </div>
          {socialCaption && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-white">
              {socialCaption}
            </div>
          )}
          {hashtagLine && (
            <div className="mt-2 text-xs text-violet-300">{hashtagLine}</div>
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
                  ? "bg-violet-500 hover:bg-violet-400"
                  : "border border-violet-400/40 text-violet-100 hover:bg-violet-500/10"
              }`}
            >
              <div className="text-sm">{formatLabel(f)}</div>
              <div className="text-[10px] font-normal text-zinc-300/70">
                {formatSub(f)}
              </div>
            </a>
          ))}
      </div>

      {hookClips.length > 0 && (
        <div className="w-full max-w-md">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-zinc-500">
            <span>Bonus clips</span>
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300">
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
                  className="block rounded-xl border border-zinc-800 bg-zinc-950 p-3 hover:border-violet-400/60"
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-white">
                      {h.title}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      {dur.toFixed(0)}s
                    </div>
                  </div>
                  {h.reason && (
                    <div className="line-clamp-2 text-xs text-zinc-500">
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
        className="text-xs text-zinc-500 hover:text-white"
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
          className="text-xs text-zinc-500 hover:text-white"
        >
          ← cancel
        </button>
        <div className="text-xs text-zinc-400">
          {phrases.length} sentence{phrases.length === 1 ? "" : "s"}
        </div>
      </div>

      {audioWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
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
      <div className="overflow-hidden rounded-xl bg-zinc-950">
        <video
          ref={videoRef}
          src={`${backendUrl()}/jobs/${jobId}/preview-video`}
          controls
          playsInline
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-black"
        />
      </div>

      {captionPreset !== "none" && (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${backendUrl()}/caption-previews/${captionPreset}.png?w=200&h=72`}
            alt={`${captionPreset} caption sample`}
            className="h-10 w-28 rounded-md object-cover"
          />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
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
        <div className="mb-1 text-[11px] uppercase tracking-[0.15em] text-zinc-500">
          Review captions
        </div>
        <div className="text-xs text-zinc-500">
          Play the video, fix typos as they go by. Tap ✕ to drop a line, tap a
          card to jump to that moment.
        </div>
      </div>

      <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto pr-1">
        {phrases.length === 0 && (
          <div className="rounded-xl border border-zinc-800 p-6 text-center text-xs text-zinc-500">
            No captions. Output will be video only.
          </div>
        )}
        {phrases.map((p, i) => {
          const isActive = i === activeIdx;
          const lowConfidence = p.confidence < 0.6;
          let borderClass = "border-zinc-800";
          if (isActive) borderClass = "border-violet-400 bg-violet-400/5";
          else if (lowConfidence) borderClass = "border-amber-500/60 bg-amber-500/[0.04]";
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
                  className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white"
                >
                  ▸ {fmtTime(p.original_start)}
                </button>
                <div className="flex items-center gap-2">
                  {lowConfidence && (
                    <span className="text-[9px] uppercase tracking-wider text-amber-400">
                      verify
                    </span>
                  )}
                  <button
                    onClick={() => remove(i)}
                    className="text-zinc-600 hover:text-red-400"
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
                className="w-full resize-none bg-transparent text-base leading-snug text-white focus:outline-none"
              />
            </div>
          );
        })}
      </div>

      <button
        onClick={onApply}
        className="mt-1 w-full rounded-xl bg-violet-500 px-6 py-4 text-base font-semibold hover:bg-violet-400 active:scale-[0.99]"
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
      <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.15em] text-zinc-500">
        <span>Cuts</span>
        <span className="text-zinc-600">
          {totalCutSeconds.toFixed(1)}s removed
          {disabled.length > 0 && ` · ${disabled.length} restored`}
        </span>
      </div>
      <div className="relative h-3 overflow-visible rounded-full bg-emerald-500/30">
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
                  ? "bg-emerald-500/70 hover:bg-emerald-400"
                  : "bg-red-500/85 hover:bg-red-400"
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
      <div className="mt-1 text-[10px] text-zinc-600">
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
      <div className="max-w-xs text-center text-xs text-zinc-500">{message}</div>
      <button
        onClick={onReset}
        className="mt-2 rounded-xl border border-zinc-700 px-5 py-2 text-sm hover:border-white"
      >
        Try again
      </button>
    </div>
  );
}
