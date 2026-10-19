import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { timelinePayload } from "./timelineSave";
import { decideUnsaved } from "./unsaved";

const clip = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });
const mine = [clip("a", 0, 5), clip("b", 6, 8)];
const server = [clip("a", 0, 5), clip("b", 6, 10)];

describe("edits left unsaved on this device (save-11)", () => {
  const backup = { segs: mine, base: 100, known: [100, 150], at: 0 };

  it("the server has them: nothing to offer", () => {
    expect(decideUnsaved(backup, { rev: 150, segments: timelinePayload(mine) }, 30)).toEqual({ kind: "none" });
    expect(decideUnsaved(null, { rev: 1, segments: [] }, 30)).toEqual({ kind: "none" });
  });

  it("nobody saved since (the rev the edit was made on, or one of this device's): back by themselves", () => {
    expect(decideUnsaved(backup, { rev: 100, segments: timelinePayload(server) }, 30).kind).toBe("auto");
    expect(decideUnsaved(backup, { rev: 150, segments: timelinePayload(server) }, 30).kind).toBe("auto");
  });

  it("another tab or device saved since: offered, never applied by itself", () => {
    const d = decideUnsaved(backup, { rev: 999, segments: timelinePayload(server) }, 30);
    expect(d.kind).toBe("offer");
    expect(d.kind !== "none" && d.segs).toEqual(mine);
  });
});
