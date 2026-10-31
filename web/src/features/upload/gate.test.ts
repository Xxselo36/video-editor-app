// The upload gate (D1): POST /jobs waits for it; only "Let's go" opens it.
import { describe, expect, it } from "vitest";
import { createGate } from "./gate";

describe("createGate", () => {
  it("opens once: later opens change nothing", async () => {
    const gate = createGate();
    expect(gate.isOpen).toBe(false);
    gate.open();
    gate.open();
    expect(gate.isOpen).toBe(true);
    await expect(gate.promise).resolves.toBeUndefined();
  });

  it("a wait that began before it opened goes on only after", async () => {
    const gate = createGate();
    const seen: string[] = [];
    const waiting = gate.promise.then(() => seen.push("through"));
    await Promise.resolve();
    seen.push("open");
    gate.open();
    await waiting;
    expect(seen).toEqual(["open", "through"]);
  });

  it("createGate(true) is open from the start", async () => {
    const gate = createGate(true);
    expect(gate.isOpen).toBe(true);
    await expect(gate.promise).resolves.toBeUndefined();
  });
});
