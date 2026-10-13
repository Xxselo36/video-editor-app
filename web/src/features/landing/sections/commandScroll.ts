/**
 * Where the command rows play (sections/CommandRows.tsx): each row's lane
 * on the page and its progress there. Pure, so the one-row-at-a-time rule
 * is unit-tested (commandScroll.test.ts); the script fallback, the native
 * path's self-check and the e2e suite all read progress through it.
 *
 * A row's lane starts when the centre of its strip reaches the middle
 * line M (the middle of what the fixed chrome leaves clear, a static line
 * in svh, so a phone's toolbar never moves it) and ends L px of scrolling
 * later: p = (scrollY − (centre − M)) / L, clamped. The page lays the
 * lanes out with a probe per row (Cleanup.module.css .probe), an element
 * whose top sits M px above its strip's centre and whose height is L: its
 * top crossing the viewport's top edge is the lane (a view timeline's
 * exit-crossing range). Every lane ends LANE_GAP px before the next one
 * starts, so at most one row is ever in flight, and the rows play in
 * order however fast the page is flung.
 */

/** The fixed chrome: the sticky header (64 px + its 1 px border) and,
 *  on phones, the CTA bar (shared PASS_ROOT_MARGIN). */
export const CHROME_TOP = 65;
export const CHROME_BOTTOM = 80;

/** The still scroll between two lanes, at least (px). */
export const LANE_GAP = 12;

/** The middle line: the middle of the area between the header (`top`)
 *  and the bottom bar (`bottom`) on a viewport `vh` tall (px from the
 *  viewport's top). Cleanup.module.css --scrub-mid computes the same. */
export function middleLine(vh: number, top = CHROME_TOP, bottom = 0): number {
  return top + (vh - top - bottom) / 2;
}

/** Each lane's start: the scroll position at which the strip's centre
 *  (document px) is on the middle line. */
export function laneStarts(centres: readonly number[], mid: number): number[] {
  return centres.map((c) => c - mid);
}

/** Each lane's length: `cssLen`, or shorter where the next lane starts
 *  less than `cssLen + gap` later (`probeTops`, in any one frame of
 *  reference, in order). The last keeps `cssLen`. */
export function laneLengths(probeTops: readonly number[], cssLen: number, gap = LANE_GAP): number[] {
  return probeTops.map((top, i) =>
    i < probeTops.length - 1 ? Math.max(1, Math.min(cssLen, probeTops[i + 1] - top - gap)) : cssLen,
  );
}

/** A row's progress at `scrollY` in the lane that starts at `start` and
 *  runs `len` px. */
export function progress(scrollY: number, start: number, len: number): number {
  return Math.min(1, Math.max(0, (scrollY - start) / len));
}

/** The same from what the script fallback reads per frame: the list's top
 *  on screen and the probe's offset in the list (the probe's top on
 *  screen crosses 0 as the lane starts). */
export function fallbackProgress(listTop: number, probeOff: number, len: number): number {
  return Math.min(1, Math.max(0, -(listTop + probeOff) / len));
}

/** The rows in flight: strictly between 0 and 1. */
export function inFlight(ps: readonly number[]): number[] {
  return ps.flatMap((p, i) => (p > 0 && p < 1 ? [i] : []));
}
