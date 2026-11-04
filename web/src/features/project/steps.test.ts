// The processing checklist shows only the steps the job goes through.
import { describe, expect, it } from "vitest";
import { stepsFor, type Step } from "./steps";

const ids = (steps: Step[]) => steps.map((s) => s.id);
/** The step a stage shows as current. */
const stepOf = (steps: Step[], stage: string) => steps.find((s) => s.stages.includes(stage))?.id;

describe("stepsFor", () => {
  it("shows every step of a job that cuts and gets captions", () => {
    expect(ids(stepsFor({}))).toEqual(["uploaded", "listening", "cutting", "captions", "ready"]);
    expect(ids(stepsFor({ no_cuts: false, captions_off: false }))).toEqual(["uploaded", "listening", "cutting", "captions", "ready"]);
    expect(stepOf(stepsFor({}), "analyze.cuts")).toBe("cutting");
  });

  it("hides cutting for captions only", () => {
    expect(ids(stepsFor({ no_cuts: true }))).toEqual(["uploaded", "listening", "captions", "ready"]);
  });

  it("hides captions without captions", () => {
    expect(ids(stepsFor({ captions_off: true }))).toEqual(["uploaded", "listening", "cutting", "ready"]);
  });

  it("hides both", () => {
    expect(ids(stepsFor({ no_cuts: true, captions_off: true }))).toEqual(["uploaded", "listening", "ready"]);
  });

  it("a hidden step's stages count for the step before it: the list never steps back", () => {
    const noCuts = stepsFor({ no_cuts: true });
    expect(stepOf(noCuts, "analyze.cleanup")).toBe("listening");
    expect(stepOf(noCuts, "analyze.cuts")).toBe("listening");
    expect(stepOf(noCuts, "analyze.captions")).toBe("captions");
    expect(stepOf(stepsFor({ captions_off: true }), "analyze.captions")).toBe("cutting");
    const neither = stepsFor({ no_cuts: true, captions_off: true });
    expect(stepOf(neither, "analyze.cuts")).toBe("listening");
    expect(stepOf(neither, "analyze.captions")).toBe("listening");
    expect(stepOf(neither, "analyze.done")).toBe("ready");
  });

  it("never changes the full list", () => {
    stepsFor({ no_cuts: true, captions_off: true });
    expect(stepsFor({}).find((s) => s.id === "listening")?.stages).toEqual([
      "queued",
      "analyze.normalize",
      "analyze.smartcam",
      "analyze.transcribe",
    ]);
  });
});
