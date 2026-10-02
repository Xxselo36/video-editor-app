/**
 * UX11: what the export sheet and the Done view say about an export —
 * pure, so the wording rules are unit-tested (exportsInfo.test.ts).
 *
 * Honest minutes (owner decision): with billing off — or for a viewer the
 * backend doesn't bill — an export is simply "Free", with no counter that
 * would hint at a later charge. When billed: the free exports left for
 * this video, else exactly what this export records ("0:45 of your
 * minutes, 25 % of the 3:00 video") and what is left; over the quota it
 * still runs and says so. An instant export (speculative render) is free.
 */
import type { TFn } from "@/i18n";
import { plural } from "@/lib/i18n/plural";
import type { ExportFields } from "@/features/jobs/types";

/** m:ss (h:mm:ss from an hour), rounding seconds up — a cost is never
 *  shown smaller than it is. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Whole minutes in the viewer's language ("70 min", "70 Min.", "70分"),
 *  rounded down — what is left is never shown bigger than it is. */
export function minutesText(lang: string, seconds: number): string {
  const m = Math.max(0, Math.floor(seconds / 60));
  try {
    return new Intl.NumberFormat(lang, { style: "unit", unit: "minute", unitDisplay: "short" }).format(m);
  } catch {
    return `${m} min`;
  }
}

export type CostLine = {
  /** The main line ("Free · 2 of 3 free exports left for this video"). */
  text: string;
  /** A second line when billed and paid: what's left, or over quota. */
  note: string | null;
  /** The export records minutes. */
  paid: boolean;
};

/**
 * The cost of the next export. `remainingSeconds`: the viewer's minutes
 * left this period (GET /me), when known.
 */
export function costLine(
  job: ExportFields,
  t: TFn,
  lang: string,
  remainingSeconds: number | null = null,
): CostLine {
  if (job.spec_ready) return { text: t("app.export.costInstant"), note: null, paid: false };
  const fu = job.fair_use;
  const left = job.free_renders_left;
  if (!fu?.billed || left === null || left === undefined) {
    return { text: t("app.export.costFree"), note: null, paid: false };
  }
  if (left > 0) {
    const key = plural(lang, fu.free_total, {
      one: "app.export.costFreeLeftOne",
      other: "app.export.costFreeLeftOther",
    } as const);
    return { text: t(key, { left, total: fu.free_total }), note: null, paid: false };
  }
  const cost = job.next_render_cost_seconds ?? 0;
  if (cost <= 0) return { text: t("app.export.costFree"), note: null, paid: false };
  const text = t("app.export.costPaid", {
    cost: clock(cost),
    pct: Math.round(fu.pct),
    length: clock(fu.basis_seconds),
  });
  let note: string | null = null;
  if (remainingSeconds !== null) {
    note =
      remainingSeconds < cost
        ? t("app.export.costOverQuota")
        : t("app.export.costRemaining", { left: minutesText(lang, remainingSeconds - cost) });
  }
  return { text, note, paid: true };
}

/** "How free exports count" — only meaningful when billed. */
export function costHelp(job: ExportFields, t: TFn): string | null {
  const fu = job.fair_use;
  if (!fu?.billed) return null;
  return t("app.export.costHelp", { free: fu.free_total, pct: Math.round(fu.pct) });
}

/** The counter next to "Edit again" (Done view), billed viewers only. */
export function editAgainNote(job: ExportFields, t: TFn, lang: string): string | null {
  const fu = job.fair_use;
  const left = job.free_renders_left;
  if (!fu?.billed || left === null || left === undefined) return null;
  if (left > 0) {
    const key = plural(lang, fu.free_total, {
      one: "app.done.freeLeftOne",
      other: "app.done.freeLeftOther",
    } as const);
    return t(key, { left, total: fu.free_total });
  }
  return t("app.done.nextCosts", { cost: clock(job.next_render_cost_seconds ?? 0) });
}

/** "9:16 · 12 MB" for a download; the primary keeps the job's aspect. */
export function downloadLabel(
  format: string,
  bytes: number | null,
  aspect: string | null,
  t: TFn,
): string {
  const a = format === "primary" ? aspect : format;
  const parts: string[] = [];
  if (a && a !== "original") parts.push(a);
  else if (format === "primary") parts.push(t("app.done.video"));
  else parts.push(format);
  if (bytes && bytes > 0) parts.push(sizeText(bytes));
  return parts.join(" · ");
}

export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ── the survey "Did you have to edit this video anywhere else?" ─────
// From this browser's 2nd export on, at most once a week (review A5).

export const SURVEY_KEY = "cleocuts.exports.v1";
export const SURVEY_EVERY_MS = 7 * 24 * 3600 * 1000;

export type ExportLog = { seen: string[]; lastSurvey: number };

export function readLog(): ExportLog {
  try {
    const v = JSON.parse(localStorage.getItem(SURVEY_KEY) ?? "null");
    if (v && Array.isArray(v.seen)) return { seen: v.seen.slice(-50), lastSurvey: Number(v.lastSurvey) || 0 };
  } catch {
    /* none / blocked */
  }
  return { seen: [], lastSurvey: 0 };
}

function writeLog(log: ExportLog): void {
  try {
    localStorage.setItem(SURVEY_KEY, JSON.stringify(log));
  } catch {
    /* private mode: the survey just shows again */
  }
}

/** Note an export seen in a Done view; whether the survey is due. */
export function noteExport(exportId: string, now = Date.now()): boolean {
  const log = readLog();
  if (!log.seen.includes(exportId)) {
    log.seen.push(exportId);
    writeLog(log);
  }
  return log.seen.length >= 2 && now - log.lastSurvey >= SURVEY_EVERY_MS;
}

export function surveyAnswered(now = Date.now()): void {
  writeLog({ ...readLog(), lastSurvey: now });
}

// ── the "Cleo cut" tip (review E3) ─────────────────────────────────

export const TIP_KEY = "cleocuts.tip.cleoCut.v1";

export function tipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissTip(): void {
  try {
    localStorage.setItem(TIP_KEY, "1");
  } catch {
    /* ignore */
  }
}
