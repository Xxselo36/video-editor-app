/**
 * A second upload while the first one runs (scratchpad bt/p5b.mjs,
 * p5conc.mjs): progress ticks of upload 1 don't throw the user out of
 * the workflow picker, and both uploads end up as cards.
 */
import { expect, test } from "./support/fixtures";
import { jobCard, openWithStorage } from "./support/app";

test("a second upload can start while the first is still uploading", async ({ page, stub, browserName }) => {
  test.skip(browserName !== "chromium", "network throttling via CDP (Chromium only)");
  const clip = await stub.media("grid.mp4");
  await openWithStorage(page, "/app");
  await expect(page.getByTestId("picker")).toBeVisible();

  // Slow uploads (150 kB/s): the first file (~4 MB) keeps uploading.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 20,
    downloadThroughput: 10e6,
    uploadThroughput: 150e3,
  });
  const pick = async (name: string, buffer: Buffer) => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.getByTestId("picker-card-tiktok").click(),
    ]);
    await chooser.setFiles({ name, mimeType: "video/mp4", buffer });
  };

  await pick("one.mp4", Buffer.concat([clip, Buffer.alloc(3_000_000, 1)]));
  await expect(jobCard(page, "one.mp4")).toBeVisible();
  await expect(jobCard(page, "one.mp4")).toHaveAttribute("data-phase", "uploading");

  await page.getByTestId("dashboard-new-video").click();
  await page.waitForTimeout(8000); // several progress ticks of upload 1
  await expect(page.getByTestId("picker")).toBeVisible();
  await expect(page.getByTestId("picker-back")).toBeVisible();

  await pick("two.mp4", clip);
  await expect(jobCard(page, "one.mp4")).toBeVisible();
  await expect(jobCard(page, "two.mp4")).toBeVisible();
});
