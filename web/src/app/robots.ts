import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// The editor (/app) and the test pages are no content for search
// engines; /app also says noindex itself (app/app/layout.tsx).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app", "/__test__"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
