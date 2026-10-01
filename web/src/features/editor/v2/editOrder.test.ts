import { describe, expect, it } from "vitest";
import { coalesces } from "@/features/editor/timeline/history";
import { EditOrder, type Area } from "./editOrder";

/** Two fake histories driven like the shell drives them. */
function harness() {
  const order = new EditOrder();
  const stacks: Record<Area, { past: string[]; future: string[] }> = {
    tl: { past: [], future: [] },
    doc: { past: [], future: [] },
  };
  let last: { key: string; t: number } | null = null;
  const commitTl = (name: string, key?: string, now = 0) => {
    const merge = coalesces(last, key, now);
    last = key ? { key, t: now } : null;
    if (!merge) {
      stacks.tl.past.push(name);
      stacks.tl.future = [];
      order.record("tl");
    }
  };
  const commitDoc = (name: string) => {
    stacks.doc.past.push(name);
    stacks.doc.future = [];
    order.record("doc");
  };
  const step = (kind: "undo" | "redo") => {
    const a = order.take(kind, (x) => (kind === "undo" ? stacks[x].past : stacks[x].future).length > 0);
    if (!a) return null;
    const s = stacks[a];
    if (kind === "undo") s.future.unshift(s.past.pop()!);
    else s.past.push(s.future.shift()!);
    return kind === "undo" ? s.future[0] : s.past[s.past.length - 1];
  };
  return { commitTl, commitDoc, step };
}

describe("one undo order for text and timeline", () => {
  it("a coalesced slider drag is one step: ⌘Z goes drag → text → older cut", () => {
    const h = harness();
    h.commitTl("cut T0");
    h.commitDoc("word D1");
    h.commitTl("drag", "volume", 1000);
    h.commitTl("drag", "volume", 1100);
    h.commitTl("drag", "volume", 1200);
    expect(h.step("undo")).toBe("drag");
    expect(h.step("undo")).toBe("word D1");
    expect(h.step("undo")).toBe("cut T0");
    expect(h.step("undo")).toBeNull();
    expect(h.step("redo")).toBe("cut T0");
    expect(h.step("redo")).toBe("word D1");
    expect(h.step("redo")).toBe("drag");
    expect(h.step("redo")).toBeNull();
  });

  it("a new edit drops the redo order", () => {
    const h = harness();
    h.commitDoc("a");
    h.commitTl("b");
    expect(h.step("undo")).toBe("b");
    h.commitDoc("c");
    expect(h.step("redo")).toBeNull();
    expect(h.step("undo")).toBe("c");
    expect(h.step("undo")).toBe("a");
  });

  it("coalesces: same key within 1 s only", () => {
    expect(coalesces(null, "k", 0)).toBe(false);
    expect(coalesces({ key: "k", t: 0 }, "k", 999)).toBe(true);
    expect(coalesces({ key: "k", t: 0 }, "k", 1000)).toBe(false);
    expect(coalesces({ key: "k", t: 0 }, "j", 10)).toBe(false);
    expect(coalesces({ key: "k", t: 0 }, undefined, 10)).toBe(false);
  });
});
