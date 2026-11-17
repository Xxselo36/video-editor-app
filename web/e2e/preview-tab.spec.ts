/**
 * The Vorschau tab (/app/preview, PR3 plan D15): it opens the Vorschau
 * last opened in this browser tab unless a newer project came since,
 * else the newest project with something to show; with none it says
 * what there is (a video waiting for "Let's go", or nothing yet). v2 only.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { chooseFile, job, JOBS, openWithStorage, startGo } from "./support/app";
import { WEB } from "./support/env";

const previewTab = (page: Page, mobile: boolean) =>
  page.getByTestId(mobile ? "tabbar" : "sidebar").locator('a[href="/app/preview"]');

test("opens the newest project with something to show", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  const review = await stub.seed("review");
  const failed = await stub.seed("err_no_speech");
  await openWithStorage(page, "/app/preview", {
    [JOBS]: [job(failed.id, "kaputt.mp4", 1_000), job(review.id, "neu.mp4", 60_000), job(done.id, "alt.mp4", 3_600_000)],
  });
  await expect(page).toHaveURL(`${WEB}/app/p/${review.id}`);
  await expect(page.getByTestId("preview")).toHaveAttribute("data-state", "ready");
});

test("comes back to the Vorschau last opened in this tab, unless a newer project came", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  const done = await stub.seed("done");
  const review = await stub.seed("review");
  await openWithStorage(page, `/app/p/${done.id}`, {
    [JOBS]: [job(review.id, "neu.mp4", 60_000), job(done.id, "alt.mp4", 3_600_000)],
  });
  await expect(page.getByTestId("preview")).toHaveAttribute("data-state", "done");
  await page.getByTestId(mobile ? "tabbar" : "sidebar").locator('a[href="/app"]').click();
  await previewTab(page, mobile).click();
  await expect(page).toHaveURL(`${WEB}/app/p/${done.id}`);
  // The tab is the current place on a project's Vorschau too.
  await expect(previewTab(page, mobile)).toHaveAttribute("aria-current", "page");

  // A project made after that: the tab opens it.
  const newer = await stub.seed("review");
  await page.evaluate(
    ([key, entry]) => {
      const list = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
      localStorage.setItem(key, JSON.stringify([entry, ...list]));
    },
    [JOBS, job(newer.id, "neuer.mp4", -60_000)] as const,
  );
  await page.goto("/app/preview");
  await expect(page).toHaveURL(`${WEB}/app/p/${newer.id}`);
});

test("nothing to show yet: it says so, with the way to upload", { tag: "@editor-v2" }, async ({ page }) => {
  await openWithStorage(page, "/app/preview");
  const empty = page.getByTestId("preview-empty");
  await expect(empty).toContainText("Nothing to watch yet");
  await expect(empty).toContainText("Upload a video and you'll see it here.");
  await empty.getByRole("link", { name: "Upload video" }).click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
});

test("the states didn't load: it says so, with a retry (not 'nothing yet')", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  const down = { on: true };
  await page.route("**/jobs/status*", (r) => (down.on ? r.fulfill({ status: 503, body: "" }) : r.fallback()));
  await openWithStorage(page, "/app/preview", { [JOBS]: [job(done.id, "alt.mp4", 3_600_000)] });
  await expect(page.getByTestId("preview-load-failed")).toContainText("Couldn't load your projects");
  await expect(page.getByTestId("preview-empty")).toHaveCount(0);
  // Only Retry may load them now: the page's own poll pauses in a hidden
  // tab (Retry asks whatever the tab's visibility).
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  down.on = false;
  await page.getByTestId("preview-retry").click();
  await expect(page).toHaveURL(`${WEB}/app/p/${done.id}`);
});

test("a video waiting for Let's go in another tab: it says so, the way back is that tab's", { tag: "@editor-v2" }, async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "drueben.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  const other = await page.context().newPage();
  await other.goto("/app/preview");
  const box = other.getByTestId("preview-uploading");
  await expect(box).toContainText("Waiting for “Let’s go”");
  await expect(box.getByRole("link", { name: "Continue" })).toHaveCount(0);
  await box.getByRole("link", { name: "Back to projects" }).click();
  await expect(other).toHaveURL(`${WEB}/app`);
  await other.close();
});

test("Let's go pressed, its upload still going: it says so, the way back to Projects", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/new");
  // The upload API answers once released: the upload is still going.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await held;
    await r.continue().catch(() => {});
  });
  await chooseFile(page, { name: "laeuft.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await previewTab(page, mobile).click();
  const box = page.getByTestId("preview-uploading");
  await expect(box).toContainText("Your video is still uploading.");
  await expect(box.getByRole("link", { name: "Continue" })).toHaveCount(0);
  await box.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(`${WEB}/app`);
  release();
});

test("a video waiting for Let's go: it says so, Continue brings it back", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "wartet.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await previewTab(page, mobile).click();
  const box = page.getByTestId("preview-uploading");
  await expect(box).toContainText("Waiting for “Let’s go”");
  await box.getByRole("link", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
});
