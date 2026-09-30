"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Toast } from "@/components/ui/Toast";
import { PaywallDialog } from "@/components/billing/PaywallDialog";
import { useT } from "@/i18n";
import type { Paywall } from "@/lib/account";
import { dropLegacyActiveJob, updateActiveJob as updateActiveJobV2 } from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { apiFetch, whenMediaReady } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import { FRIENDLY_EXPIRED_KEY, jobErrorText, tEn } from "@/lib/errors.legacy";
import { waitForSaves } from "@/lib/pendingSaves";
import { applyRender, applyRenderErrorText } from "@/features/editor/legacy/applyRender";
import { phrasesFromSubtitlesResponse, type Phrase, type Subtitle } from "@/features/editor/legacy/buildPhrases";
import { ReviewScreen } from "@/features/editor/legacy/ReviewScreen";
import { usePhraseAutosave } from "@/features/editor/legacy/usePhraseAutosave";
import { useEditorV2 } from "@/features/editor/v2/flag";
import type { JobStatus } from "@/features/jobs/types";
import { ErrorView } from "@/features/project/ErrorView";
import { ConfigureScreen } from "@/features/start/ConfigureScreen";
import { IdleScreen } from "@/features/start/IdleScreen";
import { PickerScreen } from "@/features/start/PickerScreen";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { uploadJob } from "@/features/upload/uploadJob";

type Phase = "picker" | "idle" | "configuring" | "reviewing" | "error";

// UX7: the v2 editor shell (NEXT_PUBLIC_EDITOR_V2=1, or "optin" + ?editor=v2; its own chunk,
// never loaded with the flag off). Dark placeholder while the chunk loads.
const EditorV2 = dynamic(() => import("@/features/editor/v2/EditorV2"), {
  ssr: false,
  loading: () => <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "#0d0d10" }} />,
});

export default function Home() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("picker");
  const [selectedPreset, setSelectedPreset] = useState<PresetId | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [captionPreset, setCaptionPreset] = useState("clean");
  const [cutStyle, setCutStyle] = useState("balanced");
  const [voiceTriggers, setVoiceTriggers] = useState(true);
  const [removeFillers, setRemoveFillers] = useState(true);
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
  // (Until one release after UX4: drop the old single-job store.)
  useEffect(() => dropLegacyActiveJob(), []);

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
      smartcam_enabled: applyPreset
        ? p!.settings.smartcamEnabled
        : smartcamEnabled,
      smartcam_format: applyPreset
        ? p!.settings.smartcamFormat
        : smartcamFormat,
      resolution: "1080",
      output_formats: applyPreset ? p!.settings.outputFormats : outputFormats,
    };

    await uploadJob(targetFile, settings, selectedPreset, {
      onPaywall: setPaywall,
      onCreated: () => {
        // Reset local state — the job now lives as a card on the
        // dashboard, backend keeps processing regardless of where the
        // user goes next.
        setFile(null);
        setSelectedPreset(null);
        setJob(null);
      },
    });
  };

  const { flushPhraseSave, schedulePhraseSave } = usePhraseAutosave();

  const onApplyRender = async () => {
    if (!job) return;
    flushPhraseSave();
    try {
      const started = await applyRender(job.id, phrases, unitsRef.current, captionPreset);
      // Already exporting or finished (409): its dashboard card shows
      // which; go there instead of an error screen.
      if (started === "not_in_review") showNotice(t("app.notice.alreadyExporting"));
      // Send user back to the dashboard — the card takes over from
      // here. No fullscreen "rendering" screen anymore.
      setFile(null);
      setJob(null);
      setPhrases([]);
      setSelectedPreset(null);
      setPhase("picker");
    } catch (err) {
      setErrorMsg(applyRenderErrorText(err, t));
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
    setErrorMsg(null);
    setSelectedPreset(null);
    setPhase("picker");
  };
  resetRef.current = reset;

  // UX7: with the v2 flag, the review phase is the full-screen v2 shell
  // (same job data and callbacks as ReviewScreen); its skeleton shows
  // while a job opens. Flag off: useEditorV2() is false, nothing changes.
  const editorV2 = useEditorV2();
  if (editorV2 && phase === "reviewing" && job) {
    return (
      <EditorV2
        key={job.id}
        jobId={job.id}
        filename={job.filename}
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
        onChange={(next) => {
          setPhrases(next);
          schedulePhraseSave(job.id, next);
        }}
        onApply={onApplyRender}
        onBack={reset}
      />
    );
  }
  if (editorV2 && resuming) return <EditorV2 loading />;

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      <AppHeader />

      <div
        key={phase}
        className={`phase-fade mx-auto w-full flex-1 px-5 py-8 ${
          phase === "picker" ? "max-w-2xl" : phase === "reviewing" ? "max-w-3xl" : "max-w-md"
        }`}
      >
        {resuming && <Toast compact>{t("app.header.opening")}</Toast>}
        {notice && (
          <Toast testId="notice" onDismiss={() => setNotice(null)}>
            {notice}
          </Toast>
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
