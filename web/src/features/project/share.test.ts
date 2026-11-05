// UX11 Save / Share (review C13): navigator.share runs in the same task
// as the tap — no await before it, or iOS refuses to open the sheet.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as share from "./share";
import {
  CHROMIUM_SHARE_MAX_BYTES,
  FileFetch,
  SHARE_MAX_BYTES,
  canShareFiles,
  shareCap,
  shareFile,
  shareMode,
  waitToRetry,
} from "./share";

const file = () => new File([new Uint8Array([1, 2, 3])], "talk_cleocuts_9x16.mp4", { type: "video/mp4" });

function nav(share: (d: ShareData) => Promise<void>, canShare = true, userAgent?: string) {
  return { share: vi.fn(share), canShare: vi.fn(() => canShare), userAgent };
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const named = (name: string, message = "x") => new DOMException(message, name);

describe("shareFile", () => {
  it("calls navigator.share synchronously, before any microtask", () => {
    const n = nav(() => new Promise<void>(() => {}));
    let microtaskRan = false;
    void Promise.resolve().then(() => {
      microtaskRan = true;
    });
    void shareFile(file(), n);
    expect(n.share).toHaveBeenCalledTimes(1);
    expect(microtaskRan).toBe(false);
    const arg = n.share.mock.calls[0][0] as ShareData;
    expect(arg.files?.[0].name).toBe("talk_cleocuts_9x16.mp4");
  });

  // The owner's iPhone (2026-11): every rejection but AbortError used to
  // download the file instead (into Files). WebKit's answers, by name.
  it("tells shared, cancelled, busy, denied and failed apart", async () => {
    expect(await shareFile(file(), nav(async () => {}))).toBe("shared");
    // the user closed the sheet (WebKit's and Chromium's messages)
    expect(await shareFile(file(), nav(() => Promise.reject(named("AbortError", "Abort due to cancellation of share."))))).toBe(
      "cancelled",
    );
    expect(await shareFile(file(), nav(() => Promise.reject(named("AbortError", "Share canceled"))))).toBe("cancelled");
    // a sheet is open already, or the page isn't the active one
    expect(await shareFile(file(), nav(() => Promise.reject(named("InvalidStateError"))))).toBe("busy");
    // the browser refused it (the caller tells the gesture from the file)
    expect(await shareFile(file(), nav(() => Promise.reject(named("NotAllowedError"))))).toBe("denied");
    // this file can't be shared
    expect(await shareFile(file(), nav(() => Promise.reject(new TypeError("no"))))).toBe("failed");
    expect(await shareFile(file(), {})).toBe("failed");
    const throwing = { share: () => { throw new TypeError("bad"); } };
    expect(await shareFile(file(), throwing as never)).toBe("failed");
    const refusing = { share: () => { throw named("NotAllowedError"); } };
    expect(await shareFile(file(), refusing as never)).toBe("denied");
  });

  // Review F5: an AbortError the user didn't cause comes back on every
  // tap; the button would do nothing, silently.
  it("an AbortError because the browser couldn't read the file fails it", async () => {
    const unreadable = named("AbortError", "Abort due to error while reading files.");
    expect(await shareFile(file(), nav(() => Promise.reject(unreadable)))).toBe("failed");
    const internal = named("AbortError", "Internal error: could not connect to Web Share interface.");
    expect(await shareFile(file(), nav(() => Promise.reject(internal)))).toBe("failed");
  });

  it("never downloads the file itself: there is no download fallback any more", () => {
    expect("downloadUrl" in share).toBe(false);
  });
});

describe("shareMode", () => {
  it("shares files up to 250 MB on an iPhone or iPad (WebKit: the page's memory), else downloads", () => {
    const n = nav(async () => {}, true, IPHONE);
    expect(canShareFiles(n)).toBe(true);
    expect(shareCap(n)).toBe(SHARE_MAX_BYTES);
    expect(shareMode(12_000_000, n)).toBe("share");
    expect(shareMode(120_000_000, n)).toBe("share");
    expect(shareMode(SHARE_MAX_BYTES + 1, n)).toBe("download");
    expect(shareMode(null, n)).toBe("download");
    expect(shareMode(12_000_000, nav(async () => {}, false, IPHONE))).toBe("download");
    expect(shareMode(12_000_000, {})).toBe("download");
    expect(shareMode(12_000_000, undefined)).toBe("download");
    // iPadOS reports a Mac
    const ipad = { ...nav(async () => {}, true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), platform: "MacIntel", maxTouchPoints: 5 };
    expect(shareMode(120_000_000, ipad)).toBe("share");
  });

  // Review F2: Chromium refuses to share more than 50 MiB (NotAllowedError
  // from a real tap) while canShare() says yes: Android's "Save / Share…"
  // did nothing on every tap. Such a file is a plain Download there.
  it("off iOS, up to Chromium's 50 MiB only", () => {
    const n = nav(async () => {}, true, ANDROID);
    expect(shareCap(n)).toBe(CHROMIUM_SHARE_MAX_BYTES);
    expect(CHROMIUM_SHARE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(shareMode(12_000_000, n)).toBe("share");
    expect(shareMode(CHROMIUM_SHARE_MAX_BYTES, n)).toBe("share");
    expect(shareMode(CHROMIUM_SHARE_MAX_BYTES + 1, n)).toBe("download");
    expect(shareMode(60 * 1024 * 1024, n)).toBe("download");
  });
});

// PR2 live test (D2): "Video sichern" on an iPhone shared nothing. A
// fetch() of /download follows its 307 to the bucket redirect-tainted
// (Origin: null), which the bucket's CORS rules refuse, so the page
// asks the API where the file is and fetches it there.
describe("FileFetch", () => {
  const HREF = "https://api.test/jobs/j1/download?format=primary&name=v2&v=2";
  const STORAGE = "https://acct.r2.cloudflarestorage.com/media/jobs/j1/r2/primary.mp4?X-Amz-Signature=abc";
  const mp4 = (n: number) => new Response(new Blob([new Uint8Array(n)], { type: "video/mp4" }));
  const where = (url = STORAGE) => Response.json({ url, name: "talk_cleocuts_9x16.mp4" });

  /** A body that arrives in `pieces` (their sizes, one per read), from
   *  byte `from` of a file whose byte i is i % 251; then, if `breaks`, a
   *  network error (after every piece was read). */
  function streamed(
    pieces: number[],
    { headers = {}, status = 200, from = 0, breaks = false }: { headers?: Record<string, string>; status?: number; from?: number; breaks?: boolean } = {},
  ): Response {
    let at = from;
    const left = [...pieces];
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const n = left.shift();
        if (n === undefined) {
          if (breaks) c.error(new TypeError("Load failed"));
          else c.close();
          return;
        }
        c.enqueue(Uint8Array.from({ length: n }, (_, i) => (at + i) % 251));
        at += n;
      },
    });
    return new Response(body, { status, headers: { "content-type": "video/mp4", ...headers } });
  }

  /** fetch() answering `answers` in turn; the calls as they were made. */
  function fakeFetch(answers: (Response | Error)[]): [string, RequestInit | undefined][] {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push([String(url), init]);
        const next = answers.shift();
        if (!next) throw new TypeError("Failed to fetch");
        if (next instanceof Error) throw next;
        return next;
      }),
    );
    return calls;
  }

  const range = (init: RequestInit | undefined) => new Headers(init?.headers).get("range");
  const bytesOf = async (f: File) => [...new Uint8Array(await f.arrayBuffer())];
  const expected = (n: number) => Array.from({ length: n }, (_, i) => i % 251);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks the API where the file is first, then fetches it from the storage, without credentials, both at low priority", async () => {
    const calls = fakeFetch([where(), mp4(3)]);
    const ctrl = new AbortController();
    const f = await new FileFetch(HREF, "talk_cleocuts_9x16.mp4").next(ctrl.signal);
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, STORAGE]);
    // never the HTTP cache's answer to the question (a deploy's old 307)
    expect(calls[0][1]).toMatchObject({ cache: "no-store", signal: ctrl.signal, priority: "low" });
    // straight, with the page's Origin: no redirect, no credentials, no range
    expect(calls[1][1]).toMatchObject({ credentials: "omit", signal: ctrl.signal, priority: "low" });
    expect(range(calls[1][1])).toBeNull();
    expect([f.name, f.type, f.size]).toEqual(["talk_cleocuts_9x16.mp4", "video/mp4", 3]);
  });

  it("local storage: the API's own /download, fetched like any API call, at low priority", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.test");
    const local = "/jobs/j1/download?format=primary&name=v2&v=2";
    const calls = fakeFetch([where(local), mp4(2)]);
    const f = await new FileFetch(HREF, "talk.mp4").next();
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, `https://api.test${local}`]);
    expect(calls[1][1]?.credentials).toBeUndefined();
    expect(calls[1][1]?.priority).toBe("low");
    expect(f.size).toBe(2);
  });

  it("fails without fetching a file when the API doesn't say where it is", async () => {
    // not ready (409)
    let calls = fakeFetch([new Response('{"detail":"requested format not ready"}', { status: 409 })]);
    await expect(new FileFetch(HREF, "x.mp4").next()).rejects.toThrow("409");
    expect(calls).toHaveLength(1);
    // an API from before as=url: the file itself (local), not its URL
    calls = fakeFetch([mp4(4)]);
    await expect(new FileFetch(HREF, "x.mp4").next()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    // no url in the answer
    calls = fakeFetch([Response.json({ name: "x.mp4" })]);
    await expect(new FileFetch(HREF, "x.mp4").next()).rejects.toThrow("no url");
    expect(calls).toHaveLength(1);
  });

  // "Wird vorbereitet… 42 %": the body is read piece by piece.
  it("tells how much of the file is here after each piece, of the Content-Length", async () => {
    fakeFetch([where(), streamed([2, 2, 2], { headers: { "content-length": "6" } })]);
    const seen: [number, number | null][] = [];
    const f = await new FileFetch(HREF, "x.mp4", 999).next(undefined, (loaded, total) => seen.push([loaded, total]));
    expect(seen).toEqual([
      [2, 6],
      [4, 6],
      [6, 6],
    ]);
    expect([f.type, f.size]).toEqual(["video/mp4", 6]);
    expect(await bytesOf(f)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("without a Content-Length, of the size the job lists; without either, of an unknown total", async () => {
    fakeFetch([where(), streamed([3, 1])]);
    const seen: [number, number | null][] = [];
    await new FileFetch(HREF, "x.mp4", 4).next(undefined, (loaded, total) => seen.push([loaded, total]));
    expect(seen).toEqual([
      [3, 4],
      [4, 4],
    ]);
    fakeFetch([where(), streamed([3])]);
    seen.length = 0;
    await new FileFetch(HREF, "x.mp4").next(undefined, (loaded, total) => seen.push([loaded, total]));
    expect(seen).toEqual([[3, null]]);
  });

  it("a large file, folded into a Blob every few MB while it is read: every byte in its place", async () => {
    const MB = 1024 * 1024;
    const pieces = [3 * MB, 3 * MB, 3 * MB + 7, 3 * MB, 1];
    const size = pieces.reduce((a, b) => a + b, 0);
    fakeFetch([where(), streamed(pieces, { headers: { "content-length": String(size) } })]);
    const f = await new FileFetch(HREF, "x.mp4").next();
    expect(f.size).toBe(size);
    const bytes = new Uint8Array(await f.arrayBuffer());
    for (const i of [0, 3 * MB - 1, 3 * MB, 6 * MB, 9 * MB + 6, 9 * MB + 7, size - 1]) expect(bytes[i], `byte ${i}`).toBe(i % 251);
  });

  // Review F4: each try fetched the whole file again from byte 0 (on an
  // iPhone that cut the request in the background: up to 3x 250 MB).
  it("a try that breaks off: the next asks for the rest only and adds it, every byte in its place", async () => {
    const calls = fakeFetch([
      where(),
      streamed([400, 500], { headers: { "content-length": "1000" }, breaks: true }),
      streamed([100], { status: 206, from: 900, headers: { "content-length": "100", "content-range": "bytes 900-999/1000" } }),
    ]);
    const fetcher = new FileFetch(HREF, "x.mp4", 1000);
    const seen: number[] = [];
    await expect(fetcher.next(undefined, (loaded) => seen.push(loaded))).rejects.toThrow("Load failed");
    expect(fetcher.progress).toEqual({ loaded: 900, total: 1000 });
    const f = await fetcher.next(undefined, (loaded) => seen.push(loaded));
    // the address asked once; the second fetch for the rest
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, STORAGE, STORAGE]);
    expect(calls.map(([, init]) => range(init))).toEqual([null, null, "bytes=900-"]);
    expect(seen).toEqual([400, 900, 1000]);
    expect(f.size).toBe(1000);
    expect(await bytesOf(f)).toEqual(expected(1000));
  });

  it("the local API's range: its Content-Range unseen (not exposed), the 206 taken for the rest", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.test");
    const local = "/jobs/j1/download?format=primary&name=v2&v=2";
    const calls = fakeFetch([where(local), streamed([600], { breaks: true }), streamed([400], { status: 206, from: 600 })]);
    const fetcher = new FileFetch(HREF, "x.mp4", 1000);
    await expect(fetcher.next()).rejects.toThrow();
    const f = await fetcher.next();
    expect(range(calls[2][1])).toBe("bytes=600-");
    expect(await bytesOf(f)).toEqual(expected(1000));
  });

  it("a whole file (200) for the rest: starts over with it", async () => {
    fakeFetch([where(), streamed([500], { breaks: true }), streamed([1000], { headers: { "content-length": "1000" } })]);
    const fetcher = new FileFetch(HREF, "x.mp4", 1000);
    await expect(fetcher.next()).rejects.toThrow();
    const f = await fetcher.next();
    expect(await bytesOf(f)).toEqual(expected(1000));
  });

  it("a range that starts elsewhere, or of a file of another size: starts over (never a mix of two files)", async () => {
    let calls = fakeFetch([
      where(),
      streamed([500], { headers: { "content-length": "1000" }, breaks: true }),
      streamed([10], { status: 206, from: 400, headers: { "content-range": "bytes 400-409/1000" } }),
      streamed([1000], { headers: { "content-length": "1000" } }),
    ]);
    let fetcher = new FileFetch(HREF, "x.mp4");
    await expect(fetcher.next()).rejects.toThrow();
    await expect(fetcher.next()).rejects.toThrow("another range");
    let f = await fetcher.next();
    expect(calls.map(([, init]) => range(init))).toEqual([null, null, "bytes=500-", null]);
    expect(await bytesOf(f)).toEqual(expected(1000));
    calls = fakeFetch([
      where(),
      streamed([500], { headers: { "content-length": "1000" }, breaks: true }),
      streamed([700], { status: 206, from: 500, headers: { "content-range": "bytes 500-1199/1200" } }),
      streamed([1200], { headers: { "content-length": "1200" } }),
    ]);
    fetcher = new FileFetch(HREF, "x.mp4");
    await expect(fetcher.next()).rejects.toThrow();
    await expect(fetcher.next()).rejects.toThrow("another range");
    f = await fetcher.next();
    expect(f.size).toBe(1200);
  });

  it("a body shorter than its size: not taken, the next try starts over", async () => {
    fakeFetch([where(), streamed([600], { headers: { "content-length": "1000" } }), streamed([1000], { headers: { "content-length": "1000" } })]);
    const fetcher = new FileFetch(HREF, "x.mp4");
    await expect(fetcher.next()).rejects.toThrow("short");
    expect(fetcher.progress.loaded).toBe(0);
    expect((await fetcher.next()).size).toBe(1000);
  });

  it("the storage refuses the address (a presigned URL expired): the next try asks for it again, and goes on", async () => {
    const calls = fakeFetch([
      where(),
      streamed([300], { headers: { "content-length": "1000" }, breaks: true }),
      new Response("", { status: 403 }),
      where(`${STORAGE}&fresh=1`),
      streamed([700], { status: 206, from: 300, headers: { "content-range": "bytes 300-999/1000" } }),
    ]);
    const fetcher = new FileFetch(HREF, "x.mp4");
    await expect(fetcher.next()).rejects.toThrow("Load failed");
    await expect(fetcher.next()).rejects.toThrow("403");
    const f = await fetcher.next();
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, STORAGE, STORAGE, `${HREF}&as=url`, `${STORAGE}&fresh=1`]);
    expect(range(calls[4][1])).toBe("bytes=300-");
    expect(await bytesOf(f)).toEqual(expected(1000));
  });

  it("stopped (aborted) while the body comes: what arrived stays, the next try goes on", async () => {
    let feed: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        feed = c;
        c.enqueue(Uint8Array.from({ length: 250 }, (_, i) => i % 251));
      },
    });
    const calls = fakeFetch([
      where(),
      new Response(body, { headers: { "content-length": "1000" } }),
      streamed([750], { status: 206, from: 250, headers: { "content-range": "bytes 250-999/1000" } }),
    ]);
    const ctrl = new AbortController();
    const fetcher = new FileFetch(HREF, "x.mp4");
    const first = fetcher.next(ctrl.signal, (loaded) => {
      if (loaded === 250) {
        ctrl.abort("held");
        feed?.error(new DOMException("held", "AbortError"));
      }
    });
    await expect(first).rejects.toThrow();
    expect(fetcher.progress.loaded).toBe(250);
    const f = await fetcher.next();
    expect(range(calls[2][1])).toBe("bytes=250-");
    expect(await bytesOf(f)).toEqual(expected(1000));
  });
});

// The owner's iPhone (2026-11): a try waits while the page is hidden.
describe("waitToRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A page whose visibility the test sets (document's hidden + visibilitychange). */
  function fakePage(hidden = false) {
    const page = Object.assign(new EventTarget(), { hidden });
    const show = () => {
      page.hidden = false;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    return { page, show };
  }

  it("waits its time, then until the page shows again", async () => {
    vi.useFakeTimers();
    const { page, show } = fakePage(true);
    let over = false;
    void waitToRetry(2_000, new AbortController().signal, page).then(() => (over = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(over).toBe(false);
    // another page event changes nothing while it stays hidden
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(over).toBe(false);
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toBe(true);
    // a visible page: just the time
    over = false;
    void waitToRetry(2_000, new AbortController().signal, fakePage().page).then(() => (over = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(over).toBe(true);
  });

  it("an abort ends it at once, while waiting or hidden", async () => {
    vi.useFakeTimers();
    for (const hidden of [false, true]) {
      const ctrl = new AbortController();
      const caught = waitToRetry(2_000, ctrl.signal, fakePage(hidden).page).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(hidden ? 3_000 : 1_000);
      ctrl.abort(named("AbortError"));
      expect(((await caught) as Error).name).toBe("AbortError");
    }
  });
});
