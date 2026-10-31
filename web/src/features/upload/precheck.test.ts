// The pick-time check (D9): what the server would refuse is refused before
// any byte goes up, with the server's own code and params.
import { describe, expect, it, vi } from "vitest";
import type { Me } from "@/lib/account";

const LIMITS = { max_upload_bytes: 10e9, max_seconds: 30 * 60, min_seconds: 3 };
vi.mock("@/lib/config", () => ({ getConfig: async () => ({ limits: LIMITS }) }));

const MB = 1e6;
const base = { size: 50 * MB, type: "video/mp4", duration: 60, limits: LIMITS, billing: null };
const billed = (plan: string | null, remainingSeconds: number | null) => ({ enforce: true, plan, remainingSeconds });

describe("uploadRefusal", () => {
  it("an audio file has no video", async () => {
    const { uploadRefusal } = await import("./precheck");
    expect(uploadRefusal({ ...base, type: "audio/mpeg" })).toEqual({ code: "no_video", params: {} });
  });

  it("the size and length limits, with their params", async () => {
    const { uploadRefusal } = await import("./precheck");
    expect(uploadRefusal({ ...base, size: 11e9 })).toEqual({ code: "file_too_large", params: { max_gb: 10 } });
    expect(uploadRefusal({ ...base, duration: 31 * 60 })).toEqual({ code: "video_too_long", params: { max_minutes: 30 } });
    expect(uploadRefusal({ ...base, duration: 1 })).toEqual({ code: "video_too_short", params: { min_seconds: 3 } });
    expect(uploadRefusal(base)).toBeNull();
  });

  it("billing enforced without a plan: the plan dialog", async () => {
    const { uploadRefusal } = await import("./precheck");
    expect(uploadRefusal({ ...base, billing: billed(null, null) })).toEqual({ paywall: { code: "subscription_required" } });
  });

  it("too few minutes left: the plan dialog with both numbers", async () => {
    const { uploadRefusal } = await import("./precheck");
    expect(uploadRefusal({ ...base, duration: 90.2, billing: billed("starter", 80.4) })).toEqual({
      paywall: { code: "quota_exceeded", remainingSeconds: 80, neededSeconds: 91 },
    });
    expect(uploadRefusal({ ...base, duration: 80, billing: billed("starter", 80) })).toBeNull();
    // Nothing left: refused whatever the length (as the server does).
    expect(uploadRefusal({ ...base, duration: null, billing: billed("starter", 0) })).toEqual({
      paywall: { code: "quota_exceeded", remainingSeconds: 0, neededSeconds: null },
    });
  });

  it("billing off or not enforced, a length the browser can't read, minutes not known: no refusal", async () => {
    const { uploadRefusal } = await import("./precheck");
    expect(uploadRefusal({ ...base, duration: 3600, limits: { ...LIMITS, max_seconds: null }, billing: null })).toBeNull();
    expect(uploadRefusal({ ...base, billing: { enforce: false, plan: null, remainingSeconds: 0 } })).toBeNull();
    expect(uploadRefusal({ ...base, duration: null, billing: billed("pro", 600) })).toBeNull();
    expect(uploadRefusal({ ...base, billing: billed("pro", null) })).toBeNull();
  });
});

describe("precheckUpload", () => {
  const file = (size: number, type = "video/mp4") => ({ size, type }) as File;
  const probe = (duration: number | null) => ({ width: 1080, height: 1920, duration });
  const me = (over: Partial<Me>): Me => ({
    auth_enabled: true,
    billing: { enabled: true, enforce: true },
    plan: "starter",
    minutes: { limit: 60, used: 59, remaining: 1, remaining_seconds: 60 },
    ...over,
  });

  it("checks the deployment's limits and the probe's length", async () => {
    const { precheckUpload } = await import("./precheck");
    await expect(precheckUpload(file(11e9), probe(60), null, false)).resolves.toMatchObject({ code: "file_too_large" });
    await expect(precheckUpload(file(MB), probe(31 * 60), null, false)).resolves.toMatchObject({ code: "video_too_long" });
    await expect(precheckUpload(file(MB), null, null, false)).resolves.toBeNull();
  });

  it("asks the account's plan and minutes only with billing on", async () => {
    const { precheckUpload } = await import("./precheck");
    await expect(precheckUpload(file(MB), probe(120), me({}), true)).resolves.toEqual({
      paywall: { code: "quota_exceeded", remainingSeconds: 60, neededSeconds: 120 },
    });
    await expect(precheckUpload(file(MB), probe(120), me({}), false)).resolves.toBeNull();
    await expect(precheckUpload(file(MB), probe(30), me({ plan: null, minutes: null }), true)).resolves.toEqual({
      paywall: { code: "subscription_required" },
    });
    // Minutes rounded to 0.1 when the exact seconds are missing.
    await expect(
      precheckUpload(file(MB), probe(30), me({ minutes: { limit: 60, used: 59.5, remaining: 0.5 } }), true),
    ).resolves.toBeNull();
    // An account with billing off (or none): nothing to check.
    await expect(precheckUpload(file(MB), probe(120), me({ billing: { enabled: false, enforce: false } }), true)).resolves.toBeNull();
  });
});
