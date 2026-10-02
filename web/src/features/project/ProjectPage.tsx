"use client";
/**
 * /app/p/[jobId] (UX5): one project, by its status (PLAN_TECH §1.1).
 * First version from what exists (UX11/UX12 bring the real views):
 *
 *   pending / processing   its job card, enlarged, with the stage — on
 *                          the v2 opt-in (UX12) ProcessingView: the
 *                          analysis or the export as a checklist, time
 *                          left; the editor opens by itself
 *   awaiting_review        → /app/edit/[jobId] (replace)
 *   done                   the Done view (DoneView.legacy)
 *   error                  ErrorView: the code's message, the refund,
 *                          "Try another video"
 *   404                    the project is gone
 *
 * Polls GET /jobs/{id} while the job runs (every 2 s, paused while the
 * tab is hidden).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { getActiveJob, type ActiveJobV2 } from "@/lib/activeJobs";
import { apiFetch } from "@/lib/api";
import { jobErrorText, stageText, tEn } from "@/lib/errors";
import { ActiveJobCard } from "@/features/jobs/ActiveJobCard";
import { hasExportHint, readLocalJobs } from "@/features/jobs/localJobs";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import type { JobStatus } from "@/features/jobs/types";
import { DoneView } from "./DoneView.legacy";
import { ErrorView } from "./ErrorView";
import { ProcessingView } from "./ProcessingView";

const POLL_MS = 2000;
// After an answer that isn't a job (a 502 / 503 while the backend
// restarts on a deploy, offline): again after 2 s, doubling to 30 s.
const RETRY_MAX_MS = 30_000;

/** The wait before the next try after `failures` failed ones in a row. */
export function retryDelay(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

type Load =
  | { state: "loading" }
  | { state: "job"; job: JobStatus }
  | { state: "gone" }
  | { state: "failed"; status: number };

/** The card of a running job: the stored one, else one from the job. */
function cardFor(job: JobStatus): ActiveJobV2 {
  const stored = getActiveJob(job.id);
  const rendering = Boolean(job.stage?.startsWith("render.")) || /render/i.test(job.message ?? "");
  return {
    jobId: job.id,
    phase: rendering ? "rendering" : "analyzing",
    timestamp: stored?.timestamp ?? Date.now(),
    filename: stored?.filename ?? job.filename ?? tEn("app.library.untitled"),
    presetId: stored?.presetId ?? job.preset_id ?? null,
    presetLabel: stored?.presetLabel ?? job.preset_label ?? null,
    presetIcon: null,
    captionPreset: job.caption_preset ?? "clean",
  };
}

/** A running job is an export (not the analysis). */
export function isExport(job: Pick<JobStatus, "stage" | "message" | "has_output">, seenInReview: boolean): boolean {
  if (job.stage?.startsWith("render.")) return true;
  if (job.stage?.startsWith("analyze.")) return false;
  return seenInReview || Boolean(job.has_output) || /render/i.test(job.message ?? "");
}

export function ProjectPage({ jobId }: { jobId: string }) {
  const t = useT();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // The v2 opt-in (UX12): the processing view, back to Projects.
  const v2 = useProjectsV2() === true;
  // In review (or exported) before: a queued run is an export.
  const [seenInReview] = useState(() => hasExportHint(jobId));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      clearTimeout(timer);
      if (cancelled) return;
      let running = false;
      try {
        const r = await apiFetch(`/jobs/${jobId}`);
        if (cancelled) return;
        if (r.status === 404) setLoad({ state: "gone" });
        else if (r.status === 401 || r.status === 403) {
          // Sign-in opens (apiFetch); nothing to poll meanwhile.
          setLoad((cur) => (cur.state === "job" ? cur : { state: "failed", status: r.status }));
        } else if (!r.ok) {
          // A hiccup (5xx, 429): keep what is shown, try again later.
          failures++;
          running = true;
        } else {
          failures = 0;
          const job: JobStatus = await r.json();
          if (cancelled) return;
          if (job.status === "awaiting_review") {
            router.replace(`/app/edit/${jobId}`);
            return;
          }
          setLoad({ state: "job", job });
          running = job.status === "pending" || job.status === "processing";
        }
      } catch {
        failures++;
        running = true; // offline: try again
      }
      if (running && !cancelled && !document.hidden) {
        timer = setTimeout(() => void tick(), failures ? retryDelay(failures) : POLL_MS);
      }
    };
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [jobId, router]);

  const back = (
    <Link
      href="/app"
      data-testid="project-back"
      className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
      style={{ color: "var(--text-muted)" }}
    >
      <Icon icon={ArrowLeft} className="text-base" />
      {t(v2 ? "app.projects.back" : "app.picker.backToDashboard")}
    </Link>
  );

  if (load.state === "gone" || load.state === "failed") {
    return (
      <AppPage width="md">
        <div data-testid="project" data-status={load.state}>
          <ErrorView
            message={t(load.state === "gone" ? "app.errors.expired" : load.status === 401
              ? "app.errors.signInRequired" : "app.notice.loadFailed")}
            actionLabel={t("app.picker.backToDashboard")}
            onReset={() => router.push("/app")}
          />
        </div>
      </AppPage>
    );
  }
  if (load.state === "loading") {
    return (
      <AppPage width="md">
        <div className="h-40 animate-pulse rounded-2xl bg-[var(--surface-1)]" data-testid="project-loading" />
      </AppPage>
    );
  }
  const job = load.job;
  if (job.status === "error") {
    const refundNote = job.refunded && job.error_code !== "no_speech" ? t("app.errors.refunded") : null;
    return (
      <AppPage width="md">
        <div data-testid="project" data-status="error">
          <ErrorView
            message={jobErrorText(job, t)}
            note={refundNote}
            actionLabel={t("app.errors.tryAnotherVideo")}
            onReset={() => router.push("/app/new")}
          />
        </div>
      </AppPage>
    );
  }
  if (job.status === "done") {
    return (
      <AppPage width="md">
        <div data-testid="project" data-status="done" className="flex flex-col">
          {back}
          <DoneView
            jobId={job.id}
            outputs={job.outputs ?? ["primary"]}
            socialCaption={job.social_caption ?? ""}
            socialHashtags={job.social_hashtags ?? []}
            hookClips={job.hook_clips ?? []}
            onReset={() => router.push("/app/new")}
          />
        </div>
      </AppPage>
    );
  }
  if (v2) {
    const local = readLocalJobs().find((j) => j.jobId === job.id);
    const name =
      (job as { title?: string | null }).title || local?.name || local?.filename || job.filename || t("app.library.untitled");
    return (
      <AppPage width="md">
        <div data-testid="project" data-status={job.status} className="flex flex-col">
          {back}
          <ProcessingView job={job} exporting={isExport(job, seenInReview)} name={name} />
        </div>
      </AppPage>
    );
  }
  const stage = stageText(job.stage, job.stage_params, t);
  return (
    <AppPage width="md">
      <div data-testid="project" data-status={job.status} className="flex flex-col">
        {back}
        <ActiveJobCard
          job={cardFor(job)}
          status={{
            progress: job.progress,
            message: job.message,
            status: job.status,
            queuePosition: job.queue_position ?? null,
          }}
          onOpen={() => router.push(`/app/edit/${job.id}`)}
        />
        {stage && (
          <p className="mt-3 text-center text-xs" style={{ color: "var(--text-muted)" }} data-testid="project-stage">
            {stage}
          </p>
        )}
      </div>
    </AppPage>
  );
}
