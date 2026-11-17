/**
 * The Vorschau tab (/app/preview, PR3 plan D15): it opens the Vorschau
 * last opened in this browser tab unless a newer project came since,
 * else the newest project with something to show; with none it says
 * what there is (a video waiting for "Let's go", or nothing yet). v2 only.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { chooseFile, job, JOBS, openWithStorage } from "./support/app";
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
