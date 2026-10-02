/**
 * The processing view (UX12, flows.md §3.4): /app/p/<id> of a job being
 * analysed shows the stages as a checklist that advances with the job's
 * stage codes, an estimate of the time left ("taking longer than usual"
 * past 3× of it), and opens the editor by itself — within 5 s of the
 * review status — while the view is visible. No notify button (G9).
 */
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { WEB } from "./support/env";

test("the stage list advances and the editor opens by itself", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const job = await stub.seed("review");
  // The job as the page sees it: processing at `stage` until `review`.
  const state = { stage: "analyze.normalize", progress: 5, review: false, reviewAt: 0 };
  await page.route(`**/jobs/${job.id}`, async (route) => {
    const res = await route.fetch();
    if (state.review) return route.fulfill({ response: res });
    const body = { ...(await res.json()), status: "processing", stage: state.stage, progress: state.progress, message: "…" };
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await openWithStorage(page, `/app/p/${job.id}`);
  const view = page.getByTestId("processing");
  await expect(view).toHaveAttribute("data-phase", "analyzing");
  await expect(page.getByTestId("processing-step-uploaded")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("processing-step-listening")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("project-stage")).toHaveText("Preparing your video");
  await expect(page.getByRole("button", { name: /notify/i })).toHaveCount(0);

  for (const [stage, step] of [
    ["analyze.transcribe", "listening"],
    ["analyze.cuts", "cutting"],
    ["analyze.captions", "captions"],
  ] as const) {
    state.stage = stage;
    state.progress += 20;
    await expect(view).toHaveAttribute("data-step", step, { timeout: 10_000 });
    await expect(page.getByTestId(`processing-step-${step}`)).toHaveAttribute("aria-current", "step");
  }
  await expect(page.getByTestId("processing-step-listening")).toHaveAttribute("data-state", "done");

  // Analysis done: the editor opens within 5 s.
  state.review = true;
  const t0 = Date.now();
  await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`, { timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThanOrEqual(5_000);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
});

test("time left, and 'taking longer than usual' past 3× the estimate", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const job = await stub.seed("analyzing");
  let created = Date.now() / 1000 - 10;
  await page.route(`**/jobs/${job.id}`, async (route) => {
    const res = await route.fetch();
    const body = { ...(await res.json()), duration: 120, created_at: created };
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await openWithStorage(page, `/app/p/${job.id}`);
  // 2 min of video ≈ 144 s of analysis; 10 s in: "About 3 minutes left".
  const eta = page.getByTestId("processing-eta");
  await expect(eta).toHaveAttribute("data-kind", "minutes");
  await expect(eta).toHaveText("About 3 minutes left");
  // Started 10 minutes ago: well past 3 × 144 s.
  created = Date.now() / 1000 - 600;
  await page.reload();
  await expect(eta).toHaveAttribute("data-kind", "slow");
  await expect(eta).toContainText("longer than usual");
});

test("an export shows its own steps", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const job = await stub.seed("rendering");
  await openWithStorage(page, `/app/p/${job.id}`);
  await expect(page.getByTestId("processing")).toHaveAttribute("data-phase", "rendering");
  await expect(page.getByTestId("processing-step-encode")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("processing-step-prepare")).toHaveAttribute("data-state", "done");
});
