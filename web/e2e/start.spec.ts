/**
 * The start screen (/app/new, UX6; PLAN 3.6, PLAN_TECH §UX6): one click
 * and the file chooser start the upload; the settings stay editable while
 * it runs and POST /jobs carries what they say when it goes out; saved
 * defaults come back after a reload; 16:9 is off for a vertical video; a
 * new browser sends no caption style (the server's default, Power), one
 * with earlier projects keeps Clipper (review D11).
 *
 * The start screen is for browsers on the v2 editor only (flag.ts): its
 * suites are @editor-v2 (E2E_EDITOR_V2=1 runs); the v1 run (a build with
 * NEXT_PUBLIC_EDITOR_V2=optin) checks that /app/new keeps the v1 picker
 * flow there.
 */
import fs from "node:fs";
import type { Page, Request } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, EDITOR_V2, WEB } from "./support/env";
import { ACTIVE_JOBS, chooseFile, JOBS, libEntry, LIBRARY, openWithStorage, postedSettings, readStorage } from "./support/app";

const PREFS = "cleocuts.prefs.v1";

/** Every POST /jobs of the page: its settings. Read through a route (a
 *  plain request listener doesn't always get an XHR's multipart body). */
async function watchJobPosts(page: Page): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  await page.route(`${API}/jobs`, async (route) => {
    const r: Request = route.request();
    if (r.method() === "POST") {
      const s = postedSettings(r.postDataBuffer()?.toString("utf8") ?? null);
      if (s) out.push(s);
    }
    await route.fallback();
  });
  return out;
}

/** Open the settings ("Change": inline on a wide screen, a sheet on a phone). */
async function openSettings(page: Page) {
  await page.getByTestId("start-change").click();
  await expect(page.getByTestId("start-settings")).toBeVisible();
}

async function closeSettings(page: Page) {
  const done = page.getByTestId("start-sheet-done");
  if (await done.isVisible()) await done.click();
  else await page.getByTestId("start-change").click();
  await expect(page.getByTestId("start-settings")).toHaveCount(0);
}

/** The id of the job POST /jobs created (the card swapped its upl- id). */
async function createdJobId(page: Page): Promise<string> {
  // The v2 opt-in keeps its projects in the jobs store (UX12).
  const id = async () =>
    [...((await readStorage<{ jobId: string }[]>(page, JOBS)) ?? []), ...((await readStorage<{ jobId: string }[]>(page, ACTIVE_JOBS)) ?? [])]
      .map((j) => j.jobId)
      .find((j) => !j.startsWith("upl-")) ?? null;
  await expect.poll(id, { timeout: 30_000 }).not.toBeNull();
  return (await id())!;
}

test("one click and the file chooser start the upload with the defaults @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  // Limits and defaults are visible before any file.
  // (The stub uploads with single PUTs: 5 GB, the most one PUT to R2 takes.)
  await expect(page.getByTestId("start-limits")).toContainText("up to 30 min and 5 GB");
  await expect(page.getByTestId("start-format-9x16")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-summary")).toHaveText("Tight cuts · “um/uh” removed · “Cleo cut” on");

  await chooseFile(page, { name: "eins.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  const jobId = await createdJobId(page);
  expect(posts).toHaveLength(1);
  // A new browser: no caption style (Power on the server), no extra formats.
  expect(posts[0]).toEqual({
    target_aspect: "9:16",
    style: "tight",
    remove_fillers: true,
    voice_triggers: true,
    smartcam_enabled: true,
    smartcam_format: "portrait",
    resolution: "1080",
    output_formats: [],
  });
  const job = (await stub.job(jobId))!;
  expect(job.settings).toMatchObject({ target_aspect: "9:16", style: "tight", output_formats: [] });
  expect(job.settings).not.toHaveProperty("caption_preset");
  expect(job.settings).not.toHaveProperty("caption_style_hint");
  expect(job.preset_id).toBeNull();
});

test("a setting changed during the upload is in the POST /jobs @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  // Hold the upload until the settings are changed.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await gate;
    await r.continue();
  });
  await chooseFile(page, { name: "zwei.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-upload")).toContainText("zwei.mp4");
  await expect(page.getByTestId("upload-dropzone")).toHaveCount(0);

  await page.getByTestId("start-format-original").click();
  await openSettings(page);
  await expect(page.getByTestId("start-lock-note")).toBeVisible();
  await page.getByTestId("start-pace-none").click();
  await page.getByTestId("start-language").selectOption("de");
  await closeSettings(page);
  await expect(page.getByTestId("start-summary")).toHaveText("No cuts · German");
  release();

  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  const jobId = await createdJobId(page);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    target_aspect: "original",
    style: "none",
    remove_fillers: false,
    voice_triggers: false,
    spoken_language: "de",
    smartcam_enabled: false,
  });
  expect((await stub.job(jobId))!.settings).toMatchObject({
    target_aspect: "original",
    style: "none",
    spoken_language: "de",
  });
});

test("saved defaults come back after a reload @editor-v2", async ({ page }) => {
  await openWithStorage(page, "/app/new");
  await page.getByTestId("start-format-original").click();
  await openSettings(page);
  await page.getByTestId("start-pace-smooth").click();
  await page.getByTestId("start-voice-help").scrollIntoViewIfNeeded();
  await page.getByRole("switch", { name: /Listen for/ }).click();
  await page.getByTestId("start-save-default").click();
  await expect(page.getByTestId("start-save-status")).toHaveText("Saved as your default");
  await expect(page.getByTestId("start-save-default")).toBeDisabled();
  expect(await readStorage(page, PREFS)).toEqual({
    target_aspect: "original",
    style: "smooth",
    remove_fillers: true,
    voice_triggers: false,
    spoken_language: "auto",
  });

  await page.reload();
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-summary")).toHaveText("Natural cuts · “um/uh” removed");
  // A change makes "Save as default" available again.
  await openSettings(page);
  await expect(page.getByTestId("start-save-default")).toBeDisabled();
  await page.getByTestId("start-pace-tight").click();
  await expect(page.getByTestId("start-save-default")).toBeEnabled();
});

test("16:9 is off for a vertical video, on for a landscape one @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await gate;
    await r.continue();
  });
  // 16:9 picked, then a vertical file: 16:9 greys out, Original takes over.
  await page.getByTestId("start-format-16x9").click();
  await chooseFile(page, { name: "hoch.webm", mimeType: "video/webm", buffer: await stub.media("portrait.webm") });
  await expect(page.getByTestId("start-format-16x9")).toBeDisabled();
  await expect(page.getByTestId("start-vertical-hint")).toHaveText("Your video is vertical, so 16:9 isn't available.");
  await expect(page.getByTestId("start-format-original")).toHaveAttribute("aria-checked", "true");
  release();
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  expect(posts[0]).toMatchObject({ target_aspect: "original", smartcam_enabled: false });

  // A landscape file: nothing greyed out.
  await page.goto("/app/new");
  await page.unroute("**/uploads/**");
  await page.route("**/uploads/**", async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await chooseFile(page, { name: "quer.webm", mimeType: "video/webm", buffer: await stub.media("landscape.webm") });
  await expect(page.getByTestId("start-upload")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("start-format-16x9")).toBeEnabled();
  await expect(page.getByTestId("start-vertical-hint")).toHaveCount(0);
});

test("a browser with earlier projects keeps Clipper; saved defaults end that @editor-v2", async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/new", { [LIBRARY]: [libEntry(done.id, "alt.mp4")] });
  const posts = await watchJobPosts(page);
  await chooseFile(page, { name: "drei.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);
  expect(posts[0]).toMatchObject({ caption_style_hint: "clipper", caption_preset: "clipper" });

  // Saved defaults: the style is the editor's choice from now on.
  await page.goto("/app/new");
  await openSettings(page);
  await page.getByTestId("start-save-default").click();
  await expect(page.getByTestId("start-save-status")).toHaveText("Saved as your default");
  await closeSettings(page);
  await chooseFile(page, { name: "vier.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(2);
  expect(posts[1]).not.toHaveProperty("caption_style_hint");
  expect(posts[1]).not.toHaveProperty("caption_preset");
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
  test("the start screen says iOS prepares long videos first @editor-v2", async ({ page }) => {
    await openWithStorage(page, "/app/new");
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

test("the settings sheet and the start screen fit a phone @editor-v2", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  await openWithStorage(page, "/app/new");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  // Choose video: a big button, above the fold.
  const box = (await page.getByTestId("upload-dropzone").boundingBox())!;
  expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height);
  await openSettings(page);
  await expect(page.getByTestId("start-sheet")).toBeVisible();
  for (const id of ["start-pace-tight", "start-language", "start-save-default", "start-sheet-done"]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }
  await closeSettings(page);
});

test("picking a file that is still uploading goes to its card, not a stuck 0 % @editor-v2", async ({ page, stub }) => {
  await openWithStorage(page, "/app/new");
  const posts = await watchJobPosts(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await gate;
    await r.continue();
  });
  // A file on disk: picked twice it is the same File (name, size and
  // lastModified) — a buffer would get a new lastModified each time.
  const file = test.info().outputPath("laeuft.mp4");
  fs.writeFileSync(file, await stub.media("grid.mp4"));
  await chooseFile(page, file);
  await page.getByTestId("start-to-projects").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // Back to the start screen (a fresh one) and the same file again.
  await page.getByTestId("dashboard-new-video").click();
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await chooseFile(page, file);
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(page.getByTestId("job-card").filter({ hasText: "laeuft.mp4" })).toHaveCount(1);
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
  const job = await stub.seed("review", { format_warning: "smartcam_failed" });
  await openWithStorage(page, `/app/edit/${job.id}`);
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  const note = page.getByTestId("format-warning");
  await expect(note).toContainText("Speaker tracking didn't work for this video, so it was centre-cropped.");
  await note.getByRole("button", { name: "Close" }).click();
  await expect(note).toHaveCount(0);
});
