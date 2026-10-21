/**
 * One suggested cut in the Text tab's notes, under "Cleo cut: N botched
 * takes removed" (job.cut_suggestions: what a "Cleo cut", a "Cleo finish"
 * or a guess at one before any "Cleo start" would remove, which the
 * analysis didn't cut on its own — src/scene_triggers.py):
 *
 *   ✦ Suggestion: remove 1:12? · Show · Apply
 *
 * The time is what still plays of it (Apply takes out that much); the
 * hover says why it waits for a tap. Show and Apply name the suggestion
 * they act on (review R7: two suggestions are two different buttons to a
 * screen reader). No hooks: the Text tab owns focus and the actions.
 */
import { Sparkles } from "lucide-react";
import type { TFn } from "@/i18n";
import type { OpenSuggestion } from "@/features/editor/state/cuts";
import { fmtClock } from "../../model";
import s from "../../editor.module.css";

export function CutSuggestionNote({
  r,
  t,
  onShow,
  onTake,
}: {
  r: OpenSuggestion;
  t: TFn;
  onShow: () => void;
  onTake: () => void;
}) {
  const len = fmtClock(r.plays);
  return (
    <div className={s.note} data-testid="ed-cut-suggestion">
      <Sparkles size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-cleo)", flexShrink: 0 }} />
      <span title={t("editor.cuts.suggestionWhy")}>{t("editor.cuts.suggestion", { len })}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className={s.linkBtn}
        data-testid="ed-suggestion-show"
        aria-label={t("editor.cuts.suggestionShowAria", { len })}
        onClick={onShow}
      >
        {t("editor.cuts.showTake")}
      </button>
      <span aria-hidden>·</span>
      <button
        type="button"
        className={s.linkBtn}
        data-testid="ed-suggestion-take"
        aria-label={t("editor.cuts.suggestionTakeAria", { len })}
        onClick={onTake}
      >
        {t("editor.cuts.takeSuggestion")}
      </button>
    </div>
  );
}
