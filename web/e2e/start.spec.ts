/**
 * The start flow (/app/new; PR1, approved mockups 1-video, 2-untertitel,
 * 2b-optionen): "New video" takes the file, its upload starts at once and
 * "Choose captions" follows; the job waits for "Let's go" (D1, D2). POST
 * /jobs carries the choices as they are when it goes out (§4.4); the last
 * used ones come back for the next video and "Your default" wins (D4,
 * D5). Leaving before "Let's go" neither starts nor discards the video
 * (D3); X does. A video the server would refuse is refused before any
 * byte goes up (D9).
 *
 * The start screen is for browsers on the v2 editor only (flag.ts): its
 * suites are @editor-v2 (E2E_EDITOR_V2=1 runs); the v1 run (a build with
 * NEXT_PUBLIC_EDITOR_V2=optin) checks that /app/new keeps the v1 picker
 * flow there.
 */
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, EDITOR_V2, WEB } from "./support/env";
import {
  chooseFile,
  createdJobId,
  horizontalOverflow,
  job,
  jobCard,
  JOBS,
  LANGS,
  libEntry,
  LIBRARY,
  openWithStorage,
  readStorage,
  startGo,
  storedJobs,
  watchJobPosts,
} from "./support/app";

const PREFS = "cleocuts.prefs.v1";

/** The id of the job POST /jobs created for `filename` (its record
 *  swapped the upl- id). */
async function jobOf(page: Page, filename: string): Promise<string> {
  await expect.poll(() => createdJobId(page, filename), { timeout: 30_000 }).not.toBeNull();
  return (await createdJobId(page, filename))!;
}

/** Hold every request of the upload API until `release()`: the upload
 *  is still going (the stub has no R2: its bytes go with POST /jobs). */
async function holdUpload(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await held;
    await r.continue().catch(() => {});
  });
  return release;
}

const screen = (page: Page) => page.getByTestId("start-screen");

test("the defaults are preselected; Let’s go creates the job with them @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  // (The stub uploads with single PUTs: 5 GB, the most one PUT to R2 takes.)
  await expect(page.getByTestId("start-limits")).toHaveText("MP4 · MOV · WebM · up to 30 min and 5 GB");
  await expect(page.getByTestId("upload-privacy")).toHaveText("How we handle your videos");

  await chooseFile(page, { name: "eins.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  // Focus goes to the new screen's heading.
  await expect(page.getByRole("heading", { level: 1, name: "Choose captions" })).toBeFocused();
  await expect(page.getByTestId("start-upload")).toContainText("eins.mp4");
  await expect(page.getByTestId("start-style-power")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-style-tag")).toHaveCount(0);
  // Nothing starts before Let's go.
  await page.waitForTimeout(1000);
  expect(posts).toEqual([]);

  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  const jobId = await jobOf(page, "eins.mp4");
  // §4.4 row 1: a new browser, nothing touched.
  expect(posts).toEqual([
    {
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "power",
      caption_style: { presetId: "power", overrides: {} },
    },
  ]);
  const created = (await stub.job(jobId))!;
  expect(created.settings).toMatchObject({
    target_aspect: "9:16",
    style: "tight",
    output_formats: [],
    caption_style_hint: "power",
    caption_style: { presetId: "power", overrides: {} },
  });
  expect(created.settings).not.toHaveProperty("caption_preset");
  expect(created.preset_id).toBeNull();
});

test("choices made during the upload are what POST /jobs carries @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  const release = await holdUpload(page);
  await chooseFile(page, { name: "zwei.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-upload")).toContainText("zwei.mp4");
  await expect(page.getByTestId("upload-dropzone")).toHaveCount(0);

  await page.getByTestId("start-style-karaoke").click();
  await expect(page.getByTestId("start-style-karaoke")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-style-power")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("start-more").click();
  const only = page.getByTestId("start-captions-only");
  await only.click();
  await expect(only).toHaveAttribute("aria-checked", "true");
  await expect(only).toContainText("“Cleo cut” won't cut anything either. Only silence at the start and end is trimmed.");
  // No cuts: no filler words to cut either (shown off, wanted on).
  const fillers = page.getByTestId("start-fillers");
  await expect(fillers).toHaveAttribute("aria-disabled", "true");
  await expect(fillers).toHaveAttribute("aria-checked", "false");
  await expect(fillers).toContainText("Only works when Cleo cuts.");
  await page.getByTestId("start-format-original").click();
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("start-language").selectOption("de");
  // Folded, the row sums up what differs from the defaults.
  await page.getByTestId("start-more").click();
  await expect(page.getByTestId("start-more-summary")).toHaveText("Captions only · Original · German");
  release();

  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  const jobId = await jobOf(page, "zwei.mp4");
  // §4.4 row 2.
  expect(posts).toEqual([
    {
      target_aspect: "original",
      style: "none",
      remove_fillers: false,
      voice_triggers: false,
      spoken_language: "de",
      smartcam_enabled: false,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "karaoke",
      caption_style: { presetId: "karaoke", overrides: {} },
    },
  ]);
  expect((await stub.job(jobId))!.settings).toMatchObject({
    target_aspect: "original",
    style: "none",
    spoken_language: "de",
    caption_style: { presetId: "karaoke", overrides: {} },
  });
});

test("the last used choices come back for the next video, “Captions only” doesn't @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  await chooseFile(page, { name: "drei.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await page.getByTestId("start-style-neon").click();
  await page.getByTestId("start-more").click();
  await page.getByTestId("start-captions-only").click();
  await page.getByTestId("start-format-original").click();
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "drei.mp4");
  expect(posts[0]).toMatchObject({ style: "none", target_aspect: "original", caption_style_hint: "neon" });
  // Written as POST /jobs went out: the format and filler choice as
  // wanted, the language, the style; no pace.
  expect(await readStorage(page, PREFS)).toEqual({
    target_aspect: "original",
    remove_fillers: true,
    spoken_language: "auto",
    caption_style_last: "neon",
  });

  await page.goto("/app/new");
  await chooseFile(page, { name: "vier.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  const neon = page.getByTestId("start-style-neon");
  await expect(neon).toHaveAttribute("aria-checked", "true");
  await expect(neon.getByTestId("start-style-tag")).toHaveText("Last used");
  await expect(page.getByTestId("start-more-summary")).toHaveText("Original");
  await page.getByTestId("start-more").click();
  await expect(page.getByTestId("start-captions-only")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("start-fillers")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
});

test("Horizontal is off for a vertical video, on for a landscape one @editor-v2", async ({ page, stub }) => {
  // The last video went out as Horizontal.
  await openWithStorage(page, "/app/new", { [PREFS]: { target_aspect: "16:9" } });
  const posts = await watchJobPosts(page);
  await chooseFile(page, { name: "hoch.webm", mimeType: "video/webm", buffer: await stub.media("portrait.webm") });
  // Folded: what this video gets.
  await expect(page.getByTestId("start-more-summary")).toHaveText("Original");
  await page.getByTestId("start-more").click();
  const wide = page.getByTestId("start-format-16x9");
  await expect(wide).toHaveAttribute("aria-disabled", "true");
  await expect(wide).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("start-vertical-hint")).toHaveText("Your video is vertical, so Horizontal isn't available.");
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
  await wide.click({ force: true });
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "hoch.webm");
  expect(posts[0]).toMatchObject({ target_aspect: "original", smartcam_enabled: false });
  // The wish stays (only this video couldn't have it).
  expect(await readStorage(page, PREFS)).toMatchObject({ target_aspect: "16:9" });

  // A landscape video: Horizontal as wished. Vertical crops it: the
  // folded row says so.
  await page.goto("/app/new");
  await chooseFile(page, { name: "quer.webm", mimeType: "video/webm", buffer: await stub.media("landscape.webm") });
  await expect(page.getByTestId("start-more-summary")).toHaveText("Horizontal");
  await page.getByTestId("start-more").click();
  await expect(wide).not.toHaveAttribute("aria-disabled", "true");
  await expect(wide).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-vertical-hint")).toHaveCount(0);
  await page.getByTestId("start-format-9x16").click();
  await page.getByTestId("start-more").click();
  await expect(page.getByTestId("start-more-summary")).toHaveText("Vertical");
  await page.getByTestId("start-cancel").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
});

test("Your default is preselected and sent whole; old prefs and earlier projects change nothing @editor-v2", async ({ page, stub }) => {
  // "Save as default" in the Style tab, Neon for the last video and a
  // pace from the old start screen.
  await openWithStorage(page, "/app/new", {
    [PREFS]: {
      style: "smooth",
      caption_style_default: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
      caption_style_last: "neon",
    },
  });
  const posts = await watchJobPosts(page);
  await chooseFile(page, { name: "standard.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  const karaoke = page.getByTestId("start-style-karaoke");
  await expect(karaoke).toHaveAttribute("aria-checked", "true");
  await expect(karaoke.getByTestId("start-style-tag")).toHaveText("Your default");
  const neon = page.getByTestId("start-style-neon");
  await expect(neon).toHaveAttribute("aria-checked", "false");
  await expect(neon.getByTestId("start-style-tag")).toHaveText("Last used");
  await expect(page.getByTestId("start-style-tag")).toHaveCount(2);
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "standard.mp4");
  // §4.4 row 4.
  expect(posts[0]).toMatchObject({
    style: "tight",
    caption_style_hint: "karaoke",
    caption_style: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
  });
  expect(posts[0]).not.toHaveProperty("caption_preset");

  // Earlier projects, and old prefs without cuts or voice commands: Power
  // and one tight cut like everyone (§4.4 row 5; no Clipper any more).
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/new", {
    [LIBRARY]: [libEntry(done.id, "alt.mp4")],
    [PREFS]: { style: "none", voice_triggers: false },
  });
  await chooseFile(page, { name: "frueher.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-style-power")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-style-tag")).toHaveCount(0);
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(2);
  expect(posts[1]).toMatchObject({
    style: "tight",
    remove_fillers: true,
    voice_triggers: true,
    caption_style_hint: "power",
    caption_style: { presetId: "power", overrides: {} },
  });
  expect(posts[1]).not.toHaveProperty("caption_preset");
});

test("Let’s go while it uploads: it waits, the choices stay open, then it starts by itself @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  const release = await holdUpload(page);
  await chooseFile(page, { name: "gleich.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await startGo(page);
  const go = page.getByTestId("start-go");
  await expect(go).toHaveAttribute("data-state", "waiting");
  await expect(go).toHaveText("Starts after the upload");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("start-announce")).toHaveText("Starts after the upload");
  // Until POST /jobs goes out, a choice still counts.
  await page.getByTestId("start-style-neon").click();
  await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);

  release();
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "gleich.mp4");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
});

test("X: back to New video, nothing uploaded, nothing listed @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
  });
  await chooseFile(page, { name: "weg.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  await expect.poll(async () => (await storedJobs(page)).map((j) => j.filename)).toEqual(["weg.mp4"]);

  await page.getByRole("button", { name: "Cancel upload" }).click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
  // Focus is back on the card's button.
  await expect(page.getByRole("button", { name: "Choose video" })).toBeFocused();
  await expect.poll(() => storedJobs(page)).toEqual([]);
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);
  expect(await storedJobs(page)).toEqual([]);
});

test("leaving before Let’s go keeps the video waiting; Continue brings it back, Let’s go starts it @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  await chooseFile(page, { name: "wartet.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await page.getByTestId("start-style-neon").click();
  await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");

  // Projects in the header: the video waits there. Nothing works on it
  // until "Let's go": the headline doesn't count it as in progress.
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(`${WEB}/app`);
  const tile = jobCard(page, "wartet.mp4");
  await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
  await expect(page.getByTestId("dashboard").getByRole("heading", { level: 1 })).toHaveText("Ready when you are");
  await expect(tile.getByTestId("job-card-cancel")).toBeVisible();
  // Its two actions are big enough to tap.
  for (const id of ["job-card-continue-start", "job-card-cancel"]) {
    expect((await tile.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
  }
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);

  // "Continue": the same video and choices on Choose captions, the focus
  // on its heading as after the pick.
  await tile.getByTestId("job-card-continue-start").click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  await expect(page.getByRole("heading", { level: 1, name: "Choose captions" })).toBeFocused();
  await expect(page.getByTestId("start-upload")).toContainText("wartet.mp4");
  await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "wartet.mp4");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
  expect((await storedJobs(page)).filter((j) => j.filename === "wartet.mp4")).toHaveLength(1);
});

test("the browser's Back neither starts nor discards the video @editor-v2", async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app", { [JOBS]: [job(done.id, "alt.mp4")] });
  const posts = await watchJobPosts(page);
  await page.getByTestId("dashboard-new-video").click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await chooseFile(page, { name: "zurueck.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(screen(page)).toHaveAttribute("data-screen", "style");

  await page.goBack();
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "zurueck.mp4").getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);

  // Forward again: the same video, still waiting; X gives it up.
  await page.goForward();
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  await expect(page.getByTestId("start-upload")).toContainText("zurueck.mp4");
  await page.getByTestId("start-cancel").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
  await expect.poll(async () => (await storedJobs(page)).map((j) => j.filename)).toEqual(["alt.mp4"]);
  await page.waitForTimeout(1000);
  expect(posts).toEqual([]);
});

test("leaving while the picked video is checked starts nothing @editor-v2", async ({ page, stub }) => {
  const done = await stub.seed("done");
  // GET /config is slow: the pick-time check waits for it (up to 4 s).
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${API}/config`, async (r) => {
    await held;
    await r.continue().catch(() => {});
  });
  await openWithStorage(page, "/app/new", { [JOBS]: [job(done.id, "alt.mp4")] });
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(`${API}/uploads/`) || (r.method() === "POST" && r.url() === `${API}/jobs`)) sent.push(r.url());
  });
  await chooseFile(page, { name: "geprueft.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-preparing")).toHaveText("Preparing video…");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(`${WEB}/app`);
  release();
  await page.waitForTimeout(5000);
  expect(sent).toEqual([]);
  expect((await storedJobs(page)).map((j) => j.filename)).toEqual(["alt.mp4"]);
  await expect(jobCard(page, "geprueft.mp4")).toHaveCount(0);
  // New video again: nothing waits there either.
  await page.getByTestId("dashboard-new-video").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
});

test("a video over the limits is refused on New video: nothing uploads, nothing is listed @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(`${API}/uploads/`) || (r.method() === "POST" && r.url() === `${API}/jobs`)) sent.push(r.url());
  });
  // 31 minutes: over the 30-minute cap.
  await chooseFile(page, { name: "lang.webm", mimeType: "video/webm", buffer: await stub.media("long.webm") });
  const error = page.getByTestId("start-pick-error");
  await expect(error).toHaveText("This video is longer than 30 minutes. Please trim it or split it into parts.");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
  expect(await storedJobs(page)).toEqual([]);
});

test("a failed upload stays on Choose captions with its reason; Try again starts it @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  // The first POST /jobs: the server's disk is full right now.
  let refuse = true;
  await page.route(`${API}/jobs`, (r) => {
    if (r.request().method() !== "POST" || !refuse) return r.fallback();
    refuse = false;
    return r.fulfill({
      status: 507,
      contentType: "application/json",
      body: JSON.stringify({ detail: "server_storage_full", code: "server_storage_full", params: {} }),
    });
  });
  await chooseFile(page, { name: "voll.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await startGo(page);
  const failed = page.getByTestId("start-upload-failed");
  await expect(failed).toHaveAttribute("role", "alert", { timeout: 30_000 });
  await expect(failed.getByTestId("start-upload-status")).toHaveText("Upload stopped");
  await expect(failed).toContainText("This video is too large for our servers right now. Try again in a few minutes or shorten it.");
  await expect(page).toHaveURL(`${WEB}/app/new`);
  expect(posts).toEqual([]);
  // Nothing starts from the go button now: it rests (not "Starts after
  // the upload"); Try again is the way on.
  const go = page.getByTestId("start-go");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(go).toHaveText("Let’s go");

  await failed.getByTestId("start-retry").click();
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "voll.mp4");
  expect(posts).toHaveLength(1);
  expect((await storedJobs(page)).filter((j) => j.filename === "voll.mp4")).toHaveLength(1);
});

test("a failure before Let’s go: the go button rests until Try again; Projects leads back to it, never to a start @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
  });
  // The upload API: too many uploads started in a short time (429).
  await page.route("**/uploads/**", (r) =>
    r.fulfill({
      status: 429,
      headers: { "Retry-After": "600" },
      contentType: "application/json",
      body: JSON.stringify({ detail: "too_many_uploads", code: "too_many_uploads", params: {} }),
    }),
  );
  await chooseFile(page, { name: "gestoppt.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-upload-failed")).toContainText("Too many uploads in a short time. Wait a few minutes.");
  // Let's go would start nothing: it rests, plainly unavailable (not the
  // tint of an action) and described by the alert; a tap starts nothing
  // and leads to the way on, Try again.
  const go = page.getByTestId("start-go");
  const retry = page.getByTestId("start-retry");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(go).toHaveCSS("color", "rgb(139, 134, 154)");
  await expect(go).toHaveCSS("background-color", "rgb(19, 18, 23)");
  await expect(go).toHaveAccessibleDescription("Upload stopped Too many uploads in a short time. Wait a few minutes.");
  await go.click({ force: true });
  await expect(go).toHaveAttribute("data-state", "idle");
  await expect(go).toHaveText("Let’s go");
  await expect(retry).toBeFocused();
  // A short landscape phone, where nothing sticks: at the end of the page
  // the button is all there is in view, and the tap brings Try again up.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(retry).not.toBeInViewport();
  await go.click({ force: true });
  await expect(retry).toBeFocused();
  await expect(retry).toBeInViewport();
  await page.setViewportSize(size);

  // Projects: the reason and the way back ("Continue"), no "Try again"
  // there (it would start the job without "Let's go").
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  const tile = jobCard(page, "gestoppt.mp4");
  await expect(tile).toHaveAttribute("data-state", "upload_failed");
  await expect(tile.getByTestId("job-card-status")).toHaveText("Too many uploads in a short time. Wait a few minutes.");
  await expect(tile.getByTestId("job-card-continue-start")).toBeVisible();
  await expect(tile.getByTestId("job-card-retry")).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);

  // Back on Choose captions, still stopped; Try again, then Let's go.
  await tile.getByTestId("job-card-continue-start").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  await expect(page.getByTestId("start-upload-failed")).toBeVisible();
  await page.unroute("**/uploads/**");
  await page.getByTestId("start-retry").click();
  await expect(page.getByTestId("start-upload-failed")).toHaveCount(0);
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "gestoppt.mp4");
  expect(posts).toHaveLength(1);
});

test("another tab of the browser shows the video waiting for Let’s go (its bytes wait too), and follows when it goes @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
  });
  await chooseFile(page, { name: "zweiter-tab.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  // Projects in a second tab: the video waits there too, as it does here.
  const other = await page.context().newPage();
  await other.goto("/app");
  const tile = jobCard(other, "zweiter-tab.mp4");
  await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
  await expect(tile.getByTestId("job-card-badge")).toHaveText("Uploading");
  await expect(other.getByTestId("dashboard").getByRole("heading", { level: 1 })).toHaveText("Ready when you are");
  // Its way back and its Cancel are the first tab's.
  await expect(tile.getByTestId("job-card-continue-start")).toHaveCount(0);
  await expect(tile.getByTestId("job-card-cancel")).toHaveCount(0);
  await other.waitForTimeout(1000);
  expect(posts).toEqual([]);

  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await jobOf(page, "zweiter-tab.mp4");
  await expect(tile).not.toHaveAttribute("data-state", /^upload/, { timeout: 30_000 });
  await expect(tile.getByTestId("job-card-status")).not.toHaveText("Waiting for “Let’s go”");
  expect(posts).toHaveLength(1);
  await other.close();
});

test("Let’s go, then the upload stops: Try again on its Projects tile starts it with the choices, and remembers them @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  // The upload API answers once Let's go was pressed: too many uploads
  // (429), so the upload stops after "Let's go", before POST /jobs.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await held;
    await r
      .fulfill({
        status: 429,
        headers: { "Retry-After": "600" },
        contentType: "application/json",
        body: JSON.stringify({ detail: "too_many_uploads", code: "too_many_uploads", params: {} }),
      })
      .catch(() => {});
  });
  await chooseFile(page, { name: "kachel.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await page.getByTestId("start-style-neon").click();
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  const tile = jobCard(page, "kachel.mp4");
  release();
  await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 30_000 });
  // Past "Let's go": the tile's own Try again (not the way back).
  await expect(tile.getByTestId("job-card-continue-start")).toHaveCount(0);
  expect(await readStorage(page, PREFS)).toBeNull();
  await page.unroute("**/uploads/**");
  await tile.getByTestId("job-card-retry").click();
  await jobOf(page, "kachel.mp4");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
  // Remembered as its POST /jobs went out (D4), as with the strip's Try again.
  await expect
    .poll(() => readStorage(page, PREFS))
    .toEqual({ target_aspect: "9:16", remove_fillers: true, spoken_language: "auto", caption_style_last: "neon" });
});

test("X after Let’s go while it uploads: nothing starts, nothing is remembered @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
  });
  const release = await holdUpload(page);
  await chooseFile(page, { name: "doch-nicht.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await page.getByTestId("start-style-neon").click();
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await page.getByTestId("start-cancel").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
  release();
  await page.waitForTimeout(3000);
  expect(posts).toEqual([]);
  expect(await storedJobs(page)).toEqual([]);
  // The last used are written when POST /jobs goes out: never here.
  expect(await readStorage(page, PREFS)).toBeNull();
});

test("once POST /jobs has read the choices (its bytes still going up) they are locked: the job and Last used get what the screen shows @editor-v2", async ({ page, stub, browserName }) => {
  test.skip(browserName !== "chromium", "upload throttling through the Chrome DevTools Protocol");
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "langsam.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(screen(page)).toHaveAttribute("data-screen", "style");
  // The stub has no R2: the bytes go with POST /jobs, from now on slowly
  // (100 KB/s, about 10 s for this clip).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const throttle = (bytesPerSecond: number) =>
    cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: bytesPerSecond,
    });
  await throttle(100 * 1024);
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  const neon = page.getByTestId("start-style-neon");
  await expect(neon).toHaveAttribute("aria-disabled", "true");
  await neon.click({ force: true });
  await expect(page.getByTestId("start-style-power")).toHaveAttribute("aria-checked", "true");
  await expect(neon).toHaveAttribute("aria-checked", "false");
  // (All that while the bytes were still going up.)
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await throttle(-1);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  const jobId = await jobOf(page, "langsam.mp4");
  expect((await stub.job(jobId))!.settings).toMatchObject({ caption_style: { presetId: "power", overrides: {} } });
  expect(await readStorage(page, PREFS)).toMatchObject({ caption_style_last: "power" });
});

test("Tab skips the folded options @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "tab.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  const more = page.getByTestId("start-more");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.focus();
  await page.keyboard.press("Tab");
  // Folded, the next stop is after the panel: the upload's X beside the
  // preview on a desktop, Let's go on a phone.
  const desktop = page.viewportSize()!.width >= 960;
  await expect(page.getByTestId(desktop ? "start-cancel" : "start-go")).toBeFocused();
  // Open, its first row comes next.
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("start-captions-only")).toBeFocused();
});

/**
 * Press `keys` one by one: each element that gets the focus is clear of the
 * stuck upload strip and of the go bar (their heights change with what they
 * show). Then Tab on to Let's go. The test ids (or ids, tags) passed.
 */
async function focusStaysClear(page: Page, keys: string[]): Promise<string[]> {
  const strip = page.getByTestId("start-upload");
  const bar = page.getByTestId("start-go").locator("..");
  const seen: string[] = [];
  const moves = [...keys, ...Array<string>(30).fill("Tab")];
  for (const key of moves) {
    await page.keyboard.press(key);
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.dataset.testid ?? el?.id ?? el?.tagName ?? "";
    });
    if (id === "start-go") break;
    seen.push(id);
    await expect
      .poll(
        async () => {
          const [el, top, bottom] = await Promise.all([
            page.evaluate(() => {
              const r = document.activeElement!.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
            }),
            strip.boundingBox(),
            bar.boundingBox(),
          ]);
          return el.top >= top!.y + top!.height - 1 && el.bottom <= bottom!.y + 1;
        },
        { message: `${key} → ${id} is clear of the bars` },
      )
      .toBe(true);
  }
  return seen;
}

/** Into the styles from the heading: Tab, then the arrows down and up. */
const THROUGH_STYLES = ["Tab", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp"];
/** To the last style ("No captions"), on through the open options to the
 *  language, then back and up the styles row by row to the first (two
 *  or three columns): the page scrolls both ways under the bars. */
const DOWN_AND_BACK = [
  "Tab",
  "End",
  ...Array<string>(5).fill("Tab"),
  ...Array<string>(5).fill("Shift+Tab"),
  ...Array<string>(6).fill("ArrowUp"),
];

/** "More options" open, and the page done scrolling its end into view. */
async function openOptions(page: Page) {
  await page.getByTestId("start-more").click();
  await expect(page.getByTestId("start-more")).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(async () => {
      const a = await page.evaluate(() => window.scrollY);
      await page.waitForTimeout(250);
      return a === (await page.evaluate(() => window.scrollY));
    })
    .toBe(true);
}

test("phones: Tab and the arrows never put the focus under the upload strip or the go bar @editor-v2", async ({ page, stub }, info) => {
  test.skip(info.project.name !== "pixel7", "the phone layout, one run");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "fokus.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await page.getByTestId("start-more").click();
  await expect(page.getByTestId("start-more")).toHaveAttribute("aria-expanded", "true");
  // Reduced motion: Let's go doesn't shrink when pressed, the switches'
  // knobs don't slide (opacity and colour only).
  expect(await page.getByTestId("start-go").evaluate((el) => getComputedStyle(el).transitionProperty)).not.toMatch(/transform|scale/);
  const knob = await page.getByTestId("start-captions-only").evaluate((el) => {
    const cs = getComputedStyle(el.querySelector('div[aria-hidden="true"] > div')!);
    return { property: cs.transitionProperty, duration: cs.transitionDuration };
  });
  expect(knob.property === "none" || knob.duration === "0s", JSON.stringify(knob)).toBe(true);
  // From the heading through every stop down to Let's go.
  await page.getByRole("heading", { level: 1, name: "Choose captions" }).focus();
  const seen = await focusStaysClear(page, THROUGH_STYLES);
  expect(seen).toEqual(
    expect.arrayContaining(["start-style-power", "start-more", "start-captions-only", "start-fillers", "start-format-9x16", "start-language"]),
  );
});

test("phones: a paused or stopped upload's taller strip and a two-line go button still keep the focus clear @editor-v2", async ({ page, stub }, info) => {
  test.skip(info.project.name !== "pixel7", "the phone layout, one run");
  const WALKED = ["start-style-power", "start-style-none", "start-more", "start-language"];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWithStorage(page, "/app/new");
  const title = page.getByRole("heading", { level: 1, name: "Choose captions" });
  // Paused: the upload API can't be reached (a second line in the strip).
  await page.route("**/uploads/**", (r) => r.abort("internetdisconnected"));
  await chooseFile(page, { name: "pause.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-paused")).toBeVisible({ timeout: 45_000 });
  await openOptions(page);
  await title.focus();
  expect(await focusStaysClear(page, DOWN_AND_BACK)).toEqual(expect.arrayContaining(WALKED));
  await page.getByTestId("start-cancel").click();
  await page.unroute("**/uploads/**");

  // Stopped after Let's go: the strip holds the reason and Try again.
  await page.route(`${API}/jobs`, (r) =>
    r.request().method() !== "POST"
      ? r.fallback()
      : r.fulfill({
          status: 507,
          contentType: "application/json",
          body: JSON.stringify({ detail: "server_storage_full", code: "server_storage_full", params: {} }),
        }),
  );
  await chooseFile(page, { name: "gestoppt.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await startGo(page);
  await expect(page.getByTestId("start-upload-failed")).toBeVisible({ timeout: 30_000 });
  await openOptions(page);
  await title.focus();
  expect(await focusStaysClear(page, DOWN_AND_BACK)).toEqual(expect.arrayContaining(WALKED));
  await page.getByTestId("start-cancel").click();
  await page.unroute(`${API}/jobs`);

  // A narrow phone in German, waiting: "Startet nach dem Hochladen" on
  // two lines makes the go bar taller.
  await page.getByTestId("language-switcher").first().selectOption("de");
  await page.setViewportSize({ width: 320, height: 568 });
  const release = await holdUpload(page);
  await chooseFile(page, { name: "schmal.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await openOptions(page);
  await page.getByRole("heading", { level: 1, name: "Untertitel wählen" }).focus();
  expect(await focusStaysClear(page, DOWN_AND_BACK)).toEqual(expect.arrayContaining(WALKED));
  await page.getByTestId("start-cancel").click();
  release();
});

test("iOS: Preparing video… between the chooser closing and the file arriving @editor-v2", async ({ page }) => {
  await openWithStorage(page, "/app/new");
  await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
  // The chooser closed (the page gets focus back), no file yet.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("start-preparing")).toHaveText("Preparing video…");
  await expect(page.getByTestId("start-preparing-slow")).toHaveCount(0);
  // Still nothing after ~4 s: iOS is still at it, the page says so.
  await expect(page.getByTestId("start-preparing-slow")).toHaveText("Still preparing the video. Please wait and keep this page open.");
  // Cancelled after all: nothing is coming.
  await page.getByTestId("upload-input").dispatchEvent("cancel");
  await expect(page.getByTestId("start-preparing")).toHaveCount(0);
  await expect(page.getByTestId("start-preparing-slow")).toHaveCount(0);
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

test.describe("on an iPhone", () => {
  test.use({ userAgent: IPHONE_UA });
  test("while a video is prepared, the page says iOS prepares long videos first @editor-v2", async ({ page }) => {
    await openWithStorage(page, "/app/new");
    await expect(page.getByTestId("start-limits")).toBeVisible();
    // Not at rest: only with "Preparing video…".
    await expect(page.getByTestId("start-ios-hint")).toHaveCount(0);
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("start-preparing")).toHaveText("Preparing video…");
    await expect(page.getByTestId("start-ios-hint")).toHaveText(
      "Long videos are prepared on your iPhone or iPad before they upload. For a 10-minute video this can take a minute or more.",
    );
  });

  // (Playwright's chooser ignores `accept`: what iOS does with it only
  // the owner's iPhone shows. Here: the attributes and the hint.)
  test("iOS gives up on a huge video: the hint, and Pick anyway without a format filter @editor-v2", async ({ page, stub }) => {
    await page.clock.install();
    await openWithStorage(page, "/app/new");
    await expect(page.getByTestId("upload-input")).toHaveAttribute(
      "accept",
      "video/quicktime,video/mp4,video/hevc,.mov,.mp4,.m4v,.hevc",
    );
    // Closed again within seconds: the user did that, no hint.
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(3000);
    await page.getByTestId("upload-input").dispatchEvent("cancel");
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    // iOS worked on it for a while, then gave up (WebKit: a plain cancel;
    // no back signal comes with it, unlike the user closing the picker).
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(40_000);
    await page.getByTestId("upload-input").dispatchEvent("cancel");
    await page.clock.fastForward(2000);
    const hint = page.getByTestId("pick-missed");
    await expect(hint).toContainText("Your video didn't arrive.");
    await expect(hint).toContainText("4K at 60 fps");
    // "Pick anyway": the chooser without accept (it lists photos too).
    expect(await page.getByTestId("upload-input-any").getAttribute("accept")).toBeNull();
    let [chooser] = await Promise.all([page.waitForEvent("filechooser"), hint.getByTestId("pick-anyway").click()]);
    await chooser.setFiles({ name: "IMG_0043.HEIC", mimeType: "image/heic", buffer: Buffer.from("not a video") });
    await expect(hint.getByTestId("pick-missed-error")).toHaveText("That's not a video. Pick a video file.");
    [chooser] = await Promise.all([page.waitForEvent("filechooser"), hint.getByTestId("pick-anyway").click()]);
    await chooser.setFiles({ name: "IMG_0042.MOV", mimeType: "video/quicktime", buffer: await stub.media("grid.mp4") });
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  });

  test("the picker closed with a selection and iOS gave up seconds later: the hint, not a user's cancel @editor-v2", async ({ page }) => {
    await page.clock.install();
    await openWithStorage(page, "/app/new");
    // A user who browsed Photos for 20 s and closed it: the page comes
    // back with the cancel. Nothing to say.
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(20_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByTestId("upload-input").dispatchEvent("cancel");
    await page.clock.fastForward(3000);
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    // Selected after 4 s (the sheet closes, the page is back), iOS gave
    // up 3 s later.
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(4000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await page.clock.fastForward(3000);
    await page.getByTestId("upload-input").dispatchEvent("cancel");
    await expect(page.getByTestId("pick-missed")).toContainText("Your video didn't arrive.");
    await expect(page.getByTestId("start-preparing")).toHaveCount(0);
  });

  test("the page is back but no file came: Preparing stays, 'Still nothing?' after 90 s, all gone when a slow export arrives @editor-v2", async ({ page, stub }) => {
    await page.clock.install();
    await openWithStorage(page, "/app/new");
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(2000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    // iOS may still be preparing a normal video (43 s for a 140 MB clip
    // in the owner's test): no "didn't arrive" here.
    await page.clock.fastForward(45_000);
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await expect(page.getByTestId("start-preparing-slow")).toBeVisible();
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    await expect(page.getByTestId("pick-stalled")).toHaveCount(0);
    // Still nothing after 90 s: a soft line with "Pick anyway" under it.
    await page.clock.fastForward(50_000);
    await expect(page.getByTestId("pick-stalled")).toContainText("Still nothing?");
    await expect(page.getByTestId("pick-stalled").getByTestId("pick-anyway")).toBeVisible();
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    // The file arrives after all.
    await page
      .getByTestId("upload-input")
      .setInputFiles({ name: "IMG_0044.MOV", mimeType: "video/quicktime", buffer: await stub.media("grid.mp4") });
    await expect(page.getByTestId("pick-stalled")).toHaveCount(0);
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  });

  test("Pick anyway: Preparing video… while iOS converts, the hint back on a cancel @editor-v2", async ({ page }) => {
    await page.clock.install();
    await openWithStorage(page, "/app/new");
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.clock.fastForward(40_000);
    await page.getByTestId("upload-input").dispatchEvent("cancel");
    await page.clock.fastForward(2000);
    const hint = page.getByTestId("pick-missed");
    await expect(hint).toBeVisible();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), hint.getByTestId("pick-anyway").click()]);
    expect(await chooser.element().getAttribute("data-testid")).toBe("upload-input-any");
    // Selected: the picker closed, iOS converts (minutes). No "didn't
    // arrive" with an active "Pick anyway" meanwhile.
    await page.clock.fastForward(2000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    await page.clock.fastForward(5 * 60_000);
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await expect(page.getByTestId("pick-missed")).toHaveCount(0);
    await expect(page.getByTestId("pick-stalled")).toHaveCount(0);
    // iOS gave up on the conversion too: the hint is back.
    await page.getByTestId("upload-input-any").dispatchEvent("cancel");
    await expect(page.getByTestId("pick-missed")).toBeVisible();
    await expect(page.getByTestId("start-preparing")).toHaveCount(0);
  });

  test("an original over the upload cap isn't uploaded: Pick anyway sends the converted copy @editor-v2", async ({ page, stub }) => {
    // A cap the stub's clip is over (GET /config).
    await page.route(`${API}/config`, async (route) => {
      const r = await route.fetch();
      const body = (await r.json()) as { limits: { max_upload_bytes: number } };
      body.limits.max_upload_bytes = 1000;
      await route.fulfill({ response: r, json: body });
    });
    await openWithStorage(page, "/app/new");
    await expect(page.getByTestId("start-limits")).toContainText("0 GB");
    const posts = await watchJobPosts(page);
    let inits = 0;
    page.on("request", (r) => {
      if (/\/uploads\/(multipart\/init|presign)$/.test(r.url())) inits++;
    });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles({ name: "IMG_0045.MOV", mimeType: "video/quicktime", buffer: await stub.media("grid.mp4") });
    const hint = page.getByTestId("pick-missed");
    await expect(hint).toHaveAttribute("data-reason", "too-big");
    await expect(hint).toContainText("over the 0 GB limit");
    await expect(hint.getByTestId("pick-anyway")).toBeVisible();
    await expect(page.getByTestId("start-upload")).toHaveCount(0);
    await expect(page).toHaveURL(`${WEB}/app/new`);
    expect(inits).toBe(0);
    expect(posts).toEqual([]);
    // "Pick anyway" opens the converting chooser.
    const [any] = await Promise.all([page.waitForEvent("filechooser"), hint.getByTestId("pick-anyway").click()]);
    expect(await any.element().getAttribute("data-testid")).toBe("upload-input-any");
  });

  test("Other video formats opens the chooser without a format filter @editor-v2", async ({ page }) => {
    await openWithStorage(page, "/app/new");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("start-other-formats").click()]);
    expect(await chooser.element().getAttribute("data-testid")).toBe("upload-input-any");
    expect(await page.getByTestId("upload-input-any").getAttribute("accept")).toBeNull();
  });

  test("an interrupted upload picked with Pick anyway resumes with that chooser after a reload @editor-v2", async ({ page }) => {
    await openWithStorage(page, "/app/new");
    // Its resume record (lib/uploadResume), as the reload left it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("cleocuts-uploads", 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains("uploads")) req.result.createObjectStore("uploads", { keyPath: "fp" });
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("uploads", "readwrite");
            const now = Date.now();
            tx.objectStore("uploads").put({
              v: 2,
              fp: "m1:60000000:ab12",
              name: "IMG_0046.MOV",
              size: 60_000_000,
              ticket: "t",
              storage_key: "uploads/x.mov",
              part_size: 16 * 1024 * 1024,
              parts_total: 4,
              done: [1, 2],
              created_at: now - 600_000,
              updated_at: now - 600_000,
              expires_at: now + 86_400_000,
              source: "any",
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.reload();
    const card = page.getByTestId("start-resume");
    await expect(card).toContainText("IMG_0046.MOV");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), card.getByTestId("start-resume-choose").click()]);
    expect(await chooser.element().getAttribute("data-testid")).toBe("upload-input-any");
  });
});

test("not on a desktop: video/*, and a late cancel shows no iOS hint @editor-v2", async ({ page }) => {
  await page.clock.install();
  await openWithStorage(page, "/app/new");
  await expect(page.getByTestId("upload-input")).toHaveAttribute("accept", "video/*");
  await expect(page.getByTestId("upload-input-any")).toHaveCount(0);
  await expect(page.getByTestId("start-other-formats")).toHaveCount(0);
  await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
  await page.clock.fastForward(40_000);
  await page.getByTestId("upload-input").dispatchEvent("cancel");
  await expect(page.getByTestId("start-limits")).toBeVisible();
  await expect(page.getByTestId("pick-missed")).toHaveCount(0);
});

test("no iOS hint on a desktop or Android browser @editor-v2", async ({ page }) => {
  await openWithStorage(page, "/app/new");
  await expect(page.getByTestId("start-limits")).toBeVisible();
  await expect(page.getByTestId("start-ios-hint")).toHaveCount(0);
});

test("the start screens fit a phone @editor-v2", async ({ page, stub, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  await openWithStorage(page, "/app/new");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  // New video: a big button, above the fold.
  const box = (await page.getByTestId("upload-dropzone").boundingBox())!;
  expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height);

  await chooseFile(page, { name: "passt.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  // Choose captions: the upload and Let's go in view without scrolling.
  await expect(page.getByTestId("start-upload")).toBeInViewport();
  await expect(page.getByTestId("start-go")).toBeInViewport();
  await page.getByTestId("start-more").click();
  for (const id of [
    "start-cancel",
    "start-style-none",
    "start-more",
    "start-captions-only",
    "start-fillers",
    "start-format-9x16",
    "start-format-16x9",
    "start-format-original",
    "start-language",
    "start-go",
  ]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  // A 320 px phone: nothing scrolls sideways on either screen, and in
  // every language each format's label fits its (stacked) button, in the
  // page's font and in a wide one (device fonts differ; DejaVu Sans is
  // also what CI's Chromium falls back to).
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  const heading = page.locator("#start-captions-h");
  for (const lang of LANGS) {
    const before = await heading.textContent();
    await page.getByTestId("language-switcher").first().selectOption(lang);
    // (Shown in that language: every language names the screen its way.)
    if (lang !== "en") await expect(heading).not.toHaveText(before!);
    const clipped = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid^="start-format-"]')];
      const over = (font: string) => {
        for (const b of buttons) b.style.fontFamily = font;
        return buttons
          .filter((b) => b.scrollWidth > b.clientWidth)
          .map((b) => `${b.dataset.testid} ${b.innerText.trim()} (${font || "page font"})`);
      };
      return [...over('"DejaVu Sans", Verdana, sans-serif'), ...over("")];
    });
    expect(clipped, `${lang}: format labels wider than their buttons`).toEqual([]);
  }
  await page.getByTestId("language-switcher").first().selectOption("en");
  await page.getByTestId("start-cancel").click();
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("picking a file that is still uploading goes to its card, not a stuck 0 % @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  const release = await holdUpload(page);
  // A file on disk: picked twice it is the same File (name, size and
  // lastModified); a buffer would get a new lastModified each time.
  const file = test.info().outputPath("laeuft.mp4");
  fs.writeFileSync(file, await stub.media("grid.mp4"));
  await chooseFile(page, file);
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // Back on New video (a fresh one: that video went) and the same file.
  await page.getByTestId("dashboard-new-video").click();
  await expect(screen(page)).toHaveAttribute("data-screen", "pick");
  await chooseFile(page, file);
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(jobCard(page, "laeuft.mp4")).toHaveCount(1);
  release();
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);
  await page.waitForTimeout(1000);
  expect(posts).toHaveLength(1);
});

test("without the v2 editor, /app/new keeps the v1 flow (workflow picker)", async ({ page }) => {
  test.skip(EDITOR_V2, "the v2 build shows the start screen to everyone");
  await openWithStorage(page, "/app/new");
  await expect(page.getByTestId("picker")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("start-screen")).toHaveCount(0);
  // A browser that opted into the v2 editor gets the start screen.
  await page.goto("/app/new?editor=v2");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await expect(page.getByTestId("picker")).toHaveCount(0);
});

test("the editor says when speaker tracking failed (the video was centre-cropped)", async ({ page, stub }) => {
  test.skip(EDITOR_V2, "the note of the v1 editor; the v2 shell lists it with its warnings");
  const seeded = await stub.seed("review", { format_warning: "smartcam_failed" });
  await openWithStorage(page, `/app/edit/${seeded.id}`);
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  const note = page.getByTestId("format-warning");
  await expect(note).toContainText("Speaker tracking didn't work for this video, so it was centre-cropped.");
  await note.getByRole("button", { name: "Close" }).click();
  await expect(note).toHaveCount(0);
});
