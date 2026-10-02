// UX11: the export sheet's cost wording (honest minutes) and the Done
// view's survey rhythm.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLang, translate, type TFn } from "@/i18n";
import type { ExportFields } from "@/features/jobs/types";
import {
  SURVEY_EVERY_MS,
  clock,
  costHelp,
  costLine,
  downloadLabel,
  editAgainNote,
  noteExport,
  sizeText,
  surveyAnswered,
} from "./exportsInfo";

const tEn: TFn = (key, vars) => translate("en", key, vars);
const tDe: TFn = (key, vars) => translate("de", key, vars);

beforeAll(async () => {
  expect(await loadLang("de")).toBe(true);
});

const billed = (over: Partial<ExportFields> = {}): ExportFields => ({
  fair_use: { billed: true, free_total: 3, pct: 25, basis_seconds: 180 },
  free_renders_left: 2,
  next_render_cost_seconds: 0,
  ...over,
});

describe("clock", () => {
  it("m:ss, rounding up (a cost is never shown smaller)", () => {
    expect(clock(45)).toBe("0:45");
    expect(clock(44.2)).toBe("0:45");
    expect(clock(180)).toBe("3:00");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-3)).toBe("0:00");
  });
});

describe("costLine", () => {
  it("billing off: just Free, no counter", () => {
    const off = { fair_use: { billed: false, free_total: 3, pct: 25, basis_seconds: 60 }, free_renders_left: null };
    expect(costLine(off, tEn, "en")).toEqual({ text: "Free", note: null, paid: false });
    expect(costLine({}, tEn, "en").text).toBe("Free");
    expect(costHelp(off, tEn)).toBeNull();
    expect(editAgainNote(off, tEn, "en")).toBeNull();
  });

  it("free exports left", () => {
    expect(costLine(billed(), tEn, "en").text).toBe("Free · 2 of 3 free exports left for this video");
    expect(costLine(billed(), tDe, "de").text).toBe("Kostenlos · noch 2 von 3 Gratis-Exporten für dieses Video");
    expect(editAgainNote(billed({ free_renders_left: 1 }), tEn, "en")).toBe("1 of 3 free exports left for this video");
  });

  it("paid: what it records, of what, and what is left", () => {
    const job = billed({ free_renders_left: 0, next_render_cost_seconds: 45 });
    expect(costLine(job, tEn, "en", 71 * 60)).toEqual({
      text: "Uses 0:45 of your minutes (25 % of the 3:00 video)",
      note: "70 min left afterwards",
      paid: true,
    });
    expect(editAgainNote(job, tEn, "en")).toBe("The next export uses 0:45 of your minutes");
    expect(costHelp(job, tEn)).toContain("3 free exports");
  });

  it("over the quota it still runs, and says so", () => {
    const job = billed({ free_renders_left: 0, next_render_cost_seconds: 45 });
    const line = costLine(job, tEn, "en", 30);
    expect(line.note).toBe("Your minutes are used up – this export still runs.");
    expect(line.paid).toBe(true);
  });

  it("an instant export is free", () => {
    const job = billed({ free_renders_left: 0, next_render_cost_seconds: 45, spec_ready: true });
    expect(costLine(job, tEn, "en")).toEqual({ text: "Free · ready instantly", note: null, paid: false });
  });
});

describe("downloadLabel / sizeText", () => {
  it("names the frame, not 'Main edit'", () => {
    expect(downloadLabel("primary", 12 * 1024 * 1024, "9:16", tEn)).toBe("9:16 · 12 MB");
    expect(downloadLabel("16:9", 2.5 * 1024 * 1024, "9:16", tEn)).toBe("16:9 · 2.5 MB");
    expect(downloadLabel("primary", null, "original", tEn)).toBe("Video");
    expect(sizeText(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(sizeText(300)).toBe("1 KB");
  });
});

describe("survey rhythm", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  afterEach(() => store.clear());

  it("from the 2nd export on, at most once a week", () => {
    const t0 = 1_800_000_000_000;
    expect(noteExport("a:1", t0)).toBe(false); // the first export
    expect(noteExport("a:1", t0)).toBe(false); // the same one again
    expect(noteExport("b:1", t0)).toBe(true); // the second
    surveyAnswered(t0);
    expect(noteExport("c:1", t0 + 1000)).toBe(false);
    expect(noteExport("d:1", t0 + SURVEY_EVERY_MS)).toBe(true);
  });
});
