/**
 * Browser error reporting switch + the scrubbing applied to everything
 * sent. No Sentry import here: server components (privacy page) read the
 * flag, and components/ErrorReporting loads the SDK lazily, only when a
 * DSN is set.
 *
 * Deploy: set NEXT_PUBLIC_SENTRY_DSN on Vercel and redeploy (NEXT_PUBLIC_*
 * is frozen at build; next.config.ts adds the ingest origin to the CSP).
 */

// Literal reference: only `process.env.NEXT_PUBLIC_X` gets inlined.
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
export const ERROR_REPORTING_ENABLED = Boolean(SENTRY_DSN);

/** Performance traces: off unless NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
 *  is a number in (0, 1]. */
export function tracesSampleRate(): number {
  const n = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE);
  return isFinite(n) && n > 0 ? Math.min(n, 1) : 0;
}

// Media links carry ?t= (per-user media token), R2 links presigned
// signatures, Clerk dev links __clerk_db_jwt — so no query string or
// fragment ever leaves the browser.
// Absolute URLs: keep scheme://host/path, drop ?query and #fragment.
const ABSOLUTE_URL = /\b((?:https?|wss?):\/\/[^\s"'<>`?#]*)[?#][^\s"'<>`]*/gi;
// Relative ones ("/jobs/x/watch?t=…") and bare query strings.
const QUERY_STRING = /\?[^\s"'<>`=?#&]+=[^\s"'<>`]*/g;
// Relative fragments carrying key=value ("/x#access_token=…", navigation
// breadcrumbs keep the hash). Not "#id[attr=…]" in click selectors.
const FRAGMENT_PARAMS = /#[\w.~/-]*[?&]?[\w.-]+=[^\s"'<>`]*/g;

export function scrubUrls(s: string): string {
  return s.replace(ABSOLUTE_URL, "$1").replace(QUERY_STRING, "").replace(FRAGMENT_PARAMS, "");
}

/** Strips query strings from every string in an event / breadcrumb
 *  (in place — Sentry hands us its own normalized copy). */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubUrls(value) as T;
  if (value === null || typeof value !== "object" || depth > 20) return value;
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) obj[k] = scrubDeep(obj[k], depth + 1);
  return value;
}

type Crumb = { category?: string; data?: Record<string, unknown> };

/** Breadcrumbs keep what happened, never payloads: no request/response
 *  bodies, no raw console arguments (they can hold anything, e.g. the
 *  projects list read from localStorage). */
export function scrubBreadcrumb<B extends Crumb>(b: B): B {
  if (b.data) {
    for (const k of ["body", "request_body", "response_body", "input", "response"]) delete b.data[k];
    if (b.category === "console") delete b.data.arguments;
  }
  return scrubDeep(b);
}

type EventLike = {
  user?: unknown;
  request?: { query_string?: unknown; data?: unknown; cookies?: unknown; headers?: Record<string, string> };
  breadcrumbs?: Crumb[];
  extra?: Record<string, unknown>;
};

export function scrubEvent<E extends EventLike>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.query_string;
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      const ua = event.request.headers["User-Agent"];
      event.request.headers = ua ? { "User-Agent": ua } : {};
    }
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  // Raw arguments of the wrapped callback that threw (browserApiErrors):
  // same rule as console arguments — payloads never leave the browser.
  if (event.extra) delete event.extra.arguments;
  return scrubDeep(event);
}
