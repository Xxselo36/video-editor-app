"use client";
/**
 * The v2 editor's edit document (UX8): GET /jobs/{id}/doc
 * (state/docFetch.ts), the store with its undo history, and the
 * autosave (state/docSave.ts).
 *
 *   loading   the request runs (the Text tab shows a skeleton)
 *   none      no doc: a job analysed before UT3 (404 no_doc) or the
 *             request failed — the Text tab falls back to the sentence
 *             transcript of UX7 (v1 semantics, /phrases autosave)
 *   ready     store + autosave; `conflict` after a 409 stale_rev
 *
 * Every doc change hands the caption source (state/doc.ts
 * captionSource: units and sentences without hidden words) to the
 * editor page, which feeds the preview and — until UT4 renders from the
 * doc — the render payload and the legacy /phrases save.
 *
 * Changes the server doesn't have stay on this device
 * (session/unsavedDoc.ts, journeys-2): written when a save turns
 * retrying, failed or conflict, when the editor closes with some unsent
 * (before reopening or the Vorschau's Fertigstellen go on, pendingSaves)
 * and when the page hides or goes away; dropped once the server has
 * everything. On load the copy of the last visit is decided against the
 * server's doc: back by itself as one undo step ("restored"), or the
 * server moved on and its doc stays ("moved"); the editor says which.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { trackSave } from "@/lib/pendingSaves";
import { followCaptionKeys } from "@/features/captions-ui/adjusted";
import { applyDocCopy, decideDocCopy, docCopyOf, readDocCopy, writeDocCopy } from "@/features/editor/session/unsavedDoc";
import {
  captionSource,
  editWord,
  wordTokens,
  type CaptionPhrase,
  type CaptionUnit,
  type EditDoc,
  type IdPool,
} from "@/features/editor/state/doc";
import { fetchDoc, withRenderStyle, type DocCaptions } from "@/features/editor/state/docFetch";
import { DocSaver, rebaseDoc, uniqueRev, type DocSaveState } from "@/features/editor/state/docSave";
import { reconcileV1, type V1Edits } from "@/features/editor/state/reconcile";
import { createDocStore, type DocStore } from "@/features/editor/state/store";
import { takePending, type CaptionStyleDefault } from "@/features/start/captionDefault";

export type CaptionSourceHandler = (phrases: CaptionPhrase[], units: CaptionUnit[], edited: boolean) => void;

export type DocSession =
  | { status: "loading" }
  | { status: "none" }
  | {
      status: "ready";
      store: DocStore;
      pool: IdPool;
      saveState: DocSaveState;
      readOnly: boolean;
      /** Retry a failed save now. */
      retry: () => void;
      /** Load the server's doc (after a conflict); local changes are dropped. */
      reload: () => Promise<void>;
      /** Another tab or device saved (the timeline's 409): bring the doc in line, keeping every local edit (see sync). */
      sync: () => Promise<DocSync>;
      /** Send what's pending now (before an export: the render reads the doc's style). */
      flush: () => Promise<boolean>;
      /** UT5: what the caption layer and the Style panel need (GET /jobs/{id}/doc). */
      captions: DocCaptions;
      /** Backlog #20: transcribe a span the doc has no words for (useSpanFill). */
      transcribeSpan: (start: number, end: number) => Promise<SpanResult>;
      /** What became of the doc changes this device kept from its last
       *  visit (session/unsavedDoc.ts): back as one undo step, or the
       *  server's newer doc stayed; null: none. For the editor to say (once). */
      copy: DocCopyOutcome;
    };

export type DocCopyOutcome = "restored" | "moved" | null;

/**
 * words: the span got words; empty: Whisper heard none there; error:
 * failed (a retry chip); { later }: not now, nothing failed — the rate
 * limit (429, its Retry-After), another span of the job running (409
 * busy) or a save waiting for its retry: ask again after `later` ms.
 */
export type SpanResult = "words" | "empty" | "error" | { later: number };

/** The wait a 429 / 409 busy asks for (Retry-After, seconds), in ms. */
export function retryAfterMs(r: Pick<Response, "headers">, fallbackS: number): number {
  const s = Number(r.headers.get("Retry-After"));
  return Math.round(Math.min(120, Math.max(1, Number.isFinite(s) && s > 0 ? s : fallbackS)) * 1000);
}

/**
 * After another tab or device saved (round 3): "kept" — this device's doc
 * edits are on the server and nothing else changed there (its rev is
 * ours), so nothing was reloaded; "merged" — the other device changed the
 * doc too: its doc came in with this device's unsaved edits (if any) on
 * top (saved next); "pending" — not through yet (offline, refused): the
 * autosave keeps them and goes on.
 */
export type DocSync = "kept" | "merged" | "pending";

/** A save still waiting for its retry (DocSaver.exclusive "busy"): ask again in this long. */
const SAVER_BUSY_MS = 3000;

const NO_CAPTIONS: DocCaptions = { engine: "v1", presetsLive: null, recommended: [] };

type Loaded = {
  store: DocStore;
  saver: DocSaver;
  pool: IdPool;
  readOnly: boolean;
  captions: DocCaptions;
  copy: DocCopyOutcome;
};

/**
 * `doc` with the saved caption style (start/captionDefault.ts) of a new
 * project: its preset and look; the captions' own positions stay.
 */
function withPendingStyle(doc: EditDoc, style: CaptionStyleDefault, live: string[] | null): EditDoc {
  if (live && !live.includes(style.presetId) && style.presetId !== "none") return doc;
  const own = (doc.style.overrides as { captions?: unknown } | undefined)?.captions;
  const next = { presetId: style.presetId, overrides: { ...style.overrides, ...(own ? { captions: own } : {}) } };
  return JSON.stringify(next) === JSON.stringify(doc.style) ? doc : { ...doc, style: next as EditDoc["style"] };
}

/** A word the server refused was adjusted (its old text). */
export type WordFixedHandler = (text: string) => void;

/** What the server may not have stays on this device (session/unsavedDoc.ts); nothing once it has all. */
function keepCopy(jobId: string, saver: DocSaver): void {
  writeDocCopy(jobId, docCopyOf(saver));
}

export function useDocSession(
  jobId: string,
  onCaptionSource?: CaptionSourceHandler,
  onWordFixed?: WordFixedHandler,
  v1Edits: V1Edits = null,
): DocSession {
  const [loaded, setLoaded] = useState<Loaded | "none" | null>(null);
  const [saveState, setSaveState] = useState<DocSaveState>("saved");
  const captionRef = useRef(onCaptionSource);
  const fixedRef = useRef(onWordFixed);
  // read once, when the doc arrives
  const v1Ref = useRef(v1Edits);
  useEffect(() => {
    captionRef.current = onCaptionSource;
    fixedRef.current = onWordFixed;
  });

  useEffect(() => {
    let live = true;
    let made: Loaded | null = null;
    void fetchDoc(jobId)
      .catch(() => null)
      .then((res) => {
        if (!live) return;
        if (!res) {
          setLoaded("none");
          return;
        }
        const pool: IdPool = new Set(res.doc.words.map((w) => w.id));
        // Newer v1 sentence edits go into the doc (saved below), so
        // opening v2 never reverts or overwrites them (state/reconcile.ts).
        // A caption's own position / size follows its first word (UT5), as after any text edit.
        const fromV1 = reconcileV1(res.doc, res.rev, v1Ref.current, pool);
        const reconciled = fromV1 === res.doc ? res.doc : followCaptionKeys(res.doc, fromV1);
        // A new project made with the saved caption style whose PATCH
        // didn't get through: the style now, unless someone edited it.
        const shown = withRenderStyle(reconciled, res.renderStyle);
        const pending = takePending(jobId);
        const start = res.rev === 0 && pending ? withPendingStyle(shown, pending, res.captions.presetsLive) : shown;
        const store = createDocStore(start);
        const saver: DocSaver = new DocSaver(res.doc, res.rev, {
          jobId,
          fetch: apiFetch,
          pool,
          onState: (s) => {
            setSaveState(s);
            // the device copy when a save didn't get through; gone once all is saved
            if (s === "retrying" || s === "failed" || s === "conflict") keepCopy(jobId, saver);
            else if (s === "saved" && !saver.dirty) writeDocCopy(jobId, null);
          },
          onRename: (map) => store.rename(map),
          // The server refused a word: cut it to what it accepts (or drop
          // it when it already looks valid) and tell the user.
          onRejected: (id) => {
            const w = store.getState().present.words.find((x) => x.id === id);
            if (!w) return;
            const fixed = wordTokens(w.text).join(" ");
            store.apply((d) => editWord(d, id, fixed === w.text ? "" : fixed, pool));
            fixedRef.current?.(w.text.length > 40 ? `${[...w.text].slice(0, 40).join("")}…` : w.text);
          },
          track: (p) => trackSave(jobId, p),
        });
        store.onEdit = (doc) => {
          saver.schedule(doc);
          const src = captionSource(doc.words);
          captionRef.current?.(src.phrases, src.units, true);
        };
        if (reconciled !== res.doc || start !== shown) saver.schedule(store.getState().present);
        const src = captionSource(start.words);
        captionRef.current?.(src.phrases, src.units, false);
        // Changes this device kept from its last visit (session/unsavedDoc.ts):
        // the server has them (the copy goes), nobody saved since (back by
        // themselves, one undo step, saved with the next save), or the
        // server moved on (its doc stays; the copy goes).
        let copy: DocCopyOutcome = null;
        const kept = res.read_only ? null : readDocCopy(jobId);
        if (kept) {
          const decided = decideDocCopy(kept, { doc: res.doc, rev: res.rev });
          if (decided.kind !== "auto") writeDocCopy(jobId, null);
          if (decided.kind === "moved") copy = "moved";
          else if (decided.kind === "auto") {
            const restore = (d: EditDoc) => {
              const n = applyDocCopy(d, decided.copy);
              return n === d ? d : followCaptionKeys(d, n);
            };
            if (store.apply(restore)) copy = "restored";
            // already in the doc shown (a v1 sentence save, its style):
            // saved as it is, then the copy goes
            else saver.schedule(store.getState().present);
          }
        }
        made = { store, saver, pool, readOnly: res.read_only, captions: res.captions, copy };
        setLoaded(made);
      });
    return () => {
      live = false;
      // Leaving the editor (back, a link): the last edit goes now, with
      // a few retries, then this saver stops; re-entering the job waits
      // for it (pendingSaves), so no stale saver races the next session.
      // What still didn't get through stays on this device before that
      // wait ends (the Vorschau's Fertigstellen reads it then).
      if (made) {
        const { saver } = made;
        made.store.onEdit = null;
        trackSave(jobId, saver.close().finally(() => keepCopy(jobId, saver)));
      }
    };
  }, [jobId]);

  // The page goes away: one keepalive PATCH. Hidden (iOS fires no
  // pagehide on an app switch, and may discard the tab): send now. Back
  // online: send now.
  // Either may never be answered (a closed tab, a discarded one): what it
  // carries stays on this device until the next open finds it stored.
  useEffect(() => {
    if (!loaded || loaded === "none") return;
    const { saver } = loaded;
    const onHide = () => {
      saver.flushUnload();
      keepCopy(jobId, saver);
    };
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      saver.flushHidden();
      keepCopy(jobId, saver);
    };
    const onOnline = () => void saver.flush();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("freeze", onHidden);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("freeze", onHidden);
      window.removeEventListener("online", onOnline);
    };
  }, [jobId, loaded]);

  const retry = useCallback(() => {
    if (loaded && loaded !== "none") void loaded.saver.flush();
  }, [loaded]);

  const reload = useCallback(async () => {
    if (!loaded || loaded === "none") return;
    const res = await fetchDoc(jobId).catch(() => null);
    if (!res) return;
    loaded.store.reset(withRenderStyle(res.doc, res.renderStyle));
    loaded.saver.reset(res.doc, res.rev);
    for (const w of res.doc.words) loaded.pool.add(w.id);
    const src = captionSource(res.doc.words);
    captionRef.current?.(src.phrases, src.units, false);
  }, [jobId, loaded]);

  const sync = useCallback(async (): Promise<DocSync> => {
    if (!loaded || loaded === "none" || loaded.readOnly) return "kept";
    const { saver, store, pool } = loaded;
    // this device's edits first, on the doc's own rev rule
    const saved = await saver.settle(2);
    if (!saved && saver.status !== "conflict") return "pending";
    // The server's doc now. Saved with nothing of ours pending, nothing
    // was sent: the other device may have changed the doc too, and only
    // this device's next text edit would find out (a 409 — that edit
    // lost on the reload it offers). Its rev tells.
    const res = await fetchDoc(jobId).catch(() => null);
    if (!res) return saved ? "kept" : "pending";
    if (saved && res.rev === saver.rev) return "kept";
    // the other device changed the doc too: theirs, with ours on top
    const merged = rebaseDoc(saver.known, store.getState().present, res.doc, pool);
    for (const w of res.doc.words) pool.add(w.id);
    // (the undo steps were made on a doc the server no longer has)
    store.reset(merged);
    saver.reset(res.doc, res.rev);
    saver.schedule(merged);
    const src = captionSource(merged.words);
    captionRef.current?.(src.phrases, src.units, true);
    return "merged";
  }, [jobId, loaded]);

  const transcribeSpan = useCallback(
    async (start: number, end: number): Promise<SpanResult> => {
      if (!loaded || loaded === "none" || loaded.readOnly) return "error";
      const { saver, store, pool } = loaded;
      const out = await saver
        .exclusive(async (base): Promise<SpanResult> => {
          const r = await apiFetch(`/jobs/${jobId}/transcribe-span`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start, end, base_rev: base, rev: uniqueRev(base) }),
          });
          if (r.status === 429) return { later: retryAfterMs(r, 30) };
          if (r.status === 409) {
            const detail = ((await r.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
            if (detail === "busy") return { later: retryAfterMs(r, 5) };
            return "error";
          }
          if (!r.ok) return "error";
          const j = (await r.json()) as { words?: unknown; rev?: unknown; changed?: unknown };
          const words = (Array.isArray(j.words) ? j.words : []).filter(
            (w): w is EditDoc["words"][number] =>
              !!w && typeof w === "object" && typeof (w as { id?: unknown }).id === "string",
          );
          const rev = j.changed === true && typeof j.rev === "number" ? j.rev : null;
          saver.adopt(words, rev);
          for (const w of words) pool.add(w.id);
          store.addWords(words);
          if (words.length) {
            const src = captionSource(store.getState().present.words);
            captionRef.current?.(src.phrases, src.units, true);
          }
          return words.length ? "words" : "empty";
        })
        .catch((): SpanResult => "error");
      if (out === "busy") return { later: SAVER_BUSY_MS };
      return out ?? "error";
    },
    [jobId, loaded],
  );

  /** True when the server has every change (DocSaver.settle). */
  const flush = useCallback(async () => {
    if (!loaded || loaded === "none") return true;
    return loaded.saver.settle();
  }, [loaded]);

  if (loaded === null) return { status: "loading" };
  if (loaded === "none") return { status: "none" };
  return {
    status: "ready",
    store: loaded.store,
    pool: loaded.pool,
    saveState,
    readOnly: loaded.readOnly,
    retry,
    reload,
    sync,
    flush,
    captions: loaded.captions ?? NO_CAPTIONS,
    transcribeSpan,
    copy: loaded.copy,
  };
}
