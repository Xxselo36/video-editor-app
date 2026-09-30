/**
 * Product analytics: `track(event, props)`.
 *
 * Off by default — a no-op unless NEXT_PUBLIC_ANALYTICS_PROVIDER is set
 * at build time. Providers:
 *   "vercel"  Vercel Web Analytics (@vercel/analytics): cookieless, no
 *             identifiers stored in the browser, served from our own
 *             origin (/_vercel/insights/*). Custom events need a Vercel
 *             Pro plan; the plan also caps how many properties an event
 *             keeps — put the important one first.
 * The page views come from components/AnalyticsMount (root layout).
 *
 * Privacy rules for callers: no names, e-mail addresses, file names,
 * transcript text or job ids in props — counts, codes and flags only.
 * Page URLs lose their query string and fragment (?job=, ?t= tokens)
 * before anything is sent (scrubAnalyticsUrl).
 *
 * The events (PLAN_TECH §1.8). The backend records its own render
 * events (GET /admin/metrics).
 */

export type AnalyticsEvent =
  // Funnel
  | "landing_view"
  | "cta_click"
  | "sign_up"
  | "file_chosen"
  | "upload_done"
  | "editor_opened"
  | "export_started"
  | "export_done"
  | "checkout_started"
  | "checkout_done"
  // Editing
  | "style_changed"
  | "words_edited"
  | "words_cut"
  | "cuts_restored"
  | "bulk_restore"
  | "caption_moved"
  | "undo"
  // After the export
  | "reedit_started"
  | "post_export_survey"
  | "share_used"
  | "srt_downloaded"
  // Health
  | "caption_layer_error"
  | "font_load_failed"
  | "share_failed";

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

// Literal reference: only `process.env.NEXT_PUBLIC_X` gets inlined.
const PROVIDER = (process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER ?? "").trim().toLowerCase();

export const ANALYTICS_PROVIDER: "vercel" | null = PROVIDER === "vercel" ? "vercel" : null;
export const ANALYTICS_ENABLED = ANALYTICS_PROVIDER !== null;

/** A page URL without its query string and fragment. */
export function scrubAnalyticsUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

const MAX_VALUE = 255;

/** Only flat primitives, strings capped (the providers' limits). */
function cleanProps(props: AnalyticsProps | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!props) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = typeof v === "string" ? v.slice(0, MAX_VALUE) : v;
  }
  return out;
}

/**
 * Record a product event. Never throws, never blocks: the provider's
 * code is loaded on first use, and a blocked or failing provider is
 * ignored.
 */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  if (!ANALYTICS_ENABLED || typeof window === "undefined") return;
  const clean = cleanProps(props);
  if (ANALYTICS_PROVIDER === "vercel") {
    import("@vercel/analytics")
      .then((m) => m.track(event, clean))
      .catch(() => {
        /* blocked by a content blocker / offline: analytics is optional */
      });
  }
}
