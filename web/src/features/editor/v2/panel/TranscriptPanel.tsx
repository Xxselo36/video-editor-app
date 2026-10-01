"use client";
/**
 * "Text & cuts" for a job without an edit document (analysed before
 * UT3; the word-level tab of UX8 is panel/text/TranscriptEditor): the
 * header (CutsHeader), then the v1 transcript (sentence lines, editable
 * text, delete with undo, /phrases autosave) in the v2 look. The time gutter is on the CUT timeline; the line
 * under the playhead is white (a playhead selector: one render per line
 * change, not per frame).
 */
import { ChevronDown, ChevronUp, Lightbulb, Search, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang, useT } from "@/i18n";
import { track } from "@/lib/analytics";
import type { Phrase } from "@/features/editor/legacy/buildPhrases";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { activeIndexAt, usePlayhead, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import { cutTimeOfSource, fmtClock } from "../model";
import { CutsHeader } from "./CutsHeader";
import s from "../editor.module.css";

export type TranscriptPanelProps = {
  phone: boolean;
  store: PlayheadStore;
  phrases: Phrase[];
  onChange: (p: Phrase[]) => void;
  editSegs: EditorSeg[];
  duration: number;
  toSource: (t: number) => number;
  seekToPhrase: (p: Phrase, play?: boolean) => void;
  seekCut: (cut: number) => void;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  hint: boolean;
  onHintClose: () => void;
  /** Phone sheet: the close button next to search. */
  headerExtra?: React.ReactNode;
  toast: (msg: string, action?: { label: string; run: () => void }) => void;
};

export function TranscriptPanel(p: TranscriptPanelProps) {
  const t = useT();
  const lang = useLang();

  // ── the line under the playhead ─────────────────────────────────────
  const starts = useMemo(() => p.phrases.map((x) => x.original_start), [p.phrases]);
  const ends = useMemo(() => p.phrases.map((x) => x.original_end), [p.phrases]);
  const toSource = p.toSource;
  const sel = useMemo(
    () => (st: PlayheadState) => activeIndexAt(starts, ends, toSource(st.mediaTime)),
    [starts, ends, toSource],
  );
  const active = usePlayhead(p.store, sel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    if (active < 0 || !p.store.getState().playing) return;
    const c = scrollRef.current;
    const el = rowRefs.current[active];
    if (!c || !el) return;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo({ top: Math.max(0, top - c.clientHeight * 0.3), behavior: "smooth" });
  }, [active, p.store]);

  // ── find ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [cur, setCur] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase(lang);
    if (!p.findOpen || !q) return [] as number[];
    return p.phrases.flatMap((x, i) => (x.text.toLocaleLowerCase(lang).includes(q) ? [i] : []));
  }, [query, p.phrases, p.findOpen, lang]);
  const current = matches.length ? matches[Math.min(cur, matches.length - 1)] : -1;
  const goto = (k: number) => {
    if (!matches.length) return;
    const n = (k + matches.length) % matches.length;
    setCur(n);
    const i = matches[n];
    rowRefs.current[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
    p.seekToPhrase(p.phrases[i], false);
  };

  // ── editing (v1 semantics) ──────────────────────────────────────────
  const editStartRef = useRef<string | null>(null);
  const update = (idx: number, text: string) => {
    const next = p.phrases.slice();
    next[idx] = { ...next[idx], text };
    p.onChange(next);
  };
  const phrasesRef = useRef(p.phrases);
  useEffect(() => {
    phrasesRef.current = p.phrases;
  });
  const remove = (idx: number) => {
    const phrase = p.phrases[idx];
    track("words_edited", { action: "line_deleted" });
    p.onChange(p.phrases.filter((_, i) => i !== idx));
    p.toast(t("app.transcript.lineDeleted"), {
      label: t("app.transcript.undo"),
      run: () => {
        track("undo", { area: "transcript" });
        const next = phrasesRef.current.slice();
        next.splice(Math.min(idx, next.length), 0, phrase);
        p.onChange(next);
      },
    });
  };

  return (
    <>
      <CutsHeader
        phone={p.phone}
        editSegs={p.editSegs}
        duration={p.duration}
        seekCut={p.seekCut}
        findOpen={p.findOpen}
        setFindOpen={p.setFindOpen}
        extra={p.headerExtra}
      />
      {p.findOpen && (
        <FindBar
          query={query}
          setQuery={(q) => {
            setQuery(q);
            setCur(0);
          }}
          count={matches.length}
          index={matches.length ? Math.min(cur, matches.length - 1) : -1}
          onPrev={() => goto(cur - 1)}
          onNext={() => goto(cur + 1)}
          onClose={() => {
            p.setFindOpen(false);
            setQuery("");
          }}
        />
      )}
      <div ref={scrollRef} className={`${s.scroll} ${s.trScroll}`} data-testid="ed-transcript">
        {p.hint && (
          <div className={s.hint} data-testid="ed-hint">
            <Lightbulb size={14} strokeWidth={1.75} className={s.hintIcon} aria-hidden />
            <span style={{ flex: 1 }}>{t("editor.hint")}</span>
            <button
              type="button"
              className={`${s.gb} ${s.sm}`}
              aria-label={t("editor.hint.close")}
              title={t("editor.hint.close")}
              onClick={p.onHintClose}
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        )}
        {p.phrases.length === 0 ? (
          <div className={s.empty}>{t("app.transcript.empty")}</div>
        ) : (
          <div className={s.trList}>
            {p.phrases.map((ph, i) => (
              <Row
                key={i}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                index={i}
                phrase={ph}
                time={fmtClock(cutTimeOfSource(p.editSegs, ph.original_start))}
                active={i === active}
                match={matches.includes(i)}
                current={i === current}
                phone={p.phone}
                onSeek={p.seekToPhrase}
                onText={update}
                onRemove={remove}
                editStartRef={editStartRef}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

type RowProps = {
  index: number;
  phrase: Phrase;
  time: string;
  active: boolean;
  match: boolean;
  current: boolean;
  phone: boolean;
  onSeek: (p: Phrase) => void;
  onText: (idx: number, text: string) => void;
  onRemove: (idx: number) => void;
  editStartRef: React.RefObject<string | null>;
  ref?: React.Ref<HTMLDivElement>;
};

const Row = memo(function Row({
  index,
  phrase,
  time,
  active,
  match,
  current,
  phone,
  onSeek,
  onText,
  onRemove,
  editStartRef,
  ref,
}: RowProps) {
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  // Auto height (field-sizing: content where supported, else measured).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || CSS.supports?.("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [phrase.text]);
  const lowConf = phrase.confidence < 0.6;
  return (
    <div
      ref={ref}
      className={s.trRow}
      data-active={active}
      data-match={match}
      data-current={current}
      data-testid="transcript-line"
    >
      <button
        type="button"
        className={`${s.mono} ${s.trTs}`}
        onClick={() => onSeek(phrase)}
        aria-label={t("editor.transcript.seek", { time })}
        data-testid="transcript-seek"
      >
        {time}
      </button>
      <textarea
        ref={area}
        className={s.trText}
        value={phrase.text}
        rows={1}
        aria-label={t("editor.transcript.line", { time })}
        title={lowConf ? t("editor.transcript.lowConf") : undefined}
        data-lowconf={lowConf}
        spellCheck={false}
        onFocus={() => {
          editStartRef.current = phrase.text;
        }}
        onBlur={() => {
          // Analytics: one words_edited per line edit (focus → blur).
          if (editStartRef.current !== null && editStartRef.current !== phrase.text) {
            track("words_edited", { action: "text" });
          }
          editStartRef.current = null;
        }}
        onChange={(e) => onText(index, e.target.value)}
      />
      <button
        type="button"
        className={`${s.gb} ${s.sm} ${s.trDel}`}
        aria-label={t("app.transcript.deleteSentence")}
        title={t("app.transcript.deleteSentence")}
        onClick={() => onRemove(index)}
        style={phone ? { width: 32, height: 32 } : undefined}
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
});

export function FindBar({
  query,
  setQuery,
  count,
  index,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  setQuery: (q: string) => void;
  count: number;
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className={s.find} role="search" data-testid="ed-find">
      <Search size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-text-3)", flexShrink: 0 }} />
      <input
        className={s.findInput}
        autoFocus
        value={query}
        placeholder={t("editor.find.placeholder")}
        aria-label={t("editor.find.placeholder")}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      {query.trim() && (
        <span className={`${s.mono} ${s.findCount}`} aria-live="polite">
          {count ? `${index + 1}/${count}` : t("editor.find.none")}
        </span>
      )}
      <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.prev")} onClick={onPrev} disabled={!count}>
        <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.next")} onClick={onNext} disabled={!count}>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.find.close")} onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
