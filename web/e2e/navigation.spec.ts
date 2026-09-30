/**
 * Routes of /app (UX5, PLAN_TECH §1.1): every route survives a reload,
 * the back button walks the routes, a deep link works in a fresh browser
 * context, the pre-UX5 editor link (/app?job=…) redirects, the first
 * paint of /app is never the picker for a returning user, and an upload
 * keeps going while the user moves between routes (uploadManager).
 */
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, LIBRARY, card, jobCard, libEntry, openFromDashboard, openWithStorage } from "./support/app";
import { WEB } from "./support/env";

const path = (url: string) => new URL(url).pathname;

test("dashboard → editor → reload → back → new video → back", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "echt.mp4")] });
  await expect(page.getByTestId("dashboard")).toBeVisible();

  await openFromDashboard(page, "echt.mp4");
  expect(path(page.url())).toBe(`/app/edit/${job.id}`);

  await page.reload();
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });

  await page.goBack();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(path(page.url())).toBe("/app");
  await expect(jobCard(page, "echt.mp4")).toBeVisible();

  // New video → /app/new; a workflow card opens the file chooser (cancelled) → the file screen.
  await page.getByTestId("dashboard-new-video").click();
  await expect(page.getByTestId("picker")).toBeVisible();
  expect(path(page.url())).toBe("/app/new");
  await page.reload();
  await expect(page.getByTestId("picker")).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.getByTestId("picker-card-tiktok").click(),
  ]);
  expect(chooser).toBeTruthy();
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();

  // Back leaves the file screen and stays in the app.
  await page.goBack();
  await expect(page.getByTestId("upload-dropzone")).toHaveCount(0);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(path(page.url())).toBe("/app");
});

test("every route survives a reload", async ({ page, stub }) => {
  const review = await stub.seed("review");
  const done = await stub.seed("done");
  const failed = await stub.seed("err_no_speech");
  const running = await stub.seed("analyzing");
  await openWithStorage(page, "/app", { [LIBRARY]: [libEntry(done.id, "fertig.mp4")] });
  const routes: [string, string][] = [
    ["/app", "dashboard"],
    ["/app/new", "picker"],
    [`/app/edit/${review.id}`, "editor"],
    [`/app/p/${done.id}`, "project"],
    [`/app/p/${failed.id}`, "project"],
    [`/app/p/${running.id}`, "project"],
    ["/app/library", "library-card"],
  ];
  for (const [route, testId] of routes) {
    await page.goto(route);
    await expect(page.getByTestId(testId).first(), route).toBeVisible({ timeout: 45_000 });
    await page.reload();
    await expect(page.getByTestId(testId).first(), `${route} after a reload`).toBeVisible({ timeout: 45_000 });
    expect(path(page.url())).toBe(route);
  }
});

test("the project view switches by status", async ({ page, stub }) => {
  const done = await stub.seed("done");
  const failed = await stub.seed("err_no_speech");
  const running = await stub.seed("rendering");
  const review = await stub.seed("review");
  await openWithStorage(page, `/app/p/${done.id}`);
  await expect(page.getByTestId("project")).toHaveAttribute("data-status", "done");
  await expect(page.getByRole("link", { name: /download/i }).first()).toBeVisible();

  await page.goto(`/app/p/${failed.id}`);
  const project = page.getByTestId("project");
  await expect(project).toHaveAttribute("data-status", "error");
  await expect(page.getByTestId("error-message")).toContainText("couldn't find any speech");
  await expect(page.getByTestId("error-message")).toContainText("credited");
  await page.getByRole("button", { name: "Try another video" }).click();
  await expect(page).toHaveURL(`${WEB}/app/new`);

  await page.goto(`/app/p/${running.id}`);
  await expect(page.getByTestId("project")).toHaveAttribute("data-status", "processing");
  await expect(page.getByTestId("job-card")).toBeVisible();
  await expect(page.getByTestId("project-stage")).toHaveText("Exporting");

  // In review: the editor.
  await page.goto(`/app/p/${review.id}`);
  await expect(page).toHaveURL(`${WEB}/app/edit/${review.id}`);
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });

  // A project the server doesn't know.
  await page.goto("/app/p/doesnotexist1");
  await expect(page.getByTestId("error-message")).toContainText("no longer exists");
});

test("a deep link works in a new browser context", async ({ browser, stub }) => {
  const job = await stub.seed("review");
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto(`/app/edit/${job.id}`);
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  // Back from a deep link stays in the app: the dashboard, which — with
  // nothing on this device yet — goes on to the picker.
  await page.getByTestId("editor-back").click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await expect(page.getByTestId("picker")).toBeVisible();
  await ctx.close();
});

test("the pre-UX5 editor link /app?job=… redirects to the editor", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openWithStorage(page, `/app?job=${job.id}`);
  await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("picker")).toHaveCount(0);
});

test("a finished or running job's editor link shows its project", async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, `/app/edit/${done.id}`);
  await expect(page).toHaveURL(`${WEB}/app/p/${done.id}`);
  await expect(page.getByTestId("project")).toHaveAttribute("data-status", "done");
});

test("/app never paints the picker for a returning user", async ({ page, stub }) => {
  const job = await stub.seed("analyzing");
  await page.goto("/imprint");
  await page.evaluate(
    ([k, v]) => {
      localStorage.clear();
      localStorage.setItem(k, v);
    },
    [ACTIVE_JOBS, JSON.stringify([card(job.id, "analyzing", "läuft.mp4")])] as const,
  );
  // What the page shows at DOMContentLoaded, before any effect ran.
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("picker")).toHaveCount(0);
  const first = await page.evaluate(() =>
    Boolean(document.querySelector('[data-testid="dashboard-skeleton"], [data-testid="dashboard"]')),
  );
  expect(first).toBe(true);
  await page.screenshot({ path: test.info().outputPath("app-first-paint.png") });
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("picker")).toHaveCount(0);
});

test("a first visit goes from /app to the picker", async ({ page }) => {
  await openWithStorage(page, "/app");
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await expect(page.getByTestId("picker")).toBeVisible();
  await expect(page.getByTestId("picker-back")).toHaveCount(0);
});

test("an upload keeps going while the user changes routes", async ({ page, stub }) => {
  const review = await stub.seed("review");
  await stub.config({ by_filename: { "wandert.mp4": { analysis_seconds: 60 } } });
  await openWithStorage(page, "/app/new", { [ACTIVE_JOBS]: [card(review.id, "reviewing", "andere.mp4")] });
  // A slow upload: every request of the upload API waits a little.
  await page.route("**/uploads/**", async (r) => {
    await new Promise((res) => setTimeout(res, 400));
    await r.continue();
  });
  const media = await stub.media("grid.mp4");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("picker-card-tiktok").click(),
  ]);
  await chooser.setFiles({ name: "wandert.mp4", mimeType: "video/mp4", buffer: media });
  await expect(page).toHaveURL(`${WEB}/app`);
  const upload = jobCard(page, "wandert.mp4");
  await expect(upload).toBeVisible();
  // Into another project's editor and back while it uploads.
  await openFromDashboard(page, "andere.mp4");
  await page.goBack();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // The same upload finished: its card is the job's now (analyzing), no error.
  await expect(upload).toHaveAttribute("data-phase", "analyzing", { timeout: 60_000 });
  await expect(upload.getByTestId("job-card-remove")).toHaveCount(0);
});
