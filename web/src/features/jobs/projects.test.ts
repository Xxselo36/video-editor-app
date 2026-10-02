// The jobs store's pure part (UX12): project states, the merge of this
// device's list with the server's, and the migration of the lists of
// before UX12.
import { describe, expect, it } from "vitest";
import { legacyCardCode } from "@/lib/errors";
import {
  analysisEta,
  emptyListAction,
  capLocal,
  daysLeft,
  matchesFilter,
  matchesSearch,
  MAX_LOCAL,
  mergeLocal,
  mergeProjects,
  middleEllipsis,
  migrateLegacy,
  MISSING,
  parseLocal,
  remoteFrom,
  stateOf,
  type LocalJob,
  type Remote,
} from "./projects";

const NOW = 1_800_000_000_000;
const row = (o: Record<string, unknown>) => remoteFrom({ id: "j1", status: "processing", progress: 10, message: "", ...o });
const local = (id: string, extra: Partial<LocalJob> = {}): LocalJob => ({ jobId: id, timestamp: NOW - 1000, filename: `${id}.mp4`, ...extra });

describe("stateOf", () => {
  it("names every status", () => {
    const s = (o: Record<string, unknown>, hint = false) => stateOf(local("j1"), row(o), { now: NOW, exportHint: hint });
    expect(s({ status: "pending" })).toBe("processing");
    expect(s({ stage: "analyze.transcribe" })).toBe("processing");
    expect(s({ stage: "render.encode" })).toBe("exporting");
    // Waiting for a render slot: an export when it was in review before.
    expect(s({ stage: "queued" })).toBe("processing");
    expect(s({ stage: "queued" }, true)).toBe("exporting");
    expect(s({ stage: "queued", has_output: true })).toBe("exporting");
    expect(s({ status: "awaiting_review" })).toBe("ready");
    expect(s({ status: "awaiting_review", has_output: true })).toBe("edited");
    expect(s({ status: "done", has_output: true })).toBe("exported");
    expect(s({ status: "error", error_code: "no_speech" })).toBe("failed");
    expect(s({ status: "done", expires_at: (NOW - 1000) / 1000 })).toBe("expired");
    expect(stateOf(local("j1"), MISSING, { now: NOW })).toBe("expired");
    expect(stateOf(local("j1"), undefined, { now: NOW })).toBe("unknown");
  });

  it("an upload record is an upload, failed with its code", () => {
    expect(stateOf(local("upl-1", { upload: { pct: 40 } }), undefined, { now: NOW })).toBe("uploading");
    expect(stateOf(local("upl-1", { upload: { errorCode: "connection_lost" } }), undefined, { now: NOW })).toBe("upload_failed");
  });

  it("a failed render back in review carries the note", () => {
    const r = row({ status: "awaiting_review", error_code: "render_failed" });
    expect(r.renderFailed).toBe(true);
    expect(row({ status: "awaiting_review" }).renderFailed).toBe(false);
  });
});

describe("mergeProjects", () => {
  it("joins this device's list and the account's, newest first; the server's title wins", () => {
    const remotes = new Map<string, Remote>([
      ["a", row({ id: "a", status: "done", has_output: true, title: "Folge 12", created_at: (NOW - 5000) / 1000 })],
      ["b", row({ id: "b", status: "awaiting_review", filename: "other.mov", created_at: (NOW - 500) / 1000 })],
      ["gone", MISSING],
    ]);
    const list = mergeProjects([local("a", { timestamp: NOW - 5000 }), local("gone", { timestamp: NOW - 9000 })], remotes, ["a", "b"], { now: NOW });
    expect(list.map((p) => [p.id, p.state, p.name, p.local])).toEqual([
      ["b", "ready", "other.mov", false],
      ["a", "exported", "Folge 12", true],
      ["gone", "expired", "gone.mp4", true],
    ]);
  });
});

describe("the stored list", () => {
  it("parses defensively and caps (uploads are kept)", () => {
    expect(parseLocal("not json")).toEqual([]);
    expect(parseLocal('{"a":1}')).toEqual([]);
    expect(parseLocal('[{"jobId":"a","timestamp":2},{"jobId":"a","timestamp":3},{"x":1},null]')).toEqual([
      { jobId: "a", timestamp: 2, filename: "" },
    ]);
    const many = Array.from({ length: MAX_LOCAL + 5 }, (_, i) => local(`j${i}`, { timestamp: i + 10 }));
    const capped = capLocal([...many, local("upl-old", { timestamp: 0, upload: {} })]);
    expect(capped).toHaveLength(MAX_LOCAL);
    expect(capped.some((j) => j.jobId === "upl-old")).toBe(true);
    expect(capped[0].jobId).toBe(`j${MAX_LOCAL + 4}`);
  });

  it("mergeLocal adds what's missing, keeps what's there", () => {
    const base = [local("a", { name: "Mine" })];
    expect(mergeLocal(base, [local("a"), local("b")]).map((j) => [j.jobId, j.name ?? null])).toEqual([
      ["a", "Mine"],
      ["b", null],
    ]);
  });
});

describe("migrateLegacy", () => {
  const cards = [
    { jobId: "rev1", phase: "reviewing", timestamp: 3, filename: "echt.mp4", presetId: "tiktok", presetLabel: "TikTok / Reels", captionPreset: "clipper", error: "x" },
    { jobId: "ren1", phase: "rendering", timestamp: 4, filename: "render.mp4", presetId: null, presetLabel: null },
    { jobId: "upl-1", phase: "uploading", timestamp: 5, filename: "big.mov", uploadPct: 42, fileSize: 9 },
    {
      jobId: "upl-2",
      phase: "uploading",
      timestamp: 6,
      filename: "toolong.mp4",
      error: "This video is longer than 30 minutes. Please trim it or split it into parts.",
    },
    { jobId: "upl-3", phase: "uploading", timestamp: 7, filename: "a.mp4", errorCode: "no_audio" },
    { nope: true },
  ];
  const library = [
    { jobId: "done1", timestamp: 1, filename: "fertig.mp4", presetId: null, presetLabel: "Custom", outputs: ["primary"], socialCaption: "x" },
    { jobId: "rev1", timestamp: 9, filename: "", outputs: [] },
  ];

  it("keeps ids, names and upload records — never statuses or sentences", () => {
    const m = migrateLegacy(JSON.stringify(cards), JSON.stringify(library), legacyCardCode);
    const byId = Object.fromEntries(m.jobs.map((j) => [j.jobId, j]));
    expect(Object.keys(byId).sort()).toEqual(["done1", "ren1", "rev1", "upl-1", "upl-2", "upl-3"]);
    expect(byId.rev1).toEqual({ jobId: "rev1", timestamp: 3, filename: "echt.mp4", presetId: "tiktok", presetLabel: "TikTok / Reels" });
    expect(byId.done1).toEqual({ jobId: "done1", timestamp: 1, filename: "fertig.mp4", presetId: null, presetLabel: "Custom" });
    // An upload from an earlier page load can't be running: failed.
    expect(byId["upl-1"].upload).toEqual({ pct: 42, errorCode: "upload_interrupted", errorParams: null });
    expect(byId["upl-1"].fileSize).toBe(9);
    expect(byId["upl-2"].upload?.errorCode).toBe("video_too_long");
    expect(byId["upl-2"].upload?.errorParams).toEqual({ max_minutes: 30 });
    expect(byId["upl-3"].upload?.errorCode).toBe("no_audio");
    expect(JSON.stringify(m.jobs)).not.toMatch(/phase|error"|outputs|socialCaption|captionPreset/);
    expect(m.exporting).toEqual(["ren1"]);
  });

  it("survives broken or missing lists", () => {
    expect(migrateLegacy(null, null, legacyCardCode)).toEqual({ jobs: [], exporting: [] });
    expect(migrateLegacy("{", "[1,2]", legacyCardCode)).toEqual({ jobs: [], exporting: [] });
  });
});

describe("emptyListAction", () => {
  it("leaves for the start screen only when the account's list loaded empty", () => {
    expect(emptyListAction({ ready: true, serverLoaded: true, count: 0 })).toBe("redirect");
    // A transient error (offline, 5xx): say so with a retry instead.
    expect(emptyListAction({ ready: true, serverLoaded: false, count: 0 })).toBe("retry");
    expect(emptyListAction({ ready: false, serverLoaded: false, count: 0 })).toBe("wait");
    expect(emptyListAction({ ready: true, serverLoaded: false, count: 2 })).toBe("show");
  });
});

describe("page helpers", () => {
  it("filters, searches and shortens names", () => {
    const p = mergeProjects([local("a", { filename: "Podcast Folge 12.mp4" })], new Map([["a", row({ id: "a", status: "awaiting_review" })]]), null, { now: NOW })[0];
    expect(matchesFilter(p, "edit")).toBe(true);
    expect(matchesFilter(p, "exported")).toBe(false);
    expect(matchesSearch(p, "folge")).toBe(true);
    expect(matchesSearch(p, "vlog")).toBe(false);
    expect(middleEllipsis("short.mp4")).toBe("short.mp4");
    const long = middleEllipsis("Mein_Video_Podcast_Folge_12_mit_einem_sehr_langen_Namen.mp4");
    expect(long).toHaveLength(34);
    expect(long.endsWith("Namen.mp4")).toBe(true);
    expect(long).toContain("…");
  });

  it("days left and the analysis estimate", () => {
    expect(daysLeft(null, NOW)).toBeNull();
    expect(daysLeft(NOW + 2.5 * 86_400_000, NOW)).toBe(3);
    expect(daysLeft(NOW - 1, NOW)).toBe(0);
    expect(analysisEta(null)).toBeNull();
    expect(analysisEta(5)).toBe(20);
    expect(analysisEta(60)).toBe(72);
  });
});
