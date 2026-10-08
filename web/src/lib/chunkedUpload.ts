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
 *     blocked the iOS main thread, 171ac36), keyed by the file's
 *     CONTENT — neither lastModified (iOS makes a new one on every
 *     pick, 8b94155) nor the name (iOS often renames a re-picked
 *     video): lib/uploadResume; the record goes in before part 1;
 *   - a resume asks the server which parts R2 has (/parts) and sends
 *     only the others;
 *   - 2 parts in parallel on phones / slow networks, else 4 (171ac36);
 *   - a transient failure (network, stall, an abort the browser did,
 *     a 5xx) never ends the upload while the page lives: it waits for
 *     the connection and goes on from the missing parts (2026-10, iOS
 *     Safari in the background).
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
import {
  discardResumable,
  doneBytes,
  dropRecord,
  findRecord,
  fingerprint,
  HEARTBEAT_MS,
  markUploadActive,
  partLength,
  recordPct,
  saveRecord,
  type UploadRecord,
} from "@/lib/uploadResume";
export { doneBytes, fingerprint, legacyFingerprint, partLength } from "@/lib/uploadResume";

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
  /** The upload waits for the connection (true) / bytes flow again. */
  onPaused?: (paused: boolean) => void;
};

// ── resume state: lib/uploadResume (IndexedDB, by content) ──────────

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

/** 0–100 already uploaded of an interrupted upload of this file, or
 *  null when there is nothing to resume. */
export async function resumableProgress(file: File): Promise<number | null> {
  const rec = await findRecord(file);
  return rec ? recordPct(rec) : null;
}

/** Give up an interrupted upload of this file for good: abort it on the
 *  server and forget it here. */
export async function abortResumable(opts: { file: File }): Promise<void> {
  const rec = await findRecord(opts.file);
  if (rec) await discardResumable(rec.fp);
}

// ── helpers (the pure ones are exported for chunkedUpload.test.ts) ───

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

// ── waiting out a lost connection ────────────────────────────────────
// iOS Safari suspends or cuts the requests of a page in the background
// (another app, the screen locked) and comes back with the File still
// in memory. A transient failure never ends the upload: it waits — with
// backoff, and at once when the connection or the page comes back
// (online, visible, pageshow, focus) — and continues with the parts
// still missing. Only Cancel or a definitive answer stops it.
const wakers = new Set<() => void>();
let listening = false;

/** Wake every waiting retry and kick hung parts (exported for tests). */
export function wakeUploads(): void {
  [...wakers].forEach((f) => f());
}

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  for (const ev of ["online", "pageshow", "focus"]) window.addEventListener(ev, wakeUploads);
  document?.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wakeUploads();
  });
}

/** Backoff of the n-th retry: 1, 3, 9, 15 s, then every 30 s. */
export const retryDelay = (n: number): number => [1000, 3000, 9000, 15000][n - 1] ?? 30_000;

/** Wait `ms`, or less: the connection / the page came back (or, in
 *  `group`, another part of the same upload got through). Rejects on
 *  abort. */
export function waitRetry(ms: number, signal?: AbortSignal, group?: Set<() => void>): Promise<void> {
  listen();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const end = (ok: boolean) => {
      clearTimeout(t);
      wakers.delete(wake);
      group?.delete(wake);
      signal?.removeEventListener("abort", onAbort);
      if (ok) resolve();
      else reject(abortError());
    };
    const wake = () => end(true);
    const onAbort = () => end(false);
    const t = setTimeout(wake, ms);
    wakers.add(wake);
    group?.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** An API answer, its body already read; `sentAt`: when its request
 *  went out (never later than the server's signing of the URLs in it). */
export type Answer = { r: Response; sentAt: number };

/** One API call with its own deadline (`ms`: the token fetch before the
 *  request and the body after it included) and — `kick` — cut short
 *  when the page or the connection comes back and it has run for
 *  KICK_MS: iOS leaves requests hanging in the background like the part
 *  PUTs. Rejects with an AbortError when cut or cancelled (`signal`);
 *  a body that fails half-way is a failed attempt like any other. */
export function attemptJson(
  path: string,
  body: unknown,
  signal: AbortSignal,
  ms: number,
  kick: boolean,
): Promise<Answer> {
  listen();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const att = new AbortController();
    const t0 = Date.now();
    let settled = false;
    const end = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wakers.delete(kicker);
      signal.removeEventListener("abort", cut);
      f();
    };
    const cut = () => {
      end(() => reject(abortError()));
      att.abort();
    };
    const kicker = () => {
      if (Date.now() - t0 >= KICK_MS) cut();
    };
    const timer = setTimeout(cut, ms);
    if (kick) wakers.add(kicker);
    signal.addEventListener("abort", cut, { once: true });
    postJson(path, body, att.signal).then(
      async (r) => {
        try {
          const text = await r.text();
          const empty = r.status === 204 || r.status === 205 || r.status === 304;
          const copy = new Response(empty ? null : text, { status: r.status, statusText: r.statusText, headers: r.headers });
          end(() => resolve({ r: copy, sentAt: t0 }));
        } catch (e) {
          end(() => reject(e));
        }
      },
      (e) => end(() => reject(e)),
    );
  });
}

// ── presigned part URLs ──────────────────────────────────────────────
// The backend signs part URLs for 6 h (uploads.SIGN_TTL_S). An upload
// now outlives that (a phone locked overnight), and R2 answers an
// expired URL with a 403 without CORS headers — the browser sees a
// network error. So each URL carries its own end, by this device's clock
// at signing (no clock skew): a stale one is signed again before use,
// and a PUT that fails after its URL ran out is sent again with a new
// one, never counted as a failure.
const SIGN_TTL_MS = 6 * 3600_000;
const SIGN_MARGIN_MS = 10 * 60_000;
/** A 403 / 400 on a URL older than this may be an expiry (another
 *  clock, a TTL shorter than ours): signed again; on a newer one it is
 *  an answer. */
const RESIGN_AFTER_MS = 5 * 60_000;

export type SignedUrl = { url: string; at: number; until: number };

/** A URL as /init or /sign gave it, `now`: valid until its
 *  X-Amz-Expires (else 6 h) minus a margin for the PUT itself. */
export function signedUrl(url: string, now = Date.now()): SignedUrl {
  let ttl = SIGN_TTL_MS;
  try {
    const e = Number(new URL(url).searchParams.get("X-Amz-Expires"));
    if (e > 0) ttl = e * 1000;
  } catch {
    /* not a URL we can read: the default */
  }
  return { url, at: now, until: now + ttl - Math.min(SIGN_MARGIN_MS, ttl / 2) };
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
    let lastAt = Date.now();
    const done = (r: PutResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      wakers.delete(kick);
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // The page / connection is back and this part hasn't moved for a
    // while: iOS left it hanging in the background — send it again now
    // rather than after the watchdog.
    const kick = () => {
      if (Date.now() - lastAt < KICK_MS) return;
      done({ ok: false, kind: "stall", status: 0, loaded });
      xhr.abort();
    };
    const armStall = () => {
      lastAt = Date.now();
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
    listen();
    wakers.add(kick);
    armStall();
    xhr.send(body);
  });
}

/** Retries of a part reported to telemetry (it retries for as long as
 *  the page lives). */
const MAX_ATTEMPTS = 4;
const KICK_MS = 15_000;
/** A part attempt that moved this much has a connection: not "waiting
 *  for connection" (less may only have filled the send buffer). */
const RESET_BYTES = 2 * 1024 * 1024;
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
  // What waits for the connection now (parts, API calls): "paused".
  const waiting = new Set<unknown>();
  // The retries of this upload waiting now: woken when a part got
  // through (the connection is back, whatever `online` said).
  const sleepers = new Set<() => void>();
  const setWaiting = (k: unknown, on: boolean) => {
    const was = waiting.size > 0;
    if (on) waiting.add(k);
    else waiting.delete(k);
    if (was !== waiting.size > 0) opts.onPaused?.(!was);
  };
  /** An API call that waits out a network error, a hung request (60 s,
   *  or cut when the page comes back) and, `busy`, a 502 / 503 / 504
   *  while the backend restarts — instead of failing. */
  const call = async (
    path: string,
    body: unknown,
    { busy = true, ms = 60_000, kick = true }: { busy?: boolean; ms?: number; kick?: boolean } = {},
  ): Promise<Answer> => {
    const key = {};
    try {
      for (let n = 1; ; n++) {
        try {
          const a = await attemptJson(path, body, signal, ms, kick);
          if (!busy || ![502, 503, 504].includes(a.r.status)) return a;
        } catch {
          // A network error, no token (offline), or cut: hung.
          if (signal.aborted) throw abortError();
        }
        if (n >= 2 || offline()) setWaiting(key, true);
        await waitRetry(retryDelay(n), signal, sleepers);
      }
    } finally {
      setWaiting(key, false);
    }
  };
  // This page's upload of these bytes: no "interrupted" card for it.
  const fileFp = await fingerprint(file);
  if (fileFp) markUploadActive(fileFp, true);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    let rec: UploadRecord | null = await findRecord(file);
    let doneSet = new Set<number>();
    let completed = false;
    const urls = new Map<number, SignedUrl>();

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
      const { r } = await call("/uploads/multipart/parts", { ticket: rec.ticket });
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
        await saveRecord(rec);
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
      const { r, sentAt } = await call(
        "/uploads/multipart/init",
        {
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          // Size cap, queue / per-user limits and disk space are checked
          // against this before any part goes up.
          size: file.size,
          ...(duration ? { duration } : {}),
        },
        // Its 503 is an answer (server_busy, or no R2 here). Not
        // idempotent (each makes an R2 upload): a long deadline, no kick.
        { busy: false, ms: 120_000, kick: false },
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
        /** Unix seconds: the ticket's end (backends from before: none). */
        expires_at?: number;
        parts: { part_number: number; url: string }[];
      };
      const now = Date.now();
      for (const p of init.parts) urls.set(p.part_number, signedUrl(p.url, sentAt));
      rec = {
        v: 2,
        fp: fileFp ?? "",
        name: file.name,
        size: file.size,
        ticket: init.ticket,
        storage_key: init.storage_key,
        part_size: init.part_size,
        parts_total: init.parts_total,
        done: [],
        created_at: now,
        ...(typeof init.expires_at === "number" && init.expires_at > 0 ? { expires_at: init.expires_at * 1000 } : {}),
      };
      // Written now — before part 1 — and committed: a tab killed during
      // the first part still resumes.
      await saveRecord(rec);
    }

    const state = rec;
    // Running: other tabs see it by its lock, or (no Web Locks) by this.
    if (state.fp) heartbeat = setInterval(() => void saveRecord(state), HEARTBEAT_MS);
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
      const { r, sentAt } = await call("/uploads/multipart/sign", { ticket: state.ticket, part_numbers: numbers });
      if (!r.ok) throw await apiError(r);
      const body = (await r.json()) as { parts: { part_number: number; url: string }[] };
      for (const p of body.parts) urls.set(p.part_number, signedUrl(p.url, sentAt));
    };
    /** Part `n` has a URL that is still good for a PUT. */
    const fresh = (n: number) => (urls.get(n)?.until ?? 0) > Date.now();

    const pending = (): number[] => {
      const out: number[] = [];
      for (let n = 1; n <= total; n++) if (!doneSet.has(n)) out.push(n);
      return out;
    };

    let signing: Promise<void> | null = null;
    const urlFor = async (n: number): Promise<SignedUrl> => {
      for (let rounds = 0; !fresh(n); rounds++) {
        // (A /sign answer without this part, again and again.)
        if (rounds > 3) throw new Error(UPLOAD_NETWORK_MSG);
        if (!signing) {
          // This part and the next ones without a good URL (none yet, or
          // stale after a long pause), 32 at once.
          const want = pending().filter((m) => m >= n && !fresh(m)).slice(0, SIGN_BATCH);
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
      const t0 = Date.now();
      // Failures of this part since it started (the backoff and
      // "waiting"; only its success ends them — a part R2 refuses after
      // its body, 5xx / 429, must not be sent again every second);
      // `attempt` counts all tries (telemetry).
      let fails = 0;
      const through = Math.min(RESET_BYTES, blob.size);
      for (let attempt = 1; ; attempt++) {
        const signed = await urlFor(n);
        inflight.set(n, 0);
        const res = await putPart(signed.url, blob, signal, (loaded) => {
          inflight.set(n, loaded);
          // Bytes get through: not "waiting for connection" (any part).
          if (loaded >= through && waiting.size) {
            waiting.clear();
            opts.onPaused?.(false);
          }
          report();
        });
        inflight.delete(n);
        if (res.ok) {
          setWaiting(n, false);
          // The connection is back: the other retries go now.
          [...sleepers].forEach((f) => f());
          doneSet.add(n);
          doneTotal += blob.size;
          report();
          state.done = [...doneSet];
          if (state.fp) void saveRecord(state);
          return;
        }
        // Cancelled — or a part that failed for good stopped the others.
        // An abort the browser did itself (iOS, the page in the
        // background) is a lost connection like any other.
        if (signal.aborted) throw abortError();
        // The URL ran out meanwhile (whatever R2's answer looked like —
        // a network error, without CORS headers), or a 403 / 400 on one
        // signed a while ago: a new URL, not a failure.
        const now = Date.now();
        const old = now - signed.at > RESIGN_AFTER_MS;
        if (now >= signed.until || (res.kind === "http" && (res.status === 403 || res.status === 400) && old)) {
          if (urls.get(n) === signed) urls.delete(n);
          telemetry(state.ticket, "part_resign", { part: n, attempt, status: res.status, kind: res.kind });
          attempt--;
          continue;
        }
        // R2's 4xx is an answer (a 5xx, 408 / 429, a network error, a
        // stall or an abort the browser did is not): the upload stops,
        // resumable.
        const final = res.kind === "http" && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        if (attempt <= MAX_ATTEMPTS || final) {
          telemetry(state.ticket, final ? "part_failed" : "part_retry", {
            part: n,
            attempt,
            status: res.status,
            elapsed_ms: Date.now() - t0,
            loaded: res.loaded,
            kind: res.kind,
          });
        }
        if (final) throw new Error(UPLOAD_NETWORK_MSG);
        fails++;
        // No answer, again, on a URL signed a while ago: maybe it ran out
        // after all (a clock that jumped, a suspended answer): the next
        // try gets a new one.
        if (res.kind !== "http" && fails >= 2 && now - signed.at > RESIGN_AFTER_MS && urls.get(n) === signed) urls.delete(n);
        if (fails >= 2 || offline()) setWaiting(n, true);
        await waitRetry(retryDelay(fails), signal, sleepers);
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
      // (Completing lists and joins every part on R2: it may take a while.
      // Idempotent.)
      const { r } = await call("/uploads/multipart/complete", { ticket: state.ticket }, { ms: 180_000 });
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
    clearInterval(heartbeat);
    if (fileFp) markUploadActive(fileFp, false);
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
