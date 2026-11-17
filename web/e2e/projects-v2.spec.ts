/**
 * Projekte (PR3, plan §6 P3-C and D17; UX12 before it): one list instead
 * of the dashboard and /app/library, a row per project with its state in
 * the status line (a word for screen readers where the line shows only
 * time and length), the existing customer's cards and library entries
 * carried over, expired projects collapsed without frame requests. Rows
 * with something to show open their Vorschau, where rename and delete
 * are; a row Cleo still works on is grey and opens nothing — its own
 * Delete asks first (Cleo stops) — and once it is ready it says so in
 * place. /app/library redirects to /app.
 * The v2 editor only (@editor-v2: a v2 build, NEXT_PUBLIC_EDITOR_V2 unset
 * or 1); v1 browsers keep the dashboard and library (projects.spec.ts,
 * the v1 run's NEXT_PUBLIC_EDITOR_V2=optin build).
 */
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  ACTIVE_JOBS,
  card,
  horizontalOverflow,
  job,
  JOBS,
  jobCard,
  LANG_KEY,
  LIBRARY,
  libEntry,
  openWithStorage,
  storedJobs,
} from "./support/app";
import { API, WEB } from "./support/env";

/** The Vorschau's ⋯ menu (the title row; on phones the top bar's end). */
async function previewMenu(page: Page, item: "download" | "rename" | "delete") {
  await page.getByTestId("job-card-menu").click();
  await page.getByTestId(`job-card-${item}`).click();
}

test("one list: a row per state, an existing customer's projects, 0 console errors", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
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
  const frames: string[] = [];
  page.on("request", (r) => {
    if (/\/(thumbnail|poster)\b/.test(r.url())) frames.push(r.url());
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
  // Its state: the row's data-state and the status line's words (some only
  // for screen readers: the line of a finished row shows time and length).
  const expectState = async (name: string, state: string, words: string | RegExp) => {
    const row = jobCard(page, name);
    await expect(row, name).toHaveAttribute("data-state", state, { timeout: 15_000 });
    await expect(row.getByTestId("job-card-meta"), name).toContainText(words);
  };
  await expectState("review.mp4", "ready", "Ready to edit");
  await expectState("analyzing.mp4", "processing", "Processing");
  await expectState("queued.mp4", "processing", "Processing");
  await expect(jobCard(page, "queued.mp4").getByTestId("job-card-status")).toContainText("Waiting in line");
  await expectState("rendering.mp4", "exporting", "Exporting");
  await expectState("done.mp4", "exported", "Exported");
  await expect(jobCard(page, "edited.mp4")).toHaveAttribute("data-state", "edited");
  await expect(jobCard(page, "edited.mp4").getByTestId("job-card-status")).toHaveText("Edited since export");
  await expectState("failed.mp4", "failed", "Failed");
  await expect(jobCard(page, "failed.mp4").getByTestId("job-card-status")).toContainText("couldn't find any speech");
  await expectState("exportfehler.mp4", "ready", "Ready to edit");
  await expect(jobCard(page, "exportfehler.mp4").getByTestId("job-card-status")).toContainText("Exporting didn't work");
  // An upload of an earlier page load: stopped, with Try again.
  await expectState("stopped.mp4", "upload_failed", "Upload stopped");
  await expect(jobCard(page, "stopped.mp4").getByTestId("job-card-retry")).toBeVisible();
  // Finished rows show when and how long; the source's length until the
  // server knows the cut's (the seeds' timelines).
  await expect(jobCard(page, "done.mp4").getByTestId("job-card-meta")).toContainText(/\d+:\d\d/);
  // Where they lead: the Vorschau, not while Cleo works on the video.
  await expect(jobCard(page, "done.mp4").getByTestId("job-card-open")).toHaveAttribute("href", `/app/p/${done.id}`);
  await expect(jobCard(page, "failed.mp4").getByTestId("job-card-open")).toHaveAttribute("href", `/app/p/${failed.id}`);
  await expect(jobCard(page, "rendering.mp4").getByTestId("job-card-open")).toHaveCount(1);
  await expect(jobCard(page, "analyzing.mp4").getByTestId("job-card-open")).toHaveCount(0);
  await expect(jobCard(page, "analyzing.mp4")).toHaveAttribute("data-busy", "true");
  await expect(jobCard(page, "stopped.mp4").getByTestId("job-card-open")).toHaveCount(0);
  // Expired: collapsed, never a frame request.
  await expect(jobCard(page, "old.mp4")).toBeHidden();
  await page.getByTestId("projects-expired").locator("summary").click();
  await expectState("old.mp4", "expired", "Expired");
  // The exported project shows its frame (the stub has one).
  await expect(jobCard(page, "done.mp4").getByTestId("job-card-thumb")).toBeVisible();
  expect(frames.filter((u) => u.includes("000000000000"))).toEqual([]);
  // Nothing of before: counts, the "New video" pill, search, filters.
  for (const id of ["dashboard-counts", "dashboard-new-video", "projects-search", "projects-filter-all"]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }

  // Migrated once into the new list: ids and names, no statuses.
  const stored = await storedJobs(page);
  expect(stored.map((j) => j.filename).sort()).toEqual(
    ["analyzing.mp4", "done.mp4", "edited.mp4", "failed.mp4", "old.mp4", "queued.mp4", "exportfehler.mp4", "rendering.mp4", "review.mp4", "stopped.mp4"].sort(),
  );
  expect(JSON.stringify(stored)).not.toMatch(/"phase"|"status"/);

  if (info.project.use.isMobile) {
    for (const lang of ["de", "hi", "ja"]) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [LANG_KEY, lang]);
      await page.reload();
      await expect(jobCard(page, "done.mp4")).toHaveAttribute("data-state", "exported");
      await expect.poll(() => horizontalOverflow(page), { message: `projects ${lang}` }).toBeLessThanOrEqual(1);
    }
  }
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("a finished row opens its Vorschau; rename and delete there", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  const review = await stub.seed("review");
  await openWithStorage(page, "/app", { [JOBS]: [job(done.id, "fertig.mp4"), job(review.id, "entwurf.mp4", 30_000)] });
  const row = jobCard(page, "fertig.mp4");
  await expect(row).toHaveAttribute("data-state", "exported");
  await row.getByTestId("job-card-open").click();
  await expect(page).toHaveURL(`${WEB}/app/p/${done.id}`);

  // Rename: on the server, and the row follows.
  await previewMenu(page, "rename");
  const input = page.getByTestId("rename-input");
  await expect(input).toBeFocused();
  await input.fill("Folge 12, das Finale");
  await page.getByTestId("rename-save").click();
  await expect(page.getByTestId("dialog-rename")).toHaveCount(0);
  await expect(page.getByTestId("preview-title")).toHaveText("Folge 12, das Finale");
  await expect.poll(async () => (await stub.job(done.id))?.title).toBe("Folge 12, das Finale");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(jobCard(page, "Folge 12, das Finale")).toBeVisible();

  // The download link in the menu (the primary export as an attachment).
  await jobCard(page, "Folge 12, das Finale").getByTestId("job-card-open").click();
  await page.getByTestId("job-card-menu").click();
  await expect(page.getByTestId("job-card-download")).toHaveAttribute("href", new RegExp(`/jobs/${done.id}/download\\?format=primary`));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("job-card-menu-list")).toHaveCount(0);
  await expect(page.getByTestId("job-card-menu")).toBeFocused();

  // Delete: a dialog (no browser confirm()), then gone here and on the server.
  let nativeDialog = false;
  page.on("dialog", (d) => {
    nativeDialog = true;
    void d.dismiss();
  });
  await previewMenu(page, "delete");
  const dialog = page.getByTestId("dialog-delete");
  await expect(dialog).toContainText("Folge 12, das Finale");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await previewMenu(page, "delete");
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "entwurf.mp4")).toBeVisible();
  await expect(jobCard(page, "Folge 12, das Finale")).toHaveCount(0);
  await expect.poll(() => stub.job(done.id)).toBeNull();
  expect((await storedJobs(page)).map((j) => j.jobId)).toEqual([review.id]);
  expect(nativeDialog).toBe(false);
});

test("busy rows don't open, finished rows do; ready during the visit says Ready · m:ss in place", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const busy = await stub.seed("review");
  const done = await stub.seed("done");
  // The job as the page sees it: analysed until `ready`.
  const state = { ready: false };
  await page.route(`${API}/jobs/status*`, async (route: Route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers.etag;
    if (res.status() !== 200) return route.fulfill({ response: res, headers });
    const body = (await res.json()) as { jobs: Record<string, unknown>[] };
    if (!state.ready) {
      for (const j of body.jobs) {
        if (j.id === busy.id) Object.assign(j, { status: "processing", stage: "analyze.transcribe", progress: 40, message: "…" });
      }
    }
    return route.fulfill({ response: res, headers, body: JSON.stringify(body) });
  });
  await openWithStorage(page, "/app", { [JOBS]: [job(busy.id, "frisch.mp4", 5_000), job(done.id, "alt.mp4", 3_600_000)] });
  const row = jobCard(page, "frisch.mp4");
  await expect(row).toHaveAttribute("data-state", "processing");
  await expect(row).toHaveAttribute("data-busy", "true");
  await expect(row.getByTestId("job-card-open")).toHaveCount(0);
  // Its note: the work runs on the server.
  await expect(row.getByTestId("job-card-status")).toHaveText("You can close this page.");
  // Its own Delete (the Vorschau's ⋯ is out of reach from here).
  await expect(row.getByTestId("job-card-delete")).toBeVisible();
  // A click on the busy row goes nowhere (on its frame: not the Delete).
  await row.click({ position: { x: 12, y: 12 } });
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "alt.mp4").getByTestId("job-card-open")).toHaveAttribute("href", `/app/p/${done.id}`);
  const meta = row.getByTestId("job-card-meta");
  // Screen readers hear the change only, not every percent or minute.
  await expect(meta).not.toHaveAttribute("aria-live", /.+/);
  const announce = row.getByTestId("job-card-announce");
  await expect(announce).toHaveAttribute("role", "status");
  await expect(announce).toHaveText("");
  await meta.evaluate((el) => {
    (window as unknown as { __metaNode: Element }).__metaNode = el;
  });

  state.ready = true;
  await expect(row).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-fresh", "true");
  await expect(row).not.toHaveAttribute("data-busy", "true");
  await expect(row.getByTestId("job-card-delete")).toHaveCount(0);
  await expect(meta).toHaveText(/^Ready · \d+:\d\d$/);
  // The same line, in place, not a new row; screen readers hear which.
  expect(await meta.evaluate((el) => (window as unknown as { __metaNode: Element }).__metaNode === el)).toBe(true);
  await expect(announce).toHaveText("“frisch.mp4” is ready");
  // A tap on its frame opens it, and one on its name (nothing over the
  // row's link there: Playwright's hit check would fail).
  const open = row.getByTestId("job-card-open");
  const at = async (part: Locator) => {
    const [l, p] = [(await open.boundingBox())!, (await part.boundingBox())!];
    return { x: p.x - l.x + p.width / 2, y: p.y - l.y + p.height / 2 };
  };
  await open.click({ position: await at(row.getByTestId("job-card-thumb").or(row.getByTestId("job-card-nothumb"))) });
  await expect(page).toHaveURL(`${WEB}/app/p/${busy.id}`);
  await page.goBack();
  await expect(row).toHaveAttribute("data-state", "ready");
  await open.click({ position: await at(row.locator("h3")) });
  await expect(page).toHaveURL(`${WEB}/app/p/${busy.id}`);
});

test("a row Cleo works on: Delete asks first, says Cleo stops, then it is gone here and on the server", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const busy = await stub.seed("analyzing");
  const other = await stub.seed("done");
  await openWithStorage(page, "/app", { [JOBS]: [job(busy.id, "falsch.mp4", 5_000), job(other.id, "alt.mp4", 3_600_000)] });
  const row = jobCard(page, "falsch.mp4");
  await expect(row).toHaveAttribute("data-state", "processing");
  const del = row.getByTestId("job-card-delete");
  await expect(del).toHaveText("Delete");
  // 44 px to a finger: its layout height (the box on screen can read
  // 43.99998 at a phone's device pixel ratio while the page moves in).
  expect(await del.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  await del.click();
  const dialog = page.getByTestId("dialog-delete");
  // Named as the row shows it.
  await expect(dialog.getByRole("heading")).toHaveText("Delete “falsch”?");
  await expect(dialog.getByTestId("delete-body")).toHaveText(
    "Cleo stops working on it. The video, its edits and exports are removed from our servers. This can't be undone.",
  );
  // Cancel keeps it (Cleo goes on); the focus is back on its Delete.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
  expect(await stub.job(busy.id)).not.toBeNull();

  await del.click();
  await page.getByTestId("delete-confirm").click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => stub.job(busy.id)).toBeNull();
  // Said once; the focus (its Delete is gone) on the page's title.
  await expect(page.getByTestId("projects-announce")).toHaveText("“falsch.mp4” deleted");
  await expect(page.locator("#projects-title")).toBeFocused();
  await expect(jobCard(page, "alt.mp4")).toBeVisible();
  expect((await storedJobs(page)).map((j) => j.jobId)).toEqual([other.id]);
});

test("two deleted with the same name: each one is said", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const a = await stub.seed("analyzing");
  const b = await stub.seed("analyzing");
  await openWithStorage(page, "/app", { [JOBS]: [job(a.id, "doppelt.mp4", 5_000), job(b.id, "doppelt.mp4", 6_000)] });
  const rows = jobCard(page, "doppelt.mp4");
  await expect(rows).toHaveCount(2);
  const announce = page.getByTestId("projects-announce");
  await rows.first().getByTestId("job-card-delete").click();
  await page.getByTestId("delete-confirm").click();
  await expect(rows).toHaveCount(1);
  await expect(announce).toHaveText("“doppelt.mp4” deleted");
  await announce.evaluate((el) => {
    (window as unknown as { __said: Element | null }).__said = el.firstElementChild;
  });
  await rows.first().getByTestId("job-card-delete").click();
  await page.getByTestId("delete-confirm").click();
  await expect(rows).toHaveCount(0);
  await expect(announce).toHaveText("“doppelt.mp4” deleted");
  // The same words, a new line: screen readers hear it again.
  expect(await announce.evaluate((el) => el.firstElementChild !== (window as unknown as { __said: Element | null }).__said)).toBe(true);
});

test("Delete cancelled after Cleo finished meanwhile: the focus goes to the row's way in", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const busy = await stub.seed("review");
  // The job as the page sees it: analysed until `ready`.
  const state = { ready: false };
  await page.route(`${API}/jobs/status*`, async (route: Route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers.etag;
    if (res.status() !== 200) return route.fulfill({ response: res, headers });
    const body = (await res.json()) as { jobs: Record<string, unknown>[] };
    if (!state.ready) {
      for (const j of body.jobs) {
        if (j.id === busy.id) Object.assign(j, { status: "processing", stage: "analyze.transcribe", progress: 40, message: "…" });
      }
    }
    return route.fulfill({ response: res, headers, body: JSON.stringify(body) });
  });
  await openWithStorage(page, "/app", { [JOBS]: [job(busy.id, "gleich.mp4", 5_000)] });
  const row = jobCard(page, "gleich.mp4");
  await expect(row).toHaveAttribute("data-state", "processing");
  await row.getByTestId("job-card-delete").click();
  const dialog = page.getByTestId("dialog-delete");
  await expect(dialog).toBeVisible();
  state.ready = true;
  await expect(row).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId("job-card-open")).toBeFocused();
  expect(await stub.job(busy.id)).not.toBeNull();
});

test("a mouse over a row whose name is cut shows the whole name; no title otherwise", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  test.skip(Boolean(info.project.use.isMobile), "a mouse");
  const cut = await stub.seed("done");
  const whole = await stub.seed("done");
  const long = "Interview mit Maria Schneider über nachhaltige Mode und Upcycling – Teil 2 – die ganz lange Fassung für alle";
  await page.setViewportSize({ width: 1024, height: 768 });
  await openWithStorage(page, "/app", {
    [JOBS]: [{ ...job(cut.id, "interview.mp4", 1_000), name: long }, { ...job(whole.id, "kurz", 60_000), name: "Kurz" }],
  });
  const row = jobCard(page, long);
  await expect(row).toHaveAttribute("data-state", "exported");
  // Nothing while no mouse is there: screen readers would hear it twice.
  await expect(row).not.toHaveAttribute("title", /.+/);
  await row.getByTestId("job-card-open").hover();
  await expect(row).toHaveAttribute("title", long);
  await page.mouse.move(2, 2);
  await expect(row).not.toHaveAttribute("title", /.+/);
  // A name the row shows whole: no tooltip.
  await jobCard(page, "Kurz").getByTestId("job-card-open").hover();
  await expect(jobCard(page, "Kurz")).not.toHaveAttribute("title", /.+/);
});

test("only expired projects: an empty state, nothing requested", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const gone = await stub.seed("projects_all_expired");
  const frames: string[] = [];
  page.on("request", (r) => {
    if (/\/(thumbnail|poster)\b/.test(r.url())) frames.push(r.url());
  });
  await openWithStorage(page, "/app", { [LIBRARY]: [libEntry(gone.id, "alt.mp4", 30 * 86_400_000)] });
  await expect(page.getByTestId("projects-all-expired")).toContainText("deleted after 14 days");
  await expect(page.getByTestId("projects-expired")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(frames).toEqual([]);
});

test("past its expiry while the server still lists it: Expired, no frame requested", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const old = await stub.seed("done");
  const frames: string[] = [];
  page.on("request", (r) => {
    if (/\/(thumbnail|poster)\b/.test(r.url())) frames.push(r.url());
  });
  // The server has it, its output and its frame, until the sweep: only
  // its expiry has passed.
  await page.route(`${API}/jobs/status*`, async (route: Route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers.etag;
    if (res.status() !== 200) return route.fulfill({ response: res, headers });
    const body = (await res.json()) as { jobs: Record<string, unknown>[] };
    for (const j of body.jobs) {
      if (j.id === old.id) Object.assign(j, { expires_at: Math.floor(Date.now() / 1000) - 3600, has_output: true, has_poster: true });
    }
    return route.fulfill({ response: res, headers, body: JSON.stringify(body) });
  });
  await openWithStorage(page, "/app", { [JOBS]: [job(old.id, "abgelaufen.mp4", 20 * 86_400_000)] });
  await expect(page.getByTestId("projects-all-expired")).toBeVisible();
  await page.getByTestId("projects-expired").locator("summary").click();
  await expect(jobCard(page, "abgelaufen.mp4")).toHaveAttribute("data-state", "expired");
  await expect(jobCard(page, "abgelaufen.mp4").getByTestId("job-card-open")).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(frames).toEqual([]);
});

test("/app/library redirects to Projects", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/library", { [LIBRARY]: [libEntry(done.id, "fertig.mp4")] });
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "fertig.mp4")).toBeVisible();
  // The menu's link goes to Projects too, marked as the current place.
  const link = page.getByRole("link", { name: "Projects", exact: true });
  await expect(link).toHaveAttribute("href", "/app");
  await expect(link).toHaveAttribute("aria-current", "page");
});
