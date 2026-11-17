"use client";
/**
 * The app's four places, for the tab bar (phones) and the sidebar (from
 * 960 px): Projekte, Hochladen, Vorschau, Einstellungen. A project's
 * Vorschau (/app/p/…) counts as the Vorschau; the account page as
 * Einstellungen (it is reached from there).
 */
import { usePathname } from "next/navigation";
import { useT } from "@/i18n";
import type { NavIconName } from "./navIcons";
import { bumpStartKey } from "./startKey";

export type NavItem = {
  key: NavIconName;
  href: string;
  /** The tab's label (phones); `wide` is the sidebar's, where it differs. */
  label: string;
  wide: string;
  current: boolean;
  onClick?: () => void;
};

export function currentPlace(pathname: string): NavIconName | null {
  if (pathname === "/app" || pathname === "/app/library") return "projects";
  if (pathname === "/app/new") return "upload";
  if (pathname === "/app/preview" || pathname.startsWith("/app/p/")) return "preview";
  if (pathname === "/app/settings" || pathname === "/app/account") return "settings";
  return null;
}

export function useNavItems(): NavItem[] {
  const t = useT();
  const pathname = usePathname() ?? "";
  const here = currentPlace(pathname);
  const projects = t("app.projects.title");
  const preview = t("editor.preview");
  const settings = t("app.nav.settings");
  return [
    { key: "projects", href: "/app", label: projects, wide: projects, current: here === "projects" },
    {
      key: "upload",
      href: "/app/new",
      label: t("app.nav.upload"),
      wide: t("app.nav.uploadVideo"),
      current: here === "upload",
      // Already there: a new start (a waiting video comes back as it was).
      onClick: here === "upload" ? bumpStartKey : undefined,
    },
    { key: "preview", href: "/app/preview", label: preview, wide: preview, current: here === "preview" },
    { key: "settings", href: "/app/settings", label: settings, wide: settings, current: here === "settings" },
  ];
}
