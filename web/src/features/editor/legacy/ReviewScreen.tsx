"use client";
// The v1 editor (moved from app/app/page.tsx in UX4): player in
// proxy or preview mode, timeline, transcript and captions tabs, the
// autosave with flush-on-leave, and Apply & render.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Pencil, Play, Timer, Type, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, SectionLabel } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Tabs } from "@/components/ui/Tabs";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { apiFetch, isMediaReady, mediaUrl, publicUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import { buildPlan, EditPlayer, probeProxy } from "@/lib/editPlayback";
import { sameTimeline, saveOutcome, type SaveOutcome, type TimelineSeg } from "@/lib/editSave";
import { trackSave } from "@/lib/pendingSaves";
import { PlaybackDebug } from "@/features/editor/debug/PlaybackDebug";
import { fmtTime, fmtTimecode } from "@/features/editor/format";
import { TimelineEditor } from "@/features/editor/timeline/TimelineEditor";
import type { CutRange, JobStatus, SavedSeg } from "@/features/jobs/types";
import { captionLabel } from "@/features/start/presets.legacy";
import type { Phrase, Subtitle } from "./buildPhrases";

// UT1: engine captions over the editor video (flag; its own chunk).
const CAPTIONS_INTERIM = process.env.NEXT_PUBLIC_CAPTIONS_INTERIM === "1";
const InterimOverlay = dynamic(() => import("@/features/captions-ui/InterimOverlay"), { ssr: false });

export function ReviewScreen({
  jobId,
  savedSegments,
  previewSegments,
  previewVersion,
  hasProxy,
  phrases,
  units,
  captionPreset,
  audioWarnings,
  cutRanges,
  duration,
  onChange,
  onApply,
  onBack,
}: {
  jobId: string;
  savedSegments: SavedSeg[];
  previewSegments: [number, number][];
  previewVersion: number;
  /** GET /jobs/{id} has_proxy: true / false, undefined = not reported. */
  hasProxy: boolean | undefined;
  phrases: Phrase[];
  units: { readonly current: Subtitle[] };
  captionPreset: string;
  audioWarnings: string[];
  cutRanges: CutRange[];
  duration: number;
  onChange: (p: Phrase[]) => void;
  onApply: () => void;
  onBack: () => void;
}) {
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
  const [mode, setMode] = useState<"probing" | "proxy" | "preview">(
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
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const phraseRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Poll video.currentTime every animation frame while playing.
  // onTimeUpdate only fires ~4x/sec (browser throttle) which lags the
  // active-phrase highlight visibly behind the spoken word. rAF hits
  // ~60fps so the highlight lands on the syllable.
  // Throttled to ~12 updates/s: every update re-renders the whole
  // editor (timeline, transcript), and 60/s pegged phone CPUs on long
  // videos. 80 ms is still well under a spoken syllable.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId = 0;
    let last = -1;
    const tick = () => {
      if (!video.paused && !video.ended) {
        const t = video.currentTime;
        if (Math.abs(t - last) >= 0.08) {
          last = t;
          setCurrentTime(t);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Video plays the cut-preview (concatenated kept segments), so
  // currentTime lives on the CUT timeline. We map it back to the
  // original timeline for the strip playhead so the cursor lines up
  // with the right original-time position.
  const keptSegments = useMemo<[number, number][]>(() => {
    if (!duration) return [];
    const sorted = [...cutRanges].sort((a, b) => a.start - b.start);
    const kept: [number, number][] = [];
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
  const [videoSegments, setVideoSegments] = useState<[number, number][]>(
    () => previewSegments,
  );
  useEffect(() => {
    if (videoSegments.length === 0 && keptSegments.length > 0) {
      setVideoSegments(keptSegments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptSegments.length]);

  const originalTime = useMemo(() => {
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
  }, [mode, currentTime, videoSegments, keptSegments, duration]);

  // Editable segments — starts from keptSegments and can be trimmed,
  // split, deleted, or reordered by the user in the timeline editor.
  // Changes debounce-POST to /jobs/:id/edit-segments so the preview
  // video rebuilds and the player reflects the new timeline.
  type EditableSeg = {
    id: string;
    start: number;
    end: number;
    disabled?: boolean;
    speed?: number;
    fadeIn?: number;
    fadeOut?: number;
    volume?: number;
  };
  // Seeded from the user's SAVED timeline (earlier visits included);
  // only a job that was never edited falls back to the automatic cuts.
  const [editSegs, setEditSegs] = useState<EditableSeg[]>(() =>
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
  const [saveError, setSaveError] = useState<"retrying" | "failed" | null>(null);
  // Set when the editor unmounts: nothing may re-queue or retry after
  // that — a late retry would overwrite the edit flushed on leave.
  const closedRef = useRef(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "timeline" | "transcript" | "style"
  >("timeline");
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
  const pendingRebuildRef = useRef<EditableSeg[] | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const swapWhenPausedRef = useRef(false);
  const pendingSwapRef = useRef<{ segs: [number, number][]; version: number } | null>(null);
  // The save on the wire (its request answers only after the preview
  // rebuild), so proxy mode can wait for it to be STORED instead.
  const inflightSaveRef = useRef<{ payload: TimelineSeg[]; response: Promise<Response> } | null>(null);
  const applyingRef = useRef(false);

  const editPath = `/jobs/${jobId}/edit-segments`;
  const toPayload = (segs: EditableSeg[]) =>
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
  const applyPreview = (segs: [number, number][], version: number) => {
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
    const key = (xs: [number, number][]) =>
      JSON.stringify(xs.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]));
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

  const commitEditSegs = (next: EditableSeg[]) => {
    setEditSegs(next);
    pendingRebuildRef.current = next;
    scheduleRebuild(800);
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

  // The chip on the video: the playhead's place in the EDIT and the
  // edit's length (the native control bar shows the file's own time —
  // the whole source in proxy mode). Same mapping as the timeline readout.
  const cutClock = (() => {
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
  })();

  // The preview follows the user's edited timeline, so phrases are
  // matched on SOURCE time (original_start / original_end) against the
  // playhead mapped back through the segments of the playing preview.
  useEffect(() => {
    const idx = phrases.findIndex(
      (p) => originalTime >= p.original_start && originalTime <= p.original_end,
    );
    setActiveIdx(idx === -1 ? null : idx);
  }, [originalTime, phrases]);

  // Keep the active phrase visible in the transcript container. Uses
  // getBoundingClientRect (not offsetTop) so it works regardless of
  // the container's positioned ancestor, and always scrolls so the
  // active block sits at ~30% from the top — upcoming lines stay in
  // sight, past lines fall off cleanly.
  useEffect(() => {
    if (activeIdx === null) return;
    if (videoRef.current?.paused) return;
    const container = transcriptScrollRef.current;
    const el = phraseRefs.current[activeIdx];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const relativeTop = (eRect.top - cRect.top) + container.scrollTop;
    const desiredOffset = container.clientHeight * 0.3;
    container.scrollTo({
      top: Math.max(0, relativeTop - desiredOffset),
      behavior: "smooth",
    });
  }, [activeIdx]);

  // The line's text when its field got focus (words_edited on blur).
  const editStartRef = useRef<string | null>(null);
  const updateText = (idx: number, text: string) => {
    const next = phrases.slice();
    next[idx] = { ...next[idx], text };
    onChange(next);
  };
  // Deleting a line is instant, with a few seconds to undo it.
  const [lastRemoved, setLastRemoved] = useState<{ idx: number; phrase: Phrase } | null>(null);
  const removedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remove = (idx: number) => {
    track("words_edited", { action: "line_deleted" });
    setLastRemoved({ idx, phrase: phrases[idx] });
    if (removedTimer.current) clearTimeout(removedTimer.current);
    removedTimer.current = setTimeout(() => setLastRemoved(null), 6000);
    onChange(phrases.filter((_, i) => i !== idx));
  };
  const undoRemove = () => {
    if (!lastRemoved) return;
    track("undo", { area: "transcript" });
    const next = phrases.slice();
    next.splice(Math.min(lastRemoved.idx, next.length), 0, lastRemoved.phrase);
    onChange(next);
    setLastRemoved(null);
  };

  // Source time → time in the playing preview (null if cut out).
  const previewTimeFor = (t: number): number | null => {
    const src = videoSegments.length ? videoSegments : keptSegments;
    let acc = 0;
    for (const [s, e] of src) {
      if (t >= s && t <= e) return acc + (t - s);
      acc += e - s;
    }
    return null;
  };
  const seekToPhrase = (p: Phrase) => {
    if (!videoRef.current) return;
    if (mode === "proxy") {
      if (playerRef.current?.seekRange(p.original_start, p.original_end)) {
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    // A phrase may start inside a removed stretch — jump to its first
    // moment that is still in the cut.
    let t = previewTimeFor(p.original_start);
    if (t === null) {
      const src = videoSegments.length ? videoSegments : keptSegments;
      let acc = 0;
      for (const [s, e] of src) {
        if (s >= p.original_start && s <= p.original_end) {
          t = acc;
          break;
        }
        acc += e - s;
      }
    }
    if (t === null) return;
    videoRef.current.currentTime = t;
    videoRef.current.play().catch(() => {});
  };


  return (
    <div className="flex flex-col gap-3" data-testid="editor" data-editor-root>
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          data-testid="editor-back"
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          <Icon icon={ArrowLeft} /> {t("app.review.backToDashboard")}
        </button>
      </div>

      {audioWarnings.length > 0 && (
        <div className="rounded-xl border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]">
          <div className="mb-1 font-semibold uppercase tracking-wider">
            {t("app.review.audioHeadsUp")}
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {audioWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Server-rendered cut preview — continuous MP4 with all
          enabled segments concatenated, so playback is always smooth
          (no client-side seek hops). Rebuild happens in the background
          via a debounced POST; we swap src only while paused so the
          user never sees a reload mid-playback. */}
      <div className="group relative overflow-hidden rounded-xl bg-[var(--surface-1)]">
        <video
          ref={videoRef}
          src={videoSrc ?? undefined}
          data-playback={mode}
          data-testid="editor-video"
          // The proxy can't be played after all (gone, codec): fall back
          // to the server-built preview.
          onError={() => {
            if (modeRef.current === "proxy") setMode("preview");
          }}
          controls
          // No download (it would be the source or a draft preview, not
          // the export), no speed menu (in proxy mode it would show the
          // clip's effective rate, not the user's speed; EditPlayer still
          // copes with browsers that ignore this), no casting.
          controlsList="nodownload noplaybackrate noremoteplayback"
          playsInline
          // metadata only: don't pull the whole preview over mobile data
          // before the user presses play.
          preload="metadata"
          // Seeks while paused (rAF loop only runs while playing).
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-[var(--surface-0)]"
        />
        {/* Live caption preview: the current transcript line, so the
            user sees their text on the video before rendering. (The
            exact caption style is applied in the final render.) */}
        {CAPTIONS_INTERIM && captionPreset !== "none" && (
          <InterimOverlay
            videoRef={videoRef}
            phrases={phrases}
            units={units}
            captionPreset={captionPreset}
            mode={mode}
            segments={mode === "proxy" ? editSegs.filter((s) => !s.disabled).map((s) => [s.start, s.end] as const) : videoSegments.length ? videoSegments : keptSegments}
            duration={duration}
          />
        )}
        {!CAPTIONS_INTERIM && captionPreset !== "none" && activeIdx !== null && phrases[activeIdx]?.text.trim() && (
          <div
            aria-hidden
            data-testid="caption-overlay"
            className="pointer-events-none absolute inset-x-3 bottom-12 flex justify-center"
          >
            <span
              className="max-w-[90%] rounded-md px-2 py-1 text-center text-base font-extrabold leading-tight sm:text-lg"
              style={{
                color: "#fff",
                background: "rgba(0,0,0,0.35)",
                textShadow: "0 2px 6px rgba(0,0,0,0.9)",
              }}
            >
              {phrases[activeIdx].text}
            </span>
          </div>
        )}
        {/* Clip fades (proxy mode), faded in and out by EditPlayer. Drawn
            over the captions, as the render fades burned-in subtitles
            too. Hidden while the pointer is over the video so the native
            control bar under it stays readable. */}
        {mode === "proxy" && (
          <div
            ref={fadeRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-black opacity-0 group-hover:opacity-0!"
          />
        )}
        {cutClock.total > 0 && (
          <div
            data-testid="editor-cut-time"
            className="pointer-events-none absolute left-3 top-3 rounded-full px-2.5 py-1 font-mono text-[11px] tabular-nums"
            style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
          >
            {fmtTimecode(cutClock.at)} / {fmtTimecode(cutClock.total)}
          </div>
        )}
        <PlaybackDebug videoRef={videoRef} mode={mode} />
        {/* Proxy mode has no preview to update: the edit already plays. */}
        {editSaving && mode !== "proxy" && (
          <div
            data-testid="preview-updating"
            className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold backdrop-blur-md"
            style={{
              background: "rgba(0,0,0,0.55)",
              color: "var(--brand-strong)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {t("app.review.updatingPreview")}
          </div>
        )}
      </div>

      {/* Tab bar — clean 3-way switch for the editor */}
      <Tabs
        tabs={[
          { id: "timeline", label: t("app.review.tabTimeline"), icon: <Icon icon={Timer} size="1em" className="mx-[0.1075em]" /> },
          { id: "transcript", label: t("app.review.tabTranscript"), icon: <Icon icon={Type} size="0.61em" /> },
          { id: "style", label: t("app.review.tabCaptions"), icon: <Icon icon={Pencil} /> },
        ]}
        active={activeTab}
        onChange={setActiveTab}
        testIdPrefix="editor-tab"
      />

      {/* Timeline tab — everything for cut/trim/effects lives here */}
      {/* Stays mounted when another tab is open (just hidden), so undo
          history, zoom and scroll position survive tab switches. */}
      {editSegs.length > 0 && duration > 0 && (
        <div style={{ display: activeTab === "timeline" ? undefined : "none" }}>
        <TimelineEditor
          segments={editSegs}
          duration={duration}
          playhead={originalTime}
          playheadSegId={mode === "proxy" ? playingSegId : null}
          open={activeTab === "timeline"}
          saving={editSaving}
          saveError={saveError}
          onToggleOpen={() => {}}
          onCommit={(next) => void commitEditSegs(next)}
          onSeekOriginal={(time, segId) => {
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
          }}
          getVideoTime={() => originalTime}
          onPlayPauseKey={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) v.play().catch(() => {});
            else v.pause();
          }}
        />
        </div>
      )}

      {/* Transcript tab — phrase-level text editing */}
      {activeTab === "transcript" && lastRemoved && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-body)" }}>{t("app.transcript.lineDeleted")}</span>
          <Button variant="tint" size="sm" onClick={undoRemove} data-testid="transcript-undo">
            <Icon icon={Undo2} /> {t("app.transcript.undo")}
          </Button>
        </div>
      )}
      {activeTab === "transcript" && (
        <Card>
          <div
            className="border-b px-4 pt-3 pb-2"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-1)",
            }}
          >
            <SectionLabel>
              {t(
                phrases.length === 1 ? "app.transcript.headingOne" : "app.transcript.headingOther",
                { count: phrases.length },
              )}
            </SectionLabel>
            <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              {t("app.transcript.hint")}
            </div>
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-3"
          >
            {phrases.length === 0 && (
              <div className="rounded-xl border border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
                {t("app.transcript.empty")}
              </div>
            )}
            {phrases.map((p, i) => {
              const isActive = i === activeIdx;
              const lowConfidence = p.confidence < 0.6;
              let extraClass = "border border-[var(--border)]";
              if (isActive) {
                extraClass =
                  "border border-[var(--brand)] bg-[var(--brand-tint)] " +
                  "ring-2 ring-[var(--brand-hover)]/50 shadow-[0_0_20px_var(--brand-glow)]";
              } else if (lowConfidence) {
                extraClass = "border border-[var(--warn)]/60 bg-[var(--warn)]/[0.04]";
              }
              return (
                <div
                  key={i}
                  ref={(el) => {
                    phraseRefs.current[i] = el;
                  }}
                  onClick={() => seekToPhrase(p)}
                  data-testid="transcript-line"
                  className={`relative cursor-pointer rounded-xl p-3 transition-all ${extraClass}`}
                >
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute -left-1 top-1/2 -translate-y-1/2 h-8 w-1 rounded-full"
                      style={{
                        background: "var(--brand-hover)",
                        boxShadow: "0 0 8px var(--brand-glow)",
                      }}
                    />
                  )}
                  <div className="mb-1.5 flex items-center justify-between">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        seekToPhrase(p);
                      }}
                      data-testid="transcript-seek"
                      className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    >
                      <Icon icon={Play} size="0.5em" className="fill-current" /> {fmtTime(p.original_start)}
                    </button>
                    <div className="flex items-center gap-2">
                      {lowConfidence && (
                        <span className="text-[9px] uppercase tracking-wider text-[var(--warn)]">
                          {t("app.transcript.verify")}
                        </span>
                      )}
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(i);
                        }}
                        className="-m-2 flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-faint)] hover:text-[var(--danger)]"
                        label={t("app.transcript.deleteSentence")}
                        title={t("app.transcript.deleteSentence")}
                      >
                        <Icon icon={X} />
                      </IconButton>
                    </div>
                  </div>
                  <textarea
                    value={p.text}
                    // Analytics: one words_edited per line edit (focus → blur).
                    onFocus={() => {
                      editStartRef.current = p.text;
                    }}
                    onBlur={() => {
                      if (editStartRef.current !== null && editStartRef.current !== p.text) {
                        track("words_edited", { action: "text" });
                      }
                      editStartRef.current = null;
                    }}
                    onChange={(e) => updateText(i, e.target.value)}
                    rows={Math.min(4, Math.max(1, Math.ceil(p.text.length / 38)))}
                    className="w-full resize-none bg-transparent text-base leading-snug text-[var(--text-strong)] focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Captions tab — style picker */}
      {activeTab === "style" && (
        <Card className="p-4">
          <SectionLabel className="mb-3">
            {t("app.captions.styleHeading", { style: captionPreset })}
          </SectionLabel>
          {captionPreset !== "none" ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3"
              style={{ background: "var(--surface-0)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(`/caption-previews/${captionPreset}.png?w=240&h=90`)}
                alt={t("app.configure.captionPreviewAlt", { style: captionPreset })}
                className="h-14 w-40 rounded-md object-cover"
              />
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {t("app.captions.appliedToOutput")}
                </div>
                <div className="text-sm font-medium capitalize">{captionLabel(captionPreset, t)}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">
              {t("app.captions.disabled")}
            </div>
          )}
        </Card>
      )}

      <Button
        size="lg"
        onClick={async () => {
          // Push the user's edited segments (with effects) to the
          // backend before we hit /render — the render reads them from
          // the job. Cancel the pending autosave and wait for one in
          // flight first, so neither can land after this save.
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
            const covered =
              prev && prevOutcome === "stored" && sameTimeline(prev.payload, active, duration);
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
        }}
        // Only the render itself blocks the button — autosaves no
        // longer flip it to "Preparing…" every few seconds.
        disabled={applying}
        data-testid="apply-render"
        className="mt-1 w-full"
      >
        {applying ? t("app.review.preparing") : t("app.review.applyRender")}
      </Button>
      {applyError && (
        <div className="text-center text-xs" style={{ color: "var(--danger)" }} data-testid="apply-error">
          {applyError}
        </div>
      )}
    </div>
  );
}
