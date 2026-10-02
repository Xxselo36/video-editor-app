"""Error, warning and stage codes (UX5): the one catalogue the API, the
pipeline and the task queue's worker share.

Clients get codes, never our raw text:

  job.error_code / error_params   why a job failed (JOB_ERRORS), with the
                                  numbers its message needs
  job.stage / stage_params        where a running job is (STAGES); the
                                  English `message` stays for old clients
  job.audio_warnings              codes (AUDIO_WARNINGS) instead of the
                                  English sentences of before UX5
  HTTP error bodies               {"detail", "code", "params"}: `detail`
                                  unchanged (old clients read it), `code`
                                  a catalogue code, `params` its numbers

The raw exception text stays in job.error — served to admins only
(backend/jobs.py Job.to_dict) and reported to Sentry where it happens.

`catalogue()` is what the web app gets as web/src/lib/errorCodes.json
(backend/tests/test_ux5_contract.py keeps the file in sync); its i18n
check asserts every user-facing code has a message in every language.

This module is stdlib-only apart from backend.db (the transient-error
test): the worker (backend/worker.py) imports it on Modal too.
"""
from __future__ import annotations

import re
from typing import Any, Mapping

# ── job errors (job.error_code) ──────────────────────────────────────
# code → the English text a job's `message` and (for everyone but
# admins) `error` get for it. New web builds translate the code; builds
# from before UX5 show this text: their friendlyError passes a sentence
# with "Please" through as it is and maps the others by keywords
# ("no speech detected", "no audio track", "render"), so every text here
# either asks something with "Please" or carries the keyword of its old
# mapping. {name}: error_params.

JOB_ERRORS: dict[str, str] = {
    # The video's fault (content), refused or failed.
    "no_speech": "No speech detected in the video.",
    "no_audio": "This video has no audio track.",
    "no_video": "This is an audio file. Please upload a video.",
    "video_too_short": "The video is shorter than {min_seconds} seconds. "
                       "Please upload a longer one.",
    "video_too_long": "The video is longer than {max_minutes} minutes. "
                      "Please upload a shorter one.",
    "file_too_large": "The file is larger than {max_gb} GB. "
                      "Please export it smaller.",
    "audio_silent": "The audio is silent.",
    "unreadable_video": "The video could not be read. "
                        "Please export it again as MP4 and upload that.",
    # Ours / a provider's.
    "transcription_unavailable": "Transcription is unavailable right now. "
                                 "Please try again in a few minutes.",
    "server_storage_full": "Our servers are busy. "
                           "Please try again in a few minutes.",
    "server_busy": "Our servers are busy. Please try again in a few minutes.",
    "processing_interrupted":
        "Processing was interrupted. Please upload the video again.",
    "processing_failed": "Processing failed. Please try again.",
    # Renders (the job goes back to review with these).
    "render_failed": "Render failed. Your edits are saved — please open "
                     "the project and export again.",
    "render_unavailable": "The render service is unavailable. "
                          "Please try again later.",
    "render_timeout": "The render took too long. Please try again.",
    # Media and billing.
    "media_expired": "This project's files have expired. "
                     "Please upload the video again.",
    "media_unavailable": "The original video is no longer available. "
                         "Please upload it again.",
    "quota_exceeded": "Not enough minutes left. Please choose a plan.",
    "subscription_required": "A plan is required. Please choose one.",
    # Refusals of the editor / export API (HTTP only today).
    "too_many_active_jobs": "Too many videos in progress. "
                            "Please wait until one is done.",
    "too_many_renders": "Too many exports in progress. "
                        "Please wait until one is done.",
    "render_limit": "This video reached its export limit for today. "
                    "Please try again tomorrow.",
    "stale_rev": "Changed in another tab. Please reload.",
    "doc_not_ready": "The project isn't ready yet. Please try again shortly.",
    "already_rendering": "This video is already being exported. "
                         "Please wait for it.",
    "not_in_review": "This video is already being exported. "
                     "Please wait for it.",
    "auth_required": "Please sign in again.",
}

# Non-fatal notes on a job that still works (job.format_warning, UX6;
# per-script caption support, UT5).
JOB_WARNINGS: dict[str, str] = {
    "script_unsupported": "Captions aren't available for this script yet.",
    "smartcam_failed": "Speaker tracking failed; the video was centre-cropped.",
}

# ── audio warnings (job.audio_warnings) ──────────────────────────────
# From the ffmpeg volumedetect pre-check (backend/pipeline.py
# _precheck_audio). Nothing here claims a fix the pipeline doesn't make.

AUDIO_WARNINGS: dict[str, str] = {
    "audio_silent": "Audio looks silent — check your microphone is on and not muted.",
    "audio_quiet": "Audio is very quiet — speak closer to the microphone for best results.",
    "audio_clipping": "Audio is clipping at peaks — recording too loud, distortion likely.",
}

# The English sentences jobs analysed before UX5 stored (and the code
# each became). Their milder "Audio is on the quiet side but should
# still work." note is gone: nothing to do about it.
_LEGACY_AUDIO: dict[str, str] = {
    text: code for code, text in AUDIO_WARNINGS.items()}
_QUIET_SIDE = "Audio is on the quiet side but should still work."


def audio_warning_texts(values: Any) -> list[str]:
    """job.audio_warnings as the English sentences clients from before
    UX5 show as they are: codes worded, stored sentences kept (also the
    old "quiet side" note), anything else dropped; each once."""
    out: list[str] = []
    for v in values or ():
        text = AUDIO_WARNINGS.get(v) or (str(v) if v in _LEGACY_AUDIO
                                         or v == _QUIET_SIDE else None)
        if text and text not in out:
            out.append(text)
    return out


def audio_warning_codes(values: Any) -> list[str]:
    """job.audio_warnings as codes: stored codes kept, the English
    sentences of older jobs mapped, anything else dropped; each once."""
    out: list[str] = []
    for v in values or ():
        code = v if v in AUDIO_WARNINGS else _LEGACY_AUDIO.get(str(v))
        if code and code not in out:
            out.append(code)
    return out


# ── stages (job.stage) ───────────────────────────────────────────────
# code → the English progress text (job.message) for old clients.
# {name}: stage_params. A stage is coarse; the pipeline's finer messages
# (Whisper's "Transcribing (35%)…") keep the stage they happen in.

STAGES: dict[str, str] = {
    "queued": "queued",   # clients match this message literally
    "analyze.normalize": "Preparing video…",
    "analyze.smartcam": "SmartCam tracking faces…",
    "analyze.transcribe": "Analyzing audio…",
    "analyze.cleanup": "Polishing transcript…",
    "analyze.cuts": "Building preview…",
    "analyze.captions": "Preparing captions…",
    "analyze.done": "Review subtitles",
    "render.prepare": "Preparing render…",
    "render.captions": "Rendering captions {i}/{n}…",
    "render.encode": "Rendering…",
    "render.hooks": "Cutting hooks…",
    "render.finish": "Saving…",
}


class StageMessage(str):
    """A progress message that knows its stage: the English text (what
    progress callbacks always got, so every callback keeps working) plus
    `code` and `params`. The progress writers store all three
    (stage_fields)."""

    code: str
    params: dict[str, Any]

    def __new__(cls, text: str, code: str,
                params: Mapping[str, Any] | None = None) -> "StageMessage":
        obj = super().__new__(cls, text)
        obj.code = code
        obj.params = dict(params or {})
        return obj


def stage_message(code: str, text: str | None = None,
                  **params: Any) -> StageMessage:
    """The progress message of `code`: `text` (a finer English message)
    or the catalogue's, filled in with `params`."""
    if code not in STAGES:
        raise KeyError(f"unknown stage {code!r}")
    tmpl = STAGES[code] if text is None else text
    return StageMessage(_fill(tmpl, params), code, params)


def stage_fields(msg: Any) -> dict[str, Any]:
    """The job fields a progress message writes: always `message`;
    `stage` / `stage_params` too when it is a StageMessage (a plain one
    keeps the stage the job is in)."""
    fields: dict[str, Any] = {"message": str(msg)}
    code = getattr(msg, "code", None)
    if code:
        fields["stage"] = code
        fields["stage_params"] = dict(getattr(msg, "params", None) or {})
    return fields


def stage(code: str, **params: Any) -> dict[str, Any]:
    """Job fields for a stage written directly (store.update(**stage(…)))."""
    return stage_fields(stage_message(code, **params))


# ── HTTP error bodies ────────────────────────────────────────────────
# Codes the API answers with that only the client's code handles (the
# upload protocol, validation); they need no user-facing message.

PROTOCOL_CODES: frozenset[str] = frozenset({
    "bad_request", "invalid_request", "invalid_json", "forbidden",
    "not_found", "not_available", "method_not_allowed", "conflict", "gone",
    "request_too_large", "too_many_requests", "server_error", "bad_gateway",
    "service_unavailable",
    # uploads (backend/uploads.py, lib/chunkedUpload.ts)
    "use_single_put", "bad_ticket", "upload_expired", "storage_error",
    "storage_unavailable", "upload_incomplete", "upload_already_used",
    "bad_part_numbers", "parts_missing", "too_many_uploads",
    "event_required",
    # the editor / media routes
    "proxy_not_ready", "preview_not_ready", "format_not_ready",
    "thumbnail_not_ready", "timeline_too_long", "too_many_segments",
    "invalid_segments", "invalid_payload", "too_many_ids",
    "unknown_caption_preset", "busy",
    # the edit document (UT3, backend/doc.py)
    "no_doc", "doc_read_only", "doc_patch_too_large", "peaks_not_ready",
    "poster_not_ready",
    "bad_format", "bad_rev", "bad_style", "bad_word", "bad_words",
    "clips_not_supported", "duplicate_word_id", "preset_not_live",
    "too_many_words", "unknown_field", "unknown_preset",
    "word_out_of_range", "words_not_monotonic",
    # billing / admin
    "billing_disabled", "unknown_plan", "test_mode_testers_only",
    "already_subscribed", "checkout_failed", "no_subscription",
    "bad_signature", "bad_admin_token", "webhook_failed", "presign_failed",
    # remembered upload defaults (UX6, backend/prefs.py)
    "bad_prefs",
})

# Codes by status, for errors raised with free text.
_STATUS_CODES: dict[int, str] = {
    400: "bad_request", 401: "auth_required", 403: "forbidden",
    404: "not_found", 405: "method_not_allowed", 409: "conflict",
    410: "gone", 413: "request_too_large", 422: "invalid_request",
    429: "too_many_requests", 500: "server_error", 502: "bad_gateway",
    503: "service_unavailable", 507: "server_storage_full",
}

# Free-text details of the routes (prefix match, lower case) → code.
_TEXT_CODES: tuple[tuple[str, str], ...] = (
    ("job not found", "not_found"),
    ("job not in review state", "not_in_review"),
    ("job not ready for review", "not_in_review"),
    ("job is still processing", "busy"),
    ("normalized video no longer on disk", "media_expired"),
    ("preview video not ready", "preview_not_ready"),
    ("requested format not ready", "format_not_ready"),
    ("thumbnail not ready", "thumbnail_not_ready"),
    ("unknown caption preset", "unknown_caption_preset"),
    ("segments must be", "invalid_segments"),
    ("no valid segments", "invalid_segments"),
    ("payload.", "invalid_payload"),
    ("phrases must be", "invalid_payload"),
    ("invalid events payload", "invalid_payload"),
    ("settings must be", "invalid_payload"),
    ("either 'file'", "invalid_payload"),
    ("storage_key not yours", "forbidden"),
    ("days must be", "invalid_payload"),
    ("bad signature", "bad_signature"),
    ("invalid json", "invalid_json"),
    ("invalid payload", "invalid_payload"),
    ("webhook processing failed", "webhook_failed"),
    ("bad admin token", "bad_admin_token"),
    ("presign failed", "presign_failed"),
    ("not found", "not_found"),
)

_CODE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def http_code(status: int, detail: Any) -> tuple[str, dict[str, Any]]:
    """(code, params) of an HTTP error: a `{"code": …}` detail gives its
    code and the rest as params; a snake_case detail is the code; free
    text goes through _TEXT_CODES, else the status' code."""
    if isinstance(detail, Mapping):
        code = detail.get("code")
        if isinstance(code, str) and code:
            return code, {k: v for k, v in detail.items() if k != "code"}
    if isinstance(detail, str):
        if _CODE_RE.match(detail):
            return detail, {}
        low = detail.strip().lower()
        for prefix, code in _TEXT_CODES:
            if low.startswith(prefix):
                return code, {}
    return _STATUS_CODES.get(int(status), "server_error" if status >= 500
                             else "bad_request"), {}


def http_body(status: int, detail: Any,
              extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The JSON body of an HTTP error: `detail` exactly as before, the
    refusal's extra fields next to it as before ({"detail":
    "file_too_large", "max_gb": 4}), plus `code` and `params`."""
    code, params = http_code(status, detail)
    extra = dict(extra or {})
    return {"detail": detail, **extra, "code": code,
            "params": {**params, **extra}}


def refusal_body(code: str, **params: Any) -> dict[str, Any]:
    """http_body of a refusal answered without an exception (the body
    limit middleware)."""
    return http_body(413 if code in ("file_too_large", "request_too_large")
                     else 400, code, params)


# ── classification (backend/main.py WP1 path + backend/worker.py) ────

# The English sentence pipelines from before NoSpeechError raise.
NO_SPEECH_TEXT = "No speech detected in the video."
# How the transcription step says the video has no sound track at all
# (src/audio.py: "Video has no audio track") — an upload POST /jobs
# couldn't probe (no_audio is normally refused there, before the charge).
NO_AUDIO_TEXTS = ("no audio track", "no audio stream", "has no audio")


def analysis_error_code(exc: BaseException, msg: str) -> str | None:
    """job.error_code of a failed analysis, or None when there is no
    specific one (the client shows a generic message)."""
    if getattr(exc, "code", None) == "no_speech" or msg.strip() == NO_SPEECH_TEXT:
        return "no_speech"
    low = msg.lower()
    if any(t in low for t in NO_AUDIO_TEXTS):
        return "no_audio"
    if msg == "server_storage_full":
        return "server_storage_full"
    if msg == "container_restart":
        return "processing_interrupted"
    if (low.startswith("transcription_unavailable")
            or type(exc).__name__ == "GroqTranscriptionError"):
        return "transcription_unavailable"
    if low.startswith("ffmpeg"):
        # Normalizing the upload failed: a file ffmpeg can't decode.
        return "unreadable_video"
    return None


def render_error_code(exc: BaseException) -> str:
    """job.error_code of a failed render: render_timeout /
    render_unavailable when the render worker gave up
    (pipeline.RenderUnavailableError), else render_failed."""
    if type(exc).__name__ == "RenderUnavailableError":
        return ("render_timeout" if getattr(exc, "code", None) == "render_timeout"
                else "render_unavailable")
    return "render_failed"


def is_infra_failure(exc: BaseException, msg: str) -> bool:
    """Analysis failures that are our fault (full disk, IO, ffmpeg,
    restart) give the minutes back. Content problems don't — they
    already cost Groq/Claude time, and a refund would let the same file
    be retried for free forever — except a video with (almost) no
    speech at all (refund_content_failure). The database staying down
    (a finished analysis that couldn't be saved) is ours too."""
    from backend import db
    if msg in ("server_storage_full", "container_restart"):
        return True
    if isinstance(exc, (OSError, MemoryError)) or db.is_transient(exc):
        return True
    return msg.lower().startswith("ffmpeg")


def refund_content_failure(exc: BaseException, code: str | None,
                           no_speech_refund_s: float) -> bool:
    """A content failure whose minutes still go back: no sound track at
    all (never charged), or no speech with less than
    `no_speech_refund_s` of it detected."""
    if code == "no_audio":
        return True
    if code != "no_speech":
        return False
    speech = getattr(exc, "speech_seconds", 0.0) or 0.0
    return float(speech) < no_speech_refund_s


def job_error(code: str | None, **params: Any) -> dict[str, Any]:
    """The client-facing fields of a failed job: error_code, error_params
    and the catalogue's English `message` for it ("Processing failed."
    without a known code) — never the raw text, which goes to `error`."""
    tmpl = JOB_ERRORS.get(code or "", JOB_ERRORS["processing_failed"])
    return {"error_code": code, "error_params": dict(params),
            "message": _fill(tmpl, params)}


def no_error() -> dict[str, Any]:
    """The fields that clear a job's last error (a new render starts)."""
    return {"error": None, "error_code": None, "error_params": {}}


def public_text(code: str | None, params: Mapping[str, Any] | None = None) -> str:
    """The catalogue's English text of a failure ("Processing failed."
    without a known code)."""
    tmpl = JOB_ERRORS.get(code or "", JOB_ERRORS["processing_failed"])
    return _fill(tmpl, params or {})


def public_error(error: str | None, code: str | None,
                 params: Mapping[str, Any] | None = None) -> str | None:
    """What a non-admin sees of job.error: the catalogue's English text
    for its code (public_text), never the raw text — that may hold
    paths, provider answers or transcript words. Old clients word it as
    they always did (JOB_ERRORS); new ones read error_code."""
    if not error:
        return None
    return public_text(code, params)


# ── export for the web app ───────────────────────────────────────────


def user_error_codes() -> list[str]:
    """Codes a user can see as an error message (need an i18n key)."""
    return sorted(JOB_ERRORS)


def catalogue() -> dict[str, Any]:
    """web/src/lib/errorCodes.json."""
    return {
        "errors": user_error_codes(),
        "warnings": sorted(JOB_WARNINGS),
        "audio_warnings": sorted(AUDIO_WARNINGS),
        "stages": sorted(STAGES),
        "protocol": sorted(PROTOCOL_CODES - set(JOB_ERRORS)),
    }


def _fill(tmpl: str, params: Mapping[str, Any]) -> str:
    out = tmpl
    for k, v in params.items():
        out = out.replace("{" + k + "}", str(v))
    return out
