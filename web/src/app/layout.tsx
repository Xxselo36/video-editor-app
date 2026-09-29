import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ERROR_REPORTING_ENABLED } from "@/lib/errorReporting";
import { ErrorReporting } from "@/components/ErrorReporting";

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
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/* Accounts (Clerk) only when configured — otherwise no provider
            and no Clerk code at all, exactly like the anonymous beta. */}
        {AUTH_ENABLED ? <AuthProvider>{children}</AuthProvider> : children}
        {/* Browser error reports only with NEXT_PUBLIC_SENTRY_DSN. */}
        {ERROR_REPORTING_ENABLED && <ErrorReporting />}
      </body>
    </html>
  );
}
