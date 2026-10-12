"use client";
/**
 * Caption styles as a player: one 9:16 frame of the synthetic recording
 * with the real caption engine drawing the sample sentence, and a picker
 * of every style the page's language can show.
 *
 * - First entry (the player at least half on screen): a short tour plays
 *   four contrasting styles once each (power, karaoke, clipper, elegant;
 *   unsupported ones replaced by the next supported style). The frame
 *   names the style on screen; its chip carries a progress line. The tour
 *   never moves the selection. Then the language's default style loops.
 * - The visitor's first pick (click or arrow key) ends the tour for the
 *   session; the picked style starts from its first word and loops.
 * - Paused by the pause button (on a settled page, never an empty one),
 *   off screen and in hidden tabs.
 * - Reduced motion: no tour, no loop; the engine draws each style's
 *   settled last page, and a pick redraws it at once.
 */
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { presetSupport, scriptOfLang } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import type { PresetId } from "@/lib/captions/types";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "../CaptionFrame";
import { Scene } from "../scene/Scene";
import { useDocumentVisible, useReducedMotion } from "../shared";
import { loadEngine } from "./engine";
import { LiveCaption, type LiveCaptionHandle } from "./LiveCaption";
import { subscribe } from "./ticker";
import { captionWords, spokenUntil } from "./words";
import L from "../Landing.module.css";
import s from "./CaptionPlayer.module.css";

/** The tour: four styles that look nothing alike. */
const TOUR: readonly PresetId[] = ["power", "karaoke", "clipper", "elegant"];
const TOUR_LENGTH = 4;
/** Set once the visitor has picked: no tour again in this tab. */
const TOUR_DONE_KEY = "cleocuts.captionTour";
/** Seconds after the last word before the next pass. The engine clears
 *  the page about 0.36 s after the last word, so a longer hold would
 *  only show an empty frame. */
const HOLD = 0.5;

function tourOf(supported: readonly PresetId[]): PresetId[] {
  const out = TOUR.filter((id) => supported.includes(id));
  for (const id of supported) {
    if (out.length >= TOUR_LENGTH) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

type Phase = "idle" | "tour" | "done";
type PlayState = { phase: Phase; step: number; nonce: number; picked: PresetId | null };
type Action = { type: "enter"; tour: boolean } | { type: "cycle"; steps: number } | { type: "pick"; id: PresetId };

/** `nonce` changes whenever the caption must start over from its first word. */
function reduce(state: PlayState, action: Action): PlayState {
  switch (action.type) {
    case "enter":
      if (state.phase !== "idle") return state;
      return { ...state, phase: action.tour ? "tour" : "done", step: 0, nonce: state.nonce + 1 };
    case "cycle":
      if (state.phase !== "tour") return state;
      if (state.step + 1 < action.steps) return { ...state, step: state.step + 1, nonce: state.nonce + 1 };
      return { ...state, phase: "done", nonce: state.nonce + 1 };
    case "pick":
      return { ...state, phase: "done", picked: action.id, nonce: state.nonce + 1 };
  }
}

function tourAllowed(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    return sessionStorage.getItem(TOUR_DONE_KEY) === null;
  } catch {
    return true;
  }
}

type Clock = { t: number; line: Animation | null };

/** Moves the mirror clock (and the progress line it drives) to `time`. */
function setClock(clock: Clock, handle: LiveCaptionHandle | null, time: number): void {
  clock.t = time;
  if (!clock.line) return;
  const d = handle?.duration ?? 0;
  clock.line.currentTime = d > 0 ? Math.min(1, time / d) * 1000 : 0;
}

/** Runs `fn` when the main thread is idle (Safari: shortly). */
function whenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 2000 });
  else window.setTimeout(fn, 200);
}

export function CaptionPlayerSection() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const docVisible = useDocumentVisible();
  const labelId = useId();
  const text = t("site.demo.caption");

  // Only styles that can caption this language ('unavailable' is never shown).
  const supported = useMemo<PresetId[]>(
    () => LAUNCH_PRESETS.filter((id) => presetSupport(id, lang).level !== "unavailable"),
    [lang],
  );
  const fallback: PresetId | undefined = supported.includes("power") ? "power" : supported[0];
  const tour = useMemo(() => tourOf(supported), [supported]);

  const [play, dispatch] = useReducer(reduce, { phase: "idle", step: 0, nonce: 0, picked: null });
  const [paused, setPaused] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [announce, setAnnounce] = useState("");

  const selected = play.picked && supported.includes(play.picked) ? play.picked : fallback;
  // Without the engine nothing plays: the tour waits, the poster shows.
  const touring = play.phase === "tour" && !reduced && engineReady;
  const shown = (play.phase === "tour" && !reduced ? tour[play.step] : undefined) ?? selected;
  const running = !reduced && !paused && onScreen && docVisible && play.phase !== "idle";
  const restartKey = `${shown}:${play.nonce}:${reduced ? "still" : "live"}`;
  const name = (id: PresetId) => t(`editor.style.preset.${id}` as MessageKey);

  const words = useMemo(() => captionWords(text, lang), [text, lang]);
  const wordTexts = useMemo(() => words.map((w) => w.text), [words]);
  const firstWord = words.length ? words[0].start : 0;
  const lastWord = spokenUntil(words);

  // On screen at all: run. At least half on screen the first time: the tour.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        setOnScreen(e.isIntersecting);
        if (e.isIntersecting && e.intersectionRatio >= 0.5) dispatch({ type: "enter", tour: tourAllowed() });
      },
      { threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Fonts ahead of time, so a style starts the moment it is picked: the
  // next tour step while the current one plays, every other style once
  // the tour is over or the picker is reached (Latin and Cyrillic faces
  // are small; CJK and Devanagari are fetched per pick).
  const warmed = useRef(new Set<string>());
  const warm = useCallback(
    (id: PresetId | undefined): Promise<unknown> => {
      const key = `${lang}:${id}`;
      if (!id || warmed.current.has(key)) return Promise.resolve();
      warmed.current.add(key);
      return loadEngine()
        .then((engine) => {
          const style = engine.resolveStyle(id);
          return style ? engine.ensureFonts(style, { lang, text: wordTexts }) : null;
        })
        .catch(() => {
          warmed.current.delete(key);
        });
    },
    [lang, wordTexts],
  );
  const restWarmed = useRef<string | null>(null);
  const warmRest = useCallback(() => {
    const script = scriptOfLang(lang);
    if (restWarmed.current === lang || (script !== "latin" && script !== "cyrillic")) return;
    restWarmed.current = lang;
    const queue = supported.slice();
    const next = () => {
      const id = queue.shift();
      if (id) void warm(id).then(() => whenIdle(next));
    };
    whenIdle(next);
  }, [lang, supported, warm]);
  useEffect(() => {
    if (touring) void warm(tour[play.step + 1]);
  }, [touring, tour, play.step, warm]);
  useEffect(() => {
    if (engineReady && play.phase === "done") warmRest();
  }, [engineReady, play.phase, warmRest]);

  // A mirror of the caption's clock: the same ticker, the same time
  // steps, reset where the caption resets. It drives the tour's progress
  // line and tells the pause button where the pass is.
  const handleRef = useRef<LiveCaptionHandle>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const clock = useRef<Clock>({ t: 0, line: null });
  const lines = useRef(new Map<PresetId, Animation>());
  const runningRef = useRef(running);
  const restartPending = useRef(true);
  useEffect(() => {
    runningRef.current = running;
  });

  useEffect(() => {
    clock.current.t = 0;
  }, [restartKey, words]);
  useEffect(() => {
    restartPending.current = true;
  }, [shown, words]);

  // The progress line of the chip on screen: a paused animation that the
  // clock scrubs (linear: it is the caption's playhead).
  useEffect(() => {
    if (!touring) {
      clock.current.line = null;
      return;
    }
    const el = groupRef.current?.querySelector<HTMLElement>(`[data-id="${shown}"] [data-line]`);
    if (!el || typeof el.animate !== "function") return;
    const map = lines.current;
    map.get(shown)?.cancel();
    const anim = el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: 1000,
      easing: "linear",
      fill: "both",
    });
    anim.pause();
    anim.currentTime = 0;
    map.set(shown, anim);
    clock.current.line = anim;
  }, [touring, shown, play.nonce]);

  useEffect(() => {
    const map = lines.current;
    return () => map.forEach((a) => a.cancel());
  }, []);

  const ticking = running && engineReady;
  useEffect(() => {
    if (!ticking) return;
    return subscribe((dt) => setClock(clock.current, handleRef.current, clock.current.t + dt));
  }, [ticking]);

  const onCycle = () => {
    setClock(clock.current, handleRef.current, 0);
    dispatch({ type: "cycle", steps: tour.length });
  };

  // A new style's renderer is ready: start it from its first word (the
  // caption's clock kept running while its fonts loaded).
  const onReady = () => {
    setEngineReady(true);
    if (!restartPending.current) return;
    restartPending.current = false;
    if (!runningRef.current) return;
    handleRef.current?.seek(0);
    setClock(clock.current, handleRef.current, 0);
  };

  const togglePause = () => {
    // Pausing between two passes would hold an empty frame: hold the
    // settled page instead.
    if (!paused && running && engineReady) {
      const now = clock.current.t;
      if (now < firstWord + 0.1 || now > lastWord + 0.3) {
        handleRef.current?.seek(lastWord);
        setClock(clock.current, handleRef.current, lastWord);
      }
    }
    setPaused((p) => !p);
  };

  const pick = (id: PresetId) => {
    dispatch({ type: "pick", id });
    const message = t("site.captions.frameAria", { style: name(id) });
    // the same text again would not be announced
    setAnnounce((prev) => (prev === message ? `${message} ` : message));
    try {
      sessionStorage.setItem(TOUR_DONE_KEY, "1");
    } catch {
      /* storage blocked: the tour simply stays ended for this page */
    }
  };

  // A tap on a chip whose caption is scrolled away (small phones): bring
  // the caption back into view.
  const revealCaption = () => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const band = r.top + r.height * 0.5;
    if (band < 0) window.scrollBy({ top: band - 16, behavior: reduced ? "auto" : "smooth" });
  };

  // WAI-ARIA radio group: arrows, Home and End move focus and selection.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = supported.length;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (i + 1) % n;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (i - 1 + n) % n;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    pick(supported[next]);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const warmChips = () => {
    if (engineReady) warmRest();
  };

  return (
    <section className={s.band} aria-labelledby="captions-title">
      <div className={L.wrap}>
        <div className={s.layout}>
          <div className={s.lead}>
            <h2 id="captions-title" className={L.h2}>
              {t("site.captions.title")}
            </h2>
            <p className={L.body}>{t("site.captions.body")}</p>
          </div>

          {shown && (
            <div ref={stageRef} className={s.stage}>
              <div className={s.shell}>
                <div
                  className={cx(L.frame, s.frame)}
                  role="img"
                  aria-label={t("site.captions.frameAria", { style: name(shown) })}
                >
                  <Scene crop="vertical" talking={running} />
                  <LiveCaption
                    preset={shown}
                    text={text}
                    lang={lang}
                    playing={running}
                    loop
                    hold={HOLD}
                    restartKey={restartKey}
                    onCycle={onCycle}
                    onReady={onReady}
                    handle={handleRef}
                  >
                    <CaptionPoster preset={shown} text={text} />
                  </LiveCaption>
                  <div className={s.tags}>
                    <span className={cx(L.frameTag, s.tag)}>{t("site.demo.example")}</span>
                    <span className={cx(L.frameTag, s.tag, s.styleTag)} aria-hidden="true">
                      {name(shown)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {supported.length > 0 && (
            <div className={s.controls}>
              <div className={s.pickRow}>
                <p id={labelId} className={s.pickLabel}>
                  {t("site.captions.pick")}
                </p>
                {!reduced && (
                  <IconButton
                    label={paused ? t("site.demo.play") : t("site.demo.pause")}
                    className={s.toggle}
                    onClick={togglePause}
                  >
                    <Icon icon={paused ? Play : Pause} size={16} />
                  </IconButton>
                )}
              </div>
              <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                className={s.chips}
                data-touring={touring || undefined}
                onFocus={warmChips}
                onPointerEnter={warmChips}
              >
                {supported.map((id, i) => {
                  const checked = id === selected;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      data-id={id}
                      data-playing={touring && id === shown ? "" : undefined}
                      className={s.chip}
                      onClick={(e) => {
                        pick(id);
                        if (e.detail > 0) revealCaption();
                      }}
                      onKeyDown={(e) => onKeyDown(e, i)}
                      onPointerEnter={() => {
                        if (engineReady) void warm(id);
                      }}
                    >
                      {name(id)}
                      <span className={s.line} data-line="" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className={s.note}>{t("site.auto.cleanup")}</p>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announce}
          </p>
        </div>
      </div>
    </section>
  );
}
