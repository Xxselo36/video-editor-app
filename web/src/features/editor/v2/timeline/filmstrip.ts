/**
 * Timeline filmstrip (UX7b): which sprite tile goes where in a clip.
 *
 * The sprite (GET /jobs/{id}/filmstrip, backend pipeline.make_filmstrip)
 * is `n` tiles of tileW × tileH px side by side; tile i shows the frame at
 * i · interval s of the source. A clip draws tiles scaled to its height,
 * in slots of that width from its left edge; each slot shows the frame of
 * the source time under its centre (the clip's own source range), and
 * only the slots in the visible window are drawn.
 */

export type FilmstripMeta = { n: number; interval: number; tileW: number; tileH: number };

/** One tile of a clip: x (px from the clip's left edge), its width, and
 *  the sprite tile it shows. */
export type FilmTile = { x: number; w: number; idx: number };

/** Most slots one clip draws (a very wide window at a tiny height). */
export const MAX_TILES_PER_CLIP = 400;

export function validMeta(m: unknown): m is FilmstripMeta {
  if (!m || typeof m !== "object") return false;
  const { n, interval, tileW, tileH } = m as Record<string, unknown>;
  return [n, interval, tileW, tileH].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/** The sprite tile showing source time `t` (clamped to the sprite). */
export function tileIndex(t: number, meta: FilmstripMeta): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  // a hair of slack: t = 3 · 1.0 computed as 2.9999999 is still tile 3
  const i = Math.floor(t / meta.interval + 1e-6);
  return Math.max(0, Math.min(meta.n - 1, i));
}

/** Display width of one tile at clip height `h` px. */
export function tileWidth(meta: FilmstripMeta, h: number): number {
  return (meta.tileW * h) / meta.tileH;
}

/**
 * The tiles of one clip.
 *   start, end   its source range (s)
 *   left, width  where it is in the strip (px)
 *   h            its height (px): the tiles' height
 *   lo, hi       the visible window in strip px (the tiles outside are
 *                skipped; pass a margin for smooth scrolling)
 */
export function clipTiles(
  meta: FilmstripMeta,
  c: { start: number; end: number; left: number; width: number; h: number; lo: number; hi: number },
): FilmTile[] {
  const dw = tileWidth(meta, c.h);
  if (!(dw > 0) || !(c.width > 0) || !(c.end > c.start)) return [];
  if (c.left + c.width <= c.lo || c.left >= c.hi) return [];
  const count = Math.ceil(c.width / dw);
  const first = Math.max(0, Math.floor((c.lo - c.left) / dw));
  const last = Math.min(count - 1, Math.ceil((c.hi - c.left) / dw) - 1, first + MAX_TILES_PER_CLIP - 1);
  const out: FilmTile[] = [];
  const span = c.end - c.start;
  for (let j = first; j <= last; j++) {
    const x = j * dw;
    // the centre of the slot's visible part (the last one is cropped)
    const centre = (x + Math.min(c.width, x + dw)) / 2;
    const t = c.start + (centre / c.width) * span;
    out.push({ x, w: dw, idx: tileIndex(t, meta) });
  }
  return out;
}

/** The visible window (strip px) the tiles are drawn for: the view plus
 *  one view width either side, moved in `step` px jumps — the clips'
 *  tiles change every `step` px of scrolling, not on every scroll event. */
export function filmWindow(scrollX: number, viewW: number, step = 256): { lo: number; hi: number } {
  const base = Math.floor(scrollX / step) * step;
  return { lo: base - viewW, hi: base + step + 2 * viewW };
}
