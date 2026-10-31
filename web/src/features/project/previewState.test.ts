// The Vorschau's states from the job as GET /jobs/{id} answers it.
import { describe, expect, it, vi } from "vitest";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";
import { isExport, previewStateOf, renderFailed } from "./previewState";

const job = (o: Partial<JobStatus> = {}): JobStatus => ({
  id: "j1",
  status: "processing",
  message: "",
  progress: 10,
  error: null,
  has_output: false,
  ...o,
});

describe("previewStateOf", () => {
  it("names every status", () => {
    expect(previewStateOf(job({ status: "pending" }), false)).toBe("processing");
    expect(previewStateOf(job({ stage: "analyze.transcribe" }), false)).toBe("processing");
    expect(previewStateOf(job({ stage: "render.encode" }), false)).toBe("finishing");
    expect(previewStateOf(job({ status: "awaiting_review", progress: 100 }), false)).toBe("ready");
    expect(previewStateOf(job({ status: "awaiting_review", has_output: true }), false)).toBe("edited");
    expect(previewStateOf(job({ status: "done", has_output: true }), false)).toBe("done");
    expect(previewStateOf(job({ status: "error", error_code: "no_speech" }), false)).toBe("failed");
    expect(previewStateOf(job({ status: "cancelled" }), false)).toBe("failed");
  });

  it("a failed export is back in review: ready or edited", () => {
    expect(previewStateOf(job({ status: "awaiting_review", error_code: "render_failed" }), true)).toBe("ready");
    expect(previewStateOf(job({ status: "awaiting_review", error_code: "render_timeout", has_output: true }), true)).toBe("edited");
  });

  it("waiting for a render slot is the export when this tab started one or saw it in review", () => {
    const queued = job({ stage: "queued", message: "queued" });
    expect(previewStateOf(queued, false)).toBe("processing");
    expect(previewStateOf(queued, true)).toBe("finishing");
    // Exported before: a queued run can only be the next export.
    expect(previewStateOf({ ...queued, has_output: true }, false)).toBe("finishing");
    // Builds before the stage codes: the message says so.
    expect(previewStateOf(job({ stage: null, message: "Rendering…" }), false)).toBe("finishing");
    // The stage wins over the hint.
    expect(previewStateOf(job({ stage: "analyze.cuts" }), true)).toBe("processing");
  });

  it("reads this tab's export hint unless given", () => {
    const queued = job({ stage: "queued", message: "queued" });
    // No storage (outside a browser, blocked): no hint.
    expect(previewStateOf(queued)).toBe("processing");
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
    });
    try {
      expect(previewStateOf(queued)).toBe("processing");
      setExportHint("j1");
      expect(previewStateOf(queued)).toBe("finishing");
      expect(previewStateOf({ ...queued, id: "j2" })).toBe("processing");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isExport", () => {
  it("goes by the stage first", () => {
    expect(isExport({ stage: "render.prepare", message: "", has_output: false }, false)).toBe(true);
    expect(isExport({ stage: "analyze.normalize", message: "Rendering…", has_output: true }, true)).toBe(false);
    expect(isExport({ stage: null, message: "", has_output: false }, false)).toBe(false);
  });
});

describe("renderFailed", () => {
  it("is the failed export's code while the job is back in review", () => {
    for (const code of ["render_failed", "render_unavailable", "render_timeout"]) {
      expect(renderFailed(job({ status: "awaiting_review", error_code: code, error: "x" }))).toBe(code);
    }
    // A job from before UX5: the text only.
    expect(renderFailed(job({ status: "awaiting_review", error: "Render failed" }))).toBe("render_failed");
  });

  it("is null otherwise", () => {
    expect(renderFailed(job({ status: "awaiting_review" }))).toBeNull();
    expect(renderFailed(job({ status: "awaiting_review", error_code: null, error: null }))).toBeNull();
    expect(renderFailed(job({ status: "error", error_code: "no_speech", error: "x" }))).toBeNull();
    expect(renderFailed(job({ status: "processing", stage: "render.encode" }))).toBeNull();
    expect(renderFailed(job({ status: "done", has_output: true }))).toBeNull();
  });
});
