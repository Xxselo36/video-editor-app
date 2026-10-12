"use client";
/**
 * Format: "Vertical, even if you filmed wide." One cause and one effect on
 * the same recording, shown twice side by side: in the 16:9 source the
 * creator steps to the side (the cause, filmed movement) and the 9:16
 * crop window follows their face (the effect); next to it, the 9:16
 * result that window produces. The result's camera moves by exactly what
 * the window moves, so the two frames can never disagree.
 *
 * One pass (~3.4 s) once the result frame is mostly in view (and the
 * source with it) in a visible tab. It is re-armed when the figure is
 * fully out of view (so it plays again on re-entry) and replayed by the
 * Replay button. Every moving part takes its keyframes from
 * `reframeScore` (WAAPI on translate and opacity). The base CSS is the
 * settled end state, so reduced motion, screenshots and a page without JS
 * show the result.
 *
 * The crop is a tracking camera: its path is the creator's own move,
 * 200 ms later (a delayed copy of a monotonic move can never get ahead of
 * it). In the result the creator drifts a little in the direction they
 * walk and settles back to centre, with no catch-up whip. The window and
 * the result's camera are the reframe's virtual camera, so they move on
 * the filmed curve: motion inside a video frame is video content.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CREATOR_X, CROP_W, Scene } from "../scene/Scene";
import { useReducedMotion } from "../shared";
import styles from "../Landing.module.css";
import f from "./Format.module.css";

/** The brand curve: every UI enter, exit and on-screen travel. */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Movement inside the video: the filmed person and the reframe's
 *  virtual camera (video content, not UI). */
const FILMED = "cubic-bezier(0.37, 0, 0.63, 1)";
/** The tracking lag: the camera follows 200 ms behind the creator. */
const LAG = 200;
/** How far the creator steps right, in % of the shot's width. */
const MOVE = 9;
/** The dimming outside the crop: during the pass, then settled. */
const DIM_FROM = 68;
const DIM_TO = 85;

type ReframePart = "creator" | "resultCreator" | "lens" | "camera" | "dim";
type ReframeCue = {
  at: number;
  ms: number;
  easing: string;
  prop: "translate" | "opacity";
  /** Each part's [start, settled] value; settled = the base CSS. */
  parts: Partial<Record<ReframePart, readonly [string | number, string | number]>>;
};

/** The pass. One table, so the window, the dimming and the result's
 *  camera never drift apart. */
const reframeScore: { ms: number; cues: readonly ReframeCue[] } = {
  ms: 3400,
  cues: [
    // The cause: the creator steps right (filmed, in both frames).
    {
      at: 300,
      ms: 1300,
      easing: FILMED,
      prop: "translate",
      parts: { creator: ["0 0", `${MOVE}% 0`], resultCreator: ["0 0", `${MOVE}% 0`] },
    },
    // The effect: the crop tracks them, on their own path LAG later. The
    // window and the result's camera (which moves the other way: the shot
    // slides under the crop).
    {
      at: 300 + LAG,
      ms: 1300,
      easing: FILMED,
      prop: "translate",
      parts: { lens: ["0 0", `${MOVE}% 0`], camera: ["0 0", `${-MOVE}% 0`] },
    },
    // Locked on: the outside settles darker.
    { at: 1900, ms: 300, easing: EASE, prop: "opacity", parts: { dim: [DIM_FROM / DIM_TO, 1] } },
  ],
};

/** The score's animations, paused on its first frame (armed). */
function armScore(els: Record<ReframePart, HTMLElement | null>): Animation[] {
  const out: Animation[] = [];
  for (const cue of reframeScore.cues) {
    for (const [part, values] of Object.entries(cue.parts) as [ReframePart, readonly [string | number, string | number]][]) {
      const el = els[part];
      if (!el) continue;
      const a = el.animate([{ [cue.prop]: values[0] }, { [cue.prop]: values[1] }], {
        delay: cue.at,
        duration: cue.ms,
        easing: cue.easing,
        fill: "backwards",
      });
      a.pause();
      a.currentTime = 0;
      out.push(a);
    }
  }
  return out;
}

/** The pass starts once the effect is on screen: most of the 9:16 result
 *  and, with it, a good part of the source (phones stack them, so the
 *  source alone in view is not enough). */
const RES_SHOWN = 0.6;
const SRC_SHOWN = 0.35;

export function ReframeSection() {
  const t = useT();
  const reduced = useReducedMotion();
  const figRef = useRef<HTMLDivElement>(null);
  const srcRef = useRef<HTMLDivElement>(null);
  const resRef = useRef<HTMLDivElement>(null);
  const creatorRef = useRef<HTMLDivElement>(null);
  const resultCreatorRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const fig = figRef.current;
    const src = srcRef.current;
    const res = resRef.current;
    if (reduced || !fig || !src || !res || typeof fig.animate !== "function" || typeof IntersectionObserver === "undefined") {
      return;
    }
    const els: Record<ReframePart, HTMLElement | null> = {
      creator: creatorRef.current,
      resultCreator: resultCreatorRef.current,
      lens: lensRef.current,
      camera: cameraRef.current,
      dim: dimRef.current,
    };
    let anims: Animation[] = [];
    let started = false;
    let timer = 0;
    const ratio = new Map<Element, number>();
    const shown = () => (ratio.get(res) ?? 0) >= RES_SHOWN - 0.01 && (ratio.get(src) ?? 0) >= SRC_SHOWN - 0.01;
    const arm = () => {
      window.clearTimeout(timer);
      anims.forEach((a) => a.cancel());
      anims = armScore(els);
      started = false;
    };
    const play = () => {
      if (started || document.hidden) return;
      started = true;
      anims.forEach((a) => a.play());
      timer = window.setTimeout(() => setDone(true), reframeScore.ms);
    };
    arm();
    // Fully out of view: back to the first frame for the next entry (the
    // button stays while it has focus).
    const away = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1].isIntersecting || !started) return;
      arm();
      if (!fig.contains(document.activeElement)) setDone(false);
    });
    away.observe(fig);
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratio.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
        if (shown()) play();
      },
      { threshold: [0, SRC_SHOWN, RES_SHOWN, 1] },
    );
    near.observe(src);
    near.observe(res);
    const onVisibility = () => {
      if (shown()) play();
    };
    document.addEventListener("visibilitychange", onVisibility);
    replayRef.current = () => {
      arm();
      play();
    };
    return () => {
      away.disconnect();
      near.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
      anims.forEach((a) => a.cancel());
      replayRef.current = null;
    };
  }, [reduced]);

  const figStyle = {
    "--rf-move": `${MOVE}%`,
    "--rf-dim": `${DIM_TO}%`,
    "--rf-crop-x": `${(CREATOR_X - CROP_W / 2) * 100}%`,
    "--rf-crop-w": `${CROP_W * 100}%`,
  } as React.CSSProperties;

  return (
    <section className={styles.section} aria-labelledby="reframe-title">
      <div className={cx(styles.wrap, f.reframe)}>
        <div>
          <h2 id="reframe-title" className={styles.h2}>
            {t("site.format.title")}
          </h2>
          <p className={styles.body}>{t("site.format.body")}</p>
        </div>
        <div className={f.rfBox}>
          <div ref={figRef} className={f.rf} style={figStyle}>
            <div className={f.rfCol}>
              <div className={f.srcWrap}>
                <div ref={srcRef} className={f.src} aria-hidden="true">
                  <Scene crop="wide" className={f.srcScene} creatorRef={creatorRef} />
                  <div ref={lensRef} className={f.lens}>
                    <div ref={dimRef} className={f.dim} />
                    <div className={f.window} />
                  </div>
                  <span className={cx(styles.frameTag, f.srcTag)}>{t("site.demo.example")}</span>
                </div>
                {!reduced && (
                  <IconButton
                    label={t("site.demo.replay")}
                    className={f.replay}
                    data-shown={done}
                    onClick={() => replayRef.current?.()}
                  >
                    <Icon icon={RotateCcw} size={16} />
                  </IconButton>
                )}
              </div>
              <span className={f.ratio} aria-hidden="true">
                16:9
              </span>
            </div>
            <span className={f.rfArrow} aria-hidden="true">
              <Icon icon={ArrowRight} size="1.25rem" className={f.arrowWide} />
              <Icon icon={ArrowDown} size="1.25rem" className={f.arrowTall} />
            </span>
            <div className={f.rfCol}>
              <div ref={resRef} className={f.res} aria-hidden="true">
                <Scene crop="vertical" className={f.resScene} cameraRef={cameraRef} creatorRef={resultCreatorRef} />
              </div>
              <span className={f.ratio} aria-hidden="true">
                9:16
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
