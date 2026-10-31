// The export's files and when the Vorschau fetches one ahead (plan D21).
import { describe, expect, it } from "vitest";
import { exportFiles, prefetchAhead } from "./useShareFile";

describe("exportFiles", () => {
  it("lists one file per format, the primary first in line", () => {
    const { all, primary } = exportFiles({
      downloads: [
        { format: "16:9", bytes: 9_000_000 },
        { format: "primary", bytes: 12_000_000 },
      ],
      outputs: ["primary", "16:9", "hook_1"],
    });
    expect(all.map((d) => d.format)).toEqual(["16:9", "primary"]);
    expect(primary).toEqual({ format: "primary", bytes: 12_000_000 });
  });

  it("reads the outputs of a server before UX11, bonus clips left out", () => {
    const { all, primary } = exportFiles({ outputs: ["primary", "hook_1", "1:1"] });
    expect(all).toEqual([
      { format: "primary", bytes: null },
      { format: "1:1", bytes: null },
    ]);
    expect(primary?.format).toBe("primary");
  });

  it("falls back to the primary, and to the first file without one", () => {
    expect(exportFiles({}).primary).toEqual({ format: "primary", bytes: null });
    expect(exportFiles({ downloads: [{ format: "9:16", bytes: 1 }] }).primary?.format).toBe("9:16");
  });
});

describe("prefetchAhead", () => {
  it("fetches only an export that finished while the page was open", () => {
    expect(prefetchAhead(true, undefined)).toBe(true);
    expect(prefetchAhead(false, undefined)).toBe(false);
    expect(prefetchAhead(false, { type: "wifi" })).toBe(false);
  });

  it("never on Data Saver or mobile data", () => {
    expect(prefetchAhead(true, { saveData: true })).toBe(false);
    expect(prefetchAhead(true, { type: "cellular" })).toBe(false);
    expect(prefetchAhead(true, { saveData: false, type: "wifi" })).toBe(true);
  });
});
