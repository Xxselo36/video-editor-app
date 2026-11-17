"use client";
// The sidebar of the app shell from 960 px: the brand, "Video hochladen",
// then Projekte, Vorschau, Einstellungen.
import Link from "next/link";
import { LogoMark } from "@/components/Logo";
import { useT } from "@/i18n";
import { NavIcon } from "./navIcons";
import { useNavItems } from "./useNavItems";
import s from "./shell.module.css";

export function Sidebar() {
  const t = useT();
  const items = useNavItems();
  const upload = items.find((i) => i.key === "upload");
  return (
    <nav className={s.sidebar} aria-label={t("app.nav.label")} data-testid="sidebar">
      <div className={s.brand}>
        <LogoMark size={28} idPrefix="cleoSide" />
        <span>CleoCuts</span>
      </div>
      {upload && (
        <Link
          href={upload.href}
          className={s.sideUp}
          aria-current={upload.current ? "page" : undefined}
          onClick={upload.onClick}
        >
          <NavIcon name="upload" className={s.sideUpIcon} />
          {upload.wide}
        </Link>
      )}
      {items
        .filter((i) => i.key !== "upload")
        .map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={s.sideLink}
            aria-current={item.current ? "page" : undefined}
          >
            <NavIcon name={item.key} className={s.sideIcon} />
            <span className={s.sideLabel}>{item.wide}</span>
          </Link>
        ))}
    </nav>
  );
}
