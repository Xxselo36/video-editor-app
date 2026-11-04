// Saves left running by the editor: what re-entering a job and the
// Vorschau's Fertigstellen wait for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPendingSaves, trackSave, waitForAllSaves, waitForSaves } from "./pendingSaves";

/** A save the test settles itself. */
function save() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const p = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForSaves", () => {
  it("is settled at once when nothing is out", async () => {
    expect(await waitForSaves("none", 10)).toBe(true);
  });

  it("is settled once every save of the job settled, failed ones included", async () => {
    const a = save();
    const b = save();
    trackSave("j1", a.p);
    trackSave("j1", b.p);
    let settled: boolean | null = null;
    const waiting = waitForSaves("j1", 60_000).then((v) => (settled = v));
    a.resolve();
    await a.p;
    expect(settled).toBeNull();
    b.reject(new Error("offline"));
    expect(await waiting).toBe(true);
    expect(hasPendingSaves("j1")).toBe(false);
  });

  it("gives up after the timeout and says so: the save is still out", async () => {
    vi.useFakeTimers();
    const stuck = save();
    trackSave("j2", stuck.p);
    const waiting = waitForSaves("j2", 8000);
    await vi.advanceTimersByTimeAsync(7999);
    expect(hasPendingSaves("j2")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe(false);
    expect(hasPendingSaves("j2")).toBe(true);
    stuck.resolve();
    await stuck.p;
    expect(hasPendingSaves("j2")).toBe(false);
  });

  it("waits for this job's saves only", async () => {
    const other = save();
    trackSave("j3", other.p);
    expect(await waitForSaves("j4", 60_000)).toBe(true);
    other.resolve();
    await other.p;
  });
});

describe("hasPendingSaves", () => {
  it("per job, or for any job without one", async () => {
    const s = save();
    expect(hasPendingSaves()).toBe(false);
    trackSave("j5", s.p);
    expect(hasPendingSaves()).toBe(true);
    expect(hasPendingSaves("j5")).toBe(true);
    expect(hasPendingSaves("j6")).toBe(false);
    s.resolve();
    await s.p;
    expect(hasPendingSaves("j5")).toBe(false);
    expect(hasPendingSaves()).toBe(false);
  });
});

describe("waitForAllSaves", () => {
  it("waits for every job's saves", async () => {
    vi.useFakeTimers();
    const a = save();
    const b = save();
    trackSave("j7", a.p);
    trackSave("j8", b.p);
    a.resolve();
    const late = waitForAllSaves(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await late).toBe(false);
    b.resolve();
    expect(await waitForAllSaves(5000)).toBe(true);
  });
});
