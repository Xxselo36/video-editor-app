/**
 * Saving the export (PR2 plan D21) after the live test's D1 and D2, on
 * the Vorschau and in the editor's export sheet:
 *
 *   D1  every export's download link is its own (its generation, v=):
 *       after Fine-tune and a second export, Download and ⋯ → Download
 *       (on the Vorschau and on the project's tile) ask for the new
 *       export, and the browser never answers them from its cache (a
 *       download is no-store, its redirect to R2 too); while the project
 *       is edited, the previous version keeps the first export's link.
 *       Every one of them names the file after the project (name=v2)
 *   D2  "Save video" on an iPhone and the editor's Save / Share ask the
 *       API where the file is (?as=url), then fetch it there: on R2 from
 *       the bucket itself, with the page's Origin, never through
 *       /download (its redirect into the bucket is redirect-tainted,
 *       which the bucket's CORS refuses); with local media the API's own
 *       /download. A question the API can't answer: Download instead.
 *       A second export in the same visit: asked and fetched again, its
 *       own file shared
 *
 * Desktop and pixel7 of a v2 build (E2E_EDITOR_V2=1), once with local
 * media (the anonymous run) and once on R2 (E2E_MODE=r2: moto as R2,
 * answering CORS by the bucket's rules only, as R2 does).
 */
import { expect, test, type Stub } from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { job as listed, JOBS, jobCard, openWithStorage } from "./support/app";
import { API, WEB } from "./support/env";
import { fakeShareSheet, IPHONE_UA, openRefine, sharedFiles, sharedOnce, tapStillActive, TOUR_DONE, vorschau } from "./support/vorschau";

type Store = "local" | "r2";

/** The export's generation in a download link (v=). */
const gen = (href: string | null) => (href ? new URL(href).searchParams.get("v") : null);

type Hop = { url: string; status: number; cacheControl: string; location: string | null; cached: boolean };

/**
 * What the browser did for a download link while `act` ran (CDP,
 * Chromium): each answer to a URL starting with `prefix` (its status,
 * Cache-Control, its redirect's target, and whether the browser took it
 * from its cache), and the file's name.
 */
async function downloadOf(page: Page, prefix: string, act: () => Promise<unknown>): Promise<{ hops: Hop[]; name: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const hops: Hop[] = [];
  const cc = (h: Record<string, string>) => Object.entries(h).find(([k]) => k.toLowerCase() === "cache-control")?.[1] ?? "";
  cdp.on("Network.requestWillBeSent", (e) => {
    const r = e.redirectResponse;
    if (r?.url.startsWith(prefix)) hops.push({ url: r.url, status: r.status, cacheControl: cc(r.headers), location: e.request.url, cached: !!r.fromDiskCache });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = e.response;
    if (r.url.startsWith(prefix)) hops.push({ url: r.url, status: r.status, cacheControl: cc(r.headers), location: null, cached: !!r.fromDiskCache });
  });
  try {
    const [file] = await Promise.all([page.waitForEvent("download"), act()]);
    return { hops, name: file.suggestedFilename() };
  } finally {
    await cdp.detach();
  }
}

/** A download of `href` that got the file of `key` from the server: never
 *  from the browser's cache, never stored (R2: the 307 to that object). */
function expectFile(store: Store, d: { hops: Hop[] }, href: string, key: string) {
  expect(d.hops.map((h) => h.url)).toEqual([href]);
  const [hop] = d.hops;
  expect(hop.cached).toBe(false);
  expect(hop.cacheControl).toBe("no-store");
  if (store === "local") {
    expect(hop.status).toBe(200);
    return;
  }
  expect(hop.status).toBe(307);
  expect(decodeURIComponent(new URL(hop.location!).pathname).endsWith(`/${key}`), `${hop.location} → ${key}`).toBe(true);
}

/** ⋯ → Download's link of the menu in `scope` (the Vorschau's, or a tile's). */
async function menuLink(page: Page, scope: Locator): Promise<string> {
  await scope.getByTestId("job-card-menu").click();
  const href = await page.getByTestId("job-card-download").getAttribute("href");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("job-card-menu-list")).toHaveCount(0);
  return href!;
}

/** The page's fetch()es of the export: those to its /download (their as=
 *  and v=), and those to the storage (`storage`: moto's origin), with
 *  their Origin. */
function exportFetches(page: Page, jobId: string, storage: string | null) {
  const out = { api: [] as { as: string | null; v: string | null }[], storage: [] as { path: string; origin: string | null }[] };
  page.on("request", async (r) => {
    if (r.resourceType() !== "fetch") return;
    const u = new URL(r.url());
    if (r.url().startsWith(`${API}/jobs/${jobId}/download`)) out.api.push({ as: u.searchParams.get("as"), v: u.searchParams.get("v") });
    else if (storage && r.url().startsWith(storage)) {
      const origin = (await r.allHeaders()).origin ?? null;
      out.storage.push({ path: decodeURIComponent(u.pathname), origin });
    }
  });
  return out;
}

/** The storage of this run: the stub's flavour, as the block expects. */
async function storageOf(stub: Stub, store: Store): Promise<string | null> {
  const info = await stub.info();
  expect(info.r2, `the stub's media: r2=${info.r2}, this block: ${store}`).toBe(store === "r2");
  return info.r2_endpoint;
}

function saveTests(store: Store) {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only (the browser's own record of each request: CDP)");

  test("Download after Fine-tune and a second export: the new export's own link, ⋯'s too, here and on its tile", async ({
    page,
    stub,
  }) => {
    await storageOf(stub, store);
    const job = await stub.seed("done", { render_seconds: 1 });
    const first = (await stub.job(job.id))!.output_keys.primary;
    const download = `${API}/jobs/${job.id}/download`;
    // Every download, ⋯'s too: the file named after the project.
    const named = "tiktok_3_mistakes_final_cleocuts_9x16.mp4";
    // Projects: the tile's ⋯ → Download is the first export's.
    await openWithStorage(page, "/app", { ...TOUR_DONE, [JOBS]: [listed(job.id, job.filename)] });
    const tile = jobCard(page, "tiktok_3_mistakes_final");
    await expect(tile).toHaveAttribute("data-state", "exported", { timeout: 30_000 });
    const tileFirst = await menuLink(page, tile);
    await page.goto(`/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 45_000 });
    const save = page.getByTestId("done-download").first();
    const saveFirst = (await save.getAttribute("href"))!;
    const menuFirst = await menuLink(page, vorschau(page));
    expect([gen(saveFirst), gen(menuFirst), gen(tileFirst)]).toEqual(["1", "1", "1"]);
    const d1 = await downloadOf(page, download, () => save.click());
    expect(d1.name).toBe(named);
    expectFile(store, d1, saveFirst, first);

    // Fine-tune, back: edited; the previous version is the first export's link.
    await openRefine(page, job.id);
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "edited");
    expect(await page.getByTestId("done-download-previous").getAttribute("href")).toBe(saveFirst);
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    const after = (await stub.job(job.id))!;
    expect(after.renders_ok).toBe(2);
    expect(after.output_keys.primary).not.toBe(first);

    // The second export: links of their own, the new file.
    const saveSecond = (await save.getAttribute("href"))!;
    expect(saveSecond).not.toBe(saveFirst);
    expect(gen(saveSecond)).toBe("2");
    const d2 = await downloadOf(page, download, () => save.click());
    expect(d2.name).toBe(named);
    expectFile(store, d2, saveSecond, after.output_keys.primary);
    const menuSecond = await menuLink(page, vorschau(page));
    expect(menuSecond).not.toBe(menuFirst);
    expect(gen(menuSecond)).toBe("2");
    await vorschau(page).getByTestId("job-card-menu").click();
    const dm = await downloadOf(page, download, () => page.getByTestId("job-card-download").click());
    expect(dm.name).toBe(named);
    expectFile(store, dm, menuSecond, after.output_keys.primary);

    // Projects again: the tile's too.
    await page.goto("/app");
    await expect(tile).toHaveAttribute("data-state", "exported", { timeout: 30_000 });
    const tileSecond = await menuLink(page, tile);
    expect(tileSecond).not.toBe(tileFirst);
    expect(gen(tileSecond)).toBe("2");
    await tile.getByTestId("job-card-menu").click();
    const dt = await downloadOf(page, download, () => page.getByTestId("job-card-download").click());
    expect(dt.name).toBe(named);
    expectFile(store, dt, tileSecond, after.output_keys.primary);
  });

  test.describe("on an iPhone", () => {
    test.use({ userAgent: IPHONE_UA });

    test("Save video: the file from where the API says, never through /download's redirect; shared from the tap", async ({
      page,
      stub,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      const storage = await storageOf(stub, store);
      await fakeShareSheet(page);
      await tapStillActive(page, true);
      const job = await stub.seed("done");
      const key = (await stub.job(job.id))!.output_keys.primary;
      const fetches = exportFetches(page, job.id, storage);
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      // Exported before this visit: nothing fetched until the tap (D21).
      await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
      expect(fetches.api).toEqual([]);
      await save.click();
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
      expect(downloads).toEqual([]);
      if (store === "r2") {
        // Only the question goes to /download; the file comes from the bucket.
        expect(fetches.api).toEqual([{ as: "url", v: "1" }]);
        expect(fetches.storage).toEqual([{ path: expect.stringMatching(new RegExp(`/${key}$`)), origin: WEB }]);
      } else {
        // The question first, then the API's own /download.
        expect(fetches.api).toEqual([
          { as: "url", v: "1" },
          { as: null, v: "1" },
        ]);
      }
    });

    test("Save video after Fine-tune and a second export in the same visit: asked and fetched again, the second export shared", async ({
      page,
      stub,
    }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      const storage = await storageOf(stub, store);
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      const fetches = exportFetches(page, job.id, storage);
      const name = "tiktok_3_mistakes_cleocuts_9x16.mp4";
      await openWithStorage(page, `/app/p/${job.id}`, TOUR_DONE);
      await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
      const save = page.getByTestId("done-share");
      const keys: string[] = [];
      for (const n of [1, 2]) {
        if (n === 2) {
          await openRefine(page, job.id);
          await page.getByTestId("editor-back").click();
          await expect(vorschau(page)).toHaveAttribute("data-state", "edited", { timeout: 30_000 });
        }
        await page.getByTestId("preview-finish").click();
        await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
        // Finished during this visit: fetched ahead (D21), shared from the tap.
        await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
        keys.push((await stub.job(job.id))!.output_keys.primary);
        await save.click();
        await expect.poll(() => sharedFiles(page)).toEqual(Array(n).fill(name));
      }
      await page.waitForTimeout(1000);
      expect(await sharedFiles(page)).toEqual([name, name]);
      expect(keys[1]).not.toBe(keys[0]);
      if (store === "r2") {
        // Each export's own question, each export's own object.
        expect(fetches.api).toEqual([
          { as: "url", v: "1" },
          { as: "url", v: "2" },
        ]);
        expect(fetches.storage).toEqual(keys.map((k) => ({ path: expect.stringMatching(new RegExp(`/${k}$`)), origin: WEB })));
      } else {
        expect(fetches.api).toEqual([
          { as: "url", v: "1" },
          { as: null, v: "1" },
          { as: "url", v: "2" },
          { as: null, v: "2" },
        ]);
      }
    });

    test("Save video when the API can't say where the file is: Download instead, nothing shared", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await storageOf(stub, store);
      await fakeShareSheet(page);
      await tapStillActive(page, true);
      const job = await stub.seed("done");
      await page.route(
        (u) => u.pathname === `/jobs/${job.id}/download` && u.searchParams.get("as") === "url",
        (r) => r.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": WEB }, body: "" }),
      );
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
      const [file] = await Promise.all([page.waitForEvent("download"), save.click()]);
      expect(file.suggestedFilename()).toBe("tiktok_3_mistakes_final_cleocuts_9x16.mp4");
      // The page offers the download from now on.
      await expect(page.getByTestId("done-share")).toHaveCount(0);
      await expect(page.getByTestId("done-download").first()).toHaveText("Download");
      expect(await sharedFiles(page)).toEqual([]);
    });
  });

  test("phones: the editor's Save / Share fetches the export the same way, ahead, and shares it once", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "phones only");
    const storage = await storageOf(stub, store);
    await fakeShareSheet(page);
    const job = await stub.seed("review_speech", { render_seconds: 1 });
    const fetches = exportFetches(page, job.id, storage);
    await openWithStorage(page, `/app/edit/${job.id}`, TOUR_DONE);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    const sheet = page.getByTestId("export-sheet");
    await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
    const share = sheet.getByTestId("done-share");
    await expect(share).toHaveText(/Save \/ Share/, { timeout: 30_000 });
    await expect(share).toBeEnabled();
    await share.click();
    await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
    const key = (await stub.job(job.id))!.output_keys.primary;
    if (store === "r2") {
      expect(fetches.api).toEqual([{ as: "url", v: "1" }]);
      expect(fetches.storage).toEqual([{ path: expect.stringMatching(new RegExp(`/${key}$`)), origin: WEB }]);
    } else {
      expect(fetches.api).toEqual([
        { as: "url", v: "1" },
        { as: null, v: "1" },
      ]);
    }
  });
}

test.describe("saving the export, local media", { tag: "@editor-v2" }, () => saveTests("local"));

test.describe("saving the export on R2", { tag: ["@editor-v2", "@r2"] }, () => saveTests("r2"));
