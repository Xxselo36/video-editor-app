"use client";
// The frame of every /app route (UX5; was the one page's <main> in
// app/app/page.tsx): the header and a centered column of `width`.
import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";

const WIDTHS = { md: "max-w-md", "2xl": "max-w-2xl", "3xl": "max-w-3xl" } as const;

export function AppPage({ width, children }: { width: keyof typeof WIDTHS; children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <AppHeader />
      <div className={`phase-fade mx-auto w-full flex-1 px-5 py-8 ${WIDTHS[width]}`}>{children}</div>
    </main>
  );
}
