/**
 * Error text of the /app screens (moved from app/app/page.tsx in
 * UX4): friendly messages for raw server and network errors, and the
 * English messages stored with job cards, mapped back to the viewer's
 * language. Error handling by string matching: UX5 replaces it with the
 * backend's error codes and a code → key table (tech.md §5.6).
 */
import { translate, type TFn } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import type { ApiError } from "@/lib/api";
import { MAX_MINUTES, MAX_UPLOAD_GB } from "@/lib/chunkedUpload";

// English translator for text that gets PERSISTED (localStorage job
// cards / library entries). Stored text stays English and is mapped
// back to the viewer's language at render time (see localizeKnown).
export const tEn: TFn = (key, vars) => translate("en", key, vars);

export const FRIENDLY_EXPIRED_KEY = "app.errors.expired" as const;

// Messages we may have stored in English; shown translated on render.
const STORED_MESSAGE_KEYS: MessageKey[] = [
  "app.errors.expired",
  "app.errors.generic",
  "app.errors.connection",
  "app.errors.interrupted",
  "app.errors.tooLarge",
  "app.errors.noAudio",
  "app.errors.renderFailed",
  "app.errors.serverNoResponse",
  "app.errors.serverBusy",
  "app.errors.signInRequired",
  "app.errors.subscriptionRequired",
  "app.errors.quotaExceeded",
  "app.errors.unreadableVideo",
  "app.errors.fileTooLarge",
  "app.errors.videoTooLong",
  "app.errors.tooManyJobs",
  "app.errors.noSpeech",
  "app.errors.noSpeechRefunded",
  "app.errors.noAudioTrack",
  "app.card.renderFailedNote",
];
export function localizeKnown(text: string, t: TFn): string {
  for (const key of STORED_MESSAGE_KEYS) {
    const vars = matchTemplate(translate("en", key), text);
    if (vars) return t(key, vars);
  }
  return text;
}

// The placeholder values when `text` is the English template `tpl`
// filled in ("…larger than {max} GB…" ↔ "…larger than 4 GB…"), else null.
export function matchTemplate(tpl: string, text: string): Record<string, string> | null {
  if (!tpl.includes("{")) return tpl === text ? {} : null;
  const names: string[] = [];
  const src = tpl
    .split(/\{(\w+)\}/)
    .map((part, i) => {
      if (i % 2) {
        names.push(part);
        return "(.+?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const m = new RegExp(`^${src}$`).exec(text);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : null;
}

// Upload refusals the backend answers with a code (+ the limit), as the
// English text a card stores. Null for anything else.
export const REFUSAL_CODES = new Set([
  "server_busy",
  "server_storage_full",
  "too_many_active_jobs",
  "too_many_uploads",
  "file_too_large",
  "video_too_long",
  "no_audio",
]);

export function refusalMessage(err: ApiError): string | null {
  switch (err.code) {
    case "server_busy":
    case "server_storage_full":
    case "too_many_uploads":
      return tEn("app.errors.serverBusy");
    case "too_many_active_jobs":
      return tEn("app.errors.tooManyJobs");
    case "file_too_large":
      return tEn("app.errors.fileTooLarge", { max: err.num("max_gb") ?? MAX_UPLOAD_GB });
    case "video_too_long":
      return tEn("app.errors.videoTooLong", { max: err.num("max_minutes") ?? MAX_MINUTES });
    // 400 before the charge: the file has no sound track.
    case "no_audio":
      return tEn("app.errors.noAudioTrack");
    default:
      return null;
  }
}

// A failed job's message: its error_code first (the interim codes; the
// full catalogue comes with backend/errors.py in UX5), else the text.
export function jobErrorText(
  s: { error?: string | null; message?: string | null; error_code?: string | null; refunded?: boolean | null },
  t: TFn,
): string {
  switch (s.error_code) {
    case "no_speech":
      return t(s.refunded ? "app.errors.noSpeechRefunded" : "app.errors.noSpeech");
    case "no_audio":
      return t("app.errors.noAudioTrack");
    default:
      return friendlyError(s.error ?? s.message, t);
  }
}

// Turn raw server/network errors into something a creator can act on.
// The technical text still goes to the console for debugging.
export function friendlyError(raw: unknown, t: TFn): string {
  const txt = String(raw ?? "").trim();
  if (txt) console.warn("[cleocuts] error detail:", txt.slice(0, 500));
  const l = txt.toLowerCase();
  if (!txt) return t("app.errors.generic");
  // One of our own (stored in English) → current language.
  // (Unchanged when the viewer reads English: still one of ours.)
  const known = localizeKnown(txt, t);
  if (known !== txt || STORED_MESSAGE_KEYS.some((k) => matchTemplate(translate("en", k), txt))) return known;
  // Already a user-facing message (ours or the backend's).
  if (txt.endsWith(".") && /\b(Please|please)\b/.test(txt)) return txt;
  // transcription_unavailable: the speech service failed even after
  // retries (the minutes were refunded) — a "try again later" case too.
  if (l.includes("server_storage_full") || l.includes("507") || l.includes("server_busy")
      || l.includes("transcription_unavailable"))
    return t("app.errors.serverBusy");
  if (l.includes("too_many_active_jobs"))
    return t("app.errors.tooManyJobs");
  if (l.includes("file_too_large") || l.includes("video_too_long")) {
    // Raw answer text, e.g. `{"detail":"file_too_large","max_gb":4}`.
    const lim = (f: string) => Number(new RegExp(`"${f}"\\s*:\\s*([\\d.]+)`).exec(txt)?.[1]) || null;
    return l.includes("file_too_large")
      ? t("app.errors.fileTooLarge", { max: lim("max_gb") ?? MAX_UPLOAD_GB })
      : t("app.errors.videoTooLong", { max: lim("max_minutes") ?? MAX_MINUTES });
  }
  if (l.includes("unreadable_video"))
    return t("app.errors.unreadableVideo");
  // Backends / stored errors without an error_code (see jobErrorText).
  if (l.includes("no_audio") || l.includes("no audio track") || l.includes("has no audio"))
    return t("app.errors.noAudioTrack");
  if (l.includes("no_speech") || l.includes("no speech detected"))
    return t("app.errors.noSpeech");
  // Accounts / billing (backend codes; only sent when switched on)
  if (l.includes("auth_required"))
    return t("app.errors.signInRequired");
  if (l.includes("subscription_required"))
    return t("app.errors.subscriptionRequired");
  if (l.includes("quota_exceeded"))
    return t("app.errors.quotaExceeded");
  if (l.includes("stalled") || l.includes("network") || l.includes("failed to fetch"))
    return t("app.errors.connection");
  if (l.includes("interrupted"))
    return t("app.errors.interrupted");
  if (l.includes("not found") || l.includes("404") || l.includes("no longer"))
    return t(FRIENDLY_EXPIRED_KEY);
  if (l.includes("413") || l.includes("too large"))
    return t("app.errors.tooLarge");
  if (l.includes("no audio") || l.includes("audio"))
    return t("app.errors.noAudio");
  if (l.includes("render"))
    return t("app.errors.renderFailed");
  return t("app.errors.generic");
}
