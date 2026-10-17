/**
 * The Captions Ring's geometry, timing and score (CaptionPlayer.tsx).
 * The geometry and timing are pure, so ring.test.ts can sample them; the
 * score keeps the ring's state outside React and reaches the page only
 * through the frames it is handed, so the tests run it with none.
 *
 * Three 9:16 frames stand on a ring seen from slightly above: one in
 * front, one right and one left, 120° apart. A frame's pose is two
 * angles: `a`, where it stands on the ring (+ is right), and `f`, its own
 * turn back toward the viewer. Its transform is always the same three
 * functions, rotateY(a) translateZ(R) rotateY(f), so every keyframe
 * between two poses interpolates angle by angle and the frame travels
 * along the circle (a different function list would cut straight through
 * the ring). At rest f = -0.75a: a side frame faces a/4 = 30° outward,
 * readable and about 70 % visible.
 *
 * A turn moves every frame the shortest way to its new slot. The frame
 * that wraps round goes behind the ring; its facing changes linearly
 * from one side's 30° to the other's, so it never shows its back, and it
 * fades out while it is behind (faceOpacity), so it never shows through
 * the gap between the two frames that pass in front of it.
 */
import type { CaptionWord } from "@/lib/captions/types";
import type { LiveCaptionHandle } from "./LiveCaption";
import { spokenUntil } from "./words";

/** The slots: front, right, left. */
export type Slot = 0 | 1 | 2;
export const SLOT_NAME = ["front", "right", "left"] as const;
/** Each slot's place on the ring (degrees). */
export const SLOT_ANGLE = [0, 120, -120] as const;

export type Pose = { a: number; f: number };

/** An angle in (-180, 180]. */
export function norm(a: number): number {
  const x = ((((a + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}

export function restPose(slot: Slot): Pose {
  const a = SLOT_ANGLE[slot];
  return { a, f: -0.75 * a };
}

/** Which way the frame faces (0: straight at the viewer). */
export function facing(p: Pose): number {
  return p.a + p.f;
}

/** Where a frame at `now` goes to stand in `slot`: the shortest way round,
 *  ending in the slot's rest pose (equal to it modulo 360°). */
export function target(now: Pose, slot: Slot): Pose {
  const s = SLOT_ANGLE[slot];
  const a = now.a + norm(s - now.a);
  return { a, f: s / 4 - a };
}

/** The pose a share `p` (0..1, eased) of the way from `from` to `to`. */
export function lerpPose(from: Pose, to: Pose, p: number): Pose {
  return { a: from.a + (to.a - from.a) * p, f: from.f + (to.f - from.f) * p };
}

/** Behind the ring, past this angle from the front, a frame is gone. */
export const FADE_TO = 150;

/** The frame's opacity at `a`: whole at the sides, gone behind the ring. */
export function faceOpacity(a: number): number {
  const d = Math.abs(norm(a));
  if (d <= 120) return 1;
  if (d >= FADE_TO) return 0;
  return (FADE_TO - d) / (FADE_TO - 120);
}

/** The veil over a side frame (a --surface-0 wash): none in front, half
 *  at the sides, so the front frame reads first. */
export const SIDE_VEIL = 0.5;

export function veilOpacity(a: number): number {
  return (SIDE_VEIL * Math.min(120, Math.abs(norm(a)))) / 120;
}

/** The transform of a pose, R in px. */
export function poseTransform(p: Pose, r: number): string {
  return `rotateY(${round(p.a)}deg) translateZ(${round(r)}px) rotateY(${round(p.f)}deg)`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The angles on the way from a0 to a1 where faceOpacity or veilOpacity
 *  bends, as shares of the way (0 and 1 included): keyframes there make
 *  the linear interpolation between them exact. */
export function bends(a0: number, a1: number): number[] {
  const out = new Set<number>([0, 1]);
  if (a0 !== a1) {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    for (const b of [0, 120, -120, FADE_TO, -FADE_TO, 180]) {
      for (let x = b + 360 * Math.ceil((lo - b) / 360); x < hi; x += 360) {
        if (x > lo) out.add((x - a0) / (a1 - a0));
      }
    }
  }
  return [...out].sort((x, y) => x - y);
}

export type MoveKeyframes = { transform: Keyframe[]; face: Keyframe[]; veil: Keyframe[] };

/**
 * One frame's keyframes from `from` to `to`, linear: the easing goes on
 * the effect, so an offset is a share of the way, and the opacities stay
 * functions of where the frame is. `face0` / `veil0` are the frame's
 * opacities on screen now (an interrupted move starts from them).
 */
export function moveKeyframes(from: Pose, to: Pose, r: number, face0: number, veil0: number): MoveKeyframes {
  const offsets = bends(from.a, to.a);
  const at = (o: number) => from.a + (to.a - from.a) * o;
  return {
    transform: [{ transform: poseTransform(from, r) }, { transform: poseTransform(to, r) }],
    face: offsets.map((o) => ({ offset: o, opacity: o === 0 ? face0 : faceOpacity(at(o)) })),
    veil: offsets.map((o) => ({ offset: o, opacity: o === 0 ? veil0 : veilOpacity(at(o)) })),
  };
}

/* ── Timing ── */

/** A turn of the ring between two styles (ms), and one the visitor asked
 *  for (a pick: quicker, it answers a click). */
export const TURN_MS = 1200;
export const PICK_MS = 800;
/** The first reveal: the side frames swing out from behind the front one,
 *  left first, then right. */
export const FAN_FROM = 12;
export const FAN_MS = 900;
export const FAN_STAGGER_MS = 200;

/** The settled page after the last word (s). */
export const HOLD = 0.6;

/** One pass of the caption (s): its words, then the settled page. A
 *  style stays in front for exactly one pass, then the ring turns. */
export function passLength(lastEnd: number): number {
  return lastEnd + HOLD;
}

/** Does the front caption's clock, going from `prev` to `c` (s), end a
 *  pass? After a turn it starts below zero (the lead-in while the ring
 *  brings the style round), so the first pass ends at `pass`, not as the
 *  clock comes up through zero. A turn comes only at a pass end, so it
 *  never cuts a word; one held past it waits for the next. */
export function passEnds(prev: number, c: number, pass: number): boolean {
  return c >= pass && Math.floor(c / pass) > Math.floor(prev / pass);
}

/** The playing pill's line (0..1): how far the front caption is through
 *  its pass. Empty in the lead-in, full as a turn comes; while a hold
 *  keeps the ring, the caption plays its pass again and the line with it. */
export function passProgress(c: number, pass: number): number {
  return Math.max(0, c % pass) / pass;
}

/* ── The score ── */

/** The slot of frame `i` while frame `front` is in front. */
export function slotOf(i: number, front: number): Slot {
  return ((i - front + 3) % 3) as Slot;
}

/** The brand curve, var(--ease-out) (WAAPI can't read a custom property). */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** The sentence's timing in this language (s). */
type Timing = { pass: number; lead: number; lastEnd: number };

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

export type Ui = {
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
 * the front changes. Everything per frame happens here, on refs. Without
 * frames to animate (the tests, a browser without WAAPI) a turn is the
 * front changing at once, on the same clock.
 */
export class RingScore {
  items: (HTMLDivElement | null)[] = [null, null, null];
  handles: (LiveCaptionHandle | null)[] = [null, null, null];
  /** The playing pill's progress line (a paused animation, scrubbed). */
  line: Pick<Animation, "currentTime"> | null = null;
  timing: Timing = { pass: 1, lead: 0, lastEnd: 0 };
  front = 0;
  /** The front caption's clock (s); negative while the ring brings it
   *  round, so its first word lands as the ring settles. */
  c = 0;
  move: Move | null = null;
  /** A pick made during the reveal: the ring turns to it after. */
  queued: number | null = null;
  started = false;
  live = false;
  /** Mouse over the stage or the controls, keyboard focus in the pills. */
  holds = new Set<string>();
  /** Seconds after the last hold before a turn may come. */
  wait = 0;
  /** Where the mouse was last seen on the screen (NaN: not yet). */
  private mouseX = NaN;
  private mouseY = NaN;
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
    this.timing = { pass: passLength(lastEnd), lead: words.length ? words[0].start : 0, lastEnd };
  }

  /** The playing pill's line, from where the clock is. */
  setLine(anim: Pick<Animation, "currentTime"> | null): void {
    this.line = anim;
    if (anim) anim.currentTime = passProgress(this.c, this.timing.pass) * 1000;
  }

  dropLine(anim: Pick<Animation, "currentTime">): void {
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
   *  is still under way) and it plays its pass from the first word; then
   *  the turns go on. The style in front, picked again, starts over the
   *  way a pass ends: its settled page for the hold, then its first word,
   *  so the pick never cuts a word. */
  pick(i: number): void {
    if (this.move?.fan) {
      this.queued = i;
      this.ui.setPending(i);
    } else if (i !== this.front) {
      this.turnTo(i, PICK_MS);
    } else if (!this.move) {
      this.handles[this.front]?.seek(this.timing.lastEnd);
      this.c = this.timing.lead - HOLD;
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

  /** The mouse over `key` (the stage, the controls) at (x, y) on the
   *  screen. Moving there (entering it from elsewhere, or moving on it)
   *  holds the next turn and leaving lets go. A cursor the page scrolls
   *  or loads under doesn't hold: it enters (and may get a move) but
   *  stays where it was last seen on the screen. */
  mouse(key: string, kind: "enter" | "move" | "leave", x: number, y: number): void {
    if (kind === "leave") {
      this.hold(key, false);
      return;
    }
    if (!Number.isNaN(this.mouseX) && (x !== this.mouseX || y !== this.mouseY)) this.hold(key, true);
    this.seen(x, y);
  }

  /** The mouse seen at (x, y) on the screen, anywhere on the page (after
   *  the ring's own handlers): an enter where it rests is no move. */
  seen(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  /** Pausing: the caption holds where it is, never on an empty page or a
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
    const { pass } = this.timing;
    const prev = this.c;
    this.c += dt;
    this.wait = Math.max(0, this.wait - dt);
    // A turn comes at the end of a pass, once nothing holds it; held,
    // the caption plays on and the turn waits for the next pass end.
    if (!this.move && passEnds(prev, this.c, pass) && this.holds.size === 0 && this.wait === 0) {
      this.turnTo((this.front + 1) % 3, TURN_MS);
      return;
    }
    if (this.c >= 0) this.handles[this.front]?.seek(this.c % pass);
    if (this.line) this.line.currentTime = passProgress(this.c, pass) * 1000;
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
