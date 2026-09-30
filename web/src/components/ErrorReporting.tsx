"use client";
/**
 * Browser error reporting (Sentry), mounted once in the root layout and
 * only when NEXT_PUBLIC_SENTRY_DSN is set. The SDK (lib/sentryInit) is a
 * lazily imported chunk: without a DSN it is never downloaded.
 * Opening a page with #sentry-test sends one test error (the check that
 * reports arrive after the DSN was set).
 */
import { useEffect } from "react";
import { SENTRY_DSN } from "@/lib/errorReporting";

let started = false;

export function ErrorReporting() {
  useEffect(() => {
    if (!SENTRY_DSN || started) return;
    started = true;
    import("@/lib/sentryInit")
      .then((m) => {
        m.initSentry();
        if (window.location.hash === "#sentry-test") m.sendTestError();
      })
      .catch(() => {
        /* blocked by an ad blocker / offline: the app works without it */
      });
  }, []);
  return null;
}

/**
 * Report an error an error boundary caught (app/error.tsx,
 * app/app/error.tsx): React doesn't hand those to the global handlers
 * Sentry listens on. A no-op without a DSN.
 */
export function reportError(error: unknown): void {
  if (!SENTRY_DSN) return;
  import("@/lib/sentryInit")
    .then((m) => m.report(error))
    .catch(() => {
      /* blocked / offline */
    });
}
