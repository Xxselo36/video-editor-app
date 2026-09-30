/**
 * Error text of the /app screens, by code (UX5, PLAN_TECH §1.5): the
 * backend answers every error with a code from backend/errors.py — a
 * job's `error_code` / `error_params`, an HTTP error body's `code` /
 * `params` — and this file words it in the viewer's language
 * (./errorKeys.ts: code → message key). Nothing here matches English
 * text any more (the old friendlyError / localizeKnown did).
 *
 * What gets stored (job cards in localStorage) is the code, never a
 * translated sentence: the card is worded when it renders.
 */
import { translate, type TFn } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { ApiError } from "@/lib/api";
import { DEFAULT_LIMITS } from "@/lib/config";
import { AUDIO_WARNING_KEYS, CLIENT_ERROR_KEYS, ERROR_KEYS, STAGE_KEYS, WARNING_KEYS } from "@/lib/errorKeys";

/** English translator (analytics labels, notifications' fallbacks). */
export const tEn: TFn = (key, vars) => translate("en", key, vars);

export type ErrorParams = Record<string, string | number | boolean | null>;

/** An error as a code (a job's, a response's or the browser's own). */
export type CodedError = {
  code: string | null;
  params?: ErrorParams | null;
  /** The job's minutes were credited back (job.refunded). */
  refunded?: boolean | null;
};

// Upload refusals (POST /jobs, the upload API): a final answer, not a
// hiccup to retry.
export const REFUSAL_CODES = new Set([
  "server_busy",
  "server_storage_full",
  "too_many_active_jobs",
  "too_many_uploads",
  "file_too_large",
  "video_too_long",
  "video_too_short",
  "no_audio",
  "no_video",
]);

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** The code and params of a backend answer: the body's `code` / `params`
 *  (UX5), else what older backends sent (`detail` + fields next to it). */
export function errorFromApi(e: ApiError): CodedError {
  const body = e.body ?? {};
  const code = typeof body.code === "string" ? body.code : e.code;
  let params: ErrorParams = {};
  if (body.params && typeof body.params === "object") params = body.params as ErrorParams;
  else {
    const detail = e.detail && typeof e.detail === "object" ? (e.detail as ErrorParams) : {};
    for (const [k, v] of Object.entries({ ...detail, ...body })) {
      if (k !== "detail" && k !== "code" && (typeof v !== "object" || v === null)) params[k] = v as never;
    }
  }
  return { code: code ?? null, params };
}

/** The code of a failure the browser saw itself (no answer to go by). */
export function clientErrorCode(err: unknown): string {
  const txt = String(err instanceof Error ? err.message : (err ?? "")).toLowerCase();
  if (txt.includes("interrupted")) return "upload_interrupted";
  if (txt.includes("no response") || txt.includes("timed out")) return "server_no_response";
  if (txt.includes("stalled") || txt.includes("network") || txt.includes("failed to fetch") || txt.includes("aborted"))
    return "connection_lost";
  return "processing_failed";
}

/** Any error as a code: an ApiError's, a CodedError as it is, else the
 *  browser's own (clientErrorCode). */
export function toCoded(e: unknown): CodedError {
  if (e instanceof ApiError) return errorFromApi(e);
  if (e && typeof e === "object" && "code" in e && !(e instanceof Error)) return e as CodedError;
  return { code: clientErrorCode(e) };
}

/** The message placeholders of a code, from its params. */
function vars(code: string, p: ErrorParams): Record<string, string | number> {
  switch (code) {
    case "file_too_large":
      return { max: num(p.max_gb) ?? DEFAULT_LIMITS.max_upload_bytes / 1e9 };
    case "video_too_long":
      return { max: num(p.max_minutes) ?? (DEFAULT_LIMITS.max_seconds ?? 0) / 60 };
    case "video_too_short":
      return { min: num(p.min_seconds) ?? DEFAULT_LIMITS.min_seconds };
    default:
      return {};
  }
}

/** The message key of a code (generic for one we don't know). */
export function errorKey(code: string | null | undefined): MessageKey {
  if (!code) return "app.errors.generic";
  return ERROR_KEYS[code] ?? CLIENT_ERROR_KEYS[code] ?? "app.errors.generic";
}

/** One sentence for any error (UX5's describeError). */
export function describeError(e: unknown, t: TFn): string {
  const { code, params, refunded } = toCoded(e);
  if (code === "no_speech" && refunded) return t("app.errors.noSpeechRefunded");
  return t(errorKey(code), vars(code ?? "", params ?? {}));
}

/** A failed job's message (GET /jobs/{id}, the status rows). */
export function jobErrorText(
  s: { error_code?: string | null; error_params?: ErrorParams | null; refunded?: boolean | null },
  t: TFn,
): string {
  return describeError({ code: s.error_code ?? null, params: s.error_params, refunded: s.refunded }, t);
}

const CODE_RE = /^[a-z][a-z0-9_]*$/;

/** A job card's stored error (lib/activeJobs: a code since UX5; an
 *  English sentence on older cards, shown as stored). */
export function cardErrorText(
  card: { error?: string; errorParams?: ErrorParams | null; refunded?: boolean | null },
  t: TFn,
): string {
  const e = card.error ?? "";
  if (!e) return t("app.errors.generic");
  if (!CODE_RE.test(e)) return e;
  return describeError({ code: e, params: card.errorParams, refunded: card.refunded }, t);
}

/** A job card's note ("render_failed"; older cards: a sentence). */
export function cardNoteText(note: string, t: TFn): string {
  return note === "render_failed" ? t("app.card.renderFailedNote") : note;
}

/** The fields a job card stores for a failure. */
export function cardError(e: unknown): { error: string; errorParams: ErrorParams; refunded: boolean | null } {
  const c = toCoded(e);
  return { error: c.code ?? "processing_failed", errorParams: c.params ?? {}, refunded: c.refunded ?? null };
}

/** The words of an audio warning code (job.audio_warnings); text from a
 *  backend before UX5 is shown as it came. */
export function audioWarningText(code: string, t: TFn): string {
  const key = AUDIO_WARNING_KEYS[code];
  return key ? t(key) : code;
}

/** A job warning (format_warning, …), or null for an unknown code. */
export function warningText(code: string, t: TFn): string | null {
  const key = WARNING_KEYS[code];
  return key ? t(key) : null;
}

/** Where a running job is (job.stage), or null without a known stage. */
export function stageText(stage: string | null | undefined, params: ErrorParams | null | undefined, t: TFn): string | null {
  const key = stage ? STAGE_KEYS[stage] : undefined;
  if (!key) return null;
  const p = params ?? {};
  return t(key, { i: num(p.i) ?? 1, n: num(p.n) ?? 1 });
}
