// Editor v2 UI fonts (signed-off mock: Geist + Geist Mono), self-hosted
// by next/font at build time. Not preloaded: only the editor chunk uses
// them, and it is behind NEXT_PUBLIC_EDITOR_V2.
import { Geist, Geist_Mono } from "next/font/google";

export const geist = Geist({
  subsets: ["latin", "latin-ext", "cyrillic"],
  variable: "--ed-font-geist",
  display: "swap",
  preload: false,
});

export const geistMono = Geist_Mono({
  subsets: ["latin", "latin-ext", "cyrillic"],
  variable: "--ed-font-geist-mono",
  display: "swap",
  preload: false,
});
