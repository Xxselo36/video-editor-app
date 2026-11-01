"use client";
/**
 * The job of /app/p/[jobId]: the poll of jobPoll.ts (GET /jobs/{id}
 * while it runs, after the editor's last saves, and until the preview
 * shows the stored timeline), asked again when the tab shows. Starts
 * once useProjectsV2() is known: v1 keeps opening the editor by itself
 * when the analysis is done; the v2 Vorschau shows the job in every
 * state and never redirects.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobStatus } from "@/features/jobs/types";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import { startJobPoll, type JobPollControl, type Load } from "./jobPoll";

export type { Load } from "./jobPoll";

export type JobPoll = {
  load: Load;
  /** A newer job than the last answer (POST /render's): shown at once. */
  setJob: (job: JobStatus) => void;
  /** How often this job's saves still out (lib/pendingSaves) settled
   *  while the page was open; it grows together with the first job
   *  asked for after them (what to read again then). */
  settled: number;
  /** GET /jobs/{id} now. */
  refresh: () => void;
  /** The preview of the stored timeline couldn't be built: asked once
   *  more, it failed again. */
  previewFailed: boolean;
};

export function useJobPoll(jobId: string): JobPoll {
  const router = useRouter();
  const v2 = useProjectsV2();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [settled, setSettled] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  // The running poll (null until it starts).
  const pollRef = useRef<JobPollControl | null>(null);

  useEffect(() => {
    if (v2 === null) return;
    const poll = startJobPoll(jobId, {
      v2,
      load: setLoad,
      settled: () => setSettled((n) => n + 1),
      previewFailed: setPreviewFailed,
      toEditor: () => router.replace(`/app/edit/${jobId}`),
    });
    pollRef.current = poll;
    const onVisible = () => {
      if (!document.hidden) poll.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      poll.stop();
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [jobId, router, v2]);

  const setJob = useCallback((job: JobStatus) => {
    if (pollRef.current) pollRef.current.setJob(job);
    else setLoad({ state: "job", job });
  }, []);
  const refresh = useCallback(() => pollRef.current?.refresh(), []);

  return { load, setJob, settled, refresh, previewFailed };
}
