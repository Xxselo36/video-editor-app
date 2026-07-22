import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
    description:
      "Just say 'Cleo cut' when you mess up. AI does the rest.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
