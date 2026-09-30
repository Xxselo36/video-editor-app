// Error text of the /app screens (lib/errors.legacy, moved from
// app/app/page.tsx in UX4).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { friendlyError, jobErrorText, matchTemplate } from "./errors.legacy";
import { translate, type TFn } from "@/i18n";

const tEn: TFn = (key, vars) => translate("en", key, vars);
const tDe: TFn = (key, vars) => translate("de", key, vars);

describe("matchTemplate", () => {
  it("reads the placeholder values of a filled template", () => {
    expect(matchTemplate("Larger than {max} GB (x.y)", "Larger than 4 GB (x.y)")).toEqual({ max: "4" });
    expect(matchTemplate("Larger than {max} GB (x.y)", "Larger than 4 GB (xzy)")).toBeNull();
  });

  it("compares literally without placeholders", () => {
    expect(matchTemplate("Plain.", "Plain.")).toEqual({});
    expect(matchTemplate("Plain.", "Plain!")).toBeNull();
  });
});

describe("friendlyError", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("maps nothing to the generic message", () => {
    expect(friendlyError("", tEn)).toBe(tEn("app.errors.generic"));
    expect(friendlyError(null, tEn)).toBe(tEn("app.errors.generic"));
    expect(friendlyError("something strange", tEn)).toBe(tEn("app.errors.generic"));
  });

  it("shows our stored English messages in the viewer's language", () => {
    expect(friendlyError(tEn("app.errors.expired"), tDe)).toBe(tDe("app.errors.expired"));
    const stored = tEn("app.errors.fileTooLarge", { max: 4 });
    expect(friendlyError(stored, tDe)).toBe(tDe("app.errors.fileTooLarge", { max: "4" }));
    expect(friendlyError(tEn("app.card.renderFailedNote"), tDe)).toBe(tDe("app.card.renderFailedNote"));
  });

  it("passes a user-facing sentence through", () => {
    expect(friendlyError("Your file is odd. Please export it again.", tDe)).toBe(
      "Your file is odd. Please export it again.",
    );
  });

  it.each([
    ['{"detail":"server_busy"}', "app.errors.serverBusy"],
    ['{"detail":"server_storage_full"}', "app.errors.serverBusy"],
    ["transcription_unavailable", "app.errors.serverBusy"],
    ["HTTP 507", "app.errors.serverBusy"],
    ['{"detail":"too_many_active_jobs"}', "app.errors.tooManyJobs"],
    ['{"detail":"unreadable_video"}', "app.errors.unreadableVideo"],
    ['{"detail":"auth_required"}', "app.errors.signInRequired"],
    ['{"detail":{"code":"subscription_required"}}', "app.errors.subscriptionRequired"],
    ['{"detail":{"code":"quota_exceeded"}}', "app.errors.quotaExceeded"],
    ["Upload stalled — no progress", "app.errors.connection"],
    ["Network error", "app.errors.connection"],
    ["TypeError: Failed to fetch", "app.errors.connection"],
    ["upload interrupted", "app.errors.interrupted"],
    ["404: job not found", "app.errors.expired"],
    ["413 Request Entity Too Large", "app.errors.tooLarge"],
    ["no audio stream in file", "app.errors.noAudio"],
    ["Render worker unavailable (modal_unavailable)", "app.errors.renderFailed"],
  ] as const)("classifies %s", (raw, key) => {
    expect(friendlyError(raw, tEn)).toBe(tEn(key));
  });

  it("reads the limit out of a raw refusal", () => {
    expect(friendlyError('{"detail":"file_too_large","max_gb":2}', tEn)).toBe(
      tEn("app.errors.fileTooLarge", { max: 2 }),
    );
    expect(friendlyError('{"detail":"video_too_long","max_minutes":10}', tEn)).toBe(
      tEn("app.errors.videoTooLong", { max: 10 }),
    );
    expect(friendlyError('{"detail":"video_too_long"}', tEn)).toBe(tEn("app.errors.videoTooLong", { max: 30 }));
  });

  it("maps the no-speech and no-audio texts of backends without error_code", () => {
    expect(friendlyError("No speech detected in the video.", tEn)).toBe(tEn("app.errors.noSpeech"));
    expect(friendlyError('400: {"detail":"no_audio"}', tDe)).toBe(tDe("app.errors.noAudioTrack"));
    expect(friendlyError("Video has no audio track", tEn)).toBe(tEn("app.errors.noAudioTrack"));
  });

  it("shows the stored no-speech messages in the viewer's language", () => {
    expect(friendlyError(tEn("app.errors.noSpeech"), tEn)).toBe(tEn("app.errors.noSpeech"));
    expect(friendlyError(tEn("app.errors.noAudioTrack"), tEn)).toBe(tEn("app.errors.noAudioTrack"));
    expect(friendlyError(tEn("app.errors.noSpeech"), tDe)).toBe(tDe("app.errors.noSpeech"));
    expect(friendlyError(tEn("app.errors.noSpeechRefunded"), tDe)).toBe(tDe("app.errors.noSpeechRefunded"));
    expect(friendlyError(tEn("app.errors.noAudioTrack"), tDe)).toBe(tDe("app.errors.noAudioTrack"));
  });
});

describe("jobErrorText", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("uses the job's error_code before its text", () => {
    const failed = { error: "No speech detected in the video.", message: "", error_code: "no_speech" };
    expect(jobErrorText(failed, tDe)).toBe(tDe("app.errors.noSpeech"));
    expect(jobErrorText({ ...failed, refunded: true }, tDe)).toBe(tDe("app.errors.noSpeechRefunded"));
    expect(jobErrorText({ ...failed, refunded: false }, tEn)).toBe(tEn("app.errors.noSpeech"));
    expect(jobErrorText({ error: "Video has no audio track", error_code: "no_audio", refunded: true }, tEn)).toBe(
      tEn("app.errors.noAudioTrack"),
    );
  });

  it("says the minutes came back only when the job says so", () => {
    expect(tEn("app.errors.noSpeech")).not.toMatch(/credited/);
    expect(tEn("app.errors.noSpeechRefunded")).toMatch(/credited back/);
  });

  it("falls back to the text without a known code", () => {
    expect(jobErrorText({ error: '{"detail":"server_busy"}', error_code: null }, tEn)).toBe(tEn("app.errors.serverBusy"));
    expect(jobErrorText({ error: null, message: "", error_code: "something_new" }, tEn)).toBe(tEn("app.errors.generic"));
  });
});
