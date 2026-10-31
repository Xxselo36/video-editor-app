/**
 * A still of a caption style, drawn by the real caption engine (D8): the
 * editor's Style tiles and the start screen's style tiles and preview.
 * The sample words are spoken over the video's frame (a dark backdrop
 * until there is one) and caught as the last one is spoken, its
 * animation settled; a tile shows the caption band, the start screen's
 * preview the whole frame.
 *
 * The engine comes in as an argument and is only typed here, so the
 * start screen can load it lazily (features/landing/captions/engine.ts)
 * while the editor passes its barrel imports.
 */
import type { CaptionRenderer } from "@/lib/captions/cache";
import type { ensureFonts } from "@/lib/captions/fonts";
import type { resolveStyle } from "@/lib/captions/presets";
import type { CaptionStyle, CaptionWord, Ctx2D, PageLayout, StyleOverrides } from "@/lib/captions/types";

export type SnapshotEngine = {
  CaptionRenderer: typeof CaptionRenderer;
  resolveStyle: typeof resolveStyle;
  ensureFonts: typeof ensureFonts;
};

/** A caption's text block in the frame, px. */
export type Box = PageLayout["box"];
/** The part of the frame a canvas shows, px. */
export type Crop = { sx: number; sy: number; sw: number; sh: number };
/** Where a picture lands in the frame, px. */
export type Rect = { x: number; y: number; w: number; h: number };

/** The short side of the frame a caption is laid out on: sharp in a tile, cheap to draw. */
const SHORT_SIDE = 540;
/** Under the caption where the video's frame isn't (yet). */
const BACKDROP = "#1B1B21";
const NOT_DRAWN = { ok: false, withFrame: false } as const;

/** The sample: the first two words (one for One Word), as spoken words; "Aa" without any. */
export function sampleWords(texts: readonly string[], presetId: string): CaptionWord[] {
  const picked = texts.slice(0, presetId === "punch" ? 1 : 2);
  const shown = picked.length ? picked : ["Aa"];
  return shown.map((text, i) => ({ id: `s${i}`, text, start: i * 0.5, end: i * 0.5 + 0.45 }));
}

/**
 * The caption band of a W×H frame for a cw×ch canvas: about half the
 * frame wide (the mock's zoom), never cutting the caption, centred on it
 * and kept inside the frame.
 */
export function bandCrop(box: Box, W: number, H: number, cw: number, ch: number): Crop {
  const sw = Math.min(W, Math.max(W * 0.55, (box.right - box.left) * 1.12));
  const sh = (sw * ch) / cw;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const sx = Math.min(Math.max(0, cx - sw / 2), W - sw);
  const sy = Math.min(Math.max(0, cy - sh / 2), Math.max(0, H - sh));
  return { sx, sy, sw, sh };
}

/**
 * A fw×fh picture covering a W×H frame, centred: a wide video in an
 * upright frame shows its middle. A picture of the frame's own shape
 * fills it exactly, also when the frame's size was rounded from it.
 */
export function coverRect(fw: number, fh: number, W: number, H: number): Rect {
  const s = Math.max(W / fw, H / fh);
  const w = fw * s;
  const h = fh * s;
  if (Math.abs(w - W) < 1 && Math.abs(h - H) < 1) return { x: 0, y: 0, w: W, h: H };
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** The caption's box for the band: a "scale" highlight draws the spoken
 *  word bigger around its own centre, past the laid-out line. */
function inkBox(layout: PageLayout, style: CaptionStyle): Box {
  const { box } = layout;
  if (style.highlight.mode !== "scale") return box;
  const widest = Math.max(...layout.lines.flatMap((l) => l.words.map((w) => w.width)));
  const grow = (((style.highlight.scale ?? 1.12) - 1) * widest) / 2;
  return { ...box, left: box.left - grow, right: box.right + grow };
}

/** A video draws once it has a frame, an image once it has loaded. */
function hasPicture(f: CanvasImageSource): boolean {
  if ("readyState" in f) return f.readyState >= 2 && f.videoWidth > 0;
  if ("naturalWidth" in f) return f.complete && f.naturalWidth > 0;
  return true;
}

/**
 * Draws `words` (sampleWords) in the style onto `canvas` at its CSS size,
 * device pixels up to 2×. `frame` is the picture under the caption and
 * frameW×frameH its own size (a video's videoWidth×videoHeight; 9:16 when
 * unknown). The caption is laid out on a frame with short side 540, which
 * the picture covers: for crop "band" `shape` (the format the video gets,
 * as width×height in any unit) or else the picture's own shape; for
 * "frame" the canvas's own (its box has the output format).
 * `onFontsLoading` runs just before the style's fonts are awaited; once
 * `signal` aborts nothing is drawn. Resolves `ok` once drawn, and whether
 * the picture is in it.
 */
export async function drawCaptionSnapshot(
  canvas: HTMLCanvasElement,
  input: {
    engine: SnapshotEngine;
    presetId: string;
    overrides?: Record<string, unknown>;
    frame: CanvasImageSource | null;
    frameW: number;
    frameH: number;
    shape?: { width: number; height: number };
    words: CaptionWord[];
    lang?: string;
    crop: "band" | "frame";
  },
  opts: { onFontsLoading?: () => void; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; withFrame: boolean }> {
  const { engine, presetId, frame, words, lang, crop } = input;
  const fw = input.frameW || 9;
  const fh = input.frameH || 16;
  // The canvas's layout box, unlike its rounded client size, keeps the
  // output format exact (a 4:5 stays 4:5 for presets.ts defaultY).
  const out = crop === "frame" ? canvas.getBoundingClientRect() : input.shape;
  const [ow, oh] = out?.width && out.height ? [out.width, out.height] : [fw, fh];
  const k = SHORT_SIDE / Math.min(ow, oh);
  const W = Math.round(ow * k);
  const H = Math.round(oh * k);
  const style = engine.resolveStyle(presetId, input.overrides as StyleOverrides | undefined, { W, H });
  if (!style) return NOT_DRAWN;
  opts.onFontsLoading?.();
  const fonts = await engine.ensureFonts(style, { lang, text: words.map((w) => w.text) }).catch(() => null);
  if (opts.signal?.aborted || !fonts?.ok) return NOT_DRAWN;
  const shot = document.createElement("canvas");
  shot.width = W;
  shot.height = H;
  const sctx = shot.getContext("2d");
  if (!sctx) return NOT_DRAWN;
  sctx.fillStyle = BACKDROP;
  sctx.fillRect(0, 0, W, H);
  let withFrame = false;
  if (frame && hasPicture(frame)) {
    try {
      const d = coverRect(fw, fh, W, H);
      sctx.drawImage(frame, d.x, d.y, d.w, d.h);
      withFrame = true;
    } catch {
      /* not decodable yet */
    }
  }
  const r = new engine.CaptionRenderer({ words, style, W, H, lang });
  // the last sample word is being spoken, its animation settled
  const at = words[words.length - 1].start + 0.3;
  const st = r.draw(sctx as unknown as Ctx2D, at);
  const cw = canvas.clientWidth || 100;
  const ch = canvas.clientHeight || 72;
  const src =
    crop === "frame"
      ? { sx: 0, sy: 0, sw: W, sh: H }
      : bandCrop(st ? inkBox(r.layout(st.page), style) : { left: W * 0.3, right: W * 0.7, top: H * 0.6, bottom: H * 0.7 }, W, H, cw, ch);
  r.dispose();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.getContext("2d")?.drawImage(shot, src.sx, src.sy, src.sw, src.sh, 0, 0, canvas.width, canvas.height);
  shot.width = 0;
  return { ok: true, withFrame };
}
