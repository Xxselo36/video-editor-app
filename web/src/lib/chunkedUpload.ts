/**
 * Single-PUT upload to R2 via presigned URL. Chunked/multipart path
 * was hanging on iOS Safari with no console access to diagnose; this
 * simpler path is the known-working fallback we always kept.
 *
 * Progress via XHR upload event. No resume (whole upload restarts on
 * interruption), but reliable everywhere the presigned PUT is CORS-
 * allowed on R2 (which we verified when direct upload was originally
 * introduced).
 */
import { apiError, apiFetch } from "@/lib/api";

// No upload progress for this long → treat the upload as dead.
export const UPLOAD_STALL_MS = 60_000;
export const UPLOAD_STALLED_MSG =
  "Upload stalled — no progress for 60 seconds. Check your connection and try again.";

// Upload caps: the backend's CLEO_MAX_UPLOAD_GB / CLEO_MAX_MINUTES
// defaults, checked here before any bytes are sent. The server checks
// again (presign + POST /jobs) and its 413 names its own limit; set
// these when the backend's differ. Literal references: only
// `process.env.NEXT_PUBLIC_X` gets inlined at build time.
const envNum = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v && isFinite(n) && n > 0 ? n : dflt;
};
export const MAX_UPLOAD_GB = envNum(process.env.NEXT_PUBLIC_MAX_UPLOAD_GB, 4);
export const MAX_MINUTES = envNum(process.env.NEXT_PUBLIC_MAX_MINUTES, 30);

export type UploadLimitHit =
  | { code: "file_too_large"; max: number }
  | { code: "video_too_long"; max: number };

/** Which cap a file breaks, if any (same rules as the backend: decimal
 *  GB; one second of slack for how containers round their length).
 *  `duration` null = the browser couldn't read it; the server probes. */
export function uploadLimitHit(size: number, duration: number | null): UploadLimitHit | null {
  if (size > MAX_UPLOAD_GB * 1e9) return { code: "file_too_large", max: MAX_UPLOAD_GB };
  if (duration !== null && duration > MAX_MINUTES * 60 + 1) {
    return { code: "video_too_long", max: MAX_MINUTES };
  }
  return null;
}

export async function uploadResumable(opts: {
  file: File;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  /** Seconds as the browser reads them: lets the backend refuse a video
   *  that is too long (or longer than the minutes left) before any bytes
   *  are uploaded. */
  duration?: number | null;
}): Promise<{ storage_key: string }> {
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
        reject(new DOMException("aborted", "AbortError"));
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

export function hasResumableUpload(_file: File): boolean {
  // Multipart path disabled → nothing to resume
  return false;
}

export async function abortResumable(_opts: {
  file: File;
}): Promise<void> {
  // Single-PUT has no server-side state to abort; XHR.abort() in
  // uploadResumable handles the client side via the signal.
  return;
}
