"use client";
/**
 * The editor session (UX7): the player's playback source (proxy or
 * preview), the editable timeline, its autosave with flush-on-leave, and
 * "apply" (save the timeline on screen, then render). Moved verbatim out
 * of the v1 ReviewScreen (PLAN_TECH rule 0.2 "move first, then change") so
 * the v1 screen and the v2 shell run the same code:
 *   - doRebuild / flushOnLeave / saveOutcome / trackSave, the keepalive
 *     64 KB cap;
 *   - the proxy vs. preview branches (EditPlayer, the preview src swap).
 *
 * Per-frame time is NOT state here: the v1 screen polls it itself, the v2
 * shell reads the playhead store. Both map the element's time to source
 * time with `sourceTimeOf` / `toSource`.
 *
 * The trim flow round (owner: "Vorschau hat gedauert", "Video zeigt was
 * anderes als Timeline", "Untertitel fielen aus"):
 *   - saves are serialised only until the previous one is STORED, not
 *     until its answer (which comes after the server's full preview
 *     re-encode, 19 s for the owner): the next edit reaches the server at
 *     once; "Saved" shows only once the server has the timeline on screen;
 *   - preview mode: while the playing file is older than the edit
 *     (previewStale, a chip until the matching file is on screen), playing
 *     skips the footage the edit removed (previewSync.stalePlan); a swap
 *     lands on the same SOURCE moment (previewSync.swapTime), or on a
 *     moment the user asked for that the old file didn't have; a failed
 *     rebuild says so (previewError, Retry) and is retried; reopening
 *     follows the rebuilds until the preview matches the saved timeline;
 *   - export stores the timeline once (no extra rebuild to wait for);
 *   - a hidden page (iOS app switch) sends a pending edit at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";
import { apiFetch, isMediaReady, mediaUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import { buildPlan, EditPlayer, probeProxy } from "@/lib/editPlayback";
import { sameTimeline, saveOutcome, type SaveOutcome, type TimelineSeg } from "@/lib/editSave";
import { trackSave } from "@/lib/pendingSaves";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { CutRange, JobStatus, SavedSeg } from "@/features/jobs/types";
import { previewMatches, previewTimeOf, skipTarget, stalePlan, swapTime } from "./previewSync";

export type PlaybackMode = "probing" | "proxy" | "preview";
export type SaveError = "retrying" | "failed" | null;
type Segs = [number, number][];

export type EditSessionInput = {
  jobId: string;
  savedSegments: SavedSeg[];
  previewSegments: Segs;
  previewVersion: number;
  /** GET /jobs/{id} has_proxy: true / false, undefined = not reported. */
  hasProxy: boolean | undefined;
  cutRanges: CutRange[];
  duration: number;
  onApply: () => void;
  /** UX10 (v2): EditPlayer's gain ramp around a cut's jump, in ms
   *  (review C9). Unset: none, as the v1 editor plays. */
  seekRampMs?: number;
};

/**
 * Element time → SOURCE time. The proxy's timeline IS the source
 * timeline; the cut preview plays the kept segments back to back.
 */
export function sourceTimeOf(
  currentTime: number,
  mode: PlaybackMode,
  videoSegments: Segs,
  keptSegments: Segs,
  duration: number,
): number {
  // The proxy's timeline IS the source timeline.
  if (mode === "proxy") return currentTime;
  const src = videoSegments.length ? videoSegments : keptSegments;
  if (!src.length) return currentTime;
  let acc = 0;
  for (const [s, e] of src) {
    const segDur = e - s;
    if (acc + segDur >= currentTime) return s + (currentTime - acc);
    acc += segDur;
  }
  return duration;
}

/**
 * The playhead's place in the EDIT and the edit's length (the native
 * control bar shows the file's own time — the whole source in proxy mode).
 * Same mapping as the timeline readout.
 */
export function cutClockOf(
  editSegs: EditorSeg[],
  originalTime: number,
  playingSegId: string | null,
  mode: PlaybackMode,
): { at: number; total: number } {
  let at: number | null = null;
  let total = 0;
  const find = (matchSeg: boolean) => {
    let acc = 0;
    for (const s of editSegs) {
      if (s.disabled) continue;
      const d = s.end - s.start;
      if (
        at === null &&
        (!matchSeg || s.id === playingSegId) &&
        originalTime >= s.start - 0.05 &&
        originalTime <= s.end + 0.05
      ) {
        at = acc + Math.min(d, Math.max(0, originalTime - s.start));
      }
      acc += d;
    }
    total = acc;
  };
  if (mode === "proxy" && playingSegId) find(true);
  if (at === null) find(false);
  return { at: at ?? 0, total };
}

export function useEditSession({
  jobId,
  savedSegments,
  previewSegments,
  previewVersion,
  hasProxy,
  cutRanges,
  duration,
  onApply,
  seekRampMs,
}: EditSessionInput) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  // How the player shows the edit:
  //   proxy   — plays the job's full-source proxy and follows the edit
  //             list itself (lib/editPlayback): edits show instantly and
  //             nothing waits for the server's preview rebuild.
  //   preview — backend without a proxy: plays the server-built cut
  //             preview.mp4 and swaps in each rebuild.
  //   probing — has_proxy not reported: one small request decides.
  //             The preview already loads meanwhile (no extra round
  //             trip before the video shows); a "yes" swaps to the proxy
  //             unless the user has already started playing.
  const [mode, setMode] = useState<PlaybackMode>(
    hasProxy === true ? "proxy" : hasProxy === false ? "preview" : "probing",
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const mediaReady = useMediaReady();
  // Frozen for the element's lifetime, like every media src.
  const proxySrc = useMediaUrl(jobId, "proxy-video");
  useEffect(() => {
    if (mode !== "probing" || !mediaReady) return;
    let live = true;
    void probeProxy(mediaUrl(jobId, "proxy-video")).then((ok) => {
      if (!live) return;
      const v = videoRef.current;
      // Already playing (or played) the preview: don't yank the src.
      const started = !!v && (!v.paused || v.played.length > 0);
      setMode(ok && !started ? "proxy" : "preview");
    });
    return () => {
      live = false;
    };
  }, [mode, mediaReady, jobId]);
  // Preview mode — set once: a changing src would restart playback.
  // Later previews are swapped in imperatively (swapPreviewSrc), only
  // while paused. With accounts on, not before the media token is known
  // (/me can be slow): a tokenless src would fail for good.
  const [waitingVersion, setWaitingVersion] = useState(previewVersion);
  const [initialPreviewSrc, setInitialPreviewSrc] = useState<string | null>(null);
  if (initialPreviewSrc === null && mediaReady && mode !== "proxy") {
    setInitialPreviewSrc(mediaUrl(jobId, "preview-video", { v: waitingVersion }));
  }
  const videoSrc = mode === "proxy" ? proxySrc : initialPreviewSrc;

  // Video plays the cut-preview (concatenated kept segments), so
  // currentTime lives on the CUT timeline. We map it back to the
  // original timeline for the strip playhead so the cursor lines up
  // with the right original-time position.
  const keptSegments = useMemo<Segs>(() => {
    if (!duration) return [];
    const sorted = [...cutRanges].sort((a, b) => a.start - b.start);
    const kept: Segs = [];
    let cursor = 0;
    for (const c of sorted) {
      if (c.start > cursor) kept.push([cursor, c.start]);
      cursor = c.end;
    }
    if (cursor < duration) kept.push([cursor, duration]);
    return kept;
  }, [cutRanges, duration]);

  // Segments the CURRENT preview MP4 was rendered from. Kept in sync
  // with what's actually playing, NOT with the user's in-progress
  // edits — otherwise the playhead jumps around wildly while the
  // rebuild is still pending.
  const [videoSegments, setVideoSegments] = useState<Segs>(() => previewSegments);
  useEffect(() => {
    if (videoSegments.length === 0 && keptSegments.length > 0) {
      setVideoSegments(keptSegments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptSegments.length]);

  /** Element time → source time, for the current playback source. */
  const toSource = useCallback(
    (currentTime: number) => sourceTimeOf(currentTime, mode, videoSegments, keptSegments, duration),
    [mode, videoSegments, keptSegments, duration],
  );

  // Editable segments — starts from keptSegments and can be trimmed,
  // split, deleted, or reordered by the user in the timeline editor.
  // Changes debounce-POST to /jobs/:id/edit-segments so the preview
  // video rebuilds and the player reflects the new timeline.
  // Seeded from the user's SAVED timeline (earlier visits included);
  // only a job that was never edited falls back to the automatic cuts.
  const [editSegs, setEditSegs] = useState<EditorSeg[]>(() =>
    savedSegments.map((s, i) => ({
      id: `seg-${i}-${s.start.toFixed(3)}`,
      start: s.start,
      end: s.end,
      speed: s.speed,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      volume: s.volume,
    })),
  );
  // "retrying": transient failure, the edit is re-sent. "failed": the
  // server refused it for good (job gone / no longer in review).
  const [saveError, setSaveError] = useState<SaveError>(null);
  // Set when the editor unmounts: nothing may re-queue or retry after
  // that — a late retry would overwrite the edit flushed on leave.
  const closedRef = useRef(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  useEffect(() => {
    // Seed from keptSegments the first time they arrive
    if (editSegs.length === 0 && keptSegments.length > 0) {
      setEditSegs(
        keptSegments.map(([s, e], i) => ({
          id: `seg-${i}-${s.toFixed(3)}`,
          start: s,
          end: e,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptSegments.length]);

  // Edits update local state instantly (strip re-renders in the same
  // frame). A debounced POST stores the timeline 800ms after the last
  // edit — long enough that rapid trims coalesce into one save, short
  // enough that the user doesn't wait when they stop. In preview mode the
  // server rebuilds the cut preview from it (its answer comes after that).
  //
  // The src swap that follows is gated: if the video is currently
  // playing we defer until the next pause. That's what killed the
  // 'flow' before — the browser reloaded mid-playback and jumped
  // back to the start of the clip. Until then playing skips what the
  // edit removed (stalePlan below).
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRebuildRef = useRef<EditorSeg[] | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  /** The save on the wire until the server has STORED it (the next one waits for this only). */
  const storingRef = useRef<Promise<SaveOutcome> | null>(null);
  const swapWhenPausedRef = useRef(false);
  const pendingSwapRef = useRef<{ segs: Segs; version: number } | null>(null);
  // The save on the wire (its request answers only after the preview
  // rebuild), so saves and the export can wait for it to be STORED instead.
  const inflightSaveRef = useRef<{ payload: TimelineSeg[]; response: Promise<Response> } | null>(null);
  /** The last timeline the server is known to have stored. */
  const storedRef = useRef<TimelineSeg[] | null>(null);
  const applyingRef = useRef(false);
  /** The latest committed clip list (what "Saved" must match). */
  const latestRef = useRef(editSegs);
  /** The preview version on screen (or waiting to be swapped in). */
  const shownVersionRef = useRef(previewVersion);
  /** Source time a seek asked for that the playing (stale) preview doesn't have: the swap lands there. */
  const wantSourceRef = useRef<number | null>(null);
  /** While a swap loads: the new file's time the playhead shows (not the 0 of the reload). */
  const swapHoldRef = useRef<number | null>(null);
  // the segments of the file on screen, for swaps made between renders
  const videoSegmentsRef = useRef(videoSegments);
  useEffect(() => {
    videoSegmentsRef.current = videoSegments;
  }, [videoSegments]);
  const putVideoSegments = (segs: Segs) => {
    videoSegmentsRef.current = segs;
    setVideoSegments(segs);
  };
  // "Preview couldn't update": a rebuild failed (preview_ok false), or a
  // reopened job's preview never caught up with its saved timeline.
  const [previewError, setPreviewError] = useState(false);
  const previewRetry = useRef<{ n: number; timer: ReturnType<typeof setTimeout> | null }>({ n: 0, timer: null });

  const editPath = `/jobs/${jobId}/edit-segments`;
  const toPayload = (segs: EditorSeg[]) =>
    segs
      .filter((s) => !s.disabled && s.end - s.start > 0.05)
      .map((s) => ({
        start: s.start,
        end: s.end,
        speed: s.speed,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        volume: s.volume,
      }));

  /** "Saving" ends only when the server has stored what is on screen —
   *  not during the debounce, not while queued behind another save. */
  const settleSaving = () => {
    if (closedRef.current || rebuildTimerRef.current || pendingRebuildRef.current || storingRef.current) return;
    const stored = storedRef.current;
    const want = toPayload(latestRef.current);
    if (want.length === 0 || (stored && sameTimeline(stored, want, duration))) setEditSaving(false);
  };

  /** Element time of the new preview for the moment on screen (previewSync.swapTime). */
  const swapPreviewSrc = (version: number, newSegs: Segs, oldSegs: Segs) => {
    const v = videoRef.current;
    if (!v) return;
    if (!isMediaReady()) {
      // No media token yet: the first src, set once it arrives, is this one.
      setWaitingVersion(version);
      return;
    }
    const target = swapTime(v.currentTime, oldSegs, newSegs, wantSourceRef.current);
    wantSourceRef.current = null;
    swapHoldRef.current = target;
    v.src = mediaUrl(jobId, "preview-video", { v: version });
    // the playhead keeps the target until the new file is there (no 0 flash)
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      v.removeEventListener("seeked", release);
      if (fallback) clearTimeout(fallback);
      if (swapHoldRef.current === target) swapHoldRef.current = null;
    };
    const restore = () => {
      v.removeEventListener("loadedmetadata", restore);
      try {
        const dur = isFinite(v.duration) ? v.duration : 0;
        const at = Math.min(target, Math.max(0, dur - 0.1));
        if (Math.abs(v.currentTime - at) < 1e-3) release();
        else {
          v.addEventListener("seeked", release, { once: true });
          fallback = setTimeout(release, 1500);
          v.currentTime = at;
        }
      } catch {
        release();
      }
    };
    v.addEventListener("loadedmetadata", restore, { once: true });
  };

  // Switch the player to a rebuilt preview together with the segment
  // list it was built from (the server's, not ours), so the playhead
  // mapping always matches the file that is playing.
  const applyPreview = (segs: Segs, version: number) => {
    // never back to an older file (answers of earlier saves, a poll)
    if (version <= shownVersionRef.current && shownVersionRef.current > 0) return;
    shownVersionRef.current = version;
    if (previewMatches(segs, latestRef.current)) {
      setPreviewError(false);
      previewRetry.current.n = 0;
    }
    if (modeRef.current === "proxy") {
      // Proxy: nothing to reload. Only remember the newest preview, in
      // case the player falls back to preview mode. (Probing plays the
      // preview until the probe answers, so it swaps like preview.)
      putVideoSegments(segs);
      setWaitingVersion(version);
      return;
    }
    const v = videoRef.current;
    if (v && v.paused) {
      const old = videoSegmentsRef.current;
      putVideoSegments(segs);
      swapPreviewSrc(version, segs, old);
    } else {
      // Defer the src swap until the user pauses — we DO NOT
      // interrupt playback in flight. The pause listener below
      // performs the swap when they stop.
      pendingSwapRef.current = { segs, version };
      swapWhenPausedRef.current = true;
    }
  };

  const scheduleRebuild = (delay: number) => {
    if (closedRef.current) return;
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      void doRebuild();
    }, delay);
  };

  // The rebuild failed on the server (the save itself is stored): say so
  // and ask for it again, with backoff, then leave it to Retry.
  const previewFailed = () => {
    setPreviewError(true);
    const r = previewRetry.current;
    if (r.timer || r.n >= 3 || closedRef.current) return;
    const delay = [3000, 10_000, 30_000][r.n++];
    r.timer = setTimeout(() => {
      r.timer = null;
      if (closedRef.current || pendingRebuildRef.current || inflightRef.current) return;
      pendingRebuildRef.current = latestRef.current;
      void doRebuild();
    }, delay);
  };

  /** POST the timeline. Resolves with how the save ended; registers it as THE save on the wire. */
  const send = (active: TimelineSeg[], next: EditorSeg[], keepalive = false) => {
    setEditSaving(true);
    const body = JSON.stringify({ segments: active });
    const request = apiFetch(editPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      ...(keepalive && body.length < 60_000 ? { keepalive: true } : {}),
    });
    inflightSaveRef.current = { payload: active, response: request };
    // The next save waits until this one is STORED (or answered): the
    // order of saves is kept, but nobody waits for the preview re-encode.
    const storing = saveOutcome(jobId, active, duration, request).then(async (o) => {
      if (o === "stored") {
        storedRef.current = active;
        if (!closedRef.current) setSaveError(null);
      }
      // not seen stored: wait for the answer, so the next save can't overtake it
      else await request.catch(() => undefined);
      return o;
    });
    storingRef.current = storing;
    void storing.then(() => {
      if (storingRef.current === storing) storingRef.current = null;
      settleSaving();
    });
    const run = (async () => {
      try {
        const r = await request;
        if ([400, 404, 409, 410].includes(r.status)) {
          // Permanent: retrying can't help.
          setSaveError("failed");
          return;
        }
        if (!r.ok) throw new Error(`save failed (${r.status})`);
        const data: JobStatus & { preview_ok?: boolean; superseded?: boolean } = await r.json();
        storedRef.current = active;
        setSaveError(null);
        if (closedRef.current) return;
        if (data.preview_ok && data.preview_segments) {
          applyPreview(data.preview_segments, data.preview_version ?? shownVersionRef.current + 1);
        } else if (!data.superseded && modeRef.current !== "proxy") {
          // stored, but the server couldn't rebuild the preview from it
          previewFailed();
        }
      } catch {
        // Apply & render already sent the timeline on screen.
        if (closedRef.current || applyingRef.current) return;
        // Keep the edit unless a newer one replaced it, and retry.
        if (!pendingRebuildRef.current) pendingRebuildRef.current = next;
        setSaveError("retrying");
        scheduleRebuild(3000);
      } finally {
        if (inflightSaveRef.current?.response === request) inflightSaveRef.current = null;
        settleSaving();
      }
    })();
    inflightRef.current = run;
    void run.finally(() => {
      if (inflightRef.current === run) inflightRef.current = null;
    });
    // Reopening the job waits for this save — until it is stored, not for
    // the preview rebuild (the reopened editor follows that itself).
    trackSave(jobId, storing);
    return storing;
  };

  // One save at a time, always sending the latest edit (with effects —
  // sending only start/end used to reset speed/volume/fades on every
  // autosave). A failed save stays pending and is retried.
  const doRebuild = async (): Promise<void> => {
    while (storingRef.current) await storingRef.current;
    const next = pendingRebuildRef.current;
    if (!next) return;
    pendingRebuildRef.current = null;
    const active = toPayload(next);
    if (active.length === 0) {
      settleSaving();
      return;
    }
    await send(active, next);
  };

  // Leaving the editor (in-app navigation, tab close, reload) must not
  // drop an edit that is still waiting for its debounce.
  const flushOnLeave = (unloading: boolean) => {
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    const inflight = inflightSaveRef.current;
    const next = pendingRebuildRef.current;
    pendingRebuildRef.current = null;
    const active = next ? toPayload(next) : [];
    // Only when no newer save goes out now: that one replaces the
    // in-flight timeline on the server, so the in-flight one would never
    // be seen stored and reopening would wait for its rebuild.
    if (inflight && !unloading && active.length === 0) {
      trackSave(jobId, saveOutcome(jobId, inflight.payload, duration, inflight.response, { timeoutMs: 10_000 }));
    }
    if (active.length === 0) return;
    const body = JSON.stringify({ segments: active });
    const request = apiFetch(editPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive only while the page unloads (in-app navigation keeps
      // the page alive), and only under the browser's 64 KB cap.
      keepalive: unloading && body.length < 60_000,
      unloading,
    });
    trackSave(
      jobId,
      !unloading ? saveOutcome(jobId, active, duration, request, { timeoutMs: 10_000 }) : request.catch(() => {}),
    );
  };
  // The page went to the background (iPhone Safari fires no pagehide on
  // an app switch or the lock screen; timers freeze and a hidden tab may
  // be discarded): a pending edit goes NOW, as keepalive, without waiting
  // for the debounce or for the save on the wire to be stored.
  const flushHidden = () => {
    if (closedRef.current || applyingRef.current) return;
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    const next = pendingRebuildRef.current;
    if (!next) return;
    pendingRebuildRef.current = null;
    const active = toPayload(next);
    if (active.length) void send(active, next, true);
  };
  useEffect(() => {
    // Re-armed on (re)mount — React dev mode mounts effects twice.
    closedRef.current = false;
    const onHide = () => flushOnLeave(true);
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushHidden();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("freeze", onHidden);
    const retry = previewRetry.current;
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("freeze", onHidden);
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = null;
      closedRef.current = true;
      flushOnLeave(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The file on screen is older than the edit (preview mode): the chip
  // stays until the matching file is on screen, not just while a save is
  // open (a deferred swap, a rebuild behind others, a reopened job).
  const previewStale = mode !== "proxy" && !previewMatches(videoSegments, editSegs);

  // Preview behind with nothing of ours on the wire — reopened while the
  // last saves were still rendering, or a rebuild queued on the server:
  // follow the server's rebuilds (intermediate ones too) until its
  // preview is the stored timeline. Proxy mode plays the edit itself.
  const busy = editSaving;
  useEffect(() => {
    if (mode === "proxy" || !previewStale || busy || previewError) return;
    let tries = 0;
    let live = true;
    let id: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      id = null;
      if (!live || closedRef.current) return;
      if (++tries > 150) {
        // ~5 min without the rebuild catching up: say so (Retry rebuilds)
        setPreviewError(true);
        return;
      }
      try {
        const r = await apiFetch(`/jobs/${jobId}`, { cache: "no-store" });
        if (r.ok && live) {
          const j: JobStatus & { edit_segments?: TimelineSeg[] } = await r.json();
          if (!live) return;
          if (j.preview_segments && (j.preview_version ?? 0) > shownVersionRef.current) {
            applyPreview(j.preview_segments, j.preview_version ?? shownVersionRef.current + 1);
          }
          // caught up with the stored timeline: nothing more will come
          const caught =
            !!j.preview_segments &&
            !!j.edit_segments &&
            sameTimeline(
              j.preview_segments.map(([a, b]) => ({ start: a, end: b })),
              j.edit_segments.map((x) => ({ start: x.start, end: x.end })),
              duration,
            );
          if (caught) return;
        }
      } catch {
        /* keep polling */
      }
      if (live) id = setTimeout(poll, tries < 30 ? 2000 : 5000);
    };
    id = setTimeout(poll, 2000);
    return () => {
      live = false;
      if (id) clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, previewStale, busy, previewError, jobId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => {
      if (swapWhenPausedRef.current) {
        swapWhenPausedRef.current = false;
        const sw = pendingSwapRef.current;
        pendingSwapRef.current = null;
        if (sw) {
          const old = videoSegmentsRef.current;
          putVideoSegments(sw.segs);
          swapPreviewSrc(sw.version, sw.segs, old);
        }
      }
    };
    // playing on from where the old file is: a seek request is done with
    const onPlay = () => {
      wantSourceRef.current = null;
    };
    v.addEventListener("pause", onPause);
    v.addEventListener("play", onPlay);
    return () => {
      v.removeEventListener("pause", onPause);
      v.removeEventListener("play", onPlay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preview mode, the file older than the edit: playing skips what the
  // edit removed (the old file's parts the edit still plays), so the
  // video never shows footage the timeline says is cut — with no caption
  // and no playhead — while the rebuild runs. At its end it pauses
  // (which swaps the new file in).
  const plan = useMemo(
    () => (mode !== "proxy" && previewStale ? stalePlan(videoSegments, editSegs) : null),
    [mode, previewStale, videoSegments, editSegs],
  );
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !plan) return;
    // every animation frame while playing, on the element's own clock —
    // not on presented frames: a busy phone drops video frames, and a
    // frame-driven check let removed footage play for a third of a second
    let raf = 0;
    const check = () => {
      if (v.paused || v.seeking || swapHoldRef.current !== null) return;
      const to = skipTarget(plan, v.currentTime);
      if (to === "end") v.pause();
      else if (to !== null) v.currentTime = to;
    };
    const tick = () => {
      check();
      raf = v.paused ? 0 : requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (!v.paused) onPlay();
    v.addEventListener("playing", onPlay);
    v.addEventListener("play", onPlay);
    // a hidden tab gets no animation frames
    v.addEventListener("timeupdate", check);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("playing", onPlay);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("timeupdate", check);
    };
  }, [plan]);

  const commitEditSegs = (next: EditorSeg[]) => {
    latestRef.current = next;
    setEditSegs(next);
    pendingRebuildRef.current = next;
    setEditSaving(true);
    // a new edit: a failed preview gets its chances again
    previewRetry.current.n = 0;
    setPreviewError(false);
    scheduleRebuild(800);
  };

  /** Send the timeline on screen again now (after a failed save). */
  const retrySave = () => {
    setSaveError(null);
    pendingRebuildRef.current = editSegs;
    scheduleRebuild(0);
  };

  /** "Preview couldn't update · Retry": ask the server to rebuild it again. */
  const retryPreview = () => {
    setPreviewError(false);
    previewRetry.current.n = 0;
    pendingRebuildRef.current = latestRef.current;
    scheduleRebuild(0);
  };

  /** While a swapped-in preview loads: the time the playhead keeps showing (null: none). */
  const heldTime = useCallback(() => swapHoldRef.current, []);

  // Proxy mode: the player follows the edit list client-side — the
  // timeline shows on the next frame, no preview rebuild involved.
  const playerRef = useRef<EditPlayer | null>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const [playingSegId, setPlayingSegId] = useState<string | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    // Only once the element has its src (the media token may still be
    // loading): loading a src resets the element's rate and position.
    if (mode !== "proxy" || !v || !proxySrc) return;
    const player = new EditPlayer(v, { onSegment: setPlayingSegId, fadeEl: fadeRef.current, seekRampMs });
    player.setPlan(buildPlan(editSegs, duration));
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
      setPlayingSegId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, proxySrc]);
  useEffect(() => {
    playerRef.current?.setPlan(buildPlan(editSegs, duration));
  }, [editSegs, duration]);

  // Source time → time in the playing preview (null if cut out).
  const previewTimeFor = (time: number): number | null =>
    previewTimeOf(time, videoSegments.length ? videoSegments : keptSegments);

  /**
   * A seek the playing preview can't show (footage an edit just revealed,
   * not rebuilt in yet): the nearest moment it has, and the swap to the
   * rebuilt file lands on `time` itself.
   */
  const seekNearest = (time: number) => {
    const v = videoRef.current;
    const src = videoSegments.length ? videoSegments : keptSegments;
    if (!v || !src.length) return;
    let best = 0;
    let bestD = Infinity;
    let acc = 0;
    for (const [s0, e0] of src) {
      const at = Math.min(e0, Math.max(s0, time));
      const d = Math.abs(at - time);
      if (d < bestD) {
        bestD = d;
        best = acc + (at - s0);
      }
      acc += e0 - s0;
    }
    v.currentTime = best;
    wantSourceRef.current = time;
  };

  /** Jump to a transcript line (and play, unless `play` is false). */
  const seekToPhrase = (p: { original_start: number; original_end: number }, play = true) => {
    if (!videoRef.current) return;
    if (mode === "proxy") {
      if (playerRef.current?.seekRange(p.original_start, p.original_end)) {
        if (play) videoRef.current.play().catch(() => {});
      }
      return;
    }
    // A phrase may start inside a removed stretch — jump to its first
    // moment that is still in the cut.
    let time = previewTimeFor(p.original_start);
    if (time === null) {
      const src = videoSegments.length ? videoSegments : keptSegments;
      let acc = 0;
      for (const [s, e] of src) {
        if (s >= p.original_start && s <= p.original_end) {
          time = acc;
          break;
        }
        acc += e - s;
      }
    }
    if (time === null) {
      // not in the playing file (revealed by an edit, rebuild pending)
      if (previewStale) seekNearest(p.original_start);
      return;
    }
    wantSourceRef.current = null;
    videoRef.current.currentTime = time;
    if (play) videoRef.current.play().catch(() => {});
  };

  /** Seek to source time `time` (in clip `segId` when given). */
  const seekOriginal = (time: number, segId?: string) => {
    if (mode === "proxy") {
      playerRef.current?.seek(time, segId);
      return;
    }
    // time comes in on the ORIGINAL timeline; map it through the
    // segments of the preview that is actually playing (an edit
    // may not be rebuilt into it yet).
    const pt = previewTimeFor(time);
    if (pt !== null && videoRef.current) {
      wantSourceRef.current = null;
      videoRef.current.currentTime = pt;
    } else if (previewStale) seekNearest(time);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  };

  /** The proxy can't be played after all (gone, codec): fall back to the
   *  server-built preview. */
  const onVideoError = () => {
    if (modeRef.current === "proxy") setMode("preview");
  };

  // Apply & render: push the user's edited segments (with effects) to the
  // backend before we hit /render — the render reads them from the job.
  // Cancel the pending autosave and wait for one in flight first, so
  // neither can land after this save. Both modes render as soon as the
  // server has STORED the timeline on screen — never after a preview
  // rebuild nobody watches (preview mode sent it again and waited for one
  // or two full re-encodes).
  const apply = async () => {
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    pendingRebuildRef.current = null;
    setApplying(true);
    applyingRef.current = true;
    setApplyError(null);
    const active = toPayload(editSegs);
    let outcome: SaveOutcome = "stored";
    // An autosave on the wire lands first, so it can't overwrite
    // this save; when it already carries this edit, that's it.
    const prev = inflightSaveRef.current;
    const prevOutcome = prev
      ? await saveOutcome(jobId, prev.payload, duration, prev.response, {
          settleOnAnswer: true,
          timeoutMs: 8_000,
        })
      : null;
    if (prev && prevOutcome === "stored") storedRef.current = prev.payload;
    const stored = storedRef.current;
    const covered = !!stored && sameTimeline(stored, active, duration);
    if (active.length > 0 && !covered) {
      const request = apiFetch(editPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: active }),
      });
      outcome = await saveOutcome(jobId, active, duration, request);
      if (outcome === "stored") storedRef.current = active;
    }
    if (outcome !== "stored") {
      // Never render an older cut than the one on screen.
      setApplyError(t("app.errors.saveEditsFailed"));
      pendingRebuildRef.current = editSegs;
      applyingRef.current = false;
      setApplying(false);
      return;
    }
    onApply();
  };

  /** The export ended without leaving the editor (UX11 export sheet: a
   *  failed render, or a retry after one): editing and exporting work
   *  again. */
  const endApply = () => {
    applyingRef.current = false;
    setApplying(false);
  };

  return {
    videoRef,
    fadeRef,
    videoSrc,
    mode,
    onVideoError,
    keptSegments,
    videoSegments,
    toSource,
    editSegs,
    commitEditSegs,
    saveError,
    editSaving,
    retrySave,
    previewStale,
    previewError,
    retryPreview,
    heldTime,
    applying,
    applyError,
    apply,
    endApply,
    playingSegId,
    seekToPhrase,
    seekOriginal,
    togglePlay,
    toggleMute,
  };
}

export type EditSession = ReturnType<typeof useEditSession>;
