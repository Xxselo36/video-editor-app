import { describe, expect, it } from "vitest";
import { cutRange } from "@/features/editor/state/cuts";
import { buildPlan, EditPlayer, fadeLevel, locate, nextInSource, seekRampLevel, type PlaySeg } from "@/lib/editPlayback";

const seg = (id: string, start: number, end: number, extra: Partial<PlaySeg> = {}): PlaySeg => ({
  id,
  start,
  end,
  speed: 1,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...extra,
});

describe("buildPlan", () => {
  it("keeps the timeline order and fills in default effects", () => {
    const plan = buildPlan(
      [
        { id: "b", start: 7, end: 14 },
        { id: "a", start: 0, end: 6, speed: 2 },
      ],
      30,
    );
    expect(plan).toEqual([seg("b", 7, 14), seg("a", 0, 6, { speed: 2 })]);
  });

  it("drops disabled and too-short clips, clamps to the video", () => {
    const plan = buildPlan(
      [
        { id: "off", start: 0, end: 5, disabled: true },
        { id: "tiny", start: 5, end: 5.04 },
        { id: "neg", start: -1, end: 2 },
        { id: "long", start: 28, end: 40 },
      ],
      30,
    );
    expect(plan.map((s) => [s.id, s.start, s.end])).toEqual([
      ["neg", 0, 2],
      ["long", 28, 30],
    ]);
  });

  it("does not clamp the end when the duration is unknown", () => {
    expect(buildPlan([{ id: "x", start: 1, end: 99 }], 0)[0].end).toBe(99);
  });

  it("clamps effects like the backend", () => {
    const [s] = buildPlan(
      [{ id: "x", start: 0, end: 10, speed: 9, volume: 7, fadeIn: -1, fadeOut: 5 }],
      10,
    );
    expect(s).toMatchObject({ speed: 4, volume: 2.5, fadeIn: 0, fadeOut: 2 });
    const [t] = buildPlan([{ id: "y", start: 0, end: 10, speed: 0.1, volume: NaN }], 10);
    expect(t).toMatchObject({ speed: 0.25, volume: 1 });
  });
});

describe("locate", () => {
  const plan = [seg("c2", 7, 14), seg("c1", 0, 6), seg("c3", 15, 22)];

  it("finds the clip showing a source time, in timeline order", () => {
    expect(locate(plan, 8)).toBe(0);
    expect(locate(plan, 3)).toBe(1);
    expect(locate(plan, 21.9)).toBe(2);
  });

  it("returns -1 inside a cut and at a clip's end", () => {
    expect(locate(plan, 6.5)).toBe(-1);
    expect(locate(plan, 14)).toBe(-1);
    expect(locate(plan, 22)).toBe(-1);
  });

  it("accepts a position a hair before the clip (seek targets)", () => {
    expect(locate(plan, 6.985)).toBe(0);
    expect(locate(plan, 6.97)).toBe(-1);
  });

  it("prefers the given clip when two show the same footage", () => {
    const dup = [seg("a", 0, 10), seg("b", 5, 15)];
    expect(locate(dup, 7)).toBe(0);
    expect(locate(dup, 7, "b")).toBe(1);
    // The preferred clip doesn't contain t: first match again.
    expect(locate(dup, 2, "b")).toBe(0);
    expect(locate(dup, 2, "missing")).toBe(0);
  });
});

describe("nextInSource", () => {
  const plan = [seg("c2", 7, 14), seg("c1", 0, 6), seg("c3", 15, 22)];

  it("is the clip with the earliest start at or after t", () => {
    expect(nextInSource(plan, 6.2)).toBe(0);
    expect(nextInSource(plan, 14.5)).toBe(2);
    expect(nextInSource(plan, -5)).toBe(1);
  });

  it("tolerates a position just past a clip start", () => {
    expect(nextInSource(plan, 7.01)).toBe(0);
    expect(nextInSource(plan, 7.05)).toBe(2);
  });

  it("returns -1 when nothing follows", () => {
    expect(nextInSource(plan, 20)).toBe(-1);
    expect(nextInSource([], 0)).toBe(-1);
  });
});

describe("fadeLevel", () => {
  it("is 1 without fades", () => {
    expect(fadeLevel(seg("x", 10, 20), 15)).toBe(1);
  });

  it("ramps in and out linearly", () => {
    const s = seg("x", 10, 20, { fadeIn: 1, fadeOut: 2 });
    expect(fadeLevel(s, 10)).toBe(0);
    expect(fadeLevel(s, 10.5)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 11)).toBe(1);
    expect(fadeLevel(s, 19)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 20)).toBe(0);
  });

  it("measures fades in output time (after speed)", () => {
    // 2x: 4 s of source are 2 s of output; a 1 s fade covers 2 s of source.
    const s = seg("x", 0, 4, { speed: 2, fadeIn: 1 });
    expect(fadeLevel(s, 1)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 2)).toBe(1);
  });

  it("caps each fade at half the clip", () => {
    const s = seg("x", 0, 2, { fadeIn: 2, fadeOut: 2 });
    expect(fadeLevel(s, 0.5)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 1)).toBeCloseTo(1);
    expect(fadeLevel(s, 1.5)).toBeCloseTo(0.5);
  });

  it("clamps times outside the clip", () => {
    const s = seg("x", 10, 20, { fadeIn: 1 });
    expect(fadeLevel(s, 5)).toBe(0);
    expect(fadeLevel(s, 25)).toBe(1);
  });
});

describe("seekRampLevel (UX10, review C9)", () => {
  it("is off without a ramp (the v1 editor)", () => {
    expect(seekRampLevel(0, true, 0, 0)).toBe(1);
  });

  it("holds 0 while the jump is on its way, ramps up over rampMs after it landed", () => {
    expect(seekRampLevel(15, true, null, null)).toBe(0);
    expect(seekRampLevel(15, false, 0, null)).toBe(0);
    expect(seekRampLevel(15, false, 7.5, null)).toBeCloseTo(0.5);
    expect(seekRampLevel(15, false, 15, null)).toBe(1);
    expect(seekRampLevel(15, false, null, null)).toBe(1);
  });

  it("ramps down over the last rampMs before a jump", () => {
    expect(seekRampLevel(15, false, null, 0.1)).toBe(1);
    expect(seekRampLevel(15, false, null, 0.0075)).toBeCloseTo(0.5);
    expect(seekRampLevel(15, false, null, 0)).toBe(0);
    // just landed and the next jump close: the lower one wins
    expect(seekRampLevel(15, false, 12, 0.003)).toBeCloseTo(0.2);
  });
});

describe("EditPlayer.setPlan keeps the playhead through a cut earlier in its clip (UX10, review 4)", () => {
  function fakeVideo(t: number) {
    const seeks: number[] = [];
    let cur = t;
    const v = {
      paused: true,
      ended: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      readyState: 4,
      get currentTime() {
        return cur;
      },
      set currentTime(x: number) {
        cur = x;
        seeks.push(x);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return { v: v as unknown as HTMLVideoElement, seeks };
  }

  it("cutting 'äh' (8.0–8.3) with the playhead at 9.5 in the same clip: no seek", () => {
    const { v, seeks } = fakeVideo(0);
    const p = new EditPlayer(v);
    p.setPlan(buildPlan([{ id: "A", start: 0, end: 20 }], 20));
    v.currentTime = 9.5; // played on to 9.5
    seeks.length = 0;
    const after = cutRange([{ id: "A", start: 0, end: 20 }], 7.95, 8.4, 20);
    expect(after.map((s) => s.id)).toEqual(["A", "A~c"]);
    p.setPlan(buildPlan(after, 20));
    expect(seeks).toEqual([]);
    expect(v.currentTime).toBe(9.5);
    p.destroy();
  });

  it("the playhead inside the cut still moves to the cut's end; a trim past it to the next clip", () => {
    const { v, seeks } = fakeVideo(0);
    const p = new EditPlayer(v);
    p.setPlan(buildPlan([{ id: "A", start: 0, end: 20 }], 20));
    v.currentTime = 8.1;
    seeks.length = 0;
    p.setPlan(buildPlan(cutRange([{ id: "A", start: 0, end: 20 }], 7.95, 8.4, 20), 20));
    expect(seeks).toEqual([8.4]);
    p.destroy();
    const b = fakeVideo(0);
    const q = new EditPlayer(b.v);
    q.setPlan(
      buildPlan(
        [
          { id: "A", start: 0, end: 6 },
          { id: "B", start: 10, end: 12 },
        ],
        20,
      ),
    );
    b.v.currentTime = 5;
    b.seeks.length = 0;
    q.setPlan(
      buildPlan(
        [
          { id: "A", start: 0, end: 4 },
          { id: "B", start: 10, end: 12 },
        ],
        20,
      ),
    );
    expect(b.seeks).toEqual([10]);
    q.destroy();
  });
});
