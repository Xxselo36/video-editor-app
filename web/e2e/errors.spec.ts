/**
 * Honest failure messages (UX3): a job without speech, an upload without
 * a sound track (refused before the charge), an Apply that finds the job
 * already exporting (409, tech.md T3), and the dashboard headline that
 * counts ready and failed cards apart from the working ones (T7).
 */
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, card, jobCard, openEditor, openWithStorage } from "./support/app";
import type { Page } from "@playwright/test";

/** Add `patch` to every object with this job id in /jobs/status answers. */
async function patchStatus(page: Page, jobId: string, patch: Record<string, unknown>) {
  await page.route("**/jobs/status?**", async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    try {
      const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
          return o.id === jobId ? { ...o, ...patch } : o;
        }
        return v;
      };
      body = JSON.stringify(walk(JSON.parse(body)));
    } catch {
      /* 304 / not JSON: as is */
    }
    await route.fulfill({ response: res, body });
  });
}

test("no speech: the card says so, and that the minutes came back", async ({ page, stub }) => {
  const job = await stub.seed("error");
  await patchStatus(page, job.id, { error_code: "no_speech", refunded: true });
  await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "analyzing", "stumm.mov")] });
  const status = jobCard(page, "stumm.mov").getByTestId("job-card-status");
  await expect(status).toContainText("couldn't find any speech");
  await expect(status).toContainText("credited back");
  // T7: a failed card is not "in progress".
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText("1 video failed");
});

test("no speech, nothing refunded: the same honest text, no refund claim", async ({ page, stub }) => {
  const job = await stub.seed("error");
  await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "analyzing", "stumm.mov")] });
  const status = jobCard(page, "stumm.mov").getByTestId("job-card-status");
  await expect(status).toContainText("couldn't find any speech");
  await expect(status).not.toContainText("credited");
});

test("the dashboard headline counts working, ready and failed cards apart", async ({ page, stub }) => {
  const review = await stub.seed("review");
  const analyzing = await stub.seed("analyzing");
  const failed = await stub.seed("error");
  await openWithStorage(page, "/app", {
    [ACTIVE_JOBS]: [
      card(review.id, "reviewing", "fertig.mp4"),
      card(analyzing.id, "analyzing", "laeuft.mp4"),
      card(failed.id, "analyzing", "kaputt.mov"),
    ],
  });
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText("1 video in progress");
  await expect(page.getByTestId("dashboard-counts")).toHaveText("1 video ready to review · 1 video failed");
});

test("an upload without a sound track: refused with a clear message, nothing charged", async ({ page }) => {
  await openWithStorage(page, "/app");
  await page.route("**/jobs", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "no_audio" }) })
      : r.fallback(),
  );
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("picker-card-tiktok").click(),
  ]);
  await chooser.setFiles({ name: "ohne-ton.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(50_000, 1) });
  const status = jobCard(page, "ohne-ton.mp4").getByTestId("job-card-status");
  await expect(status).toContainText("no sound track");
  await expect(status).toContainText("Nothing was charged");
});

test("Apply on a job that is already exporting shows its project, no raw error", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await page.route(`**/jobs/${job.id}/render`, (r) =>
    r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "job not in review state (status=processing)", code: "not_in_review", params: {} }),
    }),
  );
  // Another tab started the export: the job is exporting.
  await page.route(`**/jobs/${job.id}`, async (r) => {
    const res = await r.fetch();
    const body = { ...(await res.json()), status: "processing", stage: "render.encode", message: "Rendering…" };
    await r.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await page.getByTestId("apply-render").click();
  await expect(page).toHaveURL(new RegExp(`/app/p/${job.id}$`));
  await expect(page.getByTestId("project")).toHaveAttribute("data-status", "processing");
  await expect(page.getByTestId("job-card")).toHaveAttribute("data-phase", "rendering");
  await expect(page.getByTestId("error-screen")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toHaveCount(0);
});

test("Apply that fails shows a mapped message, never the raw answer", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await page.route(`**/jobs/${job.id}/render`, (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "server_busy" }),
    }),
  );
  await page.getByTestId("apply-render").click();
  const screen = page.getByTestId("error-screen");
  await expect(screen).toContainText("servers are busy");
  await expect(screen).not.toContainText("detail");
});

// UX5 (§1.7 rows 2 and 4): refused before the upload finishes and before
// any charge, worded from the code — by the browser where it can tell
// (an audio file's type), else by the server's probe (the real stub).
test("an audio file and a too-short clip are refused with their own message", async ({ page, stub }) => {
  const upload = async (name: string, mimeType: string, file: "audio.m4a" | "short.mp4") => {
    await page.goto("/app/new");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("picker-card-tiktok").click(),
    ]);
    await chooser.setFiles({ name, mimeType, buffer: await stub.media(file) });
    return jobCard(page, name).getByTestId("job-card-status");
  };
  await openWithStorage(page, "/app/new");
  const audio = await upload("podcast.m4a", "audio/mp4", "audio.m4a");
  await expect(audio).toContainText("This is an audio file");
  const short = await upload("kurz.mp4", "video/mp4", "short.mp4");
  await expect(short).toContainText("shorter than 3 seconds", { timeout: 30_000 });
  await expect(short).toContainText("Nothing was charged");
});
