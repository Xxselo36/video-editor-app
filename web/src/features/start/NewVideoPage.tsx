"use client";
/**
 * /app/new: the start of a video.
 *
 * - Browsers on the v2 editor (features/editor/v2/flag.ts: the default,
 *   or ?editor=v2 with NEXT_PUBLIC_EDITOR_V2=optin) get "Neues Video",
 *   then "Untertitel wählen" (StartScreen): its own chunk, like the
 *   caption engine and the upload code it loads (/app/new's first load
 *   stays in budget for everyone).
 * - Everyone else keeps the v1 flow exactly as before: workflow picker →
 *   file → settings (LegacyNewVideoPage), a chunk of its own as well
 *   (prerendered where it is the build's default).
 *
 * The page is prerendered with the build's default (EDITOR_V2); the
 * browser's own choice (localStorage, ?editor=) is read after mount, so
 * the first paint always matches the server's.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { EDITOR_V2, readChoice } from "@/features/editor/v2/flag";

const LegacyNewVideoPage = dynamic(() => import("./LegacyNewVideoPage").then((m) => m.LegacyNewVideoPage), {
  loading: () => <AppPage width="2xl">{null}</AppPage>,
});

const StartScreen = dynamic(() => import("./StartScreen").then((m) => m.StartScreen), {
  ssr: false,
  // The shape of "Neues Video" (its card) while the chunk loads.
  loading: () => (
    <div className="flex max-w-[820px] flex-col gap-4 min-[960px]:gap-7" data-testid="start-loading">
      <div className="h-8 w-44 rounded-lg bg-[var(--surface-1)] motion-safe:animate-pulse min-[960px]:h-11" />
      <div className="min-h-[max(380px,calc(100svh-var(--app-chrome,190px)))] rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] motion-safe:animate-pulse min-[960px]:min-h-[440px]" />
    </div>
  ),
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
    <AppPage width="6xl">
      <StartScreen />
    </AppPage>
  );
}
