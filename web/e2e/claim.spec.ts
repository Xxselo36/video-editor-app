/**
 * Claim on sign-up (UX12, review F2; E2E_MODE=auth): projects this
 * browser made anonymously (the beta kept their ids in localStorage)
 * become the account's after signing in, and show up in Projects; an id
 * that belongs to another account is dropped from the device's list.
 * The Projects page is on the v2 opt-in (UX12 gate): opted in here.
 */
import { expect, signedIn, test } from "./support/fixtures";
import { API } from "./support/env";
import { job, jobCard, JOBS, libEntry, LIBRARY, readStorage, type StoredJob } from "./support/app";

test.describe("claim after sign-in", { tag: "@auth" }, () => {
  test("anonymous projects join the account; another user's is dropped", async ({ page, stub }) => {
    // Made while signed out: no owner (the anonymous beta).
    const mine = await stub.seed("review", { filename: "anonym.mp4" });
    const older = await stub.seed("done", { filename: "alt.mp4" });
    // On this device too, but another account's (a shared computer).
    const theirs = await stub.seed("review", { owner: "someone_else", filename: "fremd.mp4" });
    const user = await signedIn(page, { plan: "pro" });
    await page.evaluate(
      ([kJobs, jobs, kLib, lib]) => {
        localStorage.setItem(kJobs, jobs);
        localStorage.setItem(kLib, lib);
        localStorage.setItem("cleocuts.editor.version.v1", "v2");
      },
      [
        JOBS,
        JSON.stringify([job(mine.id, "anonym.mp4"), job(theirs.id, "fremd.mp4", 90_000)]),
        LIBRARY,
        JSON.stringify([libEntry(older.id, "alt.mp4", 3_600_000)]),
      ] as const,
    );
    const claims: unknown[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url() === `${API}/me/claim`) claims.push(r.postDataJSON());
    });

    await page.goto("/app");
    await expect(jobCard(page, "anonym.mp4")).toBeVisible({ timeout: 30_000 });
    await expect(jobCard(page, "alt.mp4")).toBeVisible();
    await expect.poll(async () => (await stub.job(mine.id))?.owner_id).toBe(user.id);
    expect((await stub.job(older.id))?.owner_id).toBe(user.id);
    expect((await stub.job(theirs.id))?.owner_id).toBe("someone_else");
    await expect(jobCard(page, "fremd.mp4")).toHaveCount(0);
    await expect
      .poll(async () => ((await readStorage<StoredJob[]>(page, `${JOBS}:${user.id}`)) ?? []).map((j) => j.jobId).sort())
      .toEqual([mine.id, older.id].sort());
    // The anonymous list moved to the account's (the next user of this
    // computer doesn't get it).
    expect(await readStorage(page, JOBS)).toBeNull();
    expect(claims).toHaveLength(1);
    expect((claims[0] as { job_ids: string[] }).job_ids.sort()).toEqual([mine.id, older.id, theirs.id].sort());

    // Claimed once: a reload lists them from the account, without a claim.
    await page.reload();
    await expect(jobCard(page, "anonym.mp4")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    expect(claims).toHaveLength(1);
    // Another device of the same account: the server's list.
    const other = await page.context().browser()!.newContext({ baseURL: page.url().replace(/\/app.*$/, "") });
    const p2 = await other.newPage();
    await signedIn(p2, { plan: "pro", id: user.id });
    await p2.goto("/app?editor=v2");
    await expect(jobCard(p2, "anonym.mp4")).toBeVisible({ timeout: 30_000 });
    await expect(jobCard(p2, "fremd.mp4")).toHaveCount(0);
    await other.close();
  });
});
