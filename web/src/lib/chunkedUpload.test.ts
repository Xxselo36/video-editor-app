import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  doneBytes,
  fingerprint,
  knownKey,
  MAX_MINUTES,
  MAX_UPLOAD_GB,
  partLength,
  recordGone,
  uploadLimitHit,
} from "@/lib/chunkedUpload";

const MIB = 1024 * 1024;

describe("uploadLimitHit", () => {
  it("uses the default caps (4 GB, 30 min)", () => {
    expect(MAX_UPLOAD_GB).toBe(4);
    expect(MAX_MINUTES).toBe(30);
  });

  it("counts decimal gigabytes like the backend", () => {
    expect(uploadLimitHit(4e9, 60)).toBeNull();
    expect(uploadLimitHit(4e9 + 1, 60)).toEqual({ code: "file_too_large", max: 4 });
  });

  it("allows one second of slack on the length", () => {
    expect(uploadLimitHit(1000, 30 * 60 + 1)).toBeNull();
    expect(uploadLimitHit(1000, 30 * 60 + 1.5)).toEqual({ code: "video_too_long", max: 30 });
  });

  it("leaves an unreadable length to the server", () => {
    expect(uploadLimitHit(1000, null)).toBeNull();
  });

  it("reports the size first", () => {
    expect(uploadLimitHit(5e9, 99 * 60)?.code).toBe("file_too_large");
  });
});

describe("recordGone", () => {
  const e = (status: number, detail: unknown = "x") => new ApiError(status, detail);

  it("drops the resume record on definitive answers only", () => {
    for (const s of [400, 403, 404, 405, 410]) expect(recordGone(e(s))).toBe(true);
    expect(recordGone(e(409, "use_single_put"))).toBe(true);
  });

  it("keeps it on retryable answers", () => {
    for (const s of [401, 409, 429, 500, 502, 503]) expect(recordGone(e(s))).toBe(false);
  });
});

describe("resume-record keys", () => {
  const file = (name: string, bytes: Uint8Array, lastModified = 1) =>
    new File([bytes as BlobPart], name, { type: "video/mp4", lastModified });
  const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

  it("knownKey is size:name", () => {
    expect(knownKey("clip.mp4", 42)).toBe("42:clip.mp4");
  });

  it("fingerprint is size + SHA-256, independent of lastModified", async () => {
    const a = await fingerprint(file("a.mp4", bytes(1000), 1));
    const b = await fingerprint(file("a.mp4", bytes(1000), 999));
    expect(a).toMatch(/^1000:[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes with the name and the content", async () => {
    const a = await fingerprint(file("a.mp4", bytes(1000)));
    expect(await fingerprint(file("b.mp4", bytes(1000)))).not.toBe(a);
    expect(await fingerprint(file("a.mp4", bytes(1000, 8)))).not.toBe(a);
  });

  it("samples only the first and last MiB of big files", async () => {
    const big = bytes(3 * MIB);
    const middle = big.slice();
    middle[Math.floor(1.5 * MIB)] = 1;
    const tail = big.slice();
    tail[3 * MIB - 1] = 1;
    const a = await fingerprint(file("big.mp4", big));
    expect(await fingerprint(file("big.mp4", middle))).toBe(a);
    expect(await fingerprint(file("big.mp4", tail))).not.toBe(a);
  });

  it("is null without crypto.subtle (plain-http LAN dev)", async () => {
    vi.stubGlobal("crypto", {});
    try {
      expect(await fingerprint(file("n.mp4", bytes(10)))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("partLength / doneBytes: the last part is the remainder", () => {
    const size = 60 * MIB + 12345;
    const part = 16 * MIB;
    expect(partLength(1, part, size, 4)).toBe(part);
    expect(partLength(4, part, size, 4)).toBe(12 * MIB + 12345);
    expect(doneBytes([1, 2], part, size, 4)).toBe(32 * MIB);
    expect(doneBytes([1, 2, 3, 4], part, size, 4)).toBe(size);
  });
});
