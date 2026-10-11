/**
 * The file inputs that pick a video for upload (the start screen, a
 * stopped Projects tile's "Continue upload", the v1 picker): which files
 * they offer, and what a pick from the unfiltered fallback may be.
 *
 * iPhone / iPad (2026-10, the owner's picker tests on an iPhone 13):
 *   - accept="video/*" (A) hands over a conversion that differs on every
 *     pick (the upload can never continue from a re-pick) and took 4 to
 *     22 minutes for a 10-minute 4K HDR video;
 *   - the list of original formats (C, IOS_VIDEO_ACCEPT) shows only
 *     videos and gave the same video bytes on every pick, in 43 s for a
 *     short clip, but iOS gives up on a very large one (8 GB);
 *   - no accept at all (B) converts that one too (about 7 minutes), with
 *     the same bytes on every pick, but the picker also lists photos.
 * So every upload input uses C on iOS, and when iOS gives up, "Pick
 * anyway" opens an input without accept (B, ./PickMissedHint). Every
 * other platform keeps "video/*". All browsers on iOS share Safari's
 * picker: this goes by the platform (./ios), not the browser.
 */
import { useSyncExternalStore } from "react";
import { isIOS, type NavigatorLike } from "./ios";

export const VIDEO_ACCEPT = "video/*";
/** The original formats an iPhone records (MOV / MP4 / HEVC). */
export const IOS_VIDEO_ACCEPT = "video/quicktime,video/mp4,video/hevc,.mov,.mp4,.m4v,.hevc";

/** The accept list of an upload input on this device. */
export function videoAccept(nav: NavigatorLike | undefined): string {
  return isIOS(nav) ? IOS_VIDEO_ACCEPT : VIDEO_ACCEPT;
}

// Read after hydration (the server render says "not iOS"), never changes.
const subscribeNever = () => () => {};
const nav = () => (typeof navigator === "undefined" ? undefined : navigator);

/** An iPhone / iPad (false in the server render). */
export function useIsIOS(): boolean {
  return useSyncExternalStore(subscribeNever, () => isIOS(nav()), () => false);
}

/** videoAccept for this device ("video/*" in the server render). */
export function useVideoAccept(): string {
  return useSyncExternalStore(subscribeNever, () => videoAccept(nav()), () => VIDEO_ACCEPT);
}

const VIDEO_EXT = /\.(mov|qt|mp4|m4v|hevc|h265|265|3gp|3g2|webm|mkv|avi|mts|m2ts|mpg|mpeg)$/i;

/** What a pick from the unfiltered input (B) is: a video (as the upload
 *  takes it), an audio file (uploadJob refuses it as no_video), or
 *  anything else (a photo: B's picker lists those too). A file the
 *  browser gives no type goes by its extension. */
export function pickedKind(file: Pick<File, "type" | "name">): "video" | "audio" | "other" {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if ((!type || type === "application/octet-stream") && VIDEO_EXT.test(file.name)) return "video";
  return "other";
}
