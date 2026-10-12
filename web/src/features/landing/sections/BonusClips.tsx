"use client";
/**
 * Bonus clips: "Bonus clips from longer videos." The finished 3-minute
 * video lies flat as a tape with a time ruler. A playhead scans it, and
 * each picked moment goes through the same chain as the playhead reaches
 * it: its span outlines, a connector runs down from it, its 9:16 clip
 * stands up out of the tape, and its caption plays once. The three clips
 * are cut from the same captioned video, so they share one caption style:
 * Power, or the language's first native style where Power is unavailable
 * (Hindi: Karaoke).
 *
 * One pass (~2 s, then the captions; under 5 s in every language) once
 * the tape and the tiles are in view in a visible tab; re-armed when the
 * figure is fully out of view, so it plays again on re-entry. Every part
 * takes its timing from `clipsScore` (WAAPI on translate, transform,
 * opacity and clip-path). The base CSS is the settled end state (spans
 * outlined, connectors drawn, tiles upright, captions settled): reduced
 * motion, screenshots and the server HTML.
 *
 * The captions run on their own clocks (the page's one ticker), and each
 * starts only once its engine and font are ready: a slow font load
 * delays the words, it never leaves a clip blank or frozen mid-sentence.
 */
import { useEffect, useRef, useState } from "react";
import { useLang, useT } from "@/i18n";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { presetSupport } from "@/lib/captions/scripts";
import type { PresetId, StyleOverrides } from "@/lib/captions/types";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "../CaptionFrame";
import { LiveCaption, type LiveCaptionHandle } from "../captions/LiveCaption";
import { subscribe } from "../captions/ticker";
import { Scene, type ShotId } from "../scene/Scene";
import { useReducedMotion } from "../shared";
import styles from "../Landing.module.css";
import f from "./Format.module.css";

/** Bonus clips: at most this many (backend/llm.py detect_hook_moments). */
const MAX_HOOK_CLIPS = 3;

/** Karaoke (Hindi) draws at 0.078 of the width: on the small tiles it
 *  gets 1.6x and two words a page, so it stays legible. */
const CLIP_OVERRIDES: Partial<Record<PresetId, StyleOverrides>> = { karaoke: { sizeScale: 1.6, wordsPerPage: 2 } };

/** The finished video, in seconds. */
const VIDEO_S = 180;
/** The picked clips (seconds into the finished video), each its own
 *  moment of the trip video. */
const CLIPS: readonly { from: number; to: number; shot: ShotId }[] = [
  { from: 10, to: 34, shot: "globe" },
  { from: 65, to: 106, shot: "map" },
  { from: 135, to: 168, shot: "shirt" },
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

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const SCAN_MS = 1200;
const SPAN_MS = 200;
const LINK_MS = 240;
const TILE_MS = 560;
/** Each caption holds its last page this long after the last word (s). */
const CAP_TAIL = 0.1;

/** When the playhead reaches a clip (ms into the pass). */
const reached = (c: (typeof CLIPS)[number]) => Math.round((SCAN_MS * c.from) / VIDEO_S);

type Target = "head" | "span" | "link" | "tile";
type Cue = { target: Target; i: number; at: number; ms: number; easing: string; keyframes: Keyframe[] };

/** The pass. Per clip, as the playhead reaches it: the span outlines, the
 *  connector draws down, the tile stands up (its own perspective, the
 *  free edge receding, hinged under the tape), then its caption plays. */
const clipsScore: { captionAt: readonly number[]; cues: readonly Cue[] } = {
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
          at: at + SPAN_MS + LINK_MS,
          ms: TILE_MS,
          easing: EASE,
          keyframes: [
            { transform: "perspective(40rem) rotateX(-70deg)", opacity: 0 },
            { transform: "perspective(40rem) rotateX(0deg)", opacity: 1 },
          ],
        },
      ];
    }),
  ],
};

/** The pass starts once the tape (the cause) and the tiles (the effect)
 *  are both on screen. */
const TAPE_SHOWN = 0.75;
const TILES_SHOWN = 0.5;

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
  const preset = clipPreset(lang);
  const caption = t("site.demo.caption");

  const figRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const spanRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const linkRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
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
            : tileRefs.current[cue.i];
    let anims: Animation[] = [];
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
    // Everything on the pass's first frame; the captions wait on theirs
    // (before the first word: the tiles stand up clean).
    const arm = () => {
      halt();
      anims.forEach((a) => a.cancel());
      anims = [];
      for (const cue of clipsScore.cues) {
        const el = elOf(cue);
        if (!el) continue;
        const a = el.animate(cue.keyframes, { delay: cue.at, duration: cue.ms, easing: cue.easing, fill: "backwards" });
        a.pause();
        a.currentTime = 0;
        anims.push(a);
      }
      capT.fill(0);
      capDone.fill(false);
      capHandles.forEach((h) => h.current?.seek(0));
      passRef.current = "armed";
    };
    const play = () => {
      if (passRef.current !== "armed" || document.hidden) return;
      passRef.current = "started";
      anims.forEach((a) => a.play());
      t0 = performance.now();
      kick();
    };
    kickRef.current = kick;
    arm();
    const ratio = new Map<Element, number>();
    const shown = () =>
      (ratio.get(tape) ?? 0) >= TAPE_SHOWN - 0.01 && (ratio.get(tiles) ?? 0) >= TILES_SHOWN - 0.01;
    // Fully out of view: back to the first frame for the next entry.
    const away = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting && passRef.current === "started") arm();
    });
    away.observe(fig);
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratio.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
        if (shown()) play();
      },
      { threshold: [0, TILES_SHOWN, TAPE_SHOWN, 1] },
    );
    near.observe(tape);
    near.observe(tiles);
    const onVisibility = () => {
      if (shown()) play();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
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
    };
  }, [reduced, capHandles]);

  // A new sentence or style (the page language arriving) rebuilds the
  // renderers and puts each caption on its settled page: while armed, it
  // waits on its first frame instead; after a pass, it keeps the end.
  useEffect(() => {
    readyRef.current = CLIPS.map(() => false);
    const armed = passRef.current === "armed";
    capHandles.forEach((h) => h.current?.seek(armed ? 0 : h.current.duration));
  }, [lang, caption, preset, capHandles]);

  return (
    <section className={styles.section} aria-labelledby="clips-title">
      <div className={styles.wrap}>
        <h2 id="clips-title" className={styles.h2}>
          {t("site.clips.title")}
        </h2>
        <p className={styles.body}>{t("site.clips.body", { count: MAX_HOOK_CLIPS })}</p>

        <div ref={figRef} className={f.clipsFig} aria-hidden="true">
          <div className={f.tapeBox}>
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

          <div className={f.links}>
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

          <div ref={tilesRef} className={f.tiles}>
            {CLIPS.map((c, i) => (
              <div
                key={c.from}
                ref={(el) => {
                  tileRefs.current[i] = el;
                }}
                className={cx(styles.frame, f.tile)}
                style={{ "--i": i, "--c": mid(c) } as React.CSSProperties}
              >
                <Scene shot={c.shot} sizes="8.5rem" />
                {preset && (
                  <LiveCaption
                    preset={preset}
                    overrides={CLIP_OVERRIDES[preset]}
                    text={caption}
                    lang={lang}
                    playing={false}
                    loop={false}
                    hold={CAP_TAIL}
                    onReady={onReady[i]}
                    handle={capHandles[i]}
                  >
                    <CaptionPoster preset={preset} text={caption} className={preset === "karaoke" ? f.capLarge : undefined} />
                  </LiveCaption>
                )}
                <span className={f.dur}>{clock(c.to - c.from)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
