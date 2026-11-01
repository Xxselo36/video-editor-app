/**
 * m:ss of a moment or a length, the seconds rounded down: the v2
 * editor's labels (features/editor/v2/model.ts) and the Vorschau's
 * length, so one edit reads the same on both. (A cost rounds up
 * instead: features/project/exportsInfo.ts clock.)
 */
export function fmtClock(s: number): string {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
