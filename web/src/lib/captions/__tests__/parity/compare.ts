/**
 * Pixel comparison for the caption parity suite: composite a caption
 * layer over a background, SSIM on luma in 8×8 windows over the caption's
 * bounding box, ink bounding boxes, and a diff heat map.
 */

export type Rgba = { data: Uint8Array | Uint8ClampedArray; width: number; height: number; premultiplied: boolean };

/** A fixed, non-flat background (gradient + a soft shape), like a video frame. */
export function background(width: number, height: number, top = 0): Float64Array {
  const out = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = (y + top) / (height + top);
      const i = (y * width + x) * 3;
      out[i] = 58 - 30 * v + 20 * u;
      out[i + 1] = 66 - 30 * v + 10 * u;
      out[i + 2] = 82 - 40 * v;
    }
  }
  return out;
}

/** Caption layer over `bg` → luma (BT.709), 0..255. */
export function compositeLuma(layer: Rgba, bg: Float64Array): Float64Array {
  const { data, width, height, premultiplied } = layer;
  const out = new Float64Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const a = data[p * 4 + 3] / 255;
    const k = premultiplied ? 1 : a;
    const r = data[p * 4] * k + bg[p * 3] * (1 - a);
    const g = data[p * 4 + 1] * k + bg[p * 3 + 1] * (1 - a);
    const b = data[p * 4 + 2] * k + bg[p * 3 + 2] * (1 - a);
    out[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return out;
}

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** Bounding box of pixels with alpha > `min`, or null. */
export function inkBox(layer: Rgba, min = 16): Box | null {
  const { data, width, height } = layer;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > min) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function union(a: Box | null, b: Box | null, pad: number, width: number, height: number): Box | null {
  if (!a && !b) return null;
  const u = [a, b].filter(Boolean) as Box[];
  return {
    x0: Math.max(0, Math.min(...u.map((q) => q.x0)) - pad),
    y0: Math.max(0, Math.min(...u.map((q) => q.y0)) - pad),
    x1: Math.min(width - 1, Math.max(...u.map((q) => q.x1)) + pad),
    y1: Math.min(height - 1, Math.max(...u.map((q) => q.y1)) + pad),
  };
}

/** Mean SSIM of two luma images over `box`, 8×8 windows with stride 4. */
export function ssim(a: Float64Array, b: Float64Array, width: number, box: Box, win = 8): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let y = box.y0; y + win - 1 <= box.y1; y += 4) {
    for (let x = box.x0; x + win - 1 <= box.x1; x += 4) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const p = (y + j) * width + x + i;
          ma += a[p];
          mb += b[p];
        }
      }
      const N = win * win;
      ma /= N;
      mb /= N;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const p = (y + j) * width + x + i;
          const da = a[p] - ma;
          const db = b[p] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= N - 1;
      vb /= N - 1;
      cov /= N - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? sum / n : 1;
}

/** RGBA heat map of |a − b| (red, ×4) over a grey copy of `a`. */
export function heatmap(a: Float64Array, b: Float64Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const d = Math.min(255, Math.abs(a[p] - b[p]) * 4);
    const g = a[p] * 0.5;
    out[p * 4] = Math.max(g, d);
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = g;
    out[p * 4 + 3] = 255;
  }
  return out;
}
