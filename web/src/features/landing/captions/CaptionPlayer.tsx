"use client";
/**
 * Caption styles as a ring: three phone videos of the creator stand on a
 * slowly turning 3D ring, one in front and one on each side. The one in
 * front plays its caption word by word, drawn live by the real caption
 * engine, in three of the most viral looks: Power, Highlight Box and
 * Clipper (a language that can't show one gets the closest style it
 * can). Geometry and timing: ring.ts.
 *
 * - As the band scrolls in, the ring stands up (CSS, scroll-driven). Once
 *   the stage is well in view (clear of the sticky header and the phone
 *   bar), the side frames swing out from behind the front one, left,
 *   then right, as the first word lands.
 * - Then, after each style's caption has played its passes, the ring
 *   turns one step: the next style comes to the front, the one that
 *   wraps round passes behind the ring. A turn waits while a mouse is
 *   over the ring or the controls, or the keyboard is in the pills.
 * - One clock (the page's ticker) drives the front caption, the pill's
 *   progress line and the turns, so a turn never cuts a word.
 * - Only the front video plays; during a turn the leaving one plays on
 *   until it lands (on a low-end device it is the only one until then).
 * - The visitor's pick (a pill, arrows, a tap on a side frame) turns the
 *   ring to that style, which then loops; no auto turns for the session.
 * - Pause (WCAG 2.2.2) lets a turn in flight land, then holds the video
 *   and a settled caption page. Off screen and in hidden tabs everything
 *   stops where it is and resumes from there.
 * - Reduced motion: the three frames side by side, still (posters), each
 *   with its settled caption and its style's name; no pills, no pause.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play } from "lucide-react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { presetSupport } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import type { CaptionWord, PresetId } from "@/lib/captions/types";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
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
import { LiveCaption, type LiveCaptionHandle } from "./LiveCaption";
import {
  FAN_FROM,
  FAN_MS,
  FAN_STAGGER_MS,
  HOLD,
  PICK_MS,
  SLOT_NAME,
  TURN_MS,
  lerpPose,
  moveKeyframes,
  passesFor,
  restPose,
  target,
  veilOpacity,
  type Pose,
  type Slot,
} from "./ring";
import { subscribe } from "./ticker";
import { captionWords, spokenUntil } from "./words";
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
/** Set once the visitor has picked: no auto turns again in this tab. */
const TOUR_DONE_KEY = "cleocuts.captionTour";
/** How much of the stage must be in the clear area to start the reveal. */
const START_SHARE = 0.6;
/** The brand curve, var(--ease-out) (WAAPI can't read a custom property). */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

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

/** The slot of frame `i` while frame `front` is in front. */
function slotOf(i: number, front: number): Slot {
  return ((i - front + 3) % 3) as Slot;
}

/* ── Client-only facts, as stores (false on the server and in hydration) ── */

const noSubscription = () => () => {};

/** Few cores or little memory: one video decodes at a time. */
function lowEndDevice(): boolean {
  const n = navigator as Navigator & { deviceMemory?: number };
  return (n.deviceMemory !== undefined && n.deviceMemory <= 4) || (n.hardwareConcurrency > 0 && n.hardwareConcurrency <= 4);
}

function tourDone(): boolean {
  try {
    return sessionStorage.getItem(TOUR_DONE_KEY) !== null;
  } catch {
    return false;
  }
}

const PHONE_QUERY = "(max-width: 767px)";
function subscribePhone(cb: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/* ── The score ── */

/** The sentence's timing in this language (s). */
type Timing = { pass: number; passes: number; lead: number; lastEnd: number };

type Move = {
  id: number;
  /** Per frame: its transform, opacity and veil animations (none for a
   *  frame that stays put). */
  anims: (Animation[] | null)[];
  from: Pose[];
  to: Pose[];
  /** The first reveal; armed (paused at its start) until the stage is in view. */
  fan: boolean;
  started: boolean;
};

type Ui = {
  setFront(i: number): void;
  setMoving(prev: number | null): void;
  setPending(i: number | null): void;
};

const animsOf = (m: Move | null): Animation[] => (m ? m.anims.flatMap((a) => a ?? []) : []);

/** An element's opacity on screen now (animations included). */
function opacityOf(el: Element | null | undefined): number {
  if (!el) return 1;
  const v = parseFloat(getComputedStyle(el).opacity);
  return Number.isFinite(v) ? v : 1;
}

/**
 * The ring's state outside React: the frames' animations, the caption
 * clock and the holds. React renders the slots (data-slot, the front
 * style's state); this moves the frames between them and calls back when
 * the front changes. Everything per frame happens here, on refs.
 */
class RingScore {
  items: (HTMLDivElement | null)[] = [null, null, null];
  handles: (LiveCaptionHandle | null)[] = [null, null, null];
  /** The playing pill's progress line (a paused animation, scrubbed). */
  line: Animation | null = null;
  timing: Timing = { pass: 1, passes: 1, lead: 0, lastEnd: 0 };
  front = 0;
  auto = true;
  /** The front caption's clock (s); negative while the ring brings it
   *  round, so its first word lands as the ring settles. */
  c = 0;
  move: Move | null = null;
  /** A pick made during the reveal: the ring turns to it after. */
  queued: number | null = null;
  started = false;
  live = false;
  /** Mouse over the stage or the controls, the keyboard in the pills. */
  holds = new Set<string>();
  /** Seconds after the last hold before a turn may come. */
  wait = 0;
  private ids = 0;
  private readonly ui: Ui;
  /** Ref callbacks for the frames and their captions. */
  readonly itemRefs: ((el: HTMLDivElement | null) => void)[];
  readonly handleRefs: ((h: LiveCaptionHandle | null) => void)[];

  constructor(ui: Ui) {
    this.ui = ui;
    this.itemRefs = [0, 1, 2].map((i) => (el: HTMLDivElement | null) => {
      this.items[i] = el;
    });
    this.handleRefs = [0, 1, 2].map((i) => (h: LiveCaptionHandle | null) => {
      this.handles[i] = h;
    });
  }

  /** The sentence in this language: a pass is its words plus the hold. */
  setWords(words: readonly CaptionWord[]): void {
    const lastEnd = spokenUntil(words);
    const pass = lastEnd + HOLD;
    this.timing = { pass, passes: passesFor(pass), lead: words.length ? words[0].start : 0, lastEnd };
  }

  stopAuto(): void {
    this.auto = false;
  }

  /** The playing pill's line, from where the clock is. */
  setLine(anim: Animation | null): void {
    this.line = anim;
    if (!anim) return;
    const { pass, passes } = this.timing;
    anim.currentTime = Math.min(1, Math.max(0, this.c / (pass * passes))) * 1000;
  }

  dropLine(anim: Animation): void {
    if (this.line === anim) this.line = null;
  }

  /** Each frame's pose and opacities on screen now. */
  private presentation(): { pose: Pose; face: number; veil: number }[] {
    const m = this.move;
    return this.items.map((el, i) => {
      const anims = m?.anims[i];
      const pose =
        m && anims
          ? lerpPose(m.from[i], m.to[i], anims[0].effect?.getComputedTiming().progress ?? 0)
          : restPose(slotOf(i, this.front));
      return { pose, face: opacityOf(el), veil: opacityOf(el?.querySelector("[data-veil]")) };
    });
  }

  /** Where the reveal starts: the side frames hidden just behind the front one. */
  private fanStart(): { pose: Pose; face: number; veil: number }[] {
    return this.items.map((_, i) => {
      const slot = slotOf(i, this.front);
      if (slot === 0) return { pose: restPose(0), face: 1, veil: 0 };
      const a = slot === 1 ? FAN_FROM : -FAN_FROM;
      return { pose: { a, f: -0.75 * a }, face: 0, veil: veilOpacity(a) };
    });
  }

  /** Moves the frames, from where they are, so that `next` stands in
   *  front. Returns false where the browser can't animate them. */
  private animate(next: number, ms: number, fan: boolean): boolean {
    const els = this.items;
    if (els.some((el) => !el || typeof el.animate !== "function")) return false;
    const now = fan ? this.fanStart() : this.presentation();
    // R in px: the frame's width times the stage's --ring.
    const el0 = els[0] as HTMLDivElement;
    const css = getComputedStyle(el0);
    const r = parseFloat(css.width) * (parseFloat(css.getPropertyValue("--ring")) || 0.9);
    this.cancel();
    const id = ++this.ids;
    const from = now.map((n) => n.pose);
    const to = now.map((n, i) => target(n.pose, slotOf(i, next)));
    const anims = els.map((el, i) => {
      const item = el as HTMLDivElement;
      if (fan && slotOf(i, next) === 0) return null;
      const kf = moveKeyframes(from[i], to[i], r, now[i].face, now[i].veil);
      // The reveal: left, then right.
      const delay = fan && slotOf(i, next) === 1 ? FAN_STAGGER_MS : 0;
      const timing: KeyframeAnimationOptions = { duration: ms, delay, easing: EASE, fill: "both" };
      // The frame's opacity goes on the item itself (a leaf of the 3D
      // context: it flattens nothing), so its shadow fades with it.
      const veil = item.querySelector("[data-veil]") as HTMLElement;
      return [item.animate(kf.transform, timing), item.animate(kf.face, timing), veil.animate(kf.veil, timing)];
    });
    const move: Move = { id, anims, from, to, fan, started: !fan };
    this.move = move;
    const all = animsOf(move);
    if (!move.started || !this.live) all.forEach((a) => a.pause());
    Promise.all(all.map((a) => a.finished)).then(
      () => this.land(id),
      () => {
        /* cancelled: a new move took over */
      },
    );
    return true;
  }

  /** The move is over: the slots' rest styles take over again (React
   *  rendered them when it started), and a pick made meanwhile turns. */
  private land(id: number): void {
    if (this.move?.id !== id) return;
    this.cancel();
    this.ui.setMoving(null);
    const q = this.queued;
    if (q === null) return;
    this.queued = null;
    this.ui.setPending(null);
    if (q !== this.front) this.turnTo(q, PICK_MS);
  }

  private cancel(): void {
    animsOf(this.move).forEach((a) => a.cancel());
    this.move = null;
  }

  /** Brings style `k` to the front; its caption starts from the first
   *  word as the ring settles. */
  turnTo(k: number, ms: number): void {
    const prev = this.front;
    const moved = this.animate(k, ms, false);
    this.front = k;
    this.c = this.timing.lead - ms / 1000;
    // Every frame shows a settled page until its clock comes round.
    for (const h of this.handles) h?.seek(this.timing.lastEnd);
    this.ui.setFront(k);
    if (moved) this.ui.setMoving(prev);
  }

  /** The reveal, waiting at its start until the stage is in view. */
  arm(): void {
    if (!this.started && !this.move) this.animate(this.front, FAN_MS, true);
  }

  /** The stage is in view: the reveal plays and the first caption starts
   *  as the right frame lands. Paused by the visitor: no reveal, the
   *  ring is simply up. */
  start(paused: boolean): void {
    if (this.started) return;
    this.started = true;
    const m = this.move;
    if (!m?.fan) return;
    if (paused) {
      this.land(m.id);
      return;
    }
    m.started = true;
    if (this.live) animsOf(m).forEach((a) => a.play());
    this.c = this.timing.lead - (FAN_STAGGER_MS + FAN_MS) / 1000;
  }

  /** The visitor's pick: the ring turns to it (after the reveal, if that
   *  is still under way), and there are no auto turns from now on. */
  pick(i: number): void {
    this.auto = false;
    if (this.move?.fan) {
      this.queued = i;
      this.ui.setPending(i);
    } else if (i !== this.front) {
      this.turnTo(i, PICK_MS);
    }
  }

  /** On screen in a visible tab: a move in flight runs; else it holds. */
  setLive(live: boolean): void {
    this.live = live;
    const m = this.move;
    if (!m?.started) return;
    for (const a of animsOf(m)) {
      if (live && a.playState === "paused") a.play();
      else if (!live && a.playState === "running") a.pause();
    }
  }

  hold(key: string, on: boolean): void {
    if (on) this.holds.add(key);
    else if (this.holds.delete(key) && this.holds.size === 0) this.wait = TURN_MS / 1000;
  }

  /** Pausing: the caption holds a settled page, never an empty one or a
   *  first word just popping in. */
  settle(): void {
    const { pass, lead, lastEnd } = this.timing;
    if (this.c < 0) return;
    const at = this.c % pass;
    if (at >= lead + 0.1) return;
    this.c += lastEnd - at;
    this.handles[this.front]?.seek(lastEnd);
  }

  /** One frame of the clock (the page's ticker). */
  tick(dt: number): void {
    const { pass, passes } = this.timing;
    const prev = this.c;
    this.c += dt;
    this.wait = Math.max(0, this.wait - dt);
    const dwell = pass * passes;
    // A turn comes at the end of a pass, once the passes are played and
    // nothing holds it.
    const passEnd = Math.floor(this.c / pass) > Math.floor(prev / pass);
    if (this.auto && !this.move && this.c >= dwell && passEnd && this.holds.size === 0 && this.wait === 0) {
      this.turnTo((this.front + 1) % 3, TURN_MS);
      return;
    }
    if (this.c >= 0) this.handles[this.front]?.seek(this.c % pass);
    if (this.line) this.line.currentTime = Math.min(1, Math.max(0, this.c / dwell)) * 1000;
  }

  /** Back to the slots at rest, every caption on its settled page
   *  (reduced motion, also switched on mid-pass; unmount). The controls
   *  go with it, so their holds go too (no pointerleave or blur comes). */
  reset(): void {
    this.cancel();
    if (this.queued !== null) {
      this.front = this.queued;
      this.ui.setFront(this.queued);
    }
    this.queued = null;
    for (const h of this.handles) h?.seek(this.timing.lastEnd);
    this.holds.delete("controls");
    this.holds.delete("focus");
    this.ui.setMoving(null);
    this.ui.setPending(null);
  }
}

export function CaptionPlayerSection() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const docVisible = useDocumentVisible();
  const lowEnd = useSyncExternalStore(noSubscription, lowEndDevice, () => false);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const doneBefore = useSyncExternalStore(noSubscription, tourDone, () => false);
  const labelId = useId();
  const text = t("site.demo.caption");
  const looks = useMemo(() => ringStyles(lang), [lang]);
  const words = useMemo(() => captionWords(text, lang), [text, lang]);
  const name = (id: PresetId) => t(`editor.style.preset.${id}` as MessageKey);

  /** The style in front (its slot is the base CSS of every frame). */
  const [front, setFront] = useState(0);
  /** During a move: the style leaving the front (its video plays until it lands). */
  const [moving, setMoving] = useState<number | null>(null);
  /** A pick waiting for the reveal to land. */
  const [pending, setPending] = useState<number | null>(null);
  const [picked, setPicked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [stageRef, onScreen] = useInView<HTMLDivElement>();
  const groupRef = useRef<HTMLDivElement>(null);
  // The score, made once per mounted section (its methods mutate it,
  // outside render only).
  const [score] = useState(() => new RingScore({ setFront, setMoving, setPending }));

  const auto = !picked && !doneBefore;
  const checked = pending ?? front;
  const running = started && !reduced && !paused && onScreen && docVisible;
  const showLine = auto && started && !reduced;

  useEffect(() => {
    score.setWords(words);
  }, [score, words]);

  useEffect(() => {
    if (!auto) score.stopAuto();
  }, [score, auto]);

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
    if (started && !reduced) score.start(paused);
  }, [score, started, reduced, paused]);

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

  if (looks.length < 3) return null;

  // A click, tap or Space is announced. Arrow keys (`quiet`) move focus
  // to the radio, which the screen reader announces already.
  const pick = (i: number, quiet = false) => {
    if (reduced) return;
    score.pick(i);
    setPicked(true);
    setStarted(true);
    if (!quiet) {
      const message = t("site.captions.frameAria", { style: name(looks[i]) });
      // the same text again would not be announced
      setAnnounce((prev) => (prev === message ? `${message} ` : message));
    }
    try {
      sessionStorage.setItem(TOUR_DONE_KEY, "1");
    } catch {
      /* storage blocked: the auto turns simply stay off for this page */
    }
  };

  const togglePause = () => {
    if (!paused) score.settle();
    setPaused((p) => !p);
  };

  // A mouse over the ring or the controls holds the next turn (a finger
  // only taps: no hold).
  const hover = (key: string, on: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") score.hold(key, on);
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

          <div
            ref={stageRef}
            className={s.stage}
            onPointerEnter={hover("stage", true)}
            onPointerLeave={hover("stage", false)}
          >
            <div className={s.plate} aria-hidden="true" />
            <div className={s.ring}>
              {looks.map((id, i) => {
                const slot = slotOf(i, front);
                const isFront = slot === 0;
                // The front video plays; during a move the leaving one
                // too, until it lands (and on a low-end device only it).
                const plays = !paused && (moving === null ? isFront : i === moving || (isFront && !lowEnd));
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
                          text={text}
                          lang={lang}
                          playing={false}
                          hold={HOLD}
                          handle={score.handleRefs[i]}
                        >
                          <CaptionPoster preset={id} text={text} />
                        </LiveCaption>
                        <span className={L.frameTag}>{t("site.demo.example")}</span>
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
            <div className={s.controls} onPointerEnter={hover("controls", true)} onPointerLeave={hover("controls", false)}>
              <IconButton
                label={paused ? t("site.captions.play") : t("site.captions.pause")}
                className={s.toggle}
                onClick={togglePause}
              >
                <Icon icon={paused ? Play : Pause} size={16} />
              </IconButton>
              <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                className={s.pills}
                onFocus={() => score.hold("focus", true)}
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
            </div>
          )}

          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announce}
          </p>
        </div>
      </div>
    </section>
  );
}
