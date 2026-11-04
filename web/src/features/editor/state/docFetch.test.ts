// GET /jobs/{id}/doc as the editor and the Vorschau read it (docFetch.ts):
// the export's caption engine, the style an export draws now (only a
// live one) and the doc shown with that style.
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let answer: () => Response = () => new Response("{}", { status: 500 });

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    calls.push(path);
    return answer();
  }),
}));

import type { EditDoc } from "./doc";
import { docCaptions, fetchDoc, isStyle, withRenderStyle } from "./docFetch";

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const DOC: EditDoc = {
  v: 2,
  language: "de",
  words: [{ id: "w1", text: "Hallo", start: 0.2, end: 0.6 }],
  clips: null,
  style: { presetId: "power", overrides: {} },
  format: { aspect: "9:16" },
  rev: 3,
};

describe("docCaptions", () => {
  it("keeps the engines it knows; anything else is v1", () => {
    expect(docCaptions({ caption_engine: "v2" }).engine).toBe("v2");
    expect(docCaptions({ caption_engine: "optin" }).engine).toBe("optin");
    for (const e of ["v1", "off", null, undefined, 2]) expect(docCaptions({ caption_engine: e }).engine).toBe("v1");
  });

  it("reads the live presets and the recommended ones, strings only", () => {
    expect(docCaptions({ presets_live: ["power", 7, "mega"], recommended: ["mega", null] })).toEqual({
      engine: "v1",
      presetsLive: ["power", "mega"],
      recommended: ["mega"],
    });
    // no live list: every preset (an older server)
    expect(docCaptions({})).toEqual({ engine: "v1", presetsLive: null, recommended: [] });
  });
});

describe("isStyle", () => {
  it("is an object with a preset id", () => {
    expect(isStyle({ presetId: "power", overrides: {} })).toBe(true);
    expect(isStyle({ presetId: "none" })).toBe(true);
    for (const v of [null, undefined, "power", {}, { presetId: 3 }]) expect(isStyle(v)).toBe(false);
  });
});

describe("fetchDoc", () => {
  it("reads the doc, its rev and the style an export draws now", async () => {
    answer = () =>
      json({
        doc: DOC,
        rev: 7,
        read_only: true,
        caption_engine: "v2",
        render_style: { presetId: "mega", overrides: { y: 0.7 } },
        presets_live: ["power", "mega"],
        recommended: ["mega"],
      });
    expect(await fetchDoc("job1")).toEqual({
      doc: DOC,
      rev: 7,
      read_only: true,
      captions: { engine: "v2", presetsLive: ["power", "mega"], recommended: ["mega"] },
      renderStyle: { presetId: "mega", overrides: { y: 0.7 } },
    });
    expect(calls.at(-1)).toBe("/jobs/job1/doc");
  });

  it("drops a render style that isn't live (PATCH would refuse it); without a live list any style goes", async () => {
    answer = () => json({ doc: DOC, render_style: { presetId: "classic", overrides: {} }, presets_live: ["power"] });
    expect((await fetchDoc("job1"))?.renderStyle).toBeNull();
    answer = () => json({ doc: DOC, render_style: { presetId: "classic", overrides: {} } });
    expect((await fetchDoc("job1"))?.renderStyle).toEqual({ presetId: "classic", overrides: {} });
    answer = () => json({ doc: DOC, render_style: "classic" });
    expect((await fetchDoc("job1"))?.renderStyle).toBeNull();
  });

  it("an answer without a rev is rev 0, and not read-only", async () => {
    answer = () => json({ doc: DOC });
    expect(await fetchDoc("job1")).toMatchObject({ rev: 0, read_only: false });
  });

  it("no doc: a refusal (404 no_doc, 409 doc_not_ready) or a doc without words", async () => {
    answer = () => json({ detail: "no_doc" }, 404);
    expect(await fetchDoc("job1")).toBeNull();
    answer = () => json({ detail: "doc_not_ready" }, 409);
    expect(await fetchDoc("job1")).toBeNull();
    answer = () => json({ doc: { ...DOC, words: null } });
    expect(await fetchDoc("job1")).toBeNull();
    answer = () => json(null);
    expect(await fetchDoc("job1")).toBeNull();
  });
});

describe("withRenderStyle", () => {
  it("shows the doc with the style an export draws now", () => {
    const style = { presetId: "mega", overrides: { y: 0.7 } };
    expect(withRenderStyle(DOC, style)).toEqual({ ...DOC, style });
  });

  it("the doc itself when that is its own style, or there is none", () => {
    expect(withRenderStyle(DOC, { presetId: "power", overrides: {} })).toBe(DOC);
    expect(withRenderStyle(DOC, null)).toBe(DOC);
  });
});
