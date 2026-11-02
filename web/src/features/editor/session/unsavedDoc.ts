/**
 * Edit document changes the server hasn't acknowledged, kept on this
 * device per job (journeys-2): the doc's twin of the timeline's copy
 * (unsaved.ts, save-11). The doc autosave's session (v2/useDocSession)
 * writes it when it matters, not at every edit: a save turns "retrying",
 * "failed" or "conflict", the editor closes with changes the server
 * doesn't have, the page hides or goes away. It goes once the server
 * has everything. The next open of the job compares it with the
 * server's doc (decideDocCopy):
 *
 *   none   the server has it (or there is none): the copy goes
 *   auto   the server's doc is still at the rev the changes were made on
 *          (or at one only this device sent): they come back by
 *          themselves, one undo step, and are saved
 *   moved  another tab or device saved since: the server's doc stays,
 *          nothing is overwritten, the editor says so; the copy goes
 *
 * The Vorschau and Fertigstellen (features/project/finish.ts) count a
 * copy the server doesn't have as changes unsaved on this device. Kept
 * small: the words changed since the rev it was made on (and the ones a
 * request still out touched, as they are now), the deleted ids, style
 * and format when they changed; never the whole transcript.
 * localStorage can be missing, blocked or full: every access is guarded,
 * and a copy storage refuses (or one too big for it) stays in this
 * document (deviceCopy.ts), where the Vorschau still sees it.
 */
import type { PatchBody } from "@/features/editor/state/docSave";
import {
  diffWords,
  mergeWords,
  sameWord,
  type DocFormat,
  type DocStyle,
  type DocWord,
  type EditDoc,
} from "@/features/editor/state/doc";
import { dropCopy, readCopy, unsavedDocKey, writeCopy } from "./deviceCopy";

export { unsavedDocKey };

export type DocCopy = {
  /** The server rev the changes were made on. */
  base: number;
  /** Revs of this device's requests whose answer never came: the server may be at one of them. */
  known: number[];
  /** Words changed or added since `base`, as this device has them. */
  upsert: DocWord[];
  /** Ids of the words deleted since `base`. */
  delete: string[];
  style?: DocStyle;
  format?: DocFormat;
  at: number;
};

/** A copy older than this no longer counts (a week, as the timeline's). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** A bigger copy isn't stored: the storage is shared with the rest of the
 *  app (a replace-all over a very long transcript). This document keeps it. */
const MAX_CHARS = 1_000_000;

const isWord = (w: unknown): w is DocWord => {
  const x = w as DocWord | null;
  return !!x && typeof x.id === "string" && typeof x.text === "string" && Number.isFinite(x.start) && Number.isFinite(x.end);
};
const isStyle = (s: unknown): s is DocStyle =>
  !!s && typeof (s as DocStyle).presetId === "string" && !!(s as DocStyle).overrides && typeof (s as DocStyle).overrides === "object";
const isFormat = (f: unknown): f is DocFormat => !!f && typeof (f as DocFormat).aspect === "string";

/** A stored copy as text: null when it is unreadable, invalid or too old. */
function parseDocCopy(raw: string, now: number): DocCopy | null {
  try {
    const c = JSON.parse(raw) as Partial<DocCopy> | null;
    if (!c || typeof c.base !== "number" || typeof c.at !== "number" || now - c.at > MAX_AGE_MS) return null;
    if (!Array.isArray(c.upsert) || !c.upsert.every(isWord)) return null;
    if (!Array.isArray(c.delete) || !c.delete.every((id) => typeof id === "string")) return null;
    if ((c.style !== undefined && !isStyle(c.style)) || (c.format !== undefined && !isFormat(c.format))) return null;
    if (!c.upsert.length && !c.delete.length && !c.style && !c.format) return null;
    return {
      base: c.base,
      known: Array.isArray(c.known) ? c.known.filter((r): r is number => typeof r === "number") : [],
      upsert: c.upsert,
      delete: c.delete,
      ...(c.style ? { style: c.style } : {}),
      ...(c.format ? { format: c.format } : {}),
      at: c.at,
    };
  } catch {
    return null;
  }
}

/** The job's copy on this device; null without one, or when it is
 *  unreadable, invalid or too old (such a one goes). */
export function readDocCopy(jobId: string, now = Date.now()): DocCopy | null {
  return readCopy(unsavedDocKey(jobId), (raw) => parseDocCopy(raw, now));
}

/** Keep `c` (null: drop the copy). Storage that refuses it (full,
 *  blocked, too big): this document keeps it, no older one stays stored. */
export function writeDocCopy(jobId: string, c: DocCopy | null): void {
  const text = c ? JSON.stringify(c) : null;
  writeCopy(unsavedDocKey(jobId), text, text === null || text.length <= MAX_CHARS);
}

/** Drop the copy if it is still `c` (a newer one written meanwhile stays). */
export function dropDocCopy(jobId: string, c: DocCopy): void {
  const want = JSON.stringify(c);
  dropCopy(unsavedDocKey(jobId), (raw) => {
    const now = parseDocCopy(raw, c.at);
    return !!now && JSON.stringify(now) === want;
  });
}

/** Key order doesn't matter (the server stores a style it checked). */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canon(o[k])]),
    );
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** What the doc autosave (state/docSave.ts DocSaver) holds. */
export type DocSaverView = {
  /** What the server is known to have. */
  known: { words: readonly DocWord[]; style: DocStyle; format: DocFormat; rev: number };
  /** The doc as this device has it. */
  local: EditDoc;
  /** Requests sent whose answer never came (they may have been stored). */
  unacked: readonly PatchBody[];
};

/** The copy of what the server may not have; null when it has everything. */
export function docCopyOf(s: DocSaverView, now = Date.now()): DocCopy | null {
  const { upsert, delete: del } = diffWords(s.known.words, s.local.words);
  const up = new Map(upsert.map((w) => [w.id, w]));
  const gone = new Set(del);
  let style = !same(s.local.style, s.known.style);
  let format = !same(s.local.format, s.known.format);
  const known: number[] = [];
  if (s.unacked.length) {
    // A request still out may have been stored: what it touched goes as
    // this device has it now (an undo since included).
    const local = new Map(s.local.words.map((w) => [w.id, w]));
    for (const b of s.unacked) {
      known.push(b.rev);
      if (b.style) style = true;
      if (b.format) format = true;
      for (const id of [...(b.words?.upsert ?? []).map((w) => w.id), ...(b.words?.delete ?? [])]) {
        if (up.has(id) || gone.has(id)) continue;
        const w = local.get(id);
        if (w) up.set(id, w);
        else gone.add(id);
      }
    }
  }
  if (!up.size && !gone.size && !style && !format) return null;
  return {
    base: s.known.rev,
    known,
    upsert: [...up.values()],
    delete: [...gone],
    ...(style ? { style: s.local.style } : {}),
    ...(format ? { format: s.local.format } : {}),
    at: now,
  };
}

/** The doc has every change of the copy (nothing of it is missing there). */
export function docHasCopy(doc: Pick<EditDoc, "words" | "style" | "format">, c: DocCopy): boolean {
  const byId = new Map(doc.words.map((w) => [w.id, w]));
  for (const w of c.upsert) {
    const there = byId.get(w.id);
    if (!there || !sameWord(there, w)) return false;
  }
  if (c.delete.some((id) => byId.has(id))) return false;
  if (c.style && !same(c.style, doc.style)) return false;
  if (c.format && !same(c.format, doc.format)) return false;
  return true;
}

/** `doc` with the copy's changes on top (the same doc when it has them). */
export function applyDocCopy(doc: EditDoc, c: DocCopy): EditDoc {
  if (docHasCopy(doc, c)) return doc;
  return {
    ...doc,
    words: mergeWords(doc.words, c.upsert, c.delete),
    ...(c.style ? { style: c.style } : {}),
    ...(c.format ? { format: c.format } : {}),
  };
}

export type DocCopyDecision = { kind: "none" } | { kind: "auto"; copy: DocCopy } | { kind: "moved" };

/** What the editor does with a left-behind copy, given the doc the server has (see the header). */
export function decideDocCopy(c: DocCopy | null, server: { doc: Pick<EditDoc, "words" | "style" | "format">; rev: number }): DocCopyDecision {
  if (!c || docHasCopy(server.doc, c)) return { kind: "none" };
  // nobody saved since the changes were made (or only this device: a rev of its own)
  if (server.rev === c.base || c.known.includes(server.rev)) return { kind: "auto", copy: c };
  return { kind: "moved" };
}

/**
 * decideDocCopy at the editor's open, after the sentence edits of the v1
 * editor it applied to the server's doc (state/reconcile.ts): `shown` is
 * that doc, `sentencesAt` when they were saved (ms; null: none applied).
 * Sentence saves never move the doc's rev, so the rev can't tell: a copy
 * the doc shown has already is nothing to bring back (the sentence save
 * carried it), and sentence edits saved after the copy was made are the
 * newer change, kept as another device's save would be (moved).
 */
export function decideDocCopyOnOpen(
  c: DocCopy | null,
  server: { doc: Pick<EditDoc, "words" | "style" | "format">; rev: number },
  shown: Pick<EditDoc, "words" | "style" | "format">,
  sentencesAt: number | null,
): DocCopyDecision {
  if (!c || docHasCopy(shown, c)) return { kind: "none" };
  if (sentencesAt !== null && sentencesAt > c.at) return { kind: "moved" };
  return decideDocCopy(c, server);
}
