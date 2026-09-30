"use client";
/**
 * /app/p/[jobId] (UX5): one project, by its status (PLAN_TECH §1.1).
 * First version from what exists (UX11/UX12 bring the real views):
 *
 *   pending / processing   its job card, enlarged, with the stage
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
import type { JobStatus } from "@/features/jobs/types";
import { DoneView } from "./DoneView.legacy";
import { ErrorView } from "./ErrorView";

const POLL_MS = 2000;

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

export function ProjectPage({ jobId }: { jobId: string }) {
  const t = useT();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (cancelled) return;
      let running = false;
      try {
        const r = await apiFetch(`/jobs/${jobId}`);
        if (cancelled) return;
        if (r.status === 404) setLoad({ state: "gone" });
        else if (!r.ok) setLoad((cur) => (cur.state === "job" ? cur : { state: "failed", status: r.status }));
        else {
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
        running = true; // offline: try again
      }
      if (running && !cancelled && !document.hidden) timer = setTimeout(() => void tick(), POLL_MS);
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
