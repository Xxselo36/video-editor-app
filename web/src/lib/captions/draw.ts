/**
 * Drawing one caption state (captions.md §4.4.7 draw order):
 *   1. line / page boxes
 *   2. the active-word box
 *   3. glow, shadow and stroke of every word
 *   4. the fills on top (so a stroke never covers a neighbour's fill)
 * The karaoke sweep of the active word is a separate layer (drawSweep)
 * that the caller clips to the spoken part.
 *
 * Every word is drawn with fillText/strokeText at the x the layout computed
 * from the metric tables; the canvas only rasterises.
 */
import { cssFont, faceChain } from "./fonts";
import type { CaptionStyle, Ctx2D, Page, PageLayout, WordBox } from "./types";

/** A quantized animation state: what a frame shows. */
export type DrawState = {
  /** Index (within the page) of the word being spoken. */
  active: number;
  /** Page-in progress, 0..1 (1 = settled). */
  pageP: number;
  /** Word-in progress of the active word, 0..1 (1 = settled). */
  wordP: number;
};

const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

export function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Vertical extent of text around the baseline, in px (above, below). */
export function textBand(style: CaptionStyle, layout: PageLayout, px = layout.px): { above: number; below: number } {
  const capH = (layout.capH / layout.px) * px;
  return style.font.case === "upper"
    ? { above: capH + 0.02 * px, below: 0.04 * px }
    : { above: capH + 0.07 * px, below: 0.24 * px };
}

export function pageScale(style: CaptionStyle, pageP: number): number {
  return style.animation.pageIn === "pop" && pageP < 1 ? 0.8 + 0.2 * easeOutBack(pageP) : 1;
}

export function pageAlpha(style: CaptionStyle, pageP: number): number {
  return style.animation.pageIn === "fade" && pageP < 1 ? easeOutCubic(pageP) : 1;
}

function wordScale(style: CaptionStyle, k: number, s: DrawState): number {
  if (k !== s.active) return 1;
  let scale = style.highlight.mode === "scale" ? (style.highlight.scale ?? 1.12) : 1;
  if (style.animation.wordIn === "pop" && s.wordP < 1) scale *= 1 + 0.25 * (1 - easeOutCubic(s.wordP));
  return scale;
}

function visible(style: CaptionStyle, k: number, s: DrawState): boolean {
  return style.reveal !== "word" || k <= s.active;
}

function wordAlpha(style: CaptionStyle, k: number, s: DrawState): number {
  if (style.reveal === "word" && k === s.active && style.animation.wordIn === "fade") return s.wordP;
  if (style.upcoming && k > s.active) return style.upcoming.opacity;
  return 1;
}

/** Applies the page transform (pop scale, skew) around the block centre. */
function pageTransform(ctx: Ctx2D, style: CaptionStyle, layout: PageLayout, s: DrawState) {
  const scale = pageScale(style, s.pageP);
  const skew = style.transform?.skewDeg ?? 0;
  if (scale === 1 && !skew) return;
  ctx.translate(layout.cx, layout.cy);
  if (scale !== 1) ctx.scale(scale, scale);
  if (skew) ctx.transform(1, 0, Math.tan((skew * Math.PI) / 180), 1, 0, 0);
  ctx.translate(-layout.cx, -layout.cy);
}

type Ctx = {
  ctx: Ctx2D;
  page: Page;
  layout: PageLayout;
  style: CaptionStyle;
  state: DrawState;
  lang?: string;
  fonts: Map<string, string>;
};

function withWord(c: Ctx, r: WordBox, fn: () => void) {
  const { ctx, style, state } = c;
  const s = wordScale(style, r.k, state);
  ctx.save();
  ctx.globalAlpha = pageAlpha(style, state.pageP) * wordAlpha(style, r.k, state);
  if (s !== 1) {
    const mx = r.x + r.width / 2;
    const my = r.baseline - r.px * 0.35;
    ctx.translate(mx, my);
    ctx.scale(s, s);
    ctx.translate(-mx, -my);
  }
  fn();
  ctx.restore();
}

function setFont(c: Ctx, r: WordBox) {
  const w = c.page.words[r.k];
  const key = `${w.script}|${r.px}`;
  let font = c.fonts.get(key);
  if (!font) {
    font = cssFont(faceChain(c.style.font.id, c.lang, w.script), r.px);
    c.fonts.set(key, font);
  }
  c.ctx.font = font;
}

function prepareText(ctx: Ctx2D) {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const k = ctx as unknown as { fontKerning?: string };
  if ("fontKerning" in ctx) k.fontKerning = "normal";
}

function fillFor(c: Ctx, r: WordBox): unknown {
  const { style, state, ctx } = c;
  const w = c.page.words[r.k];
  const H = style.highlight;
  let fill: unknown = style.fill.color;
  if (style.fill.gradient) {
    const g = ctx.createLinearGradient(0, r.baseline - r.px * 0.8, 0, r.baseline + r.px * 0.1);
    g.addColorStop(0, style.fill.gradient[0]);
    g.addColorStop(1, style.fill.gradient[1]);
    fill = g;
  }
  if (w.emphasis && style.emphasis) fill = style.emphasis.color;
  const active = r.k === state.active;
  if (active && (H.mode === "color" || H.mode === "scale") && H.color) fill = H.color;
  if (active && H.mode === "box" && H.textColor) fill = H.textColor;
  if (H.mode === "karaoke" && r.k < state.active && H.color) fill = H.color;
  return fill;
}

/** Draws a page in state `state` (everything but the karaoke sweep). */
export function drawPage(
  ctx: Ctx2D,
  page: Page,
  layout: PageLayout,
  style: CaptionStyle,
  state: DrawState,
  lang?: string,
): void {
  const c: Ctx = { ctx, page, layout, style, state, lang, fonts: new Map() };
  const words = layout.lines.flatMap((l) => l.words);
  const alpha = pageAlpha(style, state.pageP);
  ctx.save();
  prepareText(ctx);
  pageTransform(ctx, style, layout, state);

  // 1) boxes behind lines / the page
  const B = style.box;
  if (B) {
    const band = textBand(style, layout);
    const padX = B.padX * layout.px;
    const padY = B.padY * layout.px;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(B.color, B.opacity);
    const rows = layout.lines
      .map((l) => l.words.filter((r) => visible(style, r.k, state)))
      .filter((ws) => ws.length);
    if (B.mode === "line") {
      for (const ws of rows) {
        const left = ws[0].x;
        const right = ws[ws.length - 1].x + ws[ws.length - 1].width;
        const top = ws[0].baseline - band.above - padY;
        roundRect(ctx, left - padX, top, right - left + 2 * padX, band.above + band.below + 2 * padY, B.radius * layout.px);
        ctx.fill();
      }
    } else if (rows.length) {
      const left = Math.min(...rows.map((ws) => ws[0].x));
      const right = Math.max(...rows.map((ws) => ws[ws.length - 1].x + ws[ws.length - 1].width));
      const top = rows[0][0].baseline - band.above - padY;
      const bottom = rows[rows.length - 1][0].baseline + band.below + padY;
      roundRect(ctx, left - padX, top, right - left + 2 * padX, bottom - top, B.radius * layout.px);
      ctx.fill();
    }
    ctx.restore();
  }

  // 2) the active-word box
  const H = style.highlight;
  if (H.mode === "box" && state.active >= 0) {
    const r = words.find((x) => x.k === state.active);
    if (r && visible(style, r.k, state)) {
      withWord(c, r, () => {
        const band = textBand(style, layout, r.px);
        const padX = (H.padX ?? 0.18) * r.px;
        const padY = (H.padY ?? 0.08) * r.px;
        ctx.fillStyle = H.boxColor ?? "#7C3AED";
        roundRect(ctx, r.x - padX, r.baseline - band.above - padY, r.width + 2 * padX, band.above + band.below + 2 * padY, (H.radius ?? 0.18) * r.px);
        ctx.fill();
      });
    }
  }

  // 3) glow / shadow / stroke for every word
  const S = style.shadow;
  const K = style.stroke;
  const G = style.glow;
  for (const r of words) {
    if (!visible(style, r.k, state)) continue;
    withWord(c, r, () => {
      setFont(c, r);
      const text = r.text;
      if (G) {
        ctx.save();
        ctx.shadowColor = G.color;
        ctx.shadowBlur = G.blur * r.px;
        ctx.fillStyle = G.color;
        for (let i = 0; i < G.passes; i++) ctx.fillText(text, r.x, r.baseline);
        ctx.restore();
      }
      if (S) {
        ctx.save();
        ctx.shadowColor = rgba(S.color, S.opacity);
        ctx.shadowBlur = S.blur * r.px;
        ctx.shadowOffsetX = S.dx * r.px;
        ctx.shadowOffsetY = S.dy * r.px;
        if (K && K.width > 0) {
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.lineWidth = 2 * K.width * r.px;
          ctx.strokeStyle = K.color;
          ctx.strokeText(text, r.x, r.baseline);
        } else {
          ctx.fillStyle = rgba(S.color, S.opacity);
          ctx.fillText(text, r.x, r.baseline);
        }
        ctx.restore();
      }
      if (K && K.width > 0) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.lineWidth = 2 * K.width * r.px;
        ctx.strokeStyle = K.color;
        ctx.strokeText(text, r.x, r.baseline);
      }
    });
  }

  // 4) fills on top
  for (const r of words) {
    if (!visible(style, r.k, state)) continue;
    withWord(c, r, () => {
      setFont(c, r);
      ctx.fillStyle = fillFor(c, r);
      ctx.fillText(r.text, r.x, r.baseline);
    });
  }
  ctx.restore();
}

/** The karaoke layer: the active word's fill in the highlight colour. */
export function drawSweep(
  ctx: Ctx2D,
  page: Page,
  layout: PageLayout,
  style: CaptionStyle,
  state: DrawState,
  lang?: string,
): void {
  const H = style.highlight;
  if (H.mode !== "karaoke" || !H.color) return;
  const r = layout.lines.flatMap((l) => l.words).find((x) => x.k === state.active);
  if (!r) return;
  const c: Ctx = { ctx, page, layout, style, state, lang, fonts: new Map() };
  ctx.save();
  prepareText(ctx);
  pageTransform(ctx, style, layout, state);
  withWord(c, r, () => {
    setFont(c, r);
    ctx.fillStyle = H.color;
    ctx.fillText(r.text, r.x, r.baseline);
  });
  ctx.restore();
}

/** Canvas-space rectangle of the spoken part of the active word (karaoke). */
export function sweepRect(layout: PageLayout, active: number, progress: number) {
  const r = layout.lines.flatMap((l) => l.words).find((x) => x.k === active);
  if (!r) return null;
  const p = Math.min(1, Math.max(0, progress));
  return { x: r.x - r.px, y: r.baseline - r.px * 1.2, w: r.px + r.width * p, h: r.px * 1.6 };
}

/**
 * Conservative bounds of everything a page can draw in any state
 * (effects, scale, skew), in canvas px — the bitmap size for cache.ts.
 */
export function pageBounds(layout: PageLayout, style: CaptionStyle) {
  const px = layout.px;
  const band = textBand(style, layout);
  let m = 0.3 * px;
  if (style.stroke) m += style.stroke.width * px;
  if (style.shadow) m += (Math.max(Math.abs(style.shadow.dx), Math.abs(style.shadow.dy)) + 2 * style.shadow.blur) * px;
  if (style.glow) m += 2.5 * style.glow.blur * px;
  if (style.box) m += Math.max(style.box.padX, style.box.padY) * px;
  if (style.highlight.mode === "box") m += Math.max(style.highlight.padX ?? 0.18, style.highlight.padY ?? 0.08) * px;
  const left = layout.box.left;
  const right = layout.box.right;
  const top = layout.lines[0].baseline - band.above;
  const bottom = layout.lines[layout.lines.length - 1].baseline + band.below;
  // active-word scale (≤ 1.14 × 1.25) and page pop overshoot (≈ 1.03)
  const widest = Math.max(...layout.lines.flatMap((l) => l.words.map((w) => w.width)));
  const grow = 0.2 * widest + 0.2 * px;
  const skew = Math.abs(Math.tan(((style.transform?.skewDeg ?? 0) * Math.PI) / 180)) * (bottom - top);
  const popX = 0.04 * (right - left);
  const x0 = Math.floor(Math.max(0, left - m - grow - skew - popX));
  const x1 = Math.ceil(Math.min(layout.W, right + m + grow + skew + popX));
  const y0 = Math.floor(Math.max(0, top - m - 0.2 * px));
  const y1 = Math.ceil(Math.min(layout.H, bottom + m + 0.2 * px));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
