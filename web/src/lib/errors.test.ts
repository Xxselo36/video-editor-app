// Error text by code (lib/errors, UX5) and counts (lib/i18n/plural).
import { beforeAll, describe, expect, it } from "vitest";
import { loadLang, translate, type TFn } from "@/i18n";
import { ApiError } from "@/lib/api";
import {
  audioWarningText,
  cardError,
  cardErrorText,
  describeError,
  errorFromApi,
  jobErrorText,
  stageText,
} from "@/lib/errors";
import { plural, pluralCategory } from "@/lib/i18n/plural";

const tEn: TFn = (key, vars) => translate("en", key, vars);
const tDe: TFn = (key, vars) => translate("de", key, vars);

beforeAll(async () => {
  expect(await loadLang("de")).toBe(true);
});

describe("errorFromApi", () => {
  it("reads the UX5 body: code and params", () => {
    const e = new ApiError(413, "file_too_large", {
      detail: "file_too_large", max_gb: 4, code: "file_too_large", params: { max_gb: 4 },
    });
    expect(errorFromApi(e)).toEqual({ code: "file_too_large", params: { max_gb: 4 } });
  });

  it("reads older bodies: detail and the fields next to it", () => {
    expect(errorFromApi(new ApiError(413, "video_too_long", { detail: "video_too_long", max_minutes: 30 }))).toEqual({
      code: "video_too_long",
      params: { max_minutes: 30 },
    });
    const quota = new ApiError(402, { code: "quota_exceeded", remaining_seconds: 5 }, null);
    expect(errorFromApi(quota)).toEqual({ code: "quota_exceeded", params: { remaining_seconds: 5 } });
  });
});

describe("describeError", () => {
  it("words a code in the viewer's language, with its numbers", () => {
    const e = new ApiError(400, "video_too_short", {
      detail: "video_too_short", code: "video_too_short", params: { min_seconds: 3 },
    });
    expect(describeError(e, tDe)).toBe(tDe("app.errors.videoTooShort", { min: 3 }));
    expect(describeError(e, tDe)).toContain("3");
    expect(describeError({ code: "file_too_large", params: { max_gb: 2 } }, tEn)).toBe(
      tEn("app.errors.fileTooLarge", { max: 2 }),
    );
  });

  it("says when the minutes of a no-speech failure came back", () => {
    expect(describeError({ code: "no_speech", refunded: true }, tEn)).toBe(tEn("app.errors.noSpeechRefunded"));
    expect(describeError({ code: "no_speech" }, tEn)).toBe(tEn("app.errors.noSpeech"));
  });

  it("maps the browser's own failures", () => {
    expect(describeError(new Error("Network error"), tEn)).toBe(tEn("app.errors.connection"));
    expect(describeError(new Error("Upload stalled — no progress for 60 seconds."), tEn)).toBe(
      tEn("app.errors.connection"),
    );
    expect(describeError(new Error("weird"), tEn)).toBe(tEn("app.errors.generic"));
  });

  it("falls back to the generic message for an unknown code", () => {
    expect(describeError({ code: "from_a_later_release" }, tEn)).toBe(tEn("app.errors.generic"));
    expect(jobErrorText({ error_code: null }, tEn)).toBe(tEn("app.errors.generic"));
  });
});

describe("job cards", () => {
  it("store codes and word them when they render", () => {
    const stored = cardError(new ApiError(429, "too_many_active_jobs", { code: "too_many_active_jobs", params: {} }));
    expect(stored).toEqual({ error: "too_many_active_jobs", errorParams: {}, refunded: null });
    expect(cardErrorText(stored, tDe)).toBe(tDe("app.errors.tooManyJobs"));
  });

  it("show a sentence stored before UX5 as it is", () => {
    const old = "This project no longer exists on the server (expired or server update). Please upload the video again.";
    expect(cardErrorText({ error: old }, tDe)).toBe(old);
  });
});

describe("warnings and stages", () => {
  it("words audio warning codes; older text passes through", () => {
    expect(audioWarningText("audio_quiet", tDe)).toBe(tDe("app.audio.quiet"));
    expect(audioWarningText("Audio is odd.", tDe)).toBe("Audio is odd.");
  });

  it("words stages with their numbers", () => {
    expect(stageText("render.captions", { i: 2, n: 5 }, tEn)).toBe("Adding captions (2/5)");
    expect(stageText("analyze.transcribe", null, tDe)).toBe(tDe("app.stage.analyze.transcribe"));
    expect(stageText(null, null, tEn)).toBeNull();
    expect(stageText("analyze.unknown", null, tEn)).toBeNull();
  });
});

describe("plural", () => {
  const forms = { one: "one", few: "few", many: "many", other: "other" };
  it("follows each language's rules", () => {
    expect(plural("en", 1, forms)).toBe("one");
    expect(plural("en", 21, forms)).toBe("other");
    expect(plural("ru", 21, forms)).toBe("one");
    expect(plural("ru", 3, forms)).toBe("few");
    expect(plural("pl", 5, forms)).toBe("many");
    expect(pluralCategory("ja", 1)).toBe("other");
  });

  it("falls back to other for a form the caller has no text for", () => {
    expect(plural("ru", 3, { one: "one", other: "other" })).toBe("other");
  });
});

describe("lazy languages", () => {
  it("answer in English until loaded, then in the language", async () => {
    expect(translate("fr", "app.errors.generic")).toBe(tEn("app.errors.generic"));
    expect(await loadLang("fr")).toBe(true);
    expect(translate("fr", "app.errors.generic")).not.toBe(tEn("app.errors.generic"));
  });
});
