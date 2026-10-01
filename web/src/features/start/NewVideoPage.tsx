"use client";
/**
 * /app/new (UX5): the workflow picker, the file screen and the custom
 * settings — the start of a video (moved from app/app/page.tsx, where
 * they were phases of one URL). Choosing a file starts the upload
 * (uploadManager: it goes on whatever route is shown) and returns to the
 * dashboard, where its card shows the progress. The file screen and the
 * settings are steps of this route, not routes of their own (a File
 * can't survive a reload), but each gets a history entry
 * (/app/new?step=file, ?step=settings): back returns to the step before —
 * to the picker, never out of the app. A reload on a step shows the
 * picker.
 */
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { track } from "@/lib/analytics";
import { startUpload } from "@/features/upload/uploadManager";
import { ConfigureScreen } from "./ConfigureScreen";
import { IdleScreen } from "./IdleScreen";
import { PickerScreen } from "./PickerScreen";
import { PRESETS, type PresetId } from "./presets.legacy";

type Step = "picker" | "idle" | "configuring";

// The ?step= of each step's history entry.
const STEP_PARAM: Record<Exclude<Step, "picker">, string> = { idle: "file", configuring: "settings" };

function urlStep(): string | null {
  return new URLSearchParams(window.location.search).get("step");
}

export function NewVideoPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("picker");
  const [selectedPreset, setSelectedPreset] = useState<PresetId | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [captionPreset, setCaptionPreset] = useState("clean");
  const [cutStyle, setCutStyle] = useState("balanced");
  const [voiceTriggers, setVoiceTriggers] = useState(true);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [smartcamEnabled, setSmartcamEnabled] = useState(false);
  const [smartcamFormat, setSmartcamFormat] = useState<"portrait" | "landscape">("portrait");
  const [outputFormats, setOutputFormats] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [openPickerNext, setOpenPickerNext] = useState(false);

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
    goStep("idle");
    // Open the file picker right after the idle screen mounted (still
    // within the tap's user activation, so the browser allows it). The
    // idle screen stays as the fallback if the picker is cancelled.
    setOpenPickerNext(true);
  };
  useLayoutEffect(() => {
    if (step === "idle" && openPickerNext) {
      // One-shot flag set by pickPreset; the click must run after the
      // idle screen (and its input) mounted.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenPickerNext(false);
      fileInputRef.current?.click();
    }
  }, [step, openPickerNext]);

  const onFileChange = (f: File | null) => {
    if (!f) return;
    track("file_chosen", {
      preset: selectedPreset ?? "custom",
      size_mb: Math.round(f.size / 1e6),
      video: f.type.startsWith("video/"),
    });
    setFile(f);
    // A workflow preset has its settings: straight to the upload. Custom
    // shows the settings first.
    if (selectedPreset && PRESETS[selectedPreset].skipConfigure) onProcess(f);
    else goStep("configuring");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onFileChange(f);
  };

  // Set once the upload started: the route change to /app takes a moment,
  // and a double click (or tap) meanwhile must not start a second upload
  // — a second job, charged twice.
  const startedRef = useRef(false);
  const [starting, setStarting] = useState(false);

  const onProcess = (fileOverride?: File) => {
    // Guard: a click event must never be treated as the file.
    const targetFile = fileOverride instanceof File ? fileOverride : file;
    if (!targetFile || startedRef.current) return;
    startedRef.current = true;
    setStarting(true);
    // Resolve settings from the preset on the skip-configure path (state
    // may not have flushed when pickPreset + onFileChange ran together).
    const p = selectedPreset ? PRESETS[selectedPreset] : null;
    const applyPreset = p?.skipConfigure ?? false;
    const settings = {
      caption_preset: applyPreset ? p!.settings.captionPreset : captionPreset,
      style: applyPreset ? p!.settings.cutStyle : cutStyle,
      voice_triggers: applyPreset ? p!.settings.voiceTriggers : voiceTriggers,
      remove_fillers: applyPreset ? p!.settings.removeFillers : removeFillers,
      smartcam_enabled: applyPreset ? p!.settings.smartcamEnabled : smartcamEnabled,
      smartcam_format: applyPreset ? p!.settings.smartcamFormat : smartcamFormat,
      resolution: "1080",
      output_formats: applyPreset ? p!.settings.outputFormats : outputFormats,
    };
    // In the background (uploadManager); its card on the dashboard shows
    // the progress, and the user may browse on meanwhile.
    void startUpload(targetFile, settings, selectedPreset);
    router.push("/app");
  };

  // A step's own history entry: back (the browser's, or the screen's
  // back button) returns to the step before.
  const goStep = (next: Exclude<Step, "picker">) => {
    window.history.pushState(null, "", `?step=${STEP_PARAM[next]}`);
    setStep(next);
  };
  const stateRef = useRef({ file, selectedPreset });
  useEffect(() => {
    stateRef.current = { file, selectedPreset };
  });
  useEffect(() => {
    // A reload on a step: its file is gone — start at the picker.
    if (urlStep()) window.history.replaceState(null, "", window.location.pathname);
    const onPop = () => {
      const want = urlStep();
      const { file: f, selectedPreset: p } = stateRef.current;
      if (want === "settings" && f) setStep("configuring");
      else if (want === "file" && p) setStep("idle");
      else {
        setFile(null);
        setSelectedPreset(null);
        setStep("picker");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const reset = () => {
    if (urlStep()) {
      window.history.back(); // popstate shows the step before
      return;
    }
    setFile(null);
    setSelectedPreset(null);
    setStep("picker");
  };

  return (
    <AppPage width={step === "picker" ? "2xl" : "md"}>
      {step === "picker" && <PickerScreen onPick={pickPreset} />}
      {step === "idle" && (
        <IdleScreen onPick={() => fileInputRef.current?.click()} onDrop={onDrop} onBack={reset} />
      )}
      {step === "configuring" && file && (
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
          starting={starting}
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
    </AppPage>
  );
}
