/**
 * DocSaver.settle (UT5 review 14): an export starts only when the server
 * has the doc's latest change — a transient failure is tried again at
 * once, a conflict or a refusal says "not saved".
 */
import { describe, expect, it } from "vitest";
import type { EditDoc } from "./doc";
import { DocSaver } from "./docSave";

const base: EditDoc = {
  v: 2,
  language: "en",
  words: [{ id: "w0001", text: "Hi", start: 0, end: 0.3 }],
  clips: null,
  style: { presetId: "power", overrides: {} },
  format: { aspect: "9:16" },
  rev: 0,
};
const changed: EditDoc = { ...base, style: { presetId: "karaoke", overrides: {} } };

function saver(answers: (() => Response | Promise<Response>)[]) {
  let n = 0;
  return new DocSaver(base, 0, {
    jobId: "j",
    fetch: async () => (answers[Math.min(n++, answers.length - 1)])(),
    setTimer: () => 0, // backoff timers never fire on their own here
    clearTimer: () => {},
  });
}
const ok = () => new Response(JSON.stringify({ rev: 1 }), { status: 200 });
const busy = () => new Response("{}", { status: 503 });
const refused = () => new Response(JSON.stringify({ detail: "bad_style" }), { status: 400 });
const stale = () => new Response(JSON.stringify({ detail: "stale_rev", rev: 7 }), { status: 409 });

describe("DocSaver.settle", () => {
  it("true once the change is saved", async () => {
    const s = saver([ok]);
    s.schedule(changed);
    expect(await s.settle()).toBe(true);
  });

  it("a transient failure is tried again at once", async () => {
    const s = saver([busy, ok]);
    s.schedule(changed);
    expect(await s.settle()).toBe(true);
  });

  it("still failing, refused or in conflict: false (the export doesn't start)", async () => {
    const down = saver([busy]);
    down.schedule(changed);
    expect(await down.settle()).toBe(false);
    const no = saver([refused]);
    no.schedule(changed);
    expect(await no.settle()).toBe(false);
    const conflict = saver([stale]);
    conflict.schedule(changed);
    expect(await conflict.settle()).toBe(false);
  });

  it("nothing pending: true", async () => {
    expect(await saver([ok]).settle()).toBe(true);
  });
});
