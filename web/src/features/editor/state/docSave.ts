/**
 * Autosave of the edit document (UX8): PATCH /jobs/{id}/doc, debounced
 * 800 ms, with the doc's revision rule (backend/doc.py apply_patch):
 * base_rev = the rev the server has, rev = base_rev + 1.
 *
 * - Only what changed is sent (diffWords: upserts + deletes, style and
 *   format when they changed). A body stays under PATCH_LIMIT: a bigger
 *   change (a replace-all over a long transcript) goes as several
 *   PATCHes in a row, each a valid doc on its own.
 * - Unload (pagehide): the pending change goes at once with keepalive
 *   (the browser's keepalive budget is 64 KB; review D4), based on the
 *   rev of a request still in flight.
 * - 409 stale_rev (another tab or device saved): state "conflict", the
 *   autosave stops and the local doc stays as it is until the editor
 *   reloads it (review F3) — nothing is overwritten silently.
 * - Network errors and 5xx: "retrying" with backoff (and at once when
 *   the browser is back online); other refusals: "failed".
 *
 * Framework-free (fetch and timers injected) so it is unit-tested; the
 * editor's useDocSession wires it to the store.
 */
import { diffWords, mergeWords, type DocFormat, type DocStyle, type DocWord, type EditDoc } from "./doc";

/** Bytes per PATCH body: under the server's 64 KB and the keepalive budget. */
export const PATCH_LIMIT = 60_000;
export const DEBOUNCE_MS = 800;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000];

export type DocSaveState = "saved" | "saving" | "retrying" | "failed" | "conflict";

type Saved = { words: DocWord[]; style: DocStyle; format: DocFormat; rev: number };

export type PatchBody = {
  base_rev: number;
  rev: number;
  style?: DocStyle;
  format?: DocFormat;
  words?: { upsert: DocWord[]; delete: string[] };
};

export type DocSaverDeps = {
  jobId: string;
  /** apiFetch-like. */
  fetch: (path: string, init: RequestInit & { unloading?: boolean }) => Promise<Response>;
  onState?: (s: DocSaveState) => void;
  /** Every request promise (lib/pendingSaves trackSave). */
  track?: (p: Promise<unknown>) => void;
  /** New ids were given to unsaved words (serverIds): rename them in the editor. */
  onRename?: (map: Map<string, string>) => void;
  /** Every word id the editor made (doc.ts IdPool). */
  pool?: Set<string>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  debounceMs?: number;
};

const sizeOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * The PATCH bodies that bring the server from `base` to `next`, each
 * under `limit` bytes (revs filled in by the caller).
 */
export function patchBodies(base: Saved, next: EditDoc, limit = PATCH_LIMIT): Omit<PatchBody, "base_rev" | "rev">[] {
  const head: Omit<PatchBody, "base_rev" | "rev"> = {};
  if (JSON.stringify(next.style) !== JSON.stringify(base.style)) head.style = next.style;
  if (JSON.stringify(next.format) !== JSON.stringify(base.format)) head.format = next.format;
  const { upsert, delete: del } = diffWords(base.words, next.words);
  if (!upsert.length && !del.length) return head.style || head.format ? [head] : [];
  const out: Omit<PatchBody, "base_rev" | "rev">[] = [];
  const room = limit - 200; // revs and keys
  let cur = { ...head, words: { upsert: [] as DocWord[], delete: [] as string[] } };
  let size = sizeOf(head);
  const push = () => {
    out.push(cur);
    cur = { words: { upsert: [], delete: [] } };
    size = 0;
  };
  for (const id of del) {
    const n = sizeOf(id) + 1;
    if (size + n > room && (cur.words.delete.length || cur.words.upsert.length)) push();
    cur.words.delete.push(id);
    size += n;
  }
  for (const w of upsert) {
    const n = sizeOf(w) + 1;
    if (size + n > room && (cur.words.delete.length || cur.words.upsert.length)) push();
    cur.words.upsert.push(w);
    size += n;
  }
  if (cur.words.delete.length || cur.words.upsert.length) out.push(cur);
  return out;
}

const MAX_ID = 40; // backend/doc.py _WORD_ID

/**
 * New ids for the words the server doesn't have yet, so its merge
 * (mergeWords: a new "<parent>.<k>" goes right after its parent, other
 * new words by start) puts them exactly where they are here: each one
 * becomes a child of the nearest word before it that the server has
 * (the first such word for words in front of all of them). A word that
 * already is such a child keeps its id. Without this, a word whose
 * parent was deleted meanwhile, or a long chain of splits, could land
 * elsewhere (and break the server's start order) or outgrow the id
 * limit. Returns old id → new id (empty: nothing to rename).
 */
export function serverIds(
  saved: readonly DocWord[],
  latest: readonly DocWord[],
  pool?: Set<string>,
): Map<string, string> {
  const onServer = new Set(saved.map((w) => w.id));
  // pool: every id this editor made (undo may bring one back)
  const taken = pool ?? new Set<string>();
  for (const id of onServer) taken.add(id);
  for (const w of latest) taken.add(w.id);
  const firstOld = latest.find((w) => onServer.has(w.id))?.id ?? null;
  const out = new Map<string, string>();
  let anchor: string | null = null;
  let free = 0;
  const fresh = (base: string) => {
    let k = 1;
    while (taken.has(`${base}.${k}`)) k++;
    const id = `${base}.${k}`;
    taken.add(id);
    return id;
  };
  for (const w of latest) {
    if (onServer.has(w.id)) {
      anchor = w.id;
      continue;
    }
    const parent = anchor ?? firstOld;
    const dot = w.id.lastIndexOf(".");
    const mine = dot >= 0 ? w.id.slice(0, dot) : null;
    if (parent !== null && mine === parent && w.id.length <= MAX_ID) continue;
    let id: string;
    if (parent !== null && parent.length + 6 <= MAX_ID) id = fresh(parent);
    else {
      // no word the server has (or too long an id): placed by its start
      do id = `n${(free++).toString(36)}`;
      while (taken.has(id));
      taken.add(id);
    }
    out.set(w.id, id);
  }
  return out;
}

export function renameWords(words: readonly DocWord[], map: ReadonlyMap<string, string>): DocWord[] {
  if (!map.size) return words as DocWord[];
  return words.map((w) => (map.has(w.id) ? { ...w, id: map.get(w.id)! } : w));
}

/** The server's doc after a body (what it stores; see mergeWords). */
function after(base: Saved, body: PatchBody): Saved {
  return {
    words: body.words ? mergeWords(base.words, body.words.upsert, body.words.delete) : base.words,
    style: body.style ?? base.style,
    format: body.format ?? base.format,
    rev: body.rev,
  };
}

export class DocSaver {
  private saved: Saved;
  private latest: EditDoc;
  private timer: unknown = null;
  private inflight: { body: PatchBody; done: Promise<void> } | null = null;
  private attempt = 0;
  private state: DocSaveState = "saved";
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly d: Required<Omit<DocSaverDeps, "onState" | "track" | "onRename" | "pool">> &
    Pick<DocSaverDeps, "onState" | "track" | "onRename" | "pool">;

  constructor(doc: EditDoc, rev: number, deps: DocSaverDeps) {
    this.saved = { words: doc.words, style: doc.style, format: doc.format, rev };
    this.latest = doc;
    this.d = {
      debounceMs: DEBOUNCE_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  get status(): DocSaveState {
    return this.state;
  }
  get rev(): number {
    return this.saved.rev;
  }
  /** Something not yet acknowledged by the server. */
  get dirty(): boolean {
    return this.inflight !== null || patchBodies(this.saved, this.latest).length > 0;
  }

  private set(s: DocSaveState) {
    if (s === this.state) return;
    this.state = s;
    this.d.onState?.(s);
  }

  /** The doc changed: save it after the debounce. */
  schedule(doc: EditDoc): void {
    this.latest = doc;
    if (this.stopped || this.state === "conflict" || this.state === "failed") return;
    this.clear();
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.d.debounceMs);
    if (this.state === "saved") this.set("saving");
  }

  /** Send now (leaving the editor, back online, Retry). */
  flush(): Promise<void> {
    this.clear();
    if (this.state === "conflict" || this.stopped) return Promise.resolve();
    if (this.state === "failed") this.set("saving");
    this.attempt = 0;
    return this.run();
  }

  /**
   * The page is going away: the pending change in ONE keepalive request
   * (on top of a request still in flight). True when something was sent.
   */
  flushUnload(): boolean {
    this.clear();
    if (this.state === "conflict" || this.stopped) return false;
    const prev = this.inflight;
    const base = prev ? after(this.saved, prev.body) : this.saved;
    this.normalize(base);
    const bodies = patchBodies(base, this.latest);
    if (!bodies.length) return false;
    const body: PatchBody = { ...bodies[0], base_rev: base.rev, rev: base.rev + 1 };
    const text = JSON.stringify(body);
    const res = this.request(text, new TextEncoder().encode(text).length < PATCH_LIMIT);
    // Its answer is applied after the one in flight (page restored from
    // the back/forward cache: the autosave carries on from there).
    const done = (prev ? prev.done : Promise.resolve()).then(() => this.handle(body, res));
    this.inflight = { body, done };
    this.chain = this.chain.then(() => done).catch(() => undefined);
    this.d.track?.(done);
    return true;
  }

  /** A fresh doc from the server (reload after a conflict). */
  reset(doc: EditDoc, rev: number): void {
    this.clear();
    this.saved = { words: doc.words, style: doc.style, format: doc.format, rev };
    this.latest = doc;
    this.attempt = 0;
    this.set("saved");
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear() {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  /** Unsaved words get ids the server's merge places right (serverIds). */
  private normalize(base: Saved) {
    const map = serverIds(base.words, this.latest.words, this.d.pool);
    if (!map.size) return;
    this.latest = { ...this.latest, words: renameWords(this.latest.words, map) };
    this.d.onRename?.(map);
  }

  /** Runs drain() after any drain already running (one request at a time). */
  private run(): Promise<void> {
    const next = this.chain.then(() => this.drain());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped || this.state === "conflict" || this.state === "failed") return;
      // A debounce or a retry is pending: it runs drain again.
      if (this.timer !== null) return;
      if (this.inflight) {
        // an unload flush is out: build on its answer
        const out = this.inflight;
        await out.done;
        if (this.inflight === out) this.inflight = null;
        continue;
      }
      this.normalize(this.saved);
      const bodies = patchBodies(this.saved, this.latest);
      if (!bodies.length) {
        this.set("saved");
        return;
      }
      if (this.state === "saved") this.set("saving");
      const body: PatchBody = { ...bodies[0], base_rev: this.saved.rev, rev: this.saved.rev + 1 };
      const done = this.handle(body, this.request(JSON.stringify(body), false));
      this.inflight = { body, done };
      this.d.track?.(done);
      await done;
      if (this.inflight?.done !== done) return; // an unload flush went after it
      this.inflight = null;
      if (this.state === "retrying") return;
    }
  }

  private request(text: string, unloading: boolean): Promise<Response> {
    return this.d.fetch(`/jobs/${this.d.jobId}/doc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: text,
      ...(unloading ? { keepalive: true, unloading: true } : {}),
    });
  }

  /** Applies the answer to a PATCH of `body`. */
  private async handle(body: PatchBody, res: Promise<Response>): Promise<void> {
    let r: Response;
    try {
      r = await res;
    } catch {
      this.retryLater();
      return;
    }
    if (r.ok) {
      let rev = body.rev;
      try {
        const j = (await r.json()) as { rev?: unknown };
        if (typeof j.rev === "number") rev = j.rev;
      } catch {
        /* the rev we sent */
      }
      this.saved = { ...after(this.saved, body), rev };
      this.attempt = 0;
      if (this.state === "retrying") this.set("saving");
      return;
    }
    let code: string | null = null;
    try {
      const j = (await r.json()) as { detail?: unknown };
      code = typeof j.detail === "string" ? j.detail : null;
    } catch {
      /* no body */
    }
    if (r.status === 409 && code === "stale_rev") {
      this.clear();
      this.set("conflict");
      return;
    }
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      this.retryLater();
      return;
    }
    this.clear();
    this.set("failed");
  }

  private retryLater() {
    this.set("retrying");
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.clear();
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }
}
