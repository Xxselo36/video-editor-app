"use client";
/**
 * Page views for the cookieless analytics (lib/analytics), mounted once in
 * the root layout and only when NEXT_PUBLIC_ANALYTICS_PROVIDER is set.
 * URLs are sent without query string or fragment.
 */
import { Analytics } from "@vercel/analytics/next";
import { scrubAnalyticsUrl } from "@/lib/analytics";

export function AnalyticsMount() {
  return <Analytics beforeSend={(event) => ({ ...event, url: scrubAnalyticsUrl(event.url) })} />;
}
