/**
 * The Vorschau (/app/p/[jobId] on the v2 editor, PR2 plan D11 to D14,
 * D21): helpers of its suites (vorschau, processing, export-done) and
 * its screenshots (visual/s9-vorschau).
 */
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { openWithStorage } from "./app";
import { API, WEB } from "./env";

export const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

/** Safari on an iPhone: the Vorschau saves the export through the share
 *  sheet ("Save video"; features/start/ios isIOS). */
export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** The Vorschau; data-state processing | ready | edited | finishing | done | failed. */
export const vorschau = (page: Page): Locator => page.getByTestId("preview");

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
