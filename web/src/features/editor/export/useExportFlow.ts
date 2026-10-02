"use client";
/**
 * The export sheet's state machine (UX11, PLAN_TECH §UX11 "Web"): the v2
 * editor exports in place instead of sending the user to the dashboard.
 *
 *   closed ─open→ confirm ─Export→ saving ─(timeline stored)→ rendering
 *   rendering ─poll: done→ done        (instant: straight to done)
 *   rendering ─poll: back in review with an error→ failed ─Try again→ rendering
 *
 * `saving` is the session's apply (useEditSession: the timeline on screen
 * is stored first — never an older cut), which then calls start() as the
 * editor's onApply. Leaving while it renders is fine: the project page
 * and its card show the rest.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { refreshMe } from "@/lib/account";
import { apiFetch } from "@/lib/api";
import { describeError, jobErrorText } from "@/lib/errors";
import type { JobStatus } from "@/features/jobs/types";
import { reopenJob } from "@/features/project/projectApi";

export type ExportPhase = "closed" | "confirm" | "saving" | "rendering" | "done" | "failed";

const POLL_MS = 1500;
const RENDER_FAILURES = new Set(["render_failed", "render_unavailable", "render_timeout"]);

export type ExportFlow = {
  phase: ExportPhase;
  /** The job as last read (cost numbers, stage, the Done view's data). */
  job: JobStatus | null;
  /** Why it failed (failed), mapped from the code. */
  error: string | null;
  /** Render failures in a row (2: "failed again"). */
  failures: number;
  instant: boolean;
  /** Saving or rendering: the editor's Export shows "Exporting…". */
  busy: boolean;
  open: (actions: { save: () => Promise<void>; reset: () => void }) => void;
  confirm: () => void;
  retry: () => void;
  close: () => void;
  /** The editor's onApply (after the timeline was stored). */
  start: () => void;
  editAgain: () => void;
  reopening: boolean;
  reopenError: string | null;
};

export function useExportFlow({
  jobId,
  render,
  onLeave,
  onReopened,
}: {
  jobId: string;
  /** POST /render with the editor's captions (startRender). */
  render: () => Promise<{ outcome: "started" | "not_in_review"; job: JobStatus | null }>;
  /** Close while rendering or after done: the project page. */
  onLeave: () => void;
  /** Reopened for editing: load the editor again. */
  onReopened: () => void;
}): ExportFlow {
  const t = useT();
  const [phase, setPhase] = useState<ExportPhase>("closed");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [instant, setInstant] = useState(false);
  // POST /render answered: from then on the job's state is the truth.
  const [posted, setPosted] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const actions = useRef<{ save: () => Promise<void>; reset: () => void } | null>(null);
  const started = useRef(false);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  });
  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  });

  const load = useCallback(async (): Promise<JobStatus | null> => {
    try {
      const r = await apiFetch(`/jobs/${jobId}`);
      if (!r.ok) return null;
      return (await r.json()) as JobStatus;
    } catch {
      return null;
    }
  }, [jobId]);

  // ── polling while it renders ──────────────────────────────────────
  useEffect(() => {
    if (phase !== "rendering" || !posted) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const j = await load();
      if (!live) return;
      if (j) {
        setJob(j);
        if (j.status === "done") {
          setPhase("done");
          setFailures(0);
          actions.current?.reset();
          return;
        }
        if (j.status === "awaiting_review" || j.status === "error") {
          // A render failure: the sheet's own words ("Export failed" +
          // "Your edits are saved"); the v1 catalogue text points to the
          // dashboard ("open the project"). Other causes as mapped.
          setError(RENDER_FAILURES.has(j.error_code ?? "") ? null : jobErrorText(j, t));
          setFailures((n) => n + 1);
          setPhase("failed");
          actions.current?.reset();
          return;
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phase, posted, load, t]);

  const open = useCallback(
    (a: { save: () => Promise<void>; reset: () => void }) => {
      actions.current = a;
      setError(null);
      setFailures(0);
      setInstant(false);
      setPhase("confirm");
      void load().then((j) => {
        if (!j) return;
        setJob(j);
        if (j.fair_use?.billed) void refreshMe();
      });
    },
    [load],
  );

  const start = useCallback(() => {
    started.current = true;
    setPosted(false);
    setPhase("rendering");
    renderRef
      .current()
      .then(({ outcome, job: j }) => {
        if (j) setJob(j);
        setPosted(true);
        if (outcome === "started" && j?.instant) {
          setInstant(true);
          setPhase("done");
          actions.current?.reset();
        }
        // not_in_review: already exporting (another tab) or done — the
        // poll shows which.
      })
      .catch((e: unknown) => {
        // Not started (a cap, offline): nothing failed on the server.
        setError(describeError(e, t));
        setPhase("failed");
        actions.current?.reset();
      });
  }, [t]);

  const confirm = useCallback(() => {
    const a = actions.current;
    if (!a) return;
    started.current = false;
    setPhase("saving");
    void a.save().then(() => {
      // The session didn't get to onApply: the timeline wasn't stored.
      if (!started.current && phaseRef.current === "saving") {
        setError(t("app.errors.saveEditsFailed"));
        setPhase("failed");
        a.reset();
      }
    });
  }, [t]);

  const retry = useCallback(() => {
    setError(null);
    // Stored before the first try (the editor stayed read-only since):
    // render again straight away; else store it first.
    if (started.current) start();
    else confirm();
  }, [start, confirm]);

  const close = useCallback(() => {
    const p = phaseRef.current;
    if (p === "saving") return;
    if (p === "rendering" || p === "done") {
      onLeave();
      return;
    }
    setPhase("closed");
  }, [onLeave]);

  const editAgain = useCallback(() => {
    setReopening(true);
    setReopenError(null);
    reopenJob(jobId, "export_sheet")
      .then(() => {
        setPhase("closed");
        onReopened();
      })
      .catch((e: unknown) => setReopenError(describeError(e, t)))
      .finally(() => setReopening(false));
  }, [jobId, onReopened, t]);

  return {
    phase,
    job,
    error,
    failures,
    instant,
    busy: phase === "saving" || phase === "rendering",
    open,
    confirm,
    retry,
    close,
    start,
    editAgain,
    reopening,
    reopenError,
  };
}
