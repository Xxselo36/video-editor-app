// Keys older builds left on the device: AppFlags removes them on every
// /app page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropRetiredKeys, RETIRED_KEYS } from "./retiredStorage";

describe("dropRetiredKeys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes the survey log and the voice-test mark, nothing else", () => {
    const store = new Map<string, string>([
      ["cleocuts.exports.v1", JSON.stringify({ seen: ["job:1"], lastSurvey: 1 })],
      ["cleocuts.voiceOnboardingSeen.v1", "1"],
      ["cleocuts.jobs.v2", "[]"],
      ["cleocuts.lang", "de"],
    ]);
    vi.stubGlobal("localStorage", { removeItem: (k: string) => void store.delete(k) });
    dropRetiredKeys();
    expect([...store.keys()]).toEqual(["cleocuts.jobs.v2", "cleocuts.lang"]);
    expect(RETIRED_KEYS).toEqual(["cleocuts.exports.v1", "cleocuts.voiceOnboardingSeen.v1"]);
  });

  it("blocked storage: tries every key, never throws", () => {
    const tried: string[] = [];
    vi.stubGlobal("localStorage", {
      removeItem: (k: string) => {
        tried.push(k);
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(() => dropRetiredKeys()).not.toThrow();
    expect(tried).toEqual([...RETIRED_KEYS]);
  });
});
