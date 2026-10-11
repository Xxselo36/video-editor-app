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
 * the record is found by CONTENT, never by name or lastModified. iOS
 * gives a video picked from Photos a fresh lastModified on every pick
 * (8b94155) and often a fresh name too (trim.<UUID>.MOV / a random temp
 * name), so the fingerprint of before (name ‖ first MiB ‖ last MiB)
 * never matched again after a reload.
 *
 * The content key (fingerprint):
 *   - "m1:" for an MP4 / QuickTime file: size + its top-level layout +
 *     its moov with the creation / modification times zeroed
 *     (lib/mp4Moov). iOS exports the video afresh on every pick and
 *     writes new times into moov (mvhd / tkhd / mdhd), which sits in the
 *     first 2 MiB: the raw-bytes key below changed on every re-pick, so
 *     the upload started over after every reload (2026-10, the owner's
 *     picker tests). moov's sample tables pin where every sample lies
 *     and how big it is.
 *   - "c2:" (contentFingerprint) for anything else: size + SHA-256 of
 *     the first and last 2 MiB.
 * Records written under an older key (the c2 key of an MP4 written
 * before the m1 key existed, the legacy key with the name) are still
 * found and moved to the current one.
 *
 * Part probes (data safety of a resume from a re-pick): every uploaded
 * part's record entry carries a short hash of a window in its middle
 * (partProbe). A resume keeps a part R2 has only if the re-picked file
 * has the same bytes there; any other part goes up again. A re-export
 * that differs only in the moov times keeps every part: part 1 then
 * holds the FIRST pick's moov, which is the second pick's moov but for
 * those times — the same sample tables, so it describes the parts after
 * it exactly. A file with the same layout but other media (two
 * uncompressed clips of one length) fails the probes and goes up anew.
 *
 * Lifetime: the backend's ticket (`expires_at` of init: up to 7 days, and
 * never longer than the bucket keeps an incomplete upload — backend/
 * uploads.py resume_window_s). Records from before carry no expiry: 23 h
 * after they were written, the ticket lifetime of then.
 */

import { moovFingerprintInput } from "./mp4Moov";

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
  /** Part number → partProbe of the bytes that went up as that part.
   *  Missing on records from before (their parts are trusted as they
   *  were: they matched the raw first and last 2 MiB). */
  probes?: Record<number, string>;
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
/** The window of a part that partProbe hashes (in its middle). */
export const PROBE_BYTES = 16 * 1024;

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
  ranHere.clear();
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

// ── uploads running now (this page, or another tab) ─────────────────
//
// A record of an upload that runs in ANOTHER tab is not "interrupted":
// it isn't listed, and Discard never aborts it. Each running upload holds
// a Web Lock named after its fingerprint (released by the browser when
// the tab goes, however it goes); where Web Locks are missing it writes
// a heartbeat (updated_at, every HEARTBEAT_MS) and a record touched in
// the last ACTIVE_MS counts as running.

export const HEARTBEAT_MS = 20_000;
export const ACTIVE_MS = 60_000;
const LOCK_PREFIX = "cleocuts-upload:";

type LockManagerLike = {
  request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
};
function locks(): LockManagerLike | null {
  try {
    const l = (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks;
    return l && typeof l.request === "function" && typeof l.query === "function" ? l : null;
  } catch {
    return null;
  }
}

/** Fingerprints of the uploads running in this page: not "interrupted". */
const active = new Map<string, number>();
/** Uploads of this page that ran (their heartbeat is ours, not another tab's). */
const ranHere = new Set<string>();
const lockRelease = new Map<string, () => void>();
const lockSettled = new Map<string, Promise<unknown>>();

export function markUploadActive(fp: string, on: boolean): void {
  const n = (active.get(fp) ?? 0) + (on ? 1 : -1);
  if (n > 0) active.set(fp, n);
  else active.delete(fp);
  ranHere.add(fp);
  const lm = locks();
  if (lm && on && n === 1 && !lockRelease.has(fp)) {
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    lockRelease.set(fp, release);
    const settled: Promise<unknown> = lm
      // ifAvailable: another tab uploading the same bytes holds it — then
      // it is running there anyway, and nothing here waits for it.
      .request(LOCK_PREFIX + fp, { ifAvailable: true }, (lock) => (lock ? held : Promise.resolve()))
      .catch(() => {})
      .then(() => {
        if (lockSettled.get(fp) === settled) lockSettled.delete(fp);
      });
    lockSettled.set(fp, settled);
  } else if (n <= 0 && lockRelease.has(fp)) {
    lockRelease.get(fp)!();
    lockRelease.delete(fp);
  }
  changed();
}

/** Fingerprints of uploads running in another tab of this browser. */
async function activeElsewhere(recs: UploadRecord[], now: number): Promise<Set<string>> {
  const out = new Set<string>();
  const lm = locks();
  if (lm) {
    // Our own locks may be on their way out: wait until they are gone.
    const leaving = [...lockSettled.entries()].filter(([fp]) => !active.has(fp)).map(([, p]) => p);
    if (leaving.length) await Promise.race([Promise.all(leaving), new Promise((r) => setTimeout(r, 1000))]);
    try {
      const q = await lm.query();
      for (const h of q.held ?? []) {
        const name = h?.name ?? "";
        if (name.startsWith(LOCK_PREFIX)) {
          const fp = name.slice(LOCK_PREFIX.length);
          if (!active.has(fp)) out.add(fp);
        }
      }
      return out;
    } catch {
      /* fall back to the heartbeat */
    }
  }
  for (const r of recs) {
    if (active.has(r.fp) || ranHere.has(r.fp)) continue;
    if (!r.completed && now - (r.updated_at ?? r.created_at) < ACTIVE_MS) out.add(r.fp);
  }
  return out;
}

// ── fingerprints ─────────────────────────────────────────────────────

async function sha256Hex(parts: (ArrayBuffer | Uint8Array)[]): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const len = parts.reduce((s, p) => s + p.byteLength, 0);
  const buf = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    buf.set(p instanceof Uint8Array ? p : new Uint8Array(p), at);
    at += p.byteLength;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const fpCache = new WeakMap<File, Promise<string | null>>();
const contentCache = new WeakMap<File, Promise<string | null>>();
const legacyCache = new WeakMap<File, Promise<string | null>>();

/** The resume key of `file`: "m1:" + size + ":" + hex(SHA-256(layout ‖
 *  moov without its times)) for an MP4 / QuickTime file (a re-export by
 *  iOS matches), else the raw-bytes key (contentFingerprint). Null where
 *  crypto.subtle is missing (plain-http LAN dev): no resume. */
export function fingerprint(file: File): Promise<string | null> {
  let p = fpCache.get(file);
  if (!p) {
    p = (async () => {
      try {
        if (!globalThis.crypto?.subtle) return null;
        const m = await moovFingerprint(file);
        return m ?? (await contentFingerprint(file));
      } catch {
        return contentFingerprint(file);
      }
    })();
    fpCache.set(file, p);
  }
  return p;
}

/** The moov key of `file`, or null when it isn't a plain MP4 /
 *  QuickTime file (lib/mp4Moov). */
async function moovFingerprint(file: File): Promise<string | null> {
  const input = await moovFingerprintInput(file);
  if (!input) return null;
  const head = new TextEncoder().encode(`cleocuts-moov-v1\n${file.size}\n${input.layout}\n`);
  const hex = await sha256Hex([head, input.moov]);
  return hex ? `m1:${file.size}:${hex}` : null;
}

/** "c2:" + size + ":" + hex(SHA-256(first 2 MiB ‖ last 2 MiB)): the same
 *  bytes match whatever the file is called and whenever it was picked.
 *  The key of every file before the m1 key, and of non-MP4 files now. */
export function contentFingerprint(file: File): Promise<string | null> {
  let p = contentCache.get(file);
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
    contentCache.set(file, p);
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

/** The record of an interrupted upload of this file (by content; a
 *  record under an older key of the same file is moved to the current
 *  one), or null. */
export async function findRecord(file: File): Promise<UploadRecord | null> {
  const fp = await fingerprint(file);
  if (!fp) return null;
  // The current key, then the raw-bytes key (an MP4's records from
  // before the m1 key), then the legacy key (with the name); each read
  // only when the ones before found nothing.
  const keys = [async () => fp, () => contentFingerprint(file), () => legacyFingerprint(file)];
  const tried = new Set<string>();
  for (const next of keys) {
    const key = await next();
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const rec = await backend.get(key);
    if (!rec) continue;
    if (rec.size !== file.size || !recordUsable(rec)) {
      await dropRecord(key);
      continue;
    }
    if (key === fp) return rec;
    const moved: UploadRecord = { ...rec, v: 2, fp };
    await backend.put(moved);
    await backend.delete(key);
    changed();
    return moved;
  }
  return null;
}

/** A short hash of part `n`'s bytes in `file`: SHA-256 of PROBE_BYTES in
 *  the middle of the part, 16 hex digits. Null when it can't be read. */
export async function partProbe(
  file: Blob,
  n: number,
  partSize: number,
  size: number,
  total: number,
): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const start = (n - 1) * partSize;
    const len = partLength(n, partSize, size, total);
    const w = Math.min(PROBE_BYTES, len);
    const from = start + Math.floor((len - w) / 2);
    const hex = await sha256Hex([await file.slice(from, from + w).arrayBuffer()]);
    return hex ? hex.slice(0, 16) : null;
  } catch {
    return null;
  }
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
 *  (expired ones are deleted), not running in this page or another tab,
 *  and not completed (the file is stored: POST /jobs owns it — picking
 *  the file again still goes straight there). */
export async function listResumable(now = Date.now()): Promise<ResumableUpload[]> {
  const out: ResumableUpload[] = [];
  const usable: UploadRecord[] = [];
  for (const r of await backend.all()) {
    if (!recordUsable(r, now)) {
      const fp = (r as { fp?: unknown } | null)?.fp;
      if (typeof fp === "string" && fp) await backend.delete(fp);
      continue;
    }
    usable.push(r);
  }
  const elsewhere = await activeElsewhere(usable, now);
  for (const r of usable) {
    if (r.completed || active.has(r.fp) || elsewhere.has(r.fp)) continue;
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
 *  forget it here (the start screen's "Discard", a tile's "Remove").
 *  Never one that is running — here or in another tab: false then. */
export async function discardResumable(fp: string): Promise<boolean> {
  const rec = await backend.get(fp);
  if (!rec) return true;
  if (active.has(fp) || (await activeElsewhere([rec], Date.now())).has(fp)) return false;
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
  return true;
}
