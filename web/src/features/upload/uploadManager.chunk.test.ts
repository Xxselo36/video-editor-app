// uploadManager (UX5, review finding 4): the upload code is a chunk; when
// it can't be loaded online (a deploy took this build's chunk away) the
// upload's record says "reload", not "connection lost".
import { describe, expect, it, vi } from "vitest";

const failed: { id: string; code: string | null }[] = [];
vi.mock("./records", () => ({
  liveUploads: new Set<string>(),
  projectsV2: () => false,
  addUploadRecord: vi.fn(),
  removeUploadRecord: vi.fn(),
  recordUploadFailed: vi.fn((id: string, e: { code: string | null }) => failed.push({ id, code: e.code })),
}));
vi.mock("./uploadJob", () => {
  throw new Error("Failed to load chunk /_next/static/chunks/old.js");
});

describe("a missing upload chunk", () => {
  it("asks for a reload while online, and frees the file for another try", async () => {
    const { startUpload, isUploading, canRetryInPlace } = await import("./uploadManager");
    const file = new File([new Uint8Array(3)], "x.mp4", { type: "video/mp4", lastModified: 3 });
    await startUpload(file, {
      caption_preset: "clean",
      style: "smooth",
      voice_triggers: true,
      remove_fillers: true,
      smartcam_enabled: false,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
    }, null);
    expect(failed).toHaveLength(1);
    expect(failed[0].code).toBe("app_updated");
    expect(isUploading(file)).toBe(false);
    // "Try again" goes with the File this page still has.
    expect(canRetryInPlace(failed[0].id)).toBe(true);
  });
});
