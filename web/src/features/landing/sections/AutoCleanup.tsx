"use client";
/**
 * Automatic cleanup: "Pauses and filler words are cut for you." A spoken
 * sentence with its filler words and a pause, cleaned in two beats when
 * the card is 60% in view:
 *
 * 1. Mark: each filler word draws a strike line, the pause's edge
 *    brightens (in reading order, 120 ms apart). Hold.
 * 2. Collapse: the marked pieces fade and lift, each is swapped for a slim
 *    cut marker, and the kept words travel from their old places to their
 *    new ones (FLIP on translate). A word that lands on another line does
 *    not cut across the sentence: it comes in at its new place instead.
 *
 * Languages written without spaces (Japanese) keep their text inline, so
 * the line breaking stays right; there the swap is instant, no FLIP.
 *
 * The end state is the clean sentence with a marker where each piece was.
 * Every marker is a toggle (aria-pressed: true = the piece is kept):
 * pressing it brings the piece back in place, pressing again removes it
 * (and pressing during the fade turns the fade back).
 * Screen readers get the clean sentence and the labelled toggles.
 *
 * Plays once per entry: armed unless the card is already 60% in view when
 * the page opens, re-armed when it is fully out of view (unless focus is
 * inside). Reduced motion: the end state from the start, toggles swap
 * instantly. The card keeps the raw sentence's height in every state (an
 * invisible copy shares its grid cell), so the page below never moves.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang, useT } from "@/i18n";
import { segmentsWithoutSpaces } from "@/lib/captions/scripts";
import { cx } from "@/components/ui/cx";
import { rich, useReducedMotion } from "../shared";
import styles from "../Landing.module.css";
import c from "./Cleanup.module.css";

/** The brand curve: every UI enter, exit and on-screen travel. */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** The pass and the toggles (ms). The pass ends by ~1.7 s. */
const T = {
  /** in view → first mark */
  lead: 300,
  stroke: 240,
  ring: 200,
  stagger: 120,
  hold: 400,
  lift: 200,
  /** the swap starts while the lift ends (the curve is front-loaded: the
   *  pieces are near-invisible by then), so the sentence never stalls */
  swap: 120,
  flip: 420,
  marker: 200,
  /** a word that changed line comes in at its new place */
  wrapIn: 280,
  /** …once the words around it have mostly moved (share of the FLIP) */
  wrapDelay: 0.3,
  /** by hand: restore (reverse FLIP) and remove */
  toggle: 360,
  tokenIn: 200,
  tokenInDelay: 80,
  tokenOut: 160,
  tokenSwap: 100,
};

/** A removed piece leaves: it fades and lifts. */
const LIFT: Keyframe[] = [
  { opacity: 1, translate: "0 0" },
  { opacity: 0, translate: "0 -0.3em" },
];

type Part = { kind: "text"; text: string } | { kind: "cut"; type: "um" | "pause"; n: number };

/** "So {um} three tips {pause} …" → text runs and removable pieces. */
function parseSample(sample: string): Part[] {
  const out: Part[] = [];
  let n = 0;
  for (const s of sample.split(/(\{um\}|\{pause\})/)) {
    if (!s) continue;
    if (s === "{um}" || s === "{pause}") out.push({ kind: "cut", type: s === "{um}" ? "um" : "pause", n: n++ });
    else out.push({ kind: "text", text: s });
  }
  return out;
}

/** What a screen reader hears: the sentence with the kept fillers (a pause
 *  is silence, so it adds nothing). */
function spoken(parts: Part[], kept: (n: number) => boolean, filler: string): string {
  return parts
    .map((p) => (p.kind === "text" ? p.text : p.type === "um" && kept(p.n) ? filler : ""))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:。、，！？।])/g, "$1")
    .trim();
}

/** What the sentence is drawn from: word boxes and spaces (spaced
 *  languages), inline runs (no spaces), and the removable pieces. */
type Unit =
  | { k: "word"; text: string; key: string }
  | { k: "run"; text: string; key: string }
  | { k: "space"; text: string }
  | { k: "cut"; n: number; type: "um" | "pause"; key: string };

function toUnits(parts: Part[], spaced: boolean): Unit[] {
  const out: Unit[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "cut") out.push({ k: "cut", n: p.n, type: p.type, key: `c${i}` });
    else if (!spaced) out.push({ k: "run", text: p.text, key: `r${i}` });
    else
      p.text.split(/(\s+)/).forEach((w, j) => {
        if (w) out.push(/^\s+$/.test(w) ? { k: "space", text: w } : { k: "word", text: w, key: `w${i}-${j}` });
      });
  });
  return out;
}

type FlipJob = {
  rects: Map<Element, DOMRect>;
  /** where the sentence box was (it re-centres in the card) */
  rootTop: number;
  ms: number;
  /** slots whose marker fades in */
  markers: number[];
  /** a slot whose token fades in */
  tokenIn: number | null;
};

/** First: where every word and slot is now (call before a change). */
function captureRects(
  root: HTMLElement | null,
  spaced: boolean,
  ms: number,
  extra: Partial<Pick<FlipJob, "markers" | "tokenIn">> = {},
): FlipJob {
  const rects = new Map<Element, DOMRect>();
  if (root && spaced) root.querySelectorAll("[data-flip]").forEach((el) => rects.set(el, el.getBoundingClientRect()));
  return {
    rects,
    rootTop: root?.getBoundingClientRect().top ?? 0,
    ms,
    markers: extra.markers ?? [],
    tokenIn: extra.tokenIn ?? null,
  };
}

/** Last, Invert, Play, batched: every write, then every read, then every
 *  animation (one forced layout, not one per word). */
function playFlip(job: FlipJob, root: HTMLElement) {
  const els = Array.from(job.rects.keys()).filter((el) => el.isConnected);
  // Drop the flips still running: their start points were captured
  // mid-flight, so the new ones carry on from there.
  for (const el of els) for (const a of el.getAnimations()) if (a.id === "flip") a.cancel();

  const cs = getComputedStyle(root);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
  const dir = cs.direction === "rtl" ? -1 : 1;
  const shift = root.getBoundingClientRect().top - job.rootTop;
  const moves = els.map((el) => {
    const first = job.rects.get(el)!;
    const last = el.getBoundingClientRect();
    return { el, dx: first.left - last.left, dy: first.top - last.top, lineMove: last.top - first.top - shift };
  });

  for (const { el, dx, dy, lineMove } of moves) {
    if (Math.abs(lineMove) > lh / 2) {
      // Changed line: a straight path would run through the other words.
      // It comes in at its new place, from the side the text flows from
      // (up a line: from after it; down a line: from before it).
      const from = (lineMove < 0 ? 0.25 : -0.25) * dir;
      el.animate(
        [
          { opacity: 0, translate: `${from}em 0` },
          { opacity: 1, translate: "0 0" },
        ],
        { id: "flip", duration: T.wrapIn, delay: Math.round(job.ms * T.wrapDelay), easing: EASE, fill: "backwards" },
      );
    } else if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
      el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { id: "flip", duration: job.ms, easing: EASE });
    }
  }
  for (const n of job.markers) {
    root
      .querySelector(`[data-slot="${n}"] [data-marker]`)
      ?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T.marker, easing: EASE, fill: "backwards" });
  }
  if (job.tokenIn !== null) {
    root
      .querySelector(`[data-slot="${job.tokenIn}"] [data-token]`)
      ?.animate([{ opacity: 0 }, { opacity: 1 }], {
        delay: T.tokenInDelay,
        duration: T.tokenIn,
        easing: EASE,
        fill: "backwards",
      });
  }
}

/** A removal by hand: its fade and the timer that swaps in the marker. */
type Removal = { anim: Animation; timer: number };

export function AutoCleanupSection() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const spaced = !segmentsWithoutSpaces(lang);

  const filler = t("site.demo.filler");
  const pauseWord = t("site.auto.pause");
  const sample = t("site.auto.sample");
  const parts = useMemo(() => parseSample(sample), [sample]);
  const units = useMemo(() => toUnits(parts, spaced), [parts, spaced]);

  /** "raw": the pieces are shown (armed or mid-pass); "end": markers. */
  const [phase, setPhase] = useState<"raw" | "end">("end");
  /** Pieces brought back by hand (by index). */
  const [kept, setKept] = useState<readonly number[]>([]);
  const isKept = (n: number) => kept.includes(n);

  const cardRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const flipRef = useRef<FlipJob | null>(null);
  /** Pressed during the pass: collapses at once, keeping that piece (set
   *  by the pass's effect). */
  const collapseRef = useRef<(keep: number) => void>(() => {});
  /** Removals waiting for their token to fade out. */
  const removing = useRef(new Map<number, Removal>());

  // Last, Invert, Play: after the change is in the DOM, before paint.
  useLayoutEffect(() => {
    const job = flipRef.current;
    const root = liveRef.current;
    if (!job || !root) return;
    flipRef.current = null;
    playFlip(job, root);
  });

  // The pass: armed while the card is out of view, played at 60% in view
  // in a visible tab, re-armed when it is fully out of view again.
  useEffect(() => {
    const card = cardRef.current;
    if (reduced || !card || typeof card.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    // The hook's first (hydration) value is false: never arm before it
    // catches up.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pending = removing.current;
    let mode: "end" | "armed" | "playing" | "collapsing" = "end";
    let ratio = 0;
    let first = true;
    let timers: number[] = [];
    const later = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms));
    const clearTimers = () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers = [];
    };
    const stop = () => {
      clearTimers();
      for (const r of pending.values()) window.clearTimeout(r.timer);
      pending.clear();
      liveRef.current?.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    };
    const arm = () => {
      stop();
      mode = "armed";
      setKept([]);
      setPhase("raw");
    };
    /** Beat 2: the marked pieces lift and are swapped for markers while
     *  the kept words close up. `keep`: a piece pressed during the pass. */
    const collapse = (keep: number | null) => {
      const root = liveRef.current;
      if ((mode !== "armed" && mode !== "playing") || !root) return;
      clearTimers();
      const kept = keep === null ? [] : [keep];
      if (!spaced) {
        // Inline text: an instant swap (no FLIP, never a crossfade).
        mode = "end";
        setKept(kept);
        setPhase("end");
        return;
      }
      mode = "collapsing";
      const slots = Array.from(root.querySelectorAll<HTMLElement>("[data-slot]"), (el) => Number(el.dataset.slot)).filter(
        (n) => n !== keep,
      );
      for (const n of slots) {
        root
          .querySelector(`[data-slot="${n}"] [data-token]`)
          ?.animate(LIFT, { duration: T.lift, easing: EASE, fill: "forwards" });
      }
      later(T.swap, () => {
        mode = "end";
        flipRef.current = captureRects(root, true, T.flip, { markers: slots });
        setKept(kept);
        setPhase("end");
      });
    };
    const play = () => {
      const root = liveRef.current;
      if (mode !== "armed" || ratio < 0.59 || document.hidden || !root) return;
      mode = "playing";
      // Beat 1, mark: strike lines draw, the pause's edge brightens.
      const marks = root.querySelectorAll<HTMLElement>("[data-strike], [data-ring]");
      marks.forEach((el, i) => {
        const strike = el.hasAttribute("data-strike");
        el.animate(strike ? [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }] : [{ opacity: 0 }, { opacity: 1 }], {
          delay: T.lead + i * T.stagger,
          duration: strike ? T.stroke : T.ring,
          easing: EASE,
          fill: "both",
        });
      });
      const marked = T.lead + Math.max(0, marks.length - 1) * T.stagger + T.stroke;
      later(marked + T.hold, () => collapse(null));
    };

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        ratio = e.isIntersecting ? e.intersectionRatio : 0;
        if (first) {
          first = false;
          // Already 60% on screen when the page opened: keep the end state.
          // Otherwise arm now (at the viewport edge at most, before any
          // interaction; the card's height does not change).
          if (ratio >= 0.59) return;
          arm();
          return;
        }
        if (!e.isIntersecting) {
          if (mode !== "armed" && !card.contains(document.activeElement)) arm();
          return;
        }
        play();
      },
      { threshold: [0, 0.6] },
    );
    io.observe(card);
    document.addEventListener("visibilitychange", play);
    collapseRef.current = (keep) => collapse(keep);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", play);
      collapseRef.current = () => {};
      stop();
      setPhase("end");
    };
  }, [reduced, spaced]);

  const toggle = (n: number) => {
    if (phase === "raw") {
      // Pressed during the pass: the others go now, this one stays.
      collapseRef.current(n);
      return;
    }
    if (reduced || !spaced) {
      // Instant swap (reduced motion; inline text has no FLIP).
      setKept((k) => (k.includes(n) ? k.filter((x) => x !== n) : [...k, n]));
      return;
    }
    const fading = removing.current.get(n);
    if (fading) {
      // Pressed again while it fades out: the fade turns back, it stays.
      window.clearTimeout(fading.timer);
      removing.current.delete(n);
      fading.anim.reverse();
      return;
    }
    if (!isKept(n)) {
      // Bring it back: the words make room, the piece fades in (struck).
      flipRef.current = captureRects(liveRef.current, spaced, T.toggle, { tokenIn: n });
      setKept((k) => [...k, n]);
      return;
    }
    // Remove it again: it fades and lifts (or a fade that was turned back
    // carries on), and the gap closes before the fade ends.
    const token = liveRef.current?.querySelector(`[data-slot="${n}"] [data-token]`);
    if (!token) return;
    const back = token.getAnimations().find((a) => a.id === "out" && a.playbackRate < 0);
    let out: Animation;
    if (back) {
      back.reverse();
      out = back;
    } else out = token.animate(LIFT, { id: "out", duration: T.tokenOut, easing: EASE, fill: "forwards" });
    const at = Number(out.currentTime) || 0;
    const timer = window.setTimeout(
      () => {
        if (removing.current.get(n)?.anim !== out) return;
        removing.current.delete(n);
        flipRef.current = captureRects(liveRef.current, spaced, T.toggle, { markers: [n] });
        setKept((k) => k.filter((x) => x !== n));
      },
      Math.max(0, T.tokenSwap - at),
    );
    removing.current.set(n, { anim: out, timer });
  };

  const body = rich(t("site.auto.body"), {
    um: t("site.quote", { text: filler }),
    tight: <strong className={c.em}>{t("app.start.paceTight")}</strong>,
    natural: <strong className={c.em}>{t("app.start.paceSmooth")}</strong>,
    none: <strong className={c.em}>{t("app.start.paceNone")}</strong>,
  });

  // Keyed apart from the marker: a token's held fade-out must never stay
  // on a reused node.
  const token = (type: "um" | "pause") =>
    type === "um" ? (
      <span key="token" className={cx(c.token, c.filler)} data-token>
        {filler}
        <span className={c.strike} data-strike />
      </span>
    ) : (
      <span key="token" className={cx(c.token, c.pause)} data-token>
        {pauseWord}
        <span className={c.ring} data-ring />
      </span>
    );

  // Both labels quote the piece as it is shown ("Keep “pause”"): a quoted
  // label keeps its own form, so the sentence stays grammatical in every
  // language (no case endings on a bare noun).
  const keepLabel = {
    um: t("site.auto.keep", { text: t("site.quote", { text: filler }) }),
    pause: t("site.auto.keep", { text: t("site.quote", { text: pauseWord }) }),
  };

  /** One unit of the live sentence (`live`) or of the invisible copy. */
  const unit = (u: Unit, live: boolean): React.ReactNode => {
    if (u.k === "space") return u.text;
    if (u.k === "run")
      return (
        <span key={u.key} aria-hidden={live || undefined}>
          {u.text}
        </span>
      );
    if (u.k === "word")
      return (
        <span key={u.key} className={c.w} aria-hidden={live || undefined} data-flip={live || undefined}>
          {u.text}
        </span>
      );
    if (!live)
      return (
        <span key={u.key} className={c.slot} data-mode="token">
          {token(u.type)}
        </span>
      );
    const shown = phase === "raw" || isKept(u.n);
    return (
      <button
        key={u.key}
        type="button"
        className={c.slot}
        data-flip
        data-slot={u.n}
        data-mode={shown ? "token" : "marker"}
        aria-pressed={isKept(u.n)}
        aria-label={keepLabel[u.type]}
        onClick={() => toggle(u.n)}
      >
        {shown ? token(u.type) : <span key="marker" className={c.marker} data-marker />}
      </button>
    );
  };

  /** The sentence. A piece stays on the line of the word before it (no
   *  break in between), so a marker never starts a line. */
  const draw = (live: boolean) => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const next = units[i + 2];
      if (u.k === "word" && units[i + 1]?.k === "space" && next?.k === "cut") {
        out.push(
          <span key={`g${i}`} className={c.glue}>
            {unit(u, live)}
            {"\u00a0"}
            {unit(next, live)}
          </span>,
        );
        i += 2;
      } else out.push(unit(u, live));
    }
    return out;
  };

  return (
    <section className={styles.section} aria-labelledby="auto-title">
      <div className={cx(styles.wrap, c.auto)}>
        <div>
          <h2 id="auto-title" className={styles.h2}>
            {t("site.auto.title")}
          </h2>
          <p className={styles.body}>{body}</p>
        </div>
        <div>
          <div ref={cardRef} className={c.card}>
            <p className={c.sentence} data-inline={!spaced || undefined}>
              <span className="sr-only">{spoken(parts, isKept, filler)}</span>
              {/* The raw sentence, invisible: holds the card's height. */}
              <span className={c.ghost} aria-hidden="true">
                {draw(false)}
              </span>
              <span ref={liveRef} className={c.live} data-phase={phase}>
                {draw(true)}
              </span>
            </p>
          </div>
          <p className={c.restore}>{t("site.control.restore")}</p>
        </div>
      </div>
    </section>
  );
}
