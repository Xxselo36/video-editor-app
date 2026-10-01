/**
 * Browser uploads straight to R2 (the backend never sees the bytes).
 *
 * uploadResumable: a multipart upload through the backend's
 * /uploads/multipart/* API — every part goes up as a plain PUT to a
 * presigned, size-signed URL, and an interrupted upload (reload, lost
 * network, a killed tab) resumes when the same file is picked again.
 * Lessons from this file's history, kept on purpose:
 *   - one XHR per part (fetch has no upload progress, c923bfc);
 *   - a per-part watchdog (no progress for UPLOAD_STALL_MS → abort),
 *     not a fixed timeout (d1bcb98);
 *   - resume state in IndexedDB, never localStorage (a big setItem
 *     blocked the iOS main thread, 171ac36), keyed by a fingerprint
 *     that does NOT use lastModified (iOS makes a new one on every
 *     pick, 8b94155);
 *   - 2 parts in parallel on phones / slow networks, else 4 (171ac36).
 * Retries and failures are reported to POST /uploads/telemetry (the
 * iOS hangs of Sept 2026 couldn't be diagnosed without a tethered Mac).
 *
 * uploadSingle: the single presigned PUT (/uploads/presign), used when
 * the backend has no multipart API (404 / 405 — older backend), is
 * switched to it (409 use_single_put from init, and from parts / sign
 * for a resumed upload: CLEO_UPLOAD_MODE isn't "multipart" — the
 * default) or has no R2 (503 that isn't server_busy; the caller then
 * falls back to the legacy upload through POST /jobs).
 */
import { ApiError, apiError, apiFetch } from "@/lib/api";
import type { Limits } from "@/lib/config";

// No upload progress for this long → treat the upload as dead.
export const UPLOAD_STALL_MS = 60_000;
export const UPLOAD_STALLED_MSG =
  "Upload stalled — no progress for 60 seconds. Check your connection and try again.";
export const UPLOAD_NETWORK_MSG =
  "Upload failed — network error. Check your connection and try again.";

// Upload caps: the backend's (GET /config, lib/config.ts), checked here
// before any bytes are sent. The server checks again (init / presign +
// POST /jobs) and its refusal names its own limit.

export type UploadLimitHit = {
  code: "file_too_large" | "video_too_long" | "video_too_short";
  /** The refusal's params, as the backend sends them. */
  params: Record<string, number>;
};

const plain = (n: number) => Math.round(n * 100) / 100;

/** Which limit a file breaks, if any (same rules as the backend: decimal
 *  GB; one second of slack for how containers round a length, 0.1 s
 *  under the minimum). `duration` null = the browser couldn't read it;
 *  the server probes. */
export function uploadLimitHit(size: number, duration: number | null, limits: Limits): UploadLimitHit | null {
  if (size > limits.max_upload_bytes) {
    return { code: "file_too_large", params: { max_gb: plain(limits.max_upload_bytes / 1e9) } };
  }
  if (duration !== null && limits.max_seconds !== null && duration > limits.max_seconds + 1) {
    return { code: "video_too_long", params: { max_minutes: plain(limits.max_seconds / 60) } };
  }
  if (duration !== null && limits.min_seconds > 0 && duration < limits.min_seconds - 0.1) {
    return { code: "video_too_short", params: { min_seconds: limits.min_seconds } };
  }
  return null;
}

export type UploadOptions = {
  file: File;
  /** 0–100. */
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  /** Seconds as the browser reads them: lets the backend refuse a video
   *  that is too long (or longer than the minutes left) before any bytes
   *  are uploaded. */
  duration?: number | null;
};

// ── resume state (IndexedDB) ─────────────────────────────────────────

const DB_NAME = "cleocuts-uploads";
const STORE = "uploads";
const RECORD_TTL_MS = 23 * 3600_000; // the ticket's lifetime
const FP_SAMPLE = 1024 * 1024;

type UploadRecord = {
  v: 1;
  fp: string;
  name: string;
  size: number;
  ticket: string;
  storage_key: string;
  part_size: number;
  parts_total: number;
  done: number[];
  created_at: number;
  /** Completed in R2, POST /jobs not answered yet: kept (a reload, a
   *  deploy restart or a 502 doesn't cost a second upload) until the
   *  job exists or the server refused the upload. */
  completed?: boolean;
};

/** A finished upload: its key, and — for a resumable one — the call
 *  that forgets its resume record once POST /jobs has settled it.
 *  `legacyApi`: the backend has no multipart API (init answered 404 /
 *  405: a build from before WP3) — its POST /jobs downloads the object
 *  inside the request (minutes for multi-GB) and isn't idempotent, so
 *  the caller waits long and doesn't retry. */
export type UploadResult = {
  storage_key: string;
  release?: () => Promise<void>;
  legacyApi?: boolean;
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

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        if (!req) return resolve(null);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

const idbGet = (fp: string) => idb<UploadRecord>("readonly", (s) => s.get(fp));
const idbPut = (rec: UploadRecord) => idb<unknown>("readwrite", (s) => s.put(rec));
const idbDelete = (fp: string) => idb<unknown>("readwrite", (s) => s.delete(fp));
const idbAll = () => idb<UploadRecord[]>("readonly", (s) => s.getAll());

// name:size of the stored records (knownKey), so hasResumableUpload can answer
// synchronously (refreshed on every change).
const known = new Set<string>();
export const knownKey = (name: string, size: number) => `${size}:${name}`;

async function refreshKnown(): Promise<void> {
  const all = (await idbAll()) ?? [];
  known.clear();
  const now = Date.now();
  for (const r of all) {
    if (r && r.v === 1 && now - r.created_at < RECORD_TTL_MS) known.add(knownKey(r.name, r.size));
    else if (r?.fp) void idbDelete(r.fp); // older than the ticket
  }
}
if (typeof window !== "undefined") void refreshKnown();

const fpCache = new WeakMap<File, Promise<string | null>>();

/** size + ":" + hex(SHA-256(name ‖ first 1 MiB ‖ last 1 MiB)). Null
 *  where crypto.subtle is missing (plain-http LAN dev): no resume. */
export function fingerprint(file: File): Promise<string | null> {
  let p = fpCache.get(file);
  if (!p) {
    p = (async () => {
      try {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return null;
        const head = await file.slice(0, FP_SAMPLE).arrayBuffer();
        const tail = await file.slice(Math.max(0, file.size - FP_SAMPLE)).arrayBuffer();
        const name = new TextEncoder().encode(file.name);
        const buf = new Uint8Array(name.byteLength + head.byteLength + tail.byteLength);
        buf.set(name, 0);
        buf.set(new Uint8Array(head), name.byteLength);
        buf.set(new Uint8Array(tail), name.byteLength + head.byteLength);
        const digest = new Uint8Array(await subtle.digest("SHA-256", buf));
        return `${file.size}:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      } catch {
        return null;
      }
    })();
    fpCache.set(file, p);
  }
  return p;
}

async function loadRecord(file: File): Promise<UploadRecord | null> {
  const fp = await fingerprint(file);
  if (!fp) return null;
  const rec = await idbGet(fp);
  if (!rec || rec.v !== 1 || rec.size !== file.size) return null;
  if (Date.now() - rec.created_at >= RECORD_TTL_MS) {
    await dropRecord(rec.fp);
    return null;
  }
  return rec;
}

async function saveRecord(rec: UploadRecord): Promise<void> {
  await idbPut(rec);
  known.add(knownKey(rec.name, rec.size));
}

async function dropRecord(fp: string): Promise<void> {
  await idbDelete(fp);
  await refreshKnown();
}

/** Might this file continue an interrupted upload? (A quick check by
 *  name and size; resumableProgress confirms by fingerprint.) */
export function hasResumableUpload(file: File): boolean {
  return known.has(knownKey(file.name, file.size));
}

/** 0–100 already uploaded of an interrupted upload of this file, or
 *  null when there is nothing to resume. */
export async function resumableProgress(file: File): Promise<number | null> {
  const rec = await loadRecord(file);
  if (!rec) return null;
  return Math.floor((doneBytes(rec.done, rec.part_size, file.size, rec.parts_total) / file.size) * 100);
}

/** Give up an interrupted upload for good: abort it on the server and
 *  forget it here. */
export async function abortResumable(opts: { file: File }): Promise<void> {
  const rec = await loadRecord(opts.file);
  if (!rec) return;
  try {
    await apiFetch("/uploads/multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: rec.ticket }),
    });
  } catch {
    /* the bucket's lifecycle rule aborts it after a day anyway */
  }
  await dropRecord(rec.fp);
}

// ── helpers (the pure ones are exported for chunkedUpload.test.ts) ───

export const partLength = (n: number, partSize: number, size: number, total: number) =>
  n < total ? partSize : size - partSize * (total - 1);

export function doneBytes(done: number[], partSize: number, size: number, total: number): number {
  return done.reduce((s, n) => s + partLength(n, partSize, size, total), 0);
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parallel part PUTs: 2 on phones and slow networks, else 4. */
function parallelism(): number {
  if (typeof navigator === "undefined") return 2;
  const conn = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
  if (/iPhone|iPad|Android/i.test(navigator.userAgent)) return 2;
  if (conn?.effectiveType && conn.effectiveType !== "4g") return 2;
  return 4;
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Fire-and-forget report of a retry / failure (POST /uploads/telemetry). */
function telemetry(ticket: string | null, event: string, fields: Record<string, number | string> = {}): void {
  try {
    const body = {
      ...(ticket ? { ticket } : {}),
      event,
      ...fields,
      ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 160) : "",
    };
    void apiFetch("/uploads/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let telemetry break an upload */
  }
}

type PutResult =
  | { ok: true }
  | { ok: false; kind: "stall" | "network" | "http" | "abort"; status: number; loaded: number };

/** One part: one XHR PUT of the slice, with no custom headers (a Blob
 *  slice without a type sends no Content-Type). `onLoaded` reports the
 *  bytes of this attempt; aborted when no progress for UPLOAD_STALL_MS. */
function putPart(url: string, body: Blob, signal: AbortSignal, onLoaded: (loaded: number) => void): Promise<PutResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let loaded = 0;
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: PutResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        done({ ok: false, kind: "stall", status: 0, loaded });
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };
    const onAbort = () => {
      done({ ok: false, kind: "abort", status: 0, loaded });
      xhr.abort();
    };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (ev) => {
      armStall();
      loaded = ev.loaded;
      onLoaded(loaded);
    };
    xhr.upload.onload = () => armStall(); // waiting for R2's answer now
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) done({ ok: true });
      else done({ ok: false, kind: "http", status: xhr.status, loaded });
    };
    xhr.onerror = () => done({ ok: false, kind: "network", status: 0, loaded });
    xhr.onabort = () => done({ ok: false, kind: "abort", status: 0, loaded });
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    armStall();
    xhr.send(body);
  });
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 3000, 9000];
const SIGN_BATCH = 32;

/** Fall back to the single PUT? (The backend has no multipart API, is
 *  switched to single PUTs, or has no R2 — the last one the caller then
 *  turns into the legacy upload.) */
function wantsSinglePut(e: ApiError): boolean {
  return (
    e.status === 404 ||
    e.status === 405 ||
    (e.status === 409 && e.code === "use_single_put") ||
    (e.status === 503 && e.code !== "server_busy")
  );
}

/** Does this /uploads/multipart/parts answer say the saved upload can't
 *  be resumed (so its record goes)? Only definitive answers — never a
 *  5xx, 401 or 429. */
export function recordGone(e: ApiError): boolean {
  return (
    e.status === 400 ||
    e.status === 403 ||
    e.status === 404 ||
    e.status === 405 ||
    e.status === 410 ||
    (e.status === 409 && e.code === "use_single_put")
  );
}

// ── the resumable upload ─────────────────────────────────────────────

export async function uploadResumable(opts: UploadOptions): Promise<UploadResult> {
  const { file, onProgress, duration } = opts;
  const outer = opts.signal;
  if (outer?.aborted) throw abortError();
  // Our own controller: a part that fails for good stops the others.
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const signal = ctl.signal;
  try {
    let rec = await loadRecord(file);
    let doneSet = new Set<number>();
    let completed = false;
    const urls = new Map<number, string>();

    if (rec?.completed) {
      // Uploaded and completed before; only POST /jobs failed. Straight
      // to POST /jobs with the key — it decides (and a refusal there
      // drops the record): no /parts round trip that a 5xx during a
      // deploy, or the single-PUT kill switch, could turn into a full
      // re-upload.
      const fp = rec.fp;
      onProgress?.(100);
      return {
        storage_key: rec.storage_key,
        release: async () => {
          if (fp) await dropRecord(fp);
        },
      };
    }

    if (rec) {
      // Resume: the server's list of parts wins over ours.
      const r = await postJson("/uploads/multipart/parts", { ticket: rec.ticket }, signal);
      if (r.ok) {
        const body = (await r.json()) as { completed?: boolean; parts: { part_number: number; size: number }[] };
        const cur = rec;
        doneSet = new Set(
          body.parts
            .filter((p) => p.size === partLength(p.part_number, cur.part_size, file.size, cur.parts_total))
            .map((p) => p.part_number),
        );
        completed = Boolean(body.completed);
        rec = { ...rec, done: [...doneSet] };
        void saveRecord(rec);
        telemetry(rec.ticket, "resume", { loaded: doneBytes(rec.done, rec.part_size, file.size, rec.parts_total) });
      } else {
        const e = await apiError(r);
        if (!recordGone(e)) {
          // 401 (sign in again), a 5xx while the backend restarts, 429 …:
          // not an answer about the upload — the record stays for the
          // next try.
          throw e;
        }
        // Expired (410), not ours any more (403), no multipart API
        // (404 / 405) or switched to single PUTs (409).
        await dropRecord(rec.fp);
        rec = null;
      }
    }

    if (!rec) {
      const r = await postJson(
        "/uploads/multipart/init",
        {
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          // Size cap, queue / per-user limits and disk space are checked
          // against this before any part goes up.
          size: file.size,
          ...(duration ? { duration } : {}),
        },
        signal,
      );
      if (!r.ok) {
        // Typed so the caller can tell 401 / 402 / 413 / 429 / 503 apart.
        const e = await apiError(r);
        if (wantsSinglePut(e)) {
          const single = await uploadSingle({ ...opts, signal });
          return { ...single, legacyApi: e.status === 404 || e.status === 405 };
        }
        throw e;
      }
      const init = (await r.json()) as {
        ticket: string;
        storage_key: string;
        part_size: number;
        parts_total: number;
        parts: { part_number: number; url: string }[];
      };
      for (const p of init.parts) urls.set(p.part_number, p.url);
      const fp = await fingerprint(file);
      rec = {
        v: 1,
        fp: fp ?? "",
        name: file.name,
        size: file.size,
        ticket: init.ticket,
        storage_key: init.storage_key,
        part_size: init.part_size,
        parts_total: init.parts_total,
        done: [],
        created_at: Date.now(),
      };
      if (fp) void saveRecord(rec);
    }

    const state = rec;
    const total = state.parts_total;
    const size = file.size;
    let doneTotal = doneBytes([...doneSet], state.part_size, size, total);
    const inflight = new Map<number, number>();
    let lastReport = 0;
    const report = (force = false) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastReport < 250) return; // 4 Hz
      lastReport = now;
      let sum = doneTotal;
      inflight.forEach((v) => (sum += v));
      onProgress(Math.min(100, Math.floor((sum / size) * 100)));
    };
    report(true);

    const signBatch = async (numbers: number[]) => {
      const r = await postJson("/uploads/multipart/sign", { ticket: state.ticket, part_numbers: numbers }, signal);
      if (!r.ok) throw await apiError(r);
      const body = (await r.json()) as { parts: { part_number: number; url: string }[] };
      for (const p of body.parts) urls.set(p.part_number, p.url);
    };

    const pending = (): number[] => {
      const out: number[] = [];
      for (let n = 1; n <= total; n++) if (!doneSet.has(n)) out.push(n);
      return out;
    };

    let signing: Promise<void> | null = null;
    const urlFor = async (n: number): Promise<string> => {
      while (!urls.has(n)) {
        if (!signing) {
          // This part and the next ones still without a URL, 32 at once.
          const want = pending().filter((m) => m >= n && !urls.has(m)).slice(0, SIGN_BATCH);
          signing = signBatch(want.length ? want : [n]).finally(() => {
            signing = null;
          });
        }
        await signing;
      }
      return urls.get(n)!;
    };

    const uploadPart = async (n: number): Promise<void> => {
      const a = (n - 1) * state.part_size;
      const blob = file.slice(a, a + partLength(n, state.part_size, size, total));
      let resigned = false;
      const t0 = Date.now();
      for (let attempt = 1; ; attempt++) {
        const url = await urlFor(n);
        inflight.set(n, 0);
        const res = await putPart(url, blob, signal, (loaded) => {
          inflight.set(n, loaded);
          report();
        });
        inflight.delete(n);
        if (res.ok) {
          doneSet.add(n);
          doneTotal += blob.size;
          report();
          state.done = [...doneSet];
          if (state.fp) void saveRecord(state);
          return;
        }
        if (res.kind === "abort" || signal.aborted) throw abortError();
        if (res.kind === "http" && res.status === 403 && !resigned) {
          // The URL expired (6 h) or the signature is off: sign again,
          // once, without counting it as a failed attempt.
          resigned = true;
          urls.delete(n);
          telemetry(state.ticket, "part_resign", { part: n, attempt, status: res.status });
          attempt--;
          continue;
        }
        const last = attempt >= MAX_ATTEMPTS;
        telemetry(state.ticket, last ? "part_failed" : "part_retry", {
          part: n,
          attempt,
          status: res.status,
          elapsed_ms: Date.now() - t0,
          loaded: res.loaded,
          kind: res.kind,
        });
        if (last) throw new Error(res.kind === "stall" ? UPLOAD_STALLED_MSG : UPLOAD_NETWORK_MSG);
        await sleep(BACKOFF_MS[attempt - 1] ?? 9000, signal);
      }
    };

    const uploadPending = async () => {
      const queue = pending();
      const worker = async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          await uploadPart(n);
        }
      };
      const workers = Array.from({ length: Math.min(parallelism(), queue.length) }, () => worker());
      try {
        await Promise.all(workers);
      } catch (e) {
        ctl.abort(); // stop the other parts; the state stays for a resume
        await Promise.allSettled(workers);
        throw e;
      }
    };

    for (let round = 0; ; round++) {
      if (!completed) await uploadPending();
      const r = await postJson("/uploads/multipart/complete", { ticket: state.ticket }, signal);
      if (r.ok) break;
      const e = await apiError(r);
      if (e.status === 409 && e.code === "parts_missing" && round < 2) {
        // The server's list wins: upload what it doesn't have.
        const missing = (e.body?.missing as number[] | undefined) ?? [];
        for (const n of missing) doneSet.delete(n);
        doneTotal = doneBytes([...doneSet], state.part_size, size, total);
        completed = false;
        continue;
      }
      if (e.status === 410 || e.status === 413 || e.status === 403) {
        if (state.fp) await dropRecord(state.fp);
      }
      telemetry(state.ticket, "complete_failed", { status: e.status });
      throw e;
    }
    report(true);
    onProgress?.(100);
    // Kept until POST /jobs has the job (release): picking the file
    // again after a failed POST resumes at "complete" — no re-upload.
    if (state.fp) {
      state.completed = true;
      await saveRecord(state);
    }
    const fp = state.fp;
    return {
      storage_key: state.storage_key,
      release: async () => {
        if (fp) await dropRecord(fp);
      },
    };
  } catch (e) {
    if (outer?.aborted) throw abortError();
    throw e;
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** The single presigned PUT (≤ 5 GiB; no resume). */
export async function uploadSingle(opts: UploadOptions): Promise<UploadResult> {
  const { file, onProgress, signal, duration } = opts;
  const presignRes = await apiFetch("/uploads/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      content_type: file.type || "video/mp4",
      // Size cap, queue / per-user limits and disk space are checked
      // against this before the PUT starts.
      size: file.size,
      ...(duration ? { duration } : {}),
    }),
    signal,
  });
  if (!presignRes.ok) {
    // Typed so the caller can tell 401 (sign in) / 402 (plan needed,
    // checked before any bytes are sent) / 413 (too big / too long) /
    // 429 (too many jobs) / 503 (server_busy, or no R2 here) apart.
    throw await apiError(presignRes);
  }
  const presign = (await presignRes.json()) as {
    upload_url: string;
    storage_key: string;
    headers?: Record<string, string>;
  };
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presign.upload_url);
    const ct = presign.headers?.["Content-Type"];
    if (ct) xhr.setRequestHeader("Content-Type", ct);
    // Abort if the connection stalls: without this a dropped mobile
    // connection can leave the XHR (and the progress bar) hanging
    // forever with no error.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // Reject first: abort() fires onabort synchronously.
        reject(new Error(UPLOAD_STALLED_MSG));
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };
    xhr.upload.onprogress = (ev) => {
      armStall();
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };
    xhr.upload.onload = () => clearTimeout(stallTimer);
    xhr.onload = () => {
      clearTimeout(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => {
      clearTimeout(stallTimer);
      reject(new Error("R2 network error"));
    };
    xhr.onabort = () => {
      clearTimeout(stallTimer);
      reject(new Error("Upload aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(abortError());
      });
    }
    armStall();
    xhr.send(file);
  });
  return { storage_key: presign.storage_key };
}

/** Video length from the file's metadata (no upload), or null when the
 *  browser can't tell quickly — the backend measures it anyway. */
export function readVideoDuration(file: File, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    let settled = false;
    const done = (d: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(d !== null && isFinite(d) && d > 0 ? d : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    v.src = url;
  });
}
