/**
 * Sentry setup — imported ONLY via dynamic import() from
 * components/ErrorReporting, so the SDK is a separate chunk that is
 * downloaded only when NEXT_PUBLIC_SENTRY_DSN is set. Named imports keep
 * replay/feedback/etc. tree-shaken out of that chunk.
 *
 * Errors only: no session replay, no sessions, no user data, traces off
 * (NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE to sample some; they never add
 * headers to our requests, so backend/R2 CORS is unaffected). Every
 * event and breadcrumb goes through lib/errorReporting's scrubbing.
 */
import { browserTracingIntegration, init } from "@sentry/browser";
import {
  SENTRY_DSN,
  scrubBreadcrumb,
  scrubDeep,
  scrubEvent,
  tracesSampleRate,
} from "@/lib/errorReporting";

export function initSentry(): void {
  const rate = tracesSampleRate();
  init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
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
    // Default integrations minus the per-page-load session ping.
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== "BrowserSession"),
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
