/**
 * The preview's picture while the player swaps in a rebuilt preview
 * (useEditSession swapPreviewSrc, after a cut): a new src clears the
 * <video>'s picture until the new file has a frame — black for as long
 * as it loads (a second or more from storage). The frame on screen is
 * drawn into a canvas over the video (VideoLayer's, v2) instead, and goes
 * once the video has painted a frame of the new file, its load failed,
 * or HOLD_MAX_MS passed. A swap while one is still held keeps the frame
 * it holds (the video has none of its own yet). Nothing decoded to hold
 * (the first load): no canvas, as before.
 *
 * The canvas has the video's own size and object-fit, so the picture
 * doesn't move; a cross-origin video taints it, which only forbids
 * reading it back (it is shown, never read).
 */

/** A file that never shows a frame: the canvas goes after this long. */
export const HOLD_MAX_MS = 30_000;

// The release of the hold in place, per canvas.
const releases = new WeakMap<HTMLCanvasElement, () => void>();

/** Hold the frame `v` shows in `canvas` (data-on) until `v` shows the file it loads next. */
export function holdFrame(v: HTMLVideoElement, canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const c = canvas;
  if (c.dataset.on === undefined) {
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    } catch {
      return;
    }
    c.dataset.on = "";
  }
  // (re)bound to the file that loads now
  releases.get(c)?.();
  const frameEvents = ["loadeddata", "seeked", "playing"] as const;
  let raf = 0;
  const release = () => {
    for (const e of frameEvents) v.removeEventListener(e, onFrame);
    v.removeEventListener("error", hide);
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    if (releases.get(c) === release) releases.delete(c);
  };
  const hide = () => {
    release();
    delete c.dataset.on;
    // (its bitmap goes too: a phone keeps no full frame for nothing)
    c.width = 0;
    c.height = 0;
  };
  // A frame of the new file (not mid-seek): gone once the video painted it.
  const onFrame = () => {
    if (v.readyState < 2 || v.seeking) return;
    for (const e of frameEvents) v.removeEventListener(e, onFrame);
    raf = requestAnimationFrame(() => (raf = requestAnimationFrame(hide)));
  };
  for (const e of frameEvents) v.addEventListener(e, onFrame);
  v.addEventListener("error", hide);
  const timer = setTimeout(hide, HOLD_MAX_MS);
  releases.set(c, release);
}
