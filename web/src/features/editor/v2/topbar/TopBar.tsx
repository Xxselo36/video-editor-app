"use client";
/**
 * Top bar (editor.md §4.4): back · editable title · save status ·
 * undo/redo · format · Export. The phone keeps back, title, the save dot
 * and Export (undo/redo move to its player row).
 */
import { ChevronLeft, Pencil, Redo2, Undo2 } from "lucide-react";
import { useState, type RefObject } from "react";
import { useT } from "@/i18n";
import type { SaveError } from "@/features/editor/session/useEditSession";
import { kbd } from "../hooks";
import { ExportButton } from "./ExportButton";
import { FormatLabel } from "./FormatLabel";
import { SaveStatus } from "./SaveStatus";
import s from "../editor.module.css";

export type TopBarProps = {
  phone: boolean;
  title: string;
  onRename: (title: string) => void;
  onBack: () => void;
  saving: boolean;
  saveError: SaveError;
  onRetrySave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  exporting: boolean;
  offline: boolean;
  exportRef: RefObject<HTMLButtonElement | null>;
};

function TitleField({ title, onRename, phone }: { title: string; onRename: (t: string) => void; phone: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (editing) {
    const commit = () => {
      setEditing(false);
      const v = draft.trim();
      if (v && v !== title) onRename(v.slice(0, 120));
    };
    return (
      <input
        className={s.titleInput}
        style={phone ? { width: "min(44vw, 220px)", fontSize: 16 } : undefined}
        aria-label={t("editor.titleLabel")}
        value={draft}
        autoFocus
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={`${phone ? s.mb : s.gb} ${s.title}`}
      style={phone ? { padding: "0 6px", fontSize: 15, fontWeight: 600, maxWidth: "46vw" } : undefined}
      title={t("editor.rename")}
      aria-label={`${t("editor.titleLabel")}: ${title}`}
      data-testid="ed-title"
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
    >
      <span className={s.titleText}>{title}</span>
      {!phone && <Pencil className={s.pen} size={14} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}

export function TopBar({
  phone,
  title,
  onRename,
  onBack,
  saving,
  saveError,
  onRetrySave,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  exporting,
  offline,
  exportRef,
}: TopBarProps) {
  const t = useT();
  const back = (
    <button
      type="button"
      className={`${phone ? s.mb : s.gb} ${s.ico}`}
      aria-label={t("editor.back")}
      title={t("editor.back")}
      onClick={onBack}
      data-testid="editor-back"
    >
      <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
    </button>
  );
  if (phone) {
    return (
      <header className={s.top} data-testid="ed-topbar">
        {back}
        <TitleField title={title} onRename={onRename} phone />
        <SaveStatus saving={saving} error={saveError} onRetry={onRetrySave} compact />
        <span className={s.flex1} />
        <ExportButton ref={exportRef} onExport={onExport} busy={exporting} offline={offline} phone />
      </header>
    );
  }
  return (
    <header className={s.top} data-testid="ed-topbar">
      <div className={s.topGroup}>
        {back}
        <TitleField title={title} onRename={onRename} phone={false} />
        <SaveStatus saving={saving} error={saveError} onRetry={onRetrySave} />
      </div>
      <div className={`${s.topGroup} ${s.topRight}`}>
        <UndoRedo phone={false} canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />
        <span className={s.vsep} aria-hidden />
        <FormatLabel />
        <ExportButton ref={exportRef} onExport={onExport} busy={exporting} offline={offline} />
      </div>
    </header>
  );
}

export function UndoRedo({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  phone,
}: Pick<TopBarProps, "canUndo" | "canRedo" | "onUndo" | "onRedo" | "phone">) {
  const t = useT();
  const cls = `${phone ? s.mb : s.gb} ${s.ico}`;
  return (
    <>
      <button
        type="button"
        className={cls}
        aria-label={t("editor.undo")}
        title={`${t("editor.undo")} · ${kbd("⌘Z")}`}
        onClick={onUndo}
        disabled={!canUndo}
        data-testid="ed-undo"
      >
        <Undo2 size={phone ? 20 : 18} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        className={cls}
        aria-label={t("editor.redo")}
        title={`${t("editor.redo")} · ${kbd("⇧⌘Z")}`}
        onClick={onRedo}
        disabled={!canRedo}
        data-testid="ed-redo"
      >
        <Redo2 size={phone ? 20 : 18} strokeWidth={1.75} aria-hidden />
      </button>
    </>
  );
}
