"use client";
/**
 * /app/edit/[jobId] with the v1 editor (ReviewScreen): loads the job and
 * its transcript, then edits and exports it (moved from Home's
 * resumeJob / onApplyRender in app/app/page.tsx, UX5). A reload, the
 * back button and a shared link all land here.
 *
 *   404            the project is gone: the error view, and its card
 *                  (if any) says so too
 *   not in review  /app/p/[jobId] shows where it is (replace)
 *   in review      the editor
 */
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { Toast } from "@/components/ui/Toast";
import { useT } from "@/i18n";
import { updateActiveJob } from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { apiFetch, whenMediaReady } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import { describeError } from "@/lib/errors";
import { waitForSaves } from "@/lib/pendingSaves";
import type { JobStatus } from "@/features/jobs/types";
import { ErrorView } from "@/features/project/ErrorView";
import { applyRender } from "./applyRender";
import { phrasesFromSubtitlesResponse, type Phrase, type Subtitle } from "./buildPhrases";
import { ReviewScreen } from "./ReviewScreen";
import { usePhraseAutosave } from "./usePhraseAutosave";

// UX7: the v2 editor shell (its own chunk, never loaded while the flag
// is off). Dark placeholder while the chunk loads.
const EditorV2 = dynamic(() => import("@/features/editor/v2/EditorV2"), {
  ssr: false,
  loading: () => <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "#0d0d10" }} />,
});

type Load =
  | { state: "loading" }
  | { state: "ready"; job: JobStatus }
  | { state: "error"; message: string; gone?: boolean };

/** `v2`: show the v2 editor shell (features/editor/v2) instead of
 *  ReviewScreen — same job data and callbacks (EditorRoute decides). */
export function LegacyEditorPage({ jobId, v2 = false }: { jobId: string; v2?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [captionPreset, setCaptionPreset] = useState("clean");
  // The job's word units (GET /subtitles): what the render gets, matched
  // to the edited sentences by phrasesToUnits (UX2).
  const unitsRef = useRef<Subtitle[]>([]);
  const { flushPhraseSave, schedulePhraseSave } = usePhraseAutosave();
  const flushRef = useRef(flushPhraseSave);
  useEffect(() => {
    flushRef.current = flushPhraseSave;
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // A save from the last visit may still be in flight — load the
        // state the user actually left.
        await waitForSaves(jobId, 8_000);
        const r = await apiFetch(`/jobs/${jobId}`);
        if (cancelled) return;
        if (r.status === 404) {
          updateActiveJob(jobId, { error: "media_expired" });
          setLoad({ state: "error", message: t("app.errors.expired"), gone: true });
          return;
        }
        if (!r.ok) {
          // 401: sign-in opens (apiFetch); the job itself is fine.
          setLoad({
            state: "error",
            message: t(r.status === 401 ? "app.errors.signInRequired" : "app.notice.loadFailed"),
          });
          return;
        }
        const s: JobStatus = await r.json();
        if (cancelled) return;
        if (s.status !== "awaiting_review") {
          // Analysing, exporting, done or failed: its project view.
          router.replace(`/app/p/${jobId}`);
          return;
        }
        // The editor's <video> needs the media token (accounts on) — a
        // tokenless first load would fail for good. Usually there within
        // the wait; if not, the editor sets its src once it arrives.
        if (AUTH_ENABLED) await whenMediaReady();
        let lines: Phrase[] = [];
        const subsRes = await apiFetch(`/jobs/${jobId}/subtitles`);
        if (subsRes.ok) {
          const sd = await subsRes.json();
          unitsRef.current = sd.subtitles ?? [];
          lines = phrasesFromSubtitlesResponse(sd);
          if (!cancelled) setPhrases(lines);
        }
        if (cancelled) return;
        // The caption style this job renders with.
        if (s.caption_preset) setCaptionPreset(s.caption_preset);
        setLoad({ state: "ready", job: s });
        track("editor_opened", { lines: lines.length });
      } catch {
        if (!cancelled) setLoad({ state: "error", message: t("app.notice.offline") });
      }
    })();
    return () => {
      cancelled = true;
    };
    // t: only for the error text of this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, router, attempt]);

  // Leaving the route (back, a link): the last edit goes now.
  useEffect(() => () => flushRef.current(), []);

  const leave = () => {
    flushPhraseSave();
    router.push("/app");
  };

  const onApply = async () => {
    if (load.state !== "ready") return;
    flushPhraseSave();
    try {
      const started = await applyRender(jobId, phrases, unitsRef.current, captionPreset);
      // Already exporting or finished (409): its project view shows which.
      if (started === "not_in_review") router.replace(`/app/p/${jobId}`);
      // Back to the dashboard — the card shows the export.
      else router.push("/app");
    } catch (err) {
      setLoad({ state: "error", message: describeError(err, t) });
    }
  };

  if (load.state === "error") {
    return (
      <AppPage width="md">
        <ErrorView
          message={load.message}
          actionLabel={load.gone ? t("app.picker.backToDashboard") : undefined}
          onReset={() => {
            if (load.gone) router.push("/app");
            else {
              setLoad({ state: "loading" });
              setAttempt((n) => n + 1);
            }
          }}
        />
      </AppPage>
    );
  }
  if (load.state === "loading") {
    if (v2) return <EditorV2 loading onBack={leave} />;
    return (
      <AppPage width="3xl">
        <Toast compact>{t("app.header.opening")}</Toast>
        <div className="h-[60vh] animate-pulse rounded-xl bg-[var(--surface-1)]" data-testid="editor-loading" />
      </AppPage>
    );
  }
  const job = load.job;
  if (v2) {
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
        onApply={onApply}
        onBack={leave}
      />
    );
  }
  return (
    <AppPage width="3xl">
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
        onApply={onApply}
        onBack={leave}
      />
    </AppPage>
  );
}
