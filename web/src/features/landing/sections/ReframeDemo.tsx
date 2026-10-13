"use client";
/**
 * Format: "Vertical, even if you filmed wide." SmartCam as a lift-out:
 * his wide recording (clip "smartcam") lies tilted on a plate like the
 * hero's tape. Cleo locks onto his face and frames a 9:16 window around
 * it; that vertical slice lifts out of the recording, stands up beside it
 * and keeps playing with his face centred, while the window keeps
 * following him on the plate.
 *
 * The pass (5.3 s, once per entry; `smartcamScore`), one beat after
 * another: lock (violet corner brackets close on his face), frame (they
 * travel out to the 9:16 crop), window (its outline fades in, the outside
 * dims), hold (the window follows him), lift (a copy of the window rises
 * off the plate along its normal), stand up (it swings upright on its
 * foot and grows to 1.35x while the plate lies further back: the wide
 * format sinks as the vertical rises; one band of light crosses it),
 * grounded (its shadows), label ("9:16"). Every cue is a WAAPI animation
 * of transform or opacity on the brand curve. The base CSS
 * (Format.module.css) is the settled end pose and equals each cue's last
 * keyframe, so reduced motion, data saver, screenshots and a page without
 * JS show the result as one still: the clip's first frame, the window on
 * his face and the vertical cut at the same x.
 *
 * One decoder: the plate shows the <video> (Scene), and the vertical is a
 * canvas the same element is drawn into on every presented frame
 * (requestVideoFrameCallback), cropped at the face track's x (track.ts:
 * the product's own face model on this clip). The same frame moves the
 * window on the plate, so the two never disagree; at the loop seam both
 * jump on one frame, a cut. Motion inside the frames is video content:
 * nothing there is eased.
 *
 * The pass starts once most of the stage is clear of the sticky chrome
 * (PASS_ROOT_MARGIN, passShare; the share is --rf-pass), the tab is
 * visible and the video has a frame (or after 1 s, over the poster). It
 * re-arms when the figure is fully out of view (unless paused) and
 * replays from the Replay button. Pause stops the clip and any running
 * cue; Play resumes both.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CLIPS, CLIP_DIR } from "../scene/clips";
import { SMARTCAM_TRACK, faceAt } from "../scene/track";
import { CROP_W, Scene, lqipClass } from "../scene/Scene";
import { useClipsMove } from "../scene/useClipPlayback";
import { PASS_ROOT_MARGIN, PASS_THRESHOLDS, passShare } from "../shared";
import styles from "../Landing.module.css";
import f from "./Format.module.css";

/** The brand curve: every cue of the pass. */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** The sheen's sweep: light crossing the turning slice (not UI), even in
 *  and out. */
const SWEEP = "cubic-bezier(0.37, 0, 0.63, 1)";

/** The plate's turn on the table (deg), the hero tape's. */
const ROLL = 1.5;
/** The stood vertical's scale. */
const STAND_SCALE = 1.35;
/** The lifted copy tips toward where it will turn (deg) and rises (% of
 *  its height); how far it lifts is --rf-lift. */
const LIFT_TIP = -6;
const LIFT_RISE = -3;
/** The lift shadow's darkest (during the lift). */
const LIFT_SHADOW = 0.5;
/** The sheen's brightest: a hint of light, never a flash. */
const SHEEN_PEAK = 0.1;
/** The corner brackets: their inset in the window (px, so their strokes
 *  are never clipped), how far out they start (x the face box) and the
 *  face box's height (x its width). */
const BRACKET_INSET = 4;
const LOCK_OUT = 1.3;
const FACE_H = 1.2;
/** How long a pass waits for the video's first frame before it runs
 *  over the poster. */
const FRAME_WAIT_MS = 1000;

/** The pass's beats (ms from its start), strictly one after another. */
const BEAT = {
  lock: { at: 0, ms: 450 },
  frame: { at: 600, ms: 700 },
  window: { at: 1300, ms: 400 },
  // 1700-2300, hold: nothing enters; the window follows him.
  lift: { at: 2300, ms: 800 },
  stand: { at: 3250, ms: 1200 },
  sheen: { at: 3550, ms: 700 },
  ground: { at: 4450, ms: 350 },
  label: { at: 4800, ms: 280 },
} as const;
const PASS_MS = 5300;
/** While it stands up: the lift shadow fades, the copy's white outline
 *  crossfades to the frame's edge. */
const LIFT_SHADOW_FADE = { at: BEAT.stand.at, ms: 600 };
const OUTLINE_FADE = { at: BEAT.stand.at + 400, ms: 800 };
/** When the lift's x is read from the track: just before the copy
 *  appears over the window. */
const LIFT_X_AT = BEAT.lift.at - 100;

/** The 9:16 crop's left edge at clip time `t` (fraction of the 16:9
 *  frame): centred on his face, never past the frame's edges. */
function cropLeft(t: number): number {
  return Math.min(1 - CROP_W, Math.max(0, faceAt(t).x - CROP_W / 2));
}

/** The same, as a translate of a crop-wide box (% of its own width). */
function cropShift(t: number): number {
  return (cropLeft(t) / CROP_W) * 100;
}

/** Constants the CSS shares (Format.module.css, the figure's geometry). */
const FIG_VARS = {
  "--rf-c": String(CROP_W),
  "--rf-scale": String(STAND_SCALE),
  "--rf-roll": `${ROLL}deg`,
  "--rf-x0": `${cropShift(0)}%`,
  "--rf-inset": `${BRACKET_INSET}px`,
} as React.CSSProperties;

/* ── The score ── */

type Part =
  | "tl"
  | "tr"
  | "bl"
  | "br"
  | "window"
  | "dim"
  | "plate"
  | "slice"
  | "sliceShow"
  | "liftShadow"
  | "sheenMove"
  | "sheenGlow"
  | "outline"
  | "frameLine"
  | "shadow"
  | "foot"
  | "label";

/** The element (its data-el) each part animates. Two parts on one
 *  element animate different properties. */
const PART_EL: Record<Part, string> = {
  tl: "tl",
  tr: "tr",
  bl: "bl",
  br: "br",
  window: "window",
  dim: "dim",
  plate: "plate",
  slice: "slice",
  sliceShow: "slice",
  liftShadow: "liftShadow",
  sheenMove: "sheen",
  sheenGlow: "sheen",
  outline: "outline",
  frameLine: "frameLine",
  shadow: "shadow",
  foot: "foot",
  label: "label",
};
const PARTS = Object.keys(PART_EL) as Part[];

type Beat = { at: number; ms: number };
type Seg = Beat & { easing: string; to: Keyframe };
/** One part's motion: its first values and its segments in order (a gap
 *  between two is a hold). One animation per part, so a part's later
 *  cue never fights its earlier one. */
type Track = { from: Keyframe; segs: readonly Seg[] };

/** What the score needs at the pass's start. */
type PassGeo = {
  /** The plate's (and the video's) size, px. */
  w: number;
  h: number;
  /** His face in the window, px from its top-left corner. */
  faceX: number;
  faceY: number;
  /** The window where the copy lifts off (cropShift). */
  xw: number;
  /** Per composition, from Format.module.css. */
  armed: string;
  tilt: string;
  lift: string;
  standX: string;
};

const plateAt = (tilt: string) => `rotateX(${tilt}) rotateZ(${-ROLL}deg)`;

/** The slice's pose. One function list in every keyframe (so no matrix
 *  is ever decomposed): a move in the plate's plane and along its normal,
 *  then rotateZ and rotateX (the order that undoes the plate's), then
 *  the scale. */
const sliceAt = (x: string, y: string, z: string, roll: string, tip: string, scale: number) =>
  `translate3d(${x}, ${y}, ${z}) rotateZ(${roll}) rotateX(${tip}) scale(${scale})`;

function smartcamScore(g: PassGeo): Record<Part, Track> {
  const xw = `${g.xw.toFixed(3)}%`;
  const fadeIn = (beat: Beat): Track => ({ from: { opacity: 0 }, segs: [{ ...beat, easing: EASE, to: { opacity: 1 } }] });

  // A bracket (sx, sy: its corner) sits at the window's corner. It comes
  // in from the face box pushed out, closes on the face box, then travels
  // out to the window's corner. Translate only: its 2px stroke never
  // scales. The window carries it sideways with his face.
  const hw = (SMARTCAM_TRACK.w / 2) * g.w;
  const hh = hw * FACE_H;
  const corner = (sx: -1 | 1, sy: -1 | 1): Track => {
    const bx = sx < 0 ? BRACKET_INSET : CROP_W * g.w - BRACKET_INSET;
    const by = sy < 0 ? BRACKET_INSET : g.h - BRACKET_INSET;
    const at = (k: number) => `${(g.faceX + sx * hw * k - bx).toFixed(1)}px ${(g.faceY + sy * hh * k - by).toFixed(1)}px`;
    return {
      from: { opacity: 0, translate: at(LOCK_OUT) },
      segs: [
        { ...BEAT.lock, easing: EASE, to: { opacity: 1, translate: at(1) } },
        { ...BEAT.frame, easing: EASE, to: { translate: "0px 0px" } },
      ],
    };
  };

  return {
    // Lock, then frame.
    tl: corner(-1, -1),
    tr: corner(1, -1),
    bl: corner(-1, 1),
    br: corner(1, 1),
    // Window: once the brackets have landed.
    window: fadeIn(BEAT.window),
    dim: fadeIn(BEAT.window),
    // Lift: the copy shows at once over the window (the same pixels),
    // then rises along the plate's normal and tips toward its turn. Stand
    // up: it swings upright on its foot, steps to the floor line and
    // grows, while the plate lies further back (same start, duration and
    // curve, so its rotation always mirrors the plate's).
    sliceShow: { from: { opacity: 0 }, segs: [{ at: BEAT.lift.at, ms: 1, easing: "steps(1, start)", to: { opacity: 1 } }] },
    slice: {
      from: { transform: sliceAt(xw, "0%", "2px", "0deg", "0deg", 1) },
      segs: [
        { ...BEAT.lift, easing: EASE, to: { transform: sliceAt(xw, `${LIFT_RISE}%`, g.lift, "0deg", `${LIFT_TIP}deg`, 1) } },
        {
          ...BEAT.stand,
          easing: EASE,
          to: { transform: sliceAt(g.standX, "0%", "2px", `${ROLL}deg`, `calc(${g.tilt} * -1)`, STAND_SCALE) },
        },
      ],
    },
    plate: { from: { transform: plateAt(g.armed) }, segs: [{ ...BEAT.stand, easing: EASE, to: { transform: plateAt(g.tilt) } }] },
    liftShadow: {
      from: { opacity: 0, transform: `translate3d(${xw}, 0%, 1px) scale(0.98)` },
      segs: [
        { ...BEAT.lift, easing: EASE, to: { opacity: LIFT_SHADOW, transform: `translate3d(${xw}, 0%, 1px) scale(1.1)` } },
        { ...LIFT_SHADOW_FADE, easing: EASE, to: { opacity: 0 } },
      ],
    },
    outline: { from: { opacity: 1 }, segs: [{ ...OUTLINE_FADE, easing: EASE, to: { opacity: 0 } }] },
    frameLine: { from: { opacity: 0 }, segs: [{ ...OUTLINE_FADE, easing: EASE, to: { opacity: 1 } }] },
    // Sheen: one band of light while it turns. The move is one sweep;
    // the light rises and falls over it.
    sheenMove: { from: { translate: "-100% 0" }, segs: [{ ...BEAT.sheen, easing: SWEEP, to: { translate: "100% 0" } }] },
    sheenGlow: {
      from: { opacity: 0 },
      segs: [
        { at: BEAT.sheen.at, ms: BEAT.sheen.ms / 2, easing: SWEEP, to: { opacity: SHEEN_PEAK } },
        { at: BEAT.sheen.at + BEAT.sheen.ms / 2, ms: BEAT.sheen.ms / 2, easing: SWEEP, to: { opacity: 0 } },
      ],
    },
    // Grounded: a contact shadow at its foot, its own shadow under it.
    shadow: fadeIn(BEAT.ground),
    foot: { from: { opacity: 0, scale: "0.9" }, segs: [{ ...BEAT.ground, easing: EASE, to: { opacity: 1, scale: "1" } }] },
    // "9:16" rises in under it (phase-fade).
    label: { from: { opacity: 0, translate: "0 8px" }, segs: [{ ...BEAT.label, easing: EASE, to: { opacity: 1, translate: "0 0" } }] },
  };
}

/** A track as one animation's keyframes: offsets from the beats, each
 *  segment's curve on the keyframe that starts it, a hold as two equal
 *  keyframes. Every keyframe carries every property of the part (a
 *  missing one would ease from the base CSS instead). */
function framesOf({ from, segs }: Track): { delay: number; duration: number; frames: Keyframe[] } {
  const first = segs[0];
  const last = segs[segs.length - 1];
  const duration = last.at + last.ms - first.at;
  const offset = (ms: number) => (ms - first.at) / duration;
  const frames: Keyframe[] = [];
  let value: Keyframe = from;
  let end = first.at;
  for (const seg of segs) {
    if (frames.length === 0 || seg.at > end) frames.push({ ...value, offset: offset(seg.at), easing: seg.easing });
    else frames[frames.length - 1].easing = seg.easing;
    value = { ...value, ...seg.to };
    end = seg.at + seg.ms;
    frames.push({ ...value, offset: offset(end), easing: "linear" });
  }
  return { delay: first.at, duration, frames };
}

/** The score's inputs right now: one style and one layout read, at a
 *  pass's start (never per frame). */
function readGeo(fig: HTMLElement, plate: HTMLElement, video: HTMLVideoElement | null): PassGeo {
  const css = getComputedStyle(fig);
  const prop = (name: string) => css.getPropertyValue(name).trim();
  const time = video?.currentTime ?? 0;
  const face = faceAt(time);
  const w = plate.offsetWidth;
  const h = plate.offsetHeight;
  return {
    w,
    h,
    faceX: (face.x - cropLeft(time)) * w,
    faceY: face.y * h,
    xw: cropShift(time),
    armed: prop("--rf-armed"),
    tilt: prop("--rf-tilt"),
    lift: prop("--rf-lift"),
    standX: prop("--rf-stand-x"),
  };
}

/* ── Following his face ── */

/** Drawing: the first frames timed, and what counts as slow (ms). */
const SLOW_SAMPLE = 30;
const SLOW_MS = 8;

/**
 * The window follows his face on the plate and the vertical shows what it
 * frames. On every presented video frame: one track lookup, one transform
 * write (the window) and one drawImage of the crop into the vertical's
 * canvas. The canvas is sized for the stood 1.35x (at most 2x DPR and the
 * source's own pixels) and halved if drawing proves slow. No layout
 * reads, no React. Off screen and paused, the video presents no frames,
 * so this does nothing.
 */
function useFollowFace({
  videoRef,
  trackRef,
  canvasRef,
  plateRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  trackRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  plateRef: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const video = videoRef.current;
    const track = trackRef.current;
    const canvas = canvasRef.current;
    const plate = plateRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !track || !canvas || !plate || !ctx) return;
    // The plate's layout width (ResizeObserver), the canvas's resolution
    // (1, or 0.5 once drawing proved slow), the window's last transform.
    let plateW = 0;
    let res = 1;
    let shift = "";
    let timed = 0;
    let spent = 0;

    function draw(time: number) {
      if (!video || !track || !canvas || !ctx) return;
      const left = cropLeft(time);
      const next = `translateX(${((left / CROP_W) * 100).toFixed(3)}%)`;
      if (next !== shift) {
        track.style.transform = next;
        shift = next;
      }
      if (video.readyState < 2 || !plateW) return;
      const t0 = performance.now();
      const vw = video.videoWidth;
      ctx.drawImage(video, left * vw, 0, CROP_W * vw, video.videoHeight, 0, 0, canvas.width, canvas.height);
      if (timed < SLOW_SAMPLE) {
        spent += performance.now() - t0;
        timed += 1;
        if (timed === SLOW_SAMPLE && spent / SLOW_SAMPLE > SLOW_MS) {
          res = 0.5;
          size();
        }
      }
    }

    function size() {
      if (!video || !canvas || !plateW) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const source = CROP_W * (video.videoWidth || CLIPS.smartcam.w);
      const w = Math.max(1, Math.round(Math.min(plateW * CROP_W * STAND_SCALE * dpr, source) * res));
      const h = Math.round((w * 16) / 9);
      if (canvas.width === w && canvas.height === h) return;
      // Resizing clears it: draw the current frame again.
      canvas.width = w;
      canvas.height = h;
      draw(video.currentTime);
    }

    const redraw = () => {
      size();
      draw(video.currentTime);
    };
    video.addEventListener("loadeddata", redraw);
    video.addEventListener("seeked", redraw);

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === "undefined") {
      plateW = plate.offsetWidth;
      size();
    } else {
      ro = new ResizeObserver((entries) => {
        plateW = entries[entries.length - 1].contentRect.width;
        size();
      });
      ro.observe(plate);
    }

    // Every presented frame, at its own media time. Without
    // requestVideoFrameCallback: every animation frame while it plays,
    // when its time has moved.
    let handle = 0;
    let raf = 0;
    let last = -1;
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      draw(meta.mediaTime);
      handle = video.requestVideoFrameCallback(onFrame);
    };
    const tick = () => {
      if (video.currentTime !== last) {
        last = video.currentTime;
        draw(last);
      }
      raf = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const halt = () => cancelAnimationFrame(raf);
    const perFrame = typeof video.requestVideoFrameCallback === "function";
    if (perFrame) handle = video.requestVideoFrameCallback(onFrame);
    else {
      video.addEventListener("playing", run);
      video.addEventListener("pause", halt);
    }

    return () => {
      ro?.disconnect();
      video.removeEventListener("loadeddata", redraw);
      video.removeEventListener("seeked", redraw);
      if (perFrame) video.cancelVideoFrameCallback(handle);
      else {
        halt();
        video.removeEventListener("playing", run);
        video.removeEventListener("pause", halt);
      }
    };
  }, [videoRef, trackRef, canvasRef, plateRef]);
}

/* ── The section ── */

export function ReframeSection() {
  const t = useT();
  // No motion (reduced motion, data saver): the settled still, no pass,
  // no controls.
  const moves = useClipsMove();
  const [paused, setPaused] = useState(false);
  const [done, setDone] = useState(false);
  const figRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedRef = useRef(false);
  const passRef = useRef<{ sync: () => void; replay: () => void } | null>(null);

  useFollowFace({ videoRef, trackRef, canvasRef, plateRef });

  // Pause and Play reach a running pass too.
  useEffect(() => {
    pausedRef.current = paused;
    passRef.current?.sync();
  }, [paused]);

  useEffect(() => {
    const fig = figRef.current;
    const stage = stageRef.current;
    const plate = plateRef.current;
    if (!moves || !fig || !stage || !plate || typeof stage.animate !== "function" || typeof IntersectionObserver === "undefined") {
      return;
    }
    const els = new Map<string, HTMLElement>();
    for (const el of stage.querySelectorAll<HTMLElement>("[data-el]")) {
      if (el.dataset.el) els.set(el.dataset.el, el);
    }
    let anims = new Map<Part, Animation>();
    // Timers on the pass's own clock (they pause with it).
    let marks: Animation[] = [];
    let phase: "armed" | "running" | "done" = "armed";
    // The pass a mark belongs to (a late one from a cancelled pass is
    // ignored), the stage's share of the clear area, the first-frame wait.
    let pass = 0;
    let share = 0;
    let waited = false;
    let waitTimer = 0;
    let onWaited: (() => void) | null = null;

    const geo = () => readGeo(fig, plate, videoRef.current);
    const live = () => !pausedRef.current && document.visibilityState !== "hidden";
    const threshold = () => parseFloat(getComputedStyle(fig).getPropertyValue("--rf-pass")) || 0.6;

    const stopWaiting = () => {
      window.clearTimeout(waitTimer);
      if (onWaited) videoRef.current?.removeEventListener("loadeddata", onWaited);
      onWaited = null;
    };

    // Armed: every cue created and held on its first frame (fill
    // backwards), the base CSS (the settled pose) underneath.
    const arm = (g: PassGeo) => {
      stopWaiting();
      marks.forEach((m) => m.cancel());
      anims.forEach((a) => a.cancel());
      marks = [];
      anims = new Map();
      pass += 1;
      phase = "armed";
      waited = false;
      delete stage.dataset.pass;
      const score = smartcamScore(g);
      for (const part of PARTS) {
        const el = els.get(PART_EL[part]);
        if (!el) continue;
        const { delay, duration, frames } = framesOf(score[part]);
        const a = el.animate(frames, { delay, duration, fill: "backwards" });
        a.pause();
        a.currentTime = 0;
        anims.set(part, a);
      }
    };

    const at = (ms: number, fn: () => void) => {
      const id = pass;
      const mark = stage.animate(null, { duration: ms });
      mark.finished.then(
        () => {
          if (id === pass) fn();
        },
        () => {},
      );
      marks.push(mark);
    };

    // A pass, armed afresh: his face's height and the stage's size now.
    const start = () => {
      const g = geo();
      arm(g);
      phase = "running";
      stage.dataset.pass = "";
      // Just before the copy appears: where the window is now.
      at(LIFT_X_AT, () => {
        const score = smartcamScore({ ...g, xw: cropShift(videoRef.current?.currentTime ?? 0) });
        for (const part of ["slice", "liftShadow"] as const) {
          const effect = anims.get(part)?.effect;
          if (effect instanceof KeyframeEffect) effect.setKeyframes(framesOf(score[part]).frames);
        }
      });
      at(PASS_MS, () => {
        phase = "done";
        delete stage.dataset.pass;
        setDone(true);
      });
      anims.forEach((a) => a.play());
      sync();
    };

    // Runs, holds or starts the pass as the page allows.
    function sync() {
      if (phase === "running") {
        const go = live();
        for (const a of [...anims.values(), ...marks]) {
          if (go && a.playState === "paused") a.play();
          else if (!go && a.playState === "running") a.pause();
        }
        return;
      }
      if (phase !== "armed" || !live() || share < threshold() - 0.01) return;
      const video = videoRef.current;
      if (waited || !video || video.readyState >= 2) {
        start();
        return;
      }
      if (onWaited) return;
      onWaited = () => {
        stopWaiting();
        waited = true;
        sync();
      };
      video.addEventListener("loadeddata", onWaited);
      waitTimer = window.setTimeout(onWaited, FRAME_WAIT_MS);
    }

    arm(geo());
    // Fully out of view: back to the first frame for the next entry (the
    // Replay button stays while it has focus). Not while paused: the
    // armed pose has no window and no vertical, and a paused pass would
    // not start again, so it keeps the pose it was paused in.
    const away = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1].isIntersecting || phase === "armed" || pausedRef.current) return;
      arm(geo());
      if (!fig.contains(document.activeElement)) setDone(false);
    });
    away.observe(fig);
    const near = new IntersectionObserver(
      (entries) => {
        share = passShare(entries[entries.length - 1]);
        sync();
      },
      { threshold: PASS_THRESHOLDS, rootMargin: PASS_ROOT_MARGIN },
    );
    near.observe(stage);
    document.addEventListener("visibilitychange", sync);
    passRef.current = { sync, replay: start };
    return () => {
      away.disconnect();
      near.disconnect();
      document.removeEventListener("visibilitychange", sync);
      stopWaiting();
      marks.forEach((m) => m.cancel());
      anims.forEach((a) => a.cancel());
      delete stage.dataset.pass;
      passRef.current = null;
    };
  }, [moves]);

  const { file, w, h } = CLIPS.smartcam;

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
          <div ref={figRef} className={f.rfFig} style={FIG_VARS}>
            {/* The picture is one image to assistive tech; the controls
                below it stay operable. */}
            <div ref={stageRef} className={f.stage} role="img" aria-label={t("site.format.figureAria")}>
              <div className={f.rig} aria-hidden="true">
                <div ref={plateRef} className={f.plate} data-el="plate">
                  <div className={f.screen}>
                    <Scene clip="smartcam" crop="wide" playing={!paused} videoRef={videoRef} />
                    <div ref={trackRef} className={f.cropTrack}>
                      <div className={f.dim} data-el="dim" />
                      <div className={f.window} data-el="window" />
                      <span className={cx(f.corner, f.tl)} data-el="tl" />
                      <span className={cx(f.corner, f.tr)} data-el="tr" />
                      <span className={cx(f.corner, f.bl)} data-el="bl" />
                      <span className={cx(f.corner, f.br)} data-el="br" />
                    </div>
                    <span className={f.rim} />
                  </div>
                  <span className={f.edge} />
                  <span className={f.liftShadow} data-el="liftShadow" />
                  <span className={f.footShadow} data-el="foot" />
                  <div className={f.slice} data-el="slice">
                    <span className={f.sliceShadow} data-el="shadow" />
                    <div className={f.sliceClip}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- the clip's pre-sized first frame (Scene's poster), no optimizer needed */}
                      <img
                        className={cx(f.slicePoster, lqipClass("smartcam"))}
                        src={`${CLIP_DIR}/${file}.webp`}
                        width={w}
                        height={h}
                        alt=""
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                      <canvas ref={canvasRef} className={f.sliceCanvas} />
                      <span className={f.sheen} data-el="sheen" />
                    </div>
                    <span className={f.sliceFrame} data-el="frameLine" />
                    <span className={f.sliceOutline} data-el="outline" />
                  </div>
                </div>
              </div>
              <span className={cx(styles.frameTag, f.tag)} aria-hidden="true">
                {t("site.demo.example")}
              </span>
              <span className={cx(f.ratio, f.ratioWide)} aria-hidden="true">
                16:9
              </span>
              <span className={cx(f.ratio, f.ratioTall)} data-el="label" aria-hidden="true">
                9:16
              </span>
            </div>
            {moves && (
              <div className={f.controls}>
                <IconButton
                  label={t("site.demo.replay")}
                  className={f.ctl}
                  data-shown={done}
                  onClick={() => {
                    // Replaying is asking for the motion: it plays.
                    pausedRef.current = false;
                    setPaused(false);
                    passRef.current?.replay();
                  }}
                >
                  <Icon icon={RotateCcw} size={16} />
                </IconButton>
                <IconButton
                  label={paused ? t("site.demo.play") : t("site.demo.pause")}
                  className={f.ctl}
                  onClick={() => setPaused((p) => !p)}
                >
                  <Icon icon={paused ? Play : Pause} size={16} />
                </IconButton>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
