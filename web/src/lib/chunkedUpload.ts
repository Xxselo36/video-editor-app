/**
 * Resumable multipart upload to R2 via signed S3-compatible URLs.
 *
 * Splits the file into `CHUNK_SIZE` byte parts, uploads them in
 * parallel (bounded), and persists progress to localStorage keyed by
 * (filename + size + lastModified). If the page reloads or upload
 * aborts, calling `uploadResumable` again with the same File resumes
 * from where it left off — already-uploaded parts are skipped.
 *
 * Cancellation: `signal.aborted` at any time bails out. The multipart
 * upload is NOT auto-aborted server-side because the resume state is
 * valid; caller can hit `/uploads/multipart/abort` explicitly.
 */

// R2 requires each part ≥5MB except the last. 25MB balances
// per-part overhead against granular retry / resume granularity.
const CHUNK_SIZE = 25 * 1024 * 1024;

// Bounded parallelism — don't saturate a mobile connection with 8
// parallel puts, but also don't crawl through 320 parts serially.
const MAX_PARALLEL = 4;

// URL sign batch — one call to the backend returns this many signed
// URLs, cutting round-trip overhead on very large uploads.
const SIGN_BATCH = 32;

interface PersistedState {
  version: 1;
  upload_id: string;
  storage_key: string;
  filename: string;
  file_size: number;
  chunk_size: number;
  last_modified: number;
  completed_parts: Array<{ part_number: number; etag: string }>;
}

function storageKey(file: File): string {
  // Key on (name + size) only — NOT lastModified. iOS Safari
  // regenerates the timestamp each time the user picks a video from
  // Photos, breaking resume. Name+size collision is negligible for
  // multi-GB user recordings.
  return `cleocuts.chunkedUpload.v1.${file.name}.${file.size}`;
}

function loadState(file: File): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(file));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1) return null;
    if (parsed.file_size !== file.size) return null;
    console.log(
      `[upload] resuming from ${parsed.completed_parts.length} parts`,
    );
    return parsed;
  } catch {
    return null;
  }
}

function saveState(file: File, state: PersistedState): void {
  try {
    localStorage.setItem(storageKey(file), JSON.stringify(state));
  } catch {
    // Quota exceeded — nothing we can do, the upload will still
    // complete for THIS session but resume won't work.
  }
}

function clearState(file: File): void {
  try {
    localStorage.removeItem(storageKey(file));
  } catch {
    // ignore
  }
}

/**
 * Fallback: single-shot PUT via /uploads/presign. Used when the
 * backend doesn't have the multipart endpoints yet (during deploy
 * transitions) or returns 503 (R2 not configured for multipart).
 * Same public shape as uploadResumable so callers don't branch.
 */
async function uploadSingle(opts: {
  file: File;
  backendUrl: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<{ storage_key: string }> {
  const { file, backendUrl, onProgress, signal } = opts;
  const presignRes = await fetch(`${backendUrl}/uploads/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      content_type: file.type || "video/mp4",
    }),
    signal,
  });
  if (!presignRes.ok) {
    throw new Error(`presign failed: ${await presignRes.text()}`);
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
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("R2 network error"));
    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new DOMException("aborted", "AbortError"));
      });
    }
    xhr.send(file);
  });
  return { storage_key: presign.storage_key };
}

export async function uploadResumable(opts: {
  file: File;
  backendUrl: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<{ storage_key: string }> {
  const { file, backendUrl, onProgress, signal } = opts;

  // 1. Load prior state or start fresh
  let state = loadState(file);
  if (!state) {
    const initRes = await fetch(`${backendUrl}/uploads/multipart/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type || "video/mp4",
      }),
      signal,
    });
    // Backend deploy transition: multipart endpoints not there yet.
    // Fall back to the single-PUT presign path so the user still
    // uploads successfully; they just lose the resume feature until
    // the deploy completes.
    if (initRes.status === 404 || initRes.status === 503) {
      console.warn("[upload] multipart unavailable, using single-PUT fallback");
      return uploadSingle(opts);
    }
    if (!initRes.ok) throw new Error(`init failed: ${await initRes.text()}`);
    const init = (await initRes.json()) as {
      upload_id: string;
      storage_key: string;
    };
    state = {
      version: 1,
      upload_id: init.upload_id,
      storage_key: init.storage_key,
      filename: file.name,
      file_size: file.size,
      chunk_size: CHUNK_SIZE,
      last_modified: file.lastModified,
      completed_parts: [],
    };
    saveState(file, state);
  }

  const totalParts = Math.ceil(state.file_size / state.chunk_size);
  const doneNumbers = new Set(
    state.completed_parts.map((p) => p.part_number),
  );
  const missing: number[] = [];
  for (let n = 1; n <= totalParts; n++) {
    if (!doneNumbers.has(n)) missing.push(n);
  }

  const reportProgress = () => {
    if (!onProgress) return;
    onProgress(
      Math.round(
        (state!.completed_parts.length / Math.max(1, totalParts)) * 100,
      ),
    );
  };
  reportProgress();

  // 2. Sign + upload missing parts in batches with bounded parallelism
  while (missing.length) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const batch = missing.splice(0, SIGN_BATCH);
    const signRes = await fetch(`${backendUrl}/uploads/multipart/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_id: state.upload_id,
        storage_key: state.storage_key,
        part_numbers: batch,
      }),
      signal,
    });
    if (!signRes.ok) {
      throw new Error(`sign failed: ${await signRes.text()}`);
    }
    const signed = (await signRes.json()) as {
      parts: Array<{ part_number: number; upload_url: string }>;
    };

    // Upload with a semaphore-style limit + per-part timeout + retry
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      while (cursor < signed.parts.length) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const idx = cursor++;
        const part = signed.parts[idx];
        const start = (part.part_number - 1) * state!.chunk_size;
        const end = Math.min(start + state!.chunk_size, state!.file_size);
        const blob = file.slice(start, end);

        const PART_TIMEOUT_MS = 90_000;   // 90s per 25MB chunk = ~2Mbps
        const MAX_ATTEMPTS = 4;
        let lastErr: unknown = null;
        let etag: string | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          const ctrl = new AbortController();
          const linkAbort = () => ctrl.abort();
          signal?.addEventListener("abort", linkAbort);
          const timer = setTimeout(() => ctrl.abort(), PART_TIMEOUT_MS);
          try {
            const putRes = await fetch(part.upload_url, {
              method: "PUT",
              body: blob,
              signal: ctrl.signal,
            });
            if (!putRes.ok) {
              throw new Error(`part ${part.part_number} PUT ${putRes.status}`);
            }
            const raw = putRes.headers.get("ETag") ||
              putRes.headers.get("etag");
            if (!raw) {
              throw new Error(
                `part ${part.part_number}: no ETag header ` +
                  "(check R2 CORS ExposeHeaders)",
              );
            }
            etag = raw.replace(/^"|"$/g, "");
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (signal?.aborted) throw err;
            // Backoff: 1s, 2s, 4s
            if (attempt < MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
            }
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", linkAbort);
          }
        }
        if (!etag) {
          throw new Error(
            `part ${part.part_number} failed after retries: ${lastErr}`,
          );
        }
        state!.completed_parts.push({
          part_number: part.part_number,
          etag,
        });
        saveState(file, state!);
        reportProgress();
      }
    };
    for (let w = 0; w < MAX_PARALLEL; w++) workers.push(runNext());
    await Promise.all(workers);
  }

  // 3. Complete the multipart upload
  const completeRes = await fetch(`${backendUrl}/uploads/multipart/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_id: state.upload_id,
      storage_key: state.storage_key,
      parts: state.completed_parts,
    }),
    signal,
  });
  if (!completeRes.ok) {
    throw new Error(`complete failed: ${await completeRes.text()}`);
  }

  clearState(file);
  return { storage_key: state.storage_key };
}

export function hasResumableUpload(file: File): boolean {
  return loadState(file) !== null;
}

export async function abortResumable(opts: {
  file: File;
  backendUrl: string;
}): Promise<void> {
  const { file, backendUrl } = opts;
  const state = loadState(file);
  if (!state) return;
  try {
    await fetch(`${backendUrl}/uploads/multipart/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_id: state.upload_id,
        storage_key: state.storage_key,
      }),
    });
  } catch {
    // ignore
  } finally {
    clearState(file);
  }
}
