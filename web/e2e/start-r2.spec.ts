/**
 * The start flow on the R2 path (production; PR1 D1 to D3). Runs with
 * E2E_MODE=r2 E2E_EDITOR_V2=1 (CI: e2e editor-v2-r2): the stub keeps
 * uploads in a moto S3 server and they take the resumable multipart path.
 * The bytes go up while the user chooses; POST /jobs waits for "Let's go"
 * and carries the choices as they are when it goes out.
 *
 *   stored    all bytes up, then the choices, then Let's go: one POST
 *             with them (§4.4 row 2)
 *   waiting   Let's go before the last part is up: "Starts after the
 *             upload"; a style picked meanwhile is the one POST carries
 *   cancel    X on a stored upload: no job, and the server deletes what
 *             was uploaded (no object, no open multipart upload)
 *   reload    a reload while it waits for Let's go: the tile's "Try
 *             again" takes the same file straight to POST /jobs with the
 *             latest choices (no new upload, no part sent again)
 *   left      stored, then Projects: the tile says "Uploaded" and that it
 *             waits; the headline doesn't count it as in progress
 *   offline   a waiting upload's connection gone: its tile says so first
 *   again     X, then the same file at once: it waits until the stored
 *             upload is discarded, then uploads anew (not an empty
 *             Projects page)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { createdJobId, jobCard, openWithStorage, startGo, storedJobs, watchJobPosts } from "./support/app";

/** POST /jobs requests of the page (none may go out before Let's go). */
function jobPosts(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${API}/jobs`) out.push(r.url());
  });
  return out;
}

const MIB = 1024 * 1024;

/** `bytes` as a file called `name` (written now). */
function fileOf(name: string, bytes: Buffer): string {
  const path = test.info().outputPath(name);
  fs.writeFileSync(path, bytes);
  return path;
}

/** Pick `path` on New video: "Choose captions" follows. */
async function pick(page: Page, path: string) {
  await openWithStorage(page, "/app/new");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
  await chooser.setFiles(path);
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
}

/** All its bytes are in R2: the upload waits for Let's go. */
async function stored(page: Page) {
  const status = page.getByTestId("start-upload-status");
  await expect(status).toHaveAttribute("data-state", "uploaded", { timeout: 90_000 });
  await expect(status).toHaveText("Uploaded");
}

/** What the bucket holds (GET /_test/uploads). */
async function bucket(page: Page): Promise<{ open: string[]; objects: Record<string, number> }> {
  return (await page.request.get(`${API}/_test/uploads`)).json();
}

test.describe("the start flow on R2", { tag: ["@editor-v2", "@r2"] }, () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only (request interception of the uploads)");
  test.describe.configure({ timeout: 180_000 });

  let moto = "";
  /** Upload API calls (init / parts / sign / complete / abort) and part PUTs. */
  const api: string[] = [];
  const puts: number[] = [];

  test.beforeEach(async ({ page, stub }) => {
    const info = await stub.info();
    expect(info.r2, "the stub runs without --r2").toBe(true);
    moto = info.r2_endpoint!;
    api.length = 0;
    puts.length = 0;
    page.on("request", (r) => {
      const m = /\/uploads\/multipart\/(\w+)$/.exec(r.url());
      if (r.method() === "POST" && r.url().startsWith(API) && m) api.push(m[1]);
      if (r.method() === "PUT" && r.url().startsWith(moto)) puts.push(Number(new URL(r.url()).searchParams.get("partNumber")));
    });
  });

  test("stored while the user chooses: Let’s go sends one POST with the choices", async ({ page }) => {
    const posts = await watchJobPosts(page);
    await pick(page, fileOf("karaoke.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    await expect(page.getByTestId("start-announce")).toHaveText("Your video has uploaded.");
    await expect(page.getByTestId("start-keep-open")).toHaveCount(0);
    await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "idle");
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);

    await page.getByTestId("start-style-karaoke").click();
    await page.getByTestId("start-more").click();
    await page.getByTestId("start-captions-only").click();
    await page.getByTestId("start-format-original").click();
    await page.getByTestId("start-language").selectOption("de");
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "karaoke.mp4")).not.toBeNull();
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
  });

  test("Let’s go before the last part is up: it waits, and a style picked meanwhile is the one POST carries", async ({ page }) => {
    const posts = await watchJobPosts(page);
    // The second (last) part waits.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${moto}/**`, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
      if (route.request().method() === "PUT" && n === 2) await held;
      await route.continue().catch(() => {});
    });
    await pick(page, fileOf("neon.mp4", crypto.randomBytes(17 * MIB)));
    await expect.poll(() => puts).toContain(2);
    await startGo(page);
    const go = page.getByTestId("start-go");
    await expect(go).toHaveAttribute("data-state", "waiting");
    await expect(go).toHaveText("Starts after the upload");
    await expect(page.getByTestId("start-upload-status")).toHaveAttribute("data-state", "uploading");
    await expect(page.getByTestId("start-keep-open")).toBeVisible();
    await page.getByTestId("start-style-neon").click();
    await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);

    release();
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "neon.mp4")).not.toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
  });

  test("X on a stored upload: no job, and nothing is left in the bucket", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url() === `${API}/jobs`) posts.push(r.url());
    });
    // The object's key, as the upload was opened.
    let key = "";
    page.on("response", async (r) => {
      if (r.url() === `${API}/uploads/multipart/init` && r.ok()) key = ((await r.json()) as { storage_key: string }).storage_key;
    });
    await pick(page, fileOf("weg.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    await expect.poll(() => key).not.toBe("");
    expect(Object.keys((await bucket(page)).objects)).toContain(key);

    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    await expect.poll(async () => Object.keys((await bucket(page)).objects)).not.toContain(key);
    expect((await bucket(page)).open).not.toContain(key);
    expect(api).toContain("abort");
    expect(posts).toEqual([]);
    expect(await storedJobs(page)).toEqual([]);
  });

  test("left while it waits for Let’s go: its tile says Uploaded and waiting; the headline doesn't count it", async ({ page }) => {
    const posts = jobPosts(page);
    await pick(page, fileOf("wartet.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(`${WEB}/app`);
    const tile = jobCard(page, "wartet.mp4");
    await expect(tile.getByTestId("job-card-badge")).toHaveText("Uploaded");
    await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
    await expect(tile.getByTestId("job-card-continue-start")).toBeVisible();
    await expect(page.getByTestId("dashboard").getByRole("heading", { level: 1 })).toHaveText("Ready when you are");
    await page.waitForTimeout(1000);
    expect(posts).toEqual([]);
  });

  test("a waiting upload whose connection went: its tile says so first", async ({ page }) => {
    // The second (last) part never gets through.
    await page.route(`${moto}/**`, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
      if (route.request().method() === "PUT" && n >= 2) return route.abort("internetdisconnected");
      await route.continue().catch(() => {});
    });
    await pick(page, fileOf("weg-netz.mp4", crypto.randomBytes(17 * MIB)));
    await expect(page.getByTestId("start-paused")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    const tile = jobCard(page, "weg-netz.mp4");
    await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for connection… The upload continues automatically.");
    await expect(tile.getByTestId("job-card-continue-start")).toBeVisible();
  });

  test("X, then the same file again at once: it waits until the stored upload is discarded, then uploads anew", async ({ page }) => {
    const posts = jobPosts(page);
    const path = fileOf("nochmal.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    // Discarding the stored upload takes a while (a slow connection).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${API}/uploads/multipart/abort`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    await expect.poll(() => api).toContain("abort");
    api.length = 0;
    // The same file (on disk: the same name, size and date) at once.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(`${WEB}/app/new`);
    expect(api).toEqual([]);
    release();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style", { timeout: 30_000 });
    await stored(page);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  test("a reload while it waits for Let’s go: Try again takes the same file straight to POST /jobs with the latest choices", async ({ page }) => {
    const posts = await watchJobPosts(page);
    const bytes = crypto.randomBytes(3 * MIB);
    await pick(page, fileOf("IMG_0300.mp4", bytes));
    await stored(page);
    await page.getByTestId("start-style-neon").click();
    // The record follows every choice.
    await expect
      .poll(async () => (await storedJobs(page)).find((j) => j.filename === "IMG_0300.mp4")?.upload?.settings?.caption_style_hint)
      .toBe("neon");
    // (Leaving asks first on a desktop while a video is in the page.)
    page.on("dialog", (d) => void d.accept());
    await page.reload();

    await page.goto("/app");
    const tile = jobCard(page, "IMG_0300.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 45_000 });
    // All its bytes are stored: nothing to continue, it goes again.
    const retry = tile.getByTestId("job-card-retry");
    await expect(retry).toHaveText("Try again");
    api.length = 0;
    puts.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), retry.click()]);
    await chooser.setFiles(fileOf("IMG_0300.mp4", bytes));
    await expect.poll(() => createdJobId(page, "IMG_0300.mp4"), { timeout: 60_000 }).not.toBeNull();
    expect(api).not.toContain("init");
    expect(api).not.toContain("parts");
    expect(puts).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
  });
});
