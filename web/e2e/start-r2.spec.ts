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
 *   reload    a reload while it waits for Let's go: the tile's "Continue
 *             upload" takes the same file straight to POST /jobs with the
 *             latest choices (no new upload, no part sent again), and
 *             remembers them as the last used; its Remove deletes the
 *             stored bytes on the server too
 *   left      stored, then Projects: the tile says "Uploaded" and that it
 *             waits; the headline doesn't count it as in progress
 *   offline   a waiting upload's connection gone: its tile says so first
 *   again     X, then the same file at once: it waits until the stored
 *             upload is discarded, then uploads anew (not an empty
 *             Projects page); the same bytes as a new File (an iPhone's
 *             pick) start a new upload at once, never the one being
 *             deleted; a discard that hangs holds a pick up for a while
 *             at most, then the pick goes on or says why it can't yet
 *   resume    a reload before Let's go: the same video picked again
 *             (the resume card, or New video once all bytes were stored)
 *             comes back with the choices it had, and POST /jobs carries
 *             them (the last used too)
 *   two tabs  a second tab's Projects shows the video waiting, and
 *             follows once Let's go is pressed in the first; the same
 *             video picked there goes to it (no second start of one
 *             upload); a start that failed before Let's go stays the
 *             first tab's (no Try again or Remove in the second)
 *   crash     the page died without pagehide (an Android tab discard):
 *             the same video picked again continues with its choices,
 *             and its old tile goes
 *   refused   POST /jobs refused, then X: the same video picked again
 *             starts with the choices just remembered (D4)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { createdJobId, jobCard, openWithStorage, readStorage, startGo, storedJobs, watchJobPosts } from "./support/app";

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

/** The record of the upload of `name` (the jobs store). */
async function recordOf(page: Page, name: string) {
  return (await storedJobs(page)).find((j) => j.filename === name)?.upload;
}

/** What the bucket holds (GET /_test/uploads). */
async function bucket(page: Page): Promise<{ open: string[]; objects: Record<string, number> }> {
  return (await page.request.get(`${API}/_test/uploads`)).json();
}

/** The resume records of lib/uploadResume (IndexedDB). */
const resumeRecords = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ name: string; completed?: boolean }[]>((res) => {
        const r = indexedDB.open("cleocuts-uploads");
        r.onsuccess = () => {
          try {
            const q = r.result.transaction("uploads").objectStore("uploads").getAll();
            q.onsuccess = () => res(q.result);
            q.onerror = () => res([]);
          } catch {
            res([]);
          }
        };
        r.onerror = () => res([]);
      }),
  );

/** The upload API calls (init / parts / sign / complete / abort) and POST
 *  /jobs of a second page. */
function callsOf(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const m = /\/uploads\/multipart\/(\w+)$/.exec(r.url());
    if (r.method() === "POST" && r.url().startsWith(API) && m) out.push(m[1]);
    if (r.method() === "POST" && r.url() === `${API}/jobs`) out.push("jobs");
  });
  return out;
}

/** Answer the upload API's init 429 (too many uploads) while `on()`. */
async function refuseInit(page: Page, on: () => boolean) {
  await page.route(`${API}/uploads/multipart/init`, (r) =>
    on()
      ? r.fulfill({
          status: 429,
          headers: { "Retry-After": "600" },
          contentType: "application/json",
          body: JSON.stringify({ detail: "too_many_uploads", code: "too_many_uploads", params: {} }),
        })
      : r.fallback(),
  );
}

const TOO_MANY = "Too many uploads in a short time. Wait a few minutes.";

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

  test("a reload while it waits for Let’s go: Continue upload takes the same file straight to POST /jobs with the latest choices", async ({ page }) => {
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
    // All its bytes are stored: it continues from there (D3), no "please
    // upload it again".
    const retry = tile.getByTestId("job-card-retry");
    await expect(retry).toHaveText("Continue upload");
    await expect(retry).toHaveAttribute("data-resume", "100");
    await expect(tile.getByTestId("job-card-status")).toHaveCount(0);
    await expect(tile.getByTestId("job-card-resume")).toBeVisible();
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
    // Remembered as it went out (D4), also on this way after a reload.
    await expect
      .poll(() => readStorage(page, "cleocuts.prefs.v1"))
      .toEqual({ target_aspect: "9:16", remove_fillers: true, spoken_language: "auto", caption_style_last: "neon" });
  });

  // (Titles end in plain ASCII: the test's files live in a folder named
  // after its end, and Chromium can't read a picked file from a path with
  // a curly apostrophe.)
  test("a reload while it uploads, before Let’s go: the resume card brings the video back with its choices, and POST /jobs sends them", async ({ page }) => {
    const posts = await watchJobPosts(page);
    // The second part waits (the page reloads meanwhile).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${moto}/**`, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
      if (route.request().method() === "PUT" && n === 2) await held;
      await route.continue().catch(() => {});
    });
    const path = fileOf("weiter.mp4", crypto.randomBytes(17 * MIB));
    await pick(page, path);
    await page.getByTestId("start-style-neon").click();
    await page.getByTestId("start-more").click();
    await page.getByTestId("start-fillers").click();
    await page.getByTestId("start-format-original").click();
    await page.getByTestId("start-language").selectOption("de");
    // (The record follows every choice.)
    await expect.poll(async () => (await recordOf(page, "weiter.mp4"))?.settings?.spoken_language).toBe("de");
    await expect.poll(() => puts).toContain(2);
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    release();

    await expect(page.getByTestId("start-resume")).toBeVisible({ timeout: 30_000 });
    api.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("start-resume-choose").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("start-more-summary")).toHaveText("“Um” stays in · Original · German");
    // (Prefs that answer late don't change them.)
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "weiter.mp4")).not.toBeNull();
    // It went on where it stopped: no new upload.
    expect(api).not.toContain("init");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      target_aspect: "original",
      style: "tight",
      remove_fillers: false,
      spoken_language: "de",
      caption_style_hint: "neon",
      caption_style: { presetId: "neon", overrides: {} },
    });
    expect(await readStorage(page, "cleocuts.prefs.v1")).toEqual({
      target_aspect: "original",
      remove_fillers: false,
      spoken_language: "de",
      caption_style_last: "neon",
    });
  });

  test("a reload once all its bytes are stored: the same file picked on New video comes back with its choices, straight to POST /jobs", async ({ page }) => {
    const posts = await watchJobPosts(page);
    const path = fileOf("gespeichert.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    await page.getByTestId("start-style-karaoke").click();
    await page.getByTestId("start-more").click();
    await page.getByTestId("start-captions-only").click();
    await page.getByTestId("start-language").selectOption("fr");
    // (The record follows every choice.)
    await expect.poll(async () => (await recordOf(page, "gespeichert.mp4"))?.settings?.spoken_language).toBe("fr");
    page.on("dialog", (d) => void d.accept());
    await page.reload();

    // Nothing left to upload: no resume card, the video is just picked again.
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    await expect(page.getByTestId("start-resume")).toHaveCount(0);
    api.length = 0;
    puts.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await expect(page.getByTestId("start-style-karaoke")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("start-more-summary")).toHaveText("Captions only · French");
    await stored(page);
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "gespeichert.mp4")).not.toBeNull();
    expect(api).toEqual([]);
    expect(puts).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      target_aspect: "9:16",
      style: "none",
      remove_fillers: false,
      voice_triggers: false,
      spoken_language: "fr",
      caption_style: { presetId: "karaoke", overrides: {} },
    });
    // Only one tile: the stopped one went.
    expect((await storedJobs(page)).filter((j) => j.filename === "gespeichert.mp4")).toHaveLength(1);
  });

  test("a second tab of the browser shows the video waiting for Let’s go, and follows when it goes", async ({ page }) => {
    const posts = jobPosts(page);
    await pick(page, fileOf("zwei-tabs.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    const other = await page.context().newPage();
    await other.goto("/app");
    const tile = jobCard(other, "zwei-tabs.mp4");
    await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
    await expect(tile.getByTestId("job-card-badge")).toHaveText("Uploaded");
    await expect(other.getByTestId("dashboard").getByRole("heading", { level: 1 })).toHaveText("Ready when you are");
    // Its way back and its Cancel are the first tab's.
    await expect(tile.getByTestId("job-card-continue-start")).toHaveCount(0);
    await expect(tile.getByTestId("job-card-cancel")).toHaveCount(0);
    await other.waitForTimeout(1000);
    expect(posts).toEqual([]);

    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "zwei-tabs.mp4")).not.toBeNull();
    await expect(tile).not.toHaveAttribute("data-state", /^upload/, { timeout: 30_000 });
    await expect(tile.getByTestId("job-card-status")).not.toHaveText("Waiting for “Let’s go”");
    expect(posts).toHaveLength(1);
    await other.close();
  });

  test("X, then the same video as a new File (an iPhone's pick) while the discard is still out: a new upload, and the job starts from it", async ({ page }) => {
    const posts = await watchJobPosts(page);
    const bytes = crypto.randomBytes(3 * MIB);
    await pick(page, fileOf("neu-gewaehlt.mp4", bytes));
    await stored(page);
    // The abort reaches the server; its answer comes late (a slow connection).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${API}/uploads/multipart/abort`, async (route) => {
      const answer = await route.fetch();
      await held;
      await route.fulfill({ response: answer }).catch(() => {});
    });
    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    await expect.poll(() => api).toContain("abort");
    api.length = 0;
    puts.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles({ name: "neu-gewaehlt.mp4", mimeType: "video/mp4", buffer: bytes });
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await stored(page);
    expect(api).toContain("init");
    expect(puts.length).toBeGreaterThan(0);
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "neu-gewaehlt.mp4")).not.toBeNull();
    expect(posts).toHaveLength(1);
    release();
  });

  test("X, then the same file again while the discard hangs: the pick waits a while at most, then the video uploads anew", async ({ page }) => {
    const posts = jobPosts(page);
    const path = fileOf("haengt.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    // The abort never gets an answer.
    await page.route(`${API}/uploads/multipart/abort`, () => new Promise<void>(() => {}));
    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    await expect.poll(() => api).toContain("abort");
    api.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    // (Within the 15 s a pick waits for a discard.)
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style", { timeout: 15_000 });
    await stored(page);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  test("Remove on the tile of a video stopped with all its bytes stored (a reload while it waited): the server deletes them, nothing is kept", async ({ page }) => {
    let key = "";
    page.on("response", async (r) => {
      if (r.url() === `${API}/uploads/multipart/init` && r.ok()) key = ((await r.json()) as { storage_key: string }).storage_key;
    });
    await pick(page, fileOf("entfernen.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    await expect.poll(() => key).not.toBe("");
    page.on("dialog", (d) => void d.accept());
    await page.reload();

    await page.goto("/app");
    const tile = jobCard(page, "entfernen.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 45_000 });
    await expect(tile.getByTestId("job-card-retry")).toHaveAttribute("data-resume", "100");
    expect(Object.keys((await bucket(page)).objects)).toContain(key);
    api.length = 0;
    await tile.getByTestId("job-card-remove").click();
    await expect(tile).toHaveCount(0);
    await expect.poll(() => api).toEqual(["abort"]);
    await expect.poll(async () => Object.keys((await bucket(page)).objects)).not.toContain(key);
    expect(await resumeRecords(page)).toEqual([]);
  });

  test("the page died while it waited for Let’s go, without pagehide (an Android tab discard): the same video comes back with its choices, and its old tile goes", async ({ page }) => {
    const path = fileOf("absturz.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    await page.getByTestId("start-style-neon").click();
    await page.getByTestId("start-more").click();
    await page.getByTestId("start-fillers").click();
    await page.getByTestId("start-language").selectOption("de");
    await expect.poll(async () => (await recordOf(page, "absturz.mp4"))?.settings?.spoken_language).toBe("de");
    // The renderer dies: no pagehide, nothing marks the record.
    const cdp = await page.context().newCDPSession(page);
    const crashed = new Promise((r) => page.once("crash", r));
    void cdp.send("Page.crash").catch(() => {});
    await Promise.race([crashed, new Promise((r) => setTimeout(r, 5000))]);

    const next = await page.context().newPage();
    const posts = await watchJobPosts(next);
    const calls = callsOf(next);
    await next.goto("/app/new");
    expect((await recordOf(next, "absturz.mp4"))?.errorCode ?? null).toBeNull();
    const [chooser] = await Promise.all([next.waitForEvent("filechooser"), next.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(next.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await expect(next.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
    await expect(next.getByTestId("start-more-summary")).toContainText("German");
    await stored(next);
    await startGo(next);
    await expect(next).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(next, "absturz.mp4")).not.toBeNull();
    // Nothing went up again: the stored upload went straight to its job.
    expect(calls).toEqual(["jobs"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      remove_fillers: false,
      spoken_language: "de",
      caption_style_hint: "neon",
      caption_style: { presetId: "neon", overrides: {} },
    });
    // One tile of the video: the dead record went with the new start.
    expect((await storedJobs(next)).filter((j) => j.filename === "absturz.mp4")).toHaveLength(1);
    await expect(jobCard(next, "absturz.mp4")).toHaveCount(1);
    await expect(jobCard(next, "absturz.mp4").getByTestId("job-card-retry")).toHaveCount(0);
    await next.close();
  });

  test("the page died while it waited for Let’s go: no tab runs it now, so the Projects headline counts it", async ({ page }) => {
    await pick(page, fileOf("tot.mp4", crypto.randomBytes(3 * MIB)));
    await stored(page);
    const cdp = await page.context().newCDPSession(page);
    const crashed = new Promise((r) => page.once("crash", r));
    void cdp.send("Page.crash").catch(() => {});
    await Promise.race([crashed, new Promise((r) => setTimeout(r, 5000))]);

    const next = await page.context().newPage();
    await next.goto("/app");
    await expect(jobCard(next, "tot.mp4")).toBeVisible();
    // Not "waiting" (its record's old word): uploading until it is marked
    // stopped (or stopped already).
    await expect(next.getByTestId("dashboard").getByRole("heading", { level: 1 })).not.toHaveText("Ready when you are");
    await next.close();
  });

  test("the same video picked in a second tab while the first waits for Let’s go: it goes to Projects, where it waits; nothing goes up or away, and the first tab starts it", async ({ page }) => {
    const posts = await watchJobPosts(page);
    let key = "";
    page.on("response", async (r) => {
      if (r.url() === `${API}/uploads/multipart/init` && r.ok()) key = ((await r.json()) as { storage_key: string }).storage_key;
    });
    const bytes = crypto.randomBytes(3 * MIB);
    await pick(page, fileOf("doppelt.mp4", bytes));
    await stored(page);
    await page.getByTestId("start-style-neon").click();

    const other = await page.context().newPage();
    const calls = callsOf(other);
    await other.goto("/app/new");
    // The same bytes as a new File (an iPhone's pick).
    const [chooser] = await Promise.all([other.waitForEvent("filechooser"), other.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles({ name: "doppelt.mp4", mimeType: "video/mp4", buffer: bytes });
    await expect(other).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
    const tile = jobCard(other, "doppelt.mp4");
    await expect(tile).toHaveCount(1);
    await expect(tile.getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
    // Its Cancel is the first tab's.
    await expect(tile.getByTestId("job-card-cancel")).toHaveCount(0);
    await other.waitForTimeout(1000);
    expect(calls).toEqual([]);
    expect(Object.keys((await bucket(page)).objects)).toContain(key);

    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "doppelt.mp4")).not.toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } });
    expect(calls).toEqual([]);
    await other.close();
  });

  test("a start that failed before Let’s go stays the first tab’s: a second tab shows it stopped, with its reason, and no Try again or Remove; the first tab then makes one job", async ({ page }) => {
    const posts = jobPosts(page);
    let refuse = true;
    await refuseInit(page, () => refuse);
    await pick(page, fileOf("zwei-tabs-fehler.mp4", crypto.randomBytes(3 * MIB)));
    await expect(page.getByTestId("start-upload-failed")).toContainText(TOO_MANY);

    const other = await page.context().newPage();
    const calls = callsOf(other);
    await other.goto("/app");
    const tile = jobCard(other, "zwei-tabs-fehler.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed");
    await expect(tile.getByTestId("job-card-status")).toHaveText(TOO_MANY);
    // (Asked every few seconds: still the first tab's start after that.)
    await other.waitForTimeout(6000);
    await expect(tile.getByTestId("job-card-retry")).toHaveCount(0);
    await expect(tile.getByTestId("job-card-remove")).toHaveCount(0);
    await expect(tile.getByTestId("job-card-continue-start")).toHaveCount(0);

    refuse = false;
    await page.getByTestId("start-retry").click();
    await stored(page);
    await startGo(page);
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 60_000 });
    await expect.poll(() => createdJobId(page, "zwei-tabs-fehler.mp4")).not.toBeNull();
    await expect(tile).not.toHaveAttribute("data-state", /^upload/, { timeout: 30_000 });
    expect(posts).toHaveLength(1);
    expect(calls).toEqual([]);
    await other.close();
  });

  test("a start that failed before Let’s go, its tab closed: the second tab's tile offers Try again (D3)", async ({ page }) => {
    const first = await page.context().newPage();
    await refuseInit(first, () => true);
    await pick(first, fileOf("geschlossen.mp4", crypto.randomBytes(3 * MIB)));
    await expect(first.getByTestId("start-upload-failed")).toContainText(TOO_MANY);
    await page.goto("/app");
    const tile = jobCard(page, "geschlossen.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed");
    await page.waitForTimeout(6000);
    await expect(tile.getByTestId("job-card-retry")).toHaveCount(0);
    await first.close();
    await expect(tile.getByTestId("job-card-retry")).toBeVisible({ timeout: 15_000 });
    await expect(tile.getByTestId("job-card-remove")).toBeVisible();
  });

  test("Let’s go, the job refused, X: the same video picked again starts with the choices just remembered", async ({ page }) => {
    await page.route(`${API}/jobs`, (r) =>
      r.request().method() !== "POST"
        ? r.fallback()
        : r.fulfill({
            status: 507,
            contentType: "application/json",
            body: JSON.stringify({ detail: "server_storage_full", code: "server_storage_full", params: {} }),
          }),
    );
    const path = fileOf("nochmal-gewaehlt.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    await page.getByTestId("start-style-karaoke").click();
    await startGo(page);
    await expect(page.getByTestId("start-upload-failed")).toBeVisible({ timeout: 30_000 });
    // Remembered as its POST /jobs went out (D4).
    await expect.poll(() => readStorage(page, "cleocuts.prefs.v1")).toMatchObject({ caption_style_last: "karaoke" });
    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    // In the same visit, as in the next one.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style", { timeout: 30_000 });
    const karaoke = page.getByTestId("start-style-karaoke");
    await expect(karaoke).toHaveAttribute("aria-checked", "true");
    await expect(karaoke.getByTestId("start-style-tag")).toHaveText("Last used");
  });

  test("X, then the same file again while the discard hangs here (not on the server): after a while the pick says why", async ({ page }) => {
    const path = fileOf("steckt.mp4", crypto.randomBytes(3 * MIB));
    await pick(page, path);
    await stored(page);
    // Winding down never ends (the discard's look at other tabs hangs).
    await page.evaluate(() => {
      Object.defineProperty(navigator.locks, "query", { value: () => new Promise(() => {}), configurable: true });
    });
    await page.getByTestId("start-cancel").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
    api.length = 0;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    await expect(page.getByTestId("start-preparing")).toBeVisible();
    const error = page.getByTestId("start-pick-error");
    await expect(error).toHaveText("Your cancelled upload is still being removed. Pick the video again in a moment.", { timeout: 20_000 });
    await expect(page.getByTestId("start-preparing")).toHaveCount(0);
    expect(api).toEqual([]);
  });
});

