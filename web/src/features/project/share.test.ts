// UX11 Save / Share (review C13): navigator.share runs in the same task
// as the tap — no await before it, or iOS refuses to open the sheet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHARE_MAX_BYTES, canShareFiles, prefetchFile, shareFile, shareMode } from "./share";

const file = () => new File([new Uint8Array([1, 2, 3])], "talk_cleocuts_9x16.mp4", { type: "video/mp4" });

function nav(share: (d: ShareData) => Promise<void>, canShare = true) {
  return { share: vi.fn(share), canShare: vi.fn(() => canShare) };
}

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

  it("tells shared, cancelled (AbortError) and failed apart", async () => {
    expect(await shareFile(file(), nav(async () => {}))).toBe("shared");
    const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
    expect(await shareFile(file(), nav(() => Promise.reject(abort)))).toBe("cancelled");
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    expect(await shareFile(file(), nav(() => Promise.reject(denied)))).toBe("failed");
    expect(await shareFile(file(), {})).toBe("failed");
    const throwing = { share: () => { throw new TypeError("bad"); } };
    expect(await shareFile(file(), throwing as never)).toBe("failed");
  });
});

describe("shareMode", () => {
  it("shares files up to 250 MB where the browser can, else downloads", () => {
    const n = nav(async () => {});
    expect(canShareFiles(n)).toBe(true);
    expect(shareMode(12_000_000, n)).toBe("share");
    expect(shareMode(SHARE_MAX_BYTES + 1, n)).toBe("download");
    expect(shareMode(null, n)).toBe("download");
    expect(shareMode(12_000_000, nav(async () => {}, false))).toBe("download");
    expect(shareMode(12_000_000, {})).toBe("download");
    expect(shareMode(12_000_000, undefined)).toBe("download");
  });
});

// PR2 live test (D2): "Video sichern" on an iPhone shared nothing. A
// fetch() of /download follows its 307 to the bucket redirect-tainted
// (Origin: null), which the bucket's CORS rules refuse, so the page
// asks the API where the file is and fetches it there.
describe("prefetchFile", () => {
  const HREF = "https://api.test/jobs/j1/download?format=primary&name=v2&v=2";
  const STORAGE = "https://acct.r2.cloudflarestorage.com/media/jobs/j1/r2/primary.mp4?X-Amz-Signature=abc";
  const mp4 = (n: number) => new Response(new Blob([new Uint8Array(n)], { type: "video/mp4" }));

  /** fetch() answering `answers` in turn; the calls as they were made. */
  function fakeFetch(answers: Response[]): [string, RequestInit | undefined][] {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push([String(url), init]);
        const next = answers.shift();
        if (!next) throw new TypeError("Failed to fetch");
        return next;
      }),
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks the API where the file is first, then fetches it from the storage, without credentials", async () => {
    const calls = fakeFetch([Response.json({ url: STORAGE, name: "talk_cleocuts_9x16.mp4" }), mp4(3)]);
    const ctrl = new AbortController();
    const f = await prefetchFile(HREF, "talk_cleocuts_9x16.mp4", ctrl.signal);
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, STORAGE]);
    // never the HTTP cache's answer to the question (a deploy's old 307)
    expect(calls[0][1]).toMatchObject({ cache: "no-store", signal: ctrl.signal });
    // straight, with the page's Origin: no redirect, no credentials
    expect(calls[1][1]).toMatchObject({ credentials: "omit", signal: ctrl.signal });
    expect([f.name, f.type, f.size]).toEqual(["talk_cleocuts_9x16.mp4", "video/mp4", 3]);
  });

  it("local storage: the API's own /download, fetched like any API call", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.test");
    const local = "/jobs/j1/download?format=primary&name=v2&v=2";
    const calls = fakeFetch([Response.json({ url: local, name: "talk.mp4" }), mp4(2)]);
    const f = await prefetchFile(HREF, "talk.mp4");
    expect(calls.map(([url]) => url)).toEqual([`${HREF}&as=url`, `https://api.test${local}`]);
    expect(calls[1][1]?.credentials).toBeUndefined();
    expect(f.size).toBe(2);
  });

  it("fails without fetching a file when the API doesn't say where it is (the caller downloads it)", async () => {
    // not ready (409)
    let calls = fakeFetch([new Response('{"detail":"requested format not ready"}', { status: 409 })]);
    await expect(prefetchFile(HREF, "x.mp4")).rejects.toThrow("409");
    expect(calls).toHaveLength(1);
    // an API from before as=url: the file itself (local), not its URL
    calls = fakeFetch([mp4(4)]);
    await expect(prefetchFile(HREF, "x.mp4")).rejects.toThrow();
    expect(calls).toHaveLength(1);
    // no url in the answer
    calls = fakeFetch([Response.json({ name: "x.mp4" })]);
    await expect(prefetchFile(HREF, "x.mp4")).rejects.toThrow("no url");
    expect(calls).toHaveLength(1);
    // the storage refuses the file
    calls = fakeFetch([Response.json({ url: STORAGE }), new Response("", { status: 403 })]);
    await expect(prefetchFile(HREF, "x.mp4")).rejects.toThrow("403");
    expect(calls).toHaveLength(2);
  });
});
