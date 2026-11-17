"use client";
// The tab bar of the app shell on phones (below 960 px): Projekte,
// Hochladen, Vorschau, Einstellungen. Upload is the same tint bubble on
// every screen: each screen's own action keeps the one filled violet.
import Link from "next/link";
import { useT } from "@/i18n";
import { NavIcon } from "./navIcons";
import { useNavItems } from "./useNavItems";
import s from "./shell.module.css";

export function TabBar() {
  const t = useT();
  const items = useNavItems();
  return (
    <nav className={s.tabbar} aria-label={t("app.nav.label")} data-testid="tabbar">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={s.tab}
          data-up={item.key === "upload" || undefined}
          aria-current={item.current ? "page" : undefined}
          onClick={item.onClick}
        >
          {item.key === "upload" ? (
            <span className={s.bubble}>
              <NavIcon name="upload" className={s.bubbleIcon} />
            </span>
          ) : (
            <NavIcon name={item.key} className={s.tabIcon} />
          )}
          <span className={s.tabLabel}>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
