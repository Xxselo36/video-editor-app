// The start screen's iOS hints: who counts as an iPhone/iPad.
import { describe, expect, it } from "vitest";
import { isIOS } from "./ios";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("isIOS", () => {
  it("is true for iPhone, iPod and an old iPad user agent", () => {
    expect(isIOS({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: IPHONE.replace(/iPhone/g, "iPod"), platform: "iPod", maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: IPHONE.replace(/iPhone/g, "iPad"), platform: "iPad", maxTouchPoints: 5 })).toBe(true);
  });
  it("is true for an iPad in desktop mode (a Mac user agent with touch)", () => {
    expect(isIOS({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
  });
  it("is false for a Mac, Android, Windows and no navigator", () => {
    expect(isIOS({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIOS({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
    expect(isIOS({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 10 })).toBe(false);
    expect(isIOS(undefined)).toBe(false);
  });
});
