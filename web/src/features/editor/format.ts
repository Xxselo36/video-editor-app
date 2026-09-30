// Time labels of the editor (moved verbatim from app/app/page.tsx in UX4).

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// m:ss.t — for the playhead readout and sub-second ruler labels.
export function fmtTimecode(t: number): string {
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${s.toString().padStart(2, "0")}.${tenths % 10}`;
}
