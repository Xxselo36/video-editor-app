/**
 * Client-side video downscale via ffmpeg.wasm — cuts 4K uploads from
 * 200-400 MB to 30-50 MB before they hit the network.
 *
 * Requires Cross-Origin Isolation (COOP/COEP headers) for SharedArrayBuffer.
 * Configured in next.config.ts for /app/* routes only.
 *
 * Lazy-loads the WASM core (~30MB) on first use, then reuses the instance.
 * Fails soft: caller can catch and fall back to raw upload if this errors
 * (unsupported browser, WASM load failure, decode failure).
 */

import type { FFmpeg } from "@ffmpeg/ffmpeg";

let _ffmpeg: FFmpeg | null = null;
let _loading: Promise<FFmpeg> | null = null;

// Try multi-threaded WASM first (2-3x faster with SharedArrayBuffer),
// fall back to single-thread if COOP/COEP isn't in effect. Detection
// via `typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated`.
const WASM_CDN_MT =
  "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/umd";
const WASM_CDN_ST =
  "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;

  _loading = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");
    const ff = new FFmpeg();

    // Multi-thread requires SharedArrayBuffer + cross-origin isolation
    const canUseMT =
      typeof SharedArrayBuffer !== "undefined" &&
      typeof self !== "undefined" &&
      (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

    const cdn = canUseMT ? WASM_CDN_MT : WASM_CDN_ST;
    console.log(`[ffmpeg.wasm] loading ${canUseMT ? "multi" : "single"}-thread core`);

    const loadOpts: {
      coreURL: string;
      wasmURL: string;
      workerURL?: string;
    } = {
      coreURL: await toBlobURL(`${cdn}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${cdn}/ffmpeg-core.wasm`, "application/wasm"),
    };
    if (canUseMT) {
      loadOpts.workerURL = await toBlobURL(
        `${cdn}/ffmpeg-core.worker.js`,
        "text/javascript",
      );
    }
    await ff.load(loadOpts);
    _ffmpeg = ff;
    return ff;
  })();

  return _loading;
}

export type DownscaleProgress = {
  phase: "loading" | "decoding" | "done";
  pct: number; // 0-100
};

/**
 * Return true if the given file is big enough to be worth downscaling.
 * Threshold picked so ~1080p files stay untouched (fast upload already),
 * only 4K/large files pay the transcode cost.
 */
export function shouldDownscale(file: File): boolean {
  // > 100 MB = worth compressing. Under that, upload is fast enough.
  return file.size > 100 * 1024 * 1024;
}

/**
 * Downscale a video File to 1080p max long-side, H.264, AAC.
 * Returns a new File. Original file is unchanged.
 *
 * The caller should probably check shouldDownscale() first — running
 * this on already-small files wastes time.
 */
export async function downscaleVideo(
  file: File,
  onProgress?: (p: DownscaleProgress) => void,
): Promise<File> {
  onProgress?.({ phase: "loading", pct: 0 });
  const ff = await getFFmpeg();

  const inputName = "input" + (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4");
  const outputName = "output.mp4";

  // Wire progress from ffmpeg -> caller
  const onFfProgress = ({ progress }: { progress: number }) => {
    // ffmpeg's progress is 0-1
    onProgress?.({
      phase: "decoding",
      pct: Math.max(0, Math.min(100, Math.round(progress * 100))),
    });
  };
  ff.on("progress", onFfProgress);

  try {
    // Write input to ffmpeg's virtual filesystem
    const { fetchFile } = await import("@ffmpeg/util");
    await ff.writeFile(inputName, await fetchFile(file));

    // Downscale: longest side to 1920 (= 1080p in either orientation).
    // - preset ultrafast + CRF 26: cheapest H.264 encode, backend re-
    //   encodes anyway so quality loss here is invisible
    // - -threads 0: use all CPU cores (works with core-mt build)
    // - audio stream-copy: skip the AAC re-encode entirely, saves time
    // - -pix_fmt yuv420p: some iPhone videos are yuv420p10le (10-bit),
    //   the backend expects 8-bit for libx264 anyway
    await ff.exec([
      "-i", inputName,
      "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(ih,iw),min(1920,ih),-2)'",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
      "-threads", "0",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outputName,
    ]);

    const data = await ff.readFile(outputName);
    // data can be a Uint8Array (Node types) — wrap explicitly for File
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const newFile = new File(
      [blob],
      file.name.replace(/\.[a-z0-9]+$/i, "") + "_1080p.mp4",
      { type: "video/mp4", lastModified: Date.now() },
    );

    // Cleanup ffmpeg fs
    try {
      await ff.deleteFile(inputName);
      await ff.deleteFile(outputName);
    } catch {
      /* non-fatal */
    }

    onProgress?.({ phase: "done", pct: 100 });
    return newFile;
  } finally {
    ff.off("progress", onFfProgress);
  }
}
