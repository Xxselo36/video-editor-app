import type { Metadata, Viewport } from "next";
import "./globals.css";

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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
