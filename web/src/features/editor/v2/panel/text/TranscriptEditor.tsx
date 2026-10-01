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
 *   ⌫ / Delete       cut the selection from the video / bring it back (UX10)
 *   ⌘F               find & replace
 *
 * UX10: words cut from the video are struck through (a click brings one
 * back); removed pauses (≥ 0.4 s) and Cleo-cut takes are chips (a click
 * brings them back); "Cleo cut: N botched takes removed · Show" heads the
 * text (Show jumps to the first one).
 * Cuts are clip edits (useCuts): timeline undo steps.
 *
 * Every change is one pure op of state/doc.ts applied through `apply`
 * (one undo step, autosaved). The word under the playhead and its row
 * are marked through the DOM from the playhead store, so playing never
 * re-renders the list; while playing, the list follows the playhead.
 */
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Lightbulb, Sparkles, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLang, useT } from "@/i18n";
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
import { TAKE_KINDS, textMarks, type Chip } from "@/features/editor/state/cuts";
import { cutTimeOfSource, decimalSeparator, fmtClock } from "../../model";
import type { CutsApi } from "../../useCuts";
import { CutsHeader, plural } from "../CutsHeader";
import { FindReplace } from "./FindReplace";
import { SelectionBar } from "./SelectionBar";
import { composing, WordRow, type EditKeys, type RowMarks } from "./WordSpan";
import s from "../../editor.module.css";

/** What the editor's global shortcuts (Enter, H, ⌫, Esc outside the list) can do here. */
export type TextApi = { edit: () => boolean; hide: () => boolean; cut: () => boolean; escape: () => boolean };

export type TranscriptEditorProps = {
  phone: boolean;
  doc: DocStore;
  pool: IdPool;
  /** One undo step (the shell orders it with the timeline's). */
  apply: (op: (d: EditDoc) => EditDoc) => boolean;
  playhead: PlayheadStore;
  editSegs: EditorSeg[];
  /** UX10: what is cut and why; cut / restore as timeline undo steps. */
  cuts: CutsApi;
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
  /** UT5: ids of words whose caption has its own size / position (a dot on their row). */
  adjusted?: ReadonlySet<string>;
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
  const lang = useLang();
  const dec = decimalSeparator(lang);
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
  // UX10: struck words, words inside a Cleo-cut take chip, pause chips
  // (a cut's marks follow in a render of their own: an edit shows at once)
  const pieces = useDeferredValue(p.cuts.pieces);
  const marks = useMemo(() => textMarks(words, pieces, p.duration), [words, pieces, p.duration]);
  const removed = marks.removed;
  // Each row gets the same props while it stays the same (its words, its
  // marks), so an edit re-renders only the rows it touches.
  const rowWords = useMemo(() => rows.map((r) => words.slice(r.first, r.last + 1)), [rows, words]);
  const [rowMarksCache] = useState(() => ({ words: null as readonly DocWord[] | null, rows: new Map<number, { sig: string; m: RowMarks }>() }));
  const rowMarks = (ri: number): RowMarks => {
    const c = rowMarksCache;
    if (c.words !== words) {
      c.words = words;
      c.rows.clear();
    }
    const r = rows[ri];
    const rm = removed.subarray(r.first, r.last + 1);
    const chips = new Map<number, Chip[]>();
    const to = ri === rows.length - 1 ? r.last + 1 : r.last;
    let sig = rm.join("");
    for (let i = r.first; i <= to; i++) {
      const cs = marks.chips.get(i);
      if (!cs) continue;
      chips.set(i, cs);
      sig += `|${i}:${cs.map((x) => `${x.kind}${x.reason}${x.ranges.map((q) => `${q.start},${q.end}`).join(";")}`).join("/")}`;
    }
    const old = c.rows.get(ri);
    if (old && old.sig === sig) return old.m;
    const m = { rm, chips };
    c.rows.set(ri, { sig, m });
    return m;
  };
  const takes = useMemo(() => pieces.filter((x) => TAKE_KINDS.has(x.kind)), [pieces]);

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
  // The row with the inline edit stays mounted when it scrolls out of
  // view: unmounting the focused input would drop the typed text (no
  // blur fires while React commits).
  const keepRow = editRange_ ? rowOf[editRange_[0]] : -1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const r = defaultRangeExtractor(range);
      if (keepRow >= 0 && keepRow < range.count && !r.includes(keepRow)) {
        r.push(keepRow);
        r.sort((a, b) => a - b);
      }
      return r;
    },
    [keepRow],
  );
  const v = useVirtualizer({
    rangeExtractor,
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
  const [draft, setDraft] = useState("");
  const freshEdit = useRef(false);
  const [editSerial, setEditSerial] = useState(0);
  /** Open the edit of words lo..hi with their text as the draft. */
  const beginEdit = (lo: number, hi: number) => {
    setEdit({ a: words[lo].id, f: words[hi].id });
    setDraft(words.slice(lo, hi + 1).map((w) => w.text).join(" "));
    freshEdit.current = true;
    setEditSerial((n) => n + 1);
  };
  const takeFresh = useCallback(() => {
    const f = freshEdit.current;
    freshEdit.current = false;
    return f;
  }, []);
  const startEdit = (range: [number, number] | null = selRange) => {
    if (!range) return false;
    beginEdit(range[0], range[1]);
    return true;
  };
  // The autosave may give unsaved words new ids (serverIds): follow them,
  // or the selection and an open edit would point at nothing.
  useEffect(
    () =>
      p.doc.onRenamed((map) => {
        const re = (x: Sel | null) => (x ? { a: map.get(x.a) ?? x.a, f: map.get(x.f) ?? x.f } : x);
        setSel(re);
        setEdit(re);
      }),
    [p.doc],
  );
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

  // ── cuts (UX10): the selection out of the video, or back in ────────
  const selRemoved = !!selRange && removed.subarray(selRange[0], selRange[1] + 1).every((x) => x !== 0);
  const toggleCut = () => {
    if (!selRange) return false;
    const [a, b] = selRange;
    if (selRemoved) p.cuts.restoreWord({ start: words[a].start, end: words[b].end });
    else p.cuts.cutWords(words, a, b);
    wantFocus.current = !phone;
    return true;
  };
  const restoreChip = (chip: Chip) => p.cuts.restore(chip.ranges);

  // the rows get one stable object that calls the latest handlers
  const keysRef = useRef<EditKeys | null>(null);
  const [stableKeys] = useState<EditKeys>(() => ({
    commit: (text, opts) => keysRef.current?.commit(text, opts),
    cancel: () => keysRef.current?.cancel(),
  }));
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
        const ni = index.get(next);
        if (ni !== undefined) {
          beginEdit(ni, ni);
          showRow(rowOf[ni]);
        }
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
  useLayoutEffect(() => {
    keysRef.current = editKeys;
  });

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
      cut: () => toggleCut(),
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
    // UX10: a pause or take chip brings its footage back
    const chipEl = el.closest<HTMLElement>("[data-chip]");
    if (chipEl) {
      const [at, k] = (chipEl.dataset.chip ?? "").split(":").map(Number);
      const chip = marks.chips.get(at)?.[k];
      if (chip) restoreChip(chip);
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
    // a struck word: back into the video (⇧-click still selects)
    if (removed[i] === 1 && !e.shiftKey) {
      if (p.cuts.restoreWord(words[i])) setSel({ a: words[i].id, f: words[i].id });
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
    // words inside a take chip aren't on screen: skip them
    const move = (j: number, dir: 1 | -1 = j >= i ? 1 : -1) => {
      let k = Math.max(0, Math.min(words.length - 1, j));
      while (removed[k] === 2 && k + dir >= 0 && k + dir < words.length) k += dir;
      if (removed[k] !== 2) selectWord(k, e.shiftKey, true);
    };
    switch (e.key) {
      case "ArrowRight":
        move(i + 1);
        break;
      case "ArrowLeft":
        move(i - 1);
        break;
      case "Backspace":
      case "Delete":
        // ⌫ cuts the selection from the video (or brings it back)
        if (!selRange || i < selRange[0] || i > selRange[1]) setSel({ a: words[i].id, f: words[i].id });
        if (selRange && i >= selRange[0] && i <= selRange[1]) toggleCut();
        else if (removed[i] === 0) p.cuts.cutWords(words, i, i);
        else p.cuts.restoreWord(words[i]);
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

  const items = v.getVirtualItems();
  const time = (i: number) => fmtClock(cutTimeOfSource(p.editSegs, words[i].start));
  const captionsOff = preset === "none";
  // UX10 (review E3): "Show" — the text scrolls to the first take's chip
  // (before the first word from its start on), the playhead to its cut
  const showTake = () => {
    const first = takes[0];
    if (!first || !words.length) return;
    let at = 0;
    while (at < words.length - 1 && (words[at].start + words[at].end) / 2 < first.start) at++;
    showRow(rowOf[at]);
    p.seekCut(cutTimeOfSource(p.editSegs, first.start));
  };
  return (
    <div ref={rootRef} className={s.ted} data-testid="ed-text">
      <CutsHeader
        phone={phone}
        editSegs={p.editSegs}
        duration={p.duration}
        cuts={p.cuts}
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
          {takes.length > 0 && (
            // UX10 (review E3): what Cleo cut, by name
            <div className={s.note} data-testid="ed-cleo-cut">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-cleo)", flexShrink: 0 }} />
              <span>{plural(t, lang, "editor.cuts.cleoOne", "editor.cuts.cleoOther", takes.length)}</span>
              <span aria-hidden>·</span>
              <button type="button" className={s.linkBtn} data-testid="ed-cleo-show" onClick={showTake}>
                {t("editor.cuts.showTake")}
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
              const selHere = touches(selRange);
              return (
                <WordRow
                  key={it.key}
                  rowIndex={it.index}
                  first={r.first}
                  words={rowWords[it.index]}
                  time={time(r.first)}
                  selA={selHere ? selHere[0] : -1}
                  selB={selHere ? selHere[1] : -1}
                  focus={focusIdx >= r.first && focusIdx <= r.last ? focusIdx : sel === null && it.index === items[0]?.index ? r.first : -1}
                  hits={hits}
                  marks={rowMarks(it.index)}
                  dec={dec}
                  edit={
                    !phone && touches(editRange_)
                      ? { first: editRange_![0], last: editRange_![1], draft, onDraft: setDraft, takeFresh, serial: editSerial }
                      : null
                  }
                  editKeys={stableKeys}
                  start={it.start - notesH}
                  measure={v.measureElement}
                  adjusted={!!p.adjusted?.size && words.slice(r.first, r.last + 1).some((w) => p.adjusted!.has(w.id))}
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
          removed={selRemoved}
          onCut={toggleCut}
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
          removed={selRemoved}
          onCut={toggleCut}
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
              // Enter that confirms an IME conversion must not submit
              if (composing(e) && e.key === "Enter") {
                e.preventDefault();
                return;
              }
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
