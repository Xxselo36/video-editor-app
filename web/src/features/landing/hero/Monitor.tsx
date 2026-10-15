/**
 * The hero's monitor: the 9:16 frame shows the raw take wherever the tape
 * is (hero/monitor.ts has the timing). A lazy chunk: TakeStrip renders it
 * once the loop runs, after hydration, and never under reduced motion,
 * data saver or a 2G-class connection; it first shows at the loop's seam,
 * about 3.5 s in, so nothing of it is in the first load.
 *
 * It lies over the Scene (the graded take, hero.mp4), which TakeStrip
 * keeps paused while the footage is raw and plays when the frame lights.
 * - The seam: the raw take, cued to the Scene's frame, fades in over it,
 *   so the grade drains from the picture on screen; while the tape is
 *   unseen the frame dissolves to the take's first frame and waits there.
 *   Where the two files do not hold the same frame (the finished video's
 *   last 0.4 s fade into its own start; monitor.ts drains), the Scene
 *   plays the seam out under the scrim and the take takes over at the
 *   snap instead: a still of the Scene's frame, shown at once, then the
 *   same dissolve.
 * - Act 1: the take follows the playhead's own clock (TakeStrip's Web
 *   Animation). Only its speed is steered, never a seek per frame, so the
 *   motion stays fluid; a pill shows fast-forward and the take's
 *   timecode, a bar under the picture runs with the playhead.
 * - Act 2: as each removal lifts off the tape, its removed moment flashes
 *   (a still captured once at load, hatched in the removal's colour),
 *   and behind it the take seeks to the next kept take, which plays on
 *   once it has its frame: a jump cut, never a black or stale frame. The
 *   ends' trim lands on the finished video's first frame and holds it.
 * - The render head wipes the raw take away, left to right, uncovering
 *   the Scene paused on the same frame: the grade is applied. Then the
 *   finished video plays and the monitor goes, unseen; the head's line
 *   fades where it landed.
 *
 * It loads the raw take only once the Scene's video plays (it has its
 * frame and was not refused). If the raw take cannot play (an error,
 * autoplay refused, Low Power Mode), before or after it took over, it
 * gives up and takes everything it shows with it, and the Scene plays as
 * it always did (onLive). A stop (pause button, off screen, hidden tab)
 * pauses the take; its Web Animations and transitions sit in the stage,
 * so TakeStrip's freeze holds them with the rest. Everything changes on
 * steps and media events; per frame, only Act 1 reads two clocks and
 * steers a playback rate (no React render, no layout read).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { FastForward } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { CLIPS, CLIP_DIR } from "../scene/clips";
import { CMD_COLOR } from "../shared";
import type { Step } from "./score";
import { HERO_S, RAW_S, drains, steer, timecode, timingOf, type Cue, type Cut, type Score, type Timing } from "./monitor";
import styles from "./Monitor.module.css";

const RAW = CLIPS.heroRaw;
/** The removed moments' stills: half size (the flash is hatched and
 *  brief), one small canvas each. */
const SHOT_W = RAW.w / 2;
const SHOT_H = RAW.h / 2;
/** The seam: closer than this (s) the cued take simply plays on. */
const SEAM_SLACK = 0.1;
/** A seek's head start on a playing video (s). */
const SEEK_AHEAD = 0.06;
/** The dissolve to the take's first frame while the tape is unseen (ms). */
const SNAP_MS = 280;
/** The render head's line fades where it lands, as the finished video
 *  plays (ms; the tape's head fades in 200 ms, Hero.module.css). */
const WIPE_OUT_MS = 160;
/** The take's last frame: within this of the end it holds (s). */
const END_SLACK = 0.06;

type Parts = {
  root: HTMLDivElement;
  picture: HTMLDivElement;
  raw: HTMLVideoElement;
  still: HTMLCanvasElement;
  tint: HTMLSpanElement;
  /** The render head's line, beside the root. */
  line: HTMLSpanElement;
  ff: HTMLSpanElement;
  code: HTMLSpanElement;
  bar: HTMLSpanElement;
  barHead: HTMLSpanElement;
};

type Links = {
  /** What it reads of the score, handed over by TakeStrip (monitor.ts). */
  score: Score;
  /** The Scene's video: the graded take. */
  scene: React.RefObject<HTMLVideoElement | null>;
  /** The playhead's run: Act 1's clock. */
  head: React.RefObject<Animation | null>;
  onLive: (live: boolean) => void;
};

type Control = { cue: (c: Cue) => void; run: (running: boolean) => void; stop: () => void };

/** The colour a removal is marked in on the tape (TakeStrip's --c). */
function cutColor(score: Score, c: Cut): string {
  const cmd = score.PIECES.find((p) => p.id === c.id)?.cmd;
  return cmd ? CMD_COLOR[cmd] : "var(--text-muted)";
}

/** Runs `fn` once the page's frame with the changes made so far is on
 *  screen. A video's decoded frames reach the screen without waiting for
 *  the page's, so a seek issued in the same task as a still put over it
 *  can show its new frame first, for a frame. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Settles once the video shows the frame it was sent to. */
function settled(v: HTMLVideoElement): Promise<void> {
  return new Promise((done) => {
    const check = () => {
      if (v.seeking || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      v.removeEventListener("seeked", check);
      v.removeEventListener("loadeddata", check);
      done();
      return true;
    };
    if (check()) return;
    v.addEventListener("seeked", check);
    v.addEventListener("loadeddata", check);
  });
}

function startMonitor(p: Parts, time: Timing, { score, scene, head, onLive }: Links): Control {
  const { root, picture, raw, still, tint, line, ff, code, bar, barHead } = p;
  const { AT, HEAD_FROM, HEAD_MS, RENDER_MS } = score;
  const view = still.getContext("2d");
  let running = false;
  let dead = false;
  /** The raw take has its frame and the removed moments are captured. */
  let ready = false;
  /** It has taken over: its first play went through (until it gives up). */
  let live = false;
  /** Act 1: the take follows the playhead. */
  let following = false;
  /** Outside Act 1: the take plays on at 1x (a kept take after a jump). */
  let plays = false;
  /** A newer seek drops what a pending one would do once settled. */
  let gen = 0;
  /** The monitor is on screen (its root): from the seam's drain or the
   *  snap's takeover until the reveal. */
  let shown = false;
  let raf = 0;
  let barRun: Animation | null = null;
  let flash: Animation | null = null;
  /** The render's wipe of the picture, and the head's line over it. */
  let wipeRun: Animation | null = null;
  let lineRun: Animation | null = null;
  const shots = new Map<Cut["id"], HTMLCanvasElement>();
  const moving = new Set<Animation>();

  const on = (el: Element, yes: boolean) => (yes ? el.setAttribute("data-on", "") : el.removeAttribute("data-on"));
  const animate = (el: Element, frames: Keyframe[] | PropertyIndexedKeyframes, opts: KeyframeAnimationOptions) => {
    const a = el.animate(frames, opts);
    moving.add(a);
    a.finished.then(
      () => moving.delete(a),
      () => moving.delete(a),
    );
    return a;
  };

  /** On screen: at the seam it fades in over the Scene (the grade
   *  drains); `now`, at once, over a still of the Scene's own frame. */
  function show(now = false) {
    shown = true;
    root.setAttribute("data-on", now ? "now" : "");
  }
  function hide() {
    shown = false;
    on(root, false);
  }

  function giveUp() {
    if (dead) return;
    dead = true;
    // whatever a pending seek or play would still do is dropped
    gen++;
    following = false;
    plays = false;
    halt();
    // everything it shows goes with it: the picture, and the pill, the
    // bar and the render head's line beside it (a cancel puts each back
    // to its style: hidden)
    for (const a of moving) a.cancel();
    barRun = flash = wipeRun = lineRun = null;
    on(still, false);
    on(ff, false);
    on(bar, false);
    hide();
    if (live) {
      live = false;
      root.removeAttribute("data-monitor");
      onLive(false);
    }
    // drop what it loaded (the decoder, the download)
    raw.removeAttribute("src");
    raw.load();
  }

  function play() {
    // NotAllowedError: autoplay refused (iOS Low Power Mode). A pause()
    // before play() settles rejects it too (AbortError): harmless.
    raw.play()?.catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "NotAllowedError") giveUp();
    });
  }
  /** Outside Act 1: play the take on, or hold it. Never past its end (a
   *  play() there would start it over). */
  function sync() {
    if (running && plays && live && !raw.ended && raw.currentTime < RAW_S - END_SLACK) play();
    else raw.pause();
  }

  function holdFrame(src: CanvasImageSource) {
    view?.drawImage(src, 0, 0, still.width, still.height);
    on(still, true);
  }
  /** The frame a video shows, if it has one. */
  const hasFrame = (v: HTMLVideoElement) => v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  // ── Loading: once the Scene plays, the raw take loads; then each
  //    removed moment is captured once, so a flash never waits on a seek.
  async function capture() {
    for (const c of time.cuts) {
      raw.currentTime = c.at;
      await settled(raw);
      if (dead) return;
      const shot = document.createElement("canvas");
      shot.width = SHOT_W;
      shot.height = SHOT_H;
      shot.getContext("2d")?.drawImage(raw, 0, 0, SHOT_W, SHOT_H);
      shots.set(c.id, shot);
    }
    ready = true;
  }
  const load = () => {
    if (dead || raw.getAttribute("src")) return;
    // from its metadata on: each seek fetches what it needs (a browser may
    // not buffer a video that has never played, whatever its preload)
    raw.addEventListener("loadedmetadata", () => void capture().catch(giveUp), { once: true });
    raw.preload = "auto";
    raw.src = `${CLIP_DIR}/${RAW.file}.mp4`;
  };
  raw.addEventListener("error", giveUp);
  const sceneVideo = scene.current;
  if (sceneVideo && !sceneVideo.paused && hasFrame(sceneVideo)) load();
  else sceneVideo?.addEventListener("playing", load, { once: true });

  // ── Act 1: the take follows the playhead's clock.
  function tick() {
    raf = 0;
    if (!following || !running || dead) return;
    raf = requestAnimationFrame(tick);
    const run = head.current;
    if (!run) return;
    const ms = Number(run.currentTime) || 0;
    // the frame's bar runs with the playhead, on its own clock from here
    if (!barRun) {
      barRun = animate(barHead, [{ transform: `scaleX(${HEAD_FROM / 100})` }, { transform: `scaleX(${AT.post / 100})` }], {
        duration: HEAD_MS,
        easing: "linear",
        fill: "forwards",
      });
      barRun.currentTime = ms;
    }
    const label = timecode(raw.currentTime);
    if (code.textContent !== label) code.textContent = label;
    // its last frame (“Cleo finish”, or just before the playhead gets
    // there): hold it; a play() on an ended video would start it over
    if (raw.ended || raw.currentTime >= RAW_S - END_SLACK) {
      if (!raw.paused) raw.pause();
      return;
    }
    // past “Cleo finish”: run on to the last frame
    if (ms >= HEAD_MS) {
      if (raw.playbackRate !== time.rate) raw.playbackRate = time.rate;
    } else {
      const next = steer(time.rawAtHead(ms), raw.currentTime, raw.playbackRate, time.rate);
      if (next.seek !== undefined && !raw.seeking) raw.currentTime = next.seek;
      if (next.rate !== undefined) raw.playbackRate = next.rate;
    }
    if (raw.paused) play();
  }
  function halt() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    raw.pause();
  }

  /** The first takeover happens only once the take really plays (until
   *  then a refused or unplayed video may show nothing); `then` runs
   *  once it does, unless a later cue came first. If it misses this
   *  loop, the Scene plays the loop and it tries again at the next. */
  function goLive(g: number, then: () => void) {
    raw.play().then(
      () => {
        if (g !== gen || dead || live) return;
        live = true;
        root.setAttribute("data-monitor", "live");
        onLive(true);
        then();
      },
      (e: unknown) => {
        if (e instanceof DOMException && e.name === "NotAllowedError") giveUp();
      },
    );
  }

  // ── The cues (monitor.ts cuesAt), one per step at most.
  function prime(ms: number) {
    const v = scene.current;
    if (!ready || !v || dead) return;
    raw.pause();
    raw.playbackRate = 1;
    // where the Scene will be when the seam starts; if the seam cannot
    // drain there, where the snap takes the take to
    const t = (v.currentTime + ms / 1000) % (v.duration || HERO_S);
    raw.currentTime = drains(t) ? t : 0;
  }

  function seam() {
    const v = scene.current;
    if (!ready || dead || !v || !hasFrame(v)) return;
    const g = ++gen;
    following = false;
    raw.playbackRate = 1;
    wipeRun?.cancel();
    lineRun?.cancel();
    flash?.cancel();
    on(still, false);
    on(ff, false);
    on(bar, false);
    // Not the same frame on both: the take waits for the snap.
    if (!drains(v.currentTime)) {
      plays = false;
      raw.pause();
      return;
    }
    const drain = () => {
      if (g !== gen || dead) return;
      plays = true;
      if (live) {
        show();
        return sync();
      }
      if (!running) return;
      // (once playing it may be too late for the drain: then the take
      // runs on unseen and takes over at the snap)
      goLive(g, () => (drains(v.currentTime) ? show() : undefined));
    };
    // cued at the hold before (prime): it plays on from there; otherwise
    // it seeks to the Scene's frame first and fades in once it has it
    if (Math.abs(raw.currentTime - v.currentTime) <= SEAM_SLACK) return drain();
    raw.currentTime = v.currentTime + (v.paused ? 0 : SEEK_AHEAD);
    void settled(raw).then(drain);
  }

  /** Back to the take's first frame (the wait at “Cleo start”) behind
   *  the held still, then the still dissolves into it. */
  function toStart(g: number) {
    const held = still.hasAttribute("data-on");
    afterPaint(() => {
      if (g !== gen) return;
      if (raw.currentTime !== 0) raw.currentTime = 0;
      void settled(raw).then(() => {
        if (g !== gen || !held) return;
        on(still, false);
        animate(still, { opacity: [1, 0] }, { duration: SNAP_MS, easing: "ease" });
      });
    });
  }
  /** The takeover at the snap: the Scene's frame, held at once in the
   *  monitor, dissolves into the take's first frame. */
  function takeOver(g: number) {
    const v = scene.current;
    if (v && hasFrame(v)) holdFrame(v);
    show(!!v && hasFrame(v));
    toStart(g);
  }

  function snap() {
    // (a seam still waiting for its frame or its first play does not
    // take over any more: the pause also drops that play)
    const g = ++gen;
    plays = false;
    raw.pause();
    code.textContent = timecode(0);
    barRun?.cancel();
    barRun = null;
    if (!ready || dead) return;
    if (shown) {
      // drained: the frame on screen holds while the take goes back
      if (hasFrame(raw)) holdFrame(raw);
      toStart(g);
    } else if (live) takeOver(g);
    else if (running)
      goLive(g, () => {
        raw.pause();
        takeOver(g);
      });
  }

  function follow() {
    if (!live) {
      // a takeover still waiting for its first play waits for the next loop
      gen++;
      raw.pause();
      return;
    }
    // the Scene, unseen under the take until the render: the finished
    // video's first frame, which the render wipes the grade across
    const v = scene.current;
    if (v) {
      v.pause();
      v.currentTime = time.firstKept;
    }
    // (the snap took over; if it could not, the take fades in now)
    if (!shown) show();
    on(ff, true);
    on(bar, true);
    plays = false;
    following = true;
    raw.playbackRate = time.rate;
    if (running && !raf) tick();
  }

  function read() {
    if (!live) return;
    following = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    on(ff, false);
    on(bar, false);
    // a take that lags runs on to its last frame and holds it there
    raw.playbackRate = time.rate;
    plays = true;
    sync();
  }

  function cut(c: Cut) {
    const shot = shots.get(c.id);
    if (!live || !shot) return;
    const g = ++gen;
    following = false;
    plays = false;
    flash?.cancel();
    holdFrame(shot);
    tint.style.setProperty("--c", cutColor(score, c));
    flash = animate(tint, { opacity: [1, 1] }, { duration: time.jumpMs, fill: "forwards" });
    raw.pause();
    raw.playbackRate = 1;
    // the jump: the take seeks behind the removed moment once that is on
    // screen, and cuts to the next take as the tape starts closing, once
    // the take has its frame
    const flashed = flash;
    const sought = new Promise<void>((done) =>
      afterPaint(() => {
        if (g === gen) raw.currentTime = c.to;
        done();
      }),
    );
    Promise.all([flashed.finished, sought])
      .then(() => settled(raw))
      .then(
        () => {
          if (g !== gen) return;
          flashed.cancel();
          on(still, false);
          plays = !c.hold;
          sync();
        },
        () => {},
      );
  }

  function render() {
    if (!live) return;
    plays = false;
    raw.pause();
    wipeRun?.cancel();
    lineRun?.cancel();
    wipeRun = animate(picture, [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }], {
      duration: RENDER_MS,
      easing: "linear",
      fill: "forwards",
    });
    // the line sits beside the monitor, so it lands and fades over the
    // finished video (after this step, which lasts the run)
    lineRun = animate(
      line,
      [
        { transform: "translateX(0)", opacity: 0 },
        { opacity: 1, offset: (RENDER_MS * 0.08) / (RENDER_MS + WIPE_OUT_MS) },
        { transform: "translateX(100%)", opacity: 1, offset: RENDER_MS / (RENDER_MS + WIPE_OUT_MS), easing: "ease" },
        { transform: "translateX(100%)", opacity: 0 },
      ],
      { duration: RENDER_MS + WIPE_OUT_MS, easing: "linear" },
    );
  }

  function reveal() {
    if (!live) return;
    plays = false;
    raw.pause();
    // gone at once, unseen (the wipe has uncovered the Scene), then reset
    hide();
    wipeRun?.cancel();
    wipeRun = null;
    on(still, false);
  }

  return {
    cue(c) {
      if (dead) return;
      switch (c.kind) {
        case "prime":
          return prime(c.ms);
        case "seam":
          return seam();
        case "snap":
          return snap();
        case "follow":
          return follow();
        case "read":
          return read();
        case "cut":
          return cut(c.cut);
        case "render":
          return render();
        case "reveal":
          return reveal();
      }
    },
    run(r) {
      running = r;
      if (dead) return;
      if (!r) halt();
      else if (following) {
        if (!raf) tick();
      } else sync();
    },
    stop() {
      sceneVideo?.removeEventListener("playing", load);
      raw.removeEventListener("error", giveUp);
      giveUp();
    },
  };
}

export type MonitorProps = {
  /** The step machine's step (TakeStrip). */
  step: Step;
  running: boolean;
} & Links;

export default function Monitor({ step, running, score, scene, head, onLive }: MonitorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const rawRef = useRef<HTMLVideoElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const tintRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const ffRef = useRef<HTMLSpanElement>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const barHeadRef = useRef<HTMLSpanElement>(null);
  const control = useRef<Control | null>(null);
  const last = useRef<Step | undefined>(undefined);
  const time = useMemo(() => timingOf(score), [score]);

  useLayoutEffect(() => {
    const parts = {
      root: rootRef.current,
      picture: pictureRef.current,
      raw: rawRef.current,
      still: stillRef.current,
      tint: tintRef.current,
      line: lineRef.current,
      ff: ffRef.current,
      code: codeRef.current,
      bar: barRef.current,
      barHead: barHeadRef.current,
    };
    if (Object.values(parts).some((el) => !el) || typeof parts.root!.animate !== "function") return;
    // Muted and inline as attributes too, before any src (Scene.tsx):
    // iOS plays a video without a tap only then.
    const raw = parts.raw!;
    raw.defaultMuted = true;
    raw.muted = true;
    raw.setAttribute("muted", "");
    raw.playsInline = true;
    raw.setAttribute("playsinline", "");
    raw.setAttribute("webkit-playsinline", "");
    const c = startMonitor(parts as Parts, time, { score, scene, head, onLive });
    control.current = c;
    last.current = undefined;
    return () => {
      c.stop();
      control.current = null;
    };
  }, [time, score, scene, head, onLive]);

  // Each step's cues, in the commit that sets the stage's attributes, so
  // the frame's motion starts on the same frame as the tape's.
  useLayoutEffect(() => {
    for (const c of time.cuesAt(last.current, step)) control.current?.cue(c);
    last.current = step;
  }, [time, step]);

  useEffect(() => {
    control.current?.run(running);
  }, [running]);

  return (
    <>
      <div ref={rootRef} className={styles.monitor}>
        <div ref={pictureRef} className={styles.picture}>
          <video ref={rawRef} preload="none" muted playsInline disablePictureInPicture disableRemotePlayback />
          <canvas ref={stillRef} className={styles.still} width={RAW.w} height={RAW.h} />
          <span ref={tintRef} className={styles.tint} />
        </div>
      </div>
      <span ref={lineRef} className={styles.wipe} />
      <span ref={ffRef} className={styles.ff}>
        <Icon icon={FastForward} size="1em" strokeWidth={1.5} />
        <span ref={codeRef}>{timecode(0)}</span>
      </span>
      <span ref={barRef} className={styles.bar}>
        <span ref={barHeadRef} />
      </span>
    </>
  );
}
