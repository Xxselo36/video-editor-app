/**
 * The local thumbnail of an upload (UX12, v2 Projects tiles): a frame of
 * the picked file drawn to a canvas. Its own chunk — loaded only on the
 * v2 opt-in (./uploadManager).
 */
/** A frame ~0.5 s into `file` as an object URL, or null (no decoder,
 *  timeout). */
export function grabFrame(file: File, timeoutMs = 6000): Promise<string | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const src = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(src);
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const d = isFinite(video.duration) ? video.duration : 1;
      video.currentTime = Math.min(0.5, d / 2);
    };
    video.onseeked = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return finish(null);
        const scale = Math.min(1, 360 / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => finish(b ? URL.createObjectURL(b) : null), "image/jpeg", 0.8);
      } catch {
        finish(null);
      }
    };
    video.src = src;
  });
}
