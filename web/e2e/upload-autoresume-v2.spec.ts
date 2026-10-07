/**
 * An upload goes on by itself (the owner's iPhone, 2026-10: "it stopped
 * at 6% — I expect it to just keep going"). Runs with E2E_MODE=r2
 * E2E_EDITOR_V2=1 (CI: e2e editor-v2-r2): multipart uploads to a moto S3
 * server (CLEO_UPLOAD_MODE=multipart).
 *
 *   lost     the part requests fail for a while (connection gone, Safari
 *            in the background: hidden, pagehide, offline) while the user
 *            goes to Projects: "waiting for connection", never "Upload
 *            stopped"; once they get through the upload finishes from the
 *            next missing part — same document, no new init, no re-pick
 *   reload   after a reload (the File is gone) the stopped tile's
 *            "Continue upload" asks for the file: another video is
 *            refused with a clear message, the same bytes continue from
 *            the parts R2 has, without a new init
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { createdJobId, jobCard, openWithStorage, storedJobs } from "./support/app";

const MIB = 1024 * 1024;

function fileOf(name: string, bytes: Buffer): string {
  const path = test.info().outputPath(name);
  fs.writeFileSync(path, bytes);
  return path;
}

const partOf = (route: Route) => Number(new URL(route.request().url()).searchParams.get("partNumber"));

/** Make the page believe it was hidden / shown (the app switcher). */
async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test.describe("an upload that goes on by itself", { tag: ["@editor-v2", "@r2"] }, () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only (request interception of the uploads)");
  test.describe.configure({ timeout: 300_000 });

  let moto = "";
  const api: string[] = [];
  const puts: [part: number, status: number][] = [];
  const okParts = () =>
    puts
      .filter(([, s]) => s === 200)
      .map(([n]) => n)
      .sort((a, b) => a - b);

  test.beforeEach(async ({ page, stub }) => {
    const info = await stub.info();
    expect(info.r2, "the stub runs without --r2").toBe(true);
    moto = info.r2_endpoint!;
    api.length = 0;
    puts.length = 0;
    page.on("request", (r) => {
      const m = /\/uploads\/multipart\/(\w+)$/.exec(r.url());
      if (r.method() === "POST" && r.url().startsWith(API) && m) api.push(m[1]);
    });
    page.on("requestfinished", async (r) => {
      if (r.method() === "PUT" && r.url().startsWith(moto)) {
        const res = await r.response();
        puts.push([Number(new URL(r.url()).searchParams.get("partNumber")), res ? res.status() : 0]);
      }
    });
  });

  test("the connection goes for a while: waiting, then it finishes by itself", async ({ page, context, stub }) => {
    const size = 60 * MIB + 12345; // 4 parts of 16 MiB
    const bytes = crypto.randomBytes(size);
    let blocked = true;
    const failed: number[] = [];
    await page.route(`${moto}/**`, (route) => {
      if (route.request().method() === "PUT" && partOf(route) >= 3 && blocked) {
        failed.push(partOf(route));
        return route.abort("internetdisconnected");
      }
      return route.continue();
    });
    // Any "Upload stopped" tile, however briefly.
    await page.addInitScript(() => {
      const w = window as unknown as { __stopped?: boolean };
      new MutationObserver(() => {
        if (document.querySelector('[data-state="upload_failed"]')) w.__stopped = true;
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await openWithStorage(page, "/app/new");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(fileOf("IMG_0107.mov", bytes));
    await page.evaluate(() => ((window as unknown as { __doc?: number }).__doc = 1));

    // The start screen: waiting, not failed.
    await expect(page.getByTestId("start-paused")).toContainText("Waiting for connection", { timeout: 30_000 });
    await expect.poll(okParts, { timeout: 60_000 }).toEqual([1, 2]);

    // To Projects meanwhile (a client-side navigation): the live tile.
    await page.getByTestId("start-to-projects").click();
    await expect(page).toHaveURL(`${WEB}/app`);
    const tile = jobCard(page, "IMG_0107.mov");
    await expect(tile).toHaveAttribute("data-state", "uploading");
    await expect(tile.getByTestId("job-card-status")).toContainText("Waiting for connection");
    await expect(tile.getByTestId("job-card-retry")).toHaveCount(0);

    // Safari goes to the background: hidden, then pagehide (not
    // persisted) — which writes "interrupted" in case the page dies.
    await setVisibility(page, "hidden");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await expect
      .poll(async () => (await storedJobs(page)).find((j) => j.filename === "IMG_0107.mov")?.upload?.errorCode)
      .toBe("upload_interrupted");
    // The phone is offline for a bit, and comes back to Safari.
    await context.setOffline(true);
    // Longer than the 4 tries (~13 s) after which it used to stop.
    await page.waitForTimeout(15_000);
    await setVisibility(page, "visible");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    // The same page: its upload is running again on the record too.
    await expect
      .poll(async () => (await storedJobs(page)).find((j) => j.filename === "IMG_0107.mov")?.upload?.errorCode ?? null)
      .toBeNull();
    await expect(tile).toHaveAttribute("data-state", "uploading");
    expect(failed.length).toBeGreaterThan(2);

    // Desktop: leaving the page now asks first (iOS ignores beforeunload).
    const leaveAsks = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    const desktop = test.info().project.name === "desktop";
    expect(await leaveAsks()).toBe(desktop);

    // The connection is back: it goes on by itself, from part 3.
    blocked = false;
    await context.setOffline(false);
    await expect(tile).not.toHaveAttribute("data-state", "uploading", { timeout: 60_000 });
    const id = await createdJobId(page, "IMG_0107.mov");
    expect(id).not.toBeNull();
    expect((await stub.job(id!))!.size).toBe(size);
    expect(okParts()).toEqual([1, 2, 3, 4]);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
    expect(api).not.toContain("parts");
    expect(await page.evaluate(() => (window as unknown as { __stopped?: boolean }).__stopped ?? false)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __doc?: number }).__doc)).toBe(1);
    expect(await leaveAsks()).toBe(false);
  });

  test("after a reload: Continue upload refuses another video and resumes the same bytes", async ({ page }) => {
    const size = 60 * MIB + 777; // 4 parts
    const bytes = crypto.randomBytes(size);
    const held: Route[] = [];
    await page.route(`${moto}/**`, async (route) => {
      if (route.request().method() === "PUT" && partOf(route) >= 3) {
        held.push(route);
        return;
      }
      return route.continue();
    });
    await openWithStorage(page, "/app/new");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(fileOf("urlaub.mp4", bytes));
    await expect.poll(okParts, { timeout: 90_000 }).toEqual([1, 2]);
    await page.waitForTimeout(1000); // the resume record has parts 1 and 2
    // The owner pulled to refresh mid-upload: the File is gone.
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page.unroute(`${moto}/**`);
    for (const r of held) r.abort().catch(() => {});
    await page.goto("/app");
    const tile = jobCard(page, "urlaub.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 45_000 });
    await expect(tile.getByTestId("job-card-resume")).toContainText("choose the same video");
    api.length = 0;
    puts.length = 0;

    // Another video: refused, said so; nothing starts and the tile stays.
    const retry = tile.getByTestId("job-card-retry");
    await expect(retry).toContainText("Continue upload");
    let [picker] = await Promise.all([page.waitForEvent("filechooser"), retry.click()]);
    await picker.setFiles(fileOf("anderes.mp4", crypto.randomBytes(size)));
    await expect(tile.getByTestId("job-card-wrong-file")).toContainText("different video");
    await expect(tile.getByTestId("job-card-wrong-file")).toContainText("urlaub.mp4");
    await page.waitForTimeout(1000);
    expect(api).toEqual([]);
    await expect(tile).toHaveAttribute("data-state", "upload_failed");

    // The same bytes (iOS hands them over under another name): they
    // continue from the parts R2 has.
    [picker] = await Promise.all([page.waitForEvent("filechooser"), retry.click()]);
    await picker.setFiles(fileOf("IMG_4711.mp4", bytes));
    await expect.poll(() => createdJobId(page, "IMG_4711.mp4"), { timeout: 120_000 }).not.toBeNull();
    expect(api).not.toContain("init");
    expect(api[0]).toBe("parts");
    expect(okParts()).toEqual([3, 4]);
    await expect(jobCard(page, "urlaub.mp4")).toHaveCount(0);
  });
});
