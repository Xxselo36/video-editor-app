// buildPhrases and friendlyError still live in app/app/page.tsx; vitest
// re-exports them as virtual:page-internals (see vitest.config.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPhrases, friendlyError, matchTemplate, type Subtitle } from "virtual:page-internals";
import { translate, type TFn } from "@/i18n";

const tEn: TFn = (key, vars) => translate("en", key, vars);
const tDe: TFn = (key, vars) => translate("de", key, vars);

const sub = (start: number, end: number, text: string, extra: Partial<Subtitle> = {}): Subtitle => ({
  start,
  end,
  text,
  ...extra,
});

describe("buildPhrases", () => {
  it("joins fragments up to the end of a sentence", () => {
    const p = buildPhrases([sub(0, 0.4, "Hello"), sub(0.4, 1, "world."), sub(1.2, 1.6, "Next"), sub(1.6, 2, "one")]);
    expect(p.map((x) => x.text)).toEqual(["Hello world.", "Next one"]);
    expect(p[0]).toMatchObject({ start: 0, end: 1 });
    expect(p[1]).toMatchObject({ start: 1.2, end: 2 });
  });

  it("ends a sentence at ?, ! and … and closing quotes", () => {
    const p = buildPhrases([
      sub(0, 1, "Really?"),
      sub(1, 2, "Yes!"),
      sub(2, 3, "Well…"),
      sub(3, 4, 'He said "stop."'),
      sub(4, 5, "Done"),
    ]);
    expect(p.map((x) => x.text)).toEqual(["Really?", "Yes!", "Well…", 'He said "stop."', "Done"]);
  });

  it("splits on a pause longer than 1.5 s", () => {
    expect(buildPhrases([sub(0, 1, "a"), sub(2.5, 3, "b")]).length).toBe(1);
    expect(buildPhrases([sub(0, 1, "a"), sub(2.6, 3, "b")]).length).toBe(2);
  });

  it("caps a phrase at 10 words (counting words inside fragments)", () => {
    const words = Array.from({ length: 11 }, (_, i) => sub(i * 0.3, i * 0.3 + 0.25, `w${i}`));
    expect(buildPhrases(words).map((x) => x.text.split(" ").length)).toEqual([10, 1]);
    const chunks = [sub(0, 1, "one two three four"), sub(1, 2, "five six seven"), sub(2, 3, "eight nine ten eleven")];
    expect(buildPhrases(chunks).map((x) => x.text)).toEqual([
      "one two three four five six seven",
      "eight nine ten eleven",
    ]);
  });

  it("keeps source times and averages the confidence", () => {
    const [p] = buildPhrases([
      sub(0, 1, "a", { original_start: 10, original_end: 11, confidence: 0.5 }),
      sub(1, 2, "b.", { original_start: 11.5, original_end: 12.5 }),
    ]);
    expect(p).toEqual({ start: 0, end: 2, original_start: 10, original_end: 12.5, confidence: 0.75, text: "a b." });
  });

  it("falls back to output times without source times", () => {
    const [p] = buildPhrases([sub(3, 4, "x.")]);
    expect(p).toMatchObject({ original_start: 3, original_end: 4, confidence: 1 });
  });

  it("skips empty fragments and trims text", () => {
    expect(buildPhrases([sub(0, 1, "  hi "), sub(1, 1.1, "   "), sub(1.1, 2, "there. ")])).toEqual([
      { start: 0, end: 2, original_start: 0, original_end: 2, confidence: 1, text: "hi there." },
    ]);
    expect(buildPhrases([])).toEqual([]);
  });
});

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

  it("today: 'No speech detected' falls through to the generic text (UX3 maps no_speech)", () => {
    expect(friendlyError("No speech detected in the video.", tEn)).toBe(tEn("app.errors.generic"));
  });
});
