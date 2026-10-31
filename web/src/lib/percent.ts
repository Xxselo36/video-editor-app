/**
 * A percentage as the UI language writes it, sign and space included
 * ("42%", "42 %", "%42"). Messages take it preformatted ({pct}): upload
 * progress, the point an upload stopped at.
 */
const formats = new Map<string, Intl.NumberFormat>();

/** `pct` (0 to 100) rounded to a whole percent. */
export function formatPct(pct: number, lang: string): string {
  try {
    let f = formats.get(lang);
    if (!f) {
      f = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 });
      formats.set(lang, f);
    }
    return f.format(pct / 100);
  } catch {
    return `${Math.round(pct)}%`;
  }
}
