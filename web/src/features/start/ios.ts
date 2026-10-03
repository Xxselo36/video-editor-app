/**
 * iPhone/iPad detection for the start screen's hints: iOS prepares a
 * long video (an iCloud download, a conversion) inside the Photos picker
 * before the page gets the file. iPadOS 13+ reports a Mac user agent;
 * its touch points give it away.
 */
export type NavigatorLike = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">;

export function isIOS(nav: NavigatorLike | undefined): boolean {
  if (!nav) return false;
  if (/iPad|iPhone|iPod/.test(nav.userAgent ?? "")) return true;
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}
