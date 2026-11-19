/**
 * The Vorschau (/app/p/[jobId] on the v2 editor, PR2 plan D11 to D14,
 * D21): helpers of its suites (vorschau, processing, export-done) and
 * its screenshots (visual/s9-vorschau).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { devices, expect, type Locator, type Page, type Route } from "@playwright/test";
import { openWithStorage } from "./app";
import { API, WEB } from "./env";

export const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

/** Safari on an iPhone: the Vorschau saves the export through the share
 *  sheet ("Save video"; features/start/ios isIOS). */
export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Chrome on Android (the pixel7 project's own): what a phone that is no
 *  iPhone gets, also where the project's device is an iPhone. */
export const ANDROID_UA = devices["Pixel 7"].userAgent;

/** The Vorschau; data-state processing | ready | edited | finishing | done | failed. */
export const vorschau = (page: Page): Locator => page.getByTestId("preview");

/** The title's hyphenation limits as the browser has them (the wide
 *  layout's title, preview.module.css): hyphenate-limit-chars where it
 *  knows it ("10 4 4"), else Safari's own -webkit-hyphenate-limit-before
 *  and -after ("5 5"). */
export async function titleHyphenLimits(page: Page): Promise<{ standard: boolean; value: string }> {
  return page.getByTestId("preview-title").evaluate((el) => {
    const s = getComputedStyle(el);
    return CSS.supports("hyphenate-limit-chars", "10 4 4")
      ? { standard: true, value: s.getPropertyValue("hyphenate-limit-chars") }
      : { standard: false, value: `${s.getPropertyValue("-webkit-hyphenate-limit-before")} ${s.getPropertyValue("-webkit-hyphenate-limit-after")}` };
  });
}

/** Open the Vorschau of `jobId` from /imprint (so Back has somewhere to
 *  go). `query` e.g. "?captions=v2": this browser opts in to the v2
 *  captions (the stub runs CLEO_CAPTION_ENGINE=optin). */
export async function openVorschau(page: Page, jobId: string, opts: { storage?: Record<string, unknown>; query?: string } = {}) {
  await openWithStorage(page, `/app/p/${jobId}${opts.query ?? ""}`, { ...TOUR_DONE, ...opts.storage });
  await expect(vorschau(page)).toBeVisible({ timeout: 45_000 });
}

/** The editor's copy of timeline changes the server doesn't have yet
 *  (editor/session/unsavedKey): localStorage for openVorschau. */
export function unsavedTimeline(jobId: string): Record<string, unknown> {
  return {
    [`cleocuts.editor.unsaved.v1.${jobId}`]: { segs: [{ id: "a", start: 0, end: 5 }], base: 0, known: [], at: Date.now() },
  };
}

/** The bodies of the page's POST /jobs/{id}/render, as they are sent. */
export function renderPosts(page: Page, jobId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs/${jobId}/render`) out.push(r.postDataJSON());
  });
  return out;
}

/** A browser that can share video files; the names it was given to
 *  share: sharedFiles(). */
export async function fakeShareSheet(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: string[] };
    w.__shared = [];
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: (d: ShareData) => {
        w.__shared.push(d.files?.[0]?.name ?? "");
        return Promise.resolve();
      },
      configurable: true,
    });
  });
}

export const sharedFiles = (page: Page) => page.evaluate(() => (window as unknown as { __shared: string[] }).__shared);

/** One share of `name`, and no second one a moment later. */
export async function sharedOnce(page: Page, name: string) {
  await expect.poll(() => sharedFiles(page)).toEqual([name]);
  await page.waitForTimeout(1000);
  expect(await sharedFiles(page)).toEqual([name]);
}

/** When the fetch a tap started is done, the browser still counts that
 *  tap (true: a quick fetch) or no longer (false: a slow one), whatever
 *  the machine's load (navigator.userActivation). */
export async function tapStillActive(page: Page, isActive: boolean) {
  await page.addInitScript((active) => {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: active, hasBeenActive: true }, configurable: true });
  }, isActive);
}

/**
 * Tap a Download link of the export (the API's /jobs/{id}/download):
 * the name of the file the browser saved. The API answers with
 * Content-Disposition: attachment (local media; R2: the object it
 * redirects to), and Safari downloads it. Playwright's WebKit shows a
 * video/mp4 navigation inline all the same, and reports no download for
 * a route.fulfill()ed one: there the tap's GET goes through a server of
 * this test that passes on the API's status, body and
 * Content-Disposition, as application/octet-stream.
 */
export async function tapDownload(page: Page, link: Locator): Promise<string> {
  if (page.context().browser()?.browserType().name() !== "webkit") {
    const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
    return file.suggestedFilename();
  }
  const proxy = http.createServer(async (req, res) => {
    try {
      const r = await fetch(new URL(req.url ?? "/", "http://x").searchParams.get("u")!);
      const body = Buffer.from(await r.arrayBuffer());
      const disposition = r.headers.get("content-disposition");
      res.writeHead(r.status, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        ...(disposition ? { "Content-Disposition": disposition } : {}),
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(String(e));
    }
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/?u=`;
  const isFile = (u: URL) => /^\/jobs\/[^/]+\/download$/.test(u.pathname) && !u.searchParams.has("as");
  const handler = (r: Route) =>
    r.request().resourceType() === "document" ? r.continue({ url: at + encodeURIComponent(r.request().url()) }) : r.fallback();
  await page.route(isFile, handler);
  try {
    const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
    return file.suggestedFilename();
  } finally {
    await page.unroute(isFile, handler);
    proxy.closeAllConnections();
    proxy.close();
  }
}

/**
 * Hold the page's requests to `url` (glob; only `method` if given) until
 * release(): they stay out, as on a slow connection. `held` resolves
 * once the first one is held.
 */
export async function holdRequests(page: Page, url: string, method?: string) {
  const routes: Route[] = [];
  let released = false;
  let first: () => void = () => {};
  const held = new Promise<void>((resolve) => (first = resolve));
  await page.route(url, async (route) => {
    if ((method && route.request().method() !== method) || released) return route.fallback();
    routes.push(route);
    first();
  });
  return {
    held,
    release: async () => {
      released = true;
      for (const r of routes.splice(0)) await r.fallback();
    },
  };
}

/** Feinschliff on the Vorschau: the editor of the job, loaded. */
export async function openRefine(page: Page, jobId: string) {
  await vorschau(page).getByTestId("preview-refine").click();
  await expect(page).toHaveURL(`${WEB}/app/edit/${jobId}`);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
}

const isPhone = async (page: Page) => (await page.getByTestId("editor-v2").getAttribute("data-layout")) !== "desktop";

/** Fix one word in the editor's Text tab (a save of the edit document):
 *  double-click + type (desktop), tap + Edit + Done in the sheet, which
 *  closes again (phone; English or German UI). */
export async function fixWord(page: Page, from: string, to: string) {
  const phone = await isPhone(page);
  if (phone) await page.getByTestId("ed-tab-text").click();
  const word = page.getByTestId("ed-word").filter({ hasText: new RegExp(`^${from}$`) }).first();
  await expect(word).toBeVisible({ timeout: 30_000 });
  if (phone) {
    await word.click();
    await page.getByTestId("ed-word-edit").click();
    await page.getByTestId("ed-word-input").fill(to);
    await page.getByTestId("ed-word-done").click();
  } else {
    await word.dblclick();
    await page.getByTestId("ed-word-input").fill(to);
    await page.getByTestId("ed-word-input").press("Enter");
  }
  await expect(page.getByTestId("ed-word-input")).toHaveCount(0);
  if (phone) {
    const sheet = page.getByTestId("ed-sheet-text");
    await sheet.getByRole("button", { name: /^(Close|Schließen)$/ }).click();
    await expect(sheet).toBeHidden();
  }
}

/** Cut the words first..last in the editor's Text tab (click, ⇧-click,
 *  Cut; the sheet on phones, closed again): the timeline and the doc
 *  are saved. */
export async function cutWords(page: Page, first: string, last: string) {
  const phone = await isPhone(page);
  const sheet = page.getByTestId("ed-sheet-text");
  if (phone && !(await sheet.isVisible())) await page.getByTestId("ed-tab-text").click();
  const word = (text: string) => page.getByTestId("ed-word").filter({ hasText: new RegExp(`^${text}$`) }).first();
  await expect(word(first)).toBeVisible({ timeout: 30_000 });
  await word(first).click();
  // the word menu opens over the next lines: the ⇧-click goes to the word itself
  await word(last).dispatchEvent("click", { shiftKey: true });
  await expect(page.getByTestId("ed-wordbar")).toBeVisible();
  await page.getByTestId("ed-word-cut").first().click();
  await expect(word(first)).toHaveAttribute("data-rm", "true");
  if (phone) {
    // Escape first clears the selection, then closes the sheet
    for (let i = 0; i < 3 && (await sheet.isVisible()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await expect(sheet).toBeHidden();
  }
}

/** Pick a caption style in the editor's Style tab (the sheet on phones, closed again). */
export async function pickStyle(page: Page, presetId: string) {
  const phone = await isPhone(page);
  await page.getByTestId("ed-tab-style").click();
  await expect(page.getByTestId("ed-style")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`ed-tile-${presetId}`).click();
  await expect(page.getByTestId(`ed-tile-${presetId}`)).toHaveAttribute("aria-pressed", "true");
  if (phone) {
    await page.getByRole("button", { name: /^(Close|Schließen)$/ }).first().click();
    await expect(page.getByTestId("ed-sheet-style")).toBeHidden();
  }
}

/** The times the page asked for the preview of the stored timeline
 *  (POST /jobs/{id}/preview), as they are sent. A listener, not a route:
 *  the HTTP cache stays on. */
export function previewPosts(page: Page, jobId: string): number[] {
  const out: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs/${jobId}/preview`) out.push(Date.now());
  });
  return out;
}

/** m:ss of a stored timeline's length (its clips at their speed), the
 *  seconds rounded down as the editor shows them. */
export function lengthOf(segs: { start: number; end: number; speed?: number }[]): string {
  const s = Math.floor(segs.reduce((a, x) => a + (x.end - x.start) / (x.speed || 1), 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
