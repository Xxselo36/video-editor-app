// GET /jobs/status rows (the anonymous Projects page's poll): what a tile
// needs comes through, the export's generation too (PR2 live test D1:
// the ⋯ menu's download link is its own per export).
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStatusPoller } from "./jobStatus";

afterEach(() => vi.unstubAllGlobals());

describe("JobStatusPoller", () => {
  it("keeps the export's generation of each row, 0 from a server that doesn't say", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jobs: [
            { id: "a", status: "done", message: "Done", progress: 100, has_output: true, renders_ok: 2 },
            { id: "b", status: "done", message: "Done", progress: 100, has_output: true },
          ],
          missing: [],
        }),
      ),
    );
    const res = await new JobStatusPoller().poll(["a", "b"]);
    expect(res?.rows.map((r) => [r.id, r.renders_ok])).toEqual([
      ["a", 2],
      ["b", 0],
    ]);
  });
});
