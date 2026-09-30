/**
 * Unit tests of phrasesToUnits (UX2), framework-agnostic.
 *
 * Now (Node >= 22.18 strips the types of phraseUnits.ts itself):
 *   node --test web/src/features/editor/legacy/phraseUnits.test.mjs
 * Under Vitest (UX1) the same file registers its tests with Vitest.
 * Plain .mjs so `tsc` / `next build` don't type-check a test-runner import
 * before one is installed.
 *
 * The audit clip vectors (testdata/captions/audit_clip.json) are shared
 * with backend/tests/captions/test_caption_sync.py, which renders
 * `units_payload` — asserted here to be what the web sends for the
 * unedited transcript — and gets 86/86 words right and no duplicates.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { phrasesToUnits } from "./phraseUnits.ts";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const V = JSON.parse(
  readFileSync(
    new URL("../../../../../testdata/captions/audit_clip.json", import.meta.url),
    "utf8",
  ),
);
const clone = (x) => JSON.parse(JSON.stringify(x));
const idx = V.phrases.findIndex((p) => p.text.startsWith("Mistake number two"));
const unitsOf = (p) =>
  V.units_payload.filter(
    (u) =>
      u.original_start >= p.original_start - 1e-3 &&
      u.original_end <= p.original_end + 1e-3,
  );
/** The render units for sentence `idx` after editing its text. */
function edit(text) {
  const phrases = clone(V.phrases);
  phrases[idx].text = text;
  const all = phrasesToUnits(phrases, V.units);
  return all.filter(
    (u) =>
      u.original_start >= V.phrases[idx].original_start - 1e-3 &&
      u.original_end <= V.phrases[idx].original_end + 1e-3,
  );
}
const texts = (us) => us.map((u) => u.text);
const times = (us) => us.map((u) => [u.original_start, u.original_end]);

test("unchanged transcript: exactly the analysis units (audit clip)", () => {
  const got = phrasesToUnits(V.phrases, V.units);
  assert.deepEqual(got, V.units_payload);
  assert.equal(got.length, 63);
  for (const u of got) {
    assert.deepEqual(Object.keys(u).sort(), [
      "end", "original_end", "original_start", "start", "text",
    ]);
  }
});

test("deleted sentence sends nothing", () => {
  const phrases = clone(V.phrases);
  phrases[idx].text = "   ";
  const got = phrasesToUnits(phrases, V.units);
  const gone = unitsOf(V.phrases[idx]);
  assert.equal(got.length, V.units_payload.length - gone.length);
  assert.ok(!got.some((u) => gone.some((g) => g.original_start === u.original_start)));
});

test("a replaced word keeps the time of the word it replaces", () => {
  const got = edit("Mistake number 2, is dead air.");
  assert.deepEqual(texts(got), ["Mistake", "number", "2,", "is dead", "air."]);
  assert.deepEqual(times(got), times(unitsOf(V.phrases[idx])));
});

test("deleted words: the others keep their own times", () => {
  const got = edit("Mistake number two,");
  assert.deepEqual(texts(got), ["Mistake", "number", "two,"]);
  assert.deepEqual(times(got), times(unitsOf(V.phrases[idx]).slice(0, 3)));
  const tail = edit("is dead air.");
  assert.deepEqual(texts(tail), ["is dead", "air."]);
  assert.deepEqual(times(tail), times(unitsOf(V.phrases[idx]).slice(3)));
});

test("an added word joins the previous word's unit", () => {
  const got = edit("Mistake number two, really, is dead air.");
  assert.deepEqual(texts(got), ["Mistake", "number", "two, really,", "is dead", "air."]);
  assert.deepEqual(times(got), times(unitsOf(V.phrases[idx])));
  const first = edit("So: Mistake number two, is dead air.");
  assert.equal(first[0].text, "So: Mistake");
});

test("rewritten words split over the units between the kept ones by characters", () => {
  const got = edit("Mistake number two, means silence.");
  const u = unitsOf(V.phrases[idx]);
  assert.deepEqual(texts(got), ["Mistake", "number", "two,", "means", "silence."]);
  assert.deepEqual(times(got), times(u));
});

test("case and punctuation edits keep every time", () => {
  const got = edit("mistake Number two is dead air");
  assert.deepEqual(texts(got), ["mistake", "Number", "two", "is dead", "air"]);
  assert.deepEqual(times(got), times(unitsOf(V.phrases[idx])));
});

test("whitespace differences count as unchanged", () => {
  const got = edit("  Mistake  number two,   is dead air. ");
  assert.deepEqual(got, unitsOf(V.phrases[idx]));
});

test("a unit mapped into two clips is sent once", () => {
  // _map_subtitles_to_segments maps a unit spanning a cut into both clips:
  // same text and source times, different cut-timeline times.
  const units = [
    { start: 0.0, end: 0.4, text: "I want", original_start: 1.0, original_end: 1.6 },
    { start: 0.5, end: 0.6, text: "I want", original_start: 1.0, original_end: 1.6 },
    { start: 0.6, end: 0.9, text: "more.", original_start: 1.7, original_end: 2.0 },
  ];
  const phrases = [
    { start: 0.0, end: 0.9, original_start: 1.0, original_end: 2.0, text: "I want I want more." },
  ];
  const got = phrasesToUnits(phrases, units);
  assert.deepEqual(texts(got), ["I want", "more."]);
  assert.equal(got[0].start, 0.0);
  // …also when the user already removed the repeated words.
  phrases[0].text = "I want more.";
  assert.deepEqual(texts(phrasesToUnits(phrases, units)), ["I want", "more."]);
});

test("no units loaded: one subtitle per sentence, as before UX2", () => {
  const got = phrasesToUnits(V.phrases, []);
  assert.deepEqual(
    got,
    V.phrases.map((p) => ({
      start: p.start,
      end: p.end,
      text: p.text,
      original_start: p.original_start,
      original_end: p.original_end,
    })),
  );
});

test("output stays in transcript order", () => {
  const got = phrasesToUnits(V.phrases, V.units);
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i].original_start >= got[i - 1].original_start);
  }
});
