"use client";
/**
 * /app/p/[jobId] for v1 (ProjectPage, browsers off the v2 editor), as
 * before the Vorschau:
 *   pending / processing   its job card, enlarged, with the stage
 *   awaiting_review        → /app/edit/[jobId] (replace, useJobPoll)
 *   done                   the v1 Done view (DoneView.legacy)
 *   error                  ErrorView: the code's message, the refund,
 *                          "Try another video"
 *   404                    the project is gone
 * A chunk of its own: browsers on v2 never load it.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { getActiveJob, type ActiveJobV2 } from "@/lib/activeJobs";
import { jobErrorText, stageText, tEn } from "@/lib/errors";
import { ActiveJobCard } from "@/features/jobs/ActiveJobCard";
import type { JobStatus } from "@/features/jobs/types";
import { DoneView as LegacyDoneView } from "./DoneView.legacy";
import { ErrorView } from "./ErrorView";
import type { JobPoll } from "./useJobPoll";

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

export function LegacyProject({ load }: JobPoll) {
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
