/**
 * Caption engine v2 entry points (UT2): buildPages → layoutPage →
 * drawCaptions. Pure and deterministic (no RNG, no clock): the same words,
 * style and time give the same pixels in the editor and on the render
 * worker.
 *
 * Animations are quantized to ANIM_STEPS keyframes per page-in / word-in,
 * so the bitmap cache (cache.ts) and this direct path draw identical
 * frames. The karaoke sweep is the only continuous effect: it is a clipped
 * second layer in both paths.
 */
import { drawPage, drawSweep, sweepRect, textBand, type DrawState } from "./draw";
import { buildPages, layoutPage } from "./layout";
import type { CaptionStyle, Ctx2D, Page, PageLayout } from "./types";

export { buildPages, layoutPage };

export const ANIM_STEPS = 6;

export type FrameState = DrawState & {
  /** Page index. */
  page: number;
  /** Cache key of the drawn bitmap (page, active word, animation steps). */
  key: string;
  /** Karaoke: spoken part of the active word, 0..1; null for other styles. */
  sweep: number | null;
};

/** Index of the page shown at `t`, or -1. Pages are sorted by start. */
export function pageIndexAt(pages: readonly Page[], t: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < pages[found].end ? found : -1;
}

/** The active word: the last word on the page with start ≤ t. */
export function activeIndex(page: Page, t: number): number {
  let ai = -1;
  page.words.forEach((w, i) => {
    if (t >= w.start) ai = i;
  });
  return ai;
}

function step(age: number, dur: number, kind: string): number {
  if (kind === "none" || !(dur > 0) || age >= dur || age < 0) return ANIM_STEPS;
  return Math.min(ANIM_STEPS - 1, Math.floor((age / dur) * ANIM_STEPS));
}

const progress = (k: number) => (k >= ANIM_STEPS ? 1 : (k + 0.5) / ANIM_STEPS);

/** What the frame at output time `t` shows, or null (no caption). */
export function frameState(pages: readonly Page[], t: number, style: CaptionStyle): FrameState | null {
  const pi = pageIndexAt(pages, t);
  if (pi < 0) return null;
  const page = pages[pi];
  const active = activeIndex(page, t);
  const A = style.animation;
  const ks = step(t - page.start, A.pageInSec, A.pageIn);
  const w = page.words[Math.max(0, active)];
  const kw = active >= 0 ? step(t - w.start, A.wordInSec, A.wordIn) : ANIM_STEPS;
  const sweep =
    style.highlight.mode === "karaoke" && active >= 0
      ? Math.min(1, Math.max(0, (t - w.start) / Math.max(0.05, w.end - w.start)))
      : null;
  return {
    page: pi,
    active,
    pageP: progress(ks),
    wordP: progress(kw),
    key: `${pi}:${active}:${ks}:${kw}`,
    sweep,
  };
}

export type DrawResult = { page: Page; layout: PageLayout; state: FrameState };

/**
 * Draws the caption for output time `t` straight onto `ctx` (a W×H
 * canvas; the caller clears it). Returns what was drawn, or null.
 */
export function drawCaptions(
  ctx: Ctx2D,
  pages: readonly Page[],
  t: number,
  style: CaptionStyle,
  opts: { W: number; H: number; lang?: string },
): DrawResult | null {
  const state = frameState(pages, t, style);
  if (!state) return null;
  const page = pages[state.page];
  const layout = layoutPage(page, style, opts);
  drawPage(ctx, page, layout, style, state, opts.lang);
  if (state.sweep !== null) {
    const rect = sweepRect(layout, state.active, state.sweep);
    if (rect) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      drawSweep(ctx, page, layout, style, state, opts.lang);
      ctx.restore();
    }
  }
  return { page, layout, state };
}

/** The word under canvas point (x, y), for click-to-select (UT5). */
export function hitTest(page: Page, layout: PageLayout, style: CaptionStyle, x: number, y: number) {
  const band = textBand(style, layout);
  const pad = 0.12 * layout.px;
  for (const line of layout.lines) {
    if (y < line.baseline - band.above - pad || y > line.baseline + band.below + pad) continue;
    for (const b of line.words) {
      if (x >= b.x - pad && x <= b.x + b.width + pad) {
        const w = page.words[b.k];
        return { k: b.k, index: w.index, id: w.id, text: w.source };
      }
    }
  }
  return null;
}
