/**
 * The Vorschau of a video being worked on (UX12, flows.md §3.4; PR2 plan
 * D11): /app/p/<id> of a job being analysed shows the stages as a
 * checklist that advances with the job's stage codes (only the steps the
 * video goes through), an estimate of the time left ("taking longer than
 * usual" past 3× of it), and — within 5 s of the review status, in place
 * — the video with Export and Fine-tune; no editor opens by itself. An
 * export in progress is the Vorschau's finishing state. No notify button
 * (G9).
 */
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { WEB } from "./support/env";
import { renderPosts, vorschau } from "./support/vorschau";

test("the stage list advances and the Vorschau takes over in place when it is ready", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const job = await stub.seed("review");
  // The job as the page sees it: processing at `stage` until `review`.
  const state = { stage: "analyze.normalize", progress: 5, review: false };
  await page.route(`**/jobs/${job.id}`, async (route) => {
    const res = await route.fetch();
    if (state.review) return route.fulfill({ response: res });
    const body = { ...(await res.json()), status: "processing", stage: state.stage, progress: state.progress, message: "…" };
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  const urls: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) urls.push(f.url());
  });
  await openWithStorage(page, `/app/p/${job.id}`);
  await expect(vorschau(page)).toHaveAttribute("data-state", "processing");
  // The title row is there in every state: the name without its extension.
  await expect(page.getByTestId("preview-title")).toHaveText("test");
  await expect(page.getByTestId("project-back")).toHaveCount(0);
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
  await expect(page.getByTestId("processing-step-ready")).toHaveText("Ready");

  // Analysis done: within 5 s the video takes the checklist's place; the
  // page stays (the editor opens through Fine-tune only).
  state.review = true;
  const t0 = Date.now();
  await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThanOrEqual(5_000);
  await expect(page.getByTestId("processing")).toHaveCount(0);
  await expect(page.getByTestId("preview-video")).toBeVisible();
  await expect(page.getByTestId("preview-finish")).toHaveText("Export");
  await expect(page.getByTestId("preview-refine")).toHaveText("Fine-tune");
  await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
  expect(urls.filter((u) => u.includes("/app/edit/"))).toEqual([]);
  await expect(page.getByTestId("editor-v2")).toHaveCount(0);
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

test("“Captions only” and “No captions”: the steps the video skips aren't listed", { tag: "@editor-v2" }, async ({ page, stub }) => {
  // The server's flags (no_cuts, captions_off) from the choices it was started with.
  const job = await stub.seed("analyzing", { settings: { style: "none", caption_style: { presetId: "none", overrides: {} } } });
  await openWithStorage(page, `/app/p/${job.id}`);
  const view = page.getByTestId("processing");
  await expect(view).toHaveAttribute("data-step", "listening");
  await expect(page.getByTestId("processing-steps").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByTestId("processing-step-cutting")).toHaveCount(0);
  await expect(page.getByTestId("processing-step-captions")).toHaveCount(0);
  await expect(page.getByTestId("processing-step-ready")).toHaveText("Ready");
});

test("an export in progress is the finishing state: Exporting…, the page can close, its place in line", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const job = await stub.seed("rendering");
  // Later on, the export of a video exported before waits for a render slot.
  let queued = false;
  await page.route(`**/jobs/${job.id}`, async (route) => {
    const res = await route.fetch();
    if (!queued) return route.fulfill({ response: res });
    const body = { ...(await res.json()), stage: "queued", message: "queued", queue_position: 2, has_output: true };
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  const renders = renderPosts(page, job.id);
  await openWithStorage(page, `/app/p/${job.id}`);
  await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
  const finish = page.getByTestId("preview-finish");
  await expect(finish).toHaveText("Exporting…");
  await expect(finish).toHaveAttribute("data-state", "working");
  await expect(finish).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("preview-note")).toHaveText("You can close this page. Your video will be waiting in Projects.");
  await expect(page.getByTestId("preview-refine")).toHaveCount(0);
  await expect(page.getByTestId("processing")).toHaveCount(0);
  // Pressed again: nothing (it is exporting already).
  await finish.click({ force: true });
  queued = true;
  await expect(page.getByTestId("preview-queue")).toHaveText("Waiting for a free slot (number 2 in line)", { timeout: 10_000 });
  await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
  expect(renders).toEqual([]);
});
