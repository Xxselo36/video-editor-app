// uploadManager (UX5, review finding 4): the upload code is a chunk; when
// it can't be loaded online (a deploy took this build's chunk away) the
// card says "reload", not "connection lost".
import { describe, expect, it, vi } from "vitest";

const updates: { id: string; patch: Record<string, unknown> }[] = [];
vi.mock("@/lib/activeJobs", async (orig) => ({
  ...(await orig<typeof import("@/lib/activeJobs")>()),
  addActiveJob: vi.fn(),
  updateActiveJob: vi.fn((id: string, patch: Record<string, unknown>) => updates.push({ id, patch })),
}));
vi.mock("./uploadJob", () => {
  throw new Error("Failed to load chunk /_next/static/chunks/old.js");
});

describe("a missing upload chunk", () => {
  it("asks for a reload while online, and frees the file for another try", async () => {
    const { startUpload, isUploading } = await import("./uploadManager");
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
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.errorCode).toBe("app_updated");
    expect(String(updates[0].patch.error)).toContain("reload");
    expect(isUploading(file)).toBe(false);
  });
});
