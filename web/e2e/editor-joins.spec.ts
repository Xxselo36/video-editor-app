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
 * [round(start·30), round(end·30))). A cut frame counts against the
 * player unless the page could not act (no animation frame for > 40 ms
 * while the jump was due) or the media pipeline itself leapt two or more
 * frames past its cadence (one above 1x, and a sped-up clip of two output
 * frames or less: a CPU-starved machine); those are reported and may be at
 * most two per run. A join mostly shows its clip's last kept frame (round
 * 4: the jump is asked on it; the first frames after play or a landing,
 * callbacks running late and seeks that came late go a frame early on
 * purpose; clips of 3 frames or less don't count). Desktop and pixel7, a v2 build (E2E_EDITOR_V2=1); JOINS_DUMP=1
 * attaches every frame, and when the player asked for each jump.
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

type Frame = [mediaTime: number, presented: number, presentationTime: number, expectedDisplayTime?: number, callbackAt?: number];
type Run = { frames: Frame[]; raf: number[]; seeks?: [at: number, to: number][] };

/** Plays the whole edit from its start; every presented frame's mediaTime. */
async function playThrough(page: Page, segs: Seg[]): Promise<Run> {
  const v = page.getByTestId("editor-video");
  await v.evaluate((el) => {
    const video = el as HTMLVideoElement;
    const w = window as unknown as { __frames: Frame[] };
    w.__frames = [];
    const cb: VideoFrameRequestCallback = (now, md) => {
      w.__frames.push([md.mediaTime, md.presentedFrames, md.presentationTime, md.expectedDisplayTime, now]);
      video.requestVideoFrameCallback(cb);
    };
    // the jumps (seeks) the player made: when it asked, and to where
    const sk = window as unknown as { __seeks: [number, number][] };
    sk.__seeks = [];
    const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get() {
        return ct.get!.call(this);
      },
      set(x: number) {
        sk.__seeks.push([performance.now(), x]);
        ct.set!.call(this, x);
      },
    });
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
    const w = window as unknown as { __frames: Frame[]; __raf: number[]; __seeks: [number, number][] };
    return { frames: w.__frames, raf: w.__raf, seeks: w.__seeks };
  });
  if (process.env.JOINS_DUMP) await test.info().attach("joins.json", { body: JSON.stringify(run), contentType: "application/json" });
  return run;
}

/** The frames' grid offset (a container's start offset, under half a frame). */
const phaseOf = (frames: Frame[]) => {
  const ph = frames.map(([m]) => m - Math.round(m * FPS) / FPS).sort((a, b) => a - b);
  return ph[Math.floor(ph.length / 2)] ?? 0;
};

/** The main thread stood still (no animation frame for over 40 ms) in
 *  the refreshes before wall time `at`, while the jump away from a frame
 *  shown at `at` was due: nothing on the page could act then — the
 *  machine (a parallel run), not the player. */
function stalled(raf: number[], at: number): boolean {
  let prev = -Infinity;
  for (const t of raf) {
    if (t > at) return at - prev > 40;
    if (t - prev > 40 && t > at - 70) return true;
    prev = t;
  }
  return at - prev > 40;
}

/** `leapBy`: how many frames past the steps before it a frame must come to
 *  count as the pipeline's leap (2 at 1x; above 1x, where the time-stretched
 *  clock moves in uneven steps, 1). */
function check({ frames, raf }: Run, segs: Seg[], leapBy = 2) {
  const ph = phaseOf(frames);
  const kOf = (m: number) => Math.round((m - ph) * FPS);
  const range = segs.map((s) => [Math.round(s.start * FPS + 1e-6), Math.round(s.end * FPS - 1e-6)] as const);
  const isCut = (m: number) => !range.some(([a, b]) => kOf(m) >= a && kOf(m) < b);
  // A cut frame is the player's unless the main thread stood still when
  // the jump was due, or the media pipeline leapt: the frame came two or
  // more frames further on than any step of the few frames before it, the
  // ones between never shown (a CPU-starved machine — a parallel run — at
  // a speed above 1: the time-stretched clock catching up in a jump).
  // Above 1x a clip of two output frames or less (a 0.13 s clip at 2x)
  // is over before a landing's clock has settled on a starved machine:
  // counted with those, never at 1x.
  const cut: number[] = [];
  let cutInStall = 0;
  let cutShort = 0;
  frames.forEach(([m, , at], i) => {
    if (!isCut(m)) return;
    const k = kOf(m);
    const prev = frames.slice(Math.max(0, i - 6), i).map(([x]) => kOf(x));
    const steps = prev.slice(1).map((x, j) => x - prev[j]).filter((d) => d >= 1 && d <= 8);
    const p = prev[prev.length - 1];
    const leap = p !== undefined && !isCut(frames[i - 1][0]) && steps.length >= 3 && k - p >= Math.max(...steps) + leapBy;
    const from = p === undefined ? -1 : range.findIndex(([a, b]) => p >= a && p < b);
    const speed = from >= 0 ? (segs[from].speed ?? 1) : 1;
    const short = from >= 0 && speed > 1 && (range[from][1] - range[from][0]) / speed <= 2;
    if (stalled(raf, at) || leap) cutInStall++;
    else if (short) cutShort++;
    else cut.push(k);
  });
  let joins = 0;
  for (let i = 1; i < frames.length; i++) if (kOf(frames[i][0]) !== kOf(frames[i - 1][0]) + 1) joins++;
  const shown = new Set(frames.map(([m]) => kOf(m)));
  // clip ends that jump (not a split, not the timeline's end): how many of
  // their last kept frames never showed
  const ends = range.filter((r, i) => i + 1 < range.length && range[i + 1][0] !== r[1]);
  const dropsAt = ends.map(([a, b]) => {
    let n = 0;
    for (let k = b - 1; k >= a && !shown.has(k); k--) n++;
    return n;
  });
  // (a clip of 3 frames or less ends on a landing's first frames, where
  // the player jumps a frame early on purpose: its last frame may go)
  const longer = dropsAt.filter((_, i) => ends[i][1] - ends[i][0] > 3);
  const lastShown = longer.filter((n) => n === 0).length;
  const dropped2 = dropsAt.filter((n, i) => n >= 2 && ends[i][1] - ends[i][0] > 2).length;
  // frames the pipeline itself skipped inside a clip (a busy machine)
  let skipped = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = kOf(frames[i - 1][0]);
    const b = kOf(frames[i][0]);
    if (b - a >= 2 && range.some(([s, e]) => a >= s && b < e)) skipped++;
  }
  return { cut, cutInStall, cutShort, joins, lastShown, ends: longer.length, dropped2, skipped };
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
    expect(r.cutShort).toBe(0);
    expect(r.cutInStall).toBeLessThanOrEqual(2);
    // A join drops at most its last kept frame, and mostly none. A busy
    // machine (the pipeline skipping frames by itself) makes the player
    // jump a frame earlier on purpose: a little slack then.
    expect(r.dropped2).toBeLessThanOrEqual(r.skipped <= 3 ? 1 : Math.max(4, Math.ceil(r.skipped / 2)));
    expect(r.lastShown / r.ends).toBeGreaterThan(r.skipped <= 3 ? 0.75 : 0.5);
  });

  test("clips at 1.5x and 2x: still no cut frame", async ({ page, stub }) => {
    const media = frameVideo();
    const segs = manyClips((i) => [1, 1.5, 2][i % 3]);
    const job = await seedMany(stub, segs);
    await routeProxy(page, media);
    await open(page, job.id, segs.length);
    const run = await playThrough(page, segs);
    const r = check(run, segs, 1);
    test.info().annotations.push({ type: "joins", description: JSON.stringify({ ...r, cut: r.cut.slice(0, 20), frames: run.frames.length }) });
    expect(r.joins).toBeGreaterThanOrEqual(50);
    expect(r.cut, "frames from cut ranges were on screen").toEqual([]);
    expect(r.cutInStall + r.cutShort).toBeLessThanOrEqual(2);
  });
});
