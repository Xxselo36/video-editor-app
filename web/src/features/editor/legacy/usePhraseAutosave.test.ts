import { describe, expect, it } from "vitest";
import { phraseSaveInit } from "./usePhraseAutosave";

const P = (text: string) => ({ start: 0, end: 1, original_start: 0, original_end: 1, text, confidence: 1 });

describe("phrase save request", () => {
  it("keepalive only while unloading and under 60 000 bytes (v1, unchanged)", () => {
    expect(phraseSaveInit([P("a")], 1, true).keepalive).toBe(true);
    expect(phraseSaveInit([P("a")], 1, false).keepalive).toBe(false);
    const big = Array.from({ length: 700 }, () => P("x".repeat(80)));
    expect(phraseSaveInit(big, 1, true).keepalive).toBe(false);
  });

  it("v2 with an edit doc: never keepalive, the doc PATCH keeps the 64 KiB budget", () => {
    const init = phraseSaveInit([P("a")], 1, true, false);
    expect(init.keepalive).toBe(false);
    expect(init.unloading).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ phrases: [P("a")], rev: 1 });
  });
});
