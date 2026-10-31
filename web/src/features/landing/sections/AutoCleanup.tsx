"use client";
/**
 * Automatic cleanup: "Pauses and filler words are cut for you." A spoken
 * sentence with its filler words and a pause, cleaned in two beats when
 * the card is 60% in view (clear of the sticky header and the phone bar):
 *
 * 1. Mark: each filler word draws a strike line, the pause's edge
 *    brightens (in reading order, 120 ms apart). Hold.
 * 2. Collapse: each cut is one object, as on the command strips: the
 *    marked piece squeezes into its slim cut marker, which grows in out of
 *    the piece's centre and travels with the kept words to their new
 *    places (FLIP on translate). A word that lands on another line does
 *    not cut across the sentence: it comes in at its new place instead,
 *    as soon as the words or the piece still there have made room.
 *
 * Then, once per page view, every marker lights up once (its hover
 * overlay) and the hint under the card comes up from faint: the markers
 * can be tapped.
 *
 * Languages written without spaces (Japanese) keep their text inline, so
 * the line breaking stays right; there the swap is instant, no FLIP.
 *
 * The end state is the clean sentence with a marker where each piece was.
 * Every marker is a toggle (aria-pressed: true = the piece is kept),
 * named by its piece and its place ("Keep “um”, cut 1 of 3"): pressing it
 * brings the piece back (it grows out of its marker while the words make
 * room, then its strike retracts), pressing again squeezes it back into
 * the marker. A press mid-motion carries on from where everything is.
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
import { EASE, EASE_MOVE, PASS_ROOT_MARGIN, PASS_THRESHOLDS, passShare, rich, useReducedMotion } from "../shared";
import styles from "../Landing.module.css";
import c from "./Cleanup.module.css";

/** The pass and the toggles (ms). The pass ends by ~1.6 s (the first
 *  one's marker lights by ~2.3 s). */
const T = {
  /** in view → first mark */
  lead: 300,
  stroke: 240,
  ring: 200,
  stagger: 120,
  hold: 400,
  /** the kept words close up; a removed piece squeezes with its gap */
  flip: 420,
  /** its marker grows in out of the piece's centre */
  markerIn: 200,
  /** a word that changed line comes in at its new place (once it is
   *  free) */
  wrapIn: 220,
  /** by hand: the words make room or close up (the piece with them) */
  toggle: 360,
  /** a piece brought back: its marker gives way (an exit) */
  markerOut: 140,
  /** …and once it has mostly grown back, its strike retracts (the
   *  pause's edge dims) */
  retractDelay: 200,
  retract: 200,
  /** once, after the first pass: every marker lights up */
  teach: 500,
  teachStagger: 90,
};

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

/** The form a slot shows (in flow; the other waits on its centre). */
const shownPart = (slot: Element) =>
  slot.querySelector<HTMLElement>(slot.getAttribute("data-mode") === "marker" ? "[data-marker]" : "[data-token]");

/** How one form of a piece looks now (mid-swap too): its width on screen
 *  and its opacity. */
type Look = { w: number; o: number };

const look = (el: Element | null): Look =>
  el ? { w: el.getBoundingClientRect().width, o: Number(getComputedStyle(el).opacity) } : { w: 0, o: 0 };

type FlipJob = {
  /** kept words: where they were, and their opacity (one still coming in
   *  on a new line carries on) */
  words: Map<Element, { rect: DOMRect; o: number }>;
  /** slots: which form they showed, where, how both forms looked (a new
   *  swap carries on from there), and their own opacity */
  slots: Map<Element, { mode: string | null; rect: DOMRect; o: number; token: Look; marker: Look }>;
  /** where the sentence box was (it re-centres in the card) */
  rootTop: number;
  ms: number;
  /** pieces brought back: their strike retracts */
  restored: number[];
  /** …from where the pass's mark is now (pressed mid-pass), not drawn */
  markNow: boolean;
};

/** First: where every word and slot is now (call before a change). The
 *  rects are read mid-flight too, so a new move carries on from there. */
function capture(root: HTMLElement | null, spaced: boolean, ms: number, restored: number[] = [], markNow = false): FlipJob {
  const words: FlipJob["words"] = new Map();
  const slots: FlipJob["slots"] = new Map();
  const opacity = (el: Element) => Number(getComputedStyle(el).opacity);
  if (root && spaced) {
    root.querySelectorAll("[data-flip]").forEach((el) => words.set(el, { rect: el.getBoundingClientRect(), o: opacity(el) }));
    root.querySelectorAll("[data-slot]").forEach((slot) => {
      const part = shownPart(slot);
      if (part)
        slots.set(slot, {
          mode: slot.getAttribute("data-mode"),
          rect: part.getBoundingClientRect(),
          o: opacity(slot),
          token: look(slot.querySelector("[data-token]")),
          marker: look(slot.querySelector("[data-marker]")),
        });
    });
  }
  return { words, slots, rootTop: root?.getBoundingClientRect().top ?? 0, ms, restored, markNow };
}

const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;

/** When a cubic-bezier() timing reaches the eased progress `y`, as a share
 *  of its time. */
function timeAt(curve: string, y: number): number {
  const [x1, y1, x2, y2] = (curve.match(/-?[\d.]+/g) ?? []).map(Number);
  const at = (s: number, p1: number, p2: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, y1, y2) < y) lo = mid;
    else hi = mid;
  }
  return at(hi, x1, x2);
}

/** The strike's drawn share now (its scaleX). */
function drawn(el: Element): number {
  const m = getComputedStyle(el).transform;
  return !m || m === "none" ? 1 : new DOMMatrixReadOnly(m).a;
}

/** Last, Invert, Play, batched: every read, then every animation (one
 *  forced layout, not one per word). A slot moves by its piece's centre:
 *  the marker starts where the piece was (and the piece where the marker
 *  was), so the swap reads as one object travelling with the words. */
function playFlip(job: FlipJob, root: HTMLElement) {
  const words = Array.from(job.words.keys()).filter((el) => el.isConnected);
  const slots = Array.from(job.slots.keys()).filter((el) => el.isConnected);
  for (const el of [...words, ...slots]) for (const a of el.getAnimations()) if (a.id === "flip") a.cancel();
  // A slot that changed form: its last swap gives way to the new one, which
  // starts from how both forms looked (the job), so both are measured at
  // rest here.
  const changed = (el: Element) => job.slots.get(el)!.mode !== el.getAttribute("data-mode");
  for (const el of slots)
    if (changed(el))
      for (const p of el.querySelectorAll("[data-token], [data-marker]"))
        for (const a of p.getAnimations()) if (a.id === "swap") a.cancel();

  const cs = getComputedStyle(root);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
  const dir = cs.direction === "rtl" ? -1 : 1;
  const shift = root.getBoundingClientRect().top - job.rootTop;
  const moves = [
    ...words.map((el) => {
      const { rect: first, o } = job.words.get(el)!;
      const last = el.getBoundingClientRect();
      return {
        el,
        rect: last,
        o,
        dx: first.left - last.left,
        dy: first.top - last.top,
        line: last.top - first.top - shift,
        swap: null,
      };
    }),
    ...slots.map((el) => {
      const was = job.slots.get(el)!;
      const part = shownPart(el);
      const now = part?.getBoundingClientRect() ?? was.rect;
      const [x0, y0] = centre(was.rect);
      const [x1, y1] = centre(now);
      const token = el.querySelector<HTMLElement>("[data-token]");
      const marker = el.querySelector<HTMLElement>("[data-marker]");
      return {
        el,
        rect: now,
        o: was.o,
        dx: x0 - x1,
        dy: y0 - y1,
        line: y1 - y0 - shift,
        swap:
          changed(el) && token && marker
            ? {
                token,
                marker,
                was,
                tokenW: Math.max(1, token.getBoundingClientRect().width),
                markerW: Math.max(1, marker.getBoundingClientRect().width),
              }
            : null,
      };
    }),
  ];

  // What stays on its line, at a share `e` of the move (eased): its span
  // [left, right] pushed back by the travel still to go. A swapping piece
  // is as wide as it is drawn then; one being removed counts until it has
  // mostly faded (then only its marker).
  const spans = moves
    .filter((m) => Math.abs(m.line) <= lh / 2)
    .map((m) => {
      const [cx, y] = centre(m.rect);
      const swap = m.swap;
      if (!swap) return { y, at: (e: number) => [m.rect.left + m.dx * (1 - e), m.rect.right + m.dx * (1 - e)] };
      const removed = m.el.getAttribute("data-mode") === "marker";
      const { was, tokenW, markerW } = swap;
      const w0 = removed || was.token.o > 0.01 ? was.token.w : was.marker.w;
      const w1 = removed ? markerW : tokenW;
      return {
        y,
        at: (e: number) => {
          const c = cx + m.dx * (1 - e);
          const w = removed && e >= 0.7 ? w1 : w0 + (w1 - w0) * e;
          return [c - w / 2, c + w / 2];
        },
      };
    });
  /** A word that changes line waits until its new place is free (ms): the
   *  words still travelling there, or a piece still squeezing out of it,
   *  go first. No wait when it is free already. */
  const wait = (m: (typeof moves)[number]) => {
    const near = spans.filter((s) => Math.abs(s.y - centre(m.rect)[1]) < lh / 2);
    for (let i = 0; i <= 50; i++) {
      const e = i / 50;
      const free = near.every((s) => {
        const [l, r] = s.at(e);
        return r <= m.rect.left + 1 || l >= m.rect.right - 1;
      });
      if (free) return i ? Math.round(timeAt(EASE_MOVE, e) * job.ms) : 0;
    }
    return job.ms;
  };

  for (const m of moves) {
    const { el, dx, dy, line, swap } = m;
    if (Math.abs(line) > lh / 2) {
      // Changed line: a straight path would run through the other words.
      // It comes in at its new place, from the side the text flows from
      // (up a line: from after it; down a line: from before it), as soon
      // as that place is free.
      const from = (line < 0 ? 0.25 : -0.25) * dir;
      el.animate(
        [
          { opacity: 0, translate: `${from}em 0` },
          { opacity: 1, translate: "0 0" },
        ],
        { id: "flip", duration: T.wrapIn, delay: wait(m), easing: EASE, fill: "backwards" },
      );
    } else {
      // It travels to its new place; one still coming in from an earlier
      // move (pressed mid-way) carries on from its opacity, no pop.
      const from: Keyframe = {};
      const to: Keyframe = {};
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        from.translate = `${dx}px ${dy}px`;
        to.translate = "0 0";
      }
      if (m.o < 0.99) {
        from.opacity = m.o;
        to.opacity = 1;
      }
      if (to.translate || to.opacity) el.animate([from, to], { id: "flip", duration: job.ms, easing: EASE_MOVE });
    }
    if (!swap) continue;
    // Each form starts from how it looked when pressed (at rest: the piece
    // full width or hidden, the marker hidden or whole), so a press
    // mid-swap carries on instead of snapping.
    const { token, marker, was, tokenW, markerW } = swap;
    const pieceAt = (w: number) => `${w / tokenW} 1`;
    const markerAt = was.marker.o > 0.01 ? `${was.marker.w / markerW}` : "0.6";
    // The piece's width rides the words' move (same curve, same time), so
    // it always fills the gap that opens or closes around it: no hole, no
    // overlap.
    const withWords: KeyframeAnimationOptions = { id: "swap", duration: job.ms, easing: EASE_MOVE };
    if (el.getAttribute("data-mode") === "marker") {
      // Removed: the marker lands on the piece's centre, the piece
      // squeezes into it and is gone in the second half.
      token.animate(
        [
          { opacity: was.token.o, scale: pieceAt(was.token.w) },
          { opacity: was.token.o, offset: 0.4 },
          { opacity: 0, scale: pieceAt(markerW) },
        ],
        withWords,
      );
      marker.animate(
        [
          { opacity: was.marker.o, scale: markerAt },
          { opacity: 1, scale: "1" },
        ],
        { id: "swap", duration: T.markerIn, easing: EASE },
      );
    } else {
      // Brought back: the piece grows out of its marker (or on from where
      // its squeeze was), which gives way.
      token.animate(
        [
          { opacity: was.token.o, scale: pieceAt(was.token.o > 0.01 ? was.token.w : was.marker.w) },
          { opacity: 1, offset: 0.25 },
          { opacity: 1, scale: "1 1" },
        ],
        withWords,
      );
      marker.animate(
        [
          { opacity: was.marker.o, scale: markerAt },
          { opacity: 0, scale: "0.6" },
        ],
        { id: "swap", duration: T.markerOut, easing: "ease" },
      );
    }
  }

  // Brought back: the strike retracts toward its end, the pause's edge
  // dims (from where the pass's mark is, when pressed mid-pass).
  for (const n of job.restored) {
    const token = root.querySelector(`[data-slot="${n}"] [data-token]`);
    const strike = token?.querySelector("[data-strike]");
    const ring = token?.querySelector("[data-ring]");
    const timing: KeyframeAnimationOptions = {
      delay: T.retractDelay,
      duration: T.retract,
      easing: "ease",
      fill: "backwards",
    };
    if (strike) {
      const from = job.markNow ? drawn(strike) : 1;
      for (const a of strike.getAnimations()) a.cancel();
      strike.animate([{ transform: `scaleX(${from})` }, { transform: "scaleX(0)" }], timing);
    }
    if (ring) {
      const from = job.markNow ? Number(getComputedStyle(ring).opacity) : 1;
      for (const a of ring.getAnimations()) a.cancel();
      ring.animate([{ opacity: from }, { opacity: 0 }], timing);
    }
  }
}

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
  const cutCount = parts.filter((p) => p.kind === "cut").length;

  /** "raw": the pieces are shown (armed or mid-pass); "end": markers. */
  const [phase, setPhase] = useState<"raw" | "end">("end");
  /** Pieces brought back by hand (by index). */
  const [kept, setKept] = useState<readonly number[]>([]);
  const isKept = (n: number) => kept.includes(n);

  const cardRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const flipRef = useRef<FlipJob | null>(null);
  /** The markers have lit up once (per page view). */
  const taughtRef = useRef(false);
  /** Pressed during the pass: collapses at once, keeping that piece (set
   *  by the pass's effect). */
  const collapseRef = useRef<(keep: number) => void>(() => {});

  // Last, Invert, Play: after the change is in the DOM, before paint.
  useLayoutEffect(() => {
    const job = flipRef.current;
    const root = liveRef.current;
    if (!job || !root) return;
    flipRef.current = null;
    playFlip(job, root);
  });

  // The pass: armed while the card is out of view, played at 60% in view
  // (clear of the fixed chrome; a card taller than that area: once it
  // fills 60% of it) in a visible tab, re-armed when it is fully out of
  // view again.
  useEffect(() => {
    const card = cardRef.current;
    const hint = hintRef.current;
    if (reduced || !card || typeof card.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    // The hook's first (hydration) value is false: never arm before it
    // catches up.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let mode: "end" | "armed" | "playing" = "end";
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
      liveRef.current?.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    };
    const arm = () => {
      stop();
      mode = "armed";
      // Nothing to tap yet: the hint waits a step quieter.
      hint?.setAttribute("data-quiet", "");
      setKept([]);
      setPhase("raw");
    };
    /** After the collapse: the hint comes up; the first time, every
     *  marker lights once, in reading order. */
    const teach = () => {
      hint?.removeAttribute("data-quiet");
      const root = liveRef.current;
      if (taughtRef.current || !root) return;
      taughtRef.current = true;
      root.querySelectorAll('[data-mode="marker"] [data-lit]').forEach((el, i) =>
        el.animate([{ opacity: 0, easing: "ease" }, { opacity: 1, easing: "ease" }, { opacity: 0 }], {
          duration: T.teach,
          delay: i * T.teachStagger,
        }),
      );
    };
    /** Beat 2: the marked pieces squeeze into markers while the kept
     *  words close up. `keep`: a piece pressed during the pass. */
    const collapse = (keep: number | null) => {
      const root = liveRef.current;
      if ((mode !== "armed" && mode !== "playing") || !root) return;
      clearTimers();
      mode = "end";
      const kept = keep === null ? [] : [keep];
      // Inline text (no spaces): an instant swap, no FLIP.
      flipRef.current = capture(root, spaced, T.flip, kept, true);
      setKept(kept);
      setPhase("end");
      later(T.flip, teach);
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

    const near = new IntersectionObserver(
      (entries) => {
        ratio = passShare(entries[entries.length - 1]);
        if (first) {
          first = false;
          // Already 60% on screen when the page opened: keep the end state.
          // Otherwise arm now (at the viewport edge at most, before any
          // interaction; the card's height does not change).
          if (ratio >= 0.59) return;
          arm();
          return;
        }
        play();
      },
      { threshold: PASS_THRESHOLDS, rootMargin: PASS_ROOT_MARGIN },
    );
    // Fully out of view: back to the first frame for the next entry.
    const away = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1].isIntersecting) return;
      if (mode !== "armed" && !card.contains(document.activeElement)) arm();
    });
    near.observe(card);
    away.observe(card);
    document.addEventListener("visibilitychange", play);
    collapseRef.current = (keep) => collapse(keep);
    return () => {
      near.disconnect();
      away.disconnect();
      document.removeEventListener("visibilitychange", play);
      collapseRef.current = () => {};
      stop();
      hint?.removeAttribute("data-quiet");
      setPhase("end");
    };
  }, [reduced, spaced]);

  const toggle = (n: number) => {
    if (phase === "raw") {
      // Pressed during the pass: the others go now, this one stays.
      collapseRef.current(n);
      return;
    }
    if (reduced) {
      // Instant swap.
      setKept((k) => (k.includes(n) ? k.filter((x) => x !== n) : [...k, n]));
      return;
    }
    // Bring it back (it grows out of its marker, the words make room) or
    // remove it again (it squeezes into the marker, the gap closes).
    const restoring = !isKept(n);
    flipRef.current = capture(liveRef.current, spaced, T.toggle, restoring ? [n] : []);
    setKept((k) => (restoring ? [...k, n] : k.filter((x) => x !== n)));
  };

  const body = rich(t("site.auto.body"), {
    um: t("site.quote", { text: filler }),
    none: <strong className={c.em}>{t("app.start.summaryCaptionsOnly")}</strong>,
  });

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

  // The labels quote the piece as it is shown ("Keep “pause”, cut 2 of
  // 3"): a quoted label keeps its own form, so the sentence stays
  // grammatical in every language (no case endings on a bare noun). The
  // place tells the two “um” toggles apart.
  const keepLabel = (u: Extract<Unit, { k: "cut" }>) =>
    t("site.auto.keepNth", {
      text: t("site.quote", { text: u.type === "um" ? filler : pauseWord }),
      n: u.n + 1,
      total: cutCount,
    });

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
    // Both forms stay in the slot (one in flow, one waiting on its
    // centre), so a swap animates one object.
    const shown = phase === "raw" || isKept(u.n);
    return (
      <button
        key={u.key}
        type="button"
        className={c.slot}
        data-slot={u.n}
        data-mode={shown ? "token" : "marker"}
        aria-pressed={isKept(u.n)}
        aria-label={keepLabel(u)}
        onClick={() => toggle(u.n)}
      >
        {token(u.type)}
        <span key="marker" className={c.marker} data-marker>
          <span className={c.lit} data-lit />
        </span>
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
            {" "}
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
              <span ref={liveRef} className={c.live}>
                {draw(true)}
              </span>
            </p>
          </div>
          <p ref={hintRef} className={c.restore}>
            {t("site.control.restore")}
          </p>
        </div>
      </div>
    </section>
  );
}
