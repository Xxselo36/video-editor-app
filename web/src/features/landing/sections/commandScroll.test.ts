import { describe, expect, it } from "vitest";
import {
  CHROME_BOTTOM,
  CHROME_TOP,
  LANE_GAP,
  fallbackProgress,
  inFlight,
  laneLengths,
  laneStarts,
  middleLine,
  progress,
} from "./commandScroll";

/** The strips' centres as measured on the landing (document px). */
const PHONE = { vh: 844, bottom: CHROME_BOTTOM, len: 140, centres: [1086, 1268, 1450, 1606, 1762] };
const DESKTOP = { vh: 900, bottom: 0, len: 128, centres: [1215, 1359, 1504, 1688, 1833] };

/** A layout's lanes, as the page lays them out: probe tops M above the
 *  centres, lengths clamped by the pitch. */
function lanes(centres: number[], mid: number, len: number) {
  const starts = laneStarts(centres, mid);
  return { starts, lens: laneLengths(starts, len) };
}

/** At every 0.25 px of scroll from 200 px before the first lane to 200 px
 *  after the last: at most one row in flight, every row before it
 *  edited (1), every row after it waiting (0). */
function sweep(starts: number[], lens: number[]) {
  const from = starts[0] - 200;
  const to = starts[starts.length - 1] + lens[lens.length - 1] + 200;
  let bad = 0;
  for (let y = from; y <= to; y += 0.25) {
    const ps = starts.map((s, i) => progress(y, s, lens[i]));
    const flying = inFlight(ps);
    if (flying.length > 1) bad++;
    // The row on the line, or the boundary between edited and waiting.
    const k = flying.length ? flying[0] : ps.findIndex((p) => p === 0);
    const edge = k < 0 ? ps.length : k;
    for (let i = 0; i < ps.length; i++) {
      if (i < edge && ps[i] !== 1) bad++;
      if (i > edge && ps[i] !== 0) bad++;
    }
  }
  return bad;
}

/** A small deterministic PRNG (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the middle line", () => {
  it("is the middle of what the header and the phone bar leave clear", () => {
    expect(middleLine(844, CHROME_TOP, CHROME_BOTTOM)).toBe(414.5);
    expect(middleLine(900, CHROME_TOP, 0)).toBe(482.5);
    expect(middleLine(900)).toBe(482.5);
  });

  it("matches Cleanup.module.css --scrub-mid: (vh − 15px) / 2 on phones, (vh + 65px) / 2 from 768px", () => {
    for (const vh of [568, 667, 844, 932]) expect(middleLine(vh, CHROME_TOP, CHROME_BOTTOM)).toBe((vh - 15) / 2);
    for (const vh of [700, 900, 1200]) expect(middleLine(vh, CHROME_TOP, 0)).toBe((vh + 65) / 2);
  });
});

describe("the lanes", () => {
  it("start when a strip's centre is on the line and run one lane (the measured table)", () => {
    const phone = lanes(PHONE.centres, middleLine(PHONE.vh, CHROME_TOP, PHONE.bottom), PHONE.len);
    expect(phone.starts).toEqual([671.5, 853.5, 1035.5, 1191.5, 1347.5]);
    expect(phone.lens).toEqual([140, 140, 140, 140, 140]);
    expect(phone.starts.map((s, i) => s + phone.lens[i])).toEqual([811.5, 993.5, 1175.5, 1331.5, 1487.5]);

    const desktop = lanes(DESKTOP.centres, middleLine(DESKTOP.vh, CHROME_TOP, DESKTOP.bottom), DESKTOP.len);
    expect(desktop.starts).toEqual([732.5, 876.5, 1021.5, 1205.5, 1350.5]);
    expect(desktop.lens).toEqual([128, 128, 128, 128, 128]);
    expect(desktop.starts.map((s, i) => s + desktop.lens[i])).toEqual([860.5, 1004.5, 1149.5, 1333.5, 1478.5]);
  });

  it("leave a still gap before the next lane (phone 42/42/16/16, desktop 16/17/56/17)", () => {
    const gaps = ({ centres, vh, bottom, len }: typeof PHONE) => {
      const { starts, lens } = lanes(centres, middleLine(vh, CHROME_TOP, bottom), len);
      return starts.slice(1).map((s, i) => s - (starts[i] + lens[i]));
    };
    expect(gaps(PHONE)).toEqual([42, 42, 16, 16]);
    expect(gaps(DESKTOP)).toEqual([16, 17, 56, 17]);
  });

  it("are shortened where two strips sit closer than a lane", () => {
    expect(laneLengths([0, 130, 400], 140)).toEqual([130 - LANE_GAP, 140, 140]);
    expect(laneLengths([0, 130], 140)[0]).toBe(118);
    // the last one keeps the CSS length
    expect(laneLengths([0, 500], 140)).toEqual([140, 140]);
  });
});

describe("progress", () => {
  it("is 0 at the lane's start, ½ half way, 1 at its end, clamped and never back", () => {
    expect(progress(671.5, 671.5, 140)).toBe(0);
    expect(progress(741.5, 671.5, 140)).toBe(0.5);
    expect(progress(811.5, 671.5, 140)).toBe(1);
    expect(progress(0, 671.5, 140)).toBe(0);
    expect(progress(5000, 671.5, 140)).toBe(1);
    let prev = 0;
    for (let y = 600; y < 900; y += 0.5) {
      const p = progress(y, 671.5, 140);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("reads the same from the list's top on screen (the fallback)", () => {
    const listY = 998;
    for (const off of [-327.5, -145.5, 36.5])
      for (let y = 400; y < 1600; y += 7.25) {
        const start = listY + off;
        expect(fallbackProgress(listY - y, off, 140)).toBeCloseTo(progress(y, start, 140), 12);
      }
  });

  it("counts the rows in flight", () => {
    expect(inFlight([1, 1, 0.4, 0, 0])).toEqual([2]);
    expect(inFlight([1, 1, 0, 0, 0])).toEqual([]);
    expect(inFlight([1, 0.2, 0.9, 0, 0])).toEqual([1, 2]);
  });
});

describe("one row at a time", () => {
  it("on the measured phone and desktop layouts, at every 0.25 px", () => {
    for (const { centres, vh, bottom, len } of [PHONE, DESKTOP]) {
      const { starts, lens } = lanes(centres, middleLine(vh, CHROME_TOP, bottom), len);
      expect(sweep(starts, lens)).toBe(0);
    }
  });

  it("on 1000 random layouts (pitches 0.5–3 lanes), at every 0.25 px", () => {
    const next = random(74);
    let bad = 0;
    for (let n = 0; n < 1000; n++) {
      const len = 100 + next() * 60;
      const centres = [600 + next() * 600];
      for (let i = 1; i < 5; i++) centres.push(centres[i - 1] + len * (0.5 + next() * 2.5));
      const { starts, lens } = lanes(centres, 300 + next() * 300, len);
      bad += sweep(starts, lens);
    }
    expect(bad).toBe(0);
  });
});
