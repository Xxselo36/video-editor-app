/**
 * Backend code → message key (UX5). The codes come from backend/errors.py
 * (exported as ./errorCodes.json by the backend tests); the i18n check
 * (scripts/i18n-check.mjs, rule "codes") asserts every code there has a
 * key here and the key exists in every language. Pure data — the check
 * evaluates this file on its own. Wording: lib/errors.ts describeError.
 */
import type { MessageKey } from "../i18n/messages/en";

/** Why a job failed / a request was refused (job.error_code, the error body's `code`). */
export const ERROR_KEYS: Record<string, MessageKey> = {
  already_rendering: "app.notice.alreadyExporting",
  audio_silent: "app.audio.silent",
  auth_required: "app.errors.signInRequired",
  // 409s of POST /jobs/{id}/reopen (UX11): running, or a failed analysis
  busy: "app.errors.busy",
  doc_not_ready: "app.errors.docNotReady",
  file_too_large: "app.errors.fileTooLarge",
  media_expired: "app.errors.expired",
  media_unavailable: "app.errors.mediaUnavailable",
  no_audio: "app.errors.noAudioTrack",
  no_speech: "app.errors.noSpeech",
  no_video: "app.errors.noVideoTrack",
  not_editable: "app.errors.notEditable",
  not_in_review: "app.notice.alreadyExporting",
  processing_failed: "app.errors.generic",
  processing_interrupted: "app.errors.processingInterrupted",
  quota_exceeded: "app.errors.quotaExceeded",
  render_failed: "app.errors.renderFailed",
  render_limit: "app.errors.renderLimit",
  render_timeout: "app.errors.renderFailed",
  render_unavailable: "app.errors.renderFailed",
  server_busy: "app.errors.serverBusy",
  server_storage_full: "app.errors.serverBusy",
  stale_rev: "app.errors.staleRev",
  subscription_required: "app.errors.subscriptionRequired",
  too_many_active_jobs: "app.errors.tooManyJobs",
  too_many_renders: "app.errors.tooManyRenders",
  transcription_unavailable: "app.errors.serverBusy",
  unreadable_video: "app.errors.unreadableVideo",
  video_too_long: "app.errors.videoTooLong",
  video_too_short: "app.errors.videoTooShort",
};

/** Codes the browser itself gives a failure (no server answer to go by). */
export const CLIENT_ERROR_KEYS: Record<string, MessageKey> = {
  connection_lost: "app.errors.connection",
  // The upload code (a chunk) of this build is gone: a new one is live.
  app_updated: "app.errors.appUpdated",
  upload_interrupted: "app.errors.interrupted",
  server_no_response: "app.errors.serverNoResponse",
  // Refusals the upload protocol answers with (backend "protocol" codes).
  too_many_uploads: "app.errors.serverBusy",
  storage_unavailable: "app.errors.serverBusy",
  request_too_large: "app.errors.tooLarge",
  not_found: "app.errors.expired",
};

/** The v2 opt-in (Projects tiles) words these refusals on their own —
 *  not as "servers are busy": the video doesn't fit the server's disk
 *  right now (507), or too many uploads were started (429). The v1
 *  dashboard keeps ERROR_KEYS / CLIENT_ERROR_KEYS' wording. */
export const V2_ERROR_KEYS: Record<string, MessageKey> = {
  server_storage_full: "app.errors.serverStorageFull",
  too_many_uploads: "app.errors.tooManyUploads",
};

/** Notes on a job that still works. */
export const WARNING_KEYS: Record<string, MessageKey> = {
  script_unsupported: "app.warnings.scriptUnsupported",
  smartcam_failed: "app.warnings.smartcamFailed",
};

/** job.audio_warnings. */
export const AUDIO_WARNING_KEYS: Record<string, MessageKey> = {
  audio_clipping: "app.audio.clipping",
  audio_quiet: "app.audio.quiet",
  audio_silent: "app.audio.silent",
};

/** job.stage: where a running job is. */
export const STAGE_KEYS: Record<string, MessageKey> = {
  queued: "app.stage.queued",
  "analyze.normalize": "app.stage.analyze.normalize",
  "analyze.smartcam": "app.stage.analyze.smartcam",
  "analyze.transcribe": "app.stage.analyze.transcribe",
  "analyze.cleanup": "app.stage.analyze.cleanup",
  "analyze.cuts": "app.stage.analyze.cuts",
  "analyze.captions": "app.stage.analyze.captions",
  "analyze.done": "app.stage.analyze.done",
  "render.prepare": "app.stage.render.prepare",
  "render.captions": "app.stage.render.captions",
  "render.encode": "app.stage.render.encode",
  "render.hooks": "app.stage.render.hooks",
  "render.finish": "app.stage.render.finish",
};
