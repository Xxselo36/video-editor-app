/**
 * One suggested cut in the Text tab's notes, under "Cleo cut: N botched
 * takes removed" (job.cut_suggestions: what a "Cleo cut", a "Cleo finish"
 * or a guess at one before any "Cleo start" would remove, which the
 * analysis didn't cut on its own — src/scene_triggers.py):
 *
 *   ✦ Suggestion: remove 1:12? · Show · Apply
 *     No “Cleo start” before it, so Cleo asks first.
 *
 * The time is what still plays of it (Apply takes out that much); the
 * quiet line under it says why it waits for a tap (review F6: visible,
 * not a hover — phones have none), and describes Apply. Show and Apply
 * name the suggestion they act on (review R7: two suggestions are two
 * different buttons to a screen reader). No hooks: the Text tab owns
 * focus and the actions. The row wraps like a sentence (.noteFlow: German
 * in the 340 px panel, a 320 px phone), its actions flowing on under the
 * text; a separator keeps to what precedes it (NOTE_SEP).
 */
import { Sparkles } from "lucide-react";
import type { TFn } from "@/i18n";
import type { OpenSuggestion } from "@/features/editor/state/cuts";
import { fmtClock } from "../../model";
import s from "../../editor.module.css";

/** A note's "·" between its parts (.noteFlow): U+2060 WORD JOINER keeps it
 *  on the line of what precedes it, so a wrapped line starts with an
 *  action, never with a dot. */
export const NOTE_SEP = "\u2060·";

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
  const whyId = `ed-sugg-why-${Math.round(r.start * 1000)}-${Math.round(r.end * 1000)}`;
  return (
    <div data-testid="ed-cut-suggestion">
      <div className={`${s.note} ${s.noteFlow}`}>
        <Sparkles size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-cleo)", flexShrink: 0 }} />
        <span>{t("editor.cuts.suggestion", { len })}</span>
        <span aria-hidden className={s.noteSep}>
          {NOTE_SEP}
        </span>
        <button
          type="button"
          className={s.linkBtn}
          data-testid="ed-suggestion-show"
          aria-label={t("editor.cuts.suggestionShowAria", { len })}
          onClick={onShow}
        >
          {t("editor.cuts.showTake")}
        </button>
        <span aria-hidden className={s.noteSep}>
          {NOTE_SEP}
        </span>
        <button
          type="button"
          className={s.linkBtn}
          data-testid="ed-suggestion-take"
          aria-label={t("editor.cuts.suggestionTakeAria", { len })}
          aria-describedby={whyId}
          onClick={onTake}
        >
          {t("editor.cuts.takeSuggestion")}
        </button>
      </div>
      <div id={whyId} className={s.noteWhy} data-testid="ed-suggestion-why">
        {t("editor.cuts.suggestionWhy")}
      </div>
    </div>
  );
}

/** The open suggestions' notes in the Text tab (TranscriptEditor; useCuts
 *  suggestions): Show jumps to one, Apply takes it. No hooks. */
export function SuggestionNotes({
  suggestions,
  t,
  onShow,
  onTake,
}: {
  suggestions: readonly OpenSuggestion[];
  t: TFn;
  onShow: (r: OpenSuggestion) => void;
  onTake: (r: OpenSuggestion) => void;
}) {
  return (
    <>
      {suggestions.map((r) => (
        <CutSuggestionNote key={`${r.start}-${r.end}`} r={r} t={t} onShow={() => onShow(r)} onTake={() => onTake(r)} />
      ))}
    </>
  );
}
