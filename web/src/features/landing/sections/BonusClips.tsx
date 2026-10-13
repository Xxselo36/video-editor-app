"use client";
/**
 * Bonus clips: "Bonus clips from longer videos." The finished 3-minute
 * video lies flat as a tape with a time ruler. A playhead scans it, and
 * each picked moment goes through the same chain as the playhead reaches
 * it: its span outlines, a connector runs down from it, its 9:16 clip
 * stands up out of the tape on the page's hinge spring (no overshoot),
 * comes alive (its clip starts playing, its duration chip fades in) and
 * its caption plays once. The three clips are cut from the same
 * captioned video, so they share one caption style: Power, or the
 * language's first native style where Power is unavailable (Hindi:
 * Karaoke). Each clip says its own line of the video (one of its three
 * tips), and each tile loops its own clip of him (scene/); the control
 * under the figure pauses them (WCAG 2.2.2) and shows once the first
 * tile is up.
 *
 * Never an empty band: while a tile is still down, a dashed slot marks
 * where it will stand; the slot fades as its tile lands.
 *
 * The figure enters with the page's shared entrance (data-entrance,
 * app/page.tsx); the pass starts only once that has finished, and once
 * the tape and the tiles are in view (clear of the sticky header and the
 * phone bar) in a visible tab. One pass (~2 s, then the captions; under
 * 5 s in every language); re-armed when the figure is fully out of view,
 * so it plays again on re-entry. Every part takes its timing from
 * `clipsScore` (WAAPI on translate, transform, opacity and clip-path).
 * The base CSS is the settled end state (spans outlined, connectors
 * drawn, tiles upright, slots gone, captions settled): reduced motion,
 * screenshots and the server HTML.
 *
 * The captions run on their own clocks (the page's one ticker), and each
 * starts only once its engine and font are ready: a slow font load
 * delays the words, it never leaves a clip blank or frozen mid-sentence.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { presetSupport } from "@/lib/captions/scripts";
import type { PresetId } from "@/lib/captions/types";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "../CaptionFrame";
import { LiveCaption, type LiveCaptionHandle } from "../captions/LiveCaption";
import { subscribe } from "../captions/ticker";
import type { ClipId } from "../scene/clips";
import { LoopToggle, Scene } from "../scene/Scene";
import { useClipsMove } from "../scene/useClipPlayback";
import {
  EASE,
  PASS_ROOT_MARGIN,
  PASS_THRESHOLDS,
  SMALL_FRAME_OVERRIDES,
  SPRING_HINGE,
  passShare,
  useReducedMotion,
} from "../shared";
import styles from "../Landing.module.css";
import f from "./Format.module.css";

/** Bonus clips: at most this many (backend/llm.py detect_hook_moments). */
const MAX_HOOK_CLIPS = 3;

/** The finished video, in seconds. */
const VIDEO_S = 180;
/** The picked clips (seconds into the finished video), each its own
 *  moment of the video (its own looping clip of him), with the line said
 *  in it. */
const CLIPS: readonly { from: number; to: number; clip: ClipId; cap: MessageKey }[] = [
  { from: 10, to: 34, clip: "tileCafe", cap: "site.clips.cap1" },
  { from: 65, to: 106, clip: "tileOffice", cap: "site.clips.cap2" },
  { from: 135, to: 168, clip: "tileRoom", cap: "site.clips.cap3" },
];
/** The ruler: a tick every 30 s, three labels. */
const TICKS = [0, 30, 60, 90, 120, 150, 180];
const MARKS = [0, 90, 180];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** A clip's middle, as a fraction of the video (its span's and tile's centre). */
const mid = (c: (typeof CLIPS)[number]) => (c.from + c.to) / 2 / VIDEO_S;
/** Which way a tile can be pushed to stay inside the figure: at the
 *  narrowest the three tiles fill the width (tile i centred at
 *  (i + 0.5) / 3), so its connector bends from the span towards there. */
const bend = (c: (typeof CLIPS)[number], i: number) => ((i + 0.5) / CLIPS.length >= mid(c) ? "right" : "left");

const SCAN_MS = 1200;
const SPAN_MS = 200;
const LINK_MS = 240;
/** A tile's hinge: the page's spring (shared.tsx SPRING_HINGE) over this
 *  long; its opacity comes in faster, on the brand curve. */
const TILE_MS = 600;
const TILE_FADE_MS = 200;
/** Its slot fades out as the tile lands (the spring is past 90 % of the
 *  way up), quickly, on `ease`. */
const SLOT_AT = 300;
const SLOT_MS = 150;
/** Once it is up, its duration chip fades in. */
const DUR_MS = 200;
/** Each caption holds its last page this long after the last word (s). */
const CAP_TAIL = 0.1;

/** When the playhead reaches a clip (ms into the pass). */
const reached = (c: (typeof CLIPS)[number]) => Math.round((SCAN_MS * c.from) / VIDEO_S);

type Target = "head" | "span" | "link" | "tile" | "slot" | "dur";
/** `lands`: the tile's hinge; when it finishes, the tile is up. */
type Cue = { target: Target; i: number; at: number; ms: number; easing: string; keyframes: Keyframe[]; lands?: true };

/** The pass. Per clip, as the playhead reaches it: the span outlines, the
 *  connector draws down, the tile stands up (its own perspective, the
 *  free edge receding, hinged under the tape) while its slot fades, then
 *  its clip and caption play and its duration chip fades in. */
const clipsScore: { firstUp: number; captionAt: readonly number[]; cues: readonly Cue[] } = {
  // When the first tile starts to stand up (where a skipped pass starts).
  firstUp: reached(CLIPS[0]) + SPAN_MS + LINK_MS,
  captionAt: CLIPS.map((c) => reached(c) + SPAN_MS + LINK_MS + TILE_MS),
  cues: [
    {
      target: "head",
      i: 0,
      at: 0,
      ms: SCAN_MS,
      easing: "linear",
      keyframes: [
        { translate: "0 0", opacity: 1 },
        { translate: "100% 0", opacity: 1 },
      ],
    },
    ...CLIPS.flatMap((c, i): Cue[] => {
      const at = reached(c);
      const up = at + SPAN_MS + LINK_MS;
      return [
        { target: "span", i, at, ms: SPAN_MS, easing: EASE, keyframes: [{ opacity: 0 }, { opacity: 1 }] },
        {
          target: "link",
          i,
          at: at + SPAN_MS,
          ms: LINK_MS,
          easing: EASE,
          // Drawn from the span down (the curve only ever descends).
          keyframes: [{ clipPath: "inset(0 -2px 100% -2px)" }, { clipPath: "inset(0 -2px 0 -2px)" }],
        },
        {
          target: "tile",
          i,
          at: up,
          ms: TILE_MS,
          easing: SPRING_HINGE,
          keyframes: [{ transform: "perspective(40rem) rotateX(-70deg)" }, { transform: "perspective(40rem) rotateX(0deg)" }],
          lands: true,
        },
        { target: "tile", i, at: up, ms: TILE_FADE_MS, easing: EASE, keyframes: [{ opacity: 0 }, { opacity: 1 }] },
        { target: "slot", i, at: up + SLOT_AT, ms: SLOT_MS, easing: "ease", keyframes: [{ opacity: 1 }, { opacity: 0 }] },
        {
          target: "dur",
          i,
          at: up + TILE_MS,
          ms: DUR_MS,
          easing: EASE,
          keyframes: [
            { opacity: 0, translate: "0 4px" },
            { opacity: 1, translate: "0 0" },
          ],
        },
      ];
    }),
  ],
};

/** The pass starts once the tape (the cause) and the tiles (the effect)
 *  are both on screen, the tiles down to their captions and duration
 *  chips (in their lower third; on phones, where the slots already show
 *  where they stand, down to their middle). On a screen too short for
 *  both (phones held sideways): once the figure fills most of the clear
 *  area. */
const TAPE_SHOWN = 0.75;
const TILES_SHOWN = 0.8;
const TILES_SHOWN_PHONE = 0.6;
const FIG_SHOWN = 0.9;

/** No tile up yet (a pass is armed) / every tile up (at rest). */
const DOWN: readonly boolean[] = CLIPS.map(() => false);
const UP: readonly boolean[] = CLIPS.map(() => true);

/** Nothing to subscribe to: the value only differs between the server
 *  (and hydration) and the client. */
const noSubscription = () => () => {};
/** Can this browser run the pass? */
const canPass = () => typeof IntersectionObserver !== "undefined" && typeof Element.prototype.animate === "function";

/** One caption style for the three clips: Power where the language's
 *  script has it, else the first style that renders it natively. */
function clipPreset(lang: string): PresetId | null {
  if (presetSupport("power", lang).level !== "unavailable") return "power";
  const native = LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level === "native");
  return native ?? LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? null;
}

export function BonusClipsSection() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const moves = useClipsMove();
  const [paused, setPaused] = useState(false);
  // Which tiles have stood up in this pass. Without a pass (the server
  // HTML, reduced motion, an old browser) every tile stands.
  const [landed, setLanded] = useState(DOWN);
  const passes = useSyncExternalStore(noSubscription, canPass, () => false) && !reduced;
  const up = passes ? landed : UP;
  const preset = clipPreset(lang);
  // One string for the effect below: a new line in any clip resets them.
  const captions = CLIPS.map((c) => t(c.cap)).join("|");

  const figRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const spanRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const linkRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const slotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const durRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Plain ref objects for the captions' handles (stable across renders).
  const [capHandles] = useState(() => CLIPS.map(() => ({ current: null as LiveCaptionHandle | null })));
  // Which captions have an engine renderer, and the pass's hook to start
  // a caption whose renderer arrives late.
  const readyRef = useRef<boolean[]>(CLIPS.map(() => false));
  const kickRef = useRef<() => void>(() => {});
  const [onReady] = useState(() =>
    CLIPS.map((_, i) => () => {
      readyRef.current[i] = true;
      kickRef.current();
    }),
  );
  const passRef = useRef<"idle" | "armed" | "started">("idle");

  // The pass.
  useEffect(() => {
    const fig = figRef.current;
    const tape = tapeRef.current;
    const tiles = tilesRef.current;
    if (reduced || !fig || !tape || !tiles || typeof fig.animate !== "function" || typeof IntersectionObserver === "undefined") {
      return;
    }
    const elOf = (cue: Cue): Element | null =>
      cue.target === "head"
        ? headRef.current
        : cue.target === "span"
          ? spanRefs.current[cue.i]
          : cue.target === "link"
            ? linkRefs.current[cue.i]
            : cue.target === "slot"
              ? slotRefs.current[cue.i]
              : cue.target === "dur"
                ? durRefs.current[cue.i]
                : tileRefs.current[cue.i];
    let alive = true;
    let anims: Animation[] = [];
    // The tape has been on screen since the pass was armed (see skip).
    let tapeSeen = false;
    // Each arming is a new generation: a hinge that finishes reports its
    // tile up only for the pass it belongs to.
    let gen = 0;
    // The captions' clocks (s) and the pass's start (performance.now()).
    const capT = CLIPS.map(() => 0);
    const capDone = CLIPS.map(() => false);
    let t0 = 0;
    let stopClock: (() => void) | null = null;
    const halt = () => {
      stopClock?.();
      stopClock = null;
    };
    // Each caption plays once its tile is up and its renderer is ready;
    // the ticker stops when nothing is left to play.
    const tick = (dt: number) => {
      const now = performance.now() - t0;
      let busy = false;
      capHandles.forEach((h, i) => {
        const cap = h.current;
        if (!cap || capDone[i] || !readyRef.current[i]) return;
        busy = true;
        if (now < clipsScore.captionAt[i]) return;
        capT[i] += dt;
        if (capT[i] >= cap.duration) {
          capDone[i] = true;
          cap.seek(cap.duration);
        } else {
          cap.seek(capT[i]);
        }
      });
      if (!busy) halt();
    };
    const kick = () => {
      if (passRef.current === "started" && !stopClock) stopClock = subscribe(tick);
    };
    // Everything on the pass's first frame (the tiles down, their slots
    // drawn, their clips still); the captions wait on theirs (before the
    // first word: the tiles stand up clean).
    const arm = () => {
      halt();
      anims.forEach((a) => a.cancel());
      anims = [];
      const g = ++gen;
      for (const cue of clipsScore.cues) {
        const el = elOf(cue);
        if (!el) continue;
        const a = el.animate(cue.keyframes, { delay: cue.at, duration: cue.ms, easing: cue.easing, fill: "backwards" });
        a.pause();
        a.currentTime = 0;
        anims.push(a);
        if (cue.lands) {
          a.finished.then(
            () => {
              if (alive && g === gen) setLanded((was) => was.map((v, j) => v || j === cue.i));
            },
            () => {},
          );
        }
      }
      capT.fill(0);
      capDone.fill(false);
      capHandles.forEach((h) => h.current?.seek(0));
      tapeSeen = false;
      passRef.current = "armed";
    };
    // The figure's own entrance (page.tsx) finishes first, so it never
    // moves while the pass starts.
    let waiting = false;
    const play = () => {
      if (passRef.current !== "armed" || document.hidden) return;
      const entrance = fig.getAnimations().filter((a) => a.playState !== "finished");
      if (entrance.length) {
        if (!waiting) {
          waiting = true;
          void Promise.allSettled(entrance.map((a) => a.finished)).then(() => {
            waiting = false;
            if (alive && shown()) play();
          });
        }
        return;
      }
      passRef.current = "started";
      anims.forEach((a) => a.play());
      t0 = performance.now();
      kick();
    };
    kickRef.current = kick;
    arm();
    // Scrolled past before it could start (the tape came in from below
    // and has gone above while the tiles are still on screen): the pass
    // starts where the first tile stands up, the scan above already out
    // of sight, so the tiles still stand up and come alive one by one
    // where they are seen, instead of leaving their slots empty or
    // popping up all at once. Coming back up from below the figure, it
    // waits for the tape as usual.
    const skip = () => {
      if (passRef.current !== "armed") return;
      passRef.current = "started";
      const from = clipsScore.firstUp;
      // play() first: seeking a finished animation and then playing it
      // would rewind it to its start.
      anims.forEach((a) => {
        a.play();
        a.currentTime = from;
      });
      t0 = performance.now() - from;
      kick();
    };
    const phone = window.matchMedia("(max-width: 767px)");
    const ratio = new Map<Element, number>();
    const above = new Map<Element, boolean>();
    const shown = () =>
      ((ratio.get(tape) ?? 0) >= TAPE_SHOWN - 0.01 &&
        (ratio.get(tiles) ?? 0) >= (phone.matches ? TILES_SHOWN_PHONE : TILES_SHOWN) - 0.01) ||
      (ratio.get(fig) ?? 0) >= FIG_SHOWN - 0.01;
    // Fully out of view: back to the first frame for the next entry, the
    // tiles down again.
    const away = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting && passRef.current === "started") {
        arm();
        setLanded(DOWN);
      }
    });
    away.observe(fig);
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          ratio.set(e.target, passShare(e));
          above.set(e.target, !e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0));
        }
        if ((ratio.get(tape) ?? 0) > 0) tapeSeen = true;
        if (shown()) play();
        else if (tapeSeen && above.get(tape) && (ratio.get(tiles) ?? 0) > 0) skip();
      },
      { threshold: PASS_THRESHOLDS, rootMargin: PASS_ROOT_MARGIN },
    );
    near.observe(tape);
    near.observe(tiles);
    near.observe(fig);
    const onVisibility = () => {
      if (shown()) play();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      away.disconnect();
      near.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      halt();
      anims.forEach((a) => a.cancel());
      kickRef.current = () => {};
      // Back to the settled state, the captions on their last page too
      // (hydration arms once before reduced motion is known).
      capHandles.forEach((h) => h.current?.seek(h.current.duration));
      passRef.current = "idle";
      // A pass armed again starts with every tile down.
      setLanded(DOWN);
    };
  }, [reduced, capHandles]);

  // New lines or a new style (the page language arriving) rebuild the
  // renderers and put each caption on its settled page: while armed, it
  // waits on its first frame instead; after a pass, it keeps the end.
  useEffect(() => {
    readyRef.current = CLIPS.map(() => false);
    const armed = passRef.current === "armed";
    capHandles.forEach((h) => h.current?.seek(armed ? 0 : h.current.duration));
  }, [lang, captions, preset, capHandles]);

  return (
    <section className={styles.section} aria-labelledby="clips-title">
      <div className={styles.wrap}>
        <h2 id="clips-title" className={styles.h2}>
          {t("site.clips.title")}
        </h2>
        <p className={styles.body}>{t("site.clips.body", { count: MAX_HOOK_CLIPS })}</p>

        <div ref={figRef} className={f.clipsFig} data-entrance="frame">
          <div className={f.tapeBox} aria-hidden="true">
            <span className={cx(styles.frameTag, f.tapeTag)}>{t("site.demo.example")}</span>
            <div ref={tapeRef} className={f.tape}>
              {CLIPS.map((c, i) => (
                <span
                  key={c.from}
                  ref={(el) => {
                    spanRefs.current[i] = el;
                  }}
                  className={f.span}
                  style={{ "--from": c.from / VIDEO_S, "--to": c.to / VIDEO_S } as React.CSSProperties}
                />
              ))}
              <div className={f.scan}>
                <div ref={headRef} className={f.head} />
              </div>
            </div>
          </div>

          <div className={f.links} aria-hidden="true">
            {TICKS.map((s) => (
              <span key={s} className={f.tick} style={{ "--at": s / VIDEO_S } as React.CSSProperties} />
            ))}
            {MARKS.map((s, i) => (
              <span
                key={s}
                className={cx(f.mark, i === 0 && f.markStart, i === MARKS.length - 1 && f.markEnd)}
                style={{ "--at": s / VIDEO_S } as React.CSSProperties}
              >
                {clock(s)}
              </span>
            ))}
            {/* Connectors: from each span's bottom centre to its tile's top
                centre, laid out by the same CSS clamp as the tiles. */}
            {CLIPS.map((c, i) => (
              <span
                key={c.from}
                ref={(el) => {
                  linkRefs.current[i] = el;
                }}
                className={f.link}
                data-bend={bend(c, i)}
                style={{ "--i": i, "--c": mid(c) } as React.CSSProperties}
              >
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                  <path d={bend(c, i) === "right" ? "M0 0C0 55 100 45 100 100" : "M100 0C100 55 0 45 0 100"} />
                </svg>
              </span>
            ))}
          </div>

          <div ref={tilesRef} className={f.tiles} aria-hidden="true">
            {/* Where each tile will stand (under the tiles). */}
            {CLIPS.map((c, i) => (
              <span
                key={c.from}
                ref={(el) => {
                  slotRefs.current[i] = el;
                }}
                className={f.slot}
                style={{ "--i": i, "--c": mid(c) } as React.CSSProperties}
              />
            ))}
            {CLIPS.map((c, i) => (
              <div
                key={c.from}
                ref={(el) => {
                  tileRefs.current[i] = el;
                }}
                className={cx(styles.frame, f.tile)}
                style={{ "--i": i, "--c": mid(c) } as React.CSSProperties}
              >
                <Scene clip={c.clip} playing={!paused && up[i]} />
                {preset && (
                  <LiveCaption
                    preset={preset}
                    overrides={SMALL_FRAME_OVERRIDES[preset]}
                    text={t(c.cap)}
                    lang={lang}
                    playing={false}
                    loop={false}
                    hold={CAP_TAIL}
                    onReady={onReady[i]}
                    handle={capHandles[i]}
                  >
                    <CaptionPoster preset={preset} text={t(c.cap)} className={preset === "karaoke" ? f.capLarge : undefined} />
                  </LiveCaption>
                )}
                <span
                  ref={(el) => {
                    durRefs.current[i] = el;
                  }}
                  className={f.dur}
                >
                  {clock(c.to - c.from)}
                </span>
              </div>
            ))}
          </div>

          {/* The figure is decoration (each part aria-hidden); the
              clips' pause control is not. It shows once a clip is up. */}
          {moves && <LoopToggle place="row" paused={paused} onToggle={() => setPaused((p) => !p)} shown={up.some(Boolean)} />}
        </div>
      </div>
    </section>
  );
}
