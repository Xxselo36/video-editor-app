// uploadManager (UX5): one upload per file at a time (review finding 3).
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const pending: (() => void)[] = [];
const finish = () => pending.splice(0).forEach((f) => f());
vi.mock("./uploadJob", () => ({
  uploadJob: vi.fn(async (file: File, _s: unknown, _p: unknown, cb: { tempId: string; onEnd?: (id: string) => void }) => {
    calls.push(file.name);
    await new Promise<void>((resolve) => pending.push(resolve));
    cb.onEnd?.(cb.tempId);
  }),
}));

const settings = {
  caption_preset: "clean",
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
});
