"use client";
/**
 * The word-level Text tab (UX8; captions.md §4.6, DF Desktop-Wort /
 * Handy-Wort): the edit document's words in sentence rows, virtualised
 * (@tanstack/react-virtual: a 30-minute podcast has ~10 000 words).
 *
 *   click            select the word and jump there (⇧-click extends)
 *   double-click, ↵  fix the text inline (desktop) / in the field at the
 *                    bottom of the sheet (phone); ↵ at the start of the
 *                    word or ⇧↵ also starts a new caption line there;
 *                    Tab / ⇧Tab move on to the next / previous word
 *   ← → ↑ ↓          move through the words (⇧ extends the selection)
 *   H                hide the selection from the captions / show it
 *   ⌘F               find & replace
 *
 * Every change is one pure op of state/doc.ts applied through `apply`
 * (one undo step, autosaved). The word under the playhead and its row
 * are marked through the DOM from the playhead store, so playing never
 * re-renders the list; while playing, the list follows the playhead.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Lightbulb, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import {
  editRange,
  findMatches,
  hideWords,
  replaceMatches,
  rowsOf,
  setBreak,
  wordAt,
  type DocWord,
  type EditDoc,
  type IdPool,
} from "@/features/editor/state/doc";
import { usePlayheadEffect, type PlayheadStore } from "@/features/editor/state/playhead";
import { useDocStore, type DocState, type DocStore } from "@/features/editor/state/store";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { cutTimeOfSource, fmtClock, removedRanges } from "../../model";
import { CutsHeader } from "../CutsHeader";
import { FindReplace } from "./FindReplace";
import { SelectionBar } from "./SelectionBar";
import { WordRow, type EditKeys } from "./WordSpan";
import s from "../../editor.module.css";

/** What the editor's global shortcuts (Enter, H, Esc outside the list) can do here. */
export type TextApi = { edit: () => boolean; hide: () => boolean; escape: () => boolean };

export type TranscriptEditorProps = {
  phone: boolean;
  doc: DocStore;
  pool: IdPool;
  /** One undo step (the shell orders it with the timeline's). */
  apply: (op: (d: EditDoc) => EditDoc) => boolean;
  playhead: PlayheadStore;
  editSegs: EditorSeg[];
  duration: number;
  toSource: (t: number) => number;
  /** Jump to a source range (paused). */
  seekRange: (start: number, end: number) => void;
  seekCut: (cut: number) => void;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  hint: boolean;
  onHintClose: () => void;
  onChooseStyle: () => void;
  onPlayPause: () => void;
  apiRef: RefObject<TextApi | null>;
  headerExtra?: React.ReactNode;
  toast: (msg: string) => void;
};

const selWords = (st: DocState) => st.present.words;
const selPreset = (st: DocState) => st.present.style?.presetId ?? null;

type Sel = { a: string; f: string };

function rangeOf(sel: Sel | null, index: ReadonlyMap<string, number>): [number, number] | null {
  if (!sel) return null;
  const a = index.get(sel.a);
  const f = index.get(sel.f);
  if (a === undefined || f === undefined) return null;
  return [Math.min(a, f), Math.max(a, f)];
}

const idxOf = (words: readonly DocWord[], id: string) => words.findIndex((w) => w.id === id);

export function TranscriptEditor(p: TranscriptEditorProps) {
  const t = useT();
  const words = useDocStore(p.doc, selWords);
  const preset = useDocStore(p.doc, selPreset);
  const { phone, apply, pool, seekRange } = p;

  const rows = useMemo(() => rowsOf(words), [words]);
  const rowOf = useMemo(() => {
    const a = new Int32Array(words.length);
    rows.forEach((r, ri) => a.fill(ri, r.first, r.last + 1));
    return a;
  }, [rows, words.length]);
  const index = useMemo(() => new Map(words.map((w, i) => [w.id, i])), [words]);
  const removed = useMemo(() => {
    const mask = new Uint8Array(words.length);
    const rr = removedRanges(p.editSegs, p.duration);
    let j = 0;
    for (let i = 0; i < words.length; i++) {
      const m = (words[i].start + words[i].end) / 2;
      while (j < rr.length && rr[j].end <= m) j++;
      if (j < rr.length && rr[j].start <= m) mask[i] = 1;
    }
    return mask;
  }, [words, p.editSegs, p.duration]);

  // ── selection and inline edit (word ids: stable across edits) ──────
  const [sel, setSel] = useState<Sel | null>(null);
  const [edit, setEdit] = useState<Sel | null>(null);
  const selRange = rangeOf(sel, index);
  const editRange_ = rangeOf(edit, index);
  const focusIdx = sel ? (index.get(sel.f) ?? -1) : -1;
  const wantFocus = useRef(false);

  // ── find & replace ─────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [cur, setCur] = useState(0);
  const matches = useMemo(() => (p.findOpen ? findMatches(words, query) : []), [p.findOpen, words, query]);
  // Opening find closes the word menu (it would cover the hits).
  const [findWas, setFindWas] = useState(p.findOpen);
  if (findWas !== p.findOpen) {
    setFindWas(p.findOpen);
    if (p.findOpen) setSel(null);
  }
  const curIdx = matches.length ? Math.min(cur, matches.length - 1) : -1;
  const hits = useMemo(() => {
    if (!matches.length) return null;
    const m = new Map<number, 1 | 2>();
    matches.forEach((h, k) => {
      for (let i = h.first; i <= h.last; i++) m.set(i, k === curIdx ? 2 : 1);
    });
    return m;
  }, [matches, curIdx]);

  // ── the virtual list ───────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const perLine = phone ? 5 : 7;
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer returns fresh functions by design
  // The notes (captions off, the one-time hint) scroll with the text, above the list.
  const notesRef = useRef<HTMLDivElement>(null);
  const [notesH, setNotesH] = useState(0);
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const measure = () => setNotesH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const v = useVirtualizer({
    count: rows.length,
    scrollMargin: notesH,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => 4 + 28 * Math.max(1, Math.ceil((rows[i].last - rows[i].first + 1) / perLine)),
    getItemKey: (i) => words[rows[i].first]?.id ?? i,
    overscan: 6,
  });
  const showRow = useCallback(
    (ri: number) => {
      const box = scrollRef.current;
      const el = box?.querySelector<HTMLElement>(`[data-row="${ri}"]`);
      if (box && el) {
        const r = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (r.top >= b.top + 8 && r.bottom <= b.bottom - 8) return;
      }
      v.scrollToIndex(ri, { align: "center" });
    },
    [v],
  );

  // ── the word under the playhead (DOM marks, no render) ─────────────
  const starts = useMemo(() => words.map((w) => w.start), [words]);
  const ends = useMemo(() => words.map((w) => w.end), [words]);
  const active = useRef(-1);
  const mark = useCallback(
    (idx: number) => {
      const box = scrollRef.current;
      if (!box) return;
      box.querySelectorAll('[data-on="true"]').forEach((el) => el.removeAttribute("data-on"));
      box.querySelectorAll('[data-active="true"]').forEach((el) => el.removeAttribute("data-active"));
      if (idx < 0) return;
      box.querySelector(`[data-wi="${idx}"]`)?.setAttribute("data-on", "true");
      box.querySelector(`[data-row="${rowOf[idx]}"]`)?.setAttribute("data-active", "true");
    },
    [rowOf],
  );
  const editing = edit !== null;
  usePlayheadEffect(p.playhead, (st) => {
    const idx = wordAt(starts, ends, p.toSource(st.mediaTime));
    if (idx === active.current) return;
    active.current = idx;
    mark(idx);
    if (st.playing && idx >= 0 && !editing) showRow(rowOf[idx]);
  });
  useLayoutEffect(() => {
    active.current = wordAt(starts, ends, p.toSource(p.playhead.getState().mediaTime));
    mark(active.current);
  });

  // ── actions ────────────────────────────────────────────────────────
  const seekWord = useCallback(
    (i: number) => {
      const w = words[i];
      // a hair into the word: the presented frame is then this word's
      if (w) seekRange(Math.min(w.end, w.start + Math.min(0.05, (w.end - w.start) / 2)), w.end);
    },
    [words, seekRange],
  );
  const selectWord = (i: number, extend: boolean, focus = false) => {
    const w = words[i];
    if (!w) return;
    setSel(extend && sel && index.has(sel.a) ? { a: sel.a, f: w.id } : { a: w.id, f: w.id });
    seekWord(i);
    if (focus) {
      wantFocus.current = true;
      showRow(rowOf[i]);
    }
  };
  const startEdit = (range: [number, number] | null = selRange) => {
    if (!range) return false;
    setEdit({ a: words[range[0]].id, f: words[range[1]].id });
    return true;
  };
  const toggleHide = () => {
    if (!selRange) return false;
    const ids = words.slice(selRange[0], selRange[1] + 1).map((w) => w.id);
    const hide = !ids.every((id) => words[index.get(id)!].hidden);
    if (apply((d) => hideWords(d, ids, hide))) track("words_edited", { action: hide ? "hide" : "show", n: ids.length });
    return true;
  };
  const broken = !!(selRange && selRange[0] > 0 && words[selRange[0]].breakBefore);
  const toggleBreak = () => {
    if (!selRange) return;
    const id = words[selRange[0]].id;
    if (apply((d) => setBreak(d, id, !broken))) track("words_edited", { action: broken ? "unbreak" : "break" });
  };

  const editKeys: EditKeys = {
    commit: (text, opts = {}) => {
      const e = edit;
      setEdit(null);
      if (!e) return;
      const lo = index.get(e.a);
      const hi = index.get(e.f);
      if (lo === undefined || hi === undefined) return;
      const before = lo > 0 ? words[lo - 1].id : null;
      const after = hi + 1 < words.length ? words[hi + 1].id : null;
      const changed = apply((d) => {
        const a = idxOf(d.words, e.a);
        const b = idxOf(d.words, e.f);
        if (a < 0 || b < a) return d;
        let n = editRange(d, a, b, text, pool);
        if (opts.breakBefore && idxOf(n.words, e.a) > 0) n = setBreak(n, e.a, true);
        return n;
      });
      if (changed) track("words_edited", { action: "text", n: hi - lo + 1 });
      // Where the selection goes: the next / previous word (Tab), else
      // the edited word (or its neighbour when it was deleted).
      const next = opts.move === 1 ? after : opts.move === -1 ? before : null;
      if (next) {
        setSel({ a: next, f: next });
        setEdit({ a: next, f: next });
        const ni = index.get(next);
        if (ni !== undefined) showRow(rowOf[ni]);
        return;
      }
      const keepId = p.doc.getState().present.words.some((w) => w.id === e.a) ? e.a : (before ?? after);
      setSel(keepId ? { a: keepId, f: keepId } : null);
      wantFocus.current = !phone;
    },
    cancel: () => {
      setEdit(null);
      wantFocus.current = !phone;
    },
  };

  // focus the selected word after a keyboard action (it may just have mounted)
  useLayoutEffect(() => {
    if (!wantFocus.current || focusIdx < 0) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-wi="${focusIdx}"]`);
    if (el) {
      wantFocus.current = false;
      el.focus({ preventScroll: true });
    }
  });

  // the editor's global shortcuts (focus outside the list); gone with the
  // tab: a closed Text tab must not hide, edit or swallow Escape.
  const apiRef = p.apiRef;
  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [apiRef],
  );
  useEffect(() => {
    p.apiRef.current = {
      edit: () => startEdit(),
      hide: () => toggleHide(),
      escape: () => {
        if (!sel && !edit) return false;
        setEdit(null);
        setSel(null);
        return true;
      },
    };
  });

  // ── list events (delegated) ─────────────────────────────────────────
  const wordOf = (target: EventTarget) => {
    const el = (target as HTMLElement).closest<HTMLElement>("[data-wi]");
    return el ? Number(el.dataset.wi) : -1;
  };
  const onClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const brk = el.closest<HTMLElement>("[data-brk]");
    if (brk) {
      const w = words[Number(brk.dataset.brk)];
      if (w && apply((d) => setBreak(d, w.id, false))) track("words_edited", { action: "unbreak" });
      return;
    }
    const ts = el.closest<HTMLElement>("[data-ts]");
    if (ts) {
      selectWord(Number(ts.dataset.ts), false);
      return;
    }
    const i = wordOf(e.target);
    if (i < 0) {
      if (!edit && el.closest("[data-testid=ed-word-input]") === null) setSel(null);
      return;
    }
    selectWord(i, e.shiftKey);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const i = wordOf(e.target);
    if (i >= 0) startEdit([i, i]);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = wordOf(e.target);
    if (i < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const r = rowOf[i];
    const move = (j: number) => selectWord(Math.max(0, Math.min(words.length - 1, j)), e.shiftKey, true);
    switch (e.key) {
      case "ArrowRight":
        move(i + 1);
        break;
      case "ArrowLeft":
        move(i - 1);
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const to = r + (e.key === "ArrowDown" ? 1 : -1);
        if (to < 0 || to >= rows.length) break;
        move(Math.min(rows[to].first + (i - rows[r].first), rows[to].last));
        break;
      }
      case "Home":
        move(rows[r].first);
        break;
      case "End":
        move(rows[r].last);
        break;
      case "Enter":
      case "F2":
        if (!selRange || i < selRange[0] || i > selRange[1]) {
          setSel({ a: words[i].id, f: words[i].id });
          startEdit([i, i]);
        } else startEdit();
        break;
      case "h":
      case "H":
        if (selRange && i >= selRange[0] && i <= selRange[1]) toggleHide();
        else {
          setSel({ a: words[i].id, f: words[i].id });
          const hide = !words[i].hidden;
          if (apply((d) => hideWords(d, [words[i].id], hide))) track("words_edited", { action: hide ? "hide" : "show", n: 1 });
        }
        break;
      case " ":
        p.onPlayPause();
        break;
      case "Escape":
        if (!sel) return;
        setSel(null);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // ── find & replace ─────────────────────────────────────────────────
  const goto = (k: number) => {
    if (!matches.length) return;
    const n = (k + matches.length) % matches.length;
    setCur(n);
    showRow(rowOf[matches[n].first]);
    seekWord(matches[n].first);
  };
  useEffect(() => {
    // a new query: show its first hit
    if (matches.length && query.trim()) v.scrollToIndex(rowOf[matches[0].first], { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the query changes
  }, [query]);
  const replaceOne = () => {
    if (curIdx < 0) return;
    const m = matches[curIdx];
    if (apply((d) => (d.words === words ? replaceMatches(d, [m], replacement, pool) : d)))
      track("words_edited", { action: "replace", n: 1 });
  };
  const replaceAll = () => {
    if (!matches.length) return;
    const n = matches.length;
    if (apply((d) => (d.words === words ? replaceMatches(d, matches, replacement, pool) : d))) {
      track("words_edited", { action: "replace_all", n });
      p.toast(t("editor.find.replaced", { count: n }));
    }
  };

  // ── the floating word menu (desktop) ───────────────────────────────
  const barRef = useRef<HTMLDivElement>(null);
  const placeBar = useCallback(() => {
    const bar = barRef.current;
    const root = rootRef.current;
    const box = scrollRef.current;
    if (!bar || !root || !box) return;
    const anchor =
      root.querySelector<HTMLElement>("[data-testid=ed-word-input]") ??
      (selRange ? box.querySelector<HTMLElement>(`[data-wi="${selRange[0]}"]`) : null);
    const r = anchor?.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (!r || r.bottom < b.top || r.top > b.bottom) {
      bar.style.visibility = "hidden";
      return;
    }
    const rr = root.getBoundingClientRect();
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2 - rr.left, rr.width - w - 8));
    const above = r.top - h - 8;
    const top = above >= b.top ? above - rr.top : r.bottom + 8 - rr.top;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.visibility = "visible";
  }, [selRange]);
  useLayoutEffect(() => {
    if (!phone) placeBar();
  });

  // ── phone: the edit field at the bottom of the sheet ──────────────
  const [draft, setDraft] = useState("");
  const editText = editRange_ ? words.slice(editRange_[0], editRange_[1] + 1).map((w) => w.text).join(" ") : "";
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const editKey = edit ? `${edit.a}|${edit.f}` : null;
  if (phone && editKey !== draftFor) {
    setDraftFor(editKey);
    setDraft(editText);
  }

  const items = v.getVirtualItems();
  const time = (i: number) => fmtClock(cutTimeOfSource(p.editSegs, words[i].start));
  const captionsOff = preset === "none";
  return (
    <div ref={rootRef} className={s.ted} data-testid="ed-text">
      <CutsHeader
        phone={phone}
        editSegs={p.editSegs}
        duration={p.duration}
        seekCut={p.seekCut}
        findOpen={p.findOpen}
        setFindOpen={p.setFindOpen}
        extra={p.headerExtra}
      />
      {p.findOpen && (
        <FindReplace
          query={query}
          setQuery={(q) => {
            setQuery(q);
            setCur(0);
          }}
          replacement={replacement}
          setReplacement={setReplacement}
          count={matches.length}
          index={curIdx}
          onPrev={() => goto(curIdx - 1)}
          onNext={() => goto(curIdx + 1)}
          onReplace={replaceOne}
          onReplaceAll={replaceAll}
          onClose={() => {
            p.setFindOpen(false);
            setQuery("");
          }}
        />
      )}
      <div
        ref={scrollRef}
        className={`${s.scroll} ${s.trScroll}`}
        data-testid="ed-transcript"
        onScroll={phone ? undefined : placeBar}
      >
        <div ref={notesRef} className={s.tedNotes}>
          {captionsOff && (
            <div className={s.note} data-testid="ed-captions-off">
              <span>{t("editor.text.captionsOff")}</span>
              <span aria-hidden>·</span>
              <button type="button" className={s.linkBtn} onClick={p.onChooseStyle}>
                {t("editor.text.chooseStyle")}
              </button>
            </div>
          )}
          {p.hint && (
            <div className={s.hint} data-testid="ed-hint">
              <Lightbulb size={14} strokeWidth={1.75} className={s.hintIcon} aria-hidden />
              <span style={{ flex: 1 }}>{t("editor.hint.words")}</span>
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
        </div>
        {words.length === 0 ? (
          <div className={s.empty}>{t("app.transcript.empty")}</div>
        ) : (
          <div
            className={s.tedList}
            style={{ height: v.getTotalSize() }}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
          >
            {items.map((it) => {
              const r = rows[it.index];
              const touches = (x: [number, number] | null) => (x && x[0] <= r.last && x[1] >= r.first ? x : null);
              return (
                <WordRow
                  key={it.key}
                  rowIndex={it.index}
                  first={r.first}
                  words={words.slice(r.first, r.last + 1)}
                  time={time(r.first)}
                  sel={touches(selRange)}
                  focus={focusIdx >= r.first && focusIdx <= r.last ? focusIdx : sel === null && it.index === items[0]?.index ? r.first : -1}
                  hits={hits}
                  removed={removed}
                  edit={!phone && touches(editRange_) ? { first: editRange_![0], last: editRange_![1], text: editText } : null}
                  editKeys={editKeys}
                  start={it.start - notesH}
                  measure={v.measureElement}
                />
              );
            })}
          </div>
        )}
      </div>
      {selRange && !phone && (
        <SelectionBar
          phone={false}
          hidden={words.slice(selRange[0], selRange[1] + 1).every((w) => w.hidden)}
          broken={broken}
          editing={editing}
          onHide={toggleHide}
          onEdit={() => (editing ? undefined : startEdit())}
          onBreak={toggleBreak}
          barRef={barRef}
        />
      )}
      {selRange && phone && (
        <SelectionBar
          phone
          hidden={words.slice(selRange[0], selRange[1] + 1).every((w) => w.hidden)}
          broken={broken}
          editing={editing}
          onHide={toggleHide}
          onEdit={() => (editing ? undefined : startEdit())}
          onBreak={toggleBreak}
        />
      )}
      {phone && edit && (
        <form
          className={s.meditRow}
          onSubmit={(e) => {
            e.preventDefault();
            editKeys.commit(draft);
          }}
        >
          <input
            className={s.medit}
            autoFocus
            value={draft}
            aria-label={t("editor.word.input")}
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                editKeys.cancel();
              }
            }}
            data-testid="ed-word-input"
          />
          <button type="submit" className={s.mb} style={{ color: "var(--ed-text-1)", fontWeight: 600 }} data-testid="ed-word-done">
            {t("editor.word.done")}
          </button>
        </form>
      )}
    </div>
  );
}
