import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ERROR_REPORTING_ENABLED } from "@/lib/errorReporting";
import { ErrorReporting } from "@/components/ErrorReporting";
import { ANALYTICS_ENABLED } from "@/lib/analytics";
import { AnalyticsMount } from "@/components/AnalyticsMount";
import { LANG_INIT_SCRIPT } from "@/i18n/langs";

// No web fonts: the UI uses the system font stack (globals.css), the
// Geist fonts were preloaded on every page without being used.

export const metadata: Metadata = {
  title: "CleoCuts — World's first voice-controlled AI video editor",
  description:
    "The world's first voice-controlled AI video editor. Just say 'Cleo cut' when you mess up. AI cleans the rest — captions, cuts, ready-to-post clips.",
  metadataBase: new URL("https://cleocuts.com"),
  openGraph: {
    title: "CleoCuts — World's first voice-controlled AI video editor",
    description:
      "Just say 'Cleo cut' when you mess up. AI cleans it, adds captions, and gives you ready-to-post clips.",
    url: "https://cleocuts.com",
    siteName: "CleoCuts",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CleoCuts — World's first voice-controlled AI video editor",
    description: "Just say 'Cleo cut' when you mess up. AI does the rest.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0a10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // lang is set before the first paint by LANG_INIT_SCRIPT (the stored
    // or the browser's language) — hence suppressHydrationWarning.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LANG_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Accounts (Clerk) only when configured — otherwise no provider
            and no Clerk code at all, exactly like the anonymous beta. */}
        {AUTH_ENABLED ? <AuthProvider>{children}</AuthProvider> : children}
        {/* Browser error reports only with NEXT_PUBLIC_SENTRY_DSN. */}
        {ERROR_REPORTING_ENABLED && <ErrorReporting />}
        {/* Cookieless analytics only with NEXT_PUBLIC_ANALYTICS_PROVIDER. */}
        {ANALYTICS_ENABLED && <AnalyticsMount />}
      </body>
    </html>
  );
}
