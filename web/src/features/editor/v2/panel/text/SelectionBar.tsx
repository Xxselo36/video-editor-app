"use client";
/**
 * Actions on the selected words (UX8; DF Desktop-Wort / Handy-Wort):
 * desktop a small vertical menu floating above the selection (the three
 * full labels don't fit side by side in the 380 px panel), the phone a
 * row of four actions at the bottom of the Text sheet.
 *
 *   Cut from video     disabled until UX10 (cuts in text)
 *   Hide / Show        hidden words stay in the text, not in the captions (H)
 *   Edit               fix the text (Enter)
 *   New caption line   a forced caption break before the first word
 */
import { CaseSensitive, CornerDownRight, Eye, EyeOff, Pencil, Scissors } from "lucide-react";
import type { RefObject } from "react";
import { useT } from "@/i18n";
import s from "../../editor.module.css";

export type SelectionBarProps = {
  phone: boolean;
  /** Every selected word is hidden: the action shows them again. */
  hidden: boolean;
  /** The first selected word starts a caption line (forced break). */
  broken: boolean;
  editing: boolean;
  onHide: () => void;
  onEdit: () => void;
  onBreak: () => void;
  barRef?: RefObject<HTMLDivElement | null>;
};

export function SelectionBar({ barRef, ...p }: SelectionBarProps) {
  const t = useT();
  const hideLabel = p.hidden ? t("editor.word.show") : t("editor.word.hide");
  const breakLabel = p.broken ? t("editor.word.unbreak") : t("editor.word.break");
  // Keep the words' focus: a mouse press on an action doesn't blur the
  // inline input before its click (the input commits on blur).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  if (p.phone) {
    return (
      <div role="toolbar" aria-label={t("editor.word.actions")} className={s.mbar} data-testid="ed-wordbar">
        <button type="button" className={s.mact} aria-disabled title={t("editor.word.cutSoon")} onMouseDown={keep}>
          <Scissors size={18} strokeWidth={1.75} aria-hidden />
          <span>{t("editor.word.cutShort")}</span>
        </button>
        <button type="button" className={s.mact} onMouseDown={keep} onClick={p.onHide} data-testid="ed-word-hide">
          {p.hidden ? <Eye size={18} strokeWidth={1.75} aria-hidden /> : <EyeOff size={18} strokeWidth={1.75} aria-hidden />}
          <span>{p.hidden ? t("editor.word.showShort") : t("editor.word.hideShort")}</span>
        </button>
        <button
          type="button"
          className={s.mact}
          aria-pressed={p.editing}
          onMouseDown={keep}
          onClick={p.onEdit}
          data-testid="ed-word-edit"
        >
          <Pencil size={18} strokeWidth={1.75} aria-hidden />
          <span>{t("editor.word.edit")}</span>
        </button>
        <button
          type="button"
          className={s.mact}
          aria-pressed={p.broken}
          onMouseDown={keep}
          onClick={p.onBreak}
          data-testid="ed-word-break"
        >
          <CornerDownRight size={18} strokeWidth={1.75} aria-hidden />
          <span>{t("editor.word.breakShort")}</span>
        </button>
      </div>
    );
  }
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t("editor.word.actions")}
      aria-orientation="vertical"
      className={s.wbar}
      style={{ visibility: "hidden" }}
      data-testid="ed-wordbar"
    >
      <button type="button" className={s.mi} aria-disabled title={t("editor.word.cutSoon")} onMouseDown={keep}>
        <Scissors size={16} strokeWidth={1.75} aria-hidden />
        <span>{t("editor.word.cut")}</span>
      </button>
      <button type="button" className={s.mi} title={`${hideLabel} · H`} onMouseDown={keep} onClick={p.onHide} data-testid="ed-word-hide">
        {p.hidden ? <Eye size={16} strokeWidth={1.75} aria-hidden /> : <EyeOff size={16} strokeWidth={1.75} aria-hidden />}
        <span>{hideLabel}</span>
        <span className={s.miKey} aria-hidden>
          H
        </span>
      </button>
      <button
        type="button"
        className={s.mi}
        aria-pressed={p.editing}
        title={t("editor.word.editTip")}
        onMouseDown={keep}
        onClick={p.onEdit}
        data-testid="ed-word-edit"
      >
        <CaseSensitive size={16} strokeWidth={1.75} aria-hidden />
        <span>{t("editor.word.edit")}</span>
        <span className={s.miKey} aria-hidden>
          ↵
        </span>
      </button>
      <button
        type="button"
        className={s.mi}
        aria-pressed={p.broken}
        title={t("editor.word.breakTip")}
        onMouseDown={keep}
        onClick={p.onBreak}
        data-testid="ed-word-break"
      >
        <CornerDownRight size={16} strokeWidth={1.75} aria-hidden />
        <span>{breakLabel}</span>
      </button>
    </div>
  );
}
