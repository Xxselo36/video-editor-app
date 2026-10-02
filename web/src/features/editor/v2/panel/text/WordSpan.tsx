"use client";
/**
 * One transcript row of the word-level Text tab (UX8): the cut-time
 * stamp and the sentence's words as buttons (DF Desktop-Wort). Events
 * are delegated to the list (TranscriptEditor): a word carries its
 * index in `data-wi`. The word under the playhead is marked by the
 * editor through the DOM (data-on), not by a render.
 *
 *   data-sel   selected            data-hit  1 find hit · 2 current hit
 *   data-hidden hidden from captions (the analysis hides fillers)
 *   data-rm    cut from the video (struck; a click brings it back, UX10)
 *   data-lc    recognised with low confidence (< 0.6)
 *
 * UX10 chips (data-chip="i:k", the k-th chip before word i): ⏸ removed
 * pauses (≥ 0.4 s) and Cleo-cut takes, whose words collapse into the
 * chip. A click brings the footage back.
 */
import { CornerDownRight, RotateCcw, Scissors } from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";
import { useT } from "@/i18n";
import type { Chip } from "@/features/editor/state/cuts";
import type { DocWord } from "@/features/editor/state/doc";
import { fmtSeconds } from "../../model";
import s from "../../editor.module.css";

export const LOW_CONF = 0.6;

/**
 * A key press that belongs to an IME composition (Japanese, Korean,
 * Chinese input): Enter confirms the conversion, Tab picks a candidate —
 * never a commit, a move or a replace. Safari reports keyCode 229 just
 * after compositionend.
 */
export const composing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export type InlineEdit = {
  /** Word indices being edited (one input for the range). */
  first: number;
  last: number;
  /** The typed text (kept by the editor, so a remount keeps it). */
  draft: string;
  onDraft: (text: string) => void;
  /** Which edit this is (a new one remounts the input; a rename doesn't). */
  serial: number;
  /** True once per new edit: then the input selects its text. */
  takeFresh: () => boolean;
};

export type EditKeys = {
  commit: (text: string, opts?: { breakBefore?: boolean; move?: 1 | -1 }) => void;
  cancel: () => void;
};

/**
 * A row's cut marks (state/cuts.ts textMarks): `rm[k]` for its k-th word
 * (0 plays, 1 struck, 2 inside a take chip) and the chips before word i
 * (global index; the last row also has the ones after its last word).
 * The editor hands a row the same object while its marks stay the same,
 * so a timeline edit re-renders only the rows it changed (UX10).
 */
export type RowMarks = { rm: Uint8Array; chips: ReadonlyMap<number, Chip[]> };

export type RowProps = {
  rowIndex: number;
  first: number;
  words: readonly DocWord[];
  time: string;
  /** Selected word range (indices) where it touches this row, else -1 / -1. */
  selA: number;
  selB: number;
  /** The word that takes Tab (roving tabindex), when in this row. */
  focus: number;
  hits: ReadonlyMap<number, 1 | 2> | null;
  marks: RowMarks;
  /** Decimal separator of the UI language. */
  dec: string;
  /** Inline edit (desktop), when it touches this row. */
  edit: InlineEdit | null;
  editKeys: EditKeys;
  start: number;
  measure: (el: HTMLElement | null) => void;
  /** UT5: a caption in this row has its own size / position (a dot by the time). */
  adjusted?: boolean;
};

/** A removed pause or a Cleo-cut take in the text (DF chip): a button. */
function ChipView({ chip, at, k, dec }: { chip: Chip; at: number; k: number; dec: string }) {
  const t = useT();
  const len = fmtSeconds(chip.len, dec);
  const take = chip.kind === "take";
  const tip = take
    ? t("editor.cuts.takeTip", { len })
    : t(chip.reason === "filler" ? "editor.cuts.fillerTip" : chip.reason === "user" ? "editor.cuts.userTip" : "editor.cuts.pauseTip", { len });
  const color = take ? "var(--ed-cleo)" : chip.reason === "filler" ? "var(--ed-filler)" : chip.reason === "user" ? "var(--ed-text-3)" : "var(--ed-removed)";
  return (
    <button
      type="button"
      className={s.chip}
      data-chip={`${at}:${k}`}
      data-kind={take ? chip.reason : "pause"}
      tabIndex={-1}
      title={tip}
      aria-label={tip}
      data-testid={take ? "ed-take-chip" : "ed-pause-chip"}
    >
      {take ? (
        <Scissors size={11} strokeWidth={1.75} aria-hidden style={{ color, flexShrink: 0 }} />
      ) : (
        <svg viewBox="0 0 10 10" width="10" height="10" fill={color} aria-hidden style={{ display: "block", flexShrink: 0 }}>
          <rect x="2" y="1.5" width="2.2" height="7" rx=".7" />
          <rect x="5.8" y="1.5" width="2.2" height="7" rx=".7" />
        </svg>
      )}
      {take && <span>{t("editor.cuts.take")}</span>}
      <span className={s.mono} style={take ? { color: "var(--ed-text-3)" } : undefined}>
        {len}
      </span>
      <RotateCcw size={10} strokeWidth={1.75} aria-hidden className={s.chipRs} />
    </button>
  );
}

export const WordRow = memo(function WordRow({ measure, ...p }: RowProps) {
  const t = useT();
  const out: React.ReactNode[] = [];
  const chipsAt = (i: number) =>
    p.marks.chips.get(i)?.forEach((c, k) => out.push(<ChipView key={`c${i}-${k}`} chip={c} at={i} k={k} dec={p.dec} />));
  for (let k = 0; k < p.words.length; k++) {
    const i = p.first + k;
    const w = p.words[k];
    chipsAt(i);
    // inside a take chip: not shown on its own
    if (p.marks.rm[k] === 2) continue;
    if (k === 0 && w.breakBefore && i > 0) {
      out.push(
        <button
          key="brk"
          type="button"
          className={s.brk}
          data-brk={i}
          tabIndex={-1}
          aria-label={t("editor.word.breakMark")}
          title={t("editor.word.breakMark")}
        >
          <CornerDownRight size={13} strokeWidth={2} aria-hidden />
        </button>,
      );
    }
    if (p.edit && i >= p.edit.first && i <= p.edit.last) {
      // one input for the whole range, where it starts
      if (i === p.edit.first) out.push(<WordInput key={`edit-${p.edit.serial}`} edit={p.edit} keys={p.editKeys} />);
      continue;
    }
    const sel = i >= p.selA && i <= p.selB;
    const hit = p.hits?.get(i);
    const hidden = !!w.hidden;
    const rm = p.marks.rm[k] === 1;
    const lc = w.conf !== undefined && w.conf < LOW_CONF;
    out.push(
      <button
        key={w.id}
        type="button"
        className={s.w}
        data-wi={i}
        data-sel={sel || undefined}
        data-hit={hit}
        data-hidden={hidden || undefined}
        data-rm={rm || undefined}
        data-lc={lc || undefined}
        tabIndex={i === p.focus ? 0 : -1}
        aria-pressed={sel}
        title={rm ? t("editor.word.removedTip") : hidden ? t("editor.word.hiddenTip") : lc ? t("editor.transcript.lowConf") : undefined}
        data-testid="ed-word"
      >
        {w.text}
      </button>,
    );
  }
  chipsAt(p.first + p.words.length); // after the last word (last row only)
  if (!out.length) {
    // every word of the row is inside a take chip shown in an earlier row
    return <div ref={measure} className={s.trr} data-index={p.rowIndex} data-row={p.rowIndex} style={{ transform: `translateY(${p.start}px)`, height: 0, padding: 0 }} />;
  }
  return (
    <div
      ref={measure}
      className={s.trr}
      data-index={p.rowIndex}
      data-row={p.rowIndex}
      style={{ transform: `translateY(${p.start}px)` }}
      data-testid="transcript-line"
    >
      <button
        type="button"
        className={`${s.mono} ${s.trTs}`}
        data-ts={p.first}
        tabIndex={-1}
        aria-label={t("editor.transcript.seek", { time: p.time })}
      >
        {p.adjusted && (
          <span className={s.rdot} title={t("editor.caption.ownTip")} aria-label={t("editor.caption.ownTip")} data-testid="ed-row-adjusted" />
        )}
        {p.time}
      </button>
      <div className={s.trw}>{out}</div>
    </div>
  );
});

/** The inline input of a word (or a selected range) being fixed. */
function WordInput({ edit, keys }: { edit: InlineEdit; keys: EditKeys }) {
  const t = useT();
  const draft = edit.draft;
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const takeFresh = edit.takeFresh;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // select the text when the edit starts, not when the row remounts
    if (takeFresh()) el.select();
  }, [takeFresh]);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <input
      ref={ref}
      className={s.wedit}
      value={draft}
      size={Math.max(3, [...draft].length + 1)}
      aria-label={t("editor.word.input")}
      spellCheck={false}
      autoComplete="off"
      data-testid="ed-word-input"
      onChange={(e) => edit.onDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          const el = e.currentTarget;
          // Enter at the very start of the word (or ⇧Enter): a new caption line starts here.
          const atStart = el.selectionStart === 0 && el.selectionEnd === 0 && draft.trim() !== "";
          finish(() => keys.commit(draft, { breakBefore: atStart || e.shiftKey }));
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(() => keys.commit(draft, { move: e.shiftKey ? -1 : 1 }));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(keys.cancel);
        }
      }}
      onBlur={() => finish(() => keys.commit(draft))}
    />
  );
}
