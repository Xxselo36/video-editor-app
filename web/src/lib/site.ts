/**
 * Site identity for metadata, robots.txt, the sitemap, the manifest and
 * the share images. English: the server renders one language (localized
 * URLs with hreflang come with the new landing, UX15).
 */

/** Canonical origin, no trailing slash. NEXT_PUBLIC_SITE_URL for staging /
 *  previews (frozen at build like every NEXT_PUBLIC_* value). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://cleocuts.com").replace(/\/+$/, "");

export const SITE_NAME = "CleoCuts";

/** <title> of the landing and the default for pages without their own. */
export const SITE_TITLE = "CleoCuts – Cut pauses & add captions to TikToks with AI";

/** Meta / share description — only what the product does today. */
export const SITE_DESCRIPTION =
  "Upload a talking video. CleoCuts removes pauses and filler words, adds animated captions and reframes to 9:16. Fine-tune in your browser, post in minutes.";

/** Short line for the share image and the manifest. */
export const SITE_TAGLINE = "Cut pauses. Add captions. Post in minutes.";
