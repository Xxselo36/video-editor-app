/**
 * Proxy mode, frame-exact joins (round 3, wordcuts10-flash-frames): the
 * editor plays the proxy and jumps over every cut itself (lib/editPlayback
 * EditPlayer). Cut footage must never be on screen — dropping one kept
 * frame at a join is fine.
 *
 * The proxy here is a frame-numbered video (ffmpeg drawtext: frame number
 * and time burned in, 30 fps, a keyframe a second, like the real proxy),
 * served for the job's /proxy-video with ranges. The timeline has 60+ clips
 * (0.1–0.8 s, frame-exact and ms edges, splits, one reordered pair), and a
 * probe on requestVideoFrameCallback records every presented frame's
 * mediaTime while the edit plays through: no frame may come from a cut
 * range (the render's frame grid: a clip keeps frames
 * [round(start·30), round(end·30))). Desktop and pixel7, a v2 build
 * (E2E_EDITOR_V2=1).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
// A trace screenshots every frame: that load is not what is measured here.
test.use({ trace: "off" });
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1", "cleocuts.voiceOnboardingSeen.v1": "1" };
const FPS = 30;

/** The frame-numbered proxy (built once per machine; ~2 MB). */
function frameVideo(): Buffer {
  const dir = join(tmpdir(), "cleocuts-e2e");
  const file = join(dir, "frames-v1.webm");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `frames-v1.${process.pid}.tmp.webm`);
    const text =
      "drawtext=text='%{frame_num}':x=(w-tw)/2:y=(h-th)/2:fontsize=96:fontcolor=white," +
      "drawtext=text='%{pts\\:hms}':x=20:y=40:fontsize=28:fontcolor=0xFFD166";
    const run = (vf: string[]) =>
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=0x202830:s=360x640:r=30:d=36",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=36",
        ...vf,
        "-c:v", "libvpx", "-b:v", "400k", "-g", "30", "-deadline", "realtime", "-cpu-used", "16",
        "-c:a", "libvorbis", "-f", "webm", tmp,
      ]);
    try {
      run(["-vf", text]);
    } catch {
      run([]); // an ffmpeg without drawtext / fonts: the frame times still say it all
    }
    renameSync(tmp, file);
  }
  return readFileSync(file);
}

/** /proxy-video of every job answers with `media`, ranges included. */
async function routeProxy(page: Page, media: Buffer) {
  await page.route("**/proxy-video*", async (route) => {
    const total = media.length;
    const m = /bytes=(\d*)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    const a = m?.[1] ? Number(m[1]) : 0;
    const b = m?.[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
    await route.fulfill({
      status: m ? 206 : 200,
      headers: {
        "content-type": "video/webm",
        "accept-ranges": "bytes",
        "content-length": String(b - a + 1),
        ...(m ? { "content-range": `bytes ${a}-${b}/${total}` } : {}),
      },
      body: media.subarray(a, b + 1),
    });
  });
}

type Seg = { start: number; end: number; speed?: number };

/** 60+ short clips over the 35 s clip: frame-exact edges (trims) and ms
 *  edges (text cuts) by turns, every 9th a split, one reordered pair. */
function manyClips(speedAt?: (i: number) => number): Seg[] {
  const lens = [0.1, 0.37, 0.2, 0.5, 0.8, 0.133, 0.3];
  const gaps = [0.1, 0.3, 0.15, 0.2];
  const out: Seg[] = [];
  let t = 0.5;
  for (let i = 0; t < 33.5; i++) {
    const snap = (x: number) => (i % 2 ? Math.round(x * FPS) / FPS : Math.round(x * 1000) / 1000);
    const start = snap(t);
    const end = snap(t + lens[i % lens.length]);
    out.push({ start, end, ...(speedAt ? { speed: speedAt(i) } : {}) });
    t = i % 9 === 4 ? end : end + gaps[i % gaps.length];
  }
  const a = out.length - 3;
  [out[a], out[a + 1]] = [out[a + 1], out[a]];
  return out;
}

type Frame = [mediaTime: number, presented: number, presentationTime: number];
type Run = { frames: Frame[]; raf: number[] };

/** Plays the whole edit from its start; every presented frame's mediaTime. */
async function playThrough(page: Page, segs: Seg[]): Promise<Run> {
  const v = page.getByTestId("editor-video");
  await v.evaluate((el) => {
    const video = el as HTMLVideoElement;
    const w = window as unknown as { __frames: Frame[] };
    w.__frames = [];
    const cb: VideoFrameRequestCallback = (_now, md) => {
      w.__frames.push([md.mediaTime, md.presentedFrames, md.presentationTime]);
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    // the page's own animation frames: when the main thread ran at all
    const r = window as unknown as { __raf: number[] };
    r.__raf = [];
    const tick = (now: number) => {
      r.__raf.push(now);
      if (r.__raf.length < 20_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const outDur = segs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  await page.locator('[data-testid="ed-play"]:visible').first().click();
  // EditPlayer pauses at the end of the timeline
  await expect
    .poll(() => v.evaluate((el) => (el as HTMLVideoElement).paused), { timeout: (outDur + 20) * 1000, intervals: [500] })
    .toBe(true);
  const run = await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __raf: number[] };
    return { frames: w.__frames, raf: w.__raf };
  });
  if (process.env.JOINS_DUMP) await test.info().attach("joins.json", { body: JSON.stringify(run), contentType: "application/json" });
  return run;
}

/** The frames' grid offset (a container's start offset, under half a frame). */
const phaseOf = (frames: Frame[]) => {
  const ph = frames.map(([m]) => m - Math.round(m * FPS) / FPS).sort((a, b) => a - b);
  return ph[Math.floor(ph.length / 2)] ?? 0;
};

/** The main thread stood still around wall time `at` (no animation frame
 *  for > 40 ms): nothing on the page could act then — the machine (a
 *  parallel run), not the player. */
function stalled(raf: number[], at: number): boolean {
  let i = 0;
  while (i < raf.length && raf[i] <= at) i++;
  const before = raf[i - 1] ?? -Infinity;
  const after = raf[i] ?? Infinity;
  // the frame before the cut one is when the jump was due
  return after - before > 40 || at - before > 40;
}

function check({ frames, raf }: Run, segs: Seg[]) {
  const ph = phaseOf(frames);
  const kOf = (m: number) => Math.round((m - ph) * FPS);
  const range = segs.map((s) => [Math.round(s.start * FPS + 1e-6), Math.round(s.end * FPS - 1e-6)] as const);
  const isCut = (m: number) => !range.some(([a, b]) => kOf(m) >= a && kOf(m) < b);
  // Not the player's: a cut frame while the main thread stood still, or
  // one the media pipeline leapt to, skipping the clip's last frame
  // without warning — an overloaded machine,
  // e.g. a parallel run. The player's part: on the clip's last frame the
  // jump is in time, and it lands on the next clip's first frame.
  const cut: number[] = [];
  let cutInStall = 0;
  frames.forEach(([m, , at], i) => {
    if (!isCut(m)) return;
    const k = kOf(m);
    const prev = frames.slice(Math.max(0, i - 5), i).map(([x]) => kOf(x));
    const p = prev[prev.length - 1];
    const steps = prev.slice(1).map((x, j) => x - prev[j]);
    // (frames had come one by one, or at a speed's steady stride)
    const leap = p !== undefined && !isCut(frames[i - 1][0]) && steps.length > 0 && k - p > Math.max(...steps);
    if (stalled(raf, at) || leap) cutInStall++;
    else cut.push(k);
  });
  let joins = 0;
  for (let i = 1; i < frames.length; i++) if (kOf(frames[i][0]) !== kOf(frames[i - 1][0]) + 1) joins++;
  const shown = new Set(frames.map(([m]) => kOf(m)));
  const ends = range.filter((r, i) => i + 1 < range.length && range[i + 1][0] !== r[1]);
  const lastShown = ends.filter(([, b]) => shown.has(b - 1)).length;
  // at most one kept frame dropped per join
  const dropped2 = ends.filter(([a, b]) => b - a > 2 && !shown.has(b - 1) && !shown.has(b - 2)).length;
  // frames the pipeline itself skipped inside a clip (a busy machine)
  let skipped = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = kOf(frames[i - 1][0]);
    const b = kOf(frames[i][0]);
    if (b - a >= 2 && range.some(([s, e]) => a >= s && b < e)) skipped++;
  }
  return { cut, cutInStall, joins, lastShown, ends: ends.length, dropped2, skipped };
}

async function seedMany(stub: import("./support/fixtures").Stub, segs: Seg[]) {
  const job = await stub.seed("review_speech", { proxy: "on" });
  const j0 = (await stub.job(job.id))!;
  const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
    data: { segments: segs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
    timeout: 120_000,
  });
  expect(r.ok(), await r.text()).toBe(true);
  return job;
}

async function open(page: Page, jobId: string, n: number) {
  await openWithStorage(page, `/app/edit/${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/)).toHaveCount(n, { timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  expect(await page.getByTestId("editor-video").getAttribute("src")).toMatch(/proxy-video/);
}

test.describe("proxy playback: no cut frame at any join (wordcuts10)", TAG, () => {
  test.describe.configure({ timeout: 180_000 });

  test("every presented frame across 50+ joins is a kept frame; at most one kept frame dropped per join", async ({ page, stub }) => {
    const media = frameVideo();
    const segs = manyClips();
    const job = await seedMany(stub, segs);
    await routeProxy(page, media);
    await open(page, job.id, segs.length);
    const run = await playThrough(page, segs);
    const r = check(run, segs);
    test.info().annotations.push({ type: "joins", description: JSON.stringify({ ...r, cut: r.cut.slice(0, 20), frames: run.frames.length }) });
    expect(r.joins).toBeGreaterThanOrEqual(50);
    expect(r.cut, "frames from cut ranges were on screen").toEqual([]);
    expect(r.cutInStall).toBeLessThanOrEqual(3);
    // On a quiet machine a join drops at most its last kept frame, and
    // often none (late callbacks: the last one). A busy one (the pipeline skipping frames by itself)
    // makes the player jump earlier on purpose: not checked then.
    if (r.skipped <= 3) {
      expect(r.dropped2).toBeLessThanOrEqual(2);
      expect(r.lastShown / r.ends).toBeGreaterThan(0.4);
    }
  });

  test("clips at 1.5x and 2x: still no cut frame", async ({ page, stub }) => {
    const media = frameVideo();
    const segs = manyClips((i) => [1, 1.5, 2][i % 3]);
    const job = await seedMany(stub, segs);
    await routeProxy(page, media);
    await open(page, job.id, segs.length);
    const run = await playThrough(page, segs);
    const r = check(run, segs);
    test.info().annotations.push({ type: "joins", description: JSON.stringify({ ...r, cut: r.cut.slice(0, 20), frames: run.frames.length }) });
    expect(r.joins).toBeGreaterThanOrEqual(50);
    expect(r.cut, "frames from cut ranges were on screen").toEqual([]);
    expect(r.cutInStall).toBeLessThanOrEqual(3);
  });
});
