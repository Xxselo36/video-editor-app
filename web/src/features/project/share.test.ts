// UX11 Save / Share (review C13): navigator.share runs in the same task
// as the tap — no await before it, or iOS refuses to open the sheet.
import { describe, expect, it, vi } from "vitest";
import { SHARE_MAX_BYTES, canShareFiles, shareFile, shareMode } from "./share";

const file = () => new File([new Uint8Array([1, 2, 3])], "talk_cleocuts_9x16.mp4", { type: "video/mp4" });

function nav(share: (d: ShareData) => Promise<void>, canShare = true) {
  return { share: vi.fn(share), canShare: vi.fn(() => canShare) };
}

describe("shareFile", () => {
  it("calls navigator.share synchronously, before any microtask", () => {
    const n = nav(() => new Promise<void>(() => {}));
    let microtaskRan = false;
    void Promise.resolve().then(() => {
      microtaskRan = true;
    });
    void shareFile(file(), n);
    expect(n.share).toHaveBeenCalledTimes(1);
    expect(microtaskRan).toBe(false);
    const arg = n.share.mock.calls[0][0] as ShareData;
    expect(arg.files?.[0].name).toBe("talk_cleocuts_9x16.mp4");
  });

  it("tells shared, cancelled (AbortError) and failed apart", async () => {
    expect(await shareFile(file(), nav(async () => {}))).toBe("shared");
    const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
    expect(await shareFile(file(), nav(() => Promise.reject(abort)))).toBe("cancelled");
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    expect(await shareFile(file(), nav(() => Promise.reject(denied)))).toBe("failed");
    expect(await shareFile(file(), {})).toBe("failed");
    const throwing = { share: () => { throw new TypeError("bad"); } };
    expect(await shareFile(file(), throwing as never)).toBe("failed");
  });
});

describe("shareMode", () => {
  it("shares files up to 250 MB where the browser can, else downloads", () => {
    const n = nav(async () => {});
    expect(canShareFiles(n)).toBe(true);
    expect(shareMode(12_000_000, n)).toBe("share");
    expect(shareMode(SHARE_MAX_BYTES + 1, n)).toBe("download");
    expect(shareMode(null, n)).toBe("download");
    expect(shareMode(12_000_000, nav(async () => {}, false))).toBe("download");
    expect(shareMode(12_000_000, {})).toBe("download");
    expect(shareMode(12_000_000, undefined)).toBe("download");
  });
});
