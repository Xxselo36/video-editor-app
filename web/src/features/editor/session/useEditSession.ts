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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";
import { apiFetch, isMediaReady, mediaUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import { buildPlan, EditPlayer, probeProxy } from "@/lib/editPlayback";
import { sameTimeline, saveOutcome, type SaveOutcome, type TimelineSeg } from "@/lib/editSave";
import { trackSave } from "@/lib/pendingSaves";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { CutRange, JobStatus, SavedSeg } from "@/features/jobs/types";

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
  // frame). A debounced POST rebuilds the server preview 800ms after
  // the last edit — long enough that rapid trims coalesce into one
  // rebuild, short enough that the user doesn't wait when they stop.
  //
  // The src swap that follows is gated: if the video is currently
  // playing we defer until the next pause. That's what killed the
  // 'flow' before — the browser reloaded mid-playback and jumped
  // back to the start of the clip.
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRebuildRef = useRef<EditorSeg[] | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const swapWhenPausedRef = useRef(false);
  const pendingSwapRef = useRef<{ segs: Segs; version: number } | null>(null);
  // The save on the wire (its request answers only after the preview
  // rebuild), so proxy mode can wait for it to be STORED instead.
  const inflightSaveRef = useRef<{ payload: TimelineSeg[]; response: Promise<Response> } | null>(null);
  const applyingRef = useRef(false);

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

  const swapPreviewSrc = (version: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!isMediaReady()) {
      // No media token yet: the first src, set once it arrives, is this one.
      setWaitingVersion(version);
      return;
    }
    const wasTime = v.currentTime;
    v.src = mediaUrl(jobId, "preview-video", { v: version });
    const restore = () => {
      v.removeEventListener("loadedmetadata", restore);
      try {
        const dur = isFinite(v.duration) ? v.duration : 0;
        v.currentTime = Math.min(wasTime, Math.max(0, dur - 0.1));
      } catch {
        /* ignore */
      }
    };
    v.addEventListener("loadedmetadata", restore, { once: true });
  };

  // Switch the player to a rebuilt preview together with the segment
  // list it was built from (the server's, not ours), so the playhead
  // mapping always matches the file that is playing.
  const applyPreview = (segs: Segs, version: number) => {
    if (modeRef.current === "proxy") {
      // Proxy: nothing to reload. Only remember the newest preview, in
      // case the player falls back to preview mode. (Probing plays the
      // preview until the probe answers, so it swaps like preview.)
      setVideoSegments(segs);
      setWaitingVersion(version);
      return;
    }
    const v = videoRef.current;
    if (v && v.paused) {
      setVideoSegments(segs);
      swapPreviewSrc(version);
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

  // One save at a time, always sending the latest edit (with effects —
  // sending only start/end used to reset speed/volume/fades on every
  // autosave). A failed save stays pending and is retried.
  const doRebuild = async (): Promise<void> => {
    while (inflightRef.current) await inflightRef.current;
    const next = pendingRebuildRef.current;
    if (!next) return;
    pendingRebuildRef.current = null;
    const active = toPayload(next);
    if (active.length === 0) return;
    const run = (async () => {
      setEditSaving(true);
      const request = apiFetch(editPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: active }),
      });
      inflightSaveRef.current = { payload: active, response: request };
      if (modeRef.current === "proxy") {
        // The answer only comes after the preview rebuild, which proxy
        // mode never uses: end "saving" once the edit is stored (unless a
        // newer edit is already waiting). Errors are still handled below.
        void saveOutcome(jobId, active, duration, request).then((o) => {
          if (o === "stored" && !pendingRebuildRef.current && !closedRef.current) {
            setEditSaving(false);
          }
        });
      }
      try {
        const r = await request;
        if ([400, 404, 409, 410].includes(r.status)) {
          // Permanent: retrying can't help.
          setSaveError("failed");
          return;
        }
        if (!r.ok) throw new Error(`save failed (${r.status})`);
        const data: JobStatus & { preview_ok?: boolean } = await r.json();
        setSaveError(null);
        if (data.preview_ok && data.preview_segments && !closedRef.current) {
          applyPreview(data.preview_segments, data.preview_version ?? Date.now());
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
        setEditSaving(false);
      }
    })();
    inflightRef.current = run;
    // Reopening the job waits for this save — in proxy mode only until
    // it is stored, not for the preview rebuild (see flushOnLeave).
    if (modeRef.current !== "proxy") trackSave(jobId, run);
    try {
      await run;
    } finally {
      if (inflightRef.current === run) inflightRef.current = null;
    }
  };

  // Leaving the editor (in-app navigation, tab close, reload) must not
  // drop an edit that is still waiting for its debounce.
  const flushOnLeave = (unloading: boolean) => {
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    const proxy = modeRef.current === "proxy";
    const inflight = inflightSaveRef.current;
    const next = pendingRebuildRef.current;
    pendingRebuildRef.current = null;
    const active = next ? toPayload(next) : [];
    // Only when no newer save goes out now: that one replaces the
    // in-flight timeline on the server, so the in-flight one would never
    // be seen stored and reopening would wait for its rebuild.
    if (proxy && inflight && !unloading && active.length === 0) {
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
      proxy && !unloading
        ? saveOutcome(jobId, active, duration, request, { timeoutMs: 10_000 })
        : request.catch(() => {}),
    );
  };
  useEffect(() => {
    // Re-armed on (re)mount — React dev mode mounts effects twice.
    closedRef.current = false;
    const onHide = () => flushOnLeave(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      closedRef.current = true;
      flushOnLeave(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reopened while the last save's preview was still rendering: the
  // saved edit is newer than the preview we loaded. Poll until the
  // server has the matching preview, then switch to it. (Proxy mode
  // plays the edit itself and never needs it.)
  useEffect(() => {
    if (mode !== "preview") return;
    const key = (xs: Segs) => JSON.stringify(xs.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]));
    const want = key(savedSegments.map((x) => [x.start, x.end]));
    if (!savedSegments.length || key(previewSegments) === want) return;
    let tries = 0;
    const id = setInterval(async () => {
      if (closedRef.current || ++tries > 45) return clearInterval(id);
      try {
        const r = await apiFetch(`/jobs/${jobId}`);
        if (!r.ok) return;
        const j: JobStatus = await r.json();
        if ((j.preview_version ?? 0) > previewVersion && j.preview_segments) {
          clearInterval(id);
          // Only if the user hasn't produced a newer preview meanwhile.
          if (!inflightRef.current && !pendingRebuildRef.current) {
            applyPreview(j.preview_segments, j.preview_version ?? Date.now());
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => {
      if (swapWhenPausedRef.current) {
        swapWhenPausedRef.current = false;
        const sw = pendingSwapRef.current;
        pendingSwapRef.current = null;
        if (sw) {
          setVideoSegments(sw.segs);
          swapPreviewSrc(sw.version);
        }
      }
    };
    v.addEventListener("pause", onPause);
    return () => v.removeEventListener("pause", onPause);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitEditSegs = (next: EditorSeg[]) => {
    setEditSegs(next);
    pendingRebuildRef.current = next;
    scheduleRebuild(800);
  };

  /** Send the timeline on screen again now (after a failed save). */
  const retrySave = () => {
    setSaveError(null);
    pendingRebuildRef.current = editSegs;
    scheduleRebuild(0);
  };

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
    const player = new EditPlayer(v, { onSegment: setPlayingSegId, fadeEl: fadeRef.current });
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
  const previewTimeFor = (time: number): number | null => {
    const src = videoSegments.length ? videoSegments : keptSegments;
    let acc = 0;
    for (const [s, e] of src) {
      if (time >= s && time <= e) return acc + (time - s);
      acc += e - s;
    }
    return null;
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
    if (time === null) return;
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
      videoRef.current.currentTime = pt;
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  /** The proxy can't be played after all (gone, codec): fall back to the
   *  server-built preview. */
  const onVideoError = () => {
    if (modeRef.current === "proxy") setMode("preview");
  };

  // Apply & render: push the user's edited segments (with effects) to the
  // backend before we hit /render — the render reads them from the job.
  // Cancel the pending autosave and wait for one in flight first, so
  // neither can land after this save.
  const apply = async () => {
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }
    pendingRebuildRef.current = null;
    setApplying(true);
    if (modeRef.current === "proxy") {
      // The player already shows this edit, so render as soon as
      // the server has STORED it — not after its preview rebuild.
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
      const covered = prev && prevOutcome === "stored" && sameTimeline(prev.payload, active, duration);
      if (active.length > 0 && !covered) {
        const request = apiFetch(editPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: active }),
        });
        outcome = await saveOutcome(jobId, active, duration, request);
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
      return;
    }
    while (inflightRef.current) await inflightRef.current;
    setApplyError(null);
    try {
      const active = toPayload(editSegs);
      if (active.length > 0) {
        const r = await apiFetch(editPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: active }),
        });
        if (!r.ok) throw new Error(`save failed (${r.status})`);
      }
    } catch {
      // Never render an older cut than the one on screen.
      setApplyError(t("app.errors.saveEditsFailed"));
      pendingRebuildRef.current = editSegs;
      setApplying(false);
      return;
    }
    onApply();
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
    applying,
    applyError,
    apply,
    playingSegId,
    seekToPhrase,
    seekOriginal,
    togglePlay,
  };
}

export type EditSession = ReturnType<typeof useEditSession>;
