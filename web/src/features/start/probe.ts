/**
 * What the browser can tell about a picked video without uploading it:
 * its frame (rotation applied, as the <video> element shows it) and
 * length. Null fields when it can't (a codec it doesn't decode — ProRes,
 * 10-bit HEVC); the server decides anyway (UX6: it picks SmartCam from
 * the real video).
 */
export type VideoProbe = { width: number | null; height: number | null; duration: number | null };

export function probeVideo(file: File, timeoutMs = 4000): Promise<VideoProbe> {
  return new Promise((resolve) => {
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve({ width: null, height: null, duration: null });
      return;
    }
    const v = document.createElement("video");
    let settled = false;
    const done = (p: VideoProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(p);
    };
    const timer = setTimeout(() => done({ width: null, height: null, duration: null }), timeoutMs);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      const d = v.duration;
      done({
        width: v.videoWidth || null,
        height: v.videoHeight || null,
        duration: isFinite(d) && d > 0 ? d : null,
      });
    };
    v.onerror = () => done({ width: null, height: null, duration: null });
    v.src = url;
  });
}

/** A frame taller than wide: 16:9 would only add bars. */
export function isPortrait(p: VideoProbe | null): boolean {
  return Boolean(p?.width && p?.height && p.height > p.width * 1.05);
}
