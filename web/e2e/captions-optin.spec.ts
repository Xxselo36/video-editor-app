/**
 * The per-browser opt-in to the v2 export captions, the web side of
 * CLEO_CAPTION_ENGINE=optin (UT4; the stub runs optin, and the render
 * request is answered here): `/app?captions=v2` once switches this
 * browser on — the editor shows a small "New captions (test)" note by the
 * export, and the export asks for the v2 captions in its request body.
 * `?captions=v1` switches it off again.
 */
import { expect, test } from "./support/fixtures";
import { openEditor } from "./support/app";
import type { Page } from "@playwright/test";

/** The render request's body (answered 409 so nothing renders). */
async function exportBody(page: Page, jobId: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  await page.route(`**/jobs/${jobId}/render`, (r) => {
    body = r.request().postDataJSON() as Record<string, unknown>;
    return r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "job not in review state", code: "not_in_review", params: {} }),
    });
  });
  await page.getByTestId("apply-render").click();
  await expect.poll(() => body).not.toBeNull();
  return body!;
}

test("?captions=v2 on /app: marker in the editor, the export asks for v2", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await page.goto("/app?captions=v2");
  await openEditor(page, job.id);
  await expect(page.getByTestId("captions-v2-marker")).toHaveText("New captions (test)");
  const body = await exportBody(page, job.id);
  expect(body.caption_engine).toBe("v2");
  expect(Array.isArray(body.subtitles)).toBe(true);
});

test("without the opt-in (or after ?captions=v1): no marker, no field", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await page.goto("/app?captions=v2");
  await page.goto("/app?captions=v1");
  await openEditor(page, job.id);
  await expect(page.getByTestId("apply-render")).toBeVisible();
  await expect(page.getByTestId("captions-v2-marker")).toHaveCount(0);
  const body = await exportBody(page, job.id);
  expect(body).not.toHaveProperty("caption_engine");
});
