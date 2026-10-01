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

// ── job cards (lib/activeJobs) ───────────────────────────────────────
// A card stores its failure twice: `errorCode` (+ errorParams, refunded),
// which this build words in the viewer's language, and `error`, the
// English sentence — what a tab still on a build from before UX5 shows
// (it shares localStorage). The same for the note: `noteCode` + `note`.
// Cards stored before UX5 have only the English `error` / `note`;
// legacyCardCode maps those back to a code.

type CardFailure = { error?: string; errorCode?: string | null; errorParams?: ErrorParams | null; refunded?: boolean | null };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An English message template as a regex ("{max}" → a group). */
function templateRe(tmpl: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const src = tmpl
    .split(/\{(\w+)\}/)
    .map((part, i) => {
      if (i % 2) {
        names.push(part);
        return "(.+?)";
      }
      return escapeRe(part);
    })
    .join("");
  return { re: new RegExp(`^${src}$`), names };
}

// The sentences cards stored before UX5 (tEn of these keys) → code.
const LEGACY_CARD_TEXTS: [MessageKey, string, Partial<CodedError>?][] = [
  ...Object.entries(ERROR_KEYS).map(([code, key]) => [key, code] as [MessageKey, string]),
  ...Object.entries(CLIENT_ERROR_KEYS).map(([code, key]) => [key, code] as [MessageKey, string]),
  ["app.errors.noSpeechRefunded", "no_speech", { refunded: true }],
  ["app.errors.connection", "connection_lost"],
  ["app.errors.generic", "processing_failed"],
];
const PARAM_NAME: Record<string, string> = { file_too_large: "max_gb", video_too_long: "max_minutes", video_too_short: "min_seconds" };

/** The code of a card's stored English text (cards from before UX5).
 *  Unknown text — a raw server answer, an HTML page, a browser message —
 *  is a generic failure: it is never shown as it is. */
export function legacyCardCode(text: string): CodedError {
  const s = text.trim();
  if (CODE_RE.test(s)) return { code: s };
  for (const [key, code, extra] of LEGACY_CARD_TEXTS) {
    const { re, names } = templateRe(translate("en", key));
    const m = re.exec(s);
    if (!m) continue;
    const params: ErrorParams = {};
    names.forEach((n, i) => {
      const v = Number(m[i + 1]);
      params[n === "max" || n === "min" ? (PARAM_NAME[code] ?? n) : n] = isFinite(v) ? v : m[i + 1];
    });
    return { code, params, ...extra };
  }
  // What the upload code stored as it was: "Upload failed: <answer>".
  const answer = /^Upload failed:\s*(\{[\s\S]*\})\s*$/.exec(s);
  if (answer) {
    try {
      const body = JSON.parse(answer[1]) as { detail?: unknown; code?: unknown };
      const c = typeof body.code === "string" ? body.code : typeof body.detail === "string" ? body.detail : null;
      if (c && CODE_RE.test(c)) return { code: c };
    } catch {
      /* not JSON */
    }
  }
  const l = s.toLowerCase();
  if (l.includes("interrupted")) return { code: "upload_interrupted" };
  if (/network|failed to fetch|stalled|aborted|connection/.test(l)) return { code: "connection_lost" };
  return { code: "processing_failed" };
}

/** A job card's failure in the viewer's language — never raw text. */
export function cardErrorText(card: CardFailure, t: TFn): string {
  if (card.errorCode) {
    return describeError({ code: card.errorCode, params: card.errorParams, refunded: card.refunded }, t);
  }
  if (!card.error) return t("app.errors.generic");
  const legacy = legacyCardCode(card.error);
  return describeError({ ...legacy, refunded: legacy.refunded ?? card.refunded }, t);
}

/** A job card's note, translated (the render-failed note is the only
 *  kind: `noteCode` "render_failed", or its English sentence). */
export function cardNoteText(card: { note?: string; noteCode?: string | null }, t: TFn): string {
  void card;
  return t("app.card.renderFailedNote");
}

/** The note fields of a card whose render failed. */
export function renderFailedNote(): { note: string; noteCode: string } {
  return { note: tEn("app.card.renderFailedNote"), noteCode: "render_failed" };
}

/** The fields a job card stores for a failure: the code for this build,
 *  the English sentence for older ones. */
export function cardError(e: unknown): {
  error: string;
  errorCode: string;
  errorParams: ErrorParams;
  refunded: boolean | null;
} {
  const c = toCoded(e);
  const code = c.code ?? "processing_failed";
  return {
    error: describeError({ ...c, code }, tEn),
    errorCode: code,
    errorParams: c.params ?? {},
    refunded: c.refunded ?? null,
  };
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
