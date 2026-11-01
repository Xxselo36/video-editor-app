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
 * - Only a preview that shows the stored timeline plays (jobPoll
 *   previewOutdated), in review and while Fertigstellen runs: while the
 *   server builds it (in review the page's poll asks for it) the frame
 *   is busy and plays nothing of the old cut; the new file comes in once
 *   it is there. A change waits while the video plays: a newer file (or
 *   none) comes in at the next pause or at the end; the file on screen
 *   and the segments its time maps through change together. The length
 *   and the captions follow the stored timeline at once. The build
 *   failed twice (`failed`, useJobPoll), or failed while Fertigstellen
 *   runs (no build then): a note.
 * - The doc is read again once the editor's last saves settled
 *   (`settled`, useJobPoll) and when the stored timeline changes.
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
import { previewOutdated } from "./jobPoll";
import { editSegsOf, isWide, previewCaptions, usePlayback } from "./player";
import s from "./player.module.css";

/** Read-only: no undo steps. */
const NO_EDIT = () => false;
/** The preview file plays the clips back to back: no proxy clip to name. */
const NO_SEG = () => null;
const NO_SEGS: [number, number][] = [];

type Shown = { v: number; segs: [number, number][] };

export default function PreviewVideo({
  job,
  settled,
  failed,
}: {
  job: JobStatus;
  /** useJobPoll's: grows once the editor's last saves settled. */
  settled: number;
  /** useJobPoll's: the preview of the stored timeline couldn't be built. */
  failed: boolean;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = usePlayback(videoRef);
  const optIn = useCaptionsV2();
  const phone = !useIsDesktop();

  // The preview on screen and the segments its time maps through (null:
  // none shows the stored timeline yet); a change waits while it plays.
  const behind = previewOutdated(job);
  // No preview of it to come: given up in review (useJobPoll), or failed
  // while Fertigstellen runs (only a job in review can build one).
  const gaveUp = failed || (job.status !== "awaiting_review" && job.preview_status === "failed");
  const version = job.preview_version ?? 0;
  const current = (): Shown | null => (behind ? null : { v: version, segs: job.preview_segments ?? NO_SEGS });
  const [shown, setShown] = useState(current);
  if ((shown?.v ?? null) !== (behind ? null : version) && !playback.playing) setShown(current());
  const src = useMediaUrl(job.id, "preview-video", { v: shown?.v ?? version });
  const poster = useMediaUrl(job.id, "poster");

  // The doc as stored: read again once the editor's last saves settled
  // and when the stored timeline changes; a failed read keeps the one
  // shown.
  const editRev = job.edit_rev ?? 0;
  const [doc, setDoc] = useState<Fetched | "none" | null>(null);
  useEffect(() => {
    let live = true;
    fetchDoc(job.id).then(
      (res) => {
        if (live) setDoc((cur) => res ?? (cur && cur !== "none" ? cur : "none"));
      },
      () => {
        if (live) setDoc((cur) => cur ?? "none");
      },
    );
    return () => {
      live = false;
    };
  }, [job.id, settled, editRev]);
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
  const segs = shown?.segs ?? NO_SEGS;
  const toSource = useCallback((time: number) => videoToSource(time, "preview", segs, duration), [segs, duration]);

  // Each segment at its clip's speed (useEditSession's preview mode, preview-5).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      const want = Math.min(16, Math.max(0.0625, previewSpeedAt(segs, editSegs, v.currentTime)));
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
  }, [editSegs, segs]);

  return (
    <Player
      videoRef={videoRef}
      playback={playback}
      src={shown ? src : null}
      poster={job.has_poster ? (poster ?? undefined) : undefined}
      wide={isWide(job)}
      kind="preview"
      held={shown ? undefined : gaveUp ? "failed" : "building"}
      overlay={
        store && shown ? (
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
