"use client";
/**
 * The Vorschau's video before the export (PR2, plan D13; mockup
 * docs/mockups/start/4-vorschau): the server's cut of the stored
 * timeline (GET /preview-video?v=, no captions) in the Vorschau's player
 * (ExportedVideo.tsx), with the export's captions drawn over it by the
 * editor's caption layer, read-only: what Fertigstellen renders.
 *
 * - Captions (player.ts previewCaptions): the doc as the editor shows it
 *   (docFetch withRenderStyle), its words mapped through the stored
 *   clips (edit_segments) as in the editor's preview mode. A project on
 *   the v1 engine, or without a doc, says under the frame that its
 *   captions come with the export.
 * - Each segment plays at its clip's speed, as in the editor (the file
 *   has the clips' volume and fades, not their speed).
 * - A newer preview (preview_version, from the page's poll) comes in
 *   while the video doesn't play; the file on screen and the segments
 *   its time maps through change together.
 *
 * It comes in the Vorschau's chunk (PreviewScreen, loaded with
 * next/dynamic): the caption layer, the doc store and the caption engine
 * stay out of the route's first load.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import { useIsDesktop } from "@/lib/useIsDesktop";
import CaptionLayer from "@/features/captions-ui/CaptionLayer";
import { useCaptionsV2 } from "@/features/captions-ui/flag";
import { videoToSource } from "@/features/captions-ui/interim";
import { previewSpeedAt } from "@/features/editor/session/previewSync";
import { fetchDoc, withRenderStyle, type Fetched } from "@/features/editor/state/docFetch";
import { createDocStore } from "@/features/editor/state/store";
import { removedOf } from "@/features/editor/v2/useCuts";
import type { JobStatus, SavedSeg } from "@/features/jobs/types";
import { Player } from "./ExportedVideo";
import { editSegsOf, previewCaptions, usePlayback } from "./player";
import s from "./player.module.css";

/** Read-only: no undo steps. */
const NO_EDIT = () => false;
/** The preview file plays the clips back to back: no proxy clip to name. */
const NO_SEG = () => null;

export default function PreviewVideo({ job }: { job: JobStatus }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = usePlayback(videoRef);
  const optIn = useCaptionsV2();
  const phone = !useIsDesktop();

  // The preview on screen and the segments its time maps through; a
  // newer version waits while the video plays.
  const version = job.preview_version ?? 0;
  const [shown, setShown] = useState(() => ({ v: version, segs: job.preview_segments ?? [] }));
  if (shown.v !== version && !playback.playing) setShown({ v: version, segs: job.preview_segments ?? [] });
  const src = useMediaUrl(job.id, "preview-video", { v: shown.v });
  const poster = useMediaUrl(job.id, "poster");

  const [doc, setDoc] = useState<Fetched | "none" | null>(null);
  useEffect(() => {
    let live = true;
    void fetchDoc(job.id)
      .catch(() => null)
      .then((res) => {
        if (live) setDoc(res ?? "none");
      });
    return () => {
      live = false;
    };
  }, [job.id]);
  const captions = previewCaptions(doc, optIn, !!job.captions_off);
  // The doc with the style an export draws now, for the caption layer.
  const store = useMemo(
    () =>
      captions === "live" && doc && doc !== "none" ? createDocStore(withRenderStyle(doc.doc, doc.renderStyle)) : null,
    [captions, doc],
  );

  // The poll brings a new job every 2 s while it runs: new clips only
  // when they change (the layer pages the captions again on new clips).
  const segsJson = JSON.stringify(job.edit_segments ?? []);
  const editSegs = useMemo(() => editSegsOf(JSON.parse(segsJson) as SavedSeg[]), [segsJson]);
  const duration = job.duration ?? 0;
  const removed = useMemo(() => removedOf(editSegs, duration), [editSegs, duration]);
  const toSource = useCallback(
    (time: number) => videoToSource(time, "preview", shown.segs, duration),
    [shown.segs, duration],
  );

  // Each segment at its clip's speed (useEditSession's preview mode, preview-5).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      const want = Math.min(16, Math.max(0.0625, previewSpeedAt(shown.segs, editSegs, v.currentTime)));
      if (Math.abs(v.playbackRate - want) > 1e-3) v.playbackRate = want;
    };
    apply();
    if (!editSegs.some((x) => (x.speed ?? 1) !== 1)) return;
    let raf = 0;
    const tick = () => {
      apply();
      raf = v.paused ? 0 : requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (!v.paused) onPlay();
    const events = ["play", "seeked", "loadedmetadata", "timeupdate"] as const;
    for (const e of events) v.addEventListener(e, e === "play" ? onPlay : apply);
    return () => {
      cancelAnimationFrame(raf);
      for (const e of events) v.removeEventListener(e, e === "play" ? onPlay : apply);
    };
  }, [editSegs, shown.segs]);

  return (
    <Player
      videoRef={videoRef}
      playback={playback}
      src={src}
      poster={job.has_poster ? (poster ?? undefined) : undefined}
      wide={job.output_aspect === "16:9"}
      kind="preview"
      overlay={
        store ? (
          <CaptionLayer
            videoRef={videoRef}
            doc={store}
            apply={NO_EDIT}
            editSegs={editSegs}
            toSource={toSource}
            playingSeg={NO_SEG}
            removed={removed}
            phone={phone}
            readOnly
          />
        ) : null
      }
      note={
        captions === "after" ? (
          <p className={s.note} data-testid="preview-captions-after">
            {t("app.preview.captionsAfter")}
          </p>
        ) : null
      }
    />
  );
}
