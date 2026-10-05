"use client";
/**
 * The v2 editor's edit document (UX8): GET /jobs/{id}/doc, the store
 * with its undo history, and the autosave (state/docSave.ts).
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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { trackSave } from "@/lib/pendingSaves";
import {
  captionSource,
  editWord,
  wordTokens,
  type CaptionPhrase,
  type CaptionUnit,
  type EditDoc,
  type IdPool,
} from "@/features/editor/state/doc";
import { DocSaver, uniqueRev, type DocSaveState } from "@/features/editor/state/docSave";
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
      /** Send what's pending now (before an export: the render reads the doc's style). */
      flush: () => Promise<boolean>;
      /** UT5: what the caption layer and the Style panel need (GET /jobs/{id}/doc). */
      captions: DocCaptions;
      /** Backlog #20: transcribe a span the doc has no words for (useSpanFill). */
      transcribeSpan: (start: number, end: number) => Promise<SpanResult>;
    };

/** words: the span got words; empty: Whisper heard none there; error: try again later. */
export type SpanResult = "words" | "empty" | "error";

/**
 * UT5 (GET /jobs/{id}/doc): `engine` — the export's caption engine
 * ("optin": the browser's ?captions=v2 decides); `presetsLive` — the
 * presets the Style panel offers; `recommended` — up to three for this
 * transcript. The doc's style starts as the server's `render_style`
 * (what an export draws now: before the first editor save, a v1
 * caption preset decides).
 */
export type DocCaptions = { engine: "v1" | "v2" | "optin"; presetsLive: string[] | null; recommended: string[] };

const NO_CAPTIONS: DocCaptions = { engine: "v1", presetsLive: null, recommended: [] };

function docCaptions(j: Record<string, unknown>): DocCaptions {
  const e = j.caption_engine;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  return {
    engine: e === "v2" || e === "optin" ? e : "v1",
    presetsLive: strings(j.presets_live),
    recommended: strings(j.recommended) ?? [],
  };
}

const isStyle = (v: unknown): v is EditDoc["style"] =>
  !!v && typeof v === "object" && typeof (v as { presetId?: unknown }).presetId === "string";

type Loaded = { store: DocStore; saver: DocSaver; pool: IdPool; readOnly: boolean; captions: DocCaptions };

type Fetched = { doc: EditDoc; rev: number; read_only: boolean; captions: DocCaptions; renderStyle: EditDoc["style"] | null };

async function fetchDoc(jobId: string): Promise<Fetched | null> {
  const r = await apiFetch(`/jobs/${jobId}/doc`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.doc || !Array.isArray(j.doc.words)) return null;
  const captions = docCaptions(j);
  // Only a live style: the first save sends it, and PATCH refuses others.
  const renderStyle =
    isStyle(j.render_style) && (!captions.presetsLive || captions.presetsLive.includes(j.render_style.presetId))
      ? j.render_style
      : null;
  return {
    doc: j.doc as EditDoc,
    rev: typeof j.rev === "number" ? j.rev : 0,
    read_only: !!j.read_only,
    captions,
    renderStyle,
  };
}

/**
 * The doc as the editor shows it (UT5): with the style an export draws now
 * — before the first editor save that can be a v1 caption preset's look,
 * not yet the doc's own style. Saved with the next edit.
 */
function withRenderStyle(doc: EditDoc, style: EditDoc["style"] | null): EditDoc {
  return style && JSON.stringify(style) !== JSON.stringify(doc.style) ? { ...doc, style } : doc;
}

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
        const reconciled = reconcileV1(res.doc, res.rev, v1Ref.current, pool);
        // A new project made with the saved caption style whose PATCH
        // didn't get through: the style now, unless someone edited it.
        const shown = withRenderStyle(reconciled, res.renderStyle);
        const pending = takePending(jobId);
        const start = res.rev === 0 && pending ? withPendingStyle(shown, pending, res.captions.presetsLive) : shown;
        const store = createDocStore(start);
        const saver = new DocSaver(res.doc, res.rev, {
          jobId,
          fetch: apiFetch,
          pool,
          onState: setSaveState,
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
        made = { store, saver, pool, readOnly: res.read_only, captions: res.captions };
        setLoaded(made);
      });
    return () => {
      live = false;
      // Leaving the editor (back, a link): the last edit goes now, with
      // a few retries, then this saver stops; re-entering the job waits
      // for it (pendingSaves), so no stale saver races the next session.
      if (made) {
        made.store.onEdit = null;
        trackSave(jobId, made.saver.close());
      }
    };
  }, [jobId]);

  // The page goes away: one keepalive PATCH. Back online: send now.
  useEffect(() => {
    if (!loaded || loaded === "none") return;
    const { saver } = loaded;
    const onHide = () => saver.flushUnload();
    const onOnline = () => void saver.flush();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("online", onOnline);
    };
  }, [loaded]);

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
    flush,
    captions: loaded.captions ?? NO_CAPTIONS,
    transcribeSpan,
  };
}
