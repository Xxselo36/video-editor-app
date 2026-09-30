"use client";
/**
 * The stage (UX7): the output-aspect frame (9:16 today) as large as the
 * stage allows — desktop ≈ 338×600 at 1440×900, the phone a fixed
 * 186×330 (owner decision, round 3) — with the player bar under it.
 * The picture is letterboxed ("contain") inside the frame, as the export
 * pads a video that isn't reframed. TODO(UX6/UT3): "cover" for SmartCam
 * jobs once GET /jobs reports the output format (model.ts videoBox).
 */
import { Minimize, TriangleAlert, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/i18n";
import { usePlayhead, type PlayheadState } from "@/features/editor/state/playhead";
import { fitFrame, phoneFrame, PHONE_FRAME_MAX } from "../model";
import { PlayerBar } from "./PlayerBar";
import { useFullscreen } from "./useFullscreen";
import { VideoLayer, type CaptionSlotProps } from "./VideoLayer";
import s from "../editor.module.css";

const ASPECT = 9 / 16;
const selPaused = (st: PlayheadState) => !st.playing;

export function PreviewStage({
  phone,
  sheetOpen,
  offline,
  warnings = [],
  phoneExtra,
  fullscreenRef,
  ...slot
}: CaptionSlotProps & {
  phone: boolean;
  sheetOpen: boolean;
  offline: boolean;
  /** Audio heads-up from the analysis (English sentences today; UX5 codes). */
  warnings?: string[];
  /** Phone player row: undo / redo. */
  phoneExtra?: ReactNode;
  /** Receives the fullscreen toggle (for the F shortcut). */
  fullscreenRef?: { current: (() => void) | null };
}) {
  const t = useT();
  const { session, store } = slot;
  const stageRef = useRef<HTMLElement>(null);
  const fsRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<{ w: number; h: number }>(phone ? PHONE_FRAME_MAX : { w: 338, h: 600 });
  const fs = useFullscreen(fsRef);
  const paused = usePlayhead(store, selPaused);
  const [warningsClosed, setWarningsClosed] = useState(false);

  useEffect(() => {
    if (fullscreenRef) fullscreenRef.current = fs.toggle;
  }, [fullscreenRef, fs.toggle]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const root = el.closest<HTMLElement>("[data-editor-root]");
    const measure = () => {
      if (phone) {
        // 186×330, smaller on short screens (the stage row is as tall as
        // the preview: the dock keeps its minimum, the tab bar fits).
        const H = root?.clientHeight || window.innerHeight;
        const W = root?.clientWidth || window.innerWidth;
        const landscape = root?.dataset.layout === "landscape";
        const tabH = root?.querySelector<HTMLElement>("[data-testid=ed-tabbar]")?.offsetHeight || (landscape ? 48 : 56);
        const f = phoneFrame(W, H, { landscape, sheetOpen, tabH });
        setFrame((old) => (old.w === f.w && old.h === f.h ? old : f));
        // Landscape sheets open over the dock column, right of the stage.
        root?.style.setProperty("--ed-stage-w", `${el.offsetWidth}px`);
        return;
      }
      // Player bar 32 + gap 16 under the frame, ≥ 20 px air around.
      const f = fitFrame(el.clientWidth - 48, el.clientHeight - 48 - 40, ASPECT);
      setFrame((old) => (old.w === f.w && old.h === f.h ? old : f));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (root && phone) ro.observe(root);
    return () => ro.disconnect();
  }, [phone, sheetOpen]);

  return (
    <section ref={stageRef} className={s.stage} aria-label={t("editor.preview")} data-testid="ed-stage">
      {!offline && !warningsClosed && warnings.length > 0 && (
        <div className={s.banner} role="status" data-testid="ed-audio-warning">
          <TriangleAlert size={16} strokeWidth={1.75} className={s.bannerIcon} aria-hidden />
          <span style={{ flex: 1 }}>{warnings.join(" ")}</span>
          <button
            type="button"
            className={`${s.gb} ${s.sm}`}
            aria-label={t("editor.close")}
            onClick={() => setWarningsClosed(true)}
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}
      {offline && (
        <div className={s.banner} role="status" data-testid="ed-offline">
          <WifiOff size={16} strokeWidth={1.75} className={s.bannerIcon} aria-hidden />
          <span>{t("editor.offline")}</span>
        </div>
      )}
      <div
        ref={fsRef}
        tabIndex={-1}
        className={`${s.fsWrap} ${fs.pseudo ? s.pseudoFs : ""}`}
        data-fullscreen={fs.real ? "real" : fs.pseudo ? "pseudo" : ""}
        data-testid="ed-fullscreen-wrap"
      >
        <div
          className={s.frame}
          style={{ width: frame.w, height: frame.h }}
          data-testid="ed-frame"
          data-tour="preview"
        >
          <VideoLayer {...slot} tapToPlay={phone && sheetOpen && !fs.active} paused={paused} />
          <div className={s.frameRing} aria-hidden />
        </div>
        {fs.active && (
          <button
            type="button"
            className={`${s.gb} ${s.fsExit}`}
            aria-label={t("editor.exitFullscreen")}
            title={t("editor.exitFullscreen")}
            onClick={fs.toggle}
          >
            <Minimize size={20} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      {!(phone && sheetOpen) && (
        <PlayerBar
          store={store}
          phone={phone}
          width={frame.w}
          editSegs={session.editSegs}
          toSource={session.toSource}
          playingSegId={session.playingSegId}
          mode={session.mode}
          onTogglePlay={session.togglePlay}
          onToggleMute={session.toggleMute}
          onFullscreen={fs.toggle}
          extra={phone ? phoneExtra : undefined}
        />
      )}
    </section>
  );
}
