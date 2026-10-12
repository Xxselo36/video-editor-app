"use client";
/**
 * Format: "Vertical, even if you filmed wide." The same take twice, side
 * by side: the 16:9 recording with a 9:16 crop window on it, and the
 * 9:16 result that window produces.
 *
 * The pass: the window starts where a plain centre crop would sit, with
 * his face half outside it (he sits right of centre). Cleo finds the face
 * (a box closes on it), the window glides over to it, and the outside
 * settles darker. The result's camera moves by exactly what the window
 * moves, so the two frames can never disagree. Nothing in the photo moves.
 *
 * One pass (~2.4 s) once the result frame is mostly in view (and the
 * source with it) in a visible tab. It is re-armed when the figure is
 * fully out of view (so it plays again on re-entry) and replayed by the
 * Replay button. Every moving part takes its keyframes from
 * `reframeScore` (WAAPI on translate, scale and opacity). The base CSS is
 * the settled end state, so reduced motion, screenshots and a page
 * without JS show the result.
 *
 * The window and the result's camera are the reframe's virtual camera,
 * so they glide on the filmed curve (motion inside a video frame is video
 * content); the face box is UI and uses the brand curve.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CROP_W, Scene, WIDE } from "../scene/Scene";
import { useReducedMotion } from "../shared";
import styles from "../Landing.module.css";
import f from "./Format.module.css";

/** The brand curve: every UI enter, exit and on-screen travel. */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** The reframe's virtual camera (video content, not UI). */
const FILMED = "cubic-bezier(0.37, 0, 0.63, 1)";
/** From a centre crop to his face, in % of the take's width. */
const MOVE = (WIDE.face.x - 0.5) * 100;
/** The dimming outside the crop: during the pass, then settled. */
const DIM_FROM = 68;
const DIM_TO = 85;

type ReframePart = "face" | "lens" | "camera" | "dim";
type ReframeCue = {
  at: number;
  ms: number;
  easing: string;
  /** Keyframes per part: [start, settled]; settled = the base CSS. */
  parts: Partial<Record<ReframePart, readonly [Keyframe, Keyframe]>>;
};

/** The pass. One table, so the window, the dimming and the result's
 *  camera never drift apart. */
const reframeScore: { ms: number; cues: readonly ReframeCue[] } = {
  ms: 2400,
  cues: [
    // Found: the face box closes on his face.
    {
      at: 250,
      ms: 320,
      easing: EASE,
      parts: { face: [{ opacity: 0, scale: "1.25" }, { opacity: 1, scale: "1" }] },
    },
    // The window glides from the centre crop to the face; the result's
    // camera moves the other way (the take slides under the crop).
    {
      at: 750,
      ms: 1000,
      easing: FILMED,
      parts: {
        lens: [{ translate: `${-MOVE}% 0` }, { translate: "0 0" }],
        camera: [{ translate: `${MOVE}% 0` }, { translate: "0 0" }],
      },
    },
    // Locked on: the outside settles darker.
    { at: 1850, ms: 300, easing: EASE, parts: { dim: [{ opacity: DIM_FROM / DIM_TO }, { opacity: 1 }] } },
  ],
};

/** The score's animations, paused on its first frame (armed). */
function armScore(els: Record<ReframePart, HTMLElement | null>): Animation[] {
  const out: Animation[] = [];
  for (const cue of reframeScore.cues) {
    for (const [part, values] of Object.entries(cue.parts) as [ReframePart, readonly [Keyframe, Keyframe]][]) {
      const el = els[part];
      if (!el) continue;
      const a = el.animate([values[0], values[1]], {
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
  const faceRef = useRef<HTMLSpanElement>(null);
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
      face: faceRef.current,
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

  const { face } = WIDE;
  const figStyle = {
    "--rf-dim": `${DIM_TO}%`,
    "--rf-crop-x": `${(face.x - CROP_W / 2) * 100}%`,
    "--rf-crop-w": `${CROP_W * 100}%`,
    "--rf-face-x": `${(face.x - face.w / 2) * 100}%`,
    "--rf-face-y": `${(face.y - face.h / 2) * 100}%`,
    "--rf-face-w": `${face.w * 100}%`,
    "--rf-face-h": `${face.h * 100}%`,
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
                  <Scene crop="wide" sizes="(min-width: 1024px) 26rem, min(100vw, 34rem)" />
                  <div ref={lensRef} className={f.lens}>
                    <div ref={dimRef} className={f.dim} />
                    <div className={f.window} />
                  </div>
                  <span ref={faceRef} className={f.face} />
                  <span className={styles.frameTag}>{t("site.demo.example")}</span>
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
                <Scene crop="track" sizes="8.5rem" cameraRef={cameraRef} />
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
