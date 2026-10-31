"use client";
/**
 * The job of /app/p/[jobId]: GET /jobs/{id}, again every 2 s while it
 * runs (pending / processing), paused while the tab is hidden and asked
 * again when it shows. Starts once useProjectsV2() is known: v1 keeps
 * opening the editor by itself when the analysis is done; the v2
 * Vorschau shows the job in every state and never redirects.
 *
 * In review the Vorschau plays the cut preview: while the server
 * rebuilds it for the stored timeline (preview_status "building") the
 * poll goes on, so the new preview_version arrives; "stale" (none being
 * built yet: the player's request starts one) is asked again with the
 * failures' backoff.
 *
 * setJob(job): a newer job than the last answer (POST /render's): shown
 * at once, polled again from there; an answer to a request sent before
 * it is dropped.
 *
 * A job seen in review or exported marks this tab's export hint
 * (features/jobs/localJobs): a later queued run of it can only be an
 * export (previewStateOf).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";

const POLL_MS = 2000;
// After an answer that isn't a job (a 502 / 503 while the backend
// restarts on a deploy, offline): again after 2 s, doubling to 30 s.
const RETRY_MAX_MS = 30_000;

/** The wait before the next try after `failures` failed ones in a row. */
function retryDelay(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

export type Load =
  | { state: "loading" }
  | { state: "job"; job: JobStatus }
  | { state: "gone" }
  | { state: "failed"; status: number };

export type JobPoll = { load: Load; setJob: (job: JobStatus) => void };

const running = (job: JobStatus) => job.status === "pending" || job.status === "processing";
const previewStale = (job: JobStatus) => job.status === "awaiting_review" && job.preview_status === "stale";
const polled = (job: JobStatus) =>
  running(job) || previewStale(job) || (job.status === "awaiting_review" && job.preview_status === "building");

export function useJobPoll(jobId: string): JobPoll {
  const router = useRouter();
  const v2 = useProjectsV2();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // The running poll's setJob (null until it starts).
  const showRef = useRef<((job: JobStatus) => void) | null>(null);

  useEffect(() => {
    if (v2 === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // "stale" answers in a row.
    let stale = 0;
    // Bumped by setJob: answers to requests sent before are older.
    let shown = 0;
    const next = (again: boolean) => {
      if (again && !cancelled && !document.hidden) {
        const backoff = failures || stale;
        timer = setTimeout(() => void tick(), backoff ? retryDelay(backoff) : POLL_MS);
      }
    };
    const show = (job: JobStatus) => {
      stale = previewStale(job) ? stale + 1 : 0;
      if (job.status === "awaiting_review" || job.status === "done") setExportHint(jobId);
      setLoad({ state: "job", job });
    };
    const tick = async () => {
      clearTimeout(timer);
      if (cancelled) return;
      const asked = shown;
      let again = false;
      try {
        const r = await apiFetch(`/jobs/${jobId}`);
        if (cancelled || asked !== shown) return;
        if (r.status === 404) setLoad({ state: "gone" });
        else if (r.status === 401 || r.status === 403) {
          // Sign-in opens (apiFetch); nothing to poll meanwhile.
          setLoad((cur) => (cur.state === "job" ? cur : { state: "failed", status: r.status }));
        } else if (!r.ok) {
          // A hiccup (5xx, 429): keep what is shown, try again later.
          failures++;
          again = true;
        } else {
          failures = 0;
          const job: JobStatus = await r.json();
          if (cancelled || asked !== shown) return;
          if (!v2 && job.status === "awaiting_review") {
            router.replace(`/app/edit/${jobId}`);
            return;
          }
          show(job);
          again = polled(job);
        }
      } catch {
        if (asked !== shown) return;
        failures++;
        again = true; // offline: try again
      }
      next(again);
    };
    showRef.current = (job) => {
      shown++;
      clearTimeout(timer);
      failures = 0;
      show(job);
      next(polled(job));
    };
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      showRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [jobId, router, v2]);

  const setJob = useCallback((job: JobStatus) => {
    if (showRef.current) showRef.current(job);
    else setLoad({ state: "job", job });
  }, []);

  return { load, setJob };
}
