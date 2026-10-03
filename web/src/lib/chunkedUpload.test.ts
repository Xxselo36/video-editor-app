import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  doneBytes,
  fingerprint,
  legacyFingerprint,
  partLength,
  recordGone,
  uploadLimitHit,
} from "@/lib/chunkedUpload";
import { DEFAULT_LIMITS } from "@/lib/config";

const MIB = 1024 * 1024;
const L = DEFAULT_LIMITS;

describe("uploadLimitHit", () => {
  it("uses the backend's defaults until GET /config answers (4 GB, 30 min, 3 s)", () => {
    expect(L).toEqual({ max_upload_bytes: 4e9, max_seconds: 1800, min_seconds: 3 });
  });

  it("counts decimal gigabytes like the backend", () => {
    expect(uploadLimitHit(4e9, 60, L)).toBeNull();
    expect(uploadLimitHit(4e9 + 1, 60, L)).toEqual({ code: "file_too_large", params: { max_gb: 4 } });
  });

  it("allows one second of slack on the length", () => {
    expect(uploadLimitHit(1000, 30 * 60 + 1, L)).toBeNull();
    expect(uploadLimitHit(1000, 30 * 60 + 1.5, L)).toEqual({ code: "video_too_long", params: { max_minutes: 30 } });
  });

  it("refuses a clip under the minimum (0.1 s of slack)", () => {
    expect(uploadLimitHit(1000, 2.95, L)).toBeNull();
    expect(uploadLimitHit(1000, 1.5, L)).toEqual({ code: "video_too_short", params: { min_seconds: 3 } });
  });

  it("follows the deployment's limits", () => {
    const custom = { max_upload_bytes: 5e8, max_seconds: null, min_seconds: 0 };
    expect(uploadLimitHit(6e8, 10, custom)).toEqual({ code: "file_too_large", params: { max_gb: 0.5 } });
    expect(uploadLimitHit(1000, 99 * 3600, custom)).toBeNull();
    expect(uploadLimitHit(1000, 0.5, custom)).toBeNull();
  });

  it("leaves an unreadable length to the server", () => {
    expect(uploadLimitHit(1000, null, L)).toBeNull();
  });

  it("reports the size first", () => {
    expect(uploadLimitHit(5e9, 99 * 60, L)?.code).toBe("file_too_large");
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

  it("fingerprint is size + SHA-256 of the content, independent of lastModified", async () => {
    const a = await fingerprint(file("a.mp4", bytes(1000), 1));
    const b = await fingerprint(file("a.mp4", bytes(1000), 999));
    expect(a).toMatch(/^c2:1000:[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes with the content, not with the name (iOS renames re-picked videos)", async () => {
    const a = await fingerprint(file("IMG_0042.MOV", bytes(1000)));
    expect(await fingerprint(file("trim.6F1C2D3A-0B7E.MOV", bytes(1000), 5))).toBe(a);
    expect(await fingerprint(file("IMG_0042.MOV", bytes(1000, 8)))).not.toBe(a);
    expect(await fingerprint(file("IMG_0042.MOV", bytes(1001)))).not.toBe(a);
  });

  it("the old key (records from before) still hashes the name", async () => {
    const a = await legacyFingerprint(file("a.mp4", bytes(1000)));
    expect(a).toMatch(/^1000:[0-9a-f]{64}$/);
    expect(await legacyFingerprint(file("b.mp4", bytes(1000)))).not.toBe(a);
  });

  it("samples only the first and last 2 MiB of big files", async () => {
    const big = bytes(5 * MIB);
    const middle = big.slice();
    middle[Math.floor(2.5 * MIB)] = 1;
    const tail = big.slice();
    tail[5 * MIB - 1] = 1;
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
