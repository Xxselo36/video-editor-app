import type { Metadata } from "next";
import { NotFoundView } from "@/components/site/NotFoundView";

// Next adds <meta name="robots" content="noindex"> to every 404 itself.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return <NotFoundView />;
}
