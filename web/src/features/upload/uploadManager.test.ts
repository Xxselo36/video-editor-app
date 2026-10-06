// uploadManager (UX5): one upload per file at a time (review finding 3).
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const pending: (() => void)[] = [];
const finish = () => pending.splice(0).forEach((f) => f());
const sources: unknown[] = [];
vi.mock("./uploadJob", () => ({
  uploadJob: vi.fn(
    async (
      file: File,
      s: unknown,
      _p: unknown,
      cb: {
        tempId: string;
        onCreated: (id: string) => void;
        onEnd?: (id: string) => void;
        onProgress?: (id: string, pct: number, resuming: boolean) => void;
      },
    ) => {
      calls.push(file.name);
      sources.push(s);
      cb.onProgress?.(cb.tempId, 40, false);
      await new Promise<void>((resolve) => pending.push(resolve));
      if (file.name.startsWith("ok-")) cb.onCreated(`job-${file.name}`);
      cb.onEnd?.(cb.tempId);
    },
  ),
}));

const settings = {
  style: "smooth",
  voice_triggers: true,
  remove_fillers: true,
  smartcam_enabled: false,
  smartcam_format: "portrait" as const,
  resolution: "1080",
  output_formats: [],
};

describe("startUpload", () => {
  it("refuses a second start of the same file while it uploads", async () => {
    const { startUpload, isUploading } = await import("./uploadManager");
    const file = new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4", lastModified: 1 });
    const first = startUpload(file, settings, null);
    const second = startUpload(file, settings, null);   // a double click
    await second;
    await vi.waitFor(() => expect(calls).toEqual(["clip.mp4"]));
    expect(isUploading(file)).toBe(true);
    // Another file goes up alongside.
    const other = new File([new Uint8Array(11)], "other.mp4", { type: "video/mp4", lastModified: 1 });
    void startUpload(other, settings, null);
    await vi.waitFor(() => expect(calls).toEqual(["clip.mp4", "other.mp4"]));
    finish();
    await first;
  });

  it("allows the same file again once its upload is over", async () => {
    calls.length = 0;
    const { startUpload, isUploading } = await import("./uploadManager");
    const file = new File([new Uint8Array(12)], "again.mp4", { type: "video/mp4", lastModified: 2 });
    const run = startUpload(file, settings, null);
    await vi.waitFor(() => expect(calls).toEqual(["again.mp4"]));
    finish();
    await run;
    expect(isUploading(file)).toBe(false);
    void startUpload(file, settings, null);
    await vi.waitFor(() => expect(calls).toEqual(["again.mp4", "again.mp4"]));
    finish();
  });

  it("tells the start screen its card, and how the upload ended (UX6)", async () => {
    calls.length = 0;
    const { startUpload } = await import("./uploadManager");
    const events: string[] = [];
    const getter = () => settings;
    const ok = new File([new Uint8Array(13)], "ok-a.mp4", { type: "video/mp4", lastModified: 3 });
    const run = startUpload(ok, getter, null, {
      onCard: (id) => events.push(id.startsWith("upl-") ? "card" : id),
      onCreated: (id) => events.push(`created ${id}`),
      onEnd: (id) => events.push(`end ${id}`),
    });
    await vi.waitFor(() => expect(calls).toEqual(["ok-a.mp4"]));
    expect(events).toEqual(["card"]);
    // The settings go to the upload as given: read when POST /jobs goes out.
    expect(sources.at(-1)).toBe(getter);
    finish();
    await run;
    expect(events).toEqual(["card", "created job-ok-a.mp4", "end job-ok-a.mp4"]);

    const failed: (string | null)[] = [];
    const bad = new File([new Uint8Array(14)], "bad.mp4", { type: "video/mp4", lastModified: 4 });
    const run2 = startUpload(bad, settings, null, { onEnd: (id) => failed.push(id) });
    await vi.waitFor(() => expect(calls).toEqual(["ok-a.mp4", "bad.mp4"]));
    finish();
    await run2;
    expect(failed).toEqual([null]);
  });

  it("keeps the upload in the module, not in the screen that started it", async () => {
    calls.length = 0;
    const { startUpload, getLiveUpload, getLiveUploads } = await import("./uploadManager");
    const { liveUploads } = await import("./records");
    let tempId = "";
    // The start screen hands over and goes (Projects opens): nothing of
    // the upload is left with it.
    const file = new File([new Uint8Array(15)], "ok-wandert.mp4", { type: "video/mp4", lastModified: 5 });
    const run = startUpload(file, settings, null, { onCard: (id) => (tempId = id) });
    await vi.waitFor(() => expect(calls).toEqual(["ok-wandert.mp4"]));
    // Projects reads the live progress from the module, and the record is
    // this page's (never taken for a dead one).
    expect(getLiveUpload(tempId)).toMatchObject({ pct: 40, resuming: false });
    expect(getLiveUploads().map((u) => u.id)).toContain(tempId);
    expect(liveUploads.has(tempId)).toBe(true);
    finish();
    await run;
    expect(getLiveUpload(tempId)).toBeNull();
  });
});
