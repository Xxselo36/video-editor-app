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
 *
 * Round 2 (S1–S6 continued):
 *   - the autosave is timelineSave.ts: the revision rule (another tab or
 *     device is never overwritten: onConflict reloads), one save on the
 *     wire, "Saved" only for the newest state, the unacknowledged state
 *     kept on the device and offered on the next open (unsaved.ts);
 *   - a backend that rebuilds the preview in the background answers with
 *     preview_status: the player follows GET /jobs/{id} to the new file,
 *     POST /jobs/{id}/preview asks again after a failure;
 *   - preview mode applies only the clips' speed (the server bakes volume
 *     and fades), per preview segment; a skip in a stale file lands a
 *     frame into the next part (the frame shown is one the edit plays);
 *   - scrubTo shows a trim edge while it is dragged (drag-9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";
import { apiFetch, isMediaReady, mediaUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import { buildPlan, EditPlayer, probeProxy } from "@/lib/editPlayback";
import { sameTimeline, type TimelineSeg } from "@/lib/editSave";
import { trackSave } from "@/lib/pendingSaves";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { CutRange, JobStatus, SavedSeg } from "@/features/jobs/types";
import { JOIN_S, landOf, previewMatches, previewSpeedAt, previewTimeOf, skipTarget, stalePlan, swapTime } from "./previewSync";
import { TimelineSaver, type TimelineAnswer, type TimelineSaveState } from "./timelineSave";
import { decideUnsaved, readUnsaved, writeUnsaved, type UnsavedDecision } from "./unsaved";

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
  /** GET /jobs/{id} edit_rev: the timeline's revision on the server (F3). */
  editRev?: number;
  /** The video's frame rate (a skip in a stale preview lands a frame in, F11). */
  fps?: number | null;
  /**
   * Another tab or device saved the timeline (409 stale_rev): the server's
   * timeline is on screen again (the local change dropped); the editor
   * reloads the doc too and says so.
   */
  onConflict?: () => void;
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
  for (let i = 0; i < src.length; i++) {
    const [s, e] = src[i];
    const segDur = e - s;
    // a join is the next segment's first frame (previewSync JOIN_S, F11)
    if (currentTime < acc + segDur - (i + 1 < src.length ? JOIN_S : -1e-9)) return s + Math.max(0, currentTime - acc);
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
  editRev = 0,
  onConflict,
  fps,
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
  // Set when the editor unmounts: no UI state after that (the autosave
  // finishes what is pending on its own, timelineSave close()).
  const closedRef = useRef(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
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
  // frame). The timeline autosave (timelineSave.ts) stores it 800 ms after
  // the last edit, one save on the wire at a time, the newest state next,
  // with the revision rule (409: another tab or device saved). In preview
  // mode the server rebuilds the cut preview from each save (in its answer,
  // or in the background: followed below) and the player swaps it in.
  //
  // The src swap that follows is gated: if the video is currently
  // playing we defer until the next pause. That's what killed the
  // 'flow' before — the browser reloaded mid-playback and jumped
  // back to the start of the clip. Until then playing skips what the
  // edit removed (stalePlan below).
  const swapWhenPausedRef = useRef(false);
  const pendingSwapRef = useRef<{ segs: Segs; version: number } | null>(null);
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

  // ── the timeline autosave (timelineSave.ts) ──────────────────────────
  const [saveState, setSaveState] = useState<TimelineSaveState>("saved");
  const saverRef = useRef<TimelineSaver | null>(null);
  const answerRef = useRef<(d: TimelineAnswer) => void>(() => {});
  const conflictRef = useRef<() => void>(() => {});
  // What this device left unsaved on its last visit (save-11), decided
  // against the timeline the server has now; offered by the editor.
  const [unsaved] = useState<UnsavedDecision>(() => {
    const d = decideUnsaved(readUnsaved(jobId), { rev: editRev, segments: savedSegments }, duration);
    if (d.kind === "none") writeUnsaved(jobId, null);
    return d;
  });
  const makeSaver = () =>
    new TimelineSaver(editRev, savedSegments.length ? (savedSegments as TimelineSeg[]) : null, {
      jobId,
      duration,
      fetch: apiFetch,
      known: unsaved.kind === "none" ? [] : unsaved.known,
      onState: setSaveState,
      onAnswer: (d) => answerRef.current(d),
      onConflict: () => conflictRef.current(),
      track: (p) => trackSave(jobId, p),
      backup: (b) => writeUnsaved(jobId, b),
    });
  /** The autosave of this mount (a new one after a remount: React dev mode). */
  const getSaver = () => (saverRef.current ??= makeSaver());

  // A backend that builds the preview in the background (its answers
  // carry preview_status): a rebuild is asked for with POST
  // /jobs/{id}/preview; one from before: by saving the timeline again.
  const statusApiRef = useRef(false);
  const requestRebuild = () => {
    if (statusApiRef.current) {
      void apiFetch(`/jobs/${jobId}/preview`, { method: "POST" }).catch(() => undefined);
    } else getSaver().resend();
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
      if (closedRef.current) return;
      setPreviewError(false);
      requestRebuild();
    }, delay);
  };
  const onAnswer = (data: TimelineAnswer) => {
    if (closedRef.current) return;
    if (data.preview_ok && data.preview_segments) {
      applyPreview(data.preview_segments, data.preview_version ?? shownVersionRef.current + 1);
      return;
    }
    if (data.preview_status) {
      // answered once stored: the rebuild runs in the background and the
      // follow-up below (GET /jobs/{id}) swaps it in when it is there
      statusApiRef.current = true;
      if (data.preview_status === "failed" && !data.superseded && modeRef.current !== "proxy") previewFailed();
      return;
    }
    if (!data.superseded && modeRef.current !== "proxy") {
      // stored, but the server couldn't rebuild the preview from it
      previewFailed();
    }
  };
  // 409 stale_rev: another tab or device saved. Nothing of ours went over
  // it; the server's timeline comes on screen (the editor says so).
  const onTimelineConflict = () => {
    void (async () => {
      try {
        const r = await apiFetch(`/jobs/${jobId}`, { cache: "no-store" });
        if (!r.ok || closedRef.current) return;
        const j: JobStatus & { edit_rev?: number } = await r.json();
        const segs = (j.edit_segments ?? []).map((x, i) => ({
          id: `seg-${i}-${x.start.toFixed(3)}`,
          start: x.start,
          end: x.end,
          speed: x.speed,
          fadeIn: x.fadeIn,
          fadeOut: x.fadeOut,
          volume: x.volume,
        }));
        getSaver().reset(typeof j.edit_rev === "number" ? j.edit_rev : 0, (j.edit_segments ?? []) as TimelineSeg[]);
        if (segs.length) {
          latestRef.current = segs;
          setEditSegs(segs);
        }
        onConflict?.();
      } catch {
        /* offline: the autosave stays stopped; the conflict state shows */
      }
    })();
  };

  useEffect(() => {
    answerRef.current = onAnswer;
    conflictRef.current = onTimelineConflict;
  });

  useEffect(() => {
    // Re-armed on (re)mount — React dev mode mounts effects twice.
    closedRef.current = false;
    // The page goes away / to the background (iPhone Safari fires no
    // pagehide on an app switch or the lock screen; timers freeze and a
    // hidden tab may be discarded): a pending edit goes NOW, keepalive.
    const onHide = () => getSaver().flushNow(true);
    const onHidden = () => {
      if (document.visibilityState === "hidden") getSaver().flushNow(false);
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
      // Leaving the editor (in-app navigation): the last edit goes now
      // and keeps going after the editor is gone; reopening waits for it.
      const gone = saverRef.current;
      saverRef.current = null;
      if (gone) trackSave(jobId, gone.close());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editSaving = saveState === "saving" || saveState === "retrying";
  const saveError: SaveError = saveState === "retrying" ? "retrying" : saveState === "failed" ? "failed" : null;

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
    let asked = false;
    let id: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      id = null;
      if (!live || closedRef.current) return;
      if (++tries > 200) {
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
          if (j.preview_status) statusApiRef.current = true;
          // the rebuild for the stored timeline failed: say so (Retry asks again)
          if (j.preview_status === "failed") {
            previewFailed();
            return;
          }
          // none on its way (a server restart): ask for it, once
          if (j.preview_status === "stale" && !asked) {
            asked = true;
            requestRebuild();
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
          if (caught && j.preview_status !== "building") return;
        }
      } catch {
        /* keep polling */
      }
      // quick at first (a short rebuild is there in a second or two)
      if (live) id = setTimeout(poll, tries < 10 ? 1000 : tries < 40 ? 2000 : 5000);
    };
    id = setTimeout(poll, 1000);
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
  const land = landOf(fps);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !plan) return;
    // every animation frame while playing, on the element's own clock —
    // not on presented frames: a busy phone drops video frames, and a
    // frame-driven check let removed footage play for a third of a second
    let raf = 0;
    const check = () => {
      if (v.paused || v.seeking || swapHoldRef.current !== null) return;
      const to = skipTarget(plan, v.currentTime, 0.03, land);
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
  }, [plan, land]);

  // Preview mode: the server bakes the clips' volume and fades into the
  // file, not their speed (preview-5) — the player plays each segment at
  // its clip's speed (and applies nothing else on top: no double fade or
  // volume). A rate picked in the native controls (v1) is a master speed.
  const rateRef = useRef({ applied: 1, master: 1 });
  useEffect(() => {
    const v = videoRef.current;
    if (!v || mode === "proxy") return;
    const speedy = editSegs.some((x) => !x.disabled && (x.speed ?? 1) !== 1);
    const st = rateRef.current;
    const apply = () => {
      if (Math.abs(v.playbackRate - st.applied) > 1e-3 && v.readyState > 0) st.master = v.playbackRate || 1;
      const want = Math.min(16, Math.max(0.0625, previewSpeedAt(videoSegments, editSegs, v.currentTime) * st.master));
      st.applied = want;
      if (Math.abs(v.playbackRate - want) > 1e-3) {
        try {
          v.playbackRate = want;
        } catch {
          /* unsupported rate */
        }
      }
    };
    apply();
    if (!speedy && st.master === 1) return;
    let raf = 0;
    const tick = () => {
      apply();
      raf = v.paused ? 0 : requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (!v.paused) onPlay();
    const events = ["play", "playing", "seeked", "loadedmetadata", "timeupdate"] as const;
    events.forEach((ev) => v.addEventListener(ev, ev === "play" || ev === "playing" ? onPlay : apply));
    return () => {
      cancelAnimationFrame(raf);
      events.forEach((ev) => v.removeEventListener(ev, ev === "play" || ev === "playing" ? onPlay : apply));
    };
  }, [mode, videoSegments, editSegs, videoRef]);

  const commitEditSegs = (next: EditorSeg[]) => {
    latestRef.current = next;
    setEditSegs(next);
    getSaver().schedule(next);
    // a new edit: a failed preview gets its chances again
    previewRetry.current.n = 0;
    setPreviewError(false);
  };

  /** Send the timeline on screen again now (after a failed save). */
  const retrySave = () => getSaver().retryNow();

  /** "Preview couldn't update · Retry": ask the server to rebuild it again. */
  const retryPreview = () => {
    setPreviewError(false);
    previewRetry.current.n = 0;
    requestRebuild();
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

  // ── a trim edge on screen while it is dragged (drag-9) ──────────────
  // Proxy: the frame at the edge itself (EditPlayer.scrub, footage the
  // edit cuts too). Preview: the playing file's frame there, or the
  // nearest one it has (it doesn't have footage a trim reveals). Paused;
  // one seek at a time, the newest edge wins.
  const scrubRef = useRef<{ fromSource: number; want: number | null } | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onSeeked = () => {
      const sc = scrubRef.current;
      if (!sc || sc.want === null || modeRef.current === "proxy") return;
      const w = sc.want;
      sc.want = null;
      if (Math.abs(v.currentTime - w) > 1e-4) v.currentTime = w;
    };
    v.addEventListener("seeked", onSeeked);
    return () => v.removeEventListener("seeked", onSeeked);
  }, [videoRef]);
  /** Show source time `t` (a trim edge) now; null ends it — `restore`: back to where the video was (a cancelled trim). */
  const scrubTo = (t: number | null, opts: { restore?: boolean } = {}) => {
    const v = videoRef.current;
    if (!v) return;
    if (t === null) {
      const sc = scrubRef.current;
      scrubRef.current = null;
      if (modeRef.current === "proxy") playerRef.current?.scrub(null);
      if (sc && opts.restore) seekOriginal(sc.fromSource);
      return;
    }
    if (!scrubRef.current) scrubRef.current = { fromSource: toSource(v.currentTime), want: null };
    if (modeRef.current === "proxy") {
      playerRef.current?.scrub(t);
      return;
    }
    if (!v.paused) v.pause();
    const src = videoSegments.length ? videoSegments : keptSegments;
    let at = previewTimeOf(t, src);
    if (at === null) {
      // the nearest moment the playing file has
      let best = 0;
      let bestD = Infinity;
      let acc = 0;
      for (const [s0, e0] of src) {
        const x = Math.min(e0, Math.max(s0, t));
        if (Math.abs(x - t) < bestD) [best, bestD] = [acc + (x - s0), Math.abs(x - t)];
        acc += e0 - s0;
      }
      at = best;
    }
    if (v.seeking) scrubRef.current.want = at;
    else if (Math.abs(v.currentTime - at) > 1e-4) v.currentTime = at;
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

  // Apply & render: the render reads the timeline from the job, so the
  // one on screen goes first. Both modes render as soon as the server has
  // STORED it — never after a preview rebuild nobody watches.
  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    const ok = await getSaver().settle(15_000);
    if (!ok) {
      // Never render an older cut than the one on screen.
      setApplyError(t("app.errors.saveEditsFailed"));
      setApplying(false);
      return;
    }
    onApply();
  };

  /** The export ended without leaving the editor (UX11 export sheet: a
   *  failed render, or a retry after one): editing and exporting work
   *  again. */
  const endApply = () => setApplying(false);

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
    scrubTo,
    togglePlay,
    toggleMute,
    /** What this device left unsaved last time (save-11), for the editor to offer (once). */
    unsaved,
  };
}

export type EditSession = ReturnType<typeof useEditSession>;
