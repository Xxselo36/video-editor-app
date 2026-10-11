/**
 * Synthetic MP4 / QuickTime files for the unit tests of lib/mp4Moov and
 * the resume fingerprint (lib/uploadResume): just the boxes those read
 * (ftyp, moov with mvhd / trak / tkhd / mdia / mdhd / stbl, wide, mdat),
 * with chosen creation / modification times. Test-only.
 */

const enc = new TextEncoder();

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const u64 = (n: number) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Math.floor(n / 0x100000000));
  dv.setUint32(4, n % 0x100000000);
  return b;
};

/** A box with a 32-bit size. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), enc.encode(type), body);
}

/** A box with size 1 and the 64-bit largesize. */
export function largeBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(1), enc.encode(type), u64(16 + body.length), body);
}

const fullHead = (version: number) => new Uint8Array([version, 0, 0, 0]);
const times = (version: number, c: number, m: number) => (version === 1 ? concat(u64(c), u64(m)) : concat(u32(c), u32(m)));

/** mvhd / mdhd / tkhd: version + flags, the two times, then a body. */
export function timedBox(type: "mvhd" | "tkhd" | "mdhd", version: number, created: number, modified: number, body: Uint8Array): Uint8Array {
  return box(type, fullHead(version), times(version, created, modified), body);
}

export type MovieOpts = {
  /** Creation / modification times (seconds since 1904). */
  created?: number;
  modified?: number;
  /** 0 or 1 for mvhd, tkhd and mdhd. */
  version?: number;
  /** Per-sample sizes (stsz) of the one track. */
  sampleSizes?: number[];
  /** The media bytes. */
  media?: Uint8Array;
  /** moov after mdat (camera files), mdat with a largesize. */
  moovAtEnd?: boolean;
  /** An mvex in moov (a fragmented file). */
  fragmented?: boolean;
  tracks?: number;
};

export function moovBox(o: MovieOpts = {}): Uint8Array {
  const v = o.version ?? 0;
  const c = o.created ?? 3_900_000_000;
  const m = o.modified ?? c + 1;
  const sizes = o.sampleSizes ?? [1000, 2000, 3000];
  const stsz = box("stsz", fullHead(0), u32(0), u32(sizes.length), ...sizes.map(u32));
  const stco = box("stco", fullHead(0), u32(1), u32(48));
  const trak = (id: number) =>
    box(
      "trak",
      timedBox("tkhd", v, c, m, concat(u32(id), new Uint8Array(68))),
      box(
        "mdia",
        timedBox("mdhd", v, c, m, concat(u32(600), v === 1 ? u64(6000) : u32(6000), new Uint8Array(4))),
        box("hdlr", fullHead(0), u32(0), enc.encode("vide"), new Uint8Array(12), enc.encode("Core Media Video\0")),
        box("minf", box("stbl", stsz, stco)),
      ),
    );
  return box(
    "moov",
    timedBox("mvhd", v, c, m, concat(u32(600), v === 1 ? u64(6000) : u32(6000), new Uint8Array(80))),
    ...Array.from({ length: o.tracks ?? 1 }, (_, i) => trak(i + 1)),
    ...(o.fragmented ? [box("mvex", box("trex", fullHead(0), new Uint8Array(20)))] : []),
  );
}

/** A whole movie file: ftyp, moov, wide, mdat (iOS's export layout), or
 *  ftyp, mdat (largesize), moov with `moovAtEnd`. */
export function movie(o: MovieOpts = {}): Uint8Array {
  const ftyp = box("ftyp", enc.encode("qt  "), u32(0), enc.encode("qt  "));
  const media = o.media ?? new Uint8Array(6000).fill(7);
  const moov = moovBox(o);
  if (o.moovAtEnd) return concat(ftyp, largeBox("mdat", media), moov);
  return concat(ftyp, moov, box("wide"), box("mdat", media));
}

/** Deterministic bytes (seed → content). */
export function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export const fileOf = (bytes: Uint8Array, name = "IMG_0001.MOV", lastModified = 1) =>
  new File([bytes as BlobPart], name, { type: "video/quicktime", lastModified });
