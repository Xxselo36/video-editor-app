"use client";
/**
 * Caption styles as a ring: three phone videos of the creator stand on a
 * slowly turning 3D ring, one in front and one on each side. The one in
 * front plays its caption word by word, drawn live by the real caption
 * engine, in three of the most viral looks: Power, Highlight Box and
 * Clipper (a language that can't show one gets the closest style it
 * can). Each frame says its own line. Geometry, timing and the score
 * that runs them: ring.ts.
 *
 * - As the band scrolls in, the ring stands up (CSS, scroll-driven). Once
 *   the stage is well in view (clear of the sticky header and the phone
 *   bar), the side frames swing out from behind the front one, left,
 *   then right, as the first word lands.
 * - Then each style plays its caption once (its own words and the
 *   settled page, so each stays in front as long as its line) and the
 *   ring turns one step: the next style comes to the front, the one
 *   that wraps round passes behind the ring, round and round. A turn
 *   waits while a mouse the visitor moved over the ring or the controls
 *   stays there, or keyboard focus (focus-visible) is in the pills;
 *   held, the caption plays its pass again. A cursor the page scrolls
 *   under never holds it, nor does a finger or the focus a click leaves
 *   on a pill.
 * - One clock (the page's ticker) drives the front caption, the pill's
 *   progress line (one pass, full as the turn comes) and the turns, so a
 *   turn never cuts a word.
 * - Only the front video plays; during a turn the leaving one plays on
 *   until it lands (on a low-end device it is the only one until then).
 * - The visitor's pick (a pill, arrows, a tap on a side frame) turns the
 *   ring to that style, which plays its caption from the first word (the
 *   style in front starts over); then the turns go on from there.
 *   Nothing is remembered.
 * - No pause button (the owner's call): off screen and in hidden tabs
 *   everything stops where it is and resumes from there.
 * - Reduced motion: the three frames side by side, still (posters), each
 *   with its own settled caption and its style's name; no pills.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { presetSupport } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import type { PresetId } from "@/lib/captions/types";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "../CaptionFrame";
import type { ClipId } from "../scene/clips";
import { Scene } from "../scene/Scene";
import {
  PASS_ROOT_MARGIN,
  PASS_THRESHOLDS,
  SMALL_FRAME_OVERRIDES,
  passShare,
  useDocumentVisible,
  useInView,
  useReducedMotion,
} from "../shared";
import { LiveCaption } from "./LiveCaption";
import { HOLD, RingScore, SLOT_NAME, slotOf } from "./ring";
import { subscribe } from "./ticker";
import { captionWords } from "./words";
import L from "../Landing.module.css";
import s from "./CaptionPlayer.module.css";

/** The ring's three looks in the order it shows them, each followed by
 *  the styles that stand in where the language can't show it (closest
 *  first): Hindi gets Karaoke, Sunset and Word by Word; Russian,
 *  Japanese and Korean get Neon for Clipper. */
const LOOKS: readonly (readonly PresetId[])[] = [
  ["power", "karaoke"],
  ["boxed", "gradient"],
  ["clipper", "neon", "reveal"],
];
/** One set each: the cafe, the office, the room (scene/clips.ts). */
const CLIPS: readonly ClipId[] = ["ringCafe", "ringOffice", "ringRoom"];
/** And each its own line ("[word]" is the highlighted one). */
const LINES: readonly MessageKey[] = ["site.captions.line1", "site.captions.line2", "site.captions.line3"];
/** How much of the stage must be in the clear area to start the reveal. */
const START_SHARE = 0.6;

/** The three styles this language can show (fewer only where captions
 *  aren't supported at all). */
function ringStyles(lang: string): PresetId[] {
  const ok = (id: PresetId) => presetSupport(id, lang).level !== "unavailable";
  const named = new Set<PresetId>(LOOKS.flat());
  const out: PresetId[] = [];
  for (const look of LOOKS) {
    const id =
      look.find((p) => ok(p) && !out.includes(p)) ?? LAUNCH_PRESETS.find((p) => ok(p) && !named.has(p) && !out.includes(p));
    if (id) out.push(id);
  }
  return out;
}

/* ── Client-only facts, as stores (false on the server and in hydration) ── */

const noSubscription = () => () => {};

/** Few cores or little memory: one video decodes at a time. */
function lowEndDevice(): boolean {
  const n = navigator as Navigator & { deviceMemory?: number };
  return (n.deviceMemory !== undefined && n.deviceMemory <= 4) || (n.hardwareConcurrency > 0 && n.hardwareConcurrency <= 4);
}

const PHONE_QUERY = "(max-width: 767px)";
function subscribePhone(cb: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/** Focus from the keyboard (:focus-visible). A click focuses a button
 *  too (Chrome, Firefox), and that focus stays until the visitor clicks
 *  elsewhere: it must not hold the ring. False where the browser can't
 *  tell, so a hold never sticks. */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function CaptionPlayerSection() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const docVisible = useDocumentVisible();
  const lowEnd = useSyncExternalStore(noSubscription, lowEndDevice, () => false);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const labelId = useId();
  const texts = useMemo(() => LINES.map((k) => t(k)), [t]);
  const looks = useMemo(() => ringStyles(lang), [lang]);
  const lines = useMemo(() => texts.map((text) => captionWords(text, lang)), [texts, lang]);
  const name = (id: PresetId) => t(`editor.style.preset.${id}` as MessageKey);

  /** The style in front (its slot is the base CSS of every frame). */
  const [front, setFront] = useState(0);
  /** During a move: the style leaving the front (its video plays until it lands). */
  const [moving, setMoving] = useState<number | null>(null);
  /** A pick waiting for the reveal to land. */
  const [pending, setPending] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [stageRef, onScreen] = useInView<HTMLDivElement>();
  const groupRef = useRef<HTMLDivElement>(null);
  // The score, made once per mounted section (its methods mutate it,
  // outside render only).
  const [score] = useState(() => new RingScore({ setFront, setMoving, setPending }));

  const checked = pending ?? front;
  const running = started && !reduced && onScreen && docVisible;
  const showLine = started && !reduced;

  useEffect(() => {
    score.setLines(lines);
  }, [score, lines]);

  // The stage well in view, clear of the fixed chrome: the reveal.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (passShare(entries[entries.length - 1]) < START_SHARE) return;
        io.disconnect();
        setStarted(true);
      },
      { rootMargin: PASS_ROOT_MARGIN, threshold: PASS_THRESHOLDS },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [stageRef]);

  // Before it, the side frames wait hidden behind the front one, unless
  // the stage is on screen already (a reload mid-page: the ring is up).
  // Reduced motion: every animation goes, the base CSS is the still.
  useEffect(() => {
    if (reduced) {
      score.reset();
      return;
    }
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) return;
    score.arm();
  }, [score, reduced, stageRef]);

  // On screen in a visible tab (before `start`, which plays the reveal).
  useEffect(() => {
    score.setLive(onScreen && docVisible);
  }, [score, onScreen, docVisible]);

  useEffect(() => {
    if (started && !reduced) score.start();
  }, [score, started, reduced]);

  // The clock: one subscriber on the page's ticker.
  useEffect(() => {
    if (!running) return;
    return subscribe((dt) => score.tick(dt));
  }, [score, running]);

  // The playing pill's progress line: a paused animation the clock
  // scrubs (linear: it is the caption's playhead).
  useEffect(() => {
    const el = groupRef.current?.querySelector<HTMLElement>(`[data-index="${front}"] [data-line]`);
    if (!showLine || !el || typeof el.animate !== "function") return;
    const anim = el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: 1000,
      easing: "linear",
      fill: "both",
    });
    anim.pause();
    score.setLine(anim);
    return () => {
      anim.cancel();
      score.dropLine(anim);
    };
  }, [score, showLine, front]);

  useEffect(() => () => score.reset(), [score]);

  // Where the mouse is, from every move on the page (on window, so after
  // the ring's own handlers): a mouse that lands on the ring holds even
  // with a single event, a cursor the page scrolls under still doesn't.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") score.seen(e.screenX, e.screenY);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [score]);

  if (looks.length < 3) return null;

  // A click, tap or Space is announced. Arrow keys (`quiet`) move focus
  // to the radio, which the screen reader announces already.
  const pick = (i: number, quiet = false) => {
    if (reduced) return;
    score.pick(i);
    setStarted(true);
    if (!quiet) {
      const message = t("site.captions.frameAria", { style: name(looks[i]) });
      // the same text again would not be announced
      setAnnounce((prev) => (prev === message ? `${message} ` : message));
    }
  };

  // A mouse moved over the ring or the controls holds the next turn
  // until it leaves; a cursor the page scrolls under doesn't (the score
  // tells them apart by where the mouse was last seen), nor does a
  // finger (it only taps).
  const hover = (key: string) => {
    const on = (kind: "enter" | "move" | "leave") => (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") score.mouse(key, kind, e.screenX, e.screenY);
    };
    return { onPointerEnter: on("enter"), onPointerMove: on("move"), onPointerLeave: on("leave") };
  };

  // WAI-ARIA radio group: arrows, Home and End move focus and selection.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (i + 1) % 3;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (i + 2) % 3;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 2;
        break;
      default:
        return;
    }
    e.preventDefault();
    pick(next, true);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <section className={s.band} aria-labelledby="captions-title">
      <div className={L.wrap}>
        <div className={s.layout}>
          <h2 id="captions-title" className={cx(L.h2, s.title)}>
            {t("site.captions.title")}
          </h2>
          <p className={cx(L.body, s.body)}>{t("site.captions.body")}</p>

          <div ref={stageRef} className={s.stage} {...hover("stage")}>
            <div className={s.plate} aria-hidden="true" />
            <div className={s.ring}>
              {looks.map((id, i) => {
                const slot = slotOf(i, front);
                const isFront = slot === 0;
                // The front video plays; during a move the leaving one
                // too, until it lands (and on a low-end device only it).
                const plays = moving === null ? isFront : i === moving || (isFront && !lowEnd);
                return (
                  <div
                    key={i}
                    ref={score.itemRefs[i]}
                    className={s.item}
                    data-slot={SLOT_NAME[slot]}
                    role="img"
                    aria-label={t("site.captions.frameAria", { style: name(id) })}
                    // the side frames are only pointer targets; the pills name every style
                    aria-hidden={!isFront && !reduced ? true : undefined}
                    onClick={isFront || reduced ? undefined : () => pick(i)}
                  >
                    <div className={s.face}>
                      <div className={cx(L.frame, s.frame)}>
                        <Scene clip={CLIPS[i]} playing={plays} />
                        <LiveCaption
                          preset={id}
                          overrides={reduced && phone ? SMALL_FRAME_OVERRIDES[id] : undefined}
                          text={texts[i]}
                          lang={lang}
                          playing={false}
                          hold={HOLD}
                          handle={score.handleRefs[i]}
                        >
                          <CaptionPoster preset={id} text={texts[i]} />
                        </LiveCaption>
                        <span className={s.veil} data-veil="" />
                      </div>
                    </div>
                    <span className={s.name} aria-hidden="true">
                      {name(id)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {!reduced && (
            <>
              <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                className={s.controls}
                {...hover("controls")}
                // Keyboard focus holds the next turn; a click's focus
                // doesn't, and lets go of a keyboard hold.
                onFocus={(e) => score.hold("focus", keyboardFocus(e.target))}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) score.hold("focus", false);
                }}
              >
                {looks.map((id, i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={i === checked}
                    tabIndex={i === checked ? 0 : -1}
                    data-index={i}
                    data-playing={showLine && i === front ? "" : undefined}
                    className={s.pill}
                    onClick={() => pick(i)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                  >
                    {name(id)}
                    <span className={s.line} data-line="" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <span id={labelId} className="sr-only">
                {t("site.captions.pick")}
              </span>
            </>
          )}

          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announce}
          </p>
        </div>
      </div>
    </section>
  );
}
