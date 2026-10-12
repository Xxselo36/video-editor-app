"use client";
/**
 * The command words: "Talk to Cleo while you film." One dictionary row
 * per spoken command, in its fixed colour, with a mini strip of the
 * recording that shows what the command does: the post (the moment it is
 * said) flares, the hatched piece it removes lifts off and its neighbours
 * close the gap, leaving a thin cut marker; “Cleo keep” brings in the
 * next scene instead.
 *
 * Each row plays once when it is 60% in view (rows entering together
 * start at least 120 ms apart), is reset when fully out of view and plays
 * again on re-entry. At rest (reduced motion, screenshots, no JS) the
 * strip shows the hatched piece in place. Motion: WAAPI on scale,
 * translate and opacity only; the closing translate is sized in cqw of
 * the strip, so it stays right when the strip changes width.
 *
 * The gap closes toward the edge the mini lines up on: the left from
 * 1024px (a left-aligned column) and wherever the mini has a line of its
 * own; the right where it sits flush right beside the word (phones,
 * tablets). A played strip never leaves a ragged edge on its aligned side.
 */
import { useEffect, useRef } from "react";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { CMD_COLOR, Cmd, rich, useCmdNodes, useReducedMotion, type CmdId } from "../shared";
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

/** The row's pass (ms). Ends by 740 ms; the keep row by 480 ms. */
const T = {
  flare: 240,
  /** the second post (“Cleo go”) flares this much later */
  flare2: 60,
  liftAt: 120,
  lift: 300,
  fadeDelay: 80,
  closeAt: 320,
  close: 420,
  mark: 200,
  newAt: 200,
  newIn: 280,
  /** rows entering together start at least this far apart */
  stagger: 120,
};
const POST_W = 3;
const GAP = 1;
const MARK_W = 3;
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

  // The command is said: its post flares (rise and settle, each on the
  // brand curve).
  parts
    .filter((el) => el.hasAttribute("data-post"))
    .forEach((post, i) =>
      add(
        post,
        [
          { scale: "1 1", easing: EASE },
          { scale: "1 1.3", offset: 0.4, easing: EASE },
          { scale: "1 1" },
        ],
        i * T.flare2,
        T.flare,
        "linear",
      ),
    );

  // “Cleo keep”: the next scene slides in.
  const fresh = parts.find((el) => el.hasAttribute("data-new"));
  if (fresh) {
    add(fresh, [{ opacity: 0, translate: "0.5rem 0" }, { opacity: 1, translate: "0 0" }], T.newAt, T.newIn);
    return out;
  }

  const gi = parts.findIndex((el) => el.hasAttribute("data-gone"));
  if (gi < 0) return out;
  const gone = parts[gi];
  const body = gone.querySelector("[data-body]");
  const mark = gone.querySelector("[data-cut]");
  if (body) {
    add(body, [{ translate: "0 0" }, { translate: "0 -0.4rem" }], T.liftAt, T.lift);
    add(body, [{ opacity: 1 }, { opacity: 0 }], T.liftAt + T.fadeDelay, T.lift - T.fadeDelay);
  }
  if (mark) add(mark, [{ opacity: 0 }, { opacity: 1 }], T.closeAt, T.mark);

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
  for (const el of movers) add(el, [{ translate: "0 0" }, { translate: `${shift} 0` }], T.closeAt, T.close);
  return out;
}

type RowState = { anims: Animation[]; played: boolean; ratio: number; timer: number; toRight: boolean };

/** Plays each row once at 60% in view, staggered; re-arms it when it is
 *  fully out of view. Nothing moves under reduced motion. */
function useRowPasses(listRef: React.RefObject<HTMLUListElement | null>, reduced: boolean) {
  useEffect(() => {
    const list = listRef.current;
    if (reduced || !list || typeof list.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    // The hook's first (hydration) value is false: never arm, even for a
    // frame, before it catches up.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cqw = typeof CSS !== "undefined" && CSS.supports("width", "1cqw");
    const wide = window.matchMedia(WIDE);
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row]"));
    const state = new Map<Element, RowState>();
    let nextFree = 0;

    const arm = (row: HTMLElement) => {
      const s = state.get(row);
      if (!s) return;
      window.clearTimeout(s.timer);
      s.anims.forEach((a) => a.cancel());
      s.toRight = closesRight(row, wide.matches);
      s.anims = armRow(row, cqw, s.toRight);
      s.played = false;
    };
    // When a mini changes place (breakpoint, rewrap), its strip closes
    // toward the other side: rebuild it, and a row that has played goes
    // straight to its end state. Checked once per frame at most.
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        for (const row of rows) {
          const s = state.get(row);
          if (!s || closesRight(row, wide.matches) === s.toRight) continue;
          const played = s.played;
          arm(row);
          if (played) {
            s.played = true;
            s.anims.forEach((a) => a.finish());
          }
        }
      });
    };
    const play = (row: Element) => {
      const s = state.get(row);
      if (!s || s.played || document.hidden || s.ratio < 0.59) return;
      s.played = true;
      const now = performance.now();
      const at = Math.max(now, nextFree);
      nextFree = at + T.stagger;
      s.timer = window.setTimeout(() => s.anims.forEach((a) => a.play()), at - now);
    };

    for (const row of rows) {
      state.set(row, { anims: [], played: false, ratio: 0, timer: 0, toRight: false });
      arm(row);
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const s = state.get(e.target);
          if (!s) continue;
          s.ratio = e.isIntersecting ? e.intersectionRatio : 0;
          if (!e.isIntersecting) {
            if (s.played) arm(e.target as HTMLElement);
          } else play(e.target);
        }
      },
      { threshold: [0, 0.6] },
    );
    rows.forEach((row) => io.observe(row));
    const onVisibility = () => rows.forEach(play);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(frame);
      for (const s of state.values()) {
        window.clearTimeout(s.timer);
        s.anims.forEach((a) => a.cancel());
      }
    };
  }, [listRef, reduced]);
}

export function CommandRowsSection() {
  const t = useT();
  const cmds = useCmdNodes();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  useRowPasses(listRef, reduced);

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
      </div>
    </section>
  );
}
