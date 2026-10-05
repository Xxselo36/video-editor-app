// Error text by code (lib/errors, UX5) and counts (lib/i18n/plural).
import { beforeAll, describe, expect, it } from "vitest";
import { loadLang, translate, type TFn } from "@/i18n";
import { ApiError } from "@/lib/api";
import {
  audioWarningText,
  cardError,
  cardErrorText,
  cardNoteText,
  describeError,
  errorFromApi,
  jobErrorText,
  legacyCardCode,
  renderFailedNote,
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
  it("store the code (worded per viewer) and the English sentence (older tabs)", () => {
    const stored = cardError(new ApiError(429, "too_many_active_jobs", { code: "too_many_active_jobs", params: {} }));
    expect(stored).toEqual({
      error: tEn("app.errors.tooManyJobs"),
      errorCode: "too_many_active_jobs",
      errorParams: {},
      refunded: null,
    });
    expect(cardErrorText(stored, tDe)).toBe(tDe("app.errors.tooManyJobs"));
  });

  it("translate the English sentences cards stored before UX5 (findings 8, 11)", () => {
    expect(cardErrorText({ error: tEn("app.errors.expired") }, tDe)).toBe(tDe("app.errors.expired"));
    // Filled-in templates keep their numbers.
    expect(cardErrorText({ error: tEn("app.errors.fileTooLarge", { max: 4 }) }, tDe)).toBe(
      tDe("app.errors.fileTooLarge", { max: 4 }),
    );
    expect(cardErrorText({ error: tEn("app.errors.noSpeechRefunded") }, tDe)).toBe(tDe("app.errors.noSpeechRefunded"));
    expect(legacyCardCode(tEn("app.errors.videoTooLong", { max: 30 }))).toEqual({
      code: "video_too_long",
      params: { max_minutes: 30 },
    });
  });

  it("never show raw stored text: answers, HTML, browser messages", () => {
    expect(cardErrorText({ error: 'Upload failed: {"detail":"storage_unavailable"}' }, tDe)).toBe(
      tDe("app.errors.serverBusy"),
    );
    expect(cardErrorText({ error: "Upload failed: <html><body>502 Bad Gateway</body></html>" }, tDe)).toBe(
      tDe("app.errors.generic"),
    );
    expect(cardErrorText({ error: "Network error" }, tDe)).toBe(tDe("app.errors.connection"));
    expect(
      cardErrorText({ error: "Upload was interrupted (page reloaded or connection lost). Please upload the video again." }, tDe),
    ).toBe(tDe("app.errors.interrupted"));
  });

  it("translate the render-failed note, old or new (finding 13)", () => {
    expect(renderFailedNote()).toEqual({ note: tEn("app.card.renderFailedNote"), noteCode: "render_failed" });
    expect(cardNoteText({ note: tEn("app.card.renderFailedNote") }, tDe)).toBe(tDe("app.card.renderFailedNote"));
    expect(cardNoteText(renderFailedNote(), tDe)).toBe(tDe("app.card.renderFailedNote"));
  });
});

describe("upload refusals on the v2 opt-in (Oct 2026: storage full read as 'busy')", () => {
  const storageFull = new ApiError(507, "server_storage_full", {
    detail: "server_storage_full",
    code: "server_storage_full",
    params: {},
  });
  const tooMany = new ApiError(429, "too_many_uploads", { detail: "too_many_uploads", code: "too_many_uploads", params: {} });

  it("words 507 storage full and 429 too_many_uploads on their own, in every language", () => {
    expect(describeError(storageFull, tEn, { v2: true })).toBe(
      "This video is too large for our servers right now — try again in a few minutes or shorten it.",
    );
    expect(describeError(storageFull, tDe, { v2: true })).toBe(
      "Dieses Video ist gerade zu groß für unsere Server — versuch es in ein paar Minuten nochmal oder kürze es.",
    );
    expect(describeError(tooMany, tEn, { v2: true })).toBe("Too many uploads in a short time — wait a few minutes.");
    expect(describeError(tooMany, tDe, { v2: true })).toBe("Zu viele Uploads in kurzer Zeit — warte ein paar Minuten.");
    for (const code of ["server_storage_full", "too_many_uploads"]) {
      expect(describeError({ code }, tDe, { v2: true })).not.toBe(tDe("app.errors.serverBusy"));
    }
    expect(tDe("app.projects.errorCode", { code: "server_storage_full" })).toBe("Code: server_storage_full");
  });

  it("keeps 'servers are busy' for a full queue — and everywhere on v1", () => {
    expect(describeError({ code: "server_busy" }, tEn, { v2: true })).toBe(tEn("app.errors.serverBusy"));
    expect(describeError(storageFull, tEn)).toBe(tEn("app.errors.serverBusy"));
    expect(describeError(tooMany, tDe)).toBe(tDe("app.errors.serverBusy"));
    expect(cardErrorText(cardError(storageFull), tDe)).toBe(tDe("app.errors.serverBusy"));
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
