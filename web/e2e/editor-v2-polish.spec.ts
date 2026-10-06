/**
 * Four owner requests on the v2 editor:
 *   1. "Save as default" in the Style tab: kept in this browser's prefs
 *      (cleocuts.prefs.v1 caption_style_default); new uploads send its
 *      preset as the hint and the whole style once the job exists; a job
 *      whose PATCH didn't get through gets it on first open.
 *   2. "Show in text" in a selected caption's bar: the Text tab (the
 *      sheet on a phone) selects that word and the playhead goes there.
 *   3. Phone Back: in the iPhone pseudo-fullscreen it closes the
 *      fullscreen; after /app?job=… it goes where the user came from.
 *   4. Footage brought back without words gets its text (POST
 *      /jobs/{id}/transcribe-span, faked by the stub: seed option span):
 *      "Adding text…", then the words; a failure leaves a retry chip.
 * Desktop and pixel7; a v2 build (NEXT_PUBLIC_EDITOR_V2 unset or 1; E2E_EDITOR_V2=1).
 */
import { devices, type Page, type Request } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { chooseFile, JOBS, openWithStorage, postedSettings, readStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };
const LIVE = { ...TOUR_DONE, "cleocuts.captions.engine.v1": "v2" };
const PREFS = "cleocuts.prefs.v1";
const SAVED = { timeout: 15_000 };

type Hook = { ready: boolean; page: string | null; pageId: string | null };
const hook = (page: Page) => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer ?? null);
const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");
const videoTime = (page: Page) => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).currentTime);

async function openEditor(page: Page, path: string, storage: Record<string, unknown> = TOUR_DONE) {
  await openWithStorage(page, path, storage);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

async function openLive(page: Page, jobId: string) {
  await openEditor(page, `/app/edit/${jobId}?captions=v2`, LIVE);
  await expect(page.getByTestId("caption-layer")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await hook(page))?.ready, { timeout: 30_000 }).toBe(true);
}

async function openText(page: Page) {
  if ((await isPhone(page)) && !(await page.getByTestId("ed-sheet-text").isVisible())) await page.getByTestId("ed-tab-text").click();
  await expect(page.getByTestId("ed-word").first()).toBeVisible({ timeout: 30_000 });
}

test.describe("editor v2: save the caption style as default", TAG, () => {
  test("Style tab → prefs; the next upload sends it; the job gets the whole style", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    // the upload defaults saved before stay
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ style: "smooth", target_aspect: "9:16" })), PREFS);
    await page.getByTestId("ed-tab-style").click();
    await page.getByTestId("ed-tile-karaoke").click();
    await page.getByTestId("ed-style-customize").click();
    await page.getByTestId("ed-style-words").getByRole("button", { name: "2", exact: true }).click();
    const save = page.getByTestId("ed-style-save-default");
    await expect(save).toHaveAttribute("data-state", "idle");
    await save.click();
    await expect(save).toHaveAttribute("data-state", "saved");
    await expect(save).toHaveText("Saved as default");
    expect(await readStorage(page, PREFS)).toEqual({
      style: "smooth",
      target_aspect: "9:16",
      caption_style_default: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
    });
    // another look: savable again
    await page.getByTestId("ed-tile-boxed").click();
    await expect(save).toHaveAttribute("data-state", "idle");

    // a new video: the preset as the hint, then the whole style on the job
    const posts: Record<string, unknown>[] = [];
    await page.route(`${API}/jobs`, async (route) => {
      const r: Request = route.request();
      if (r.method() === "POST") {
        const s = postedSettings(r.postDataBuffer()?.toString("utf8") ?? null);
        if (s) posts.push(s);
      }
      await route.fallback();
    });
    await page.goto("/app/new");
    await chooseFile(page, { name: "standard.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
    const id = async () =>
      ((await readStorage<{ jobId: string }[]>(page, JOBS)) ?? []).map((j) => j.jobId).find((j) => !j.startsWith("upl-") && j !== job.id) ??
      null;
    await expect.poll(id, { timeout: 30_000 }).not.toBeNull();
    expect(posts[0]).toMatchObject({ caption_style_hint: "karaoke", style: "smooth" });
    expect(posts[0]).not.toHaveProperty("caption_preset");
    await expect
      .poll(async () => (await stub.job((await id())!))?.settings?.caption_style, SAVED)
      .toEqual({ presetId: "karaoke", overrides: { wordsPerPage: 2 } });
  });

  test("a new project whose style didn't get through gets it on first open", async ({ page, stub }) => {
    const fresh = await stub.seed("review_speech");
    const pending = { [fresh.id]: { presetId: "boxed", overrides: { case: "upper" } } };
    await openEditor(page, `/app/edit/${fresh.id}`, { ...TOUR_DONE, "cleocuts.captionDefault.pending.v1": pending });
    await expect.poll(async () => (await stub.doc(fresh.id)).doc.style, SAVED).toEqual({ presetId: "boxed", overrides: { case: "upper" } });
    expect(await readStorage(page, "cleocuts.captionDefault.pending.v1")).toBeNull();
  });
});

test.describe("editor v2: a caption shows its word in the text", TAG, () => {
  test("select the caption, Show in text: the word is selected and the playhead on it", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await page.getByTestId("editor-video").evaluate((v) => {
      const el = v as HTMLVideoElement;
      el.pause();
      el.currentTime = 4.6;
    });
    await expect.poll(async () => (await hook(page))?.page ?? null, SAVED).not.toBeNull();
    const caption = (await hook(page))!.page!;
    // first tap: the caption is selected for adjusting (UT5), as before
    await page.getByTestId("caption-hit").click();
    await expect(page.getByTestId("caption-bar")).toBeVisible();
    await page.getByTestId("caption-show-text").click();
    if (await isPhone(page)) await expect(page.getByTestId("ed-sheet-text")).toBeVisible();
    const sel = page.locator('[data-testid="ed-word"][data-sel="true"]');
    await expect(sel).toHaveCount(1);
    await expect(sel).toBeInViewport();
    const text = (await sel.textContent())!.trim();
    expect(caption.toLowerCase()).toContain(text.toLowerCase());
    // the playhead went to that word (a hair into it)
    const t = await videoTime(page);
    expect(Math.abs(t - 4.6)).toBeLessThan(2);
    await expect(page.getByTestId("caption-bar")).toHaveCount(0);
  });
});

test.describe("phone Back", TAG, () => {
  test("after /app?job=… Back goes where the user came from, not to the editor again", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    // openEditor starts on /imprint
    await openEditor(page, `/app?job=${job.id}`);
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
    await page.goBack();
    await expect(page).toHaveURL(`${WEB}/imprint`, SAVED);
  });
});

const { defaultBrowserType: _iphone, ...IPHONE_13 } = devices["iPhone 13"];
void _iphone;

test.describe("phone Back on an iPhone", TAG, () => {
  test.use(IPHONE_13);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "phone emulation, one run");
  });

  test("Back closes the pseudo-fullscreen and stays in the editor; the exit button leaves no entry behind", async ({ page, stub }) => {
    await page.addInitScript(() => {
      for (const k of ["requestFullscreen", "webkitRequestFullscreen"]) {
        Object.defineProperty(Element.prototype, k, { value: undefined, configurable: true });
      }
    });
    const job = await stub.seed("review_speech");
    await openEditor(page, `/app/edit/${job.id}`);
    const url = page.url();
    const wrap = page.getByTestId("ed-fullscreen-wrap");
    await page.getByTestId("ed-fullscreen").tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "pseudo");
    await page.goBack();
    await expect(wrap).toHaveAttribute("data-fullscreen", "");
    expect(page.url()).toBe(url);
    await expect(page.getByTestId("editor-v2")).toBeVisible();
    // the exit button: closed, and the next Back leaves the editor
    await page.getByTestId("ed-fullscreen").tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "pseudo");
    await page.getByRole("button", { name: "Exit full screen" }).tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "");
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await page.goBack();
    await expect(page).toHaveURL(`${WEB}/imprint`, SAVED);
  });
});

test.describe("editor v2: text for footage brought back", TAG, () => {
  // the pause after "point." (13.656–15.156): no words in the doc
  const pauseChip = (page: Page) => page.getByTestId("ed-pause-chip").filter({ hasText: /1[.,]5/ }).first();

  test("restore a pause: Adding text…, then its words, saved with the doc", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { span: { text: "really quite good", seconds: 1.5 } });
    await openEditor(page, `/app/edit/${job.id}`);
    await openText(page);
    const posts = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/jobs/${job.id}/transcribe-span`));
    await pauseChip(page).click();
    const body = (await posts).postDataJSON() as { start: number; end: number };
    expect(body.start).toBeGreaterThanOrEqual(13.6);
    expect(body.end).toBeLessThanOrEqual(15.2);
    await expect(page.getByTestId("ed-span-busy")).toBeVisible();
    await expect(page.getByTestId("ed-span-busy")).toHaveCount(0, SAVED);
    for (const t of ["really", "quite", "good"]) await expect(page.getByTestId("ed-word").filter({ hasText: new RegExp(`^${t}$`) })).toHaveCount(1);
    const texts = async () => (await stub.doc(job.id)).doc.words.map((w) => w.text);
    await expect.poll(texts, SAVED).toContain("quite");
    // the editor's next save builds on it (no conflict, nothing deleted)
    const word = page.getByTestId("ed-word").filter({ hasText: /^quite$/ });
    await word.click();
    await page.getByTestId("ed-word-hide").click();
    await expect.poll(async () => (await stub.doc(job.id)).doc.words.find((w) => w.text === "quite")?.hidden ?? false, SAVED).toBe(true);
    await expect(page.getByTestId("ed-conflict")).toHaveCount(0);
    expect(await texts()).toContain("really");
  });

  test("a failure leaves no captions there and a retry chip; the retry brings the words", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { span: { text: "second try", fail: 1 } });
    await openEditor(page, `/app/edit/${job.id}`);
    await openText(page);
    await pauseChip(page).click();
    const retry = page.getByTestId("ed-span-retry");
    await expect(retry).toBeVisible(SAVED);
    await expect(page.getByTestId("ed-word").filter({ hasText: /^second$/ })).toHaveCount(0);
    await retry.click();
    await expect(page.getByTestId("ed-word").filter({ hasText: /^second$/ })).toHaveCount(1, SAVED);
    await expect(retry).toHaveCount(0);
  });
});
