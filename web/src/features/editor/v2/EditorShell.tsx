"use client";
/**
 * Editor shell v2 (UX7a, behind NEXT_PUBLIC_EDITOR_V2): one 100dvh
 * screen, no page scroll.
 *   desktop  top bar 52 · stage + side panel (380, 340 below 1366 px) ·
 *            timeline dock 150; no resizable panels (review G3)
 *   < 900 px top bar 44 · stage (186×330 preview + player row) · dock ·
 *            two bottom tabs opening sheets
 * Same job data and the same session code as the v1 ReviewScreen
 * (useEditSession); the playhead store feeds everything that moves while
 * playing, so the shell itself doesn't re-render per frame.
 */
import { Captions, Palette, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n";
import { apiFetch } from "@/lib/api";
import type { Phrase, Subtitle } from "@/features/editor/legacy/buildPhrases";
import { useEditSession } from "@/features/editor/session/useEditSession";
import { useEditorShortcuts, type ShortcutHandlers } from "@/features/editor/shortcuts/useEditorShortcuts";
import { createPlayheadStore, PlayheadContext } from "@/features/editor/state/playhead";
import type { EditDoc } from "@/features/editor/state/doc";
import type { V1Edits } from "@/features/editor/state/reconcile";
import { createDocStore, useDocStore, type DocState } from "@/features/editor/state/store";
import { useTimelineHistory, type TimelineHistory } from "@/features/editor/timeline/history";
import {
  canDelete,
  playheadCutOf,
  sourceAtCut,
  splitAt,
  splittableIndex,
} from "@/features/editor/timeline/mechanics";
import type { CutRange, SavedSeg } from "@/features/jobs/types";
import { useEditorRoot, useOnline } from "./hooks";
import { EditOrder, type Area } from "./editOrder";
import { cutDuration } from "./model";
import { BottomSheet } from "./panel/BottomSheet";
import { StylePanel } from "./panel/StylePanel";
import { TranscriptEditor, type TextApi } from "./panel/text/TranscriptEditor";
import { TranscriptPanel } from "./panel/TranscriptPanel";
import { PreviewStage } from "./preview/PreviewStage";
import { ExpiredView } from "./states";
import { useDocSession, type CaptionSourceHandler } from "./useDocSession";
import { TimelineDock, type DockApi } from "./timeline/TimelineDock";
import { TopBar, UndoRedo } from "./topbar/TopBar";
import { useFirstRun } from "./tour/firstRun";
import { Tour } from "./tour/Tour";
import s from "./editor.module.css";

export type EditorShellProps = {
  jobId: string;
  filename: string | null | undefined;
  savedSegments: SavedSeg[];
  previewSegments: [number, number][];
  previewVersion: number;
  hasProxy: boolean | undefined;
  phrases: Phrase[];
  units: { readonly current: Subtitle[] };
  captionPreset: string;
  audioWarnings: string[];
  cutRanges: CutRange[];
  duration: number;
  onChange: (p: Phrase[]) => void;
  /** UX8: the caption source of the edit document (preview, render
   *  payload and — after an edit — the legacy /phrases save). */
  onCaptionSource?: CaptionSourceHandler;
  /** v1 sentence edits (/phrases) and their save time: applied to the
   *  doc when newer than it (state/reconcile.ts). */
  v1Edits?: V1Edits;
  onApply: () => void;
  onBack: () => void;
};

const selCanUndo = (st: DocState) => st.past.length > 0;
const selCanRedo = (st: DocState) => st.future.length > 0;
const NO_DOC_STATE = (): boolean => false;
/** Read while the doc loads (hooks can't be skipped). */
const EMPTY_STORE = createDocStore({
  v: 2,
  language: null,
  words: [],
  clips: null,
  style: { presetId: "none", overrides: {} },
  format: { aspect: "9:16" },
  rev: 0,
});

const TITLE_KEY = (id: string) => `cleocuts.editor.title.${id}`;

function initialTitle(jobId: string, filename: string | null | undefined): string {
  try {
    const stored = localStorage.getItem(TITLE_KEY(jobId));
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  const base = (filename ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim();
  return base || "Video";
}

type ToastState = { msg: string; action?: { label: string; run: () => void }; key: number } | null;

export function EditorShell(props: EditorShellProps & { phone: boolean; onSheetChange: (open: boolean) => void }) {
  const t = useT();
  const { phone } = props;
  const root = useEditorRoot();
  const session = useEditSession({
    jobId: props.jobId,
    savedSegments: props.savedSegments,
    previewSegments: props.previewSegments,
    previewVersion: props.previewVersion,
    hasProxy: props.hasProxy,
    cutRanges: props.cutRanges,
    duration: props.duration,
    onApply: props.onApply,
  });
  const { editSegs, toSource, videoRef } = session;

  // ── playhead store, fed by the video's presented frames ─────────────
  const store = useMemo(() => createPlayheadStore(), []);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    return store.attach(v);
  }, [store, videoRef]);

  // ── toast ───────────────────────────────────────────────────────────
  const [toast, setToast] = useState<ToastState>(null);
  const showToast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setToast({ msg, action, key: Date.now() });
  }, []);
  const tlHistory = useTimelineHistory(editSegs, session.commitEditSegs);
  const doc = useDocSession(
    props.jobId,
    props.onCaptionSource,
    (word) => showToast(t("editor.save.wordFixed", { word })),
    props.v1Edits ?? null,
  );
  const docStore = doc.status === "ready" ? doc.store : null;

  // ── one undo for text and timeline (until UX10 merges the stacks):
  // ⌘Z undoes the latest edit of either, in the order they were made.
  const order = useMemo(() => new EditOrder(), []);
  const docCanUndo = useDocStore(docStore ?? EMPTY_STORE, docStore ? selCanUndo : NO_DOC_STATE);
  const docCanRedo = useDocStore(docStore ?? EMPTY_STORE, docStore ? selCanRedo : NO_DOC_STATE);
  const history: TimelineHistory = {
    ...tlHistory,
    commit: (next, coalesce) => {
      // a coalesced slider drag is one step: recorded once
      const added = tlHistory.commit(next, coalesce);
      if (added) order.record("tl");
      return added;
    },
    undo: () => stepHistory("undo"),
    redo: () => stepHistory("redo"),
    canUndo: tlHistory.canUndo || docCanUndo,
    canRedo: tlHistory.canRedo || docCanRedo,
  };
  const applyDoc = useCallback(
    (op: (d: EditDoc) => EditDoc) => {
      if (!docStore?.apply(op)) return false;
      order.record("doc");
      return true;
    },
    [docStore, order],
  );
  function stepHistory(kind: "undo" | "redo") {
    const can = (a: Area) =>
      a === "doc"
        ? !!docStore && (kind === "undo" ? docStore.getState().past.length : docStore.getState().future.length) > 0
        : kind === "undo"
          ? tlHistory.canUndo
          : tlHistory.canRedo;
    const area = order.take(kind, can);
    if (!area) return;
    if (area === "tl") (kind === "undo" ? tlHistory.undo : tlHistory.redo)();
    else if (kind === "undo") docStore!.undo();
    else docStore!.redo();
  }
  const [selected, setSelected] = useState<string | null>(null);
  const selectedLive = selected && editSegs.some((x) => x.id === selected) ? selected : null;

  // ── title (local until PATCH /jobs/{id} {title} exists) ─────────────
  // TODO(UX7 backend): PATCH /jobs/{id} {title}; kept in localStorage per job.
  const [title, setTitle] = useState(() => initialTitle(props.jobId, props.filename));
  const rename = (v: string) => {
    setTitle(v);
    try {
      localStorage.setItem(TITLE_KEY(props.jobId), v);
    } catch {
      /* ignore */
    }
  };

  // ── panels ──────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"text" | "style">("text");
  const [sheetState, setSheetState] = useState<"text" | "style" | null>(null);
  // Sheets exist on the phone layout only (a resize to desktop drops one).
  const sheet = phone ? sheetState : null;
  const { onSheetChange } = props;
  const setSheet = useCallback(
    (v: "text" | "style" | null) => {
      setSheetState(v);
      onSheetChange(v !== null);
    },
    [onSheetChange],
  );
  const [findOpen, setFindOpen] = useState(false);
  const textTabRef = useRef<HTMLButtonElement>(null);
  const styleTabRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const dockApi = useRef<DockApi | null>(null);
  const textApi = useRef<TextApi | null>(null);
  const fullscreenRef = useRef<(() => void) | null>(null);

  // ── toast ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.action ? 6000 : 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // ── states: offline, expired ────────────────────────────────────────
  const online = useOnline();
  const [expired, setExpired] = useState(false);
  const [conflictClosed, setConflictClosed] = useState(false);
  useEffect(() => {
    if (session.saveError !== "failed") return;
    let live = true;
    void apiFetch(`/jobs/${props.jobId}`)
      .then((r) => {
        if (live && (r.status === 404 || r.status === 410)) setExpired(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session.saveError, props.jobId]);

  // ── actions ─────────────────────────────────────────────────────────
  const split = () => {
    const at = toSource(store.getState().mediaTime);
    const idx = splittableIndex(editSegs, at);
    if (idx === -1) {
      showToast(t("app.timeline.splitUnavailable"));
      return;
    }
    history.commit(splitAt(editSegs, idx, at));
  };
  const del = () => {
    if (!selectedLive) return false;
    if (!canDelete(editSegs, selectedLive)) return true;
    history.commit(editSegs.filter((x) => x.id !== selectedLive));
    setSelected(null);
  };
  const stepBy = (d: number) => {
    const segId = session.mode === "proxy" ? session.playingSegId : null;
    const cut = playheadCutOf(editSegs, toSource(store.getState().mediaTime), segId) ?? 0;
    const at = sourceAtCut(editSegs, Math.max(0, Math.min(cutDuration(editSegs) - 0.001, cut + d)));
    if (at) session.seekOriginal(at.t, at.segId);
  };
  const lineBy = (dir: 1 | -1) => {
    const src = toSource(store.getState().mediaTime);
    const ps = props.phrases;
    if (!ps.length) return;
    const p =
      dir > 0
        ? ps.find((x) => x.original_start > src + 0.05)
        : [...ps].reverse().find((x) => x.original_start < src - 0.3);
    if (p) session.seekToPhrase(p, false);
  };
  const exportNow = () => {
    if (!online || session.applying) return;
    void session.apply();
  };
  const openFind = () => {
    if (phone) setSheet("text");
    else setTab("text");
    setFindOpen(true);
  };
  const first = useFirstRun();
  const handlers: ShortcutHandlers = {
    playPause: session.togglePlay,
    stepBack: () => stepBy(-0.1),
    stepForward: () => stepBy(0.1),
    stepBackLong: () => stepBy(-1),
    stepForwardLong: () => stepBy(1),
    prevLine: () => lineBy(-1),
    nextLine: () => lineBy(1),
    split,
    delete: del,
    // UX8: Enter / H act on the selected words (focus outside the list)
    edit: () => textApi.current?.edit() ?? false,
    hide: () => textApi.current?.hide() ?? false,
    escape: () => {
      if (findOpen) setFindOpen(false);
      else if (textApi.current?.escape()) return;
      else if (selectedLive) setSelected(null);
      else return false;
    },
    undo: history.undo,
    redo: history.redo,
    find: openFind,
    zoomIn: () => dockApi.current?.zoomIn(),
    zoomOut: () => dockApi.current?.zoomOut(),
    zoomFit: () => dockApi.current?.fit(),
    export: exportNow,
    mute: session.toggleMute,
    fullscreen: () => fullscreenRef.current?.(),
  };
  // While the find bar is open, single keys belong to it (and to typing),
  // wherever focus went: only ⌘ combos and Escape stay.
  const active: ShortcutHandlers = findOpen
    ? { escape: handlers.escape, undo: handlers.undo, redo: handlers.redo, find: handlers.find, export: handlers.export }
    : handlers;
  useEditorShortcuts(active, first.tourStep === null && !expired);

  const seekCut = (cut: number) => {
    const at = sourceAtCut(editSegs, cut);
    if (at) session.seekOriginal(at.t, at.segId);
  };

  if (expired) return <ExpiredView onBack={props.onBack} />;

  const docSave = doc.status === "ready" ? doc.saveState : "saved";
  // 409 stale_rev (review F3): another tab or device saved this project.
  // The autosave stopped; nothing is overwritten until a reload.
  const conflict =
    docSave === "conflict" && !conflictClosed ? (
      <div className={s.banner} role="alert" data-testid="ed-conflict">
        <TriangleAlert size={16} strokeWidth={1.75} className={s.bannerIcon} aria-hidden />
        <span style={{ flex: 1 }}>{t("editor.conflict.text")}</span>
        <button
          type="button"
          className={`${s.gb} ${s.toastAction}`}
          onClick={() => {
            if (doc.status === "ready") void doc.reload();
          }}
          data-testid="ed-conflict-reload"
        >
          {t("editor.conflict.reload")}
        </button>
        <button type="button" className={`${s.gb} ${s.sm}`} aria-label={t("editor.close")} onClick={() => setConflictClosed(true)}>
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    ) : null;

  const chooseStyle = () => {
    if (phone) setSheet("style");
    else setTab("style");
  };
  const transcript =
    doc.status === "ready" ? (
      <TranscriptEditor
        phone={phone}
        doc={doc.store}
        pool={doc.pool}
        apply={applyDoc}
        playhead={store}
        editSegs={editSegs}
        duration={props.duration}
        toSource={toSource}
        seekRange={(start, end) => session.seekToPhrase({ original_start: start, original_end: end }, false)}
        seekCut={seekCut}
        findOpen={findOpen}
        setFindOpen={setFindOpen}
        hint={first.hint}
        onHintClose={first.closeHint}
        onChooseStyle={chooseStyle}
        onPlayPause={session.togglePlay}
        apiRef={textApi}
        toast={showToast}
      />
    ) : doc.status === "loading" ? (
      <div className={s.empty} role="status" data-testid="ed-text-loading">
        {t("editor.text.loading")}
      </div>
    ) : (
      // A job from before the edit document (UT3): the sentence transcript.
      <TranscriptPanel
        phone={phone}
        store={store}
        phrases={props.phrases}
        onChange={props.onChange}
        editSegs={editSegs}
        duration={props.duration}
        toSource={toSource}
        seekToPhrase={session.seekToPhrase}
        seekCut={seekCut}
        findOpen={findOpen}
        setFindOpen={setFindOpen}
        hint={first.hint}
        onHintClose={first.closeHint}
        toast={showToast}
      />
    );
  const style = <StylePanel captionPreset={props.captionPreset} videoRef={videoRef} />;
  const undoRedo = (
    <UndoRedo
      phone={phone}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      onUndo={history.undo}
      onRedo={history.redo}
    />
  );

  const onTabKey = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? "text" : e.key === "End" ? "style" : tab === "text" ? "style" : "text";
    setTab(next);
    (next === "text" ? textTabRef : styleTabRef).current?.focus();
  };

  return (
    <PlayheadContext.Provider value={store}>
      <TopBar
        phone={phone}
        title={title}
        onRename={rename}
        onBack={props.onBack}
        saving={session.editSaving || docSave === "saving"}
        saveError={
          session.saveError ??
          (docSave === "failed" || docSave === "conflict" ? "failed" : docSave === "retrying" ? "retrying" : null)
        }
        onRetrySave={() => {
          if (session.saveError) session.retrySave();
          if (doc.status !== "ready") return;
          if (docSave === "conflict") void doc.reload();
          else doc.retry();
        }}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={history.undo}
        onRedo={history.redo}
        onExport={exportNow}
        exporting={session.applying}
        offline={!online}
        exportRef={exportRef}
      />
      <PreviewStage
        phone={phone}
        sheetOpen={sheet !== null}
        offline={!online}
        warnings={props.audioWarnings}
        phoneExtra={undoRedo}
        fullscreenRef={fullscreenRef}
        session={session}
        store={store}
        phrases={props.phrases}
        units={props.units}
        captionPreset={props.captionPreset}
        duration={props.duration}
        notice={conflict}
      />
      {!phone && (
        <aside className={s.side} aria-label={t("editor.panel")} data-tour="text" data-testid="ed-sidepanel">
          <div role="tablist" aria-label={t("editor.panel")} className={s.tablist} onKeyDown={onTabKey}>
            <button
              ref={textTabRef}
              type="button"
              role="tab"
              id="ed-tab-text"
              aria-controls="ed-panel"
              aria-selected={tab === "text"}
              tabIndex={tab === "text" ? 0 : -1}
              className={s.tab}
              onClick={() => setTab("text")}
              data-testid="ed-tab-text"
            >
              {t("editor.tab.text")}
              <span className={s.ind} />
            </button>
            <button
              ref={styleTabRef}
              type="button"
              role="tab"
              id="ed-tab-style"
              aria-controls="ed-panel"
              aria-selected={tab === "style"}
              tabIndex={tab === "style" ? 0 : -1}
              className={s.tab}
              onClick={() => setTab("style")}
              data-testid="ed-tab-style"
              data-tour="style"
            >
              {t("editor.tab.style")}
              <span className={s.ind} />
            </button>
          </div>
          <div role="tabpanel" id="ed-panel" aria-labelledby={`ed-tab-${tab}`} className={s.tabpanel}>
            {tab === "text" ? transcript : style}
          </div>
        </aside>
      )}
      <TimelineDock
        phone={phone}
        store={store}
        segments={editSegs}
        duration={props.duration}
        history={history}
        selected={selectedLive}
        setSelected={setSelected}
        toSource={toSource}
        playingSegId={session.playingSegId}
        mode={session.mode}
        seekOriginal={session.seekOriginal}
        onSplit={split}
        onDelete={() => void del()}
        apiRef={dockApi}
      />
      {phone && (
        <nav className={s.tabbar} aria-label={t("editor.panel")} data-testid="ed-tabbar">
          <button
            ref={textTabRef}
            type="button"
            className={s.mtab}
            aria-haspopup="dialog"
            aria-expanded={sheet === "text"}
            onClick={() => setSheet(sheet === "text" ? null : "text")}
            data-testid="ed-tab-text"
            data-tour="text"
          >
            <Captions size={20} strokeWidth={1.75} aria-hidden />
            <span>{t("editor.tab.text")}</span>
          </button>
          <button
            ref={styleTabRef}
            type="button"
            className={s.mtab}
            aria-haspopup="dialog"
            aria-expanded={sheet === "style"}
            onClick={() => setSheet(sheet === "style" ? null : "style")}
            data-testid="ed-tab-style"
            data-tour="style"
          >
            <Palette size={20} strokeWidth={1.75} aria-hidden />
            <span>{t("editor.tab.style")}</span>
          </button>
        </nav>
      )}
      {phone && sheet && (
        <BottomSheet
          key={sheet}
          title={sheet === "text" ? t("editor.tab.text") : t("editor.tab.style")}
          onClose={() => setSheet(null)}
          returnFocus={sheet === "text" ? textTabRef : styleTabRef}
          // The player row with undo / redo is hidden under an open sheet:
          // text edits are undone from the sheet itself (UX8).
          headerExtra={sheet === "text" ? undoRedo : undefined}
          testId={`ed-sheet-${sheet}`}
        >
          {sheet === "text" ? transcript : style}
        </BottomSheet>
      )}
      {session.applyError && !toast && (
        <div className={s.toast} role="alert" data-testid="apply-error" style={phone ? { bottom: 72 } : { bottom: 166 }}>
          <span>{session.applyError}</span>
        </div>
      )}
      {toast && (
        <div key={toast.key} className={s.toast} role="status" data-testid="ed-toast" style={phone ? { bottom: 72 } : { bottom: 166 }}>
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              type="button"
              className={`${s.gb} ${s.toastAction}`}
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {first.tourStep !== null && (
        <Tour root={root} phone={phone} step={first.tourStep} onStep={first.setTourStep} onDone={first.finishTour} />
      )}
    </PlayheadContext.Provider>
  );
}
