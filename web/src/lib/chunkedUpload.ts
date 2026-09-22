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

export async function uploadResumable(opts: {
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

export function hasResumableUpload(_file: File): boolean {
  // Multipart path disabled → nothing to resume
  return false;
}

export async function abortResumable(_opts: {
  file: File;
  backendUrl: string;
}): Promise<void> {
  // Single-PUT has no server-side state to abort; XHR.abort() in
  // uploadResumable handles the client side via the signal.
  return;
}
