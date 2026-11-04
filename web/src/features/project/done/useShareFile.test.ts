// The export's files and when the Vorschau fetches one ahead (plan D21).
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadHref, exportFiles, prefetchAhead } from "./useShareFile";

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

// PR2 live test (D1): after Fine-tune and a second export, Download
// saved the first one: every export had the same link, and the browser
// answered it with the first export's redirect from its cache.
describe("downloadHref", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a link of its own per export: the export's generation in it", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.test");
    const first = downloadHref({ id: "j1", renders_ok: 1 }, "primary");
    const second = downloadHref({ id: "j1", renders_ok: 2 }, "primary");
    expect(second).not.toBe(first);
    const q = new URL(second).searchParams;
    expect(new URL(second).pathname).toBe("/jobs/j1/download");
    expect([q.get("format"), q.get("name"), q.get("v")]).toEqual(["primary", "v2", "2"]);
    // an export the server doesn't count (an instant one, or one from before the counter)
    expect(new URL(downloadHref({ id: "j1" }, "1:1")).searchParams.get("v")).toBe("0");
  });
});
