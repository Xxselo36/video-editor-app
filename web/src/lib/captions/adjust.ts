/**
 * Per-caption position and size (UT5): pure helpers over a style's
 * overrides, shared by the editor's caption layer and the tests.
 *
 * - A caption is identified by the id of its page's first word
 *   (`captionIdOf`); `overrides.captions[id] = {y?, sizeScale?}` replaces
 *   the style's own y / sizeScale for that caption ("Nur hier").
 * - "Überall" writes the style's own y / sizeScale instead and drops the
 *   caption's own values, so it follows the style again.
 * - Every write first removes the keys of all words on the page: after a
 *   re-paging (another style, words per caption) an older key may sit on
 *   a later word of the same page (layout.ts pageAdjust takes the first).
 */
import type { CaptionAdjust, CaptionStyle, Page, StyleOverrides } from "./types";

/** The caption's id: its first word's id (null without word ids). */
export function captionIdOf(page: Page): string | null {
  return page.words[0]?.id ?? null;
}

/** Position and size the page is drawn with, and whether they are its own. */
export function effectiveAdjust(style: CaptionStyle, page: Page): { y: number; sizeScale: number; own: boolean } {
  const a = page.adjust;
  return {
    y: a?.y ?? style.layout.y,
    sizeScale: a?.sizeScale ?? style.sizeScale ?? 1,
    own: !!a,
  };
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** y and sizeScale as stored: y to 0.001, size to 0.01, in the server's ranges. */
export function normAdjust(a: CaptionAdjust): CaptionAdjust {
  const out: CaptionAdjust = {};
  if (a.y !== undefined && Number.isFinite(a.y)) out.y = +round(clamp(a.y, 0.05, 0.95), 0.001).toFixed(3);
  if (a.sizeScale !== undefined && Number.isFinite(a.sizeScale)) out.sizeScale = +round(clamp(a.sizeScale, 0.6, 1.6), 0.01).toFixed(2);
  return out;
}

function withoutPage(captions: Record<string, CaptionAdjust> | undefined, page: Page): Record<string, CaptionAdjust> {
  const out = { ...(captions ?? {}) };
  for (const w of page.words) if (w.id !== undefined) delete out[w.id];
  return out;
}

function withCaptions(o: StyleOverrides, captions: Record<string, CaptionAdjust>): StyleOverrides {
  const next = { ...o };
  if (Object.keys(captions).length) next.captions = captions;
  else delete next.captions;
  return next;
}

/** "Nur hier": this caption gets `adjust` (null: back to the style's). */
export function setCaptionAdjust(o: StyleOverrides, page: Page, adjust: CaptionAdjust | null): StyleOverrides {
  const id = captionIdOf(page);
  const captions = withoutPage(o.captions, page);
  const a = adjust ? normAdjust(adjust) : {};
  if (id !== null && (a.y !== undefined || a.sizeScale !== undefined)) captions[id] = a;
  return withCaptions(o, captions);
}

/** "Überall": the style's y / sizeScale become `adjust`; this caption follows the style. */
export function setStyleAdjust(o: StyleOverrides, page: Page, adjust: CaptionAdjust): StyleOverrides {
  const a = normAdjust(adjust);
  const next = withCaptions(o, withoutPage(o.captions, page));
  if (a.y !== undefined) next.y = a.y;
  if (a.sizeScale !== undefined) {
    if (Math.abs(a.sizeScale - 1) < 0.005) delete next.sizeScale;
    else next.sizeScale = a.sizeScale;
  }
  return next;
}

/** "Zurücksetzen": the caption's own values go; with `everywhere`, the style's y / size too. */
export function resetAdjust(o: StyleOverrides, page: Page, everywhere: boolean): StyleOverrides {
  const next = withCaptions(o, withoutPage(o.captions, page));
  if (everywhere) {
    delete next.y;
    delete next.sizeScale;
  }
  return next;
}

/** Ids of the captions with their own position / size. */
export function adjustedIds(o: StyleOverrides | Record<string, unknown> | null | undefined): string[] {
  const c = (o as StyleOverrides | null | undefined)?.captions;
  return c && typeof c === "object" ? Object.keys(c) : [];
}
