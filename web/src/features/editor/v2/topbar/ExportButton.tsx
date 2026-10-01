"use client";
/**
 * The one filled button of the editor. Calls the session's apply (save
 * the timeline on screen, then the legacy render) until UX11 brings the
 * export sheet. Disabled while offline (editor.md §4.7).
 */
import { Download } from "lucide-react";
import { forwardRef } from "react";
import { useT } from "@/i18n";
import { CaptionsV2Marker } from "@/features/captions-ui/CaptionsV2Marker";
import { kbd } from "../hooks";
import s from "../editor.module.css";

export const ExportButton = forwardRef<
  HTMLButtonElement,
  { onExport: () => void; busy: boolean; offline: boolean; phone?: boolean }
>(function ExportButton({ onExport, busy, offline, phone }, ref) {
  const t = useT();
  const label = busy ? t("editor.exporting") : t("editor.export");
  const title = offline
    ? t("editor.exportOffline")
    : `${t("editor.export")} · ${kbd("⌘E")}`;
  if (phone) {
    return (
      <>
        <CaptionsV2Marker
          style={{ alignSelf: "center", marginRight: 6, fontSize: 10 }}
        />
        <button
          ref={ref}
          type="button"
          className={s.mprimary}
          onClick={onExport}
          disabled={busy || offline}
          title={title}
          data-testid="ed-export"
          data-tour="export"
        >
          <span className={s.pill}>{label}</span>
        </button>
      </>
    );
  }
  return (
    <>
      {/* UT4 opt-in note (nothing unless this browser asked for it) */}
      <CaptionsV2Marker style={{ alignSelf: "center", marginRight: 8 }} />
      <ExportPrimary
        ref={ref}
        onExport={onExport}
        busy={busy}
        offline={offline}
        label={label}
        title={title}
      />
    </>
  );
});

const ExportPrimary = forwardRef<
  HTMLButtonElement,
  {
    onExport: () => void;
    busy: boolean;
    offline: boolean;
    label: string;
    title: string;
  }
>(function ExportPrimary({ onExport, busy, offline, label, title }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`${s.primary} ${s.exportGap}`}
      onClick={onExport}
      disabled={busy || offline}
      title={title}
      data-testid="ed-export"
      data-tour="export"
    >
      <Download size={16} strokeWidth={1.75} aria-hidden />
      {label}
    </button>
  );
});
