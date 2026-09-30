import type { MetadataRoute } from "next";
import { AUTH_ENABLED } from "@/lib/auth";
import { SITE_URL } from "@/lib/site";

// The public pages. /pricing exists only with accounts on (it is a 404
// in the anonymous beta).
export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string, priority: number, changeFrequency: "weekly" | "monthly" | "yearly") => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  });
  return [
    page("/", 1, "weekly"),
    ...(AUTH_ENABLED ? [page("/pricing", 0.8, "monthly")] : []),
    page("/terms", 0.3, "yearly"),
    page("/privacy", 0.3, "yearly"),
    page("/imprint", 0.2, "yearly"),
  ];
}
