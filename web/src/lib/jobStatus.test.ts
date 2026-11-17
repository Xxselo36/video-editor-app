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

  it("keeps what a Projekte row shows: name, lengths, poster flag, lifetime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jobs: [
            {
              id: "a", status: "awaiting_review", message: "", progress: 100, title: "Morgenroutine", duration: 134.2,
              output_seconds: 104.5, has_poster: true, created_at: 1_800_000_000, expires_at: 1_801_209_600,
            },
            { id: "b", status: "processing", message: "", progress: 10 },
          ],
          missing: [],
        }),
      ),
    );
    const res = await new JobStatusPoller().poll(["a", "b"]);
    const [a, b] = res!.rows;
    expect(a).toMatchObject({
      title: "Morgenroutine", duration: 134.2, output_seconds: 104.5, has_poster: true,
      created_at: 1_800_000_000, expires_at: 1_801_209_600,
    });
    // A server from before (or a job still being analysed) says less.
    expect(b).toMatchObject({ title: null, duration: null, output_seconds: null, has_poster: false, created_at: null, expires_at: null });
  });

  it("an unchanged answer (304) hands out the rows of before, the row fields too", async () => {
    const answers = [
      Response.json(
        { jobs: [{ id: "a", status: "done", message: "", progress: 100, title: "Clip", output_seconds: 52, has_poster: true }], missing: [] },
        { headers: { ETag: 'W/"1"' } },
      ),
      new Response(null, { status: 304, headers: { ETag: 'W/"1"' } }),
    ];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const poller = new JobStatusPoller();
    const first = await poller.poll(["a"]);
    const second = await poller.poll(["a"]);
    expect(second?.changed).toBe(false);
    expect(second?.rows).toEqual(first?.rows);
    expect(second?.rows[0]).toMatchObject({ title: "Clip", output_seconds: 52, has_poster: true });
  });
});
