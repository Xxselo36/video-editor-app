"use client";
/**
 * /app/p/[jobId] (UX5): one project, by its status (PLAN_TECH §1.1).
 *
 * The v2 editor (useProjectsV2): the Vorschau (PreviewScreen, PR2 plan
 * D11), its own chunk, in every state of the project: processing, ready,
 * edited, finishing, done, failed. Its shape (frame, title, two buttons)
 * while it loads, also while the server can't be reached (useJobPoll
 * tries again); a project that is gone says so, with the way back to
 * Projects.
 *
 * v1, as before:
 *   pending / processing   its job card, enlarged, with the stage
 *   awaiting_review        → /app/edit/[jobId] (replace, useJobPoll)
 *   done                   the v1 Done view (DoneView.legacy)
 *   error                  ErrorView: the code's message, the refund,
 *                          "Try another video"
 *   404                    the project is gone
 *
 * The job comes from useJobPoll: GET /jobs/{id}, again every 2 s while it
 * runs, paused while the tab is hidden.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { getActiveJob, type ActiveJobV2 } from "@/lib/activeJobs";
import { jobErrorText, stageText, tEn } from "@/lib/errors";
import { EDITOR_V2 } from "@/features/editor/v2/flag";
import { ActiveJobCard } from "@/features/jobs/ActiveJobCard";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import type { JobStatus } from "@/features/jobs/types";
import { DoneView as LegacyDoneView } from "./DoneView.legacy";
import { ErrorView } from "./ErrorView";
import { useJobPoll, type JobPoll } from "./useJobPoll";
import s from "./preview.module.css";

/** The Vorschau's shape while it (or its job) loads: frame, title, buttons. */
function PreviewSkeleton() {
  return (
    <div className={s.root} data-testid="project-loading" aria-busy="true">
      <div className={s.watch} data-shape="tall">
        <div className={s.media}>
          <div className={s.frameSkeleton} />
        </div>
        <div className={s.info}>
          <div className={s.titleSkeleton} />
          <div className={s.acts}>
            <div className={s.buttonSkeleton} />
            <div className={s.buttonSkeleton} />
          </div>
        </div>
      </div>
    </div>
  );
}

// The Vorschau with its players and the caption engine: a chunk of its
// own (keeps /app/p within its first-load budget).
const PreviewScreen = dynamic(() => import("./PreviewScreen"), { ssr: false, loading: PreviewSkeleton });

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

export function ProjectPage({ jobId }: { jobId: string }) {
  const poll = useJobPoll(jobId);
  // Known after hydration; until then the build's default.
  const v2 = useProjectsV2() ?? EDITOR_V2;
  return v2 ? <Vorschau {...poll} /> : <LegacyProject {...poll} />;
}

function Vorschau({ load, setJob }: JobPoll) {
  const t = useT();
  const router = useRouter();
  if (load.state === "gone" || load.state === "failed") {
    return (
      <AppPage width="5xl">
        <div data-testid="project" data-status={load.state}>
          <ErrorView
            message={t(load.state === "gone" ? "app.errors.expired" : load.status === 401
              ? "app.errors.signInRequired" : "app.notice.loadFailed")}
            actionLabel={t(load.state === "gone" ? "editor.expired.back" : "app.picker.backToDashboard")}
            onReset={() => router.push("/app")}
          />
        </div>
      </AppPage>
    );
  }
  return (
    <AppPage width="5xl">
      {load.state === "loading" ? (
        <PreviewSkeleton />
      ) : (
        <div data-testid="project" data-status={load.job.status}>
          <PreviewScreen job={load.job} setJob={setJob} />
        </div>
      )}
    </AppPage>
  );
}

function LegacyProject({ load }: JobPoll) {
  const t = useT();
  const router = useRouter();

  const back = (
    <Link
      href="/app"
      data-testid="project-back"
      className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
      style={{ color: "var(--text-muted)" }}
    >
      <Icon icon={ArrowLeft} className="text-base" />
      {t("app.picker.backToDashboard")}
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
          <LegacyDoneView
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
