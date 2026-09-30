/**
 * Uploads and media with R2 (scratchpad wp3/bt wp3media, wp3upload,
 * wp3post) — run with E2E_MODE=r2 E2E_NIGHTLY=1: the stub keeps media in
 * a moto S3 server and uploads go straight to it (CLEO_UPLOAD_MODE=
 * multipart).
 *   media   media routes answer 307 to presigned R2 GETs (editor proxy,
 *           library thumbnail, attachment downloads)
 *   upload  resumable multipart upload: a cut-off part is retried; a
 *           reload + re-pick resumes with only the missing parts
 *   post    POST /jobs after the upload: retried with backoff on 5xx and
 *           network errors, the resume record kept until the job exists;
 *           an old API (no multipart) gets one long try
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test } from "./support/fixtures";
import { API } from "./support/env";
import { ACTIVE_JOBS, editorVideo, LIBRARY, libEntry, openWithStorage, playbackMode, VOICE_SEEN } from "./support/app";
import type { Page } from "@playwright/test";

const MIB = 1024 * 1024;

test.describe("R2 uploads and media", { tag: ["@r2", "@nightly"] }, () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only (request interception of the uploads)");
  test.describe.configure({ timeout: 300_000 });

  let moto = "";
  test.beforeEach(async ({ stub }) => {
    const info = await stub.info();
    expect(info.r2, "the stub runs without --r2").toBe(true);
    moto = info.r2_endpoint!;
  });

  function file(name: string, size: number): string {
    const path = test.info().outputPath(name);
    fs.writeFileSync(path, crypto.randomBytes(size));
    return path;
  }

  const activeJobs = (page: Page) =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]") as { jobId: string; error?: string }[], ACTIVE_JOBS);

  /** Upload records of lib/chunkedUpload (IndexedDB). */
  const records = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<{ completed?: boolean; done: number[] }[]>((res) => {
          const r = indexedDB.open("cleocuts-uploads");
          r.onsuccess = () => {
            try {
              const q = r.result.transaction("uploads").objectStore("uploads").getAll();
              q.onsuccess = () => res(q.result);
            } catch {
              res([]);
            }
          };
          r.onerror = () => res([]);
        }),
    );

  async function pick(page: Page, path: string, reload = true) {
    if (reload) {
      await page.goto("/imprint");
      await page.evaluate((k) => localStorage.setItem(k, "1"), VOICE_SEEN);
      await page.goto("/app");
    }
    await expect(page.getByTestId("picker-card-tiktok")).toBeVisible({ timeout: 60_000 });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("picker-card-tiktok").click()]);
    await chooser.setFiles(path);
  }

  /** The job the upload created, or {error} of a failed card. */
  async function waitJob(page: Page, ms = 90_000): Promise<{ jobId?: string; error?: string } | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const all = await activeJobs(page);
      const real = all.find((j) => !j.jobId.startsWith("upl-"));
      if (real) return real;
      const err = all.find((j) => j.error);
      if (err) return { error: err.error };
      await page.waitForTimeout(250);
    }
    return null;
  }

  test("media routes answer 307 to presigned R2 GETs", async ({ page, stub }) => {
    const review = await stub.seed("review", { proxy: "real" });
    const done = await stub.seed("done", { clip: "grid" });
    const responses: { url: string; status: number; type: string }[] = [];
    page.on("response", (r) => responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }));

    expect((await stub.job(review.id))?.has_proxy).toBe(true);
    await openWithStorage(page, `/app?job=${review.id}`);
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("proxy");
    await expect(editorVideo(page)).toHaveAttribute("src", new RegExp(`/jobs/${review.id}/proxy-video`));
    await expect
      .poll(() => editorVideo(page).evaluate((v) => (v as HTMLVideoElement).duration), { timeout: 30_000 })
      .toBeGreaterThan(29);
    expect(
      responses.some((r) => /\/proxy-video/.test(r.url) && r.status === 307 && r.type === "media"),
      "media request: 307 from the API",
    ).toBe(true);
    expect(responses.some((r) => r.url.startsWith(moto) && /proxy\.mp4/.test(r.url) && r.status === 206)).toBe(true);
    const seeked = await editorVideo(page).evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      const ok = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      v.currentTime = 20;
      await ok;
      return v.currentTime;
    });
    expect(Math.abs(seeked - 20)).toBeLessThan(0.6);

    await openWithStorage(page, "/app/library", { [LIBRARY]: [libEntry(done.id, "done.mp4", 60_000, { outputs: ["primary", "9:16"] })] });
    const libCard = page.getByTestId("library-card").filter({ hasText: "done.mp4" });
    await expect(libCard).toBeVisible();
    const img = libCard.locator("img");
    await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(responses.some((r) => /\/thumbnail/.test(r.url) && r.status === 307)).toBe(true);
    expect(responses.some((r) => r.url.startsWith(moto) && /thumb\.jpg/.test(r.url) && r.status === 200)).toBe(true);
    const href = await libCard.getByTestId("library-download").first().getAttribute("href");
    const dl = await page.request.get(href!, { maxRedirects: 5 });
    expect(dl.status()).toBe(200);
    expect(dl.headers()["content-disposition"]).toMatch(new RegExp(`^attachment; filename="cleo_${done.id}_`));
  });

  test("a cut-off part is retried; a reload resumes with the missing parts only", async ({ page, stub }) => {
    const f40 = file("up40.mp4", 40 * MIB);
    const f60 = file("up60.mp4", 60 * MIB + 12345);
    const puts: [part: number, status: number][] = [];
    const telemetry: { event?: string; part?: number }[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/uploads/telemetry")) telemetry.push(JSON.parse(r.postData() || "{}"));
    });
    page.on("requestfinished", async (r) => {
      if (r.method() === "PUT" && r.url().startsWith(moto)) {
        const res = await r.response();
        puts.push([Number(new URL(r.url()).searchParams.get("partNumber")), res ? res.status() : 0]);
      }
    });
    page.on("requestfailed", (r) => {
      if (r.method() === "PUT" && r.url().startsWith(moto)) puts.push([Number(new URL(r.url()).searchParams.get("partNumber")), -1]);
    });

    // 1) the first try of part 2 is cut off
    let part2 = 0;
    await page.route(`${moto}/**`, async (route) => {
      const u = new URL(route.request().url());
      if (route.request().method() === "PUT" && u.searchParams.get("partNumber") === "2" && ++part2 === 1) {
        return route.abort("connectionreset");
      }
      return route.continue();
    });
    await pick(page, f40);
    let job = await waitJob(page);
    expect(job?.jobId, JSON.stringify(job)).toBeTruthy();
    const p2 = puts.filter(([n]) => n === 2);
    expect(p2).toEqual([
      [2, -1],
      [2, 200],
    ]);
    expect(new Set(puts.map(([n]) => n)).size).toBe(3); // 3 parts of 16 MiB
    expect(telemetry.some((t) => t.event === "part_retry" && t.part === 2)).toBe(true);
    const j1 = (await stub.job(job!.jobId!))!;
    expect(j1.size).toBe(40 * MIB);
    expect(j1.source_key).toMatch(/^uploads\//);
    expect(await records(page)).toHaveLength(0);
    await page.unroute(`${moto}/**`);

    // 2) reload mid-upload, pick the same file again → resume
    await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_JOBS);
    puts.length = 0;
    const held: import("@playwright/test").Route[] = [];
    await page.route(`${moto}/**`, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get("partNumber"));
      if (route.request().method() === "PUT" && n >= 3) {
        held.push(route); // parts 3 + 4 hang
        return;
      }
      return route.continue();
    });
    await pick(page, f60);
    await expect.poll(() => puts.filter(([, s]) => s === 200).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    expect(puts.filter(([, s]) => s === 200).map(([n]) => n).sort()).toEqual([1, 2]);
    expect(held.length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500); // the record is written after each part
    await page.unroute(`${moto}/**`);
    for (const r of held) r.abort().catch(() => {});
    await page.reload();
    puts.length = 0;
    // Slow the resumed parts a little, so the card can be seen.
    await page.route(`${moto}/**`, async (route) => {
      if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1500));
      return route.continue();
    });
    await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_JOBS);
    let sawResuming = false;
    const watch = setInterval(() => {
      page
        .getByText("Resuming the upload where it stopped")
        .count()
        .then((n) => {
          if (n > 0) sawResuming = true;
        })
        .catch(() => {});
    }, 100);
    await pick(page, f60);
    job = await waitJob(page);
    clearInterval(watch);
    expect(job?.jobId, JSON.stringify(job)).toBeTruthy();
    expect(puts.filter(([, s]) => s === 200).map(([n]) => n).sort()).toEqual([3, 4]);
    expect(sawResuming, 'the card said "Resuming…"').toBe(true);
    expect((await stub.job(job!.jobId!))!.size).toBe(60 * MIB + 12345);
    expect(telemetry.some((t) => t.event === "resume")).toBe(true);
  });

  test("POST /jobs after the upload: retried with backoff; the old API gets one long try", async ({ page, stub, context }) => {
    const fA = file("post20a.mp4", 20 * MIB + 1);
    const fB = file("post20b.mp4", 20 * MIB + 2);
    const fC = file("post5c.mp4", 5 * MIB);
    await context.addInitScript(() => {
      const w = window as unknown as { __posts: { timeout: number; at: number }[] };
      w.__posts = [];
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __m?: string; __u?: string }, m: string, u: string | URL, ...rest: unknown[]) {
        this.__m = m;
        this.__u = String(u);
        return (open as (...a: unknown[]) => void).call(this, m, u, ...rest);
      } as typeof XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __m?: string; __u?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
        if (this.__m === "POST" && /\/jobs$/.test(this.__u ?? "")) w.__posts.push({ timeout: this.timeout, at: Date.now() });
        return send.call(this, body);
      };
    });
    const puts: string[] = [];
    page.on("requestfinished", (r) => {
      if (r.method() === "PUT" && r.url().startsWith(moto)) puts.push(r.url());
    });
    const posts = () => page.evaluate(() => (window as unknown as { __posts: { timeout: number; at: number }[] }).__posts);

    // 1) 502, 502, then the job
    let n1 = 0;
    let recDuringFailure: { completed?: boolean }[] | null = null;
    await page.route(`${API}/jobs`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (++n1 <= 2) {
        recDuringFailure = await records(page);
        return route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" });
      }
      return route.continue();
    });
    await pick(page, fA);
    let job = await waitJob(page);
    expect(job?.jobId, JSON.stringify(job)).toBeTruthy();
    const ps1 = await posts();
    expect([n1, ps1.length]).toEqual([3, 3]);
    expect(ps1[1].at - ps1[0].at).toBeGreaterThanOrEqual(1900);
    expect(ps1[2].at - ps1[1].at).toBeGreaterThanOrEqual(3900);
    expect(ps1.every((x) => x.timeout === 120_000)).toBe(true);
    expect(recDuringFailure).toHaveLength(1);
    expect(recDuringFailure![0].completed).toBe(true);
    expect(await records(page)).toHaveLength(0);
    await page.unroute(`${API}/jobs`);

    // 2) POST /jobs never answers → reload → pick again → no re-upload
    await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_JOBS);
    let n2 = 0;
    await page.route(`${API}/jobs`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      n2++;
      return route.abort("connectionrefused");
    });
    puts.length = 0;
    await pick(page, fB);
    await expect.poll(() => n2, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const putsFirst = puts.length;
    const recs2 = await records(page);
    expect(recs2.map((r) => r.completed)).toEqual([true]);
    await page.unroute(`${API}/jobs`);
    await page.reload();
    await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_JOBS);
    puts.length = 0;
    await pick(page, fB);
    job = await waitJob(page, 60_000);
    expect(job?.jobId, JSON.stringify(job)).toBeTruthy();
    expect(putsFirst).toBeGreaterThanOrEqual(2);
    expect(puts, "nothing uploaded again").toEqual([]);
    expect((await stub.job(job!.jobId!))!.size).toBe(20 * MIB + 2);
    expect(await records(page)).toHaveLength(0);

    // 3) old API: init 404 → single PUT; POST /jobs: 30 min, one try
    await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_JOBS);
    await page.route(`${API}/uploads/multipart/init`, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' }),
    );
    let n3 = 0;
    await page.route(`${API}/jobs`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      n3++;
      return route.fulfill({ status: 502, contentType: "text/html", body: "Bad Gateway" });
    });
    puts.length = 0;
    await pick(page, fC); // a fresh page: window.__posts starts empty
    job = await waitJob(page, 60_000);
    await page.waitForTimeout(6000); // a retry would come within 2 s
    const ps3 = await posts();
    expect(puts).toHaveLength(1);
    expect(puts[0]).not.toMatch(/partNumber/);
    expect(n3).toBe(1);
    expect(ps3.map((p) => p.timeout)).toEqual([30 * 60_000]);
    expect(job?.error).toBeTruthy();
  });
});
