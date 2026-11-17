"use client";
/**
 * The frame of the app's screens (PR3, plan §6.2; mockups
 * docs/mockups/start/3-projekte.html and settings/S1-S3): on phones a top
 * bar with the screen's title and the tab bar; from 960 px the sidebar.
 * The editor (/app/edit) has none.
 *
 * Only for browsers on the v2 editor (features/editor/v2/flag), like the
 * screens in it: everyone else keeps the page header of before
 * (components/AppHeader, via AppPage). The build's default while the page
 * hydrates (it is prerendered), the browser's own choice after.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LogoMark } from "@/components/Logo";
import { useT } from "@/i18n";
import { useViewportFitCover } from "@/lib/viewportFit";
import { EDITOR_V2 } from "@/features/editor/v2/flag";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { ShellContext, noteNavigation, useTopBar } from "./useShell";
import s from "./shell.module.css";

export function AppShell({ children }: { children: ReactNode }) {
  const on = useProjectsV2() ?? EDITOR_V2;
  return on ? <Shell>{children}</Shell> : children;
}

function Shell({ children }: { children: ReactNode }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const [trailing, setTrailing] = useState<HTMLElement | null>(null);
  useViewportFitCover();

  // Navigations within the shell (a link, Back, Forward): the first
  // screen of a visit behaves differently from one reached from another
  // (useShell navigatedInApp). Before the screens' own effects run.
  const seen = useRef(pathname);
  useLayoutEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    noteNavigation();
  }, [pathname]);

  const value = useMemo(() => ({ trailing }), [trailing]);
  return (
    <ShellContext.Provider value={value}>
      <div className={s.shell} data-app-shell="" data-testid="app-shell">
        <a href="#main" className={s.skip} onClick={skipToMain}>
          {t("app.nav.skip")}
        </a>
        <Sidebar />
        <div className={s.column}>
          <TopBar pathname={pathname} slot={setTrailing} />
          {children}
        </div>
        <TabBar />
      </div>
    </ShellContext.Provider>
  );
}

/** The skip link: the focus to the screen, with no history entry (Next
 *  ignores one it did not make: Back would stop on it). */
function skipToMain(e: MouseEvent<HTMLAnchorElement>) {
  const main = document.getElementById("main");
  if (!main) return;
  e.preventDefault();
  main.focus();
}

/** The top bar's title until the screen names its own (PageTitle `bar`). */
function routeTitle(pathname: string, t: ReturnType<typeof useT>): string {
  if (pathname === "/app/new") return t("app.start.title");
  if (pathname === "/app/preview" || pathname.startsWith("/app/p/")) return t("editor.preview");
  if (pathname === "/app/settings") return t("app.nav.settings");
  if (pathname === "/app/account") return t("app.account.title");
  return t("app.projects.title");
}

/**
 * The phone top bar: the mark, the screen's title (its <h1> is there for
 * screen readers, PageTitle) and the screen's action at the end. Clear
 * over the page's glow at the top; opaque with a line once the page
 * scrolls (no line where the screen draws its own under it).
 */
function TopBar({ pathname, slot }: { pathname: string; slot: (el: HTMLElement | null) => void }) {
  const t = useT();
  const asked = useTopBar();
  const sentinel = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <div ref={sentinel} className={s.sentinel} aria-hidden="true" />
      <div
        className={s.topbar}
        data-testid="topbar"
        data-scrolled={scrolled || undefined}
        data-edge={asked?.edge ?? "line"}
      >
        <LogoMark size={26} idPrefix="cleoTop" />
        <span className={s.barTitle} aria-hidden="true">
          {asked?.title ?? routeTitle(pathname, t)}
        </span>
        <div ref={slot} className={s.trailing} />
      </div>
    </>
  );
}
