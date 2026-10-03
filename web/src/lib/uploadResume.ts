/**
 * Resume records of interrupted uploads (lib/chunkedUpload), split out
 * so the start screen and the Projects tiles can show them without
 * loading the upload code.
 *
 * One record per multipart upload, in IndexedDB (never localStorage: a
 * big setItem blocked the iOS main thread, 171ac36), written as soon as
 * the backend opened the upload — before part 1 — and after every part.
 *
 * Matching a re-picked file (2026-10, the owner's lost iPhone upload):
 * the record is found by CONTENT — size + SHA-256 of the first and last
 * 2 MiB — never by name or lastModified. iOS gives a video picked from
 * Photos a fresh lastModified on every pick (8b94155) and often a fresh
 * name too (trim.<UUID>.MOV / a random temp name), so the fingerprint
 * of before (name ‖ first MiB ‖ last MiB) never matched again after a
 * reload. Records written under that old key are still found
 * (legacyFingerprint) and moved to the new one.
 *
 * Lifetime: the backend's ticket (`expires_at` of init: up to 7 days, and
 * never longer than the bucket keeps an incomplete upload — backend/
 * uploads.py resume_window_s). Records from before carry no expiry: 23 h
 * after they were written, the ticket lifetime of then.
 */

/** v1: keyed by the old fingerprint (with the name); v2: by content. */
export type UploadRecord = {
  v: 1 | 2;
  fp: string;
  name: string;
  size: number;
  ticket: string;
  storage_key: string;
  part_size: number;
  parts_total: number;
  done: number[];
  created_at: number;
  /** ms; the ticket's expiry (missing on records from before). */
  expires_at?: number;
  /** ms; the last write. */
  updated_at?: number;
  /** Completed in R2, POST /jobs not answered yet: kept (a reload, a
   *  deploy restart or a 502 doesn't cost a second upload) until the
   *  job exists or the server refused the upload. */
  completed?: boolean;
};

/** What the start screen / a Projects tile shows of a record. */
export type ResumableUpload = {
  fp: string;
  name: string;
  size: number;
  /** 0–100 uploaded (by the record; the server's list decides on resume). */
  pct: number;
  updatedAt: number;
  expiresAt: number;
};

const DB_NAME = "cleocuts-uploads";
const STORE = "uploads";
/** The ticket lifetime of records written before `expires_at` existed. */
export const LEGACY_TTL_MS = 23 * 3600_000;
/** A record this close to its expiry isn't offered any more: the upload
 *  would run into the ticket's end. */
export const EXPIRY_MARGIN_MS = 10 * 60_000;
export const FP_SAMPLE = 2 * 1024 * 1024;
const LEGACY_FP_SAMPLE = 1024 * 1024;

// ── storage (IndexedDB; a memory map in unit tests) ──────────────────

type Backend = {
  get(fp: string): Promise<UploadRecord | null>;
  put(rec: UploadRecord): Promise<void>;
  delete(fp: string): Promise<void>;
  all(): Promise<UploadRecord[]>;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** The database, or null (no IndexedDB, private mode, blocked): the
 *  upload still works then, it just can't resume. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: "fp" });
          }
        } catch {
          /* resolve(null) via onerror */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        // A write counts once it is committed (a killed tab keeps it).
        if (mode === "readwrite") {
          tx.oncomplete = () => resolve((req.result as T) ?? null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } else {
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

const idbBackend: Backend = {
  get: (fp) => idb<UploadRecord>("readonly", (s) => s.get(fp)),
  put: async (rec) => {
    await idb("readwrite", (s) => s.put(rec));
  },
  delete: async (fp) => {
    await idb("readwrite", (s) => s.delete(fp));
  },
  all: async () => (await idb<UploadRecord[]>("readonly", (s) => s.getAll())) ?? [],
};

let backend: Backend = idbBackend;

/** Unit tests: records in a Map (vitest runs in node, no IndexedDB). */
export function _useMemoryStoreForTests(): Map<string, UploadRecord> {
  const m = new Map<string, UploadRecord>();
  backend = {
    get: async (fp) => (m.has(fp) ? structuredClone(m.get(fp)!) : null),
    put: async (rec) => void m.set(rec.fp, structuredClone(rec)),
    delete: async (fp) => void m.delete(fp),
    all: async () => [...m.values()].map((r) => structuredClone(r)),
  };
  active.clear();
  return m;
}

// ── change notifications (the start screen's card, the tiles) ────────

const subs = new Set<() => void>();
function changed(): void {
  subs.forEach((f) => {
    try {
      f();
    } catch {
      /* a listener's problem */
    }
  });
}
export function subscribeResumable(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Fingerprints of the uploads running in this page: not "interrupted". */
const active = new Map<string, number>();
export function markUploadActive(fp: string, on: boolean): void {
  const n = (active.get(fp) ?? 0) + (on ? 1 : -1);
  if (n > 0) active.set(fp, n);
  else active.delete(fp);
  changed();
}

// ── fingerprints ─────────────────────────────────────────────────────

async function sha256Hex(parts: ArrayBuffer[]): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const len = parts.reduce((s, p) => s + p.byteLength, 0);
  const buf = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    buf.set(new Uint8Array(p), at);
    at += p.byteLength;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const fpCache = new WeakMap<File, Promise<string | null>>();
const legacyCache = new WeakMap<File, Promise<string | null>>();

/** "c2:" + size + ":" + hex(SHA-256(first 2 MiB ‖ last 2 MiB)): the same
 *  bytes match whatever the file is called and whenever it was picked.
 *  Null where crypto.subtle is missing (plain-http LAN dev): no resume. */
export function fingerprint(file: File): Promise<string | null> {
  let p = fpCache.get(file);
  if (!p) {
    p = (async () => {
      try {
        if (!globalThis.crypto?.subtle) return null;
        const head = await file.slice(0, FP_SAMPLE).arrayBuffer();
        const tail = await file.slice(Math.max(0, file.size - FP_SAMPLE)).arrayBuffer();
        const hex = await sha256Hex([head, tail]);
        return hex ? `c2:${file.size}:${hex}` : null;
      } catch {
        return null;
      }
    })();
    fpCache.set(file, p);
  }
  return p;
}

/** The key of records from before (size:SHA-256(name ‖ first MiB ‖ last
 *  MiB)): only to find those. */
export function legacyFingerprint(file: File): Promise<string | null> {
  let p = legacyCache.get(file);
  if (!p) {
    p = (async () => {
      try {
        if (!globalThis.crypto?.subtle) return null;
        const head = await file.slice(0, LEGACY_FP_SAMPLE).arrayBuffer();
        const tail = await file.slice(Math.max(0, file.size - LEGACY_FP_SAMPLE)).arrayBuffer();
        const name = new TextEncoder().encode(file.name);
        const hex = await sha256Hex([name.buffer as ArrayBuffer, head, tail]);
        return hex ? `${file.size}:${hex}` : null;
      } catch {
        return null;
      }
    })();
    legacyCache.set(file, p);
  }
  return p;
}

// ── records ──────────────────────────────────────────────────────────

export const partLength = (n: number, partSize: number, size: number, total: number) =>
  n < total ? partSize : size - partSize * (total - 1);

export function doneBytes(done: number[], partSize: number, size: number, total: number): number {
  return done.reduce((s, n) => s + partLength(n, partSize, size, total), 0);
}

export function recordExpiry(rec: Pick<UploadRecord, "created_at" | "expires_at">): number {
  return rec.expires_at ?? rec.created_at + LEGACY_TTL_MS;
}

/** Can this record still be resumed at `now`? */
export function recordUsable(rec: UploadRecord | null | undefined, now = Date.now()): rec is UploadRecord {
  return Boolean(
    rec &&
      (rec.v === 1 || rec.v === 2) &&
      typeof rec.fp === "string" &&
      rec.fp &&
      typeof rec.size === "number" &&
      Array.isArray(rec.done) &&
      now < recordExpiry(rec) - EXPIRY_MARGIN_MS,
  );
}

export function recordPct(rec: UploadRecord): number {
  if (rec.completed) return 100;
  if (rec.size <= 0) return 0;
  return Math.min(100, Math.floor((doneBytes(rec.done, rec.part_size, rec.size, rec.parts_total) / rec.size) * 100));
}

/** The record of an interrupted upload of this file (by content; an old
 *  record by its old key, moved to the new one), or null. */
export async function findRecord(file: File): Promise<UploadRecord | null> {
  const fp = await fingerprint(file);
  if (!fp) return null;
  const rec = await backend.get(fp);
  if (rec) {
    if (rec.size === file.size && recordUsable(rec)) return rec;
    await dropRecord(fp);
    return null;
  }
  const old = await legacyFingerprint(file);
  if (!old) return null;
  const legacy = await backend.get(old);
  if (!legacy) return null;
  if (legacy.size !== file.size || !recordUsable(legacy)) {
    await dropRecord(old);
    return null;
  }
  const moved: UploadRecord = { ...legacy, v: 2, fp };
  await backend.put(moved);
  await backend.delete(old);
  changed();
  return moved;
}

export async function saveRecord(rec: UploadRecord): Promise<void> {
  if (!rec.fp) return;
  rec.updated_at = Date.now();
  await backend.put(rec);
  changed();
}

export async function dropRecord(fp: string): Promise<void> {
  if (!fp) return;
  await backend.delete(fp);
  changed();
}

export async function getRecord(fp: string): Promise<UploadRecord | null> {
  return backend.get(fp);
}

/** The interrupted uploads of this browser, newest first: not expired
 *  (expired ones are deleted) and not running in this page. */
export async function listResumable(now = Date.now()): Promise<ResumableUpload[]> {
  const out: ResumableUpload[] = [];
  for (const r of await backend.all()) {
    if (!recordUsable(r, now)) {
      const fp = (r as { fp?: unknown } | null)?.fp;
      if (typeof fp === "string" && fp) await backend.delete(fp);
      continue;
    }
    if (active.has(r.fp)) continue;
    out.push({
      fp: r.fp,
      name: r.name,
      size: r.size,
      pct: recordPct(r),
      updatedAt: r.updated_at ?? r.created_at,
      expiresAt: recordExpiry(r),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Give up an interrupted upload for good: abort it on the server and
 *  forget it here (the start screen's "Discard", a tile's "Remove"). */
export async function discardResumable(fp: string): Promise<void> {
  const rec = await backend.get(fp);
  if (!rec) return;
  try {
    const { apiFetch } = await import("@/lib/api");
    await apiFetch("/uploads/multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: rec.ticket }),
    });
  } catch {
    /* the bucket's lifecycle rule aborts it anyway */
  }
  await dropRecord(fp);
}
