// The start flow (PR1; the approved mockups docs/mockups/start 1-video,
// 2-untertitel, 2b-optionen and the waiting state), in German like them:
// "Neues Video", then "Untertitel wählen" with the video's frame (idle,
// Mehr Optionen open, waiting for the upload after "Los geht’s") at every
// size the owner checks; phones on the pixel7 project (touch), the rest
// on desktop. The other states at 390×844 and 1440×900: a refused video,
// an interrupted upload to continue, the folded Mehr Optionen summary with
// Hochkant, a failed upload, waiting for the connection, the Projekte tile
// waiting for "Los geht’s", and the iPhone's "Video wird vorbereitet…".
// Screenshots only (UX18 adds baselines). Needs E2E_EDITOR_V2=1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { API } from "../support/env";
import { chooseFile, LANG_KEY, openWithStorage, startGo } from "../support/app";
import { shot } from "./shot";

const TAG = { tag: ["@editor-v2", "@visual", "@nightly"] };

type Size = { width: number; height: number };
const PHONES: Size[] = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
  // 400 % zoom of a 1280×1024 screen
  { width: 320, height: 256 },
];
const DESKTOPS: Size[] = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 1240, height: 800 },
  { width: 1280, height: 800 },
];
const PHONE = PHONES[0];
const DESKTOP = DESKTOPS[0];

/** The phone sizes on pixel7, the others on desktop. */
function skipUnlessOwnProject(size: Size, project: string) {
  test.skip(project !== (PHONES.includes(size) ? "pixel7" : "desktop"), "phones on pixel7, the rest on desktop");
}

/** A screenshot named after the size, the pointer off the controls (no
 *  hover look). */
async function snap(page: Page, size: Size, what: string, opts?: { settleMs?: number }) {
  await page.mouse.move(2, Math.round(size.height / 2));
  await shot(page, `${size.width}x${size.height}-${what}`, opts);
}

/** The whole screen in one picture: the viewport as tall as the page (a
 *  whole-page capture draws the sticky bars where they stand in the
 *  first screenful). */
async function snapWhole(page: Page, size: Size, what: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height });
  await snap(page, size, what, { settleMs: 600 });
  await page.setViewportSize(size);
}

/** "Neues Video" in German (the routes of a step before gone). */
async function open(page: Page, size: Size, storage: Record<string, unknown> = {}) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.setViewportSize(size);
  await openWithStorage(page, "/app/new", { [LANG_KEY]: "de", ...storage });
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Hold the upload until the test ends: it stays at 0 % (the stub has
 *  no R2; its bytes go with POST /jobs once "Los geht’s" is pressed). */
async function holdUpload(page: Page) {
  await page.route("**/uploads/**", () => new Promise<void>(() => {}));
}

/** A calm clip like the mockups' frame (a warm light on dark violet; the
 *  stub's test picture is loud under the captions): VP8, which the
 *  browser decodes. Built once per machine with ffmpeg (the stub needs
 *  it too). */
function morningClip(landscape: boolean): Buffer {
  const [w, h] = landscape ? [640, 360] : [360, 640];
  const dir = join(tmpdir(), "cleocuts-e2e");
  const file = join(dir, `morgenroutine-${w}x${h}-v1.webm`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `morgenroutine-${w}x${h}-v1.${process.pid}.tmp.webm`);
    const [x, y] = [Math.round(w * 0.49), Math.round(h * 0.375)];
    const run = (picture: string) =>
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `${picture},format=yuv420p`,
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=4",
        "-c:v", "libvpx", "-crf", "4", "-b:v", "2M",
        "-c:a", "libvorbis", "-shortest", "-f", "webm", tmp,
      ]);
    try {
      run(
        `gradients=s=${w}x${h}:c0=0xb98563:c1=0x2a1c3c:c2=0x140f1f:n=3:type=radial` +
          `:x0=${x}:y0=${y}:x1=${x}:y1=${y + 320}:speed=0.00001:d=4:r=15`,
      );
    } catch {
      run(`color=c=0x2a1c3c:s=${w}x${h}:r=15:d=4`); // an ffmpeg without the radial gradients
    }
    renameSync(tmp, file);
  }
  return readFileSync(file);
}

/** Pick "Morgenroutine" (its frame is drawn on the tiles). */
async function pickVideo(page: Page, landscape = false) {
  await chooseFile(page, { name: "Morgenroutine.webm", mimeType: "video/webm", buffer: morningClip(landscape) });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  // The first tile drawn on the video's frame, and on desktop the preview.
  await expect(page.getByTestId("start-style-power").locator("canvas").nth(1)).toHaveAttribute("data-drawn", "", { timeout: 30_000 });
  if ((page.viewportSize()?.width ?? 0) >= 960) {
    await expect(page.getByTestId("start-preview").locator("canvas[data-drawn]")).toHaveCount(1, { timeout: 30_000 });
  }
  await expect(page.locator('[data-testid^="start-style-"][data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
  // Seen from the top like the mockups (the click on the card may have
  // scrolled the page to bring all of it into view).
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const size of [...PHONES, ...DESKTOPS]) {
  test(`start flow ${size.width}×${size.height}`, TAG, async ({ page }, info) => {
    skipUnlessOwnProject(size, info.project.name);
    // A returning user, as in the mockups: Power was used last.
    await open(page, size, { "cleocuts.prefs.v1": { caption_style_last: "power" } });
    await snap(page, size, "1-neues-video");

    await holdUpload(page);
    await pickVideo(page);
    await snap(page, size, "2-untertitel", { settleMs: 600 });
    const more = page.getByTestId("start-more");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await snap(page, size, "2b-optionen", { settleMs: 700 });
    await snapWhole(page, size, "2b-optionen-ganz");
    // Folded again, then "Los geht’s" while the video still uploads. Seen
    // from the top like the mockup (the click scrolled down), unless the
    // screen is too short for the button to stick.
    await more.click();
    await startGo(page);
    await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
    if (size.height > 500) await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, size, "2w-wartet", { settleMs: 600 });
  });
}

for (const size of [PHONE, DESKTOP]) {
  test(`start flow states ${size.width}×${size.height}`, TAG, async ({ page, stub }, info) => {
    skipUnlessOwnProject(size, info.project.name);
    // (Leaving a page with a video in it asks first on a desktop.)
    page.on("dialog", (d) => void d.accept());
    // Refused before any byte: over the 30-minute cap.
    await open(page, size);
    await chooseFile(page, { name: "Vortrag.webm", mimeType: "video/webm", buffer: await stub.media("long.webm") });
    await expect(page.getByTestId("start-pick-error")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, size, "1-abgelehnt");

    // A landscape video: the folded Mehr Optionen sums up what differs
    // (filler words kept, English) and that Hochkant crops it.
    await open(page, size);
    await holdUpload(page);
    await pickVideo(page, true);
    await page.getByTestId("start-more").click();
    await page.getByTestId("start-fillers").click();
    await page.getByTestId("start-language").selectOption("en");
    await page.getByTestId("start-more").click();
    await expect(page.getByTestId("start-more-summary")).toBeVisible();
    await page.getByTestId("start-more").scrollIntoViewIfNeeded();
    await snap(page, size, "2-zusammenfassung", { settleMs: 700 });

    // Waiting for the connection.
    await open(page, size);
    await page.route("**/uploads/**", (r) => r.abort("internetdisconnected"));
    await pickVideo(page);
    await expect(page.getByTestId("start-paused")).toBeVisible({ timeout: 15_000 });
    await snap(page, size, "2-pausiert");

    // A failed upload stays on Untertitel wählen: why, and Nochmal versuchen.
    await open(page, size);
    await page.route(`${API}/jobs`, (r) =>
      r.request().method() !== "POST"
        ? r.fallback()
        : r.fulfill({
            status: 507,
            contentType: "application/json",
            body: JSON.stringify({ detail: "server_storage_full", code: "server_storage_full", params: {} }),
          }),
    );
    await pickVideo(page);
    await startGo(page);
    await expect(page.getByTestId("start-upload-failed")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, size, "2-fehler");

    // Left before "Los geht’s": the Projekte tile waits for it.
    await open(page, size);
    await holdUpload(page);
    await pickVideo(page);
    await page.getByRole("link", { name: "Projekte", exact: true }).click();
    await expect(page.getByTestId("job-card-continue-start")).toBeVisible();
    await snap(page, size, "3-projekte-wartet", { settleMs: 800 });

    // An upload a reload interrupted: offered above the card.
    await open(page, size);
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
              name: "Morgenroutine.mov",
              size: 60_000_000,
              ticket: "t",
              storage_key: "uploads/x.mov",
              part_size: 16 * 1024 * 1024,
              parts_total: 4,
              done: [1, 2],
              created_at: now - 600_000,
              updated_at: now - 600_000,
              expires_at: now + 86_400_000,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.reload();
    await expect(page.getByTestId("start-resume")).toBeVisible();
    await snap(page, size, "1-fortsetzen");
  });
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

test.describe("on an iPhone", () => {
  test.use({ userAgent: IPHONE_UA });
  test(`Neues Video ${PHONE.width}×${PHONE.height}`, TAG, async ({ page }, info) => {
    skipUnlessOwnProject(PHONE, info.project.name);
    await open(page, PHONE);
    await snap(page, PHONE, "1-iphone");
    // The chooser closed, iOS prepares the video.
    await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("start-ios-hint")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, PHONE, "1-iphone-vorbereiten");
  });
});
