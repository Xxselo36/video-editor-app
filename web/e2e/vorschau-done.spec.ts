/**
 * The Vorschau's done page after the owner's report (2026-11, an iPhone,
 * Safari, a 47 s video from the iPhone camera: the frame showed no
 * picture, and "Video sichern" ended as a download into Files):
 *
 *   picture   before a tap the frame shows the first still that really
 *             decodes: the export's thumbnail, else the analysis' poster
 *             (a thumbnail that isn't a JPEG, or none: 404); only a still
 *             that decoded is ever the video's poster (WebKit loads no
 *             other poster once one failed). Neither: the video's first
 *             frame through #t=0.001 (iOS paints none before play, nor
 *             does Chromium on a phone), never once the video was started
 *   start     "Video sichern" of an export finished during the visit is
 *             fetched once the frame has its picture, or 2.5 s after done
 *   playing   that fetch holds while the video plays ("Save video" again)
 *             and goes on from where it stopped (Range) once it stops
 *   retries   a file fetch that fails is tried twice more, each going on
 *             from where the last stopped: ready, and one tap shares it;
 *             one that keeps failing: Download with a note (Files, not
 *             Photos), nothing downloaded or shared by itself
 *   progress  "Preparing… 42%" while the file comes in
 *   Android   the editor's Save / Share: a file Chromium refuses (over its
 *             50 MiB) fails with a note, never a dead button; a file over
 *             50 MiB is a plain Download there (an iPhone shares it)
 *
 * Desktop and pixel7 of a v2 build (E2E_EDITOR_V2=1), once with local
 * media (the anonymous run) and once on R2 (E2E_MODE=r2: the stills and
 * the file come from moto through the API's redirects).
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Locator, Page, Request } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { API, WEB } from "./support/env";
import {
  fakeShareSheet,
  holdRequests,
  IPHONE_UA,
  openVorschau,
  sharedFiles,
  sharedOnce,
  tapStillActive,
  TOUR_DONE,
  vorschau,
} from "./support/vorschau";

type Store = "local" | "r2";

/** The Vorschau's note (iPhone / iPad) and the editor Done view's. */
const SAVE_FAILED = "Couldn't get the video ready for Photos. Download saves it to Files instead.";
const SHARE_FAILED = "Couldn't get the video ready to share. Download it instead.";

/** The stub's media, as the block expects; R2: moto's origin. */
async function storageOf(stub: Stub, store: Store): Promise<string | null> {
  const info = await stub.info();
  expect(info.r2, `the stub's media: r2=${info.r2}, this block: ${store}`).toBe(store === "r2");
  return info.r2_endpoint;
}

const frame = (page: Page) => page.getByTestId("preview-frame");
const video = (page: Page) => page.getByTestId("preview-video");

/** The job's /thumbnail or /poster answers 200 image/jpeg with a body that
 *  is no JPEG ("garbage"), or 404 with an empty body. */
async function breakStill(page: Page, jobId: string, still: "thumbnail" | "poster", how: "garbage" | "404") {
  await page.route(
    (u) => u.pathname === `/jobs/${jobId}/${still}`,
    (r) =>
      how === "404"
        ? r.fulfill({ status: 404, headers: { "Cache-Control": "no-store" }, body: "" })
        : r.fulfill({ status: 200, contentType: "image/jpeg", body: "this is not a JPEG" }),
  );
}

/** No frame of the video before a tap, as on an iPhone (preload="metadata"):
 *  the frame shows only what its poster does. */
async function noFrameBeforeTap(page: Page, jobId: string) {
  await page.route((u) => u.pathname === `/jobs/${jobId}/watch`, (r) => r.abort());
}

/**
 * The spread of luma (max − min, 0..255) over the frame as painted, but
 * its edges and the play button (64 px round its centre at 40 %
 * of the height): a few units for an empty frame (one flat colour under
 * the soft shade at its foot), far more for any picture, also a
 * letterboxed one.
 */
async function lumaSpread(el: Locator): Promise<number> {
  const box = (await el.boundingBox())!;
  const img = await loadImage(await el.screenshot());
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = img.width / box.width;
  // its rounded corners (16 px) lie inside 8 px from each edge
  const edge = Math.ceil(8 * px);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const [bx, by, br] = [img.width / 2, img.height * 0.4, 40 * px];
  let min = 255;
  let max = 0;
  for (let y = edge; y < img.height - edge; y++) {
    for (let x = edge; x < img.width - edge; x++) {
      if (Math.abs(x - bx) < br && Math.abs(y - by) < br) continue;
      const i = (y * img.width + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
  }
  return Math.round(max - min);
}

/** The page's fetch()es of the export's file itself (not the as=url
 *  question): to the API's /download (local media) or to the storage. */
function isFileFetch(u: URL, jobId: string, storage: string | null): boolean {
  if (storage && u.href.startsWith(storage)) return true;
  return `${u.origin}` === API && u.pathname === `/jobs/${jobId}/download` && !u.searchParams.has("as");
}

/** The first `fails` fetches of the file fail (a network error), then it
 *  comes; the count of file fetches so far. */
async function failFileFetches(page: Page, jobId: string, storage: string | null, fails: number) {
  const seen = { n: 0 };
  await page.route(
    (u) => isFileFetch(u, jobId, storage),
    (r) => {
      if (r.request().resourceType() !== "fetch") return r.fallback();
      seen.n++;
      return seen.n <= fails ? r.abort("failed") : r.fallback();
    },
  );
  return seen;
}

/** The as=url questions the page asked about the job's /download. */
function askedWhere(page: Page, jobId: string): number[] {
  const at: number[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === `/jobs/${jobId}/download` && u.searchParams.get("as") === "url") at.push(Date.now());
  });
  return at;
}

/**
 * A file that comes slowly: a server of this test sends `sent` of its
 * `size` bytes (with Content-Length and CORS for the page), then holds
 * the rest until release(). The API's as=url answer points the page there.
 */
async function slowFile(page: Page, jobId: string, size: number, sent: number) {
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(size), "Access-Control-Allow-Origin": "*" });
    const chunk = 64 * 1024;
    for (let at = 0; at < sent; at += chunk) res.write(Buffer.alloc(Math.min(chunk, sent - at), 7));
    void released.then(() => res.end(Buffer.alloc(size - sent, 7)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/primary.mp4`;
  await page.route(
    (u) => u.pathname === `/jobs/${jobId}/download` && u.searchParams.get("as") === "url",
    (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": WEB }, body: JSON.stringify({ url }) }),
  );
  return {
    release,
    close: () => {
      release();
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * A file of `size` bytes (byte i is i % 251) from a server of this test
 * that answers ranges as the bucket does (206, Content-Range; CORS for
 * the page, the range header allowed): the first request gets `sent`
 * bytes, then its connection breaks off. The API's as=url answer points
 * the page there. `ranges`: each GET's Range header (null: none).
 */
async function breakingFile(page: Page, jobId: string, size: number, sent: number) {
  const body = Buffer.from(Uint8Array.from({ length: size }, (_, i) => i % 251));
  const ranges: (string | null)[] = [];
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET" });
      return res.end();
    }
    const range = req.headers.range ?? null;
    ranges.push(range);
    const from = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? NaN) : 0;
    if (!Number.isFinite(from) || from >= size) {
      res.writeHead(416, cors);
      return res.end();
    }
    if (range) {
      res.writeHead(206, { ...cors, "Content-Type": "video/mp4", "Content-Length": String(size - from), "Content-Range": `bytes ${from}-${size - 1}/${size}` });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { ...cors, "Content-Type": "video/mp4", "Content-Length": String(size) });
    res.write(body.subarray(0, sent), () => setTimeout(() => res.destroy(), 300));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/primary.mp4`;
  await page.route(
    (u) => u.pathname === `/jobs/${jobId}/download` && u.searchParams.get("as") === "url",
    (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": WEB }, body: JSON.stringify({ url }) }),
  );
  return {
    body,
    ranges,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Every label "Video sichern" / "Save / Share…" showed, in turn. */
async function recordShareLabels(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __labels: string[] };
    w.__labels = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="done-share"]')?.textContent ?? null;
      if (t && w.__labels.at(-1) !== t) w.__labels.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const shareLabels = (page: Page) => page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);

/**
 * Every poster a <video> of the page was given, in turn: set when the
 * element was made, or changed later. (WebKit loads no other poster
 * once one failed: a poster that doesn't decode must never be set.)
 */
async function recordPosters(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posters: string[] };
    w.__posters = [];
    const add = (v: string | null) => {
      if (v && w.__posters.at(-1) !== v) w.__posters.push(v);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") {
          add((r.target as Element).getAttribute("poster"));
          continue;
        }
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          for (const v of [n, ...n.querySelectorAll("video")]) if (v.tagName === "VIDEO") add(v.getAttribute("poster"));
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["poster"] });
  });
}

const posters = (page: Page) => page.evaluate(() => (window as unknown as { __posters: string[] }).__posters);

/** A share sheet like fakeShareSheet (sharedFiles, sharedOnce) that also
 *  keeps each shared file's size and SHA-256: sharedBytes(). */
async function shareSheetKeepingFiles(page: Page) {
  await page.addInitScript(() => {
    type Kept = { name: string; size: number; sha256: string };
    const w = window as unknown as { __shared: string[]; __kept: Promise<Kept>[] };
    w.__shared = [];
    w.__kept = [];
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: (d: ShareData) => {
        const f = d.files?.[0];
        w.__shared.push(f?.name ?? "");
        if (f)
          w.__kept.push(
            f.arrayBuffer().then(async (b) => ({ name: f.name, size: f.size, sha256: hex(await crypto.subtle.digest("SHA-256", b)) })),
          );
        return Promise.resolve();
      },
      configurable: true,
    });
  });
}

const sharedBytes = (page: Page) =>
  page.evaluate(() => Promise.all((window as unknown as { __kept: Promise<{ name: string; size: number; sha256: string }>[] }).__kept));

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The export's primary file as the API serves it (through the 307 on R2). */
async function exportFile(page: Page, jobId: string): Promise<Buffer> {
  const r = await page.request.get(`${API}/jobs/${jobId}/download?format=primary`);
  expect(r.ok(), `GET download: ${r.status()}`).toBeTruthy();
  return r.body();
}

/** The page's fetch()es of the export's file itself, in turn: their
 *  Range header, the answer's status (0 until it came) and whether the
 *  request was stopped or broke off ("failed <error>"). */
function fileFetches(page: Page, jobId: string, storage: string | null) {
  type Entry = { range: string | null; status: number; failed: string | null };
  const out: Entry[] = [];
  const entries = new Map<Request, Entry>();
  const mine = (r: Request) => r.resourceType() === "fetch" && isFileFetch(new URL(r.url()), jobId, storage);
  page.on("request", (r) => {
    if (!mine(r)) return;
    const entry = { range: r.headers().range ?? null, status: 0, failed: null };
    entries.set(r, entry);
    out.push(entry);
  });
  page.on("response", (res) => {
    const entry = entries.get(res.request());
    if (entry) entry.status = res.status();
  });
  page.on("requestfailed", (r) => {
    const entry = entries.get(r);
    if (entry) entry.failed = r.failure()?.errorText ?? "failed";
  });
  return out;
}

/** GET /jobs/{id} answers with the primary file listed at `bytes` (the
 *  page decides share or download by it; the file itself stays small). */
async function listPrimaryAs(page: Page, jobId: string, bytes: number) {
  await page.route(
    (u) => u.pathname === `/jobs/${jobId}`,
    async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const res = await r.fetch();
      const job = await res.json();
      if (Array.isArray(job.downloads))
        job.downloads = job.downloads.map((d: { format: string }) => (d.format === "primary" ? { ...d, bytes } : d));
      return r.fulfill({ response: res, json: job });
    },
  );
}

/** A browser that refuses to share like Chromium over its 50 MiB
 *  (NotAllowedError "Permission denied", from a real tap); the calls. */
async function refusingShareSheet(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shareCalls: number };
    w.__shareCalls = 0;
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: () => {
        w.__shareCalls++;
        return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      },
      configurable: true,
    });
  });
}

/** The editor of `jobId`, exported: its export sheet in the done phase. */
async function exportInEditor(page: Page, jobId: string) {
  await openWithStorage(page, `/app/edit/${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("ed-export").click();
  await page.getByTestId("export-confirm").click();
  const sheet = page.getByTestId("export-sheet");
  await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  return sheet;
}

function doneTests(store: Store) {
  test.describe("the frame's picture", () => {
    test("the export's thumbnail, once it decodes", async ({ page, stub }) => {
      await storageOf(stub, store);
      const job = await stub.seed("done");
      await recordPosters(page);
      await openVorschau(page, job.id);
      await expect(vorschau(page)).toHaveAttribute("data-state", "done");
      await expect(frame(page)).toHaveAttribute("data-still", "thumbnail");
      await expect(video(page)).toHaveAttribute("poster", `${API}/jobs/${job.id}/thumbnail?v=1`);
      expect(await video(page).getAttribute("src")).toBe(`${API}/jobs/${job.id}/watch?v=1`);
      expect(await posters(page)).toEqual([`${API}/jobs/${job.id}/thumbnail?v=1`]);
    });

    for (const how of ["garbage", "404"] as const) {
      test(`a thumbnail ${how === "404" ? "that isn't there (404)" : "that isn't a JPEG"}: the analysis' poster, a real picture`, async ({
        page,
        stub,
      }) => {
        await storageOf(stub, store);
        const job = await stub.seed("done");
        await breakStill(page, job.id, "thumbnail", how);
        await noFrameBeforeTap(page, job.id);
        await recordPosters(page);
        await openVorschau(page, job.id);
        await expect(vorschau(page)).toHaveAttribute("data-state", "done");
        // What the frame shows is a picture, not one flat colour.
        await expect.poll(() => lumaSpread(frame(page)), { timeout: 15_000 }).toBeGreaterThan(40);
        await expect(frame(page)).toHaveAttribute("data-still", "poster");
        await expect(video(page)).toHaveAttribute("poster", `${API}/jobs/${job.id}/poster`);
        // The broken thumbnail never was the poster: after it, WebKit
        // (Safari 17 to 26) would load no other one, the frame stays empty.
        expect(await posters(page)).toEqual([`${API}/jobs/${job.id}/poster`]);
      });
    }

    test.describe("on an iPhone", () => {
      test.use({ userAgent: IPHONE_UA });

      test("neither still decodes: the video's first frame through #t=0.001", async ({ page, stub }, info) => {
        test.skip(info.project.name !== "pixel7", "phones only");
        await storageOf(stub, store);
        const job = await stub.seed("done");
        await breakStill(page, job.id, "thumbnail", "garbage");
        await breakStill(page, job.id, "poster", "404");
        await openVorschau(page, job.id);
        await expect(vorschau(page)).toHaveAttribute("data-state", "done");
        await expect(video(page)).toHaveAttribute("src", `${API}/jobs/${job.id}/watch?v=1#t=0.001`, { timeout: 15_000 });
        await expect(frame(page)).toHaveAttribute("data-still", "frame");
        await expect(video(page)).not.toHaveAttribute("poster");
        await expect.poll(() => lumaSpread(frame(page)), { timeout: 15_000 }).toBeGreaterThan(40);
        // The browser went to that frame and has it.
        await expect
          .poll(() =>
            video(page).evaluate((v) => {
              const el = v as HTMLVideoElement;
              return el.readyState >= 2 && el.currentTime > 0 && el.currentTime < 0.05;
            }),
          )
          .toBe(true);
        // A tap plays it from there.
        await page.getByTestId("preview-play").click();
        await expect(frame(page)).toHaveAttribute("data-playing", "true");
      });

      test("a video started before the stills gave up: never reloaded for the first frame", async ({ page, stub }, info) => {
        test.skip(info.project.name !== "pixel7", "phones only");
        await storageOf(stub, store);
        const job = await stub.seed("done");
        await breakStill(page, job.id, "thumbnail", "404");
        await breakStill(page, job.id, "poster", "404");
        const thumbnail = await holdRequests(page, `${API}/jobs/${job.id}/thumbnail**`);
        await openVorschau(page, job.id);
        await expect(vorschau(page)).toHaveAttribute("data-state", "done");
        await thumbnail.held;
        await page.getByTestId("preview-play").click();
        await expect(frame(page)).toHaveAttribute("data-playing", "true");
        await expect.poll(() => video(page).evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.3);
        await thumbnail.release();
        await expect(frame(page)).toHaveAttribute("data-still", "frame");
        await page.waitForTimeout(500);
        expect(await video(page).getAttribute("src")).toBe(`${API}/jobs/${job.id}/watch?v=1`);
        // still playing on, from where it was
        const t = await video(page).evaluate((v) => (v as HTMLVideoElement).currentTime);
        expect(t).toBeGreaterThan(0.5);
        await expect(frame(page)).toHaveAttribute("data-playing", "true");
      });
    });

    test("neither still decodes on another phone or a desktop: its first frame through #t=0.001 too", async ({ page, stub }) => {
      await storageOf(stub, store);
      const job = await stub.seed("done");
      // A thumbnail that loads but doesn't decode, no poster: Chromium
      // would keep the frame empty (on a phone it does without a poster
      // at all).
      await breakStill(page, job.id, "thumbnail", "garbage");
      await breakStill(page, job.id, "poster", "404");
      await openVorschau(page, job.id);
      await expect(frame(page)).toHaveAttribute("data-still", "frame", { timeout: 15_000 });
      await expect(video(page)).toHaveAttribute("src", `${API}/jobs/${job.id}/watch?v=1#t=0.001`);
      await expect.poll(() => lumaSpread(frame(page)), { timeout: 15_000 }).toBeGreaterThan(40);
    });
  });

  test.describe("Video sichern on an iPhone", () => {
    test.use({ userAgent: IPHONE_UA });

    test("finished during the visit: nothing fetched before the frame has its picture, or 2.5 s after done", async ({
      page,
      stub,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const asked = askedWhere(page, job.id);
      const thumbnail = await holdRequests(page, `${API}/jobs/${job.id}/thumbnail**`);
      await openVorschau(page, job.id);
      await page.getByTestId("preview-finish").click();
      await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
      const done = Date.now();
      // The thumbnail is still on its way: no question yet.
      await page.waitForTimeout(1_500);
      expect(asked).toEqual([]);
      await expect(frame(page)).toHaveAttribute("data-still", "none");
      // 2.5 s after done it goes anyway; the file is then fetched ahead.
      await expect.poll(() => asked.length, { timeout: 5_000 }).toBe(1);
      expect(asked[0] - done).toBeGreaterThanOrEqual(1_500);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await thumbnail.release();
      await expect(frame(page)).toHaveAttribute("data-still", "thumbnail");
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
    });

    test("finished during the visit: the question goes once the thumbnail is in, not before", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const asked = askedWhere(page, job.id);
      // The thumbnail is asked for as the done frame comes (its still is
      // tried at once), and is in a moment later.
      let thumbnailAsked = 0;
      let thumbnailIn = 0;
      page.on("request", (r) => {
        if (!thumbnailAsked && new URL(r.url()).pathname === `/jobs/${job.id}/thumbnail`) thumbnailAsked = Date.now();
      });
      page.on("requestfinished", (r) => {
        if (!thumbnailIn && new URL(r.url()).pathname === `/jobs/${job.id}/thumbnail`) thumbnailIn = Date.now();
      });
      await openVorschau(page, job.id);
      await page.getByTestId("preview-finish").click();
      await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
      await expect(frame(page)).toHaveAttribute("data-still", "thumbnail");
      await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
      expect(thumbnailIn).toBeGreaterThan(0);
      expect(asked[0]).toBeGreaterThanOrEqual(thumbnailIn);
      // Opened by the picture (onPicture), not by the 2.5 s timer after done.
      expect(asked[0] - thumbnailIn).toBeLessThan(1_500);
      expect(asked[0] - thumbnailAsked).toBeLessThan(2_000);
      await expect(page.getByTestId("done-share")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    });

    test("a file fetch that fails twice: tried again, ready, and one tap shares it; nothing downloaded", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      const storage = await storageOf(stub, store);
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const fetches = await failFileFetches(page, job.id, storage, 2);
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      await openVorschau(page, job.id);
      await page.getByTestId("preview-finish").click();
      await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "preparing");
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      expect(fetches.n).toBe(3);
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
      expect(downloads).toEqual([]);
      await expect(page.getByTestId("done-share-failed")).toHaveCount(0);
    });

    test("a file fetch that keeps failing: Download with a note why; nothing downloaded or shared by itself", async ({
      page,
      stub,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      const storage = await storageOf(stub, store);
      await fakeShareSheet(page);
      await tapStillActive(page, true);
      const job = await stub.seed("done");
      const fetches = await failFileFetches(page, job.id, storage, 99);
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
      await save.click();
      await expect(save).toHaveAttribute("data-state", "preparing");
      // Three tries (about 8 s), then the page offers the download.
      const download = page.getByTestId("done-download").first();
      await expect(download).toHaveText("Download", { timeout: 30_000 });
      await expect(page.getByTestId("done-share")).toHaveCount(0);
      await expect(page.getByTestId("done-share-failed")).toHaveText(SAVE_FAILED);
      // the focus the pressed button had goes on to the download
      await expect(download).toBeFocused();
      expect(fetches.n).toBe(3);
      await page.waitForTimeout(1_500);
      expect(downloads).toEqual([]);
      expect(await sharedFiles(page)).toEqual([]);
      // Download, tapped: the export, named after the project.
      const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
      expect(file.suggestedFilename()).toBe("tiktok_3_mistakes_final_cleocuts_9x16.mp4");
    });

    test("while the file comes in, the button says how much of it is here", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      await tapStillActive(page, false);
      const job = await stub.seed("done");
      const file = await slowFile(page, job.id, 1_000_000, 420_000);
      try {
        await openWithStorage(page, `/app/p/${job.id}`);
        const save = page.getByTestId("done-share");
        await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
        await save.click();
        await expect(save).toHaveText("Preparing… 42%", { timeout: 15_000 });
        await expect(save).toHaveAttribute("data-state", "preparing");
        file.release();
        await expect(save).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
        await expect(save).toHaveText("Save video");
        await save.click();
        await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
      } finally {
        file.close();
      }
    });

    // Review F4: every try fetched the whole file again from byte 0, and
    // the label fell back ("90 %", "Preparing…", "5 %").
    test("a file fetch that breaks off: the next try asks for the rest only, the label goes on from there", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await shareSheetKeepingFiles(page);
      await tapStillActive(page, false);
      await recordShareLabels(page);
      const job = await stub.seed("done");
      const file = await breakingFile(page, job.id, 1_000_000, 420_000);
      try {
        await openWithStorage(page, `/app/p/${job.id}`);
        const save = page.getByTestId("done-share");
        await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
        await save.click();
        await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
        // The second GET asked for the rest of what the first one read.
        expect(file.ranges).toHaveLength(2);
        expect(file.ranges[0]).toBeNull();
        const from = Number(/^bytes=(\d+)-$/.exec(file.ranges[1] ?? "")?.[1]);
        expect(from).toBeGreaterThan(0);
        expect(from).toBeLessThanOrEqual(420_000);
        // Once counting, the label never fell back: no bare "Preparing…"
        // between the tries, no smaller percent; then "Save video".
        const labels = await shareLabels(page);
        const first = labels.findIndex((l) => /\d%$/.test(l));
        expect(first, labels.join(" | ")).toBeGreaterThanOrEqual(0);
        const after = labels.slice(first);
        expect(after.at(-1), labels.join(" | ")).toBe("Save video");
        const nums = after.slice(0, -1).map((l) => Number(/^Preparing… (\d+)%$/.exec(l)?.[1] ?? NaN));
        expect(nums.every((n, i) => Number.isFinite(n) && (i === 0 || n >= nums[i - 1])), labels.join(" | ")).toBe(true);
        await save.click();
        await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
        // Every byte in its place.
        expect(await sharedBytes(page)).toEqual([
          { name: "tiktok_3_mistakes_final_cleocuts_9x16.mp4", size: 1_000_000, sha256: sha256(file.body) },
        ]);
      } finally {
        file.close();
      }
    });

    // Review F3: the fetch ahead ran through the video's playback (on
    // production 7.4 s stalled in 25 s, against none without it).
    test("the fetch ahead holds while the video plays and goes on from where it stopped once it stops", async ({
      page,
      stub,
      browserName,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      test.skip(browserName !== "chromium", "Chromium only (CDP throttling)");
      const storage = await storageOf(stub, store);
      await shareSheetKeepingFiles(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const fetches = fileFetches(page, job.id, storage);
      await openVorschau(page, job.id);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      const throttle = (bytesPerSecond: number) =>
        cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: bytesPerSecond,
          uploadThroughput: -1,
        });
      await page.getByTestId("preview-finish").click();
      // A slow connection from here on (the export's file, some 80 KB:
      // about 13 s), until the fetch went on after the video stopped.
      await throttle(6 * 1024);
      await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
      const save = page.getByTestId("done-share");
      await expect(save).toHaveText(/^Preparing… [1-9]\d?%$/, { timeout: 30_000 });
      // Play: the fetch stops at once, the button is "Save video" again.
      await page.getByTestId("preview-play").click();
      await expect(frame(page)).toHaveAttribute("data-playing", "true");
      await expect(save).toHaveAttribute("data-state", "idle");
      await expect(save).toHaveText("Save video");
      await expect.poll(() => fetches.at(-1)?.failed).toBeTruthy();
      const tries = fetches.length;
      await page.waitForTimeout(2_500);
      expect(fetches.length, "no fetch of the file while the video plays").toBe(tries);
      // Paused: on from where it stopped (Range), the label where it was.
      await page.getByTestId("preview-play").click();
      await expect(frame(page)).not.toHaveAttribute("data-playing", "true");
      await expect.poll(() => fetches.length).toBe(tries + 1);
      await throttle(-1);
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      // One stopped fetch of the whole file, then the rest of it (206).
      expect(fetches.map((f) => (f.range === null ? "whole" : "rest")), JSON.stringify(fetches)).toEqual(["whole", "rest"]);
      expect(fetches[1].range).toMatch(/^bytes=[1-9]\d*-$/);
      expect(fetches[1].status, JSON.stringify(fetches)).toBe(206);
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
      // Every byte in its place: the export's file itself.
      const want = await exportFile(page, job.id);
      expect(await sharedBytes(page)).toEqual([{ name: "tiktok_3_mistakes_cleocuts_9x16.mp4", size: want.length, sha256: sha256(want) }]);
    });
  });

  // Review F2: Chromium refuses to share more than 50 MiB of files
  // (NotAllowedError from a real tap): "Save / Share…" did nothing on
  // every tap, with no note and no download.
  test.describe("the editor's Save / Share on Android", () => {
    test("a share the browser refuses although it counted the tap: Download with a note, nothing downloaded by itself", async ({
      page,
      stub,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await refusingShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      const sheet = await exportInEditor(page, job.id);
      const share = sheet.getByTestId("done-share");
      await expect(share).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await share.click();
      await expect(sheet.getByTestId("done-share-failed")).toHaveText(SHARE_FAILED);
      await expect(sheet.getByTestId("done-share")).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls)).toBe(1);
      await page.waitForTimeout(1_000);
      expect(downloads).toEqual([]);
      // The export's Download is the main action now.
      const [file] = await Promise.all([page.waitForEvent("download"), sheet.getByTestId("done-download").first().click()]);
      expect(file.suggestedFilename()).toBe("tiktok_3_mistakes_cleocuts_9x16.mp4");
    });

    test("a file over 50 MiB: a plain Download, nothing fetched ahead", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      await listPrimaryAs(page, job.id, 60 * 1024 * 1024);
      const asked = askedWhere(page, job.id);
      const sheet = await exportInEditor(page, job.id);
      await expect(sheet.getByTestId("done-download").first()).toBeVisible();
      await page.waitForTimeout(1_500);
      await expect(sheet.getByTestId("done-share")).toHaveCount(0);
      expect(asked).toEqual([]);
    });
  });

  test.describe("an iPhone's file over 50 MiB", () => {
    test.use({ userAgent: IPHONE_UA });

    test("still Save video: WebKit has no such limit (the cap is 250 MB there)", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      await tapStillActive(page, true);
      const job = await stub.seed("done");
      await listPrimaryAs(page, job.id, 120 * 1024 * 1024);
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
    });
  });
}

test.describe("the done page, local media", { tag: "@editor-v2" }, () => doneTests("local"));

test.describe("the done page on R2", { tag: ["@editor-v2", "@r2"] }, () => doneTests("r2"));
