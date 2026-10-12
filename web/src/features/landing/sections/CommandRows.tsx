"use client";
/**
 * The command words: "Talk to Cleo while you film." One dictionary row
 * per spoken command, in its fixed colour, with a mini strip of the
 * recording that shows what the command does: the post (the moment it is
 * said) flares, a beat, then the hatched piece it removes lifts off and
 * its neighbours close the gap, leaving a thin cut marker; “Cleo keep”
 * brings in the next scene instead.
 *
 * The rows play strictly one after another, top to bottom (each pass
 * about 1.5 to 2 s, a short beat between two): a row starts once the one
 * above it has finished and it is itself 60% in view, clear of the sticky
 * header and the phone bar. The playing row is lit (its word and mini at
 * full strength, the other rows' a little quieter; opacity only, so
 * nothing moves). A row the visitor scrolled past before its turn (it is
 * out of view, a later row is in view) is settled without motion and the
 * turn moves on; a row still below waits for them. Played rows stay
 * played until the list is fully out of view: then every row re-arms and
 * the sequence plays again on re-entry.
 *
 * The sequence runs longer than 5 s, so a pause control sits under the
 * list (WCAG 2.2.2): pause holds the playing row where it is and nothing
 * starts on its own until play (a list left while paused is settled);
 * play continues, or replays from the top once every row has played.
 * Hidden tabs hold the same way.
 *
 * At rest (reduced motion, screenshots, no JS) the strip shows the
 * hatched piece in place, every row at full strength, and no control.
 * Motion: WAAPI on scale, translate and opacity only; the closing
 * translate is sized in cqw of the strip, so it stays right when the
 * strip changes width. The light is a CSS opacity transition on
 * data-playing / data-active (Cleanup.module.css). Nothing re-renders
 * while a row plays: React state is the control's icon only.
 *
 * The gap closes toward the edge the mini lines up on: the left from
 * 1024px (a left-aligned column) and wherever the mini has a line of its
 * own; the right where it sits flush right beside the word (phones,
 * tablets). A played strip never leaves a ragged edge on its aligned side.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { CMD_COLOR, Cmd, PASS_ROOT_MARGIN, rich, useCmdNodes, useReducedMotion, type CmdId } from "../shared";
import styles from "../Landing.module.css";
import c from "./Cleanup.module.css";

/** The brand curve: every UI enter, exit and on-screen travel. */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Piece weights are flex-grow values; posts are 3px bars. */
type Piece = { k: "seg" | "gone" | "new"; g: number } | { k: "post" };

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

/** One row's pass (ms from the moment it lights up): said, a beat, then
 *  removed. It ends by 1720 ms; “Cleo stop … go” by 2040 ms (two posts),
 *  “Cleo keep” by 1520 ms. The whole list takes about 10 s. */
const T = {
  /** the row lights up first, then its command is said */
  lead: 160,
  /** the post flares: a quick rise, a slow settle */
  flare: 560,
  /** “Cleo go” is said this much after “Cleo stop” */
  flare2: 320,
  /** after the flare: the beat between said and removed */
  hold: 120,
  lift: 440,
  /** the lifting piece starts to fade this much later */
  fadeDelay: 100,
  /** the gap starts to close this far into the lift (the curve is
   *  front-loaded: the piece is nearly gone by then) */
  closeIn: 320,
  close: 560,
  /** the cut marker fades in this far into the close */
  markIn: 240,
  mark: 320,
  /** “Cleo keep”: the next scene slides in */
  newIn: 680,
  /** from one row's end to the next row's start */
  beat: 320,
  /** the next row is not in view yet: the light stays on the last row
   *  this long (a visitor still scrolling never sees it flicker), then
   *  every row is back at full strength while the turn waits */
  grace: 1000,
};
const POST_W = 3;
const GAP = 1;
const MARK_W = 3;
/** A row counts as in view from here (threshold 0.6, with some slack). */
const IN_VIEW = 0.59;
/** From here the minis form a left-aligned column (Cleanup.module.css). */
const WIDE = "(min-width: 1024px)";

/** Does this row's mini sit flush right beside its word (not on a line of
 *  its own, not in the desktop column)? Then its gap closes rightward. */
function closesRight(row: HTMLElement, wide: boolean): boolean {
  const mini = row.querySelector("[data-mini]");
  if (wide || !mini) return false;
  return mini.getBoundingClientRect().left - row.getBoundingClientRect().left > 1;
}

function Mini({ parts }: { parts: Piece[] }) {
  return (
    <span className={c.mini} data-mini aria-hidden="true">
      {parts.map((p, i) =>
        p.k === "post" ? (
          <span key={i} className={c.post} data-post />
        ) : p.k === "gone" ? (
          <span key={i} className={c.gone} style={{ "--g": p.g } as React.CSSProperties} data-gone={p.g}>
            <span className={c.goneBody} data-body />
            <span className={c.cutMark} data-cut />
          </span>
        ) : (
          <span
            key={i}
            className={c.piece}
            style={{ "--g": p.g } as React.CSSProperties}
            data-g={p.g}
            data-new={p.k === "new" || undefined}
          />
        ),
      )}
    </span>
  );
}

/** One row's pass, paused on its first frame (armed). Every animation
 *  holds its first keyframe until it starts and its last one after.
 *  `toRight`: the pieces before the removed one close the gap rightward
 *  (and the cut marker sits at its right end, see .cutMark). */
function armRow(row: HTMLElement, cqw: boolean, toRight: boolean): Animation[] {
  const mini = row.querySelector<HTMLElement>("[data-mini]");
  if (!mini) return [];
  mini.dataset.close = toRight ? "right" : "left";
  const out: Animation[] = [];
  const add = (el: Element, frames: Keyframe[], delay: number, duration: number, easing = EASE) => {
    const a = el.animate(frames, { delay, duration, easing, fill: "both" });
    a.pause();
    a.currentTime = 0;
    out.push(a);
  };
  const parts = Array.from(mini.children) as HTMLElement[];
  const posts = parts.filter((el) => el.hasAttribute("data-post"));

  // The command is said: its post flares, thicker and taller, then
  // settles (each half on the brand curve).
  posts.forEach((post, i) =>
    add(
      post,
      [
        { scale: "1 1", easing: EASE },
        { scale: "1.7 1.4", offset: 0.3, easing: EASE },
        { scale: "1 1" },
      ],
      T.lead + i * T.flare2,
      T.flare,
      "linear",
    ),
  );
  // …a beat after the last post has settled, the command acts.
  const said = T.lead + (posts.length - 1) * T.flare2 + T.flare + T.hold;

  // “Cleo keep”: the next scene slides in.
  const fresh = parts.find((el) => el.hasAttribute("data-new"));
  if (fresh) {
    add(fresh, [{ opacity: 0, translate: "0.75rem 0" }, { opacity: 1, translate: "0 0" }], said, T.newIn);
    return out;
  }

  const gi = parts.findIndex((el) => el.hasAttribute("data-gone"));
  if (gi < 0) return out;
  const gone = parts[gi];
  const body = gone.querySelector("[data-body]");
  const mark = gone.querySelector("[data-cut]");
  const closeAt = said + T.closeIn;
  if (body) {
    add(body, [{ translate: "0 0" }, { translate: "0 -0.5rem" }], said, T.lift);
    add(body, [{ opacity: 1 }, { opacity: 0 }], said + T.fadeDelay, T.lift - T.fadeDelay);
  }
  if (mark) add(mark, [{ opacity: 0 }, { opacity: 1 }], closeAt + T.markIn, T.mark);

  // Its neighbours on one side close the gap up to a 3px cut marker. The
  // shift is the removed piece's width minus the marker: its share of the
  // strip's flexible width (100cqw minus posts and gaps).
  const movers = toRight ? parts.slice(0, gi) : parts.slice(gi + 1);
  if (!movers.length) return out;
  const sign = toRight ? 1 : -1;
  let shift: string;
  if (cqw) {
    let sum = 0;
    let fixed = (parts.length - 1) * GAP;
    for (const el of parts) {
      if (el.hasAttribute("data-post")) fixed += POST_W;
      else sum += Number(el.dataset.g ?? el.dataset.gone ?? 0);
    }
    const share = Number(gone.dataset.gone) / sum;
    shift = `calc(${(sign * share).toFixed(5)} * (100cqw - ${fixed}px) ${toRight ? "-" : "+"} ${MARK_W}px)`;
  } else {
    // Measured once (no container units).
    shift = `${sign * (gone.getBoundingClientRect().width - MARK_W)}px`;
  }
  for (const el of movers) add(el, [{ translate: "0 0" }, { translate: `${shift} 0` }], closeAt, T.close);
  return out;
}

/** The control's state: no control (reduced motion, before hydration),
 *  the sequence is on (pause), held by the visitor (play: continue), or
 *  every row has played (play: replay). */
type Mode = "off" | "run" | "held" | "done";

type RowState = {
  el: HTMLElement;
  anims: Animation[];
  phase: "armed" | "playing" | "done";
  /** share of the row in the clear area (threshold-precise: 0, < 0.6, ≥ 0.6) */
  ratio: number;
  toRight: boolean;
};

/** Plays the rows one after another, top to bottom, each once it is in
 *  view (clear of the fixed chrome); re-arms them all when the list is
 *  fully out of view. Nothing moves under reduced motion. */
function useRowPasses(
  listRef: React.RefObject<HTMLUListElement | null>,
  reduced: boolean,
): { mode: Mode; toggle: () => void } {
  const [mode, setMode] = useState<Mode>("off");
  const toggleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const list = listRef.current;
    if (reduced || !list || typeof list.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    // The hook's first (hydration) value is false: never arm, even for a
    // frame, before it catches up.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cqw = typeof CSS !== "undefined" && CSS.supports("width", "1cqw");
    const wide = window.matchMedia(WIDE);
    const rows: RowState[] = Array.from(list.querySelectorAll<HTMLElement>("[data-row]"), (el) => ({
      el,
      anims: [],
      phase: "armed",
      ratio: 0,
      toRight: false,
    }));
    const byEl = new Map<Element, RowState>(rows.map((r) => [r.el, r]));

    /** the row whose turn it is (rows above it have played or settled) */
    let turn = 0;
    /** the row mid-pass */
    let current: RowState | null = null;
    /** bumped whenever a pass ends or is dropped: a stale pass's
     *  `finished` promise is ignored */
    let pass = 0;
    /** the visitor paused: nothing starts on its own until play */
    let held = false;
    /** the current pass's animations paused by a hold */
    let frozen: Animation[] = [];
    let beatTimer = 0;
    let graceTimer = 0;
    let lit: HTMLElement | null = null;
    let shown: Mode = "off";

    const show = (m: Mode) => {
      if (m === shown) return;
      shown = m;
      setMode(m);
    };
    /** Light one row (the others step back), or none. */
    const light = (row: HTMLElement | null) => {
      window.clearTimeout(graceTimer);
      graceTimer = 0;
      if (row === lit) return;
      lit?.removeAttribute("data-active");
      lit = row;
      if (row) {
        row.setAttribute("data-active", "");
        list.setAttribute("data-playing", "");
      } else {
        list.removeAttribute("data-playing");
      }
    };
    const arm = (r: RowState) => {
      r.anims.forEach((a) => a.cancel());
      r.toRight = closesRight(r.el, wide.matches);
      r.anims = armRow(r.el, cqw, r.toRight);
      r.phase = "armed";
    };
    /** Straight to the played state, without motion. */
    const settle = (r: RowState) => {
      r.anims.forEach((a) => a.finish());
      r.phase = "done";
    };
    /** Drop the pass in flight and any pending beat. */
    const reset = () => {
      pass++;
      current = null;
      frozen = [];
      window.clearTimeout(beatTimer);
      beatTimer = 0;
    };
    const stopped = () => held || document.hidden;
    /** The next turn, a beat from now. */
    const afterBeat = () => {
      window.clearTimeout(beatTimer);
      beatTimer = window.setTimeout(() => {
        beatTimer = 0;
        step();
      }, T.beat);
    };
    const start = (r: RowState) => {
      current = r;
      r.phase = "playing";
      light(r.el);
      const id = ++pass;
      r.anims.forEach((a) => a.play());
      Promise.all(r.anims.map((a) => a.finished)).then(
        () => {
          if (id !== pass) return;
          r.phase = "done";
          pass++;
          current = null;
          afterBeat();
        },
        // Cancelled (re-armed): that pass was dropped.
        () => {},
      );
    };
    /** The row whose turn it is plays once it is in view (or partly in
     *  view at the top while a later row is in view); it is settled
     *  without motion once the visitor has scrolled past it (out of view,
     *  a later row in view); otherwise the turn waits for it. */
    const step = () => {
      if (stopped() || current || beatTimer) return;
      while (turn < rows.length) {
        const r = rows[turn];
        const ahead = rows.some((n, i) => i > turn && n.ratio >= IN_VIEW);
        if (r.ratio >= IN_VIEW || (r.ratio > 0 && ahead)) {
          turn++;
          start(r);
          return;
        }
        if (!ahead) {
          if (lit && !graceTimer) graceTimer = window.setTimeout(() => light(null), T.grace);
          return;
        }
        settle(r);
        turn++;
      }
      light(null);
      show("done");
    };
    /** A hold (the visitor, a hidden tab) freezes the pass in flight;
     *  going on thaws it, or takes the next turn after a beat. */
    const sync = () => {
      if (stopped()) {
        window.clearTimeout(beatTimer);
        beatTimer = 0;
        for (const a of current?.anims ?? []) {
          if (a.playState !== "running") continue;
          a.pause();
          frozen.push(a);
        }
        // Paused by the visitor: every row back at full strength.
        if (held) light(null);
        return;
      }
      // Only what the hold paused (play() rewinds a finished animation).
      for (const a of frozen) if (a.playState === "paused") a.play();
      frozen = [];
      if (current) light(current.el);
      else if (!beatTimer) afterBeat();
    };
    const replay = () => {
      held = false;
      reset();
      rows.forEach(arm);
      turn = 0;
      show("run");
      step();
    };
    /** The list is fully out of view: re-arm for the next entry; while
     *  paused, settle instead (it does not play by itself). */
    const leave = () => {
      reset();
      light(null);
      if (held) {
        for (const r of rows) if (r.phase !== "done") settle(r);
        turn = rows.length;
        show("held");
        return;
      }
      for (const r of rows) if (r.phase !== "armed") arm(r);
      turn = 0;
      show("run");
    };
    toggleRef.current = () => {
      if (shown === "run") {
        held = true;
        show("held");
        sync();
      } else if (shown === "held" && (current || turn < rows.length)) {
        held = false;
        show("run");
        sync();
      } else {
        replay();
      }
    };

    // When a mini changes place (breakpoint, rewrap), its strip closes
    // toward the other side: rebuild it. A row that has played (or is
    // mid-pass) goes straight to its end state. Checked once per frame at
    // most.
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        for (const r of rows) {
          if (closesRight(r.el, wide.matches) === r.toRight) continue;
          const phase = r.phase;
          arm(r);
          if (phase === "armed") continue;
          settle(r);
          if (r !== current) continue;
          pass++;
          current = null;
          frozen = [];
          if (!stopped()) afterBeat();
        }
      });
    };

    rows.forEach(arm);
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const r = byEl.get(e.target);
          if (r) r.ratio = e.isIntersecting ? e.intersectionRatio : 0;
        }
        step();
      },
      { threshold: [0, 0.6], rootMargin: PASS_ROOT_MARGIN },
    );
    // Fully out of view: back to the first frame for the next entry.
    const away = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting) leave();
      else if (shown === "off") show("run");
    });
    rows.forEach((r) => near.observe(r.el));
    away.observe(list);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", onResize);
    return () => {
      near.disconnect();
      away.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(frame);
      reset();
      light(null);
      rows.forEach((r) => r.anims.forEach((a) => a.cancel()));
      toggleRef.current = () => {};
      setMode("off");
    };
  }, [listRef, reduced]);

  return { mode, toggle: () => toggleRef.current() };
}

export function CommandRowsSection() {
  const t = useT();
  const cmds = useCmdNodes();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const { mode, toggle } = useRowPasses(listRef, reduced);

  return (
    <section className={styles.section} aria-labelledby="commands-title">
      <div className={styles.wrap}>
        <h2 id="commands-title" className={styles.h2}>
          {t("site.commands.title")}
        </h2>
        <p className={styles.body}>{rich(t("site.commands.sub"), cmds)}</p>
        <p className={c.note}>{t("site.commands.note")}</p>
        <ul ref={listRef} className={c.cmdList}>
          {ROWS.map((row) => {
            const pair = row.ids.length === 2;
            return (
              <li
                key={row.ids.join("-")}
                className={c.row}
                data-row
                data-pair={pair || undefined}
                style={{ "--c": CMD_COLOR[row.ids[0]] } as React.CSSProperties}
              >
                <h3 className={c.word}>
                  {pair ? (
                    <>
                      <span className={c.unit}>
                        <Cmd id={row.ids[0]} inherit /> <small className={c.ellipsis}>…</small>
                      </span>{" "}
                      <span className={c.unit}>
                        <Cmd id={row.ids[1]} inherit />
                      </span>
                    </>
                  ) : (
                    <Cmd id={row.ids[0]} inherit />
                  )}
                </h3>
                <Mini parts={row.mini} />
                <p className={c.desc}>{t(row.desc)}</p>
              </li>
            );
          })}
        </ul>
        {/* Only while the passes can run (not in the server HTML, not
            under reduced motion); out of flow, so it moves nothing. */}
        {mode !== "off" && (
          <div className={c.passBar}>
            <IconButton
              label={mode === "run" ? t("site.demo.pause") : t("site.demo.play")}
              className={c.passToggle}
              onClick={toggle}
            >
              <Icon icon={mode === "run" ? Pause : Play} size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </section>
  );
}
