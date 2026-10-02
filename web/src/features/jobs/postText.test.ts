// UX12 re-review: the menu's post text is kept only when it loaded, and
// only for the same status / output / revision.
import { describe, expect, it, vi } from "vitest";
import { postTextEntry, postTextKey, postTextOf } from "./postText";

const p = { id: "j1", state: "exported" as const, hasOutput: true, updatedAt: 1000 };
const job = { social_caption: "Hello", social_hashtags: ["a", "#b", 3] };

describe("post text cache", () => {
  it("joins the caption and hashtags", () => {
    expect(postTextOf(job)).toBe("Hello\n\n#a #b");
    expect(postTextOf({})).toBe("");
  });

  it("reuses a loaded text for the same revision", async () => {
    const fetch = vi.fn(async () => job);
    const a = postTextEntry(null, postTextKey(p), fetch);
    await expect(a.promise).resolves.toBe("Hello\n\n#a #b");
    expect(postTextEntry(a, postTextKey(p), fetch)).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed fetch", async () => {
    const fetch = vi.fn(async (): Promise<Record<string, unknown> | null> => null).mockResolvedValueOnce(null).mockResolvedValueOnce(job);
    const a = postTextEntry(null, postTextKey(p), fetch);
    await expect(a.promise).resolves.toBe("");
    expect(a.failed).toBe(true);
    const b = postTextEntry(a, postTextKey(p), fetch);
    expect(b).not.toBe(a);
    await expect(b.promise).resolves.toBe("Hello\n\n#a #b");
    // A rejected fetch counts as failed too.
    const c = postTextEntry(null, "k", () => Promise.reject(new Error("offline")));
    await expect(c.promise).resolves.toBe("");
    expect(c.failed).toBe(true);
  });

  it("asks again when the status, output or revision changed", async () => {
    const fetch = vi.fn(async () => job);
    const a = postTextEntry(null, postTextKey(p), fetch);
    await a.promise;
    for (const next of [
      { ...p, updatedAt: 2000 },
      { ...p, hasOutput: false },
      { ...p, state: "edited" as const },
    ]) {
      expect(postTextKey(next)).not.toBe(postTextKey(p));
      expect(postTextEntry(a, postTextKey(next), fetch)).not.toBe(a);
    }
  });
});
