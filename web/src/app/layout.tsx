import type { Metadata, Viewport } from "next";
import "./globals.css";

// No web fonts: the UI uses the system font stack (globals.css), the
// Geist fonts were preloaded on every page without being used.

export const metadata: Metadata = {
  title: "CleoCuts – KI-Videoschnitt per Sprachbefehl",
  description:
    "Sag „Cleo cut“, wenn du dich versprichst. CleoCuts schneidet Pausen, Füllwörter und verpatzte Takes automatisch heraus und fügt Untertitel hinzu – fertig für TikTok, Reels und YouTube.",
  metadataBase: new URL("https://cleocuts.com"),
  openGraph: {
    title: "CleoCuts – KI-Videoschnitt per Sprachbefehl",
    description:
      "Sag „Cleo cut“, wenn du dich versprichst. Die KI schneidet, untertitelt und liefert fertige Clips.",
    url: "https://cleocuts.com",
    siteName: "CleoCuts",
    locale: "de_DE",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CleoCuts – KI-Videoschnitt per Sprachbefehl",
    description: "Sag „Cleo cut“, wenn du dich versprichst. Die KI macht den Rest.",
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
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
