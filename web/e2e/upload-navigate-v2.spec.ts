/**
 * An upload outlives in-app navigation (the owner's iPhone, 2026-10): it
 * belongs to the page (features/upload/uploadManager), not to the start
 * screen, so going to Projects mid-upload shows its live progress and it
 * finishes there. A full page load is different — it cuts the upload —
 * and the tile then says "interrupted", never "connection_lost".
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { chooseFile, createdJobId, jobCard, openWithStorage, storedJobs } from "./support/app";

/** A slow upload: the upload API waits a little, the body (the stub has
 *  no R2: it goes with POST /jobs) `ms`. */
async function throttleUpload(page: Page, ms: number) {
  await page.route("**/uploads/**", async (r) => {
    await new Promise((res) => setTimeout(res, 300));
    await r.continue().catch(() => {});
  });
  await page.route(`${API}/jobs`, async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    await new Promise((res) => setTimeout(res, ms));
    await r.continue().catch(() => {});
  });
}

/** Mark this document: still there after a client-side navigation. */
const markDocument = (page: Page) => page.evaluate(() => ((window as unknown as { __doc?: number }).__doc = 1));
const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __doc?: number }).__doc === 1);

test.describe("an upload while the user moves around the app", { tag: "@editor-v2" }, () => {
  test("Projects mid-upload: live progress, no connection_lost, and the upload finishes", async ({ page, stub }) => {
    const media = await stub.media("grid.mp4");
    await openWithStorage(page, "/app/new");
    await throttleUpload(page, 26_000);
    await chooseFile(page, { name: "wandert.mp4", mimeType: "video/mp4", buffer: media });
    await expect(page.getByTestId("start-upload")).toBeVisible();
    await markDocument(page);

    // To Projects while it uploads (a client-side navigation).
    await page.getByTestId("start-to-projects").click();
    await expect(page).toHaveURL(`${WEB}/app`);
    const tile = jobCard(page, "wandert.mp4");
    await expect(tile).toHaveAttribute("data-state", "uploading");
    // Back to the start screen and to Projects again (the header link).
    await page.getByTestId("dashboard-new-video").click();
    await expect(page.getByTestId("start-screen")).toBeVisible();
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(`${WEB}/app`);
    await expect(tile).toHaveAttribute("data-state", "uploading");
    expect(await sameDocument(page)).toBe(true);
    // Past markStaleUploads' 20 s for a record no page owns: this page's
    // upload is never taken for a dead one.
    await page.waitForTimeout(21_000);
    await expect(tile).toHaveAttribute("data-state", "uploading");
    await expect(tile.getByTestId("job-card-retry")).toHaveCount(0);
    await expect(tile).not.toContainText("connection_lost");

    // The upload finishes here: the tile is the project now.
    await expect(tile).not.toHaveAttribute("data-state", "uploading", { timeout: 30_000 });
    await expect(tile).not.toHaveAttribute("data-state", "upload_failed");
    await expect.poll(() => createdJobId(page, "wandert.mp4"), { timeout: 15_000 }).not.toBeNull();
    expect((await storedJobs(page)).filter((j) => j.filename === "wandert.mp4")).toHaveLength(1);
    expect(await sameDocument(page)).toBe(true);
  });

  test("a full page load mid-upload: the tile says interrupted, not connection_lost", async ({ page, stub }) => {
    const media = await stub.media("grid.mp4");
    // Next falls back to a full page load when the navigation's RSC fetch
    // fails (or a deploy happened since the page loaded). From the start:
    // no prefetch of /app gets through either.
    await page.route(`${WEB}/app**`, (r) => (r.request().headers()["rsc"] ? r.abort() : r.fallback()));
    await openWithStorage(page, "/app/new");
    await throttleUpload(page, 60_000);
    await chooseFile(page, { name: "neu-geladen.mp4", mimeType: "video/mp4", buffer: media });
    await expect(page.getByTestId("start-upload")).toBeVisible();
    await markDocument(page);
    await page.getByTestId("start-to-projects").click();
    await expect(page).toHaveURL(`${WEB}/app`);
    await expect.poll(() => sameDocument(page)).toBe(false);

    const tile = jobCard(page, "neu-geladen.mp4");
    // At once — not after markStaleUploads' 20 s of a frozen "uploading".
    await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 5000 });
    await expect(tile).not.toContainText("connection_lost");
    const rec = (await storedJobs(page)).find((j) => j.filename === "neu-geladen.mp4");
    expect(rec?.upload?.errorCode).toBe("upload_interrupted");
    await expect(tile.getByTestId("job-card-retry")).toBeVisible();
  });
});
