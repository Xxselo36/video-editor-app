"use client";
/**
 * Browser error reporting (Sentry), mounted once in the root layout and
 * only when NEXT_PUBLIC_SENTRY_DSN is set. The SDK (lib/sentryInit) is a
 * lazily imported chunk: without a DSN it is never downloaded.
 */
import { useEffect } from "react";
import { SENTRY_DSN } from "@/lib/errorReporting";

let started = false;

export function ErrorReporting() {
  useEffect(() => {
    if (!SENTRY_DSN || started) return;
    started = true;
    import("@/lib/sentryInit")
      .then((m) => m.initSentry())
      .catch(() => {
        /* blocked by an ad blocker / offline: the app works without it */
      });
  }, []);
  return null;
}
