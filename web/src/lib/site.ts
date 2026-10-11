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
export const SITE_TITLE = "CleoCuts: voice-controlled video editor for short videos";

/** Meta / share description — only what the product does today. */
export const SITE_DESCRIPTION =
  "Film on your phone and say commands like “Cleo cut”. After upload, CleoCuts removes bad takes, pauses and filler words and returns a captioned 9:16 video.";

/** Short line for the share image and the manifest. */
export const SITE_TAGLINE = "You talk. Cleo edits.";
