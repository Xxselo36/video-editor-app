import type { Metadata } from "next";

// The library page is a Client Component, so its title lives here.
export const metadata: Metadata = { title: "Library" };

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
