/**
 * Browser notifications for long-running renders.
 *
 * Uses the native Notification API — works when the tab is in the
 * background or another tab is active, on both desktop and mobile
 * browsers that support it (Chrome, Safari 16+, Firefox).
 *
 * Only actually fires when the page is NOT visible (Page Visibility
 * API). If the user is looking at the tab, no notification — the
 * on-page 'Ready' screen already tells them.
 */

/** Ask for permission on first render start. Silent if already granted/denied. */
export async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    /* older browsers / user dismiss — non-fatal */
  }
}

/** Show a notification only if the page isn't visible right now. */
export function notifyIfHidden(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    // User is looking at the tab already — no notification needed
    return;
  }
  try {
    const n = new Notification(title, {
      body,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: "cleocuts-render",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some environments (in-app browsers) throw — non-fatal */
  }
}
