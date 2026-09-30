"use client";
/**
 * Honest autosave status (editor.md §4.4), from the session's existing
 * semantics: saving / saved, "retrying" (transient failure, the edit is
 * re-sent) and "failed" (refused for good) with Retry. aria-live.
 * The phone shows the dot only (the text stays for screen readers).
 */
import { useT } from "@/i18n";
import type { SaveError } from "@/features/editor/session/useEditSession";
import s from "../editor.module.css";

export function SaveStatus({
  saving,
  error,
  onRetry,
  compact,
}: {
  saving: boolean;
  error: SaveError;
  onRetry: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const state = error === "failed" ? "failed" : error === "retrying" ? "retrying" : saving ? "saving" : "saved";
  const text = {
    saved: t("editor.save.saved"),
    saving: t("editor.save.saving"),
    retrying: t("editor.save.retrying"),
    failed: t("editor.save.failed"),
  }[state];
  return (
    <div className={s.save} data-testid="ed-save-status" data-state={state}>
      <span role="status" aria-live="polite" style={{ display: "contents" }}>
        <span className={s.saveDot} data-state={state} aria-hidden />
        <span className={compact ? s.sr : undefined}>{text}</span>
      </span>
      {state === "failed" && (
        <button type="button" className={`${s.gb} ${s.retry}`} onClick={onRetry}>
          {t("editor.save.retry")}
        </button>
      )}
    </div>
  );
}
