"use client";
/**
 * The output format as static text (review D13): no dropdown, the format
 * is chosen at upload. TODO(UX11/UX6): the job's real aspect once GET
 * /jobs/{id} reports it; the shell renders 9:16 today.
 */
import { RectangleVertical } from "lucide-react";
import { useT } from "@/i18n";
import s from "../editor.module.css";

export function FormatLabel({ aspect = "9:16" }: { aspect?: string }) {
  const t = useT();
  return (
    <div className={s.format} title={t("editor.formatTip")} data-testid="ed-format">
      <RectangleVertical size={16} strokeWidth={1.75} aria-hidden />
      <span className={s.mono}>{aspect}</span>
    </div>
  );
}
