import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ERROR_REPORTING_ENABLED } from "@/lib/errorReporting";
import { ErrorReporting } from "@/components/ErrorReporting";
import { ANALYTICS_ENABLED } from "@/lib/analytics";
import { AnalyticsMount } from "@/components/AnalyticsMount";
import { LANG_INIT_SCRIPT } from "@/i18n/langs";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/site";

// No web fonts: the UI uses the system font stack (globals.css), the
// Geist fonts were preloaded on every page without being used.

export const metadata: Metadata = {
  // Pages set a short title of their own ("Privacy"); the template makes
  // it "Privacy · CleoCuts". The landing (a client page) gets the default.
  title: { default: SITE_TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  metadataBase: new URL(SITE_URL),
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0a10",
  colorScheme: "dark",
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
