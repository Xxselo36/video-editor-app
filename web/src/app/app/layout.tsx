import type { Metadata } from "next";
import { AUTH_ENABLED } from "@/lib/auth";
import { AppGate } from "@/components/auth/AppGate";
import { SiteFooter } from "@/components/site/SiteFooter";

// The editor, library and account are private tools: never in search
// results (robots.ts also keeps crawlers out of /app).
export const metadata: Metadata = {
  // A plain string would drop the root "%s · CleoCuts" template for the
  // library and account pages below; restate it.
  title: { default: "Editor", template: "%s · CleoCuts" },
  robots: { index: false, follow: false },
};

// /app, /app/library, /app/account. With accounts off the gate adds
// nothing: the editor stays open to everyone, exactly as in the beta.
// The legal footer sits below every app screen (and below the sign-in
// gate), so imprint and privacy are always one click away.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {AUTH_ENABLED ? <AppGate>{children}</AppGate> : children}
      <SiteFooter />
    </>
  );
}
