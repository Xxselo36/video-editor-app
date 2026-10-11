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
 * Part hashes (data safety of a resume from a re-pick): the m1 key says
 * nothing about the media bytes (an equal moov means equal sample sizes
 * and offsets, not equal samples), so every uploaded part's record entry
 * carries the SHA-256 of the WHOLE part (`hashes`: read once as the part
 * goes up, and those very bytes are sent) and a short hash of 16 KiB in
 * its middle (`probes`: a cheap first check), both with moov's times
 * zeroed where the part holds them (lib/mp4Moov `times`). A resume keeps
 * a part R2 has only when the re-picked file's bytes there hash the
 * same; any other part goes up again. A completed upload whose POST
 * /jobs failed is used again only when every part checks out; else the
 * file goes up anew. So a re-export by iOS (new moov times, the same
 * bytes otherwise) keeps every part: part 1 then holds the FIRST pick's
 * moov, the second pick's but for those times. A re-export with other
 * media of the same length (PCM audio, a fixed-size codec, a smart
 * render: the same moov) and two iOS picks whose mdat differs in a few
 * places (the owner's test B: 63 of 64 sampled windows equal) fail on
 * the parts that differ. Records from before the hashes that were found
 * by a raw-bytes key (c2 / legacy: the raw first and last 2 MiB matched)
 * keep their parts as before and take the hashes from the file now; a
 * record found by the m1 key without hashes keeps none.
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
  /** Part number → partProbe of the bytes that went up as that part
   *  (a first check on resume). Missing on records from before. */
  probes?: Record<number, string>;
  /** Part number → SHA-256 (hex) of the whole part as it went up, moov's
   *  times zeroed (partDigest): a resume keeps a part R2 has only when
   *  the re-picked file's bytes hash the same. Only ever names bytes R2
   *  has (a part sent again loses its hash before it goes). Missing on
   *  records from before (see the top of this file). */
  hashes?: Record<number, string>;
  /** "any": picked with the unfiltered iOS input ("Pick anyway": iOS
   *  converted the video), so a resume opens that one again (the
   *  original-formats picker hands over other bytes). */
  source?: "any";
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
  /** See UploadRecord.source. */
  source?: "any";
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
  let buf: ArrayBuffer | Uint8Array<ArrayBuffer>;
  if (parts.length === 1) {
    // One buffer (a whole part: 16 MiB and more): digested as it is.
    // (Every buffer here is a plain ArrayBuffer's: File reads, copies.)
    buf = parts[0] as ArrayBuffer | Uint8Array<ArrayBuffer>;
  } else {
    const all = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p instanceof Uint8Array ? p : new Uint8Array(p), at);
      at += p.byteLength;
    }
    buf = all;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const fpCache = new WeakMap<File, Promise<string | null>>();
const contentCache = new WeakMap<File, Promise<string | null>>();
const legacyCache = new WeakMap<File, Promise<string | null>>();
/** [from, to) byte ranges of a file. */
type Range = [number, number];
const timesCache = new WeakMap<Blob, Promise<Range[]>>();

/** Where moov's creation / modification times lie in `file` (lib/
 *  mp4Moov), or none (not a plain MP4 / QuickTime file): the bytes the
 *  part hashes zero. */
export function moovTimes(file: Blob): Promise<Range[]> {
  let p = timesCache.get(file);
  if (!p) {
    p = moovFingerprintInput(file).then(
      (input) => input?.times ?? [],
      () => [],
    );
    timesCache.set(file, p);
  }
  return p;
}

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
  // (Read once: the part hashes need where the times are.)
  if (!timesCache.has(file)) timesCache.set(file, Promise.resolve(input?.times ?? []));
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

/** A record and the key it was found by: "m1" (the moov key: the media
 *  may differ, only the part hashes tell) or a raw-bytes key ("c2", or
 *  "legacy" with the name). */
export type RecordMatch = { rec: UploadRecord; by: "m1" | "c2" | "legacy" };

/** Files whose record was found by a raw-bytes key and moved to the
 *  current one: a later look-up with the same File (the upload after the
 *  start screen's percent) still knows that these bytes matched. */
const movedFor = new WeakMap<File, { fp: string; by: RecordMatch["by"] }>();

/** The record of an interrupted upload of this file (by content; a
 *  record under an older key of the same file is moved to the current
 *  one), and how it was found; or null. */
export async function findRecordMatch(file: File): Promise<RecordMatch | null> {
  const fp = await fingerprint(file);
  if (!fp) return null;
  // The current key, then the raw-bytes key (an MP4's records from
  // before the m1 key), then the legacy key (with the name); each read
  // only when the ones before found nothing.
  const keys: [RecordMatch["by"], () => Promise<string | null>][] = [
    [fp.startsWith("m1:") ? "m1" : "c2", async () => fp],
    ["c2", () => contentFingerprint(file)],
    ["legacy", () => legacyFingerprint(file)],
  ];
  const tried = new Set<string>();
  for (const [by, next] of keys) {
    const key = await next();
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const rec = await backend.get(key);
    if (!rec) continue;
    if (rec.size !== file.size || !recordUsable(rec)) {
      await dropRecord(key);
      continue;
    }
    if (key === fp) {
      const was = movedFor.get(file);
      return { rec, by: was?.fp === fp ? was.by : by };
    }
    const moved: UploadRecord = { ...rec, v: 2, fp };
    await backend.put(moved);
    await backend.delete(key);
    movedFor.set(file, { fp, by });
    changed();
    return { rec: moved, by };
  }
  return null;
}

/** findRecordMatch's record. */
export async function findRecord(file: File): Promise<UploadRecord | null> {
  return (await findRecordMatch(file))?.rec ?? null;
}

/** `bytes` (at file offset `at`) with every byte of `times` in them
 *  zeroed: a copy when any is, else `bytes` itself. */
function withoutTimes(bytes: Uint8Array<ArrayBuffer>, at: number, times: Range[]): Uint8Array<ArrayBuffer> {
  let out = bytes;
  for (const [a, b] of times) {
    const from = Math.max(a, at);
    const to = Math.min(b, at + bytes.length);
    if (from >= to) continue;
    if (out === bytes) out = bytes.slice();
    out.fill(0, from - at, to - at);
  }
  return out;
}

/** Where partProbe's window lies in a part of `len` bytes. */
function probeWindow(len: number): { from: number; w: number } {
  const w = Math.min(PROBE_BYTES, len);
  return { from: Math.floor((len - w) / 2), w };
}

/** A short hash of part `n`'s bytes in `file`: SHA-256 of PROBE_BYTES in
 *  the middle of the part (moov's times zeroed), 16 hex digits. Null when
 *  it can't be read. */
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
    const { from, w } = probeWindow(partLength(n, partSize, size, total));
    const bytes = new Uint8Array(await file.slice(start + from, start + from + w).arrayBuffer());
    const hex = await sha256Hex([withoutTimes(bytes, start + from, await moovTimes(file))]);
    return hex ? hex.slice(0, 16) : null;
  } catch {
    return null;
  }
}

/** What a resume checks a part against. */
export type PartDigest = {
  /** SHA-256 (hex) of the whole part. */
  hash: string;
  /** partProbe of it. */
  probe: string;
};

/** The digests of one whole part, `bytes`, which starts at file offset
 *  `start` (moov's `times` zeroed, as partProbe does). Null without
 *  crypto.subtle. */
export async function partDigest(bytes: Uint8Array<ArrayBuffer>, start: number, times: Range[]): Promise<PartDigest | null> {
  try {
    const clean = withoutTimes(bytes, start, times);
    const { from, w } = probeWindow(clean.length);
    const [hash, probe] = await Promise.all([sha256Hex([clean]), sha256Hex([clean.subarray(from, from + w)])]);
    return hash && probe ? { hash, probe: probe.slice(0, 16) } : null;
  } catch {
    return null;
  }
}

/** partDigest of part `n` of `file`, read now (the whole part). Null when
 *  it can't be read. */
export async function partHash(
  file: Blob,
  n: number,
  partSize: number,
  size: number,
  total: number,
): Promise<PartDigest | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const start = (n - 1) * partSize;
    const len = partLength(n, partSize, size, total);
    const bytes = new Uint8Array(await file.slice(start, start + len).arrayBuffer());
    if (bytes.length !== len) return null;
    return await partDigest(bytes, start, await moovTimes(file));
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
 *  the file again still goes straight there, once its bytes match every
 *  part: lib/chunkedUpload). */
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
      ...(r.source === "any" ? { source: "any" as const } : {}),
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
