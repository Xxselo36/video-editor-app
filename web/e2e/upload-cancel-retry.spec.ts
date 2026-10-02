/**
 * Upload tiles (UX12, flows.md §3.3): an upload can be cancelled (nothing
 * is left, no job is created); a failed one says why and "Try again"
 * goes on — at once with the file this page still has, after a reload by
 * picking the same file again.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { chooseFile, createdJobId, jobCard, openWithStorage, storedJobs } from "./support/app";

/** Pick `name` on the start screen (UX6) and go on to Projects while it
 *  uploads. */
async function pickTikTok(page: Page, name: string, buffer: Buffer) {
  await chooseFile(page, { name, mimeType: "video/mp4", buffer });
  const toProjects = page.getByTestId("start-to-projects");
  await expect(toProjects.or(page.getByTestId("dashboard"))).toBeVisible({ timeout: 15_000 });
  if (await toProjects.isVisible()) await toProjects.click().catch(() => {});
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
}

test("cancel: the upload stops and nothing is left", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const media = await stub.media("grid.mp4");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
  });
  await openWithStorage(page, "/app/new");
  // A slow upload: every request of the upload API waits.
  await page.route("**/uploads/**", async (r) => {
    await new Promise((res) => setTimeout(res, 2500));
    await r.continue().catch(() => {});
  });
  await pickTikTok(page, "abbrechen.mp4", media);
  const tile = jobCard(page, "abbrechen.mp4");
  await expect(tile).toHaveAttribute("data-state", "uploading");
  await expect(tile.getByTestId("job-card-status")).toContainText("Keep this tab open");
  await tile.getByTestId("job-card-cancel").click();
  await expect(tile).toHaveCount(0);
  await page.waitForTimeout(6000);
  expect(posts).toEqual([]);
  expect((await storedJobs(page)).filter((j) => j.filename === "abbrechen.mp4")).toEqual([]);
});

test("a failed upload: its reason, then Try again creates the job", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const media = await stub.media("grid.mp4");
  await openWithStorage(page, "/app/new");
  let refuse = true;
  await page.route(`${API}/jobs`, (r) => {
    if (r.request().method() !== "POST" || !refuse) return r.fallback();
    refuse = false;
    return r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "server_busy", code: "server_busy", params: {} }) });
  });
  await pickTikTok(page, "nochmal.mp4", media);
  const tile = jobCard(page, "nochmal.mp4");
  await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 30_000 });
  await expect(tile.getByTestId("job-card-status")).toContainText("busy");
  // This page still has the file: no file chooser, straight on.
  await tile.getByTestId("job-card-retry").click();
  await expect(tile).toHaveAttribute("data-phase", "analyzing", { timeout: 30_000 });
  await expect.poll(() => createdJobId(page, "nochmal.mp4")).not.toBeNull();
  expect((await storedJobs(page)).filter((j) => j.filename === "nochmal.mp4")).toHaveLength(1);
});

test("after a reload, Try again asks for the same file", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const media = await stub.media("grid.mp4");
  await openWithStorage(page, "/app/new");
  // The connection drops on the upload itself.
  await page.route("**/uploads/presign", (r) => r.abort("internetdisconnected"));
  await pickTikTok(page, "wieder.mp4", media);
  const tile = jobCard(page, "wieder.mp4");
  await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 30_000 });
  await page.unroute("**/uploads/presign");
  await page.reload();
  await expect(tile).toHaveAttribute("data-state", "upload_failed");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), tile.getByTestId("job-card-retry").click()]);
  await chooser.setFiles({ name: "wieder.mp4", mimeType: "video/mp4", buffer: media });
  await expect(tile).toHaveAttribute("data-phase", "analyzing", { timeout: 30_000 });
  const id = await createdJobId(page, "wieder.mp4");
  expect(id).not.toBeNull();
  const created = await stub.job(id!);
  expect(created?.filename).toBe("wieder.mp4");
});
