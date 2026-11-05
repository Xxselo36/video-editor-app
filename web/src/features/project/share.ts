/**
 * "Save / Share…" on phones (UX11, review C13): the Web Share API with
 * the video FILE, so iOS offers "Save Video" (Photos) and the TikTok /
 * Instagram apps directly.
 *
 * iOS Safari only opens the share sheet from a user gesture with no
 * `await` between the tap and navigator.share(): the file is fetched
 * ahead (FileFetch; its tries and pauses: done/useShareFile; the button
 * says "Preparing… 42 %") and the tap handler calls shareFile()
 * synchronously. Above shareCap or without file sharing the page offers
 * a plain Download. Nothing here downloads by itself: a file that can't
 * be fetched or shared ends as "failed", and the page offers Download
 * with a note (the owner's iPhone, 2026-11: a share that fell back to a
 * download landed in Files, not in Photos).
 */
import { apiFetch } from "@/lib/api";
import { isIOS, type NavigatorLike } from "@/features/start/ios";

/** WebKit (every iOS browser) shares a file of any size: this cap is
 *  the page's memory (the file is held as a Blob until the tap). */
export const SHARE_MAX_BYTES = 250 * 1024 * 1024;
/** Chromium (Android, ChromeOS, Windows) shares at most 50 MiB of files
 *  and refuses more with NotAllowedError, from a real tap too, while
 *  canShare() says yes (navigator_share.cc kMaxSharedFileBytes). */
export const CHROMIUM_SHARE_MAX_BYTES = 50 * 1024 * 1024;

type ShareNav = Pick<Navigator, "share" | "canShare">;
type Nav = Partial<ShareNav & NavigatorLike>;

/** Can this browser share a video file? (A tiny probe file.) */
export function canShareFiles(nav: Partial<ShareNav> | undefined = globalThis.navigator): boolean {
  try {
    if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.mp4", { type: "video/mp4" });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** The largest file this browser shares: WebKit's cap on iOS (the only
 *  engine there), Chromium's anywhere else (the phones and tablets that
 *  share files besides iOS run it). */
export function shareCap(nav: Nav | undefined = globalThis.navigator): number {
  return isIOS(nav as NavigatorLike | undefined) ? SHARE_MAX_BYTES : CHROMIUM_SHARE_MAX_BYTES;
}

/** share: prefetch and offer the share sheet; download: a plain link. */
export function shareMode(bytes: number | null | undefined, nav: Nav | undefined = globalThis.navigator): "share" | "download" {
  if (!canShareFiles(nav)) return "download";
  if (bytes == null || bytes <= 0 || bytes > shareCap(nav)) return "download";
  return "share";
}

/** How much of the file is here: bytes read, and of how many (null: unknown). */
export type OnProgress = (loaded: number, total: number | null) => void;

/** The body is folded into a Blob every this many bytes while it is read. */
const FOLD_BYTES = 8 * 1024 * 1024;

/** The first byte and the size of a 206's Content-Range ("bytes 100-999/1000");
 *  null when the browser doesn't show it (an API that doesn't expose it). */
function contentRange(r: Response): { start: number; size: number | null } | null {
  const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(r.headers.get("content-range") ?? "");
  return m ? { start: Number(m[1]), size: m[2] === "*" ? null : Number(m[2]) } : null;
}

/**
 * The rendered file, as a File for shareFile, fetched in tries (`next`)
 * that each go on where the last one stopped. `href`: its GET /download
 * (done/useShareFile downloadHref). The API says where the file is first
 * (as=url): a fetch() of /download itself follows its redirect to the
 * storage, redirect-tainted (Origin: null), which the bucket's CORS
 * rules refuse (the PR2 live test's iPhone). From the storage straight,
 * without credentials (the page's own Origin, which the bucket allows);
 * a URL of the API itself (local storage) like any API call. The address
 * is asked once, and again after the storage refused it (a presigned
 * URL that expired).
 *
 * What a try read stays when it fails or is stopped: the next one asks
 * for the rest only (Range: bytes=N-; the bucket and the API answer
 * 206), so an iPhone that cut the request of a page in the background,
 * or a pause while the video plays, doesn't fetch 100 MB again from its
 * start. A whole file (200) instead, or a range that doesn't fit, starts
 * it over. Both requests go at low priority (a hint to the browser).
 * `onProgress` after each piece of the body; its total is the answer's
 * size where the browser shows it, else `bytes` (what the job lists).
 */
export class FileFetch {
  private url: string | null = null;
  private parts: Blob[] = [];
  private loaded = 0;
  /** The file's size by an answer's headers (null: none said it). */
  private size: number | null = null;
  private type = "";

  constructor(
    private readonly href: string,
    private readonly name: string,
    private readonly bytes: number | null = null,
  ) {}

  /** Bytes read so far, and of how many (null: unknown). */
  get progress(): { loaded: number; total: number | null } {
    return { loaded: this.loaded, total: this.size ?? this.bytes };
  }

  private restart() {
    this.parts = [];
    this.loaded = 0;
    this.size = null;
  }

  /** One try: the file, or a rejection (what it read stays for the next). */
  async next(signal?: AbortSignal, onProgress?: OnProgress): Promise<File> {
    if (this.url === null) {
      const asked = await fetch(`${this.href}${this.href.includes("?") ? "&" : "?"}as=url`, {
        signal,
        cache: "no-store",
        priority: "low",
      });
      if (!asked.ok) throw new Error(`prefetch failed (${asked.status})`);
      const { url } = (await asked.json()) as { url?: unknown };
      if (typeof url !== "string" || !url) throw new Error("prefetch failed (no url)");
      this.url = url;
    }
    const from = this.loaded;
    const init: RequestInit = { signal, priority: "low", ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}) };
    const r = /^\/(?!\/)/.test(this.url)
      ? await apiFetch(this.url, init)
      : await fetch(this.url, { ...init, credentials: "omit" });
    if (r.status === 206 && from > 0) {
      // The rest of the file: unless the answer says it starts elsewhere
      // or is of another file (a new size), which starts it over.
      const range = contentRange(r);
      const length = Number(r.headers.get("content-length")) || null;
      const size = range?.size ?? (length !== null ? from + length : null);
      if ((range && range.start !== from) || (size !== null && this.size !== null && size !== this.size)) {
        this.restart();
        throw new Error("prefetch failed (another range)");
      }
      this.size = size ?? this.size;
    } else if (r.ok && r.status !== 206) {
      // The whole file (the first try, or a server that ignored the range).
      this.restart();
      this.size = Number(r.headers.get("content-length")) || null;
    } else {
      // Refused: the address is asked again next time (a presigned URL
      // expires); a range that doesn't fit (416) starts the file over.
      if (r.status === 416 || r.status === 206) this.restart();
      else this.url = null;
      throw new Error(`prefetch failed (${r.status})`);
    }
    this.type = r.headers.get("content-type") || this.type;
    await this.read(r, onProgress);
    if (this.size !== null && this.loaded !== this.size) {
      this.restart();
      throw new Error("prefetch failed (short)");
    }
    const file = new File(this.parts, this.name, { type: this.type.split(";")[0] || "video/mp4" });
    this.restart();
    return file;
  }

  /** The body onto what is here, piece by piece where the browser can
   *  (onProgress after each), folded into a Blob every FOLD_BYTES: the
   *  pieces never pile up into a second copy of the file. What arrived
   *  before a failure is kept. */
  private async read(r: Response, onProgress?: OnProgress): Promise<void> {
    const reader = r.body?.getReader();
    if (!reader) {
      const blob = await r.blob();
      this.parts.push(blob);
      this.loaded += blob.size;
      onProgress?.(this.loaded, this.progress.total);
      return;
    }
    let pieces: Uint8Array<ArrayBuffer>[] = [];
    let held = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pieces.push(value);
        held += value.byteLength;
        this.loaded += value.byteLength;
        if (held >= FOLD_BYTES) {
          this.parts.push(new Blob(pieces));
          pieces = [];
          held = 0;
        }
        onProgress?.(this.loaded, this.progress.total);
      }
    } finally {
      if (held > 0) this.parts.push(new Blob(pieces));
    }
  }
}

/** The waits before the second and the third try of a fetch that failed. */
export const RETRY_WAITS_MS: readonly number[] = [2_000, 6_000];

/** Whether the page is in view (document). */
export type PageVisibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** `ms`, then, if the page is hidden by then, until it shows again (iOS
 *  cuts the requests of a page in the background); rejects with the
 *  abort's reason when `signal` aborts. */
export function waitToRetry(ms: number, signal: AbortSignal, page: PageVisibility | undefined = globalThis.document): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const check = () => {
      if (page?.hidden) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      page?.addEventListener("visibilitychange", check);
      check();
    }, ms);
    signal.addEventListener("abort", abort);
    function cleanup() {
      clearTimeout(timer);
      page?.removeEventListener("visibilitychange", check);
      signal.removeEventListener("abort", abort);
    }
  });
}

/**
 * What became of a share (navigator.share's answer; WebKit's and
 * Chromium's names and messages):
 *   shared     the user picked a target
 *   cancelled  AbortError: the user closed the sheet; the next tap tries again
 *   busy       InvalidStateError: a sheet is open already, or the page
 *              isn't the active one
 *   denied     NotAllowedError: the browser refused it. Without the tap
 *              counted that is the gesture (the next tap shares); with
 *              it, a refusal of this file (Chromium over 50 MiB): the
 *              caller tells them apart (done/useShareFile)
 *   failed     anything else: this file can't be shared (TypeError), or
 *              the browser couldn't read it (WebKit's AbortError "Abort
 *              due to error while reading files.", Chromium's "Internal
 *              error: …"), which every later tap would repeat
 */
export type ShareOutcome = "shared" | "cancelled" | "busy" | "denied" | "failed";

function outcomeOf(e: unknown): ShareOutcome {
  const { name, message } = (e ?? {}) as { name?: unknown; message?: unknown };
  if (name === "AbortError") return /reading files|internal error/i.test(String(message ?? "")) ? "failed" : "cancelled";
  if (name === "InvalidStateError") return "busy";
  return name === "NotAllowedError" ? "denied" : "failed";
}

/**
 * Open the share sheet for `file` — call it straight from the click
 * handler: navigator.share runs in the same task (no microtask before
 * it). The returned promise settles with what happened.
 */
export function shareFile(file: File, nav: Partial<ShareNav> | undefined = globalThis.navigator): Promise<ShareOutcome> {
  let started: Promise<void>;
  try {
    if (!nav || typeof nav.share !== "function") return Promise.resolve("failed");
    started = nav.share({ files: [file], title: file.name });
  } catch (e) {
    return Promise.resolve(outcomeOf(e));
  }
  return started.then(() => "shared" as const, outcomeOf);
}
