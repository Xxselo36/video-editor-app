/**
 * Projects (UX12, flows.md §3.9): one page instead of the dashboard and
 * /app/library — a badge per state, the existing customer's cards and
 * library entries carried over, expired projects collapsed without
 * thumbnail requests, rename and delete through the ⋯ menu, search and
 * filters, no console errors, and /app/library redirects to /app.
 * The v2 opt-in only (@editor-v2: a build with NEXT_PUBLIC_EDITOR_V2=1);
 * everyone else keeps the dashboard and library (projects.spec.ts).
 */
import { expect, test } from "./support/fixtures";
import {
  ACTIVE_JOBS,
  card,
  horizontalOverflow,
  job,
  JOBS,
  jobCard,
  LIBRARY,
  libEntry,
  openWithStorage,
  storedJobs,
  tileMenu,
} from "./support/app";
import { WEB } from "./support/env";

test("one page: a badge per state, an existing customer's projects, 0 console errors", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const review = await stub.seed("review");
  const analyzing = await stub.seed("analyzing");
  const queued = await stub.seed("queued");
  const rendering = await stub.seed("rendering");
  const done = await stub.seed("done");
  const failed = await stub.seed("err_no_speech");
  const renderFailed = await stub.seed("render_failed");
  const edited = await stub.seed("edited");
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const thumbs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/thumbnail")) thumbs.push(r.url());
  });
  // What a customer of before UX12 has: dashboard cards + library entries.
  await openWithStorage(page, "/app", {
    [ACTIVE_JOBS]: [
      card(review.id, "reviewing", "review.mp4"),
      card(analyzing.id, "analyzing", "analyzing.mp4"),
      card(queued.id, "analyzing", "queued.mp4"),
      card(rendering.id, "rendering", "rendering.mp4"),
      card(failed.id, "analyzing", "failed.mp4"),
      card(renderFailed.id, "reviewing", "exportfehler.mp4"),
      card("upl-123-old", "uploading", "stopped.mp4", { uploadPct: 30 }),
    ],
    [LIBRARY]: [
      libEntry(done.id, "done.mp4"),
      libEntry(edited.id, "edited.mp4", 120_000),
      libEntry("000000000000", "old.mp4", 20 * 86_400_000),
    ],
  });
  await expect(page.getByTestId("dashboard")).toBeVisible();
  const expectState = async (name: string, state: string, badge: string) => {
    const tile = jobCard(page, name);
    await expect(tile, name).toHaveAttribute("data-state", state, { timeout: 15_000 });
    await expect(tile.getByTestId("job-card-badge"), name).toHaveText(badge);
  };
  await expectState("review.mp4", "ready", "Ready to edit");
  await expectState("analyzing.mp4", "processing", "Processing");
  await expectState("queued.mp4", "processing", "Processing");
  await expect(jobCard(page, "queued.mp4").getByTestId("job-card-status")).toContainText("Waiting in line");
  await expectState("rendering.mp4", "exporting", "Exporting");
  await expectState("done.mp4", "exported", "Exported");
  await expectState("edited.mp4", "edited", "Edited since export");
  await expectState("failed.mp4", "failed", "Failed");
  await expect(jobCard(page, "failed.mp4").getByTestId("job-card-status")).toContainText("couldn't find any speech");
  await expectState("exportfehler.mp4", "ready", "Ready to edit");
  await expect(jobCard(page, "exportfehler.mp4").getByTestId("job-card-status")).toContainText("Render failed");
  // An upload of an earlier page load: stopped, with Try again.
  await expectState("stopped.mp4", "upload_failed", "Upload stopped");
  await expect(jobCard(page, "stopped.mp4").getByTestId("job-card-retry")).toBeVisible();
  // Expired: collapsed, never a thumbnail request.
  await expect(jobCard(page, "old.mp4")).toBeHidden();
  await page.getByTestId("projects-expired").locator("summary").click();
  await expectState("old.mp4", "expired", "Expired");
  // The exported project shows its poster frame (the stub has one).
  await expect(jobCard(page, "done.mp4").getByTestId("job-card-thumb")).toBeVisible();
  expect(thumbs.filter((u) => u.includes("000000000000"))).toEqual([]);

  // Migrated once into the new list: ids and names, no statuses.
  const stored = await storedJobs(page);
  expect(stored.map((j) => j.filename).sort()).toEqual(
    ["analyzing.mp4", "done.mp4", "edited.mp4", "failed.mp4", "old.mp4", "queued.mp4", "exportfehler.mp4", "rendering.mp4", "review.mp4", "stopped.mp4"].sort(),
  );
  expect(JSON.stringify(stored)).not.toMatch(/"phase"|"status"/);

  if (info.project.use.isMobile) {
    for (const lang of ["de", "hi", "ja"]) {
      await page.getByTestId("language-switcher").first().selectOption(lang);
      await expect.poll(() => horizontalOverflow(page), { message: `projects ${lang}` }).toBeLessThanOrEqual(1);
    }
    await page.getByTestId("language-switcher").first().selectOption("en");
  }
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("rename and delete through the ⋯ menu", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  const review = await stub.seed("review");
  await openWithStorage(page, "/app", { [JOBS]: [job(done.id, "fertig.mp4"), job(review.id, "entwurf.mp4", 30_000)] });
  const tile = jobCard(page, "fertig.mp4");
  await expect(tile).toHaveAttribute("data-state", "exported");

  // Rename: on the server, and the tile follows.
  await tileMenu(page, tile, "rename");
  const input = page.getByTestId("rename-input");
  await expect(input).toBeFocused();
  await input.fill("Folge 12 – Finale");
  await page.getByTestId("rename-save").click();
  await expect(page.getByTestId("dialog-rename")).toHaveCount(0);
  const renamed = jobCard(page, "Folge 12 – Finale");
  await expect(renamed).toBeVisible();
  await expect.poll(async () => (await stub.job(done.id))?.title).toBe("Folge 12 – Finale");
  await page.reload();
  await expect(jobCard(page, "Folge 12 – Finale")).toBeVisible();

  // Download link in the menu (the primary export as an attachment).
  await renamed.getByTestId("job-card-menu").click();
  await expect(page.getByTestId("job-card-download")).toHaveAttribute("href", new RegExp(`/jobs/${done.id}/download\\?format=primary`));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("job-card-menu-list")).toHaveCount(0);
  await expect(renamed.getByTestId("job-card-menu")).toBeFocused();

  // Delete: a dialog (no browser confirm()), then gone here and on the server.
  let nativeDialog = false;
  page.on("dialog", (d) => {
    nativeDialog = true;
    void d.dismiss();
  });
  await tileMenu(page, renamed, "delete");
  const dialog = page.getByTestId("dialog-delete");
  await expect(dialog).toContainText("Folge 12 – Finale");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(renamed).toBeVisible();
  await tileMenu(page, renamed, "delete");
  await page.getByTestId("delete-confirm").click();
  await expect(renamed).toHaveCount(0);
  await expect.poll(() => stub.job(done.id)).toBeNull();
  expect((await storedJobs(page)).map((j) => j.jobId)).toEqual([review.id]);
  expect(nativeDialog).toBe(false);
});

test("search and the To edit / Exported filters", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  const review = await stub.seed("review");
  const a = await stub.seed("analyzing");
  const b = await stub.seed("error");
  await openWithStorage(page, "/app", {
    [JOBS]: [job(done.id, "urlaub.mp4"), job(review.id, "podcast.mp4"), job(a.id, "vlog.mp4"), job(b.id, "kaputt.mp4")],
  });
  await expect(jobCard(page, "urlaub.mp4")).toHaveAttribute("data-state", "exported");
  const names = async () => page.getByTestId("job-card").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await page.getByTestId("projects-filter-edit").click();
  await expect.poll(names).toEqual(["podcast.mp4"]);
  await page.getByTestId("projects-filter-exported").click();
  await expect.poll(names).toEqual(["urlaub.mp4"]);
  await page.getByTestId("projects-filter-all").click();
  await page.getByTestId("projects-search").fill("VLO");
  await expect.poll(names).toEqual(["vlog.mp4"]);
  await page.getByTestId("projects-search").fill("nothing like it");
  await expect(page.getByTestId("projects-no-results")).toContainText("nothing like it");
});

test("only expired projects: an empty state, nothing requested", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const gone = await stub.seed("projects_all_expired");
  const thumbs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/thumbnail")) thumbs.push(r.url());
  });
  await openWithStorage(page, "/app", { [LIBRARY]: [libEntry(gone.id, "alt.mp4", 30 * 86_400_000)] });
  await expect(page.getByTestId("projects-all-expired")).toContainText("deleted after 14 days");
  await expect(page.getByTestId("projects-expired")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(thumbs).toEqual([]);
});

test("/app/library redirects to Projects", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/library", { [LIBRARY]: [libEntry(done.id, "fertig.mp4")] });
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "fertig.mp4")).toBeVisible();
  // The header's link goes to Projects too.
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("href", "/app");
});
