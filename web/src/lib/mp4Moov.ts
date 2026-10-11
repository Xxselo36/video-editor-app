/**
 * The movie header (moov) of an MP4 / QuickTime file, read for the
 * resume fingerprint (lib/uploadResume): a video that iOS hands over
 * again after a reload is a fresh export each time, with new
 * creation / modification times in moov (mvhd, tkhd, mdhd: 60 bytes on
 * the owner's 8 GB test video) and otherwise the same bytes. With those
 * times zeroed, the moov of two picks of the same video is identical.
 *
 * moov's sample tables (stsz / stco / co64 / stts / stsc …) give the
 * size and the file offset of every sample of every track: an identical
 * moov at an identical top-level layout means the media data lies at the
 * same offsets with the same sizes in both files.
 *
 * Only small File.slice reads: one 16-byte header per top-level box,
 * then moov itself (at most MAX_MOOV_BYTES, wherever it is: at the start
 * of an iOS export, at the end of many camera files). Anything that
 * isn't a plain ISO-BMFF / QuickTime file (WebM, MKV, AVI, a fragmented
 * MP4, a truncated or odd file) gives null: the caller falls back to
 * hashing raw bytes.
 */

/** A moov bigger than this isn't read (a 30-minute 4K video has ~2 MB). */
export const MAX_MOOV_BYTES = 64 * 1024 * 1024;
/** More top-level boxes than this: not a file we know how to read. */
const MAX_TOP_BOXES = 1024;
/** Nesting deeper than this inside moov: malformed. */
const MAX_DEPTH = 16;

export type TopBox = {
  type: string;
  /** File offset of the box header. */
  start: number;
  /** Header + payload, in bytes. */
  size: number;
};

/** What's in a box this needs: a plain readable blob (File is one). */
type Readable = Pick<Blob, "size" | "slice">;

const printable = (b: Uint8Array, at: number) => {
  for (let i = at; i < at + 4; i++) if (b[i] < 0x20 || b[i] > 0x7e) return false;
  return true;
};
const typeAt = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** A box's size from its header at `at` in `dv` (32-bit, or the 64-bit
 *  largesize after size 1; 0 → `rest`, the bytes left in its parent),
 *  and the header length; null when it can't be read. */
function boxSize(dv: DataView, at: number, rest: number): { size: number; header: number } | null {
  const s32 = dv.getUint32(at);
  if (s32 === 1) {
    if (at + 16 > dv.byteLength) return null;
    const hi = dv.getUint32(at + 8);
    const lo = dv.getUint32(at + 12);
    // Above 2^53 bytes: not a real file.
    if (hi >= 0x200000) return null;
    return { size: hi * 0x100000000 + lo, header: 16 };
  }
  if (s32 === 0) return { size: rest, header: 8 };
  return { size: s32, header: 8 };
}

/**
 * The top-level boxes of `file`, or null unless they tile the whole file
 * exactly (each one's size in bounds, printable four-letter types).
 * `refuse`: types that make it null at once (a fragmented file's first
 * moof: thousands of boxes would follow, read for nothing).
 */
export async function readTopBoxes(file: Readable, { refuse = [] }: { refuse?: string[] } = {}): Promise<TopBox[] | null> {
  const out: TopBox[] = [];
  let at = 0;
  while (at < file.size) {
    if (out.length >= MAX_TOP_BOXES || at + 8 > file.size) return null;
    const head = new Uint8Array(await file.slice(at, Math.min(at + 16, file.size)).arrayBuffer());
    if (head.length < 8 || !printable(head, 4)) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const s = boxSize(dv, 0, file.size - at);
    if (!s || s.size < s.header || at + s.size > file.size) return null;
    const type = typeAt(head, 4);
    if (refuse.includes(type)) return null;
    out.push({ type, start: at, size: s.size });
    at += s.size;
  }
  return out;
}

type MoovScan = { ok: boolean; tracks: number; fragmented: boolean };

/**
 * Zeroes, in place, the creation and modification times of every mvhd
 * (in moov), tkhd (in trak) and mdhd (in trak/mdia) of `moov` (the whole
 * box, header included). Version 0 boxes hold them as two 32-bit fields
 * after version + flags, version 1 as two 64-bit fields. `ok` false: the
 * box structure doesn't add up (or a version this doesn't know).
 */
export function normalizeMoov(moov: Uint8Array): MoovScan {
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const scan: MoovScan = { ok: true, tracks: 0, fragmented: false };
  const top = boxSize(dv, 0, moov.length);
  if (moov.length < 8 || typeAt(moov, 4) !== "moov" || !top || top.size !== moov.length) {
    return { ok: false, tracks: 0, fragmented: false };
  }

  const zeroTimes = (payload: number, end: number): boolean => {
    if (payload + 4 > end) return false;
    const version = moov[payload];
    const width = version === 0 ? 4 : version === 1 ? 8 : 0;
    if (!width || payload + 4 + 2 * width > end) return false;
    moov.fill(0, payload + 4, payload + 4 + 2 * width);
    return true;
  };

  const walk = (from: number, to: number, parent: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let at = from;
    while (at < to) {
      if (at + 8 > to || !printable(moov, at + 4)) return false;
      const s = boxSize(dv, at, to - at);
      if (!s || s.size < s.header || at + s.size > to) return false;
      const type = typeAt(moov, at + 4);
      const payload = at + s.header;
      const end = at + s.size;
      if (
        (parent === "moov" && type === "mvhd") ||
        (parent === "trak" && type === "tkhd") ||
        (parent === "mdia" && type === "mdhd")
      ) {
        if (!zeroTimes(payload, end)) return false;
      }
      if (parent === "moov" && type === "mvex") scan.fragmented = true;
      if (parent === "moov" && type === "trak") scan.tracks++;
      if ((parent === "moov" && type === "trak") || (parent === "trak" && type === "mdia")) {
        if (!walk(payload, end, type, depth + 1)) return false;
      }
      at = end;
    }
    return at === to;
  };

  scan.ok = walk(top.header, moov.length, "moov", 0);
  return scan;
}

/** The parts of a file a moov fingerprint hashes, or null when it has
 *  none (see the top of this file). */
export type MoovFingerprintInput = {
  /** Every top-level box as "type@start+size", in order. */
  layout: string;
  /** moov with its times zeroed. */
  moov: Uint8Array;
};

export async function moovFingerprintInput(file: Readable): Promise<MoovFingerprintInput | null> {
  // A fragmented file keeps its sample tables in the moof boxes: not this.
  const top = await readTopBoxes(file, { refuse: ["moof"] });
  if (!top) return null;
  // One moov, describing the samples of a plain mdat.
  const moovs = top.filter((b) => b.type === "moov");
  if (moovs.length !== 1 || !top.some((b) => b.type === "mdat")) return null;
  const box = moovs[0];
  if (box.size > MAX_MOOV_BYTES) return null;
  const moov = new Uint8Array(await file.slice(box.start, box.start + box.size).arrayBuffer());
  if (moov.length !== box.size) return null;
  const scan = normalizeMoov(moov);
  if (!scan.ok || scan.fragmented || scan.tracks === 0) return null;
  return { layout: top.map((b) => `${b.type}@${b.start}+${b.size}`).join(","), moov };
}
