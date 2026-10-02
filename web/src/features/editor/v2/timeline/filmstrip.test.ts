import { describe, expect, it } from "vitest";
import { clipTiles, filmWindow, MAX_TILES_PER_CLIP, tileIndex, tileWidth, validMeta, type FilmstripMeta } from "./filmstrip";

// a 36 s landscape proxy: 36 tiles of 160×90, one a second
const LAND: FilmstripMeta = { n: 36, interval: 1, tileW: 160, tileH: 90 };
// a 10-minute portrait one: 200 tiles 3 s apart, 50×90
const TALL: FilmstripMeta = { n: 200, interval: 3, tileW: 50, tileH: 90 };
const ALL = { lo: -1e9, hi: 1e9 };

describe("tileIndex", () => {
  it("maps source seconds to the tile of their interval, clamped", () => {
    expect(tileIndex(0, LAND)).toBe(0);
    expect(tileIndex(0.99, LAND)).toBe(0);
    expect(tileIndex(1, LAND)).toBe(1);
    expect(tileIndex(3 * 0.1 * 10, LAND)).toBe(3); // 2.9999999…
    expect(tileIndex(35.7, LAND)).toBe(35);
    expect(tileIndex(99, LAND)).toBe(35);
    expect(tileIndex(-1, LAND)).toBe(0);
    expect(tileIndex(Number.NaN, LAND)).toBe(0);
    expect(tileIndex(8.9, TALL)).toBe(2);
    expect(tileIndex(9, TALL)).toBe(3);
  });
});

describe("tileWidth", () => {
  it("scales the tile to the clip height (desktop 52 px, phone 80 px)", () => {
    expect(tileWidth(LAND, 90)).toBe(160);
    expect(tileWidth(LAND, 52)).toBeCloseTo(92.444, 3);
    expect(tileWidth(TALL, 80)).toBeCloseTo(44.444, 3);
  });
});

describe("clipTiles", () => {
  it("fills the clip with tiles of its own source range", () => {
    // clip 10–14 s at 90 px/s: 360 px wide, tiles 160 px at h 90
    const tiles = clipTiles(LAND, { start: 10, end: 14, left: 900, width: 360, h: 90, ...ALL });
    expect(tiles.map((t) => t.x)).toEqual([0, 160, 320]);
    // slot centres 80, 240, 340 (the last one's centre: the clip's end) px → 10.89, 12.67, 13.78 s
    expect(tiles.map((t) => t.idx)).toEqual([10, 12, 13]);
    expect(tiles.every((t) => t.w === 160)).toBe(true);
  });

  it("shows the source of a reordered clip, not its timeline position", () => {
    const a = clipTiles(LAND, { start: 30, end: 32, left: 0, width: 320, h: 90, ...ALL });
    expect(a.map((t) => t.idx)).toEqual([30, 31]);
  });

  it("draws only the slots in the visible window", () => {
    const c = { start: 0, end: 600, left: 0, width: 60_000, h: 80, lo: 4000, hi: 5000 };
    const tiles = clipTiles(TALL, c);
    const dw = tileWidth(TALL, 80);
    expect(tiles[0].x).toBeLessThanOrEqual(4000);
    expect(tiles[0].x + dw).toBeGreaterThan(4000);
    expect(tiles[tiles.length - 1].x).toBeLessThan(5000);
    expect(tiles.length).toBe(Math.ceil(5000 / dw) - Math.floor(4000 / dw));
    // each tile: the frame under its centre
    for (const t of tiles) expect(t.idx).toBe(Math.floor((t.x + dw / 2) / 100 / 3));
  });

  it("offsets the window by the clip's left edge", () => {
    const tiles = clipTiles(LAND, { start: 0, end: 10, left: 1000, width: 1000, h: 90, lo: 0, hi: 1200 });
    expect(tiles.map((t) => t.x)).toEqual([0, 160]);
    expect(clipTiles(LAND, { start: 0, end: 10, left: 1000, width: 1000, h: 90, lo: 2100, hi: 3000 })).toEqual([]);
  });

  it("a clip narrower than a tile still gets one (cropped by the clip)", () => {
    const tiles = clipTiles(LAND, { start: 5, end: 5.2, left: 0, width: 18, h: 52, ...ALL });
    expect(tiles).toEqual([{ x: 0, w: tileWidth(LAND, 52), idx: 5 }]);
  });

  it("caps the slots of one clip", () => {
    const tiles = clipTiles(TALL, { start: 0, end: 600, left: 0, width: 1e7, h: 4, ...ALL });
    expect(tiles.length).toBe(MAX_TILES_PER_CLIP);
  });

  it("nothing for an empty clip or a broken size", () => {
    expect(clipTiles(LAND, { start: 3, end: 3, left: 0, width: 100, h: 52, ...ALL })).toEqual([]);
    expect(clipTiles(LAND, { start: 0, end: 3, left: 0, width: 0, h: 52, ...ALL })).toEqual([]);
    expect(clipTiles(LAND, { start: 0, end: 3, left: 0, width: 100, h: 0, ...ALL })).toEqual([]);
  });
});

describe("filmWindow", () => {
  it("snaps outward so small scrolls keep the same window", () => {
    expect(filmWindow(0, 1400)).toEqual({ lo: -1400, hi: 3056 });
    expect(filmWindow(255, 1400)).toEqual(filmWindow(0, 1400));
    expect(filmWindow(256, 1400)).toEqual({ lo: -1144, hi: 3312 });
    for (const x of [0, 77, 4999, 5000, 12345]) {
      const w = filmWindow(x, 358);
      expect(w.lo).toBeLessThanOrEqual(x - 358);
      expect(w.hi).toBeGreaterThanOrEqual(x + 2 * 358);
    }
  });
});

describe("validMeta", () => {
  it("accepts the backend's meta only", () => {
    expect(validMeta(LAND)).toBe(true);
    expect(validMeta(null)).toBe(false);
    expect(validMeta({ n: 3, interval: 1, tileW: 0, tileH: 90 })).toBe(false);
    expect(validMeta({ n: "3", interval: 1, tileW: 160, tileH: 90 })).toBe(false);
  });
});
