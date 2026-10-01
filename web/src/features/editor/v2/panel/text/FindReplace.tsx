"use client";
/**
 * Find & replace in the transcript (UX8; ⌘F or the magnifier in the
 * Text tab header): hits across words, case-insensitive (state/doc.ts
 * findMatches). Enter / ⇧Enter step through the hits, Enter in the
 * replace field replaces the current one; "Replace all" is one undo
 * step. "No results for “x”" (state matrix row 9).
 */
import { ChevronDown, ChevronUp, Replace, Search, X } from "lucide-react";
import { useT } from "@/i18n";
import s from "../../editor.module.css";

export type FindReplaceProps = {
  query: string;
  setQuery: (q: string) => void;
  replacement: string;
  setReplacement: (r: string) => void;
  count: number;
  /** Index of the current hit, -1 without hits. */
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
};

export function FindReplace(p: FindReplaceProps) {
  const t = useT();
  const q = p.query.trim();
  const keys = (e: React.KeyboardEvent, enter: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      enter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      p.onClose();
    }
  };
  return (
    <div className={s.findBox} role="search" data-testid="ed-find">
      <div className={s.find}>
        <Search size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-text-3)", flexShrink: 0 }} />
        <input
          className={s.findInput}
          autoFocus
          value={p.query}
          placeholder={t("editor.find.placeholder")}
          aria-label={t("editor.find.placeholder")}
          onChange={(e) => p.setQuery(e.target.value)}
          onKeyDown={(e) => keys(e, e.shiftKey ? p.onPrev : p.onNext)}
          data-testid="ed-find-input"
        />
        {q && p.count > 0 && (
          <span className={`${s.mono} ${s.findCount}`} data-testid="ed-find-count">
            {`${p.index + 1}/${p.count}`}
          </span>
        )}
        <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.prev")} onClick={p.onPrev} disabled={!p.count}>
          <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.next")} onClick={p.onNext} disabled={!p.count}>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.close")} onClick={p.onClose}>
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className={s.find}>
        <Replace size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-text-3)", flexShrink: 0 }} />
        <input
          className={s.findInput}
          value={p.replacement}
          placeholder={t("editor.find.replace")}
          aria-label={t("editor.find.replace")}
          onChange={(e) => p.setReplacement(e.target.value)}
          onKeyDown={(e) => keys(e, p.onReplace)}
          data-testid="ed-replace-input"
        />
        <button type="button" className={`${s.gb} ${s.findBtn}`} onClick={p.onReplace} disabled={!p.count} data-testid="ed-replace-one">
          {t("editor.find.replaceOne")}
        </button>
        <button type="button" className={`${s.gb} ${s.findBtn}`} onClick={p.onReplaceAll} disabled={!p.count} data-testid="ed-replace-all">
          {t("editor.find.replaceAll")}
        </button>
      </div>
      <div className={s.sr} role="status" aria-live="polite">
        {q ? (p.count ? `${p.index + 1}/${p.count}` : t("editor.find.noneFor", { q })) : ""}
      </div>
      {q && p.count === 0 && (
        <div className={s.findNone} data-testid="ed-find-none">
          {t("editor.find.noneFor", { q })}
        </div>
      )}
    </div>
  );
}
