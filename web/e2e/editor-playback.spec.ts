/**
 * Editor playback (scratchpad wp5/wp5play, wp5edit, wp5mobile, wp5mode,
 * wp5save): with a proxy the editor plays the whole source and follows
 * the edit list itself (lib/editPlayback) — cuts are skipped, reordered
 * clips play in timeline order, speed / volume / fades per clip — and
 * nothing waits for the server's preview rebuild. Without one it plays
 * the server-built preview. Grid clip: four clips [0,6] [7,14] [15,22]
 * [23,30].
 */
import { expect, test } from "./support/fixtures";
import {
  ACTIVE_JOBS,
  card,
  clip,
  clips,
  deleteClip,
  editorVideo,
  horizontalOverflow,
  jobCard,
  openEditor,
  openFromDashboard,
  openWithStorage,
  pause,
  play,
  playbackMode,
  SAVED,
  selectClip,
  setRange,
  userSeek,
  videoPaused,
  videoTime,
  waitForMetadata,
} from "./support/app";
import type { Page, Request } from "@playwright/test";

type Sample = [wall: number, t: number, paused: boolean, rate: number, volume: number, muted: boolean];

/** Record [wall ms, currentTime, paused, rate, volume, muted] every frame. */
async function startSampler(page: Page) {
  await editorVideo(page).evaluate((el) => {
    const v = el as HTMLVideoElement;
    const w = window as unknown as { __s: Sample[] };
    w.__s = [];
    const f = () => {
      w.__s.push([performance.now(), v.currentTime, v.paused, v.playbackRate, v.volume, v.muted]);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}
const now = (page: Page) => page.evaluate(() => performance.now());
/** Samples since `from` while playing. */
const samples = async (page: Page, from: number): Promise<Sample[]> =>
  (await page.evaluate(() => (window as unknown as { __s: Sample[] }).__s)).filter((s) => s[0] >= from && !s[2]);

async function seekAndPlay(page: Page, t: number) {
  await userSeek(page, t);
  await play(page);
}

/** Wait (every frame) until lo < currentTime < hi. */
const untilTime = (page: Page, lo: number, hi = 1e9, timeout = 8000) =>
  page.waitForFunction(
    ([lo, hi]) => {
      const v = document.querySelector('[data-testid="editor-video"]') as HTMLVideoElement;
      return v.currentTime > lo && v.currentTime < hi;
    },
    [lo, hi],
    { timeout, polling: "raf" },
  );

async function proxyEditor(page: Page, jobId: string) {
  await openEditor(page, jobId);
  await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("proxy");
  await waitForMetadata(page);
}

test.describe("proxy playback follows the edit list", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.use.isMobile === true, "desktop playback suite (the phone one is below)");
  });

  test("cuts, captions, reorder, speed, volume, fades, ruler, end of timeline", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "probe" });
    const requests: { url: string; type: string; range?: string }[] = [];
    page.on("request", (r) => requests.push({ url: r.url(), type: r.resourceType(), range: r.headers()["range"] }));
    await openEditor(page, job.id);
    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).not.toBe("probing");

    await test.step("the probe finds the proxy; one <video> plays it", async () => {
      expect(await playbackMode(page)).toBe("proxy");
      await expect(editorVideo(page)).toHaveAttribute("src", /\/proxy-video/);
      const probes = requests.filter((r) => /proxy-video/.test(r.url) && r.type === "fetch");
      expect(probes.some((r) => r.range === "bytes=0-1")).toBe(true);
      await expect(page.locator("video")).toHaveCount(1);
    });
    await waitForMetadata(page);
    await startSampler(page);

    await test.step("playback crosses the cut 6–7 without showing it", async () => {
      const w0 = await now(page);
      await seekAndPlay(page, 5.5);
      await untilTime(page, 7.6);
      await pause(page);
      const ss = await samples(page, w0);
      const before = ss.filter((s) => s[1] < 6.0).pop();
      const after = ss.find((s) => s[1] >= 7.0);
      expect(ss.filter((s) => s[1] > 6.02 && s[1] < 6.98)).toEqual([]);
      expect(before && after).toBeTruthy();
      expect(before![1]).toBeGreaterThan(5.9); // the jump starts at most ~1 frame early
      expect(after![0] - before![0]).toBeLessThan(400);
    });

    await test.step("the caption preview follows source time", async () => {
      await seekAndPlay(page, 8.0);
      await expect(page.getByTestId("caption-overlay")).toContainText("Satz 2 hier.");
      await pause(page);
    });

    await test.step("reorder: clip 1 moved right plays after [7,14]", async () => {
      await selectClip(page, 0);
      await page.getByTestId("clip-move-right").click();
      await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
        [7, 14],
        [0, 6],
        [15, 22],
        [23, 30],
      ]);
      let w0 = await now(page);
      await seekAndPlay(page, 13.5);
      await untilTime(page, 0.3, 5);
      await page.waitForTimeout(200);
      await pause(page);
      let ss = await samples(page, w0);
      expect(ss.find((s) => s[1] < 6)?.[1]).toBeLessThan(0.5);
      expect(ss.filter((s) => s[1] >= 14.05)).toEqual([]);
      // The timeline readout: clip 2 starts at 7 s on the timeline.
      const readout = await page.getByTestId("timeline-timecode").innerText();
      const tNow = await videoTime(page);
      expect(Math.abs(parseFloat(readout.split(":")[1]) - (7 + tNow))).toBeLessThan(0.35);
      // …and after [0,6] comes [15,22], not 7.
      w0 = await now(page);
      await seekAndPlay(page, 5.6);
      await untilTime(page, 15.3);
      await pause(page);
      ss = await samples(page, w0);
      expect(ss.filter((s) => s[1] > 6.02 && s[1] < 14.98)).toEqual([]);
    });

    await test.step("speed 2× on [0,6] (now clip 2), 1× again in the next clip", async () => {
      await selectClip(page, 1);
      await page.getByTestId("clip-speed").selectOption("2");
      await page.waitForTimeout(300);
      let w0 = await now(page);
      await seekAndPlay(page, 1.0);
      await page.waitForTimeout(1000);
      await pause(page);
      let ss = await samples(page, w0);
      const last = ss[ss.length - 1];
      expect(last[3]).toBe(2);
      const adv = (last[1] - ss[0][1]) / ((last[0] - ss[0][0]) / 1000);
      expect(adv).toBeGreaterThan(1.7);
      expect(adv).toBeLessThan(2.3);
      w0 = await now(page);
      await seekAndPlay(page, 5.5);
      await untilTime(page, 15.4);
      await pause(page);
      ss = await samples(page, w0);
      expect(ss[ss.length - 1][3]).toBe(1);
      // The native speed menu is hidden in proxy mode; a rate set from
      // outside during the 2× clip is the master speed ("Normal" = 1×).
      await expect(editorVideo(page)).toHaveAttribute("controlslist", "noplaybackrate");
      await seekAndPlay(page, 1.0);
      await page.waitForTimeout(300);
      await editorVideo(page).evaluate((v) => {
        (v as HTMLVideoElement).playbackRate = 1;
      });
      await untilTime(page, 15.4);
      await page.waitForTimeout(300);
      expect(await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).playbackRate)).toBe(1);
      await pause(page);
    });

    await test.step("volume 50 % with a 1 s fade-in on [15,22]; a muted clip mutes only itself", async () => {
      await selectClip(page, 2);
      await setRange(page.getByTestId("clip-volume"), 0.5);
      await setRange(page.getByTestId("clip-fade-in"), 1);
      await page.waitForTimeout(300);
      const w0 = await now(page);
      await seekAndPlay(page, 15.0);
      await page.waitForTimeout(1600);
      await pause(page);
      const ss = await samples(page, w0);
      const eff = (s: Sample) => (s[5] ? 0 : s[4]);
      const early = ss.filter((s) => s[1] >= 15 && s[1] < 15.2);
      const mid = ss.filter((s) => s[1] > 15.4 && s[1] < 15.6);
      const late = ss.filter((s) => s[1] > 16.1);
      expect(early.length && mid.length && late.length).toBeTruthy();
      expect(eff(early[0])).toBeLessThan(0.1);
      expect(eff(mid[0])).toBeGreaterThan(0.15);
      expect(eff(mid[0])).toBeLessThan(0.4);
      expect(Math.abs(late[late.length - 1][4] - 0.5)).toBeLessThan(0.03);
      expect(late[late.length - 1][5]).toBe(false);

      await setRange(page.getByTestId("clip-volume"), 0);
      await page.waitForTimeout(300);
      await seekAndPlay(page, 17.0);
      await page.waitForTimeout(300);
      const mutedIn = await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).muted);
      await seekAndPlay(page, 24.0);
      await page.waitForTimeout(300);
      const mutedOut = await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).muted);
      await pause(page);
      expect([mutedIn, mutedOut]).toEqual([true, false]);
    });

    await test.step("a ruler click maps timeline time to clip + source time", async () => {
      await page.getByTestId("timeline-scroll").evaluate((el) => {
        el.scrollLeft = 0;
      });
      const bb = (await page.getByTestId("timeline-ruler").boundingBox())!;
      // Timeline: [7,14] [0,6] [15,22] [23,30] = 27 s; 3.0 s → source 10.0.
      await page.mouse.click(bb.x + (3.0 / 27) * bb.width, bb.y + bb.height / 2);
      await page.waitForTimeout(400);
      expect(Math.abs((await videoTime(page)) - 10.0)).toBeLessThan(0.15);
    });

    await test.step("the end of the timeline stops; play again starts at clip 1", async () => {
      await seekAndPlay(page, 29.5);
      await expect.poll(() => videoPaused(page), { timeout: 5000 }).toBe(true);
      expect(await videoTime(page)).toBeGreaterThan(29.8);
      await play(page);
      await page.waitForTimeout(300);
      const t = await videoTime(page);
      await pause(page);
      expect(t).toBeGreaterThanOrEqual(7);
      expect(t).toBeLessThan(7.6);
    });

    await test.step("proxy mode never reloads previews", async () => {
      // has_proxy not reported: the first preview may load while probing
      // (one URL, possibly in several range requests) — but never a
      // rebuilt one (?v=2 after the reorder's save).
      const previews = new Set(requests.filter((r) => /preview-video/.test(r.url)).map((r) => r.url));
      expect([...previews].length, [...previews].join(" ")).toBeLessThanOrEqual(1);
      await expect(page.getByTestId("preview-updating")).toHaveCount(0);
    });
  });

  test("editing while it plays: scrub, split, delete, trim, transcript jump, undo", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "probe" });
    await proxyEditor(page, job.id);
    await editorVideo(page).evaluate((el) => {
      const v = el as HTMLVideoElement;
      const w = window as unknown as { __seeks: number };
      w.__seeks = 0;
      v.addEventListener("seeking", () => w.__seeks++);
    });
    const seeks = () => page.evaluate(() => (window as unknown as { __seeks: number }).__seeks);

    await test.step("a native scrub into the cut 14–15 snaps to the next clip", async () => {
      await userSeek(page, 14.5);
      await page.waitForTimeout(300);
      expect(Math.abs((await videoTime(page)) - 15)).toBeLessThan(0.05);
    });

    await test.step("split while playing: no seek, keeps playing", async () => {
      await userSeek(page, 8.0);
      await play(page);
      await page.waitForTimeout(700);
      const s0 = await seeks();
      await page.getByTestId("timeline-split").click();
      await page.waitForTimeout(700);
      await expect(clips(page)).toHaveCount(5);
      expect(await seeks()).toBe(s0);
      expect(await videoPaused(page)).toBe(false);
      expect(await videoTime(page)).toBeGreaterThan(8.9);
      await pause(page);
    });

    await test.step("deleting the playing clip continues with the next one", async () => {
      // [0,6] [7,~8.7] [~8.7,14] [15,22] [23,30]: play in clip 3, delete it.
      await userSeek(page, 10.0);
      await selectClip(page, 2); // selecting seeks to its start
      await userSeek(page, 10.0);
      await play(page);
      await page.waitForTimeout(300);
      await page.getByTestId("clip-delete").click();
      await page.waitForTimeout(600);
      const t = await videoTime(page);
      expect(t).toBeGreaterThanOrEqual(15);
      expect(t).toBeLessThan(16.5);
      expect(await videoPaused(page)).toBe(false);
      await pause(page);
    });

    await test.step("trimming the start past the playhead moves it to the new start", async () => {
      // [0,6] [7,~8.7] [15,22] [23,30]: at 15.2 in clip 3, drag its start right.
      await userSeek(page, 15.2);
      await selectClip(page, 2);
      await userSeek(page, 15.2);
      const bb = (await clip(page, 2).getByTestId("clip-trim-start").boundingBox())!;
      const y = bb.y + bb.height / 2;
      await page.mouse.move(bb.x + bb.width / 2, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width / 2 + i * 8, y);
      await page.mouse.up();
      await page.waitForTimeout(500);
      const t = await videoTime(page);
      await expect.poll(async () => (await stub.timeline(job.id))[2]?.[0], SAVED).toBeGreaterThan(15.3);
      const start = (await stub.timeline(job.id))[2][0];
      expect(Math.abs(t - start)).toBeLessThan(0.05);
    });

    await test.step("a transcript line jumps there and plays", async () => {
      await page.getByTestId("editor-tab-transcript").click();
      await page.getByTestId("transcript-line").nth(3).getByTestId("transcript-seek").click();
      await page.waitForTimeout(500);
      const t = await videoTime(page);
      expect(t).toBeGreaterThanOrEqual(23.5);
      expect(t).toBeLessThan(24.5);
      expect(await videoPaused(page)).toBe(false);
      await pause(page);
      await page.getByTestId("editor-tab-timeline").click();
    });

    await test.step("undo works in proxy mode", async () => {
      const n = await clips(page).count();
      const before = await stub.timeline(job.id);
      await page.getByTestId("timeline-undo").click();
      await expect(clips(page)).toHaveCount(n);
      await expect.poll(() => stub.timeline(job.id), SAVED).not.toEqual(before);
    });
  });
});

test("phone: cuts are skipped, a ruler tap seeks, no overflow", async ({ page, stub }, info) => {
  test.skip(info.project.use.isMobile !== true, "phone suite");
  const job = await stub.seed("review", { proxy: "probe" });
  await proxyEditor(page, job.id);
  await startSampler(page);
  const w0 = await now(page);
  await seekAndPlay(page, 13.4);
  await untilTime(page, 15.5);
  await pause(page);
  const inCut = (await samples(page, w0)).filter((s) => s[1] > 14.02 && s[1] < 14.98);
  expect(inCut).toEqual([]);

  await page.getByTestId("timeline-scroll").evaluate((el) => {
    el.scrollLeft = 0;
  });
  const r = (await page.getByTestId("timeline-ruler").boundingBox())!;
  // Timeline 6.2 s = 0.2 s into clip 2 = source 7.2 (27 s in all).
  await page.touchscreen.tap(r.x + (6.2 / 27) * r.width, r.y + r.height / 2);
  await page.waitForTimeout(400);
  expect(Math.abs((await videoTime(page)) - 7.2)).toBeLessThan(0.2);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test.describe("how the editor picks proxy or preview", () => {
  const collect = (page: Page) => {
    const reqs: { url: string; type: string; range?: string }[] = [];
    const statuses: number[] = [];
    page.on("request", (r: Request) => reqs.push({ url: r.url(), type: r.resourceType(), range: r.headers()["range"] }));
    page.on("response", (r) => {
      if (/proxy-video/.test(r.url())) statuses.push(r.status());
    });
    return { reqs, statuses };
  };
  const probes = (reqs: { url: string; type: string; range?: string }[]) =>
    reqs.filter((r) => /proxy-video/.test(r.url) && r.type === "fetch");

  test("has_proxy: true → proxy at once, no probe", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "on" });
    const { reqs } = collect(page);
    await openEditor(page, job.id);
    await expect.poll(() => playbackMode(page)).toBe("proxy");
    await page.waitForTimeout(1500);
    expect(probes(reqs)).toEqual([]);
    expect(reqs.some((r) => /proxy-video/.test(r.url) && r.type === "media")).toBe(true);
  });

  test("a proxy that fails to load falls back to the preview", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "on" });
    await page.route("**/proxy-video*", (r) =>
      r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' }),
    );
    await openEditor(page, job.id);
    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("preview");
    await expect(editorVideo(page)).toHaveAttribute("src", /preview-video\?v=\d+/);
  });

  test("no proxy route (older backend): the preview loads while probing, rebuilds swap in", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "probe-none" });
    const { reqs, statuses } = collect(page);
    // Delay the probe, so "preview src set before the probe answers" shows.
    await page.route("**/proxy-video*", async (r) => {
      await new Promise((res) => setTimeout(res, 800));
      await r.continue();
    });
    await page.goto(`/app?job=${job.id}`);
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    const early = [await playbackMode(page), (await editorVideo(page).getAttribute("src")) ?? ""];
    expect(early[0]).toBe("probing");
    expect(early[1]).toMatch(/preview-video/);
    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("preview");
    expect(probes(reqs).length).toBeGreaterThanOrEqual(1);
    expect(probes(reqs).every((r) => r.range === "bytes=0-1")).toBe(true);
    expect(statuses.every((s) => s === 404)).toBe(true);
    expect(reqs.some((r) => /proxy-video/.test(r.url) && r.type === "media")).toBe(false);
    await expectRebuildSwapsIn(page, stub, job.id);
  });

  test("has_proxy: false → preview at once, no probe", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "off" });
    const { reqs } = collect(page);
    await page.goto(`/app?job=${job.id}`);
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    expect(await playbackMode(page)).toBe("preview");
    await expect(editorVideo(page)).toHaveAttribute("src", /preview-video\?v=\d+/);
    await page.waitForTimeout(1000);
    expect(probes(reqs)).toEqual([]);
    await expectRebuildSwapsIn(page, stub, job.id);
  });

  async function expectRebuildSwapsIn(page: Page, stub: import("./support/fixtures").Stub, jobId: string) {
    const v0 = (await stub.job(jobId))!.preview_version;
    await deleteClip(page, 1);
    await expect.poll(async () => (await stub.job(jobId))!.preview_version, SAVED).toBeGreaterThan(v0);
    const { preview_version } = (await stub.job(jobId))!;
    await expect(editorVideo(page)).toHaveAttribute("src", new RegExp(`\\?v=${preview_version}$`), {
      timeout: 15_000,
    });
  }
});

test.describe("proxy mode never waits for the preview rebuild", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.use.isMobile === true, "timing suite: desktop only");
  });

  async function setup(page: Page, stub: import("./support/fixtures").Stub) {
    // Every /edit-segments answers only after a 6 s rebuild.
    const job = await stub.seed("review", { proxy: "probe", slow_rebuild: 6 });
    const saves: number[] = [];
    let renderAt = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/render")) renderAt = Date.now();
      if (r.method() === "POST" && r.url().endsWith("/edit-segments")) saves.push(Date.now());
    });
    await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "test.mp4")] });
    await openFromDashboard(page, "test.mp4");
    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("proxy");
    return { job, saves, renderAt: () => renderAt };
  }

  test("leave and reopen, then render, while an autosave waits for its rebuild", async ({ page, stub }) => {
    const { job, saves, renderAt } = await setup(page, stub);
    await deleteClip(page, 1);
    await page.waitForTimeout(1200); // the debounce fired; the rebuild takes 6 s
    expect(saves).toHaveLength(1);
    await page.getByTestId("editor-back").click();
    await expect(page.getByTestId("dashboard")).toBeVisible();
    const t0 = Date.now();
    await jobCard(page, "test.mp4").click();
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    expect(Date.now() - t0, "reopen waited for the rebuild").toBeLessThan(3000);
    await expect(clips(page)).toHaveCount(3);

    await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe("proxy");
    await deleteClip(page, 0);
    await page.waitForTimeout(1200); // autosave 2 on the wire
    const before = saves.length;
    const t1 = Date.now();
    await page.getByTestId("apply-render").click();
    await expect.poll(renderAt, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(renderAt() - t1, "render waited for the rebuild").toBeLessThan(2000);
    expect(saves.length, "Apply sent a duplicate save").toBe(before);
    await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
      [15, 22],
      [23, 30],
    ]);
  });

  test("Apply right after an edit sends the save itself, once", async ({ page, stub }) => {
    const { job, saves, renderAt } = await setup(page, stub);
    await deleteClip(page, 1);
    await page.waitForTimeout(150); // inside the 800 ms debounce
    const t1 = Date.now();
    await page.getByTestId("apply-render").click();
    await expect.poll(renderAt, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(renderAt() - t1).toBeLessThan(2000);
    expect(saves).toHaveLength(1);
    await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
      [0, 6],
      [15, 22],
      [23, 30],
    ]);
  });
});
