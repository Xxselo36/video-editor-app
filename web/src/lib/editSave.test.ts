import { afterEach, describe, expect, it, vi } from "vitest";

// saveOutcome polls GET /jobs/{id} through apiFetch.
const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init) }));

const { sameTimeline, saveOutcome } = await import("@/lib/editSave");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  apiFetch.mockReset();
});

describe("sameTimeline", () => {
  const ours = [
    { start: 0, end: 6 },
    { start: 7, end: 14, speed: 2 },
  ];

  it("matches the server's copy within its 1 ms rounding", () => {
    const server = [
      { start: 0.0004, end: 5.9996, speed: 1, fadeIn: 0, fadeOut: 0, volume: 1 },
      { start: 7, end: 14.001, speed: 2, fadeIn: 0, fadeOut: 0, volume: 1 },
    ];
    expect(sameTimeline(server, ours, 30)).toBe(true);
  });

  it("treats missing effects as the defaults", () => {
    expect(sameTimeline([{ start: 0, end: 6, speed: 1, volume: 1 }], [{ start: 0, end: 6 }], 30)).toBe(true);
  });

  it("differs on order, effects, times and length", () => {
    expect(sameTimeline([...ours].reverse(), ours, 30)).toBe(false);
    expect(sameTimeline([ours[0], { ...ours[1], speed: 1.5 }], ours, 30)).toBe(false);
    expect(sameTimeline([ours[0], { ...ours[1], end: 14.01 }], ours, 30)).toBe(false);
    expect(sameTimeline([ours[0]], ours, 30)).toBe(false);
  });

  it("compares the stored form: ends clamped, tiny clips dropped", () => {
    expect(sameTimeline([{ start: 25, end: 30 }], [{ start: 25, end: 40 }], 30)).toBe(true);
    expect(
      sameTimeline([{ start: 0, end: 6 }], [{ start: 0, end: 6 }, { start: 9, end: 9.02 }], 30),
    ).toBe(true);
  });

  it("is false without a server timeline", () => {
    expect(sameTimeline(undefined, ours, 30)).toBe(false);
  });
});

describe("saveOutcome", () => {
  const segs = [{ start: 0, end: 6 }];
  const neverStored = () => json({ status: "awaiting_review", edit_segments: [{ start: 1, end: 2 }] });

  it("is 'stored' on an OK answer", async () => {
    apiFetch.mockImplementation(async () => neverStored());
    await expect(saveOutcome("j1", segs, 30, Promise.resolve(new Response("{}")))).resolves.toBe("stored");
  });

  it("is 'refused' on a 4xx answer", async () => {
    apiFetch.mockImplementation(async () => neverStored());
    const r = Promise.resolve(json({ detail: "gone" }, 409));
    await expect(saveOutcome("j1", segs, 30, r)).resolves.toBe("refused");
  });

  it("is 'stored' once GET /jobs shows the timeline, while the answer is still out", async () => {
    apiFetch.mockImplementation(async () => json({ status: "awaiting_review", edit_segments: segs }));
    const pending = new Promise<Response>(() => {});
    await expect(saveOutcome("j1", segs, 30, pending, { timeoutMs: 5_000 })).resolves.toBe("stored");
    expect(apiFetch).toHaveBeenCalledWith("/jobs/j1", expect.objectContaining({ cache: "no-store" }));
  });

  it("is 'unknown' when a 5xx answer comes and the timeline never shows", async () => {
    apiFetch.mockImplementation(async () => neverStored());
    const r = Promise.resolve(json({ detail: "busy" }, 503));
    await expect(saveOutcome("j1", segs, 30, r, { timeoutMs: 300 })).resolves.toBe("unknown");
  });

  it("is 'unknown' at once on a failed answer with settleOnAnswer", async () => {
    apiFetch.mockImplementation(async () => neverStored());
    const t0 = Date.now();
    const r = Promise.reject(new Error("offline"));
    await expect(saveOutcome("j1", segs, 30, r, { settleOnAnswer: true, timeoutMs: 10_000 })).resolves.toBe(
      "unknown",
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("stops waiting when the job left review", async () => {
    apiFetch.mockImplementation(async () => json({ status: "processing", edit_segments: [] }));
    const r = Promise.reject(new Error("offline"));
    await expect(saveOutcome("j1", segs, 30, r, { timeoutMs: 10_000 })).resolves.toBe("unknown");
  });
});
