"use client";
/**
 * The frame of every /app screen (UX5): in the app shell
 * (components/shell) the screen's <main> next to the menu, its content
 * starting at the left; without it (v1) the page header and a centred
 * column of `width`. The header is a chunk of its own: shell screens
 * never load it.
 */
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useInShell } from "@/components/shell/useShell";
import s from "@/components/shell/shell.module.css";

const AppHeader = dynamic(() => import("@/components/AppHeader").then((m) => m.AppHeader), {
  // Its height while the chunk loads (no jump below it).
  loading: () => <div className="h-[61px]" style={{ borderBottom: "1px solid var(--border)" }} />,
});

const WIDTHS = { md: "max-w-md", "2xl": "max-w-2xl", "3xl": "max-w-3xl", "5xl": "max-w-5xl", "6xl": "max-w-6xl" } as const;

export function AppPage({ width, children }: { width: keyof typeof WIDTHS; children: ReactNode }) {
  const shell = useInShell();
  if (shell) {
    return (
      <main id="main" tabIndex={-1} className={s.main} style={{ color: "var(--text-strong)" }}>
        <div className={`phase-fade w-full ${WIDTHS[width]}`}>{children}</div>
      </main>
    );
  }
  return (
    <main className="flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <AppHeader />
      <div className={`phase-fade mx-auto w-full flex-1 px-5 py-8 ${WIDTHS[width]}`}>{children}</div>
    </main>
  );
}
