/**
 * Timeline saves that don't wait for the preview rebuild.
 *
 * POST /jobs/{id}/edit-segments stores the timeline right away but only
 * answers once the server has rebuilt preview.mp4 from it. An editor
 * that plays the proxy (lib/editPlayback) never needs that preview, so
 * where it waits for a save (Apply & render, reopening a job) it only
 * waits until the save is stored: the answer, or GET /jobs/{id}
 * showing the timeline — whichever comes first.
 */
import { apiFetch } from "@/lib/api";

export type TimelineSeg = {
  start: number;
  end: number;
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  volume?: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const eff = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === "number" && isFinite(v) ? clamp(v, lo, hi) : fallback;

/** The timeline as the backend stores it (_save_edit_segments: end
 *  clamped to the video, clips under 0.05 s dropped, effects clamped). */
function asStored(segs: TimelineSeg[], duration: number): number[][] {
  const out: number[][] = [];
  for (const s of segs) {
    const start = Math.max(0, Number(s.start) || 0);
    let end = Number(s.end) || 0;
    if (duration > 0) end = Math.min(end, duration);
    if (end - start < 0.05) continue;
    out.push([
      start,
      end,
      eff(s.speed, 1, 0.25, 4),
      eff(s.fadeIn, 0, 0, 2),
      eff(s.fadeOut, 0, 0, 2),
      eff(s.volume, 1, 0, 2.5),
    ]);
  }
  return out;
}

/** Same timeline (the server rounds times to 1 ms). */
export function sameTimeline(
  server: TimelineSeg[] | undefined,
  ours: TimelineSeg[],
  duration: number,
): boolean {
  if (!Array.isArray(server)) return false;
  const a = asStored(server, duration);
  const b = asStored(ours, duration);
  return (
    a.length === b.length &&
    a.every((row, i) => row.every((v, k) => Math.abs(v - b[i][k]) < 0.002))
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });

/** Resolves true once GET /jobs/{id} shows `segs` as the saved timeline;
 *  false when the job is gone or left review, or after `timeoutMs`. */
export async function waitUntilStored(
  jobId: string,
  segs: TimelineSeg[],
  duration: number,
  opts: { signal?: AbortSignal; timeoutMs?: number; firstDelayMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const { signal, timeoutMs = 15_000, firstDelayMs = 200, intervalMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  let wait = firstDelayMs;
  for (;;) {
    await sleep(wait, signal);
    if (signal?.aborted || Date.now() > deadline) return false;
    wait = intervalMs;
    try {
      const r = await apiFetch(`/jobs/${jobId}`, { signal, cache: "no-store" });
      if (r.status === 404 || r.status === 410) return false;
      if (!r.ok) continue;
      const j: { status?: string; edit_segments?: TimelineSeg[] } = await r.json();
      if (sameTimeline(j.edit_segments, segs, duration)) return true;
      if (j.status && j.status !== "awaiting_review") return false;
    } catch {
      if (signal?.aborted) return false;
      /* network hiccup: keep trying */
    }
  }
}

export type SaveOutcome = "stored" | "refused" | "unknown";

/**
 * How a sent save ended, without waiting for its preview rebuild:
 *   stored  — answered OK, or the server already shows the timeline
 *   refused — a 4xx answer (the server won't take it)
 *   unknown — no OK answer and not seen stored within `timeoutMs`
 * With `settleOnAnswer`, any answer (even an error) ends the wait: used
 * where only the ORDER of saves matters.
 */
export function saveOutcome(
  jobId: string,
  segs: TimelineSeg[],
  duration: number,
  response: Promise<Response>,
  opts: { timeoutMs?: number; settleOnAnswer?: boolean } = {},
): Promise<SaveOutcome> {
  const ctl = new AbortController();
  return new Promise<SaveOutcome>((resolve) => {
    let open = 2;
    const done = (o: SaveOutcome) => {
      ctl.abort();
      resolve(o);
    };
    const lost = () => {
      if (--open === 0) done("unknown");
    };
    response.then(
      (r) => {
        if (r.ok) done("stored");
        else if (r.status >= 400 && r.status < 500) done("refused");
        else if (opts.settleOnAnswer) done("unknown");
        else lost();
      },
      () => (opts.settleOnAnswer ? done("unknown") : lost()),
    );
    waitUntilStored(jobId, segs, duration, {
      signal: ctl.signal,
      timeoutMs: opts.timeoutMs,
    }).then((ok) => (ok ? done("stored") : lost()));
  });
}
