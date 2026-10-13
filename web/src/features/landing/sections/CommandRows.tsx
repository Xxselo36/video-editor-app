"use client";
/**
 * The command words: "Talk to Cleo while you film." One row per spoken
 * command, in its fixed colour, with a strip of the recording right under
 * the word that shows what the command does ("Spoken Cut"). Each row is
 * said, then edited: the word inks from a tint into its colour behind a
 * small voice caret while its post rises in the strip; the hatch marks
 * the span out of the post; the piece folds away on a hinge while the
 * rest of the strip rides its edge shut on the hinge spring's shape, and
 * one marker in the command colour is left (a dashed rail shows where the
 * video got shorter). “Cleo keep” brings in the next scene instead; “Cleo
 * stop … go” grows its hatch from one post to the next and lands the go
 * post on the stop post. The choreography and the contact math:
 * commandScore.ts.
 *
 * The scroll plays the rows; nothing here has a clock of its own (a row
 * playing on its own time while the page moved read as stutter). A row
 * starts when its strip's centre reaches the middle of the screen and is
 * edited once its lane, about 140 px of scrolling, is through; the next
 * lane starts only after that (commandScroll.ts), so one row plays at a
 * time, top to bottom. Scrolling up plays it backwards; rows above stay
 * edited, rows below wait unsaid, and a fling or a jump lands every row
 * where its position puts it. Nothing moves while the page stands still,
 * so there is no pause control (WCAG 2.2.2 asks for one for motion that
 * runs by itself) and no replay: scrolling back is the replay.
 *
 * Where the browser has view timelines (Safari 26, Chrome 115, Firefox
 * 159), each row runs on the timeline of its probe (Cleanup.module.css
 * .probe), off the main thread, and no script runs while scrolling except
 * a one-shot check that the engine agrees with the formula. Elsewhere, or
 * when it does not, one passive scroll listener seeks the same animations
 * (paused) once a frame while the list is near. The timeline's inset is
 * always 0px: its default is the scroll padding, which the page sets for
 * its sticky header and which would start every row 80 px early.
 *
 * Never give the strip, the lead, the row, the list, the section or the
 * page overflow hidden, auto or scroll, position: sticky,
 * content-visibility or display: contents: the probe's timeline then
 * follows that box instead of the page, or nothing, and the rows freeze
 * without an error. Clip with overflow: clip.
 *
 * At rest (reduced motion, screenshots, no JS) every word is in its
 * colour and every strip shows its mark; nothing is attached, and turning
 * reduced motion on detaches everything. Attaching is one long task, so
 * it waits for an idle moment or for the list to come near, never
 * hydration; rows already on screen by then fade into their scroll
 * positions once (320 ms, the only timed motion left). A language change
 * only swaps the words and attaches nothing anew.
 *
 * Motion: WAAPI on translate, scale, opacity and one fixed transform list
 * (the lift and a perspective rotateY), 61 animations created once and
 * re-keyed in place when a strip changes width. Nothing re-renders.
 */
import { useEffect, useRef } from "react";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { CMD_COLOR, Cmd, EASE, EASE_SCRUB, rich, useCmdNodes, useReducedMotion, type CmdId } from "../shared";
import { CARET_BARS, scoreRow, type Curve, type Piece, type Target, type Track } from "./commandScore";
import { fallbackProgress, laneLengths, progress } from "./commandScroll";
import styles from "../Landing.module.css";
import c from "./Cleanup.module.css";

const ROWS: { ids: CmdId[]; desc: MessageKey; mini: Piece[] }[] = [
  {
    ids: ["start"],
    desc: "site.commands.start",
    mini: [{ k: "gone", g: 2 }, { k: "post" }, { k: "seg", g: 3 }, { k: "seg", g: 2 }],
  },
  {
    ids: ["cut"],
    desc: "site.commands.cut",
    mini: [{ k: "seg", g: 2 }, { k: "gone", g: 3 }, { k: "post" }, { k: "seg", g: 3 }],
  },
  {
    ids: ["keep"],
    desc: "site.commands.keep",
    mini: [{ k: "seg", g: 3 }, { k: "post" }, { k: "new", g: 3 }],
  },
  {
    ids: ["stop", "go"],
    desc: "site.commands.stopgo",
    mini: [{ k: "seg", g: 2 }, { k: "post" }, { k: "gone", g: 2 }, { k: "post" }, { k: "seg", g: 2 }],
  },
  {
    ids: ["finish"],
    desc: "site.commands.finish",
    mini: [{ k: "seg", g: 3 }, { k: "seg", g: 2 }, { k: "post" }, { k: "gone", g: 2 }],
  },
];

const CURVE: Record<Curve, string> = { linear: "linear", scrub: EASE_SCRUB, ease: "ease" };

/** The fallback's animations are this long (ms) and seeked to p × SEEK;
 *  while scrolling a row stops 0.1 ms short of its end, the settle once
 *  the list is away lands on it. */
const SEEK = 1000;
/** A list on screen at hydration: its visible rows fade out of the rest
 *  state and back in at their scroll positions (ms). */
const FADE = { out: 120, in: 200 };
/** The native path's check: once a row is this far into its lane, every
 *  row's timeline must agree with the formula within `tolerance`; lanes
 *  that moved more than `still` px while it waited are looked at again. */
const CHECK = { from: 0.1, to: 0.9, tolerance: 0.05, still: 1 };
/** The attach waits for an idle moment (at most `idle` ms) or for the
 *  list to come within `near` of the viewport, whichever is first. */
const ATTACH = { idle: 1000, near: "200% 0px" };

const noop = () => {};

/** One spoken command: the base text (a tint while the rows play), its
 *  ink copy and the voice caret (aria-hidden copies, drawn only with
 *  motion). */
function Said({ id }: { id: CmdId }) {
  return (
    <span className={c.unit} data-unit>
      <span className={c.say}>
        <Cmd id={id} inherit />
      </span>
      <span className={c.ink} aria-hidden="true" data-ink>
        <span className={c.inkIn} data-ink-in>
          <Cmd id={id} inherit />
        </span>
      </span>
      <span className={c.voice} aria-hidden="true" data-voice>
        <span className={c.caret} data-caret>
          {Array.from({ length: CARET_BARS }, (_, i) => (
            <span key={i} className={c.bar} />
          ))}
        </span>
      </span>
    </span>
  );
}

/** The strip: takes (waveforms), posts, the removed piece (hatch over a
 *  take), the next scene (“Cleo keep”) and the rail. */
function Strip({ parts }: { parts: readonly Piece[] }) {
  const keep = parts.some((p) => p.k === "new");
  const ringAt = keep ? parts.findIndex((p) => p.k === "post") - 1 : -1;
  return (
    <span className={c.mini} data-mini aria-hidden="true">
      <span className={c.rail} data-rail />
      {parts.map((p, i) => {
        if (p.k === "post") return <span key={i} className={c.post} data-post />;
        const style = { "--g": p.g } as React.CSSProperties;
        if (p.k === "gone")
          return (
            <span key={i} className={c.gone} style={style} data-gone>
              <span className={c.goneBase} />
              <span className={c.hatchClip} data-hatch-clip>
                <span className={c.hatch} data-hatch />
              </span>
            </span>
          );
        if (p.k === "new")
          return (
            <span key={i} className={c.newSlot} style={style}>
              <span className={c.ghostSlot} data-ghost />
              <span className={c.newClip} data-new-clip>
                <span className={c.newPiece} data-new-piece />
              </span>
            </span>
          );
        return (
          <span key={i} className={c.piece} style={style}>
            {i === ringAt && <span className={c.keepRing} data-ring />}
          </span>
        );
      })}
    </span>
  );
}

type Row = {
  lead: HTMLElement;
  probe: HTMLElement;
  mini: HTMLElement;
  rail: HTMLElement;
  inks: HTMLElement[];
  inkIns: HTMLElement[];
  voices: HTMLElement[];
  carets: HTMLElement[];
  posts: HTMLElement[];
  gone: HTMLElement | null;
  movers: HTMLElement[];
  one: Partial<Record<"hatchClip" | "hatch" | "ring" | "ghost" | "newClip" | "newPiece", HTMLElement>>;
  pieces: readonly Piece[];
  /** its view timeline and range, or the fallback's paused length */
  timing: KeyframeAnimationOptions;
  /** one per track and element, in score order (a re-score re-keys them) */
  anims: Animation[];
  /** the strip's width when it was scored (px) */
  width: number;
  /** its lane: the probe's top in the list, and its length (px) */
  off: number;
  len: number;
  /** the fallback's last seek (-1: none yet) */
  p: number;
};

function collect(el: HTMLLIElement, pieces: readonly Piece[]): Row | null {
  const q = (s: string, root: ParentNode = el) => root.querySelector<HTMLElement>(s);
  const lead = q("[data-lead]");
  const probe = q("[data-probe]");
  const mini = q("[data-mini]");
  const rail = q("[data-rail]");
  if (!lead || !probe || !mini || !rail) return null;
  const units = Array.from(el.querySelectorAll<HTMLElement>("[data-unit]"));
  const all = (s: string) => units.map((u) => q(s, u)).filter((e): e is HTMLElement => !!e);
  const parts = Array.from(mini.children).filter((e) => e !== rail) as HTMLElement[];
  const gi = pieces.findIndex((p) => p.k === "gone");
  const one: Row["one"] = {};
  for (const [k, s] of [
    ["hatchClip", "[data-hatch-clip]"],
    ["hatch", "[data-hatch]"],
    ["ring", "[data-ring]"],
    ["ghost", "[data-ghost]"],
    ["newClip", "[data-new-clip]"],
    ["newPiece", "[data-new-piece]"],
  ] as const) {
    const e = q(s, mini);
    if (e) one[k] = e;
  }
  return {
    lead,
    probe,
    mini,
    rail,
    inks: all("[data-ink]"),
    inkIns: all("[data-ink-in]"),
    voices: all("[data-voice]"),
    carets: all("[data-caret]"),
    posts: parts.filter((e) => e.hasAttribute("data-post")),
    gone: gi >= 0 ? parts[gi] : null,
    movers: gi >= 0 ? parts.slice(gi + 1) : [],
    one,
    pieces,
    timing: {},
    anims: [],
    width: 0,
    off: 0,
    len: 1,
    p: -1,
  };
}

/** The elements a score track moves. */
function targets(r: Row, t: Target): Element[] {
  const list = (e: Element | null | undefined) => (e ? [e] : []);
  switch (t.el) {
    case "ink":
      return list(r.inks[t.unit]);
    case "inkIn":
      return list(r.inkIns[t.unit]);
    case "voice":
      return list(r.voices[t.unit]);
    case "caret":
      return list(r.carets[t.unit]);
    case "post":
      return list(r.posts[t.post]);
    case "gone":
      return list(r.gone);
    case "movers":
      return r.movers;
    case "rail":
      return [r.rail];
    default:
      return list(r.one[t.el]);
  }
}

const keyframes = (t: Track) =>
  t.frames.map(({ easing, ...rest }) => (easing ? { ...rest, easing: CURVE[easing] } : rest)) as Keyframe[];

/** The row scored at gone width `w`: its rail's width set, and each
 *  element it moves with its keyframes, in score order. */
function plan(r: Row, w: number): [Element, Keyframe[]][] {
  const score = scoreRow(r.pieces, w);
  r.rail.style.width = score.rail ? `${score.rail}px` : "";
  return score.tracks.flatMap((t) => {
    const frames = keyframes(t);
    return targets(r, t.target).map((el): [Element, Keyframe[]] => [el, frames]);
  });
}

/** The removed piece's laid-out width: the fold's transform leaves it
 *  alone, so it is right at any p. */
const goneWidth = (r: Row) => (r.gone ? parseFloat(getComputedStyle(r.gone).width) || 0 : 0);

/** The lane as a view timeline range: exit-crossing (the probe's top
 *  crossing the viewport's top edge, to its bottom crossing it), or exit,
 *  the same while the probe is shorter than the screen; null without view
 *  timelines. */
function nativeRange(): readonly [string, string] | null {
  if (typeof ViewTimeline !== "function" || typeof CSS === "undefined" || !CSS.supports) return null;
  for (const name of ["exit-crossing", "exit"]) {
    const range = [`${name} 0%`, `${name} 100%`] as const;
    if (CSS.supports("animation-range", range.join(" "))) return range;
  }
  return null;
}

/** Plays the rows with the scroll: on view timelines where the browser
 *  has them and gets them right, else by one scroll listener; nothing
 *  under reduced motion. Not tied to the language: a new one swaps the
 *  text inside the spans the animations hold, and the ResizeObserver
 *  re-fits whatever it moved (re-attaching would flash the rest state,
 *  and every visitor not reading English would attach twice). */
function useScrubRows(listRef: React.RefObject<HTMLUListElement | null>, reduced: boolean) {
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof list.animate !== "function") return;
    // The hook's first (hydration) value is false: read the setting itself.
    if (reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const found = Array.from(list.querySelectorAll<HTMLLIElement>("[data-row]"), (el, i) => collect(el, ROWS[i].mini));
    if (found.some((r) => !r)) return;
    const rows = found as Row[];
    const range = nativeRange();
    let path: "native" | "js" = range ? "native" : "js";
    let live = true;
    /** the list's top in the document when the lanes were measured */
    let listY = 0;
    /** stops the running path's listeners and observers */
    let unpath = noop;
    let fades: Animation[] = [];

    /** The lanes: each probe's top in the list and its length, shortened
     *  (inline) where the next lane would start too soon. Returns the
     *  list's top on screen. */
    const measure = () => {
      for (const r of rows) r.probe.style.height = "";
      const top = list.getBoundingClientRect().top;
      const boxes = rows.map((r) => r.probe.getBoundingClientRect());
      const lens = laneLengths(boxes.map((b) => b.top), boxes[0].height);
      listY = top + window.scrollY;
      rows.forEach((r, i) => {
        r.off = boxes[i].top - top;
        r.len = lens[i];
        if (lens[i] < boxes[i].height) r.probe.style.height = `${lens[i]}px`;
      });
      return top;
    };

    /** The fallback's seek: each row whose p changed since the last one,
     *  or every row, exactly, when settling. One layout read. */
    const sync = (settle = false) => {
      const top = list.getBoundingClientRect().top;
      for (const r of rows) {
        const p = fallbackProgress(top, r.off, r.len);
        if (!settle && Math.abs(p - r.p) <= 1e-4) continue;
        r.p = p;
        const t = settle ? p * SEEK : Math.min(p * SEEK, SEEK - 0.1);
        for (const a of r.anims) a.currentTime = t;
      }
    };

    /** Row `r` scored at gone width `w`, its animations made anew. */
    const animate = (r: Row, w: number) => {
      for (const a of r.anims) a.cancel();
      r.p = -1;
      r.anims = plan(r, w).map(([el, frames]) => el.animate(frames, r.timing));
      if (!r.timing.timeline) for (const a of r.anims) a.pause();
    };

    /** A strip changed width: the row re-scored, its animations re-keyed
     *  in place (timelines and layers stay). */
    const rescore = (r: Row, w: number) => {
      if (typeof KeyframeEffect === "undefined" || !("setKeyframes" in KeyframeEffect.prototype)) {
        animate(r, w);
        return;
      }
      plan(r, w).forEach(([, frames], i) => (r.anims[i]?.effect as KeyframeEffect | null)?.setKeyframes(frames));
    };

    /** Every animation in the list off: the rows', a fade's. */
    const cancelAll = () => {
      for (const r of rows) for (const a of r.anims) a.cancel();
      for (const a of fades) a.cancel();
      for (const a of list.getAnimations?.({ subtree: true }) ?? []) a.cancel();
      for (const r of rows) r.anims = [];
      fades = [];
    };

    /** Every row on the current path, then data-motion, in one task: the
     *  first frame is already the scroll's. */
    const arm = () => {
      performance.mark("commands:attach-start");
      const widths = rows.map((r) => {
        r.width = r.mini.offsetWidth;
        return goneWidth(r);
      });
      measure();
      const make = () =>
        rows.forEach((r, i) => {
          r.timing =
            path === "native" && range
              ? {
                  timeline: new ViewTimeline({ subject: r.probe, axis: "block", inset: "0px" }),
                  rangeStart: range[0],
                  rangeEnd: range[1],
                  fill: "both",
                }
              : { duration: SEEK, fill: "both" };
          animate(r, widths[i]);
        });
      try {
        make();
      } catch (e) {
        if (path === "js") throw e;
        // View timelines, yet these options throw: the fallback.
        cancelAll();
        path = "js";
        make();
      }
      list.setAttribute("data-motion", path);
      if (path === "js") sync(true);
      unpath = path === "native" ? check() : drive();
      performance.mark("commands:attach-end");
    };

    /** The native path's one check, once some row is well into its lane:
     *  every row's timeline must agree with the formula (an engine can
     *  take the options and still get the range or the inset wrong), or
     *  the rows move to the fallback. Until then a passive scroll
     *  listener, only while the list is on screen, tests the cached lanes
     *  (no layout read); a resize re-measures them, since the middle line
     *  is in svh and moves with the viewport's height while no strip
     *  changes size. Returns its stop. */
    const check = () => {
      let frame = 0;
      let listening = false;
      /** the lanes when the wait for the timelines began */
      let waited: number[] = [];
      const midLane = (ps: number[]) => ps.some((p) => p >= CHECK.from && p <= CHECK.to);
      const cached = () => rows.map((r) => progress(window.scrollY, listY + r.off, r.len));
      const lanes = () => [listY, ...rows.flatMap((r) => [r.off, r.len])];
      const verify = () => {
        frame = 0;
        // The lanes as they are now: the cache may be stale (something
        // above the list changed height, the viewport did).
        const top = measure();
        // Lanes that moved during the wait need not be the ones the
        // timelines sampled: look again two frames on.
        if (lanes().some((v, i) => Math.abs(v - waited[i]) > CHECK.still)) {
          soon();
          return;
        }
        const ps = rows.map((r) => fallbackProgress(top, r.off, r.len));
        if (!midLane(ps)) return;
        stop();
        const agree = rows.every((r, i) => {
          const got = r.anims[0]?.effect?.getComputedTiming().progress;
          return typeof got === "number" && Math.abs(got - ps[i]) <= CHECK.tolerance;
        });
        if (agree) return;
        unpath();
        cancelAll();
        path = "js";
        arm();
      };
      // Two frames on: the timelines have sampled this scroll position.
      const soon = () => {
        if (frame || !midLane(cached())) return;
        waited = lanes();
        frame = requestAnimationFrame(() => (frame = requestAnimationFrame(verify)));
      };
      const listen = (on: boolean) => {
        if (on === listening) return;
        listening = on;
        if (on) window.addEventListener("scroll", soon, { passive: true });
        else window.removeEventListener("scroll", soon);
        if (on) soon();
      };
      const onResize = () => {
        measure();
      };
      // The observer's first report starts the listener if the list is on
      // screen: no scroll read inside the attach, whose style is dirty.
      const io =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver((entries) => listen(entries[entries.length - 1].isIntersecting));
      const stop = () => {
        io?.disconnect();
        listen(false);
        window.removeEventListener("resize", onResize);
        cancelAnimationFrame(frame);
        frame = 0;
      };
      if (io) io.observe(list);
      else listen(true);
      window.addEventListener("resize", onResize);
      return stop;
    };

    /** The fallback: while the list is within a screen of the viewport,
     *  one passive scroll listener seeks the rows once a frame; leaving
     *  settles every row on 0 or 1. Returns its stop. */
    const drive = () => {
      let frame = 0;
      let listening = false;
      const onScroll = () => {
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            sync();
          });
      };
      const listen = (on: boolean) => {
        if (on === listening) return;
        listening = on;
        if (on) window.addEventListener("scroll", onScroll, { passive: true });
        else {
          window.removeEventListener("scroll", onScroll);
          cancelAnimationFrame(frame);
          frame = 0;
        }
        sync(!on);
      };
      const onResize = () => {
        measure();
        sync(true);
      };
      // Back from the bfcache: the scroll may have been restored anywhere.
      const onShow = (e: PageTransitionEvent) => {
        if (e.persisted) sync(true);
      };
      const io =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver((entries) => listen(entries[entries.length - 1].isIntersecting), {
              rootMargin: "100% 0px",
            });
      if (io) io.observe(list);
      else listen(true);
      window.addEventListener("resize", onResize);
      window.addEventListener("pageshow", onShow);
      return () => {
        io?.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pageshow", onShow);
        cancelAnimationFrame(frame);
      };
    };

    // A strip that changed width (resize, rotation, fonts, a language) is
    // re-scored in place, and the lanes re-measured; once a frame, never
    // during a plain scroll.
    let fit = 0;
    const refit = () => {
      fit = 0;
      if (!list.hasAttribute("data-motion")) return;
      const changed = rows.flatMap((r) => {
        const width = r.mini.offsetWidth;
        return Math.abs(width - r.width) >= 1 ? [{ r, width, w: goneWidth(r) }] : [];
      });
      measure();
      for (const { r, width, w } of changed) {
        r.width = width;
        rescore(r, w);
      }
      if (path === "js") sync(true);
      else if (changed.length) {
        // Checked again where the new score is mid-lane.
        unpath();
        unpath = check();
      }
    };
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!fit) fit = requestAnimationFrame(refit);
          });
    ro?.observe(list);
    for (const r of rows) ro?.observe(r.mini);

    // The attach (61 animations, 5 timelines) is one long task: it waits
    // for an idle moment, or for the list to come near if that is sooner,
    // so it never lengthens hydration. Without an idle callback (Safari)
    // the list coming near starts it. Rows on screen by then (a reload
    // mid-page, a tall screen) fade out of the rest state and back in at
    // their scroll positions; out of view the swap is unseen.
    let begun = false;
    let idle = 0;
    let near: IntersectionObserver | null = null;
    const begin = () => {
      if (begun) return;
      begun = true;
      near?.disconnect();
      if (idle) cancelIdleCallback(idle);
      const vh = window.innerHeight;
      const seen = rows.filter((r) => {
        const b = r.lead.getBoundingClientRect();
        return b.bottom > 0 && b.top < vh;
      });
      if (!seen.length) {
        arm();
        return;
      }
      fades = seen.map((r) =>
        r.lead.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE.out, easing: "ease", fill: "forwards" }),
      );
      Promise.all(fades.map((a) => a.finished)).then(() => {
        if (!live) return;
        for (const a of fades) a.cancel();
        arm();
        fades = seen.map((r) => r.lead.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE.in, easing: EASE }));
      }, noop);
    };
    if (typeof IntersectionObserver !== "undefined") {
      near = new IntersectionObserver(
        (entries) => {
          if (entries[entries.length - 1].isIntersecting) begin();
        },
        { rootMargin: ATTACH.near },
      );
      near.observe(list);
    }
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(begin, { timeout: ATTACH.idle });
    else if (!near) begin();

    return () => {
      live = false;
      near?.disconnect();
      if (idle) cancelIdleCallback(idle);
      unpath();
      unpath = noop;
      ro?.disconnect();
      cancelAnimationFrame(fit);
      cancelAll();
      list.removeAttribute("data-motion");
      for (const r of rows) {
        r.rail.style.width = "";
        r.probe.style.height = "";
      }
    };
  }, [listRef, reduced]);
}

export function CommandRowsSection() {
  const t = useT();
  const cmds = useCmdNodes();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  useScrubRows(listRef, reduced);

  return (
    <section className={styles.section} aria-labelledby="commands-title">
      <div className={styles.wrap}>
        <h2 id="commands-title" className={styles.h2}>
          {t("site.commands.title")}
        </h2>
        <p className={styles.body}>{rich(t("site.commands.sub"), cmds)}</p>
        <p className={c.note}>{t("site.commands.note")}</p>
        <ul ref={listRef} className={c.cmdList} data-testid="command-rows">
          {ROWS.map((row) => (
            <li
              key={row.ids.join("-")}
              className={c.row}
              data-row
              style={{ "--c": CMD_COLOR[row.ids[0]] } as React.CSSProperties}
            >
              <div className={c.lead} data-lead>
                <h3 className={c.word}>
                  {row.ids.length === 2 ? (
                    <>
                      <span className={c.pairHead}>
                        <Said id={row.ids[0]} />
                        {" "}
                        <small className={c.ellipsis}>…</small>
                      </span>{" "}
                      <Said id={row.ids[1]} />
                    </>
                  ) : (
                    <Said id={row.ids[0]} />
                  )}
                </h3>
                {/* The probe is the row's lane on the page (commandScroll.ts). */}
                <div className={c.strip} data-strip>
                  <span className={c.probe} data-probe aria-hidden="true" />
                  <Strip parts={row.mini} />
                </div>
              </div>
              <p className={c.desc}>{t(row.desc)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
