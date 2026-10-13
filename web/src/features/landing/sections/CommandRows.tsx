"use client";
/**
 * The command words: "Talk to Cleo while you film." One row per spoken
 * command, in its fixed colour, with a strip of the recording right under
 * the word that shows what the command does ("Spoken Cut"). Each row is
 * said, then edited: the word inks from a tint into its colour behind a
 * small voice caret while its post rises in the strip like a level meter;
 * the hatch marks the span out of the post; the piece folds away on a
 * hinge while the rest of the strip rides its edge shut on one critically
 * damped spring, and one marker in the command colour is left (a dashed
 * rail shows where the video got shorter). “Cleo keep” brings in the next
 * scene instead; “Cleo stop … go” grows its hatch at the speed of speech
 * and lands the go post on the stop post. Timing and contact math:
 * commandScore.ts.
 *
 * The rows cascade at reading pace, top to bottom: a row starts once the
 * one above it hands off (its close at p ≥ 0.92) and its strip's centre is
 * well on screen (6 % of the screen clear of the sticky header above and
 * the phone bar below), after scrolling has rested for 120 ms: a visitor
 * who stops with the list in view sees it play through. A row still visible above that band
 * plays when a later one is in it; a row fully out of the clear area
 * before its turn is finished unseen; a visible row is never finished in
 * place and nothing dims. The first entry per page view: the rows fade up
 * and each strip draws in, then the first row is said.
 *
 * Each strip is a button that plays its row again (tap, click, Enter,
 * Space; with a mouse also a short hover over the word and strip): it
 * fades out, re-arms unseen and fades back in as the pass starts. The
 * sequence runs longer than 5 s, so a pause control sits under the list
 * (WCAG 2.2.2): pause freezes the rows in flight and their clocks, and
 * nothing starts on its own until play (a list left while paused is
 * settled); once every row has played, play replays the list. Hidden tabs
 * hold the same way. When the list is fully out of view everything
 * re-arms unseen; re-entry plays again, without the entrance.
 *
 * At rest (reduced motion, screenshots, no JS, and a list already on
 * screen when the page hydrates) every word is in its colour and every
 * strip shows its mark: no caret, ink copy or rail; play (or a strip)
 * then rewinds softly and plays. Reduced motion: a strip toggles between
 * marked and played by a crossfade (opacity only).
 *
 * Motion: WAAPI on translate, scale, opacity and a perspective rotateY.
 * A row's animations are created paused when it is armed (unseen) and
 * played on its turn; one empty "cue" animation per row is its clock, so a
 * hold freezes everything together. Nothing re-renders while a row plays:
 * React state is the control's icon only.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import {
  CMD_COLOR,
  CMD_PHRASE,
  Cmd,
  EASE,
  PASS_ROOT_MARGIN,
  rich,
  useCmdNodes,
  useReducedMotion,
  type CmdId,
} from "../shared";
import { CARET_BARS, scoreRow, type Curve, type Piece, type Target } from "./commandScore";
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

/** Between the level meter's steps. */
const SINE = "cubic-bezier(0.37, 0, 0.63, 1)";
const CURVE: Record<Curve, string> = { brand: EASE, sine: SINE, ease: "ease", linear: "linear" };

/** The fixed chrome (shared PASS_ROOT_MARGIN): the sticky header above,
 *  the phone CTA bar below (px). */
const CHROME_TOP = 65;
const CHROME_BOTTOM = 80;
/** Scrolling must have rested this long before a row starts (ms). */
const REST = 120;
/** A hover replays after this dwell, this long after the last scroll. */
const DWELL = 180;
const HOVER_REST = 400;

/** The first entry: rows fade up, then each strip draws in (ms). */
const ENTER = { row: 280, stagger: 60, strip: 420, stripAfter: 40, firstSay: 300 };
/** A soft rewind (replay): the ink and the strip fade, the row re-arms
 *  unseen, the strip fades back in and the pass starts into that fade. */
const REWIND = { ink: 160, strip: 140, stripIn: 220, passIn: 100, stagger: 40 };
/** Reduced motion: a strip crossfades between marked and played. */
const SWAP = { out: 120, in: 180 };

/** The start band: a strip's centre between these (px from the top). */
function band(vh: number): [number, number] {
  return [CHROME_TOP + 0.06 * vh, vh - CHROME_BOTTOM - 0.06 * vh];
}

const noop = () => {};

/** One spoken command: the base text (a tint until said), its ink copy
 *  and the voice caret (aria-hidden copies, drawn only with motion). */
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
            <span key={i} className={c.bar} data-bar />
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

/** The control: none (reduced motion, before hydration), the sequence is
 *  on (pause), held by the visitor (play: continue), or played / at rest
 *  (play: replay). */
type Mode = "off" | "run" | "held" | "done";

/** still: the server's rest state (never armed); armed: on its first
 *  frame, waiting for its turn; rewinding: fading out to re-arm. */
type Phase = "still" | "armed" | "playing" | "rewinding" | "done";

type RowState = {
  el: HTMLLIElement;
  lead: HTMLElement;
  strip: HTMLElement;
  mini: HTMLElement;
  rail: HTMLElement;
  units: HTMLElement[];
  inks: HTMLElement[];
  inkIns: HTMLElement[];
  voices: HTMLElement[];
  carets: HTMLElement[];
  bars: HTMLElement[][];
  posts: HTMLElement[];
  gone: HTMLElement | null;
  movers: HTMLElement[];
  one: Partial<Record<"hatchClip" | "hatch" | "ring" | "ghost" | "newClip" | "newPiece", HTMLElement>>;
  pieces: readonly Piece[];
  /** the pass, paused on its first frame while armed */
  anims: Animation[];
  /** fades of a rewind or a crossfade */
  fx: Animation[];
  /** the pass's clock: the next row may start when it ends */
  cue: Animation | null;
  handoff: number;
  phase: Phase;
  /** bumped on every arm: a stale pass never marks its words said */
  gen: number;
  /** bumped by every rewind, crossfade or reset: a stale one stops */
  op: number;
  /** the strip's width when it was armed (px) */
  width: number;
};

function collect(el: HTMLLIElement, pieces: readonly Piece[]): RowState | null {
  const q = (s: string, root: ParentNode = el) => root.querySelector<HTMLElement>(s);
  const lead = q("[data-lead]");
  const strip = q("[data-strip]");
  const mini = q("[data-mini]");
  const rail = q("[data-rail]");
  if (!lead || !strip || !mini || !rail) return null;
  const units = Array.from(el.querySelectorAll<HTMLElement>("[data-unit]"));
  const all = (s: string) => units.map((u) => q(s, u)).filter((e): e is HTMLElement => !!e);
  const parts = Array.from(mini.children).filter((e) => e !== rail) as HTMLElement[];
  const gi = pieces.findIndex((p) => p.k === "gone");
  const one: RowState["one"] = {};
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
    el,
    lead,
    strip,
    mini,
    rail,
    units,
    inks: all("[data-ink]"),
    inkIns: all("[data-ink-in]"),
    voices: all("[data-voice]"),
    carets: all("[data-caret]"),
    bars: units.map((u) => Array.from(u.querySelectorAll<HTMLElement>("[data-bar]"))),
    posts: parts.filter((e) => e.hasAttribute("data-post")),
    gone: gi >= 0 ? parts[gi] : null,
    movers: gi >= 0 ? parts.slice(gi + 1) : [],
    one,
    pieces,
    anims: [],
    fx: [],
    cue: null,
    handoff: 0,
    phase: "still",
    gen: 0,
    op: 0,
    width: 0,
  };
}

/** The elements a score track moves. */
function targets(r: RowState, t: Target): Element[] {
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
    case "bar":
      return list(r.bars[t.unit]?.[t.bar]);
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

/** Arm a row: its pass, paused on the first frame (every animation holds
 *  its first keyframe until it starts and its last one after). Measures
 *  the removed piece once; call it while the row is unseen or unchanged
 *  to the eye (an armed row looks the same re-armed). */
function arm(r: RowState) {
  for (const a of r.anims) a.cancel();
  for (const a of r.fx) a.cancel();
  r.cue?.cancel();
  r.anims = [];
  r.fx = [];
  r.cue = null;
  const gen = ++r.gen;
  const score = scoreRow(r.pieces, r.gone?.getBoundingClientRect().width ?? 0);
  r.rail.style.width = score.rail ? `${score.rail}px` : "";
  r.handoff = score.handoff;
  r.width = r.mini.offsetWidth;
  for (const u of r.units) u.removeAttribute("data-said");
  for (const t of score.tracks) {
    const frames = t.frames.map(({ easing, ...rest }) => (easing ? { ...rest, easing: CURVE[easing] } : rest)) as Keyframe[];
    for (const el of targets(r, t.target)) {
      const a = el.animate(frames, { delay: t.delay, duration: t.duration, easing: "linear", fill: "both" });
      a.pause();
      a.currentTime = 0;
      r.anims.push(a);
      // Said: the base switches to full colour under the finished ink.
      const unit = t.target.el === "ink" ? r.units[t.target.unit] : null;
      if (unit)
        a.finished.then(() => {
          if (r.gen === gen) unit.setAttribute("data-said", "");
        }, noop);
    }
  }
  r.phase = "armed";
}

/** Straight to the played state, without motion. */
function settle(r: RowState) {
  for (const a of r.fx) a.cancel();
  r.fx = [];
  for (const a of r.anims) a.finish();
  r.cue?.cancel();
  r.cue = null;
  r.phase = "done";
}

/** Back to the server's rest state (no pass). */
function unarm(r: RowState) {
  for (const a of [...r.anims, ...r.fx]) a.cancel();
  r.cue?.cancel();
  r.anims = [];
  r.fx = [];
  r.cue = null;
  r.gen++;
  r.rail.style.width = "";
  r.phase = "still";
}

/** Plays the rows one after another under the start rule; replays a row
 *  from its strip; re-arms everything when the list is fully out of view.
 *  Under reduced motion only the strips' crossfade. */
function useRowPasses(
  listRef: React.RefObject<HTMLUListElement | null>,
  reduced: boolean,
): { mode: Mode; toggle: () => void; tap: (i: number) => void } {
  const [mode, setMode] = useState<Mode>("off");
  const toggleRef = useRef<() => void>(noop);
  const tapRef = useRef<(i: number) => void>(noop);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof list.animate !== "function") return;
    const rows = Array.from(list.querySelectorAll<HTMLLIElement>("[data-row]"), (el, i) => collect(el, ROWS[i].mini));
    if (rows.some((r) => !r)) return;
    const R = rows as RowState[];
    // The hook's first (hydration) value is false: read the setting
    // itself, before anything is armed.
    const reduce = reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // A strip whose width changed is re-armed (its fold is measured);
    // one caught mid-pass is finished, not restarted. Once per frame.
    let frame = 0;
    let onResized: (r: RowState) => void = noop;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (frame) return;
            frame = window.requestAnimationFrame(() => {
              frame = 0;
              for (const r of R) if (r.width && Math.abs(r.mini.offsetWidth - r.width) >= 1) onResized(r);
            });
          });
    R.forEach((r) => ro?.observe(r.mini));
    const teardown = () => {
      ro?.disconnect();
      window.cancelAnimationFrame(frame);
      for (const a of list.getAnimations({ subtree: true })) a.cancel();
      for (const r of R) {
        unarm(r);
        r.op++;
        for (const u of r.units) u.removeAttribute("data-said");
      }
      list.removeAttribute("data-motion");
      toggleRef.current = noop;
      tapRef.current = noop;
      setMode("off");
    };

    if (reduce) {
      // Gentler, not zero: a strip crossfades between its mark (the rest
      // state) and the played result (armed and finished while unseen).
      onResized = (r) => {
        if (r.phase !== "done") return;
        arm(r);
        settle(r);
      };
      tapRef.current = (i) => {
        const r = R[i];
        if (!r || r.phase === "rewinding") return;
        const op = ++r.op;
        const played = r.phase === "done";
        r.phase = "rewinding";
        const out = r.mini.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SWAP.out, easing: "ease", fill: "both" });
        r.fx.push(out);
        out.finished.then(() => {
          if (r.op !== op) return;
          if (played) unarm(r);
          else {
            arm(r);
            settle(r);
          }
          r.fx.push(r.mini.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SWAP.in, easing: EASE }));
        }, noop);
      };
      return teardown;
    }
    if (typeof IntersectionObserver === "undefined") return teardown;

    /** data-motion is on: the ink copies, caret, rail and tint are drawn */
    let motion = false;
    /** the row whose turn it is (rows above it have played or settled) */
    let turn = R.length;
    /** the row the cascade is waiting on (its cue) */
    let current: RowState | null = null;
    const running = new Set<RowState>();
    /** the visitor paused: nothing starts on its own until play */
    let held = false;
    /** animations a hold (the visitor, a hidden tab) paused */
    let frozen: Animation[] = [];
    /** a replay of the whole list is fading rows out: the cascade waits */
    let rewinding = false;
    let replayId = 0;
    let lastScroll = -Infinity;
    /** the first row may not start before this (the entrance) */
    let notBefore = 0;
    let wake = 0;
    /** the entrance, paused on its first frame until the list enters */
    let entrance: Animation[] = [];
    let shown: Mode = "off";

    const show = (m: Mode) => {
      if (m === shown) return;
      shown = m;
      setMode(m);
    };
    const wakeAt = (at: number) => {
      window.clearTimeout(wake);
      wake = window.setTimeout(
        () => {
          wake = 0;
          step();
        },
        Math.max(0, at - performance.now()) + 4,
      );
    };
    const stopped = () => held || document.hidden;
    const done = () => {
      if (shown === "run" && turn >= R.length && !current && !running.size && !rewinding) show("done");
    };

    const run = (r: RowState, solo: boolean) => {
      const gen = r.gen;
      r.phase = "playing";
      running.add(r);
      for (const a of r.anims) a.play();
      const cue = r.el.animate([], { duration: r.handoff });
      r.cue = cue;
      if (!solo) current = r;
      cue.finished.then(() => {
        if (current !== r) return;
        current = null;
        step();
      }, noop);
      Promise.all(r.anims.map((a) => a.finished)).then(() => {
        if (r.gen !== gen) return;
        r.phase = "done";
        running.delete(r);
        done();
      }, noop);
    };

    /** The cascade: the row whose turn it is plays once its strip is in
     *  the band (or it is visible above the band while a later one is in
     *  it) and scrolling has rested; it is finished unseen once it is
     *  fully above the clear area; otherwise the turn waits. */
    const step = () => {
      if (!motion || stopped() || current || rewinding) return;
      const now = performance.now();
      if (now < notBefore) return wakeAt(notBefore);
      const vh = window.innerHeight;
      const [top, bottom] = band(vh);
      const inBand = (b: DOMRect) => {
        const mid = (b.top + b.bottom) / 2;
        return mid >= top && mid <= bottom;
      };
      while (turn < R.length) {
        const r = R[turn];
        if (r.phase !== "armed") {
          // played on its own (a tap) before its turn
          turn++;
          continue;
        }
        const box = r.strip.getBoundingClientRect();
        if (box.bottom <= CHROME_TOP) {
          settle(r);
          turn++;
          continue;
        }
        const go =
          inBand(box) ||
          (box.top < vh - CHROME_BOTTOM &&
            R.slice(turn + 1).some((n) => n.phase === "armed" && inBand(n.strip.getBoundingClientRect())));
        if (!go) return;
        if (now - lastScroll < REST) return wakeAt(lastScroll + REST);
        turn++;
        run(r, false);
        return;
      }
      done();
    };

    const freeze = () => {
      for (const r of running)
        for (const a of r.cue ? [...r.anims, r.cue] : r.anims) {
          if (a.playState !== "running") continue;
          a.pause();
          frozen.push(a);
        }
    };
    /** A hold (the visitor, a hidden tab) freezes the rows in flight and
     *  their clocks; going on thaws them and takes the next turn. */
    const sync = () => {
      if (stopped()) {
        freeze();
        return;
      }
      for (const a of frozen) if (a.playState === "paused") a.play();
      frozen = [];
      step();
    };

    /** Motion on: the ink copies, caret, rail and tint are drawn. A row
     *  at rest stays as it is (said, its ink over it) until it is armed. */
    const motionOn = () => {
      if (motion) return;
      motion = true;
      for (const r of R) if (r.phase === "still") for (const u of r.units) u.setAttribute("data-said", "");
      list.setAttribute("data-motion", "");
    };
    /** Every row on its first frame, the turn back at the top. */
    const armAll = () => {
      motionOn();
      replayId++;
      rewinding = false;
      current = null;
      frozen = [];
      running.clear();
      for (const r of R) {
        r.op++;
        arm(r);
      }
      turn = 0;
      show("run");
    };

    /** The first entry: the rows fade up and each strip draws in (a wipe:
     *  the strip and its content counter-translate). Created paused while
     *  the list is out of view, played as it enters. */
    const prepareEntrance = () => {
      R.forEach((r, i) => {
        const row = i * ENTER.stagger;
        const strip = row + ENTER.stripAfter;
        entrance.push(
          r.el.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], {
            duration: ENTER.row,
            delay: row,
            easing: EASE,
            fill: "backwards",
          }),
          r.strip.animate([{ translate: "-100% 0" }, { translate: "0 0" }], {
            duration: ENTER.strip,
            delay: strip,
            easing: EASE,
            fill: "backwards",
          }),
          r.mini.animate([{ translate: "100% 0" }, { translate: "0 0" }], {
            duration: ENTER.strip,
            delay: strip,
            easing: EASE,
            fill: "backwards",
          }),
        );
      });
      for (const a of entrance) {
        a.pause();
        a.currentTime = 0;
      }
    };
    const playEntrance = () => {
      if (!entrance.length) return;
      for (const a of entrance) a.play();
      entrance = [];
      notBefore = performance.now() + (R.length - 1) * ENTER.stagger + ENTER.stripAfter + ENTER.strip + ENTER.firstSay;
      wakeAt(notBefore);
    };

    /** The list is fully out of view: everything back to the first frame
     *  for the next entry (no entrance then); while paused, settle instead
     *  (it does not play by itself). */
    const leave = () => {
      window.clearTimeout(wake);
      wake = 0;
      if (!held) {
        armAll();
        return;
      }
      replayId++;
      rewinding = false;
      current = null;
      frozen = [];
      running.clear();
      for (const r of R) {
        r.op++;
        if (r.phase === "still") continue;
        if (r.phase === "rewinding") arm(r);
        settle(r);
      }
      turn = R.length;
      show("held");
    };

    /** One row again: the ink and the strip fade, the row re-arms unseen
     *  and fades back in; resolves (true) 100 ms into that fade-in, when
     *  its pass should start. */
    const rewind = (r: RowState, delay: number): Promise<boolean> => {
      const op = ++r.op;
      if (current === r) current = null;
      running.delete(r);
      r.cue?.cancel();
      r.cue = null;
      r.phase = "rewinding";
      // Under the ink, unseen: the base waits in its tint again.
      for (const u of r.units) u.removeAttribute("data-said");
      const fades = [
        ...[...r.inks, ...r.voices].map((el) =>
          el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REWIND.ink, delay, easing: "ease", fill: "both" }),
        ),
        r.mini.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REWIND.strip, delay, easing: "ease", fill: "both" }),
      ];
      r.fx.push(...fades);
      return Promise.all(fades.map((a) => a.finished)).then(
        () => {
          if (r.op !== op) return false;
          // One task: arm drops the fades, the fade-in starts invisible.
          arm(r);
          r.phase = "rewinding";
          r.fx.push(
            r.mini.animate([{ opacity: 0, translate: "0 3px" }, { opacity: 1, translate: "0 0" }], {
              duration: REWIND.stripIn,
              easing: EASE,
            }),
          );
          const lead = r.mini.animate([], { duration: REWIND.passIn });
          r.fx.push(lead);
          return lead.finished.then(
            () => {
              if (r.op !== op) return false;
              r.phase = "armed";
              return true;
            },
            () => false,
          );
        },
        () => false,
      );
    };
    /** A played row (or the rest state) plays again, on its own. */
    const replay = (r: RowState) => {
      motionOn();
      rewind(r, 0).then((ok) => {
        if (ok) run(r, true);
      });
    };
    /** Play after the end (or at rest): the visible rows rewind top to
     *  bottom, the others re-arm unseen; then the cascade starts again
     *  under the start rule. */
    const replayAll = () => {
      motionOn();
      held = false;
      frozen = [];
      current = null;
      running.clear();
      window.clearTimeout(wake);
      wake = 0;
      turn = 0;
      const id = ++replayId;
      rewinding = true;
      show("run");
      const vh = window.innerHeight;
      let k = 0;
      const resets = R.map((r) => {
        if (r.phase === "armed") return Promise.resolve(true);
        const b = r.el.getBoundingClientRect();
        if (b.bottom <= 0 || b.top >= vh) {
          r.op++;
          arm(r);
          return Promise.resolve(true);
        }
        return rewind(r, k++ * REWIND.stagger);
      });
      Promise.all(resets).then(() => {
        if (id !== replayId) return;
        rewinding = false;
        step();
      });
    };

    toggleRef.current = () => {
      if (shown === "run") {
        held = true;
        show("held");
        sync();
      } else if (shown === "held" && (frozen.length || current || turn < R.length)) {
        held = false;
        show("run");
        sync();
      } else {
        replayAll();
      }
    };
    /** A strip pressed: a played row (or the rest state) plays again; the
     *  row whose turn it is starts now; a later one plays on its own. An
     *  explicit press plays even while paused. */
    tapRef.current = (i) => {
      const r = R[i];
      if (!r || r.phase === "playing" || r.phase === "rewinding") return;
      if (r.phase !== "armed") {
        replay(r);
        return;
      }
      const isTurn = R[turn] === r;
      if (isTurn) turn++;
      run(r, !isTurn || !!current || stopped());
    };
    onResized = (r) => {
      if (r.phase === "armed") arm(r);
      else if (r.phase === "playing" || r.phase === "done") {
        const wasCurrent = current === r;
        running.delete(r);
        arm(r);
        settle(r);
        if (wasCurrent) {
          current = null;
          step();
        } else done();
      }
    };

    // Hover replays (a mouse over the word and strip): a real move, a
    // short dwell, the page at rest; once per hover, never while paused or
    // while that row plays.
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const unhover = R.map((r) => {
      let dwell = 0;
      let used = false;
      const quiet = () => performance.now() - lastScroll >= HOVER_REST;
      const move = (e: PointerEvent) => {
        if (e.pointerType !== "mouse" || used || dwell || !fine.matches) return;
        // A pointer the page scrolled under has not moved.
        if (!e.movementX && !e.movementY) return;
        if (!quiet()) return;
        dwell = window.setTimeout(() => {
          dwell = 0;
          if (held || !quiet() || (r.phase !== "done" && r.phase !== "still")) return;
          used = true;
          replay(r);
        }, DWELL);
      };
      const out = () => {
        window.clearTimeout(dwell);
        dwell = 0;
        used = false;
      };
      r.lead.addEventListener("pointermove", move);
      r.lead.addEventListener("pointerleave", out);
      return () => {
        out();
        r.lead.removeEventListener("pointermove", move);
        r.lead.removeEventListener("pointerleave", out);
      };
    });

    const onScroll = () => {
      lastScroll = performance.now();
      if (motion && !stopped() && turn < R.length) wakeAt(lastScroll + REST);
    };
    // Wakes the cascade when a strip crosses the clear area without a
    // scroll (layout changes); step() itself reads the band.
    const near = new IntersectionObserver(() => step(), {
      rootMargin: PASS_ROOT_MARGIN,
      threshold: [0, 0.5, 1],
    });
    const enter = new IntersectionObserver(
      (entries) => {
        if (!entries[entries.length - 1].isIntersecting || !motion) return;
        playEntrance();
        enter.disconnect();
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    let first = true;
    const away = new IntersectionObserver((entries) => {
      const on = entries[entries.length - 1].isIntersecting;
      if (first) {
        first = false;
        if (on) {
          // On screen at hydration: the rest state stays (nothing is
          // armed in view); play replays it softly. Armed once it leaves.
          enter.disconnect();
          show("done");
          return;
        }
        armAll();
        prepareEntrance();
        return;
      }
      if (!on) leave();
    });
    R.forEach((r) => near.observe(r.strip));
    enter.observe(list);
    away.observe(list);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", sync);
    return () => {
      near.disconnect();
      enter.disconnect();
      away.disconnect();
      unhover.forEach((off) => off());
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", sync);
      window.clearTimeout(wake);
      entrance = [];
      // A replay still settling after this (its fades cancelled) must not
      // wake the cascade.
      motion = false;
      replayId++;
      teardown();
    };
  }, [listRef, reduced]);

  return { mode, toggle: () => toggleRef.current(), tap: (i) => tapRef.current(i) };
}

export function CommandRowsSection() {
  const t = useT();
  const cmds = useCmdNodes();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const { mode, toggle, tap } = useRowPasses(listRef, reduced);
  const quoted = (ids: CmdId[]) => ids.map((id) => t("site.quote", { text: CMD_PHRASE[id] })).join(" … ");

  return (
    <section className={styles.section} aria-labelledby="commands-title">
      <div className={styles.wrap}>
        <h2 id="commands-title" className={styles.h2}>
          {t("site.commands.title")}
        </h2>
        <p className={styles.body}>{rich(t("site.commands.sub"), cmds)}</p>
        <p className={c.note}>{t("site.commands.note")}</p>
        <ul ref={listRef} className={c.cmdList}>
          {ROWS.map((row, i) => (
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
                        {" "}
                        <small className={c.ellipsis}>…</small>
                      </span>{" "}
                      <Said id={row.ids[1]} />
                    </>
                  ) : (
                    <Said id={row.ids[0]} />
                  )}
                </h3>
                <button
                  type="button"
                  className={c.strip}
                  data-strip
                  aria-label={t("site.commands.replay", { cmd: quoted(row.ids) })}
                  onClick={() => tap(i)}
                >
                  <Strip parts={row.mini} />
                </button>
              </div>
              <p className={c.desc}>{t(row.desc)}</p>
            </li>
          ))}
        </ul>
        {/* Only while the passes can run (not in the server HTML, not
            under reduced motion); out of flow, so it moves nothing. The
            two icons crossfade. */}
        {mode !== "off" && (
          <div className={c.passBar}>
            <IconButton
              label={mode === "run" ? t("site.demo.pause") : t("site.demo.play")}
              className={c.passToggle}
              data-mode={mode}
              onClick={toggle}
            >
              <Icon icon={Pause} size={16} className={c.icPause} />
              <Icon icon={Play} size={16} className={c.icPlay} />
            </IconButton>
          </div>
        )}
      </div>
    </section>
  );
}
