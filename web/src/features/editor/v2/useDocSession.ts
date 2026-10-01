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
import { DocSaver, type DocSaveState } from "@/features/editor/state/docSave";
import { reconcileV1, type V1Edits } from "@/features/editor/state/reconcile";
import { createDocStore, type DocStore } from "@/features/editor/state/store";

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
    };

type Loaded = { store: DocStore; saver: DocSaver; pool: IdPool; readOnly: boolean };

async function fetchDoc(jobId: string): Promise<{ doc: EditDoc; rev: number; read_only: boolean } | null> {
  const r = await apiFetch(`/jobs/${jobId}/doc`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.doc || !Array.isArray(j.doc.words)) return null;
  return { doc: j.doc as EditDoc, rev: typeof j.rev === "number" ? j.rev : 0, read_only: !!j.read_only };
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
        const start = reconcileV1(res.doc, res.rev, v1Ref.current, pool);
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
        if (start !== res.doc) saver.schedule(start);
        const src = captionSource(start.words);
        captionRef.current?.(src.phrases, src.units, false);
        made = { store, saver, pool, readOnly: res.read_only };
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
    loaded.store.reset(res.doc);
    loaded.saver.reset(res.doc, res.rev);
    for (const w of res.doc.words) loaded.pool.add(w.id);
    const src = captionSource(res.doc.words);
    captionRef.current?.(src.phrases, src.units, false);
  }, [jobId, loaded]);

  if (loaded === null) return { status: "loading" };
  if (loaded === "none") return { status: "none" };
  return { status: "ready", store: loaded.store, pool: loaded.pool, saveState, readOnly: loaded.readOnly, retry, reload };
}
