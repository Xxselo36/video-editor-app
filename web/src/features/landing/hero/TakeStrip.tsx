"use client";
/**
 * The hero demo: one recording as a tape lying in 3D, and the finished
 * 9:16 video it becomes. In an endless loop that reads as one film it
 * tells the headline in two acts (hero/score.ts): "You talk" (a playhead
 * records, each command flags where it was said and plants its post,
 * “Cleo keep” at the end of the first scene among them, and the playhead
 * lands on “Cleo finish”) and "Cleo cuts" (Cleo reads the recording and
 * marks what goes; the bad take, a filler word, a pause and the skipped
 * sentence lift off, the tape closes behind them and gets visibly
 * shorter; keep's post stays and its scene is sealed as kept), then a
 * render head runs over the kept tape and, as it lands, the video lights
 * up and its captions play, drawn by the real caption engine.
 *
 * The video is the real clip (scene/, clip "hero"): a dimmed raw monitor
 * while the tape is cut, lit when it is done. It plays while the loop
 * runs and pauses on its frame with it.
 *
 * A step machine: each step is data-* attributes and per-piece
 * translates; CSS transitions and keyframes move between steps, so the
 * holds cost nothing and nothing re-renders per frame. Act 1's playhead
 * is one linear Web Animation for the whole recording, and its steps
 * (posts appearing, the chip moving on) follow that clock. Each act has
 * one chip that travels from flag to flag. It runs while on screen and
 * the tab is visible, unless the visitor paused it (WCAG 2.2.2); a stop
 * freezes the stage where it is and resumes from there. Reduced motion
 * shows the finished still (the video's poster and the caption's
 * poster). The first frame is the finished video, so a screenshot or a
 * slow start shows the result, and the first motion is the result
 * playing, never an undo.
 *
 * The stage is decoration for sighted visitors (aria-hidden); the list
 * under it says the same in words.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play } from "lucide-react";
import { useLang, useT } from "@/i18n";
import { presetSupport } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import type { PresetId } from "@/lib/captions/types";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "../CaptionFrame";
import { LiveCaption } from "../captions/LiveCaption";
import { captionWords, spokenUntil } from "../captions/words";
import { Scene } from "../scene/Scene";
import { CMD_COLOR, Cmd, SMALL_FRAME_OVERRIDES, useDocumentVisible, useInView, useReducedMotion, type CmdId } from "../shared";
import {
  AT,
  CLOSE_DELAY_MS,
  CLOSE_MS,
  FINISHED,
  FIRST,
  FLAG_TARGET,
  GLINT_MS,
  HEAD_FROM,
  HEAD_MS,
  LIFT_DELAY,
  LIFT_MS,
  LOOP_FROM,
  MARKED,
  MARK_MS,
  PIECES,
  PIECE_IN_MS,
  PIECE_STAGGER_MS,
  POSTS,
  PULSE_MS,
  RENDER_MS,
  SCAN_MS,
  SEAL,
  STEPS,
  chipsAt,
  flagAt,
  headAt,
  keptLength,
  renderAt,
  shiftAt,
  statusOf,
  type ChipView,
  type FlagId,
  type LegendId,
  type PieceId,
  type Step,
} from "./score";
import styles from "./Hero.module.css";

const LEGEND: { id: LegendId; key: "site.demo.take" | "site.demo.fillers" | "site.demo.pauses" | "site.demo.skip" | "site.demo.captions" }[] = [
  { id: "take", key: "site.demo.take" },
  { id: "fillers", key: "site.demo.fillers" },
  { id: "pauses", key: "site.demo.pauses" },
  { id: "skip", key: "site.demo.skip" },
  { id: "captions", key: "site.demo.captions" },
];
const LEGEND_KEY = Object.fromEntries(LEGEND.map((l) => [l.id, l.key])) as Record<LegendId, (typeof LEGEND)[number]["key"]>;

/** The flag chip's colour: its command's; a filler or a pause stays neutral. */
const FLAG_CMD: Record<FlagId, CmdId | undefined> = {
  start: "start",
  cut: "cut",
  cutTake: "cut",
  keep: "keep",
  stop: "stop",
  stopgo: "stop",
  skip: "stop",
  finish: "finish",
  trimStart: "start",
  trimFinish: "finish",
  um: undefined,
  pause: undefined,
};

/** The chips on screen at each step (score.chipsAt). */
const CHIPS: ChipView[][] = STEPS.map((_, n) => chipsAt(n));

/** The score's timings, for the stage's CSS (Hero.module.css). */
const STAGE_TIMING = {
  "--lift-ms": `${LIFT_MS}ms`,
  "--close-ms": `${CLOSE_MS}ms`,
  "--close-delay": `${CLOSE_DELAY_MS}ms`,
  "--scan-ms": `${SCAN_MS}ms`,
  "--mark-ms": `${MARK_MS}ms`,
  "--pulse-ms": `${PULSE_MS}ms`,
  "--render-ms": `${RENDER_MS}ms`,
  "--glint-ms": `${GLINT_MS}ms`,
  "--piece-in-ms": `${PIECE_IN_MS}ms`,
  "--piece-stagger-ms": `${PIECE_STAGGER_MS}ms`,
} as React.CSSProperties;

/** The kept tape, where the render head stops (%). */
const KEPT = keptLength(new Set<PieceId>(FINISHED.gone));

/** A chip's stem stays this far from its rounded ends (px); past that the
 *  chip may overhang the rail by up to OVERHANG to keep it on its post. */
const STEM_INSET = 12;
const OVERHANG = 8;
/** The base width the chip's middle is scaled from (px; Hero.module.css .chipMid). */
const MID_BASE = 100;

/** The caption's hold after its last word (s). */
const CAPTION_HOLD = 0.4;

/** The caption style the hero's video uses in this language. */
function heroPreset(lang: string): PresetId {
  if (presetSupport("power", lang).level !== "unavailable") return "power";
  return LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? "power";
}

/** A media query as a store for useSyncExternalStore (false on the server). */
function mediaStore(query: string) {
  return {
    subscribe: (cb: () => void): (() => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    get: () => window.matchMedia(query).matches,
    server: () => false,
  };
}

/** Phones: the frame is about 100 px wide, so a style that draws small
 *  (Karaoke, for Hindi) draws larger, as on the bonus clips. */
const SMALL_FRAME = mediaStore("(max-width: 767px)");
/** Phones and tablets: the video is hidden until the finish (Hero.module.css). */
const LIT_ONLY = mediaStore("(max-width: 1023px)");

/**
 * Places a chip over its target: the pill is drawn as two caps and a
 * middle, so its width morphs with transforms only while it travels;
 * the stem stays on the target even where the chip is held inside the
 * rail. The first placement of a chip is instant (it rises in where it
 * is); after that every change travels (Hero.module.css .chip[data-placed]).
 */
function placeChip(el: HTMLElement, x: number, railW: number) {
  const label = el.querySelector<HTMLElement>("[data-on]");
  const capL = el.querySelector<HTMLElement>("[data-part='l']");
  const mid = el.querySelector<HTMLElement>("[data-part='m']");
  const capR = el.querySelector<HTMLElement>("[data-part='r']");
  const stem = el.querySelector<HTMLElement>("[data-part='stem']");
  if (!label || !capL || !mid || !capR || !stem) return;
  const w = label.offsetWidth;
  const h = label.offsetHeight;
  const half = w / 2;
  const room = Math.max(0, half - STEM_INSET);
  let c = Math.min(Math.max(x, half), Math.max(half, railW - half));
  const off = x - c;
  if (off < -room) c -= Math.min(OVERHANG, -room - off);
  else if (off > room) c += Math.min(OVERHANG, off - room);
  // the pill widens before a longer label shows (so text never spills
  // past it) and narrows in step with the travel (so it never passes
  // the rail's edge on the way)
  const was = Number(el.dataset.w) || w;
  if (w !== was) el.dataset.morph = w > was ? "grow" : "shrink";
  el.dataset.w = String(w);
  el.style.transform = `translateX(${c}px)`;
  capL.style.transform = `translateX(${-half}px)`;
  capR.style.transform = `translateX(${half - h / 2 - 1}px)`;
  mid.style.transform = `translateX(${-half + h / 2}px) scaleX(${Math.max(0, w - h) / MID_BASE})`;
  stem.style.transform = `translateX(${Math.min(Math.max(x - c, -room), room)}px)`;
  if (!el.dataset.placed) {
    // apply the first placement without transitions, then let it travel
    el.getBoundingClientRect();
    el.dataset.placed = "1";
  }
}

/** Text that crossfades when it changes: the old line rises out as the
 *  new one rises in, two stacked spans, never a blank frame. */
function Swap({ text, className }: { text: string; className: string }) {
  const [shown, setShown] = useState({ text, prev: "" });
  if (shown.text !== text) setShown({ text, prev: shown.text });
  return (
    <>
      {shown.prev && shown.prev !== text && (
        <span key={shown.prev} className={cx(className, styles.swapOut)}>
          {shown.prev}
        </span>
      )}
      <span key={text} className={className}>
        {text}
      </span>
    </>
  );
}

export function TakeStrip() {
  const t = useT();
  const lang = useLang();
  const [paused, setPaused] = useState(false);
  const [i, setI] = useState(FIRST);
  const [cycle, setCycle] = useState(0);
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.1 });
  const visible = useDocumentVisible();
  const reduced = useReducedMotion();
  const running = !paused && inView && visible && !reduced;
  const smallFrame = useSyncExternalStore(SMALL_FRAME.subscribe, SMALL_FRAME.get, SMALL_FRAME.server);
  const litOnly = useSyncExternalStore(LIT_ONLY.subscribe, LIT_ONLY.get, LIT_ONLY.server);
  const caption = t("site.demo.caption");

  // A play step lasts as long as the sentence and its hold.
  const capMs = useMemo(() => Math.round((spokenUntil(captionWords(caption, lang)) + CAPTION_HOLD) * 1000), [caption, lang]);
  const ms = STEPS[i].play ? capMs : STEPS[i].ms;

  const s: Step = reduced ? FINISHED : STEPS[i];

  // Act 1's playhead: one linear animation for the whole recording, so it
  // never waits at a post for a late timer. It holds on the finish post
  // while it lands and goes back to the start post once it is hidden.
  const headRef = useRef<HTMLDivElement>(null);
  const headAnim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (s.head === "run") {
      const el = headRef.current;
      if (headAnim.current || !el || typeof el.animate !== "function") return;
      const anim = el.animate([{ transform: `translateX(${HEAD_FROM}%)` }, { transform: `translateX(${AT.post}%)` }], {
        duration: HEAD_MS,
        easing: "linear",
        fill: "forwards",
      });
      // from where this step starts (the start post, unless the loop was
      // picked up mid-recording)
      anim.currentTime = headAt(STEPS[i - 1]?.to ?? HEAD_FROM);
      headAnim.current = anim;
    } else if (s.head !== "end") {
      headAnim.current?.cancel();
      headAnim.current = null;
    }
  }, [s.head, i]);

  // The step clock. A stop keeps what is left of the step, so the stage
  // and the clock resume together; while recording, the next post is due
  // when the playhead gets there.
  const held = useRef<{ i: number; left: number } | null>(null);
  useEffect(() => {
    if (!running) return;
    const step = STEPS[i];
    const head = headAnim.current;
    const left =
      step.head === "run" && step.to !== undefined && head
        ? Math.max(0, headAt(step.to) - (Number(head.currentTime) || 0))
        : held.current?.i === i
          ? held.current.left
          : ms;
    held.current = null;
    const t0 = performance.now();
    const id = window.setTimeout(() => {
      // The loop goes on from the hold after the captions (the first hold
      // and play run once); entering the captions step starts them over.
      const next = i === STEPS.length - 1 ? LOOP_FROM : i + 1;
      if (next === STEPS.length - 1) setCycle((c) => c + 1);
      setI(next);
    }, left);
    return () => {
      window.clearTimeout(id);
      held.current = { i, left: Math.max(0, left - (performance.now() - t0)) };
    };
  }, [running, i, ms]);

  // A stop freezes the stage's motion where it is (the playhead, the
  // sweeps, the scrub, lifting pieces, closing lanes, a travelling chip)
  // and resumes it; the video pauses on its frame (Scene playing). Only
  // running ones: a finished fill-both entrance is never replayed.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (running || !stage || typeof stage.getAnimations !== "function") return;
    const frozen = stage.getAnimations({ subtree: true }).filter((a) => a.playState === "running");
    for (const a of frozen) a.pause();
    return () => {
      for (const a of frozen) if (a.playState === "paused") a.play();
    };
  }, [running]);

  const gone = useMemo(() => new Set<PieceId>(s.gone), [s.gone]);
  const marked = useMemo(() => new Set<PieceId>(s.mark ?? []), [s.mark]);
  const preset = heroPreset(lang);

  // The chips: one per act, travelling from flag to flag over the tape;
  // the previous act's fades out where it was. Each is placed on the
  // screen after its step (the tape is in perspective) by measuring a
  // probe at its target's resting place, and kept inside the rail.
  const chips = reduced ? [] : CHIPS[i];
  const current = chips.find((c) => !c.leaving);
  const target = current?.slots[current.on];
  const railRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef(new Map<number, HTMLElement>());
  useLayoutEffect(() => {
    const rail = railRef.current;
    const probe = probeRef.current;
    const el = current && chipRefs.current.get(current.act);
    if (!rail || !probe || !el) return;
    const rr = rail.getBoundingClientRect();
    const pr = probe.getBoundingClientRect();
    placeChip(el, pr.left + pr.width / 2 - rr.left, rr.width);
  }, [current, lang]);

  const filler = t("site.demo.filler");
  const chipBody = (f: FlagId) => {
    switch (f) {
      case "start":
      case "trimStart":
        return <Cmd id="start" />;
      case "cut":
      case "cutTake":
        return <Cmd id="cut" />;
      case "keep":
        return <Cmd id="keep" />;
      case "stop":
        return <Cmd id="stop" />;
      case "stopgo":
      case "skip":
        return (
          <>
            <Cmd id="stop" /> <span className={styles.ellipsis}>…</span> <Cmd id="go" />
          </>
        );
      case "finish":
      case "trimFinish":
        return <Cmd id="finish" />;
      case "um":
        return <span className={styles.struck}>{filler}</span>;
      case "pause":
        return (
          <>
            <span className={styles.hatchSwatch} />
            <span className={styles.neutralWord}>{t("site.auto.pause")}</span>
          </>
        );
    }
  };
  const chipColor = (f: FlagId | undefined) => {
    const cmd = f && FLAG_CMD[f];
    return cmd ? CMD_COLOR[cmd] : undefined;
  };

  const phaseText = s.phase === "talk" ? t("site.demo.phaseTalk") : s.phase === "edit" ? t("site.demo.phaseEdit") : t("site.demo.phaseReady");
  const statusId = statusOf(s);
  const status = statusId ? t(LEGEND_KEY[statusId]) : phaseText;
  // While recording, a post shows once the playhead has reached it.
  const recording = s.phase === "talk" || s.fade === "snap";
  const saidFlag = s.flag && FLAG_TARGET[s.flag];
  const said = recording ? POSTS.findIndex((p) => !!saidFlag && "post" in saidFlag && saidFlag.post === p.id) : POSTS.length;
  const sealed = s.phase === "edit" && gone.has(SEAL.when);

  return (
    <div
      ref={ref}
      className={styles.demo}
      data-phase={s.phase ?? ""}
      data-fade={s.fade ?? ""}
      data-frame={s.frame}
      data-play={s.play ? "on" : ""}
      data-sweep={s.sweep ?? ""}
      data-scrub={s.scrub ?? ""}
      data-reveal={s.reveal ? "on" : ""}
      data-running={running}
      style={STAGE_TIMING}
    >
      <div ref={stageRef} className={styles.stage} aria-hidden="true">
        <div ref={railRef} className={styles.rail}>
          {chips.map((c) => (
            <span
              key={c.act}
              ref={(el) => {
                if (el) chipRefs.current.set(c.act, el);
                else chipRefs.current.delete(c.act);
              }}
              className={styles.chip}
              data-leaving={c.leaving ? "true" : undefined}
              style={{ "--rc": chipColor(c.slots[c.on]) } as React.CSSProperties}
            >
              <span className={styles.chipCap} data-part="l" />
              <span className={styles.chipMid} data-part="m" />
              <span className={cx(styles.chipCap, styles.chipCapR)} data-part="r" />
              <span className={styles.stem} data-part="stem" />
              {c.slots.map((f, n) => (
                <span key={n} className={styles.chipLabel} data-on={n === c.on ? "true" : undefined}>
                  {f && chipBody(f)}
                </span>
              ))}
            </span>
          ))}
        </div>

        <div className={styles.stripArea}>
          <div className={styles.strip}>
            <div className={styles.track}>
              {/* the space the removals freed, hatched once the ends are
                  trimmed; under the pieces, so the closing tape uncovers it */}
              <span className={styles.freed} data-shown={gone.has("pre") ? "true" : undefined} style={{ left: `${keptLength(gone)}%` }} />
              {PIECES.map((p, n) => {
                const state = gone.has(p.id) ? "gone" : marked.has(p.id) ? "mark" : "";
                const kept = !FINISHED.gone.includes(p.id);
                return (
                  <div key={p.id} className={styles.lane} style={{ transform: `translateX(${-shiftAt(AT[p.id], gone)}%)` }}>
                    <span
                      className={cx(styles.piece, styles[p.kind])}
                      data-state={state}
                      data-sealed={p.id === SEAL.piece && sealed ? "true" : undefined}
                      style={
                        {
                          left: `${AT[p.id]}%`,
                          width: `${p.g}%`,
                          "--c": p.cmd ? CMD_COLOR[p.cmd] : "var(--text-muted)",
                          "--n": n,
                          "--at": AT[p.id] / 100,
                          "--rt": kept ? renderAt(p.id) : undefined,
                          "--lift-delay": LIFT_DELAY[p.id] ? `${LIFT_DELAY[p.id]}ms` : undefined,
                        } as React.CSSProperties
                      }
                    >
                      <span className={styles.mark} />
                      {p.kind === "filler" && <span className={styles.um}>{filler}</span>}
                      {p.id === SEAL.piece && <span className={styles.seal} />}
                    </span>
                  </div>
                );
              })}
              {MARKED.map((m) =>
                gone.has(m.id) ? (
                  <div key={`cut-${m.id}`} className={styles.lane} style={{ transform: `translateX(${-shiftAt(AT[m.id], gone)}%)` }}>
                    <span
                      className={styles.marker}
                      data-tone={m.tone}
                      data-beside={m.beside ? "true" : undefined}
                      style={{ left: `${AT[m.id]}%` }}
                    />
                  </div>
                ) : null,
              )}
              {POSTS.map((p, n) => {
                const left = p.leavesWith && gone.has(p.leavesWith);
                return (
                  <div key={p.id} className={styles.lane} style={{ transform: `translateX(${-shiftAt(p.at, gone)}%)` }}>
                    <span
                      className={styles.post}
                      data-ahead={n > said ? "true" : undefined}
                      data-gone={left ? "true" : undefined}
                      data-flash={s.flash === p.id ? "true" : undefined}
                      style={{ left: `${p.at}%`, "--pc": CMD_COLOR[p.cmd], "--at": p.at / 100 } as React.CSSProperties}
                    />
                  </div>
                );
              })}
              {/* where the current chip points, at rest (never moves while measured) */}
              <span ref={probeRef} className={styles.probe} style={{ left: `${target ? flagAt(target, gone) : 0}%` }} />
              {/* the full-width lanes slide; clipped so they never widen the page */}
              <div className={styles.headClip}>
                <div ref={headRef} className={styles.headLane} data-head={s.head ?? ""} style={{ transform: `translateX(${HEAD_FROM}%)` }} />
                <div className={styles.sweepLane} style={{ "--kept": `${KEPT}%` } as React.CSSProperties} />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.video}>
          <div className={styles.screen}>
            {/* It plays with the loop; where it is hidden until the
                finish (phones, tablets), from the render step on, so
                its first visible frame is already moving. */}
            <Scene
              clip="hero"
              priority
              playing={running && (s.frame === "lit" || !litOnly || i === STEPS.length - 2)}
              className={styles.scene}
            />
            <div className={styles.captionLayer}>
              <LiveCaption
                preset={preset}
                overrides={smallFrame ? SMALL_FRAME_OVERRIDES[preset] : undefined}
                text={caption}
                lang={lang}
                playing={running && !!s.play}
                loop={false}
                hold={CAPTION_HOLD}
                restartKey={cycle}
                swapOnPlay
              >
                {/* larger on phones via CSS, so the first paint matches */}
                <CaptionPoster preset={preset} text={caption} className={preset === "karaoke" ? styles.capLarge : undefined} />
              </LiveCaption>
            </div>
            <span className={styles.scrim} />
            <span className={styles.tag}>{t("site.demo.example")}</span>
            <span className={styles.scrub}>
              <span className={styles.scrubHead} style={{ transitionDuration: s.scrub === "run" ? `${capMs}ms` : "0ms" }} />
            </span>
          </div>
        </div>
      </div>

      <div className={styles.under}>
        <p className={styles.phase} aria-hidden="true">
          <Swap text={phaseText} className={styles.phaseText} />
        </p>
        <ul className={styles.legend} aria-label={t("site.demo.listAria")}>
          {LEGEND.map((l) => (
            <li
              key={l.id}
              className={cx(styles.legendItem, styles[`li_${l.id}`])}
              data-state={s.li === l.id ? "current" : s.done.includes(l.id) ? "done" : ""}
            >
              <span className={styles.swatch} aria-hidden="true" />
              {t(l.key)}
            </li>
          ))}
        </ul>
        <div className={styles.status} aria-hidden="true">
          <span className={styles.statusLine}>
            <Swap text={status} className={styles.statusText} />
          </span>
          <span className={styles.ticks}>
            {LEGEND.map((l) => (
              <span
                key={l.id}
                className={cx(styles.tick, styles[`li_${l.id}`])}
                data-state={s.li === l.id ? "current" : s.done.includes(l.id) ? "done" : ""}
              />
            ))}
          </span>
        </div>
        {!reduced && (
          <IconButton
            label={paused ? t("site.demo.play") : t("site.demo.pause")}
            className={styles.playToggle}
            onClick={() => setPaused((p) => !p)}
          >
            <Icon icon={paused ? Play : Pause} size={16} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
