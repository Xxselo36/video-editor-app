/**
 * Signed-in flows with test auth (run with E2E_MODE=auth: the web built
 * with NEXT_PUBLIC_AUTH_TEST=1, the stub with CLEO_AUTH_TEST=1). The app
 * runs as with accounts on — sign-in gate, per-user projects from the
 * server, media URLs with the user's token — only the Clerk part is
 * replaced by a test-user picker, and API calls carry X-Test-User.
 */
import { expect, signedIn, test } from "./support/fixtures";
import { API } from "./support/env";
import { clips, deleteClip, editorVideo, jobCard, openFromDashboard, SAVED, waitForMetadata } from "./support/app";

test.describe("accounts on (test auth)", { tag: "@auth" }, () => {
  test("signed out, /app asks to sign in and comes back after it", async ({ page }) => {
    await page.goto("/imprint");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/, { timeout: 30_000 });
    await page.getByTestId("mock-user-test_pro").click();
    // Back in the app: /app, or /app/new straight away — a user with no
    // projects yet is sent on to the start screen, and that redirect can
    // land before this assertion polls.
    await expect(page).toHaveURL(/\/app(\/new)?$/);
    await expect(page.getByTestId("mock-user-name")).toHaveText("test_pro");
  });

  test("a signed-in user opens and edits their own project", async ({ page, stub }) => {
    const user = await signedIn(page, { plan: "pro" });
    const job = await stub.seed("review", { owner: user.id, filename: "mine.mp4" });
    const sent = new Set<string>();
    page.on("request", (r) => {
      const h = r.headers()["x-test-user"];
      if (r.url().startsWith(API) && h) sent.add(h);
    });

    await page.goto("/app");
    // The card comes from the server's project list (GET /jobs).
    await expect(jobCard(page, "mine.mp4")).toBeVisible({ timeout: 30_000 });
    await openFromDashboard(page, "mine.mp4");
    // <video> can't send headers: its URL carries the user's media token.
    await expect(editorVideo(page)).toHaveAttribute("src", /[?&]t=/);
    await waitForMetadata(page);
    await expect(clips(page)).toHaveCount(4);

    await deleteClip(page, 1);
    await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
      [0, 6],
      [15, 22],
      [23, 30],
    ]);
    expect([...sent]).toEqual([user.header]);
    expect((await stub.job(job.id))?.owner_id).toBe(user.id);
  });

  test("another user's project stays hidden", async ({ page, stub }) => {
    await signedIn(page);
    const theirs = await stub.seed("review", { owner: "someone_else", filename: "theirs.mp4" });
    await page.goto(`/app/edit/${theirs.id}`);
    // Not theirs to see: the same answer as a project that doesn't exist.
    await expect(page.getByTestId("error-screen")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("editor")).toHaveCount(0);
    await expect(jobCard(page, "theirs.mp4")).toHaveCount(0);
    expect((await stub.job(theirs.id))?.owner_id).toBe("someone_else");
  });

  test("signing out ends the session", async ({ page }) => {
    await signedIn(page);
    await page.goto("/app");
    await page.getByTestId("mock-sign-out").click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/, { timeout: 30_000 });
  });
});
