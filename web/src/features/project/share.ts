/**
 * "Save / Share…" on phones (UX11, review C13): the Web Share API with
 * the video FILE, so iOS offers "Save Video" (Photos) and the TikTok /
 * Instagram apps directly.
 *
 * iOS Safari only opens the share sheet from a user gesture with no
 * `await` between the tap and navigator.share(): the file is fetched
 * ahead (prefetchFile, when the Done view mounts; the button says
 * "Preparing…") and the tap handler calls shareFile() synchronously.
 * Above SHARE_MAX_BYTES (memory), without file sharing, or when sharing
 * fails (anything but the user's own cancel) the video is downloaded.
 */

export const SHARE_MAX_BYTES = 250 * 1024 * 1024;

type ShareNav = Pick<Navigator, "share" | "canShare">;

/** Can this browser share a video file? (A tiny probe file.) */
export function canShareFiles(nav: Partial<ShareNav> | undefined = globalThis.navigator): boolean {
  try {
    if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.mp4", { type: "video/mp4" });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** share: prefetch and offer the share sheet; download: a plain link. */
export function shareMode(
  bytes: number | null | undefined,
  nav: Partial<ShareNav> | undefined = globalThis.navigator,
): "share" | "download" {
  if (!canShareFiles(nav)) return "download";
  if (bytes == null || bytes <= 0 || bytes > SHARE_MAX_BYTES) return "download";
  return "share";
}

/** The rendered file as a File, for shareFile. */
export async function prefetchFile(url: string, name: string, signal?: AbortSignal): Promise<File> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`prefetch failed (${r.status})`);
  const blob = await r.blob();
  return new File([blob], name, { type: blob.type || "video/mp4" });
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Open the share sheet for `file` — call it straight from the click
 * handler: navigator.share runs in the same task (no microtask before
 * it). The returned promise settles with what happened; "failed" means
 * the caller downloads instead.
 */
export function shareFile(
  file: File,
  nav: Partial<ShareNav> | undefined = globalThis.navigator,
): Promise<ShareOutcome> {
  let started: Promise<void>;
  try {
    if (!nav || typeof nav.share !== "function") return Promise.resolve("failed");
    started = nav.share({ files: [file], title: file.name });
  } catch {
    return Promise.resolve("failed");
  }
  return started.then(
    () => "shared" as const,
    (e: unknown) => (e instanceof Error && e.name === "AbortError" ? "cancelled" : "failed"),
  );
}

/** A click on a temporary <a download> (the fallback). */
export function downloadUrl(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
