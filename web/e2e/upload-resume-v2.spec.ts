/**
 * An interrupted upload continues (v2 opt-in; the owner's iPhone report
 * of 2026-10: "my phone switched off and my progress was lost"). Runs
 * with E2E_MODE=r2 E2E_EDITOR_V2=1 (CI: e2e editor-v2-r2): the stub keeps
 * uploads in a moto S3 server and uploads take the resumable multipart
 * path (CLEO_UPLOAD_MODE=multipart).
 *
 *   resume   a reload mid-upload; the Projects tile and the start screen
 *            say where it stopped; the same bytes picked again under
 *            another name (as iOS does) continue from the parts the
 *            server lists — no completed part is sent again — and the
 *            job is created
 *   other    another file starts a new upload and leaves the interrupted
 *            one offered; "Discard" aborts it on the server
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { API, WEB } from "./support/env";
import { createdJobId, jobCard, openWithStorage, storedJobs } from "./support/app";

const MIB = 1024 * 1024;

/** `bytes` as a file called `name` (setFiles takes no buffer over 50 MB);
 *  written now: a new name and a new lastModified for the same bytes. */
function fileOf(name: string, bytes: Buffer): string {
  const path = test.info().outputPath(name);
  fs.writeFileSync(path, bytes);
  return path;
}

/** The resume records of lib/uploadResume (IndexedDB). */
const records = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ name: string; done: number[]; v: number; expires_at?: number }[]>((res) => {
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

test.describe("resume an interrupted upload", { tag: ["@editor-v2", "@r2"] }, () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only (request interception of the uploads)");
  test.describe.configure({ timeout: 300_000 });

  let moto = "";
  /** Upload API calls (init / parts / sign / complete / abort) and part PUTs. */
  const api: string[] = [];
  const puts: [part: number, status: number][] = [];

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

  const okParts = () =>
    puts
      .filter(([, s]) => s === 200)
      .map(([n]) => n)
      .sort((a, b) => a - b);

  /** Start an upload of `bytes` on the start screen; parts from `holdFrom`
   *  on never answer. Once the parts before it are in R2 and in the
   *  resume record the page is reloaded mid-upload (the phone went off). */
  async function interruptedUpload(page: Page, path: string, holdFrom: number) {
    const held: Route[] = [];
    await page.route(`${moto}/**`, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
      if (route.request().method() === "PUT" && n >= holdFrom) {
        held.push(route);
        return;
      }
      return route.continue();
    });
    await openWithStorage(page, "/app/new");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("upload-dropzone").click()]);
    await chooser.setFiles(path);
    const before = Array.from({ length: holdFrom - 1 }, (_, i) => i + 1);
    await expect.poll(okParts, { timeout: 90_000 }).toEqual(before);
    // On phones: the honest hint while it uploads.
    if (test.info().project.name === "pixel7") {
      await expect(page.getByTestId("start-keep-open")).toContainText("phone on");
    }
    await expect.poll(async () => (await records(page)).map((r) => [...r.done].sort()), { timeout: 15_000 }).toEqual([before]);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
    const [rec] = await records(page);
    expect(rec.v).toBe(2);
    // The ticket's expiry, as the backend gives it (7 days with the
    // bucket rules of r2_setup).
    expect(rec.expires_at! - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    // Reloaded while parts are still on their way (none may slip
    // through after the page is gone).
    await page.reload();
    await page.unroute(`${moto}/**`);
    for (const r of held) r.abort().catch(() => {});
    api.length = 0;
    puts.length = 0;
  }

  test("a reload mid-upload; the same bytes under another name continue from the server's parts", async ({ page, stub }) => {
    const size = 60 * MIB + 12345; // 4 parts of 16 MiB
    const bytes = crypto.randomBytes(size);
    await interruptedUpload(page, fileOf("IMG_0042.mp4", bytes), 3);

    // Projects: the stopped tile says where it stopped and how to go on.
    await page.goto("/app");
    const tile = jobCard(page, "IMG_0042.mp4");
    await expect(tile).toHaveAttribute("data-state", "upload_failed", { timeout: 45_000 });
    await expect(tile.getByTestId("job-card-status")).toContainText("Stopped at 53%");
    await expect(tile.getByTestId("job-card-retry")).toContainText("Continue upload");

    // The start screen: the card on top.
    await page.goto("/app/new");
    const card = page.getByTestId("start-resume");
    await expect(card).toContainText("Upload of IMG_0042.mp4 stopped at 53%");
    // The same bytes, renamed and with a new date (what iOS hands over).
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), card.getByTestId("start-resume-choose").click()]);
    await chooser.setFiles(fileOf("trim.6F1C2D3A.mp4", bytes));
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 120_000 });
    const id = await createdJobId(page, "trim.6F1C2D3A.mp4");
    expect(id).not.toBeNull();

    // Only the parts R2 didn't have went up; no second upload was opened.
    expect(api).not.toContain("init");
    expect(api[0]).toBe("parts");
    expect(api).toContain("complete");
    expect(okParts()).toEqual([3, 4]);
    expect(puts.map(([n]) => n).filter((n) => n <= 2)).toEqual([]);
    expect((await stub.job(id!))!.size).toBe(size);
    // The stopped tile went with the resume; the record is settled.
    await expect(jobCard(page, "IMG_0042.mp4")).toHaveCount(0);
    expect((await storedJobs(page)).filter((j) => j.jobId.startsWith("upl-"))).toEqual([]);
    expect(await records(page)).toEqual([]);
    await page.goto("/app/new");
    await expect(page.getByTestId("upload-dropzone")).toBeVisible();
    await expect(page.getByTestId("start-resume")).toHaveCount(0);
  });

  test("another file starts a new upload and leaves the card; Discard aborts it", async ({ page }) => {
    const first = crypto.randomBytes(40 * MIB + 1); // 3 parts
    await interruptedUpload(page, fileOf("erstes.mp4", first), 2);
    const card = page.getByTestId("start-resume");
    await expect(card).toContainText("Upload of erstes.mp4 stopped at 39%");

    // Another video (same name even): a new upload, the card's stays.
    const other = crypto.randomBytes(17 * MIB);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), card.getByTestId("start-resume-choose").click()]);
    await chooser.setFiles({ name: "erstes.mp4", mimeType: "video/mp4", buffer: other });
    await expect(page).toHaveURL(`${WEB}/app`, { timeout: 120_000 });
    expect(await createdJobId(page, "erstes.mp4")).not.toBeNull();
    expect(api).toContain("init");
    expect(api).not.toContain("parts");
    expect(okParts()).toEqual([1, 2]);
    expect((await records(page)).map((r) => r.done)).toEqual([[1]]);

    await page.goto("/app/new");
    await expect(card).toContainText("stopped at 39%");
    const open = async () => ((await (await page.request.get(`${API}/_test/uploads`)).json()) as { open: string[] }).open.length;
    const openBefore = await open();
    await card.getByTestId("start-resume-discard").click();
    await expect(card).toHaveCount(0);
    expect(api).toContain("abort");
    expect(await records(page)).toEqual([]);
    await expect.poll(open).toBe(openBefore - 1);
    // Still gone after a reload.
    await page.reload();
    await expect(page.getByTestId("upload-dropzone")).toBeVisible();
    await expect(page.getByTestId("start-resume")).toHaveCount(0);
  });
});
