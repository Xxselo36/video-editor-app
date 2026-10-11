// The moov reader behind the resume fingerprint (lib/mp4Moov) and the
// fingerprint itself (lib/uploadResume): iOS re-exports a video on every
// pick with new creation / modification times in mvhd, tkhd and mdhd;
// with those zeroed two picks match, while other sample tables, another
// layout or a file that isn't a plain MP4 / QuickTime file don't.
import { describe, expect, it, vi } from "vitest";
import { MAX_MOOV_BYTES, moovFingerprintInput, normalizeMoov, readTopBoxes } from "@/lib/mp4Moov";
import { contentFingerprint, fingerprint } from "@/lib/uploadResume";
import { box, concat, fileOf, moovBox, movie, noise } from "./__tests__/mp4Fixtures";

const fp = (bytes: Uint8Array) => fingerprint(fileOf(bytes));

describe("readTopBoxes", () => {
  it("reads iOS's export layout: ftyp, moov, wide, mdat", async () => {
    const bytes = movie();
    const top = await readTopBoxes(fileOf(bytes));
    expect(top?.map((b) => b.type)).toEqual(["ftyp", "moov", "wide", "mdat"]);
    expect(top?.at(-1)).toMatchObject({ size: 8 + 6000 });
    expect(top!.reduce((s, b) => s + b.size, 0)).toBe(bytes.length);
  });

  it("follows a 64-bit largesize (mdat of a camera file, moov at the end)", async () => {
    const top = await readTopBoxes(fileOf(movie({ moovAtEnd: true })));
    expect(top?.map((b) => b.type)).toEqual(["ftyp", "mdat", "moov"]);
    expect(top?.[1].size).toBe(16 + 6000);
  });

  it("takes size 0 as 'to the end of the file' for the last box", async () => {
    const ftyp = box("ftyp", new TextEncoder().encode("isom"));
    const open = concat(new Uint8Array([0, 0, 0, 0]), new TextEncoder().encode("mdat"), new Uint8Array(100));
    const top = await readTopBoxes(fileOf(concat(ftyp, moovBox(), open)));
    expect(top?.map((b) => [b.type, b.size])).toEqual([["ftyp", 12], ["moov", moovBox().length], ["mdat", 108]]);
  });

  it("stops at a refused type (a fragmented file's first moof)", async () => {
    const reads: number[] = [];
    const frags = concat(movie(), ...Array.from({ length: 50 }, () => concat(box("moof", new Uint8Array(8)), box("mdat", new Uint8Array(8)))));
    const f = fileOf(frags);
    const slice = f.slice.bind(f);
    Object.assign(f, { slice: (a?: number, b?: number) => (reads.push(a ?? 0), slice(a, b)) });
    expect(await readTopBoxes(f, { refuse: ["moof"] })).toBeNull();
    expect(reads).toHaveLength(5); // ftyp, moov, wide, mdat, moof
    expect((await readTopBoxes(fileOf(frags)))?.length).toBe(104);
  });

  it("is null for anything that doesn't tile the file with boxes", async () => {
    expect(await readTopBoxes(fileOf(noise(5000, 1)))).toBeNull();
    expect(await readTopBoxes(fileOf(new Uint8Array(5000).fill(7)))).toBeNull();
    // Trailing bytes, a box running past the end, a non-printable type.
    expect(await readTopBoxes(fileOf(concat(movie(), new Uint8Array(3))))).toBeNull();
    expect(await readTopBoxes(fileOf(movie().slice(0, -10)))).toBeNull();
    const bad = movie();
    bad[4] = 0;
    expect(await readTopBoxes(fileOf(bad))).toBeNull();
    // A 1 that isn't followed by a largesize.
    expect(await readTopBoxes(fileOf(concat(new Uint8Array([0, 0, 0, 1]), new TextEncoder().encode("mdat"))))).toBeNull();
  });
});

describe("normalizeMoov", () => {
  /** Offsets of the bytes that differ between two equal-length buffers. */
  const diff = (a: Uint8Array, b: Uint8Array) => [...a.keys()].filter((i) => a[i] !== b[i]);

  it("zeroes exactly the creation and modification times (version 0: 32-bit)", () => {
    const a = moovBox({ created: 3_900_000_000, modified: 3_900_000_100 });
    const b = moovBox({ created: 3_911_111_111, modified: 3_922_222_222 });
    // mvhd + tkhd + mdhd, 8 bytes each (some bytes may happen to be equal).
    expect(diff(a, b).length).toBeGreaterThan(12);
    expect(diff(a, b).length).toBeLessThanOrEqual(24);
    const before = a.slice();
    expect(normalizeMoov(a)).toEqual({ ok: true, tracks: 1, fragmented: false });
    expect(normalizeMoov(b).ok).toBe(true);
    expect(a).toEqual(b);
    // Nothing but those 24 bytes changed.
    expect(diff(before, a).length).toBeLessThanOrEqual(24);
    // mvhd's times sit at moov+8 (mvhd header) +8 +4 (version, flags).
    expect([...a.slice(20, 28)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...a.slice(28, 32)]).toEqual([0, 0, 2, 88]); // timescale 600 kept
  });

  it("zeroes the 64-bit times of version 1 boxes", () => {
    const a = moovBox({ version: 1, created: 5_000_000_000, modified: 5_000_000_001 });
    const b = moovBox({ version: 1, created: 6_000_000_000, modified: 7_000_000_000 });
    expect(diff(a, b).length).toBeGreaterThan(0);
    normalizeMoov(a);
    normalizeMoov(b);
    expect(a).toEqual(b);
    expect([...a.slice(20, 36)]).toEqual(new Array(16).fill(0));
  });

  it("covers every track", () => {
    const a = moovBox({ tracks: 3, created: 1 });
    const b = moovBox({ tracks: 3, created: 2 });
    expect(normalizeMoov(a).tracks).toBe(3);
    normalizeMoov(b);
    expect(a).toEqual(b);
  });

  it("says when the structure doesn't add up, or the box is fragmented", () => {
    const short = moovBox();
    new DataView(short.buffer).setUint32(0, short.length + 4); // moov longer than its bytes
    expect(normalizeMoov(short).ok).toBe(false);
    const v2 = moovBox();
    v2[16] = 2; // mvhd version 2: unknown
    expect(normalizeMoov(v2).ok).toBe(false);
    expect(normalizeMoov(moovBox({ fragmented: true })).fragmented).toBe(true);
    expect(normalizeMoov(box("free", new Uint8Array(8))).ok).toBe(false);
  });
});

describe("the resume fingerprint of an MP4 / QuickTime file", () => {
  it("matches two exports that differ only in mvhd / tkhd / mdhd times (the raw key doesn't)", async () => {
    const media = noise(50_000, 3);
    const first = movie({ media, created: 3_900_000_000, modified: 3_900_000_000 });
    const again = movie({ media, created: 3_912_345_678, modified: 3_912_345_999 });
    expect(first.length).toBe(again.length);
    const a = await fp(first);
    expect(a).toMatch(/^m1:\d+:[0-9a-f]{64}$/);
    expect(await fp(again)).toBe(a);
    expect(await contentFingerprint(fileOf(again))).not.toBe(await contentFingerprint(fileOf(first)));
  });

  it("matches version 1 boxes and a moov at the end behind a largesize mdat", async () => {
    const media = noise(20_000, 4);
    const a = await fp(movie({ media, version: 1, moovAtEnd: true, created: 1 }));
    expect(a).toMatch(/^m1:/);
    expect(await fp(movie({ media, version: 1, moovAtEnd: true, created: 2, modified: 9 }))).toBe(a);
  });

  it("differs for other sample tables, another layout or another size", async () => {
    const media = noise(6000, 5);
    const a = await fp(movie({ media, sampleSizes: [1000, 2000, 3000] }));
    expect(await fp(movie({ media, sampleSizes: [1000, 2001, 2999] }))).not.toBe(a);
    // The same moov, moved to the end of the file.
    expect(await fp(movie({ media, moovAtEnd: true }))).not.toBe(a);
    expect(await fp(movie({ media: noise(6001, 5) }))).not.toBe(a);
  });

  it("falls back to the raw-bytes key for other files", async () => {
    for (const bytes of [
      noise(5000, 6), // not boxes at all (WebM, MKV, AVI …)
      movie({ fragmented: true }), // a fragmented MP4 (samples in moof)
      concat(movie(), box("moof", new Uint8Array(16))),
      concat(box("ftyp", new Uint8Array(8)), box("mdat", new Uint8Array(100))), // no moov
      concat(movie(), new Uint8Array(5)), // trailing bytes
      concat(box("ftyp", new Uint8Array(8)), box("free", new Uint8Array(8)), box("mdat", new Uint8Array(8)), moovBox(), moovBox()),
    ]) {
      const f = fileOf(bytes);
      const key = await fingerprint(f);
      expect(key).toMatch(/^c2:/);
      expect(key).toBe(await contentFingerprint(fileOf(bytes)));
    }
  });

  it("doesn't read a moov over MAX_MOOV_BYTES (the raw key then)", async () => {
    const huge = { size: 0, slice: () => new Blob([]) } as unknown as Blob;
    // Only the header says how big it is: a moov box of 65 MiB.
    const head = new Uint8Array(16);
    new DataView(head.buffer).setUint32(0, MAX_MOOV_BYTES + 8);
    head.set(new TextEncoder().encode("moov"), 4);
    const total = MAX_MOOV_BYTES + 8 + 16;
    const reads: [number, number][] = [];
    Object.assign(huge, {
      size: total,
      slice: (a: number, b: number) => {
        reads.push([a, b]);
        if (a === 0) return new Blob([head as BlobPart]);
        const mdat = new Uint8Array(16);
        new DataView(mdat.buffer).setUint32(0, 16);
        mdat.set(new TextEncoder().encode("mdat"), 4);
        return new Blob([mdat as BlobPart]);
      },
    });
    expect(await moovFingerprintInput(huge)).toBeNull();
    // Only box headers were read.
    expect(reads.every(([a, b]) => b - a <= 16)).toBe(true);
  });

  it("is the raw-bytes key when reading the boxes throws", async () => {
    const bytes = movie();
    const f = fileOf(bytes);
    const slice = f.slice.bind(f);
    let n = 0;
    vi.spyOn(f, "slice").mockImplementation((a?: number, b?: number) => {
      // The box reads fail; the raw-bytes key reads (2 MiB windows) work.
      if (b !== undefined && b - (a ?? 0) <= 16 && n++ < 1) throw new Error("NotReadableError");
      return slice(a, b);
    });
    expect(await fingerprint(f)).toBe(await contentFingerprint(fileOf(bytes)));
  });
});
