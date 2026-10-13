/**
 * The page's one entrance for what sits between the demos: a short rise
 * into place on the brand curve, once per load. The hero, the commands
 * list, the caption ring and the SmartCam figure keep their own motion.
 * A lazy chunk (app/page.tsx loads it once the page has hydrated): it
 * only ever moves what is below the fold, so it never holds up the hero.
 *
 * - Only what is wholly below the fold once this runs takes part, parked
 *   by a paused Web Animation (no attribute, no class): the server HTML,
 *   a page without JS and React's hydration all see every element at
 *   rest.
 * - It never stands between a visitor and the text: what is still
 *   parked on screen when scrolling rests goes in then, and what was
 *   scrolled past unseen (a jump) is let go at once.
 */
import { EASE } from "./shared";

/** The id of every entrance animation. A demo inside a unit waits for
 *  its unit's entrance to finish before it starts moving, so two things
 *  never start at once (sections/BonusClips.tsx waits on its figure's). */
const ENTRANCE_ID = "landing-entrance";

/** What enters: in every section below the hero (except one marked
 *  data-entrance="own", which has its own), the heading and the lines
 *  right under it, and the units a section marks with data-entrance:
 *  "frame", a demo figure without an entrance of its own; "row", a list
 *  row whose [data-entrance-part] pieces arrive together ("rule",
 *  "icon", "text"); "phase", a list row that rises as a whole. */
type Kind = "text" | "frame" | "row" | "phase";
type Move = { from: Keyframe; to: Keyframe; ms: number };
const MOVE: Record<Exclude<Kind, "row">, Move> = {
  text: { from: { opacity: 0, translate: "0 12px" }, to: { opacity: 1, translate: "0 0" }, ms: 420 },
  frame: { from: { opacity: 0, translate: "0 16px", scale: "0.98" }, to: { opacity: 1, translate: "0 0", scale: "1" }, ms: 480 },
  phase: { from: { opacity: 0, translate: "0 8px" }, to: { opacity: 1, translate: "0 0" }, ms: 280 },
};
/** A row's pieces: its rule draws in from the start edge, the icon tile
 *  fades up from a little smaller, the text rises. */
const PART: Record<string, Move> = {
  rule: { from: { scale: "0 1" }, to: { scale: "1 1" }, ms: 480 },
  icon: { from: { opacity: 0, scale: "0.92" }, to: { opacity: 1, scale: "1" }, ms: 200 },
  text: { from: { opacity: 0, translate: "0 8px" }, to: { opacity: 1, translate: "0 0" }, ms: 280 },
};
/** Reduced motion: every piece only fades in. */
const FADE: Move = { from: { opacity: 0 }, to: { opacity: 1 }, ms: 200 };
/** Units that cross together go in reading order, this far apart (ms)
 *  after a unit of each kind, a batch's delays within ENTRANCE_SPREAD. */
const STEP: Record<Kind, number> = { text: 60, frame: 60, row: 70, phase: 50 };
const ENTRANCE_SPREAD = 360;
/** A unit enters as it crosses this line (88 % of the viewport)... */
const ENTRANCE_MARGIN = "0px 0px -12% 0px";
/** ...or when scrolling rests this long with it still parked on screen. */
const SCROLL_REST_MS = 160;

/** Parks the units of `main` below the fold (every section but the one
 *  with class `heroClass`) and lets each enter as it comes up. Returns
 *  the teardown: everything parked is let go at rest. */
export function startEntrances(main: HTMLElement, heroClass: string): () => void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scope = `section:not(.${CSS.escape(heroClass)}):not([data-entrance="own"])`;
  const found = main.querySelectorAll<HTMLElement>(
    `${scope} :is(h2, h2 ~ p:not(.sr-only)), ${scope} [data-entrance]:not([data-entrance="own"])`,
  );
  type Unit = { el: HTMLElement; kind: Kind; anims: Animation[] };
  const parked = new Map<Element, Unit>();
  const all: Animation[] = [];
  const fold = window.innerHeight;
  // Every position first, then the animations: a parked unit's own
  // offset would otherwise force a style pass per element.
  const below = Array.from(found).filter((el) => el.getBoundingClientRect().top >= fold);
  for (const el of below) {
    const mark = el.dataset.entrance;
    const kind: Kind = mark === "frame" || mark === "row" || mark === "phase" ? mark : "text";
    const pieces: [HTMLElement, Move][] =
      kind === "row"
        ? Array.from(el.querySelectorAll<HTMLElement>("[data-entrance-part]"), (p) => [p, PART[p.dataset.entrancePart ?? ""] ?? PART.text])
        : [[el, MOVE[kind]]];
    const anims = pieces.map(([p, m]) => {
      const move = reduced ? FADE : m;
      const a = p.animate([move.from, move.to], {
        duration: move.ms,
        easing: reduced ? "ease" : EASE,
        fill: "backwards",
        id: ENTRANCE_ID,
      });
      a.pause();
      return a;
    });
    all.push(...anims);
    parked.set(el, { el, kind, anims });
  }
  if (!parked.size) return () => {};

  let rest = 0;
  // The earliest the next unit may start (performance.now()): a batch
  // that crosses right after another waits its turn, so reading order
  // holds across batches too.
  let next = 0;
  const stop = () => {
    io.disconnect();
    window.removeEventListener("scroll", onScroll);
    window.clearTimeout(rest);
  };
  const release = (u: Unit) => {
    parked.delete(u.el);
    io.unobserve(u.el);
  };
  const enter = (units: Unit[]) => {
    units.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const now = performance.now();
    let delay = Math.min(Math.max(0, next - now), ENTRANCE_SPREAD);
    for (const u of units) {
      release(u);
      for (const a of u.anims) {
        a.effect?.updateTiming({ delay });
        a.play();
      }
      next = now + delay + STEP[u.kind];
      delay = Math.min(delay + STEP[u.kind], ENTRANCE_SPREAD);
    }
    if (!parked.size) stop();
  };
  const io = new IntersectionObserver(
    (entries) => {
      const now: Unit[] = [];
      for (const e of entries) {
        const u = parked.get(e.target);
        if (u && e.isIntersecting) now.push(u);
      }
      if (now.length) enter(now);
    },
    { rootMargin: ENTRANCE_MARGIN },
  );
  const settle = () => {
    const h = window.innerHeight;
    const now: Unit[] = [];
    for (const u of parked.values()) {
      const r = u.el.getBoundingClientRect();
      if (r.bottom <= 0) {
        release(u);
        for (const a of u.anims) a.finish();
      } else if (r.top < h) now.push(u);
    }
    if (now.length) enter(now);
    else if (!parked.size) stop();
  };
  function onScroll() {
    window.clearTimeout(rest);
    rest = window.setTimeout(settle, SCROLL_REST_MS);
  }
  for (const el of parked.keys()) io.observe(el);
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    stop();
    for (const a of all) a.cancel();
  };
}
