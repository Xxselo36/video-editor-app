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
 *   data-rm    in a range the edit removes (UX10 makes it restorable)
 *   data-lc    recognised with low confidence (< 0.6)
 */
import { CornerDownRight } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import type { DocWord } from "@/features/editor/state/doc";
import s from "../../editor.module.css";

export const LOW_CONF = 0.6;

export type InlineEdit = {
  /** Word indices being edited (one input for the range). */
  first: number;
  last: number;
  text: string;
};

export type EditKeys = {
  commit: (text: string, opts?: { breakBefore?: boolean; move?: 1 | -1 }) => void;
  cancel: () => void;
};

export type RowProps = {
  rowIndex: number;
  first: number;
  words: readonly DocWord[];
  time: string;
  /** Selected word range (indices), when it touches this row. */
  sel: readonly [number, number] | null;
  /** The word that takes Tab (roving tabindex), when in this row. */
  focus: number;
  hits: ReadonlyMap<number, 1 | 2> | null;
  removed: Uint8Array;
  /** Inline edit (desktop), when it touches this row. */
  edit: InlineEdit | null;
  editKeys: EditKeys;
  start: number;
  measure: (el: HTMLElement | null) => void;
};

export const WordRow = memo(function WordRow({ measure, ...p }: RowProps) {
  const t = useT();
  const out: React.ReactNode[] = [];
  for (let k = 0; k < p.words.length; k++) {
    const i = p.first + k;
    const w = p.words[k];
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
      if (i === p.edit.first) out.push(<WordInput key={`edit-${w.id}`} text={p.edit.text} keys={p.editKeys} />);
      continue;
    }
    const sel = p.sel !== null && i >= p.sel[0] && i <= p.sel[1];
    const hit = p.hits?.get(i);
    const hidden = !!w.hidden;
    const rm = p.removed[i] === 1;
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
        {p.time}
      </button>
      <div className={s.trw}>{out}</div>
    </div>
  );
});

/** The inline input of a word (or a selected range) being fixed. */
function WordInput({ text, keys }: { text: string; keys: EditKeys }) {
  const t = useT();
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
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
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
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
