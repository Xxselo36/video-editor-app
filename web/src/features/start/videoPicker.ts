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
 *
 * C lists only MOV / MP4 / HEVC: a video in another format (3GP, AVI,
 * WebM, MKV from the Files app) is picked with B ("Other video formats"
 * under the start screen's dropzone). An original over the upload cap
 * isn't uploaded: B's converted copy is a fraction of it
 * (originalTooBig). An upload that came from B resumes with B
 * (resumeWithAny): C hands over the original, other bytes.
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

/** iOS, a pick from the original-formats input (C): over the upload cap
 *  it isn't uploaded (the server would refuse it); "Pick anyway" sends
 *  the converted copy instead, a fraction of the size (the owner's 4K
 *  60 fps HDR video: about 0.8 GB a minute as the original, 0.2 GB
 *  converted). Any other pick goes to the upload, which checks the cap
 *  itself (file_too_large). */
export function originalTooBig(size: number, maxBytes: number, { ios, original }: { ios: boolean; original: boolean }): boolean {
  return ios && original && maxBytes > 0 && size > maxBytes;
}

/** A size in GB for the "over the limit" message: one decimal, rounded
 *  up (10.04 GB shows as 10.1, never as the 10 GB limit itself). */
export function overLimitGb(bytes: number): number {
  return Math.ceil(bytes / 1e8) / 10;
}

/** Does "Continue upload" of an upload that came from `source` open the
 *  unfiltered input (B) again? On iOS, for one picked with it: the
 *  original-formats picker would hand over the original, which never
 *  matches the converted copy that went up. */
export function resumeWithAny(ios: boolean, source: "any" | undefined | null): boolean {
  return ios && source === "any";
}
