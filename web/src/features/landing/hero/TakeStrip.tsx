"use client";
/**
 * The hero demo: one recording as a tape lying in 3D, and the finished
 * 9:16 video it becomes. In an endless loop it tells the headline in two
 * acts (hero/score.ts): "You talk" (a playhead records, each command
 * flags where it was said) and "Cleo edits" (the bad take, a filler
 * word, a pause and the skipped sentence lift off, the tape closes
 * behind them and gets visibly shorter), then the video lights up and
 * its captions play, drawn by the real caption engine.
 *
 * A step machine: each step is data-* attributes and per-piece
 * translates; CSS transitions move between steps, so the holds cost
 * nothing. It runs while on screen and the tab is visible, unless the
 * visitor paused it (WCAG 2.2.2). Reduced motion shows the finished
 * still. The first frame is the finished video, so a screenshot or a
 * slow start shows the result, and the first motion is the result
 * playing, never an undo.
 *
 * The stage is decoration for sighted visitors (aria-hidden); the list
 * under it says the same in words.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Scene } from "../scene/Scene";
import { CMD_COLOR, Cmd, useDocumentVisible, useInView, useReducedMotion } from "../shared";
import { AT, FINISHED, FIRST, MARKED, PIECES, POSTS, STEPS, shiftAt, type FlagId, type LegendId, type PieceId, type Step } from "./score";
import styles from "./Hero.module.css";

const LEGEND: { id: LegendId; key: "site.demo.take" | "site.demo.fillers" | "site.demo.pauses" | "site.demo.skip" | "site.demo.captions" }[] = [
  { id: "take", key: "site.demo.take" },
  { id: "fillers", key: "site.demo.fillers" },
  { id: "pauses", key: "site.demo.pauses" },
  { id: "skip", key: "site.demo.skip" },
  { id: "captions", key: "site.demo.captions" },
];

/** The flag's target on the tape: a post, or the middle of a piece. */
const FLAG_TARGET: Record<FlagId, { post?: string; piece?: PieceId }> = {
  start: { post: "start" },
  cut: { post: "cut" },
  stop: { post: "stop" },
  stopgo: { post: "go" },
  finish: { post: "finish" },
  cutTake: { piece: "bad" },
  um: { piece: "um" },
  pause: { piece: "pause" },
  skip: { piece: "skip" },
};

/** Where the playhead is at the end of each talk step (% of the tape). */
const HEAD_TO: Partial<Record<FlagId, number>> = { start: AT.a, cut: AT.skip, stop: AT.c, stopgo: AT.post, finish: AT.post };

/** The caption style the hero's video uses in this language. */
function heroPreset(lang: string): PresetId {
  if (presetSupport("power", lang).level !== "unavailable") return "power";
  return LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? "power";
}

type Chip = { key: number; flag: FlagId; leaving?: boolean };

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

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => {
      // The loop wraps to the captions step (the first hold plays once).
      const next = i === STEPS.length - 1 ? 1 : i + 1;
      if (next === 1) setCycle((c) => c + 1);
      setI(next);
    }, STEPS[i].ms);
    return () => window.clearTimeout(id);
  }, [running, i]);

  const s: Step = reduced ? FINISHED : STEPS[i];
  const gone = useMemo(() => new Set<PieceId>(s.gone), [s.gone]);
  const marked = useMemo(() => new Set<PieceId>(s.mark ?? []), [s.mark]);
  const preset = heroPreset(lang);

  // Flags: one at a time, over their post or piece; the previous one
  // fades out where it was. Placed on the screen after each step (the
  // tape is in perspective) and kept inside the rail.
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const postRefs = useRef(new Map<string, HTMLElement>());
  const pieceRefs = useRef(new Map<PieceId, HTMLElement>());
  const prevFlag = !reduced && i > 0 ? STEPS[i - 1].flag : undefined;
  const chips: Chip[] = [];
  if (prevFlag && prevFlag !== s.flag) chips.push({ key: i - 1, flag: prevFlag, leaving: true });
  if (s.flag) chips.push({ key: i, flag: s.flag });
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const rr = rail.getBoundingClientRect();
    for (const el of rail.children as HTMLCollectionOf<HTMLElement>) {
      const f = el.dataset.flag as FlagId | undefined;
      if (!f || el.dataset.placed) continue;
      const target = FLAG_TARGET[f];
      const anchor = target.post ? postRefs.current.get(target.post) : target.piece ? pieceRefs.current.get(target.piece) : null;
      if (!anchor) continue;
      const r = anchor.getBoundingClientRect();
      const x = r.left + r.width / 2 - rr.left;
      const half = el.offsetWidth / 2;
      el.style.left = `${Math.min(Math.max(x, half), Math.max(half, rr.width - half))}px`;
      el.dataset.placed = "1";
    }
  }, [i]);

  const filler = t("site.demo.filler");
  const chipBody = (f: FlagId) => {
    switch (f) {
      case "start":
        return <Cmd id="start" />;
      case "cut":
      case "cutTake":
        return <Cmd id="cut" />;
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
  const chipColor = (f: FlagId) =>
    f === "start" ? CMD_COLOR.start : f === "cut" || f === "cutTake" ? CMD_COLOR.cut : f === "finish" ? CMD_COLOR.finish : f === "stop" || f === "stopgo" || f === "skip" ? CMD_COLOR.stop : undefined;

  const headX = s.flag && HEAD_TO[s.flag] !== undefined ? HEAD_TO[s.flag]! : AT.bad;
  const phaseText = s.phase === "talk" ? t("site.demo.phaseTalk") : s.phase === "edit" ? t("site.demo.phaseEdit") : t("site.demo.phaseReady");
  const legendNow = LEGEND.find((l) => l.id === s.li);
  const status = s.phase === "edit" && legendNow ? t(legendNow.key) : phaseText;
  const caption = t("site.demo.caption");

  return (
    <div
      ref={ref}
      className={styles.demo}
      data-phase={s.phase ?? ""}
      data-fade={s.fade ?? ""}
      data-frame={s.frame}
      data-play={s.play ? "on" : ""}
      data-running={running}
    >
      <div ref={stageRef} className={styles.stage} aria-hidden="true">
        <div ref={railRef} className={styles.rail}>
          {chips.map((c) => (
            <span
              key={c.key}
              className={styles.chip}
              data-leaving={c.leaving ? "true" : undefined}
              data-flag={c.flag}
              style={{ "--rc": chipColor(c.flag) } as React.CSSProperties}
            >
              {chipBody(c.flag)}
            </span>
          ))}
        </div>

        <div className={styles.stripArea}>
          <div className={styles.strip}>
            <div className={styles.track}>
              {PIECES.map((p, n) => {
                const state = gone.has(p.id) ? "gone" : marked.has(p.id) ? "mark" : "";
                return (
                  <div key={p.id} className={styles.lane} style={{ transform: `translateX(${-shiftAt(AT[p.id], gone)}%)` }}>
                    <span
                      ref={(el) => {
                        if (el) pieceRefs.current.set(p.id, el);
                        else pieceRefs.current.delete(p.id);
                      }}
                      className={cx(styles.piece, styles[p.kind])}
                      data-state={state}
                      style={
                        {
                          left: `${AT[p.id]}%`,
                          width: `${p.g}%`,
                          "--c": p.cmd ? CMD_COLOR[p.cmd] : "var(--text-muted)",
                          "--n": n,
                        } as React.CSSProperties
                      }
                    >
                      <span className={styles.mark} />
                      {p.kind === "filler" && <span className={styles.um}>{filler}</span>}
                    </span>
                  </div>
                );
              })}
              {MARKED.map((m) =>
                gone.has(m.id) ? (
                  <div key={`cut-${m.id}`} className={styles.lane} style={{ transform: `translateX(${-shiftAt(AT[m.id], gone)}%)` }}>
                    <span className={styles.marker} data-tone={m.tone} style={{ left: `${AT[m.id]}%` }} />
                  </div>
                ) : null,
              )}
              {POSTS.map((p) => {
                const left = p.leavesWith && gone.has(p.leavesWith);
                const flash = s.flash === p.id || (s.flash === "ends" && (p.id === "start" || p.id === "finish"));
                return (
                  <div key={p.id} className={styles.lane} style={{ transform: `translateX(${-shiftAt(p.at, gone)}%)` }}>
                    <span
                      ref={(el) => {
                        if (el) postRefs.current.set(p.id, el);
                        else postRefs.current.delete(p.id);
                      }}
                      className={styles.post}
                      data-gone={left ? "true" : undefined}
                      data-flash={flash ? "true" : undefined}
                      style={{ left: `${p.at}%`, "--pc": CMD_COLOR[p.cmd] } as React.CSSProperties}
                    />
                  </div>
                );
              })}
              <div
                className={styles.headLane}
                data-head={s.head ?? ""}
                style={{ transform: `translateX(${headX}%)`, transitionDuration: s.head === "run" ? `${s.ms}ms` : "0ms" }}
              />
            </div>
          </div>
        </div>

        <div className={styles.video}>
          <div className={styles.screen}>
            <Scene pose="center" talking={running && !!s.play} className={styles.scene} />
            <div className={styles.captionLayer}>
              <LiveCaption
                preset={preset}
                text={caption}
                lang={lang}
                playing={running && !!s.play}
                loop={false}
                hold={0.4}
                restartKey={cycle}
              >
                <CaptionPoster preset={preset} text={caption} />
              </LiveCaption>
            </div>
            <span className={styles.scrim} />
            <span className={styles.tag}>{t("site.demo.example")}</span>
            <span className={styles.scrub}>
              <span className={styles.scrubHead} style={{ transitionDuration: s.play ? `${s.ms}ms` : "0ms" }} />
            </span>
          </div>
        </div>
      </div>

      <div className={styles.under}>
        <p className={styles.phase} aria-hidden="true">
          <span key={s.phase} className={styles.phaseText}>
            {phaseText}
          </span>
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
          <span key={status} className={styles.statusText}>
            {status}
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
