"use client";
/**
 * The processing view of /app/p/[jobId] (UX12, flows.md §3.4): what
 * happens to the video while it is analysed — or exported — as a
 * checklist from the job's stage codes (backend/errors.py STAGES), an
 * estimate of the time left, and what the user may do meanwhile. When the
 * analysis ends while this view is visible, ProjectPage opens the editor
 * by itself. No "Notify me" button (review G9).
 */
import { useEffect, useState } from "react";
import { Check, Film, LoaderCircle } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Progress } from "@/components/ui/Progress";
import { useLang, useT, type TFn } from "@/i18n";
import { stageText } from "@/lib/errors";
import { plural } from "@/lib/i18n/plural";
import type { MessageKey } from "@/i18n/messages/en";
import type { JobStatus } from "@/features/jobs/types";
import { analysisEta, toMsTime } from "@/features/jobs/projects";
import { useLocalThumb } from "@/features/upload/uploadState";

export type Step = { id: string; key: MessageKey; stages: string[] };

/** The analysis: Uploaded ✓ → Listening → Cutting → Captions → Ready. */
export const ANALYSIS_STEPS: Step[] = [
  { id: "uploaded", key: "app.processing.step.uploaded", stages: [] },
  { id: "listening", key: "app.processing.step.listening", stages: ["queued", "analyze.normalize", "analyze.smartcam", "analyze.transcribe"] },
  { id: "cutting", key: "app.processing.step.cutting", stages: ["analyze.cleanup", "analyze.cuts"] },
  { id: "captions", key: "app.processing.step.captions", stages: ["analyze.captions"] },
  { id: "ready", key: "app.processing.step.ready", stages: ["analyze.done"] },
];

/** The export: Preparing → Captions → Encoding → Finishing. */
export const EXPORT_STEPS: Step[] = [
  { id: "prepare", key: "app.processing.step.prepare", stages: ["queued", "render.prepare"] },
  { id: "addCaptions", key: "app.processing.step.addCaptions", stages: ["render.captions"] },
  { id: "encode", key: "app.processing.step.encode", stages: ["render.encode"] },
  { id: "finish", key: "app.processing.step.finish", stages: ["render.hooks", "render.finish"] },
];

/** Index of the step the job is in (a stage nobody knows: the first one
 *  after "Uploaded"). */
export function currentStep(steps: Step[], stage: string | null | undefined): number {
  const i = stage ? steps.findIndex((s) => s.stages.includes(stage)) : -1;
  if (i >= 0) return i;
  return steps[0].id === "uploaded" ? 1 : 0;
}

/** The time-left line: null without an estimate. `slow` past 3× the
 *  estimate (flows.md §3.4: "taking longer than usual"). */
export function etaLine(
  { duration, createdAt, now }: { duration: number | null | undefined; createdAt: number | null; now: number },
): { kind: "minutes"; n: number } | { kind: "underMinute" | "almost" | "slow" } | null {
  const eta = analysisEta(duration ?? null);
  if (eta === null || createdAt === null) return null;
  const elapsed = Math.max(0, (now - createdAt) / 1000);
  if (elapsed > eta * 3) return { kind: "slow" };
  const left = eta - elapsed;
  if (left <= 5) return { kind: "almost" };
  if (left < 60) return { kind: "underMinute" };
  return { kind: "minutes", n: Math.ceil(left / 60) };
}

function etaText(e: NonNullable<ReturnType<typeof etaLine>>, t: TFn, lang: string): string {
  switch (e.kind) {
    case "minutes":
      return t(plural(lang, e.n, { one: "app.processing.etaMinutesOne", other: "app.processing.etaMinutesOther" }), { n: e.n });
    case "underMinute":
      return t("app.processing.etaUnderMinute");
    case "almost":
      return t("app.processing.etaAlmost");
    case "slow":
      return t("app.processing.slow");
  }
}

export function ProcessingView({ job, exporting, name }: { job: JobStatus; exporting: boolean; name: string }) {
  const t = useT();
  const lang = useLang();
  const thumb = useLocalThumb(job.id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const steps = exporting ? EXPORT_STEPS : ANALYSIS_STEPS;
  const at = currentStep(steps, job.stage);
  const queued = job.stage === "queued" || job.message === "queued";
  const detail = queued
    ? job.queue_position
      ? t("app.card.queued.title", { n: job.queue_position })
      : t("app.card.queued.titleNoPos")
    : stageText(job.stage, job.stage_params, t);
  const createdAt = toMsTime((job as { created_at?: unknown }).created_at);
  const eta = exporting ? null : etaLine({ duration: job.duration, createdAt, now });

  return (
    <section
      data-testid="processing"
      data-phase={exporting ? "rendering" : "analyzing"}
      data-step={steps[at]?.id}
      aria-labelledby="processing-title"
      className="flex flex-col gap-6"
    >
      <div className="flex items-center gap-4">
        <div
          className="relative flex h-20 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl"
          style={{ background: "var(--surface-2)", color: "var(--text-faint)" }}
        >
          {thumb ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={thumb} alt="" className="h-full w-full object-contain" />
          ) : (
            <Icon icon={Film} size={24} strokeWidth={1.5} />
          )}
        </div>
        <div className="min-w-0">
          <h1 id="processing-title" className="text-xl font-bold tracking-tight" style={{ color: "var(--text-strong)" }}>
            {t(exporting ? "app.processing.titleExport" : "app.processing.titleAnalyze")}
          </h1>
          <p className="truncate text-sm" style={{ color: "var(--text-muted)" }} title={name}>
            {name}
          </p>
        </div>
      </div>

      <ol className="flex flex-col gap-1" data-testid="processing-steps">
        {steps.map((s, i) => {
          const state = i < at ? "done" : i === at ? "current" : "todo";
          return (
            <li
              key={s.id}
              data-testid={`processing-step-${s.id}`}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
              className="flex items-start gap-3 rounded-xl px-3 py-2.5"
              style={state === "current" ? { background: "var(--surface-1)", border: "1px solid var(--border)" } : undefined}
            >
              <span
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: state === "done" ? "var(--success)" : state === "current" ? "var(--brand-tint)" : "var(--surface-2)",
                  color: state === "done" ? "#0b0b0f" : "var(--brand-strong)",
                }}
              >
                {state === "done" ? (
                  <Icon icon={Check} size={13} strokeWidth={3} />
                ) : state === "current" ? (
                  <Icon icon={LoaderCircle} size={13} strokeWidth={2.5} className="animate-spin motion-reduce:animate-none" />
                ) : null}
              </span>
              <span className="min-w-0">
                <span
                  className="block text-sm font-medium"
                  style={{ color: state === "todo" ? "var(--text-muted)" : "var(--text-strong)" }}
                >
                  {t(s.key)}
                  {state === "done" && <span className="sr-only"> ✓</span>}
                </span>
                {state === "current" && detail && (
                  <span className="block text-xs" style={{ color: "var(--text-muted)" }} data-testid="project-stage">
                    {detail}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-2">
        <Progress value={job.progress} color="#8b5cf6" min={3} label={t(steps[at]?.key ?? steps[0].key)} />
        <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
          <span data-testid="processing-eta" data-kind={eta?.kind}>{eta ? etaText(eta, t, lang) : null}</span>
          <span className="tabular-nums">{Math.round(job.progress)}%</span>
        </div>
      </div>

      <p className="rounded-xl px-4 py-3 text-sm" style={{ background: "var(--surface-1)", color: "var(--text-body)" }}>
        {t(exporting ? "app.processing.closeTabExport" : "app.processing.closeTab")}
      </p>
    </section>
  );
}
