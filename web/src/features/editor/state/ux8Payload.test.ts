/**
 * The render payload the v2 editor sends (UX8: captionSource →
 * phrasesToUnits) for testdata/captions/ux8_doc.json, kept as
 * testdata/captions/ux8_payload.json: backend/tests/test_captions_v2.py
 * maps it back onto the doc's words for the v2 render (UT4).
 * UPDATE_VECTORS=1 rewrites the file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { phrasesToUnits } from "../legacy/phraseUnits";
import { captionSource, type DocWord } from "./doc";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../testdata/captions");

it("the UX8 render payload vectors are current", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, "ux8_doc.json"), "utf8")) as { words: DocWord[] };
  const src = captionSource(doc.words);
  const payload = { phrases: src.phrases, subtitles: phrasesToUnits(src.phrases, src.units) };
  const file = path.join(DIR, "ux8_payload.json");
  if (process.env.UPDATE_VECTORS) fs.writeFileSync(file, JSON.stringify(payload, null, 1) + "\n");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(payload)));
});
