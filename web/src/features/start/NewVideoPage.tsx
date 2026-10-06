"use client";
/**
 * /app/new: the start of a video.
 *
 * - Browsers on the v2 editor (features/editor/v2/flag.ts: ?editor=v2,
 *   or NEXT_PUBLIC_EDITOR_V2=1) get the one start screen of UX6
 *   (StartScreen) — its own chunk (UX12: /app/new's first load stays in
 *   budget for everyone).
 * - Everyone else keeps the v1 flow exactly as before: workflow picker →
 *   file → settings (LegacyNewVideoPage).
 *
 * The page is prerendered with the build's default (EDITOR_V2); the
 * browser's own choice (localStorage, ?editor=) is read after mount, so
 * the first paint always matches the server's.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { EDITOR_V2, readChoice } from "@/features/editor/v2/flag";
import { LegacyNewVideoPage } from "./LegacyNewVideoPage";

const StartScreen = dynamic(() => import("./StartScreen").then((m) => m.StartScreen), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-2xl bg-[var(--surface-1)]" data-testid="start-loading" />,
});

export function NewVideoPage() {
  const [v2, setV2] = useState(EDITOR_V2);
  useEffect(() => {
    // After mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setV2(readChoice());
  }, []);
  if (!v2) return <LegacyNewVideoPage />;
  return (
    <AppPage width="md">
      <StartScreen />
    </AppPage>
  );
}
