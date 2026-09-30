/**
 * Sentry setup — imported ONLY via dynamic import() from
 * components/ErrorReporting, so the SDK is a separate chunk that is
 * downloaded only when NEXT_PUBLIC_SENTRY_DSN is set. Named imports keep
 * replay/feedback/etc. tree-shaken out of that chunk.
 *
 * Errors, plus release health: one anonymous session per page load
 * (started / crashed or not, the release, the browser — no user, no
 * URL), so Sentry can show the crash-free rate of each release (the
 * launch gate). No session replay, no user data, traces off
 * (NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE to sample some; they never add
 * headers to our requests, so backend/R2 CORS is unaffected). Every
 * event and breadcrumb goes through lib/errorReporting's scrubbing.
 * Events are tagged with the deployed git SHA (NEXT_PUBLIC_RELEASE,
 * next.config.ts) — the same release as the backend's.
 */
import { browserTracingIntegration, captureException, init } from "@sentry/browser";
import {
  SENTRY_DSN,
  scrubBreadcrumb,
  scrubDeep,
  scrubEvent,
  tracesSampleRate,
} from "@/lib/errorReporting";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  initialized = true;
  const rate = tracesSampleRate();
  init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_RELEASE || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
    // sendDefaultPii: false — SDK v11 spells it out per category.
    dataCollection: {
      userInfo: false, // no IP / user inference
      cookies: false,
      httpHeaders: { request: { allow: ["User-Agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: rate,
    // Default integrations, including BrowserSession (release health:
    // one session per page load).
    integrations: (defaults) => [
      ...defaults,
      ...(rate > 0 ? [browserTracingIntegration({ linkPreviousTrace: "off" })] : []),
    ],
    // Never add sentry-trace/baggage headers (R2 presigned PUTs and the
    // backend's CORS would reject them).
    tracePropagationTargets: [],
    sendClientReports: false,
    // The default ("always") rewrites the app's own fetch errors to
    // "Failed to fetch (host)": the editor shows err.message and matches
    // it (friendlyError), so a hostname could change what users see.
    // report-only adds the host to the Sentry event only.
    enhanceFetchErrorMessages: "report-only",
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
    beforeSend: (event) => scrubEvent(event),
    // Traces (if sampled) are streamed as spans in v11.
    beforeSendSpan: (span) => scrubDeep(span),
  });
}

/** The check that browser reports arrive: open any page with
 *  #sentry-test (components/ErrorReporting). */
export function sendTestError(): void {
  captureException(new Error("CleoCuts test error (#sentry-test)"));
}

/** A handled error (error boundaries): reported like an uncaught one.
 *  Initializes first — a boundary can catch before ErrorReporting's
 *  effect ran (an error in the first render). */
export function report(error: unknown): void {
  initSentry();
  captureException(error);
}
