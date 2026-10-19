import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { TimelineSeg } from "@/lib/editSave";
import { TimelineSaver, timelinePayload, type TimelineBackup, type TimelineSaveState } from "./timelineSave";

type Body = { segments: TimelineSeg[]; base_rev: number; rev: number; keepalive: boolean };

/**
 * A fake backend with /edit-segments' revision rule: base_rev must be the
 * stored rev, rev newer (409 stale_rev {rev}); the timeline is stored at
 * once, the answer comes after `rebuildMs` (the preview re-encode).
 * GET /jobs/{id} shows edit_rev.
 */
function server() {
  const srv = {
    rev: 0,
    segs: null as TimelineSeg[] | null,
    posts: [] as Body[],
    gets: 0,
    rebuildMs: 0,
    /** ms before a POST reaches the store (a busy server). */
    storeMs: 0,
    /** Per request (in order), instead of storeMs. */
    storeDelays: [] as number[],
    fail: [] as ("net" | "lost" | 500)[],
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (path: string, init: RequestInit & { unloading?: boolean } = {}): Promise<Response> => {
    if (init.method !== "POST") {
      srv.gets++;
      return json(200, { edit_rev: srv.rev, status: "awaiting_review", edit_segments: srv.segs });
    }
    const body = JSON.parse(String(init.body)) as Body;
    srv.posts.push({ ...body, keepalive: !!init.keepalive });
    const f = srv.fail.shift();
    if (f === "net") throw new TypeError("offline");
    const wait = srv.storeDelays.length ? srv.storeDelays.shift()! : srv.storeMs;
    if (wait) await sleep(wait);
    if (body.base_rev !== srv.rev || body.rev <= srv.rev) return json(409, { detail: "stale_rev", rev: srv.rev });
    srv.rev = body.rev;
    srv.segs = body.segments;
    if (f === "lost") throw new TypeError("connection reset");
    if (f === 500) return json(500, { detail: "rebuild" });
    if (srv.rebuildMs) await sleep(srv.rebuildMs);
    return json(200, { edit_rev: body.rev, preview_ok: true, preview_segments: body.segments.map((s) => [s.start, s.end]) });
  };
  return { srv, fetch };
}

const clip = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });
const tl = (end: number): EditorSeg[] => [clip("a", 0, 5), clip("b", 6, end)];

function saverOf(rev = 100, opts: { known?: number[] } = {}) {
  const { srv, fetch } = server();
  srv.rev = rev;
  srv.segs = timelinePayload(tl(10));
  const states: TimelineSaveState[] = [];
  const backups: (TimelineBackup | null)[] = [];
  const conflicts: (number | null)[] = [];
  const answers: unknown[] = [];
  const saver = new TimelineSaver(rev, timelinePayload(tl(10)), {
    jobId: "j1",
    duration: 30,
    fetch,
    onState: (s) => states.push(s),
    backup: (b) => backups.push(b),
    onConflict: (r) => conflicts.push(r),
    onAnswer: (d) => answers.push(d),
    known: opts.known,
  });
  return { srv, saver, states, backups, conflicts, answers };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TimelineSaver (review F3/F4, save-11)", () => {
  it("sends base_rev / rev; the next save is based on the acknowledged rev; Saved only then", async () => {
    const { srv, saver, states } = saverOf();
    saver.schedule(tl(9));
    expect(saver.status).toBe("saving");
    await vi.advanceTimersByTimeAsync(799);
    expect(srv.posts).toHaveLength(0);
    expect(saver.status).toBe("saving");
    await vi.advanceTimersByTimeAsync(10);
    expect(srv.posts).toHaveLength(1);
    expect(srv.posts[0].base_rev).toBe(100);
    expect(srv.posts[0].rev).toBeGreaterThan(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(saver.status).toBe("saved");
    expect(saver.rev).toBe(srv.posts[0].rev);
    saver.schedule(tl(8));
    await vi.advanceTimersByTimeAsync(900);
    expect(srv.posts[1].base_rev).toBe(srv.posts[0].rev);
    expect(srv.segs).toEqual(timelinePayload(tl(8)));
    expect(states.at(-1)).toBe("saved");
  });

  it("one save on the wire at a time: edits meanwhile go as ONE save of the newest state (F4)", async () => {
    const { srv, saver } = saverOf();
    srv.storeMs = 3000; // the server takes 3 s to store it
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(800);
    expect(srv.posts).toHaveLength(1);
    // three more edits while it is on the wire
    saver.schedule(tl(8.5));
    await vi.advanceTimersByTimeAsync(900);
    saver.schedule(tl(8));
    await vi.advanceTimersByTimeAsync(900);
    saver.schedule(tl(7.5));
    await vi.advanceTimersByTimeAsync(900);
    // still one: nothing overtakes the save on the wire
    expect(srv.posts).toHaveLength(1);
    expect(saver.status).toBe("saving");
    await vi.advanceTimersByTimeAsync(3000);
    // stored: the newest state goes next, the ones between never
    expect(srv.posts).toHaveLength(2);
    expect(srv.posts[1].segments).toEqual(timelinePayload(tl(7.5)));
    expect(srv.posts[1].base_rev).toBe(srv.posts[0].rev);
    await vi.advanceTimersByTimeAsync(3100);
    expect(saver.status).toBe("saved");
    expect(srv.segs).toEqual(timelinePayload(tl(7.5)));
  });

  it("the next save goes once the server SHOWS the first stored, not after its preview re-encode", async () => {
    const { srv, saver, answers } = saverOf();
    srv.rebuildMs = 20_000;
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(800);
    saver.schedule(tl(8));
    // GET /jobs shows its rev within the first poll: acknowledged
    await vi.advanceTimersByTimeAsync(800 + 300);
    expect(srv.posts).toHaveLength(2);
    expect(srv.posts[1].base_rev).toBe(srv.posts[0].rev);
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status).toBe("saved");
    // the answers (with the previews) still arrive
    await vi.advanceTimersByTimeAsync(20_000);
    expect(answers).toHaveLength(2);
  });

  it("another tab or device saved: conflict, nothing is overwritten, the local copy goes", async () => {
    const { srv, saver, conflicts, backups } = saverOf();
    srv.rev = 555; // someone else saved
    saver.schedule(tl(9));
    expect(backups.at(-1)?.segs).toEqual(tl(9));
    await vi.advanceTimersByTimeAsync(900);
    expect(saver.status).toBe("conflict");
    expect(conflicts).toEqual([555]);
    expect(backups.at(-1)).toBeNull();
    saver.schedule(tl(8));
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.posts).toHaveLength(1);
    expect(srv.segs).toEqual(timelinePayload(tl(10)));
    // the editor reloaded: the server's rev is the base again
    saver.reset(555, timelinePayload(tl(10)));
    saver.schedule(tl(8));
    await vi.advanceTimersByTimeAsync(900);
    expect(srv.posts.at(-1)!.base_rev).toBe(555);
    expect(saver.status).toBe("saved");
  });

  it("a save that committed but whose answer was lost: sent again as it was, its 409 is the success", async () => {
    const { srv, saver, conflicts } = saverOf();
    srv.fail = ["lost"];
    srv.rebuildMs = 0;
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(805);
    // (the first poll may see it stored first: either way, no conflict)
    await vi.advanceTimersByTimeAsync(5000);
    expect(conflicts).toEqual([]);
    expect(saver.status).toBe("saved");
    expect(srv.segs).toEqual(timelinePayload(tl(9)));
    if (srv.posts.length > 1) expect(srv.posts[1]).toEqual(srv.posts[0]);
  });

  it("network down: retrying with the same body, then saved", async () => {
    const { srv, saver, states } = saverOf();
    srv.fail = ["net", "net"];
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(805);
    expect(saver.status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(5000);
    expect(saver.status).toBe("saved");
    expect(srv.posts).toHaveLength(3);
    expect(new Set(srv.posts.map((p) => p.rev)).size).toBe(1);
    expect(states).toContain("retrying");
  });

  it("a keepalive flush that overtook the save on the wire is no conflict (its rev is ours)", async () => {
    const { srv, saver, conflicts } = saverOf();
    // the save on the wire takes 3 s to be stored, the flush gets there first
    srv.storeDelays = [3000, 0];
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(800);
    saver.schedule(tl(8));
    // hidden page: sent at once, chained on the save on the wire
    saver.flushNow(false);
    expect(srv.posts).toHaveLength(2);
    expect(srv.posts[1].keepalive).toBe(true);
    expect(srv.posts[1].base_rev).toBe(srv.posts[0].rev);
    await vi.advanceTimersByTimeAsync(100);
    // refused (the first isn't stored yet): its 409 names the rev we loaded — ours
    expect(srv.rev).toBe(100);
    await vi.advanceTimersByTimeAsync(8000);
    expect(conflicts).toEqual([]);
    expect(saver.status).toBe("saved");
    expect(srv.segs).toEqual(timelinePayload(tl(8)));
    expect(srv.posts).toHaveLength(3);
  });

  it("a rev of this device's last visit (a backup's) is no conflict either", async () => {
    const { srv, saver, conflicts } = saverOf(100, { known: [777] });
    srv.rev = 777; // the last visit's keepalive landed after this editor loaded the job
    saver.schedule(tl(9));
    await vi.advanceTimersByTimeAsync(3000);
    expect(conflicts).toEqual([]);
    expect(srv.posts.at(-1)!.base_rev).toBe(777);
    expect(srv.segs).toEqual(timelinePayload(tl(9)));
  });

  it("the local copy holds what isn't acknowledged, with its base rev; gone once stored", async () => {
    const { srv, saver, backups } = saverOf();
    srv.fail = ["net", "net", "net"];
    saver.schedule(tl(9));
    const b = backups.at(-1)!;
    expect(b.segs).toEqual(tl(9));
    expect(b.base).toBe(100);
    await vi.advanceTimersByTimeAsync(1500);
    expect(backups.at(-1)?.segs).toEqual(tl(9));
    expect(backups.at(-1)?.known.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(saver.status).toBe("saved");
    expect(backups.at(-1)).toBeNull();
  });

  it("refused for good (job gone): failed; settle() says false", async () => {
    const { saver } = saverOf();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: "job not found" }), { status: 404 }));
    const s2 = new TimelineSaver(1, null, { jobId: "x", duration: 30, fetch });
    s2.schedule(tl(9));
    const ok = s2.settle(5000);
    await vi.advanceTimersByTimeAsync(100);
    expect(await ok).toBe(false);
    expect(s2.status).toBe("failed");
    saver.stop();
  });

  it("settle() (export) sends what is pending at once and resolves once it is stored", async () => {
    const { srv, saver } = saverOf();
    srv.rebuildMs = 20_000;
    saver.schedule(tl(9));
    const ok = saver.settle();
    expect(srv.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(await ok).toBe(true);
    expect(srv.segs).toEqual(timelinePayload(tl(9)));
  });

  it("an empty timeline is never sent", async () => {
    const { srv, saver } = saverOf();
    saver.schedule([clip("a", 0, 0.02)]);
    await vi.advanceTimersByTimeAsync(900);
    expect(srv.posts).toHaveLength(0);
    expect(saver.status).toBe("saved");
  });

  it("close() sends the pending edit now and keeps going after the editor is gone", async () => {
    const { srv, saver, states } = saverOf();
    srv.fail = ["net"];
    saver.schedule(tl(9));
    const n = states.length;
    const done = saver.close();
    expect(srv.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(srv.segs).toEqual(timelinePayload(tl(9)));
    // no state reached the (gone) editor
    expect(states.length).toBe(n);
  });
});
