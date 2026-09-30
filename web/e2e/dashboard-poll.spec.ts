/**
 * Dashboard (scratchpad bt/p1.mjs, p1b.mjs, p1c.mjs): no voice popup on a
 * first visit, one batched status poll every ~2 s (≤ 14 requests per
 * 10 s), expired jobs shown as such and removable, a failed render goes
 * back to review with a note, and the workflow cards open the file
 * chooser directly.
 */
import { expect, test } from "./support/fixtures";
import { API } from "./support/env";
import { ACTIVE_JOBS, card, jobCard, openWithStorage, readStorage } from "./support/app";

test.describe("dashboard", () => {
  test("first visit: no voice-test popup", async ({ page }) => {
    await page.goto("/imprint");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/app");
    await expect(page.getByTestId("picker")).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("dialog-voice-test")).toHaveCount(0);
  });

  test("status poll: batched, ≤ 14 requests per 10 s; expired jobs shown and removable", async ({ page, stub }) => {
    const review = await stub.seed("review");
    const analyzing = await stub.seed("analyzing");
    const polls: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(`${API}/jobs/`)) polls.push(r.url());
    });
    await openWithStorage(page, "/app", {
      [ACTIVE_JOBS]: [
        card(review.id, "reviewing", "echt.mp4"),
        card(analyzing.id, "analyzing", "laeuft.mp4"),
        card("0123456789ab", "analyzing", "weg.mp4"),
      ],
    });
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await page.waitForTimeout(1500);
    polls.length = 0;
    await page.waitForTimeout(10_000);
    expect(polls.length, polls.join("\n")).toBeLessThanOrEqual(14);
    // The analysing card keeps being polled (one batched GET every ~2 s).
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls.every((u) => u.startsWith(`${API}/jobs/status?ids=`))).toBe(true);

    await expect(jobCard(page, "weg.mp4").getByTestId("job-card-status")).toContainText(
      "no longer exists on the server",
    );
    await jobCard(page, "weg.mp4").getByTestId("job-card-remove").click();
    await expect(jobCard(page, "weg.mp4")).toHaveCount(0);
    const stored = await readStorage<{ jobId: string }[]>(page, ACTIVE_JOBS);
    expect(stored?.map((j) => j.jobId)).not.toContain("0123456789ab");
  });

  test("a failed render goes back to review with a note; the card reopens the editor", async ({ page, stub }) => {
    const job = await stub.seed("review", { render: "fail", render_seconds: 1 });
    await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "echt.mp4")] });
    await jobCard(page, "echt.mp4").click();
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    await page.getByTestId("apply-render").click();
    // Back on the dashboard; the card follows the render.
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect
      .poll(async () => {
        const j = (await stub.job(job.id))!;
        return `${j.status}/${j.message}`;
      }, { timeout: 30_000 })
      .toBe("awaiting_review/render_failed");
    await expect(jobCard(page, "echt.mp4").getByTestId("job-card-status")).toContainText("Render failed", {
      timeout: 20_000,
    });
    await jobCard(page, "echt.mp4").click();
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  });

  for (const preset of ["tiktok", "podcast", "vlog", "captions"] as const) {
    test(`the ${preset} card opens the file chooser directly and uploads the file`, async ({ page, stub }) => {
      await page.goto("/imprint");
      await page.evaluate(() => localStorage.clear());
      await page.goto("/app");
      const posts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
      });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        page.getByTestId(`picker-card-${preset}`).click(),
      ]);
      await chooser.setFiles({ name: "mein.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(200_000, 1) });
      // No configure screen for a workflow card: the upload starts at once.
      await expect(page.getByTestId("dashboard")).toBeVisible();
      await expect(jobCard(page, "mein.mp4")).toBeVisible();
      // The card swaps its temporary id for the job POST /jobs created.
      const jobId = async () =>
        ((await readStorage<{ jobId: string }[]>(page, ACTIVE_JOBS)) ?? [])
          .map((j) => j.jobId)
          .find((id) => !id.startsWith("upl-")) ?? null;
      await expect.poll(jobId, { timeout: 20_000 }).not.toBeNull();
      expect(posts).toHaveLength(1);
      const job = await stub.job((await jobId())!);
      expect(job?.filename).toBe("mein.mp4");
      expect(job?.preset_id).toBe(preset);
    });
  }

  test("custom setup: the chosen file reaches the configure screen", async ({ page }) => {
    await page.goto("/imprint");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/app");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.getByTestId("picker-card-custom").click(),
    ]);
    // The <input> is re-created by the screen switch: the chooser must be
    // the live one, or the file is lost (p1c).
    expect(await chooser.element().evaluate((el) => el.isConnected)).toBe(true);
    await chooser.setFiles({ name: "eigen.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(100_000, 1) });
    await expect(page.getByTestId("configure-process")).toBeVisible();
    await expect(page.getByText("eigen.mp4", { exact: false })).toBeVisible();
  });
});
