#!/usr/bin/env python3
"""Caption font coverage (UT2, CI): no missing glyphs, honest support table.

1. For every preset × the 14 UI languages where the preset is offered
   (script-support.json: native or fallback), the language's sample line
   (web/src/lib/captions/samples.json, cased like the preset draws it)
   renders with 0 .notdef: every character resolves to a face of the
   preset's chain (same order as web/src/lib/captions/fonts.ts faceChain)
   whose shipped subset file really has the glyph, and Devanagari runs
   shaped by HarfBuzz produce no glyph 0.
2. The support table matches the fonts' real coverage: "native" iff the
   preset's own font covers the script's alphabet, "fallback" iff only the
   configured same-weight fallback does, "unavailable" otherwise.
   CJK rows are "deferred": those fonts are subset per job (UT3).

Exit 1 on any failure. Requirements: scripts/requirements-caption-fonts.txt.
"""
from __future__ import annotations

import io
import json
import os
import sys
import unicodedata

from fontTools.ttLib import TTFont

try:
    import uharfbuzz as hb
except ImportError:  # shaping check is skipped, cmap check still runs
    hb = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "web", "src", "lib", "captions")
WEB_FONTS = os.path.join(ROOT, "web", "public", "fonts", "captions")
UI_LANGS = ["en", "de", "es", "fr", "pt", "it", "tr", "pl", "nl", "ru", "ja", "ko", "id", "hi"]
SCRIPTS = ["latin", "cyrillic", "devanagari"]
ALPHABET = {
    "latin": "AaBbCcÄäÖöÜüßÉéÈèÊêÇçÑñÃãÕõÀàÌìÒòÙùĞğİıŞşĄąĆćĘęŁłŃńŚśŹźŻż",
    "cyrillic": "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "devanagari": "अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसहािीुूेैोौंँः्",
}


def load(name: str) -> dict:
    with open(os.path.join(LIB, name), encoding="utf-8") as fh:
        return json.load(fh)


FONTS = load("fonts.json")
SUPPORT = load("script-support.json")
SAMPLES = load("samples.json")["samples"]
PRESET_CASE = {}  # filled from presets.ts below


def preset_cases() -> dict[str, str]:
    """font.case per preset, read from presets.ts (no TS runtime needed)."""
    src = open(os.path.join(LIB, "presets.ts"), encoding="utf-8").read()
    out = {}
    for pid in SUPPORT["presets"]:
        i = src.find(f"\n  {pid}: {{")
        j = src.find('case: "', i)
        out[pid] = src[j + 7:src.find('"', j + 7)]
    return out


def parse_range(spec: str) -> set[int]:
    cps = set()
    for part in spec.split(","):
        a, _, b = part.removeprefix("U+").partition("-")
        cps.update(range(int(a, 16), int(b or a, 16) + 1))
    return cps


class Face:
    def __init__(self, font_id: str, subset: str, entry: dict):
        self.key = f"{font_id}:{subset}"
        self.font_id, self.subset = font_id, subset
        self.cps = parse_range(entry["unicodeRange"])
        path = os.path.join(WEB_FONTS, entry["file"])
        font = TTFont(path)
        self.cmap = font.getBestCmap()
        font.flavor = None
        buf = io.BytesIO()
        font.save(buf)
        self.sfnt = buf.getvalue()
        self._hb = None

    def shape_notdef(self, text: str) -> int:
        if hb is None:
            return 0
        if self._hb is None:
            self._hb = hb.Font(hb.Face(hb.Blob(self.sfnt)))
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self._hb, buf, {})
        return sum(1 for g in buf.glyph_infos if g.codepoint == 0)


FACES: dict[str, Face] = {}


def face(font_id: str | None, subset: str) -> Face | None:
    if not font_id or font_id not in FONTS["fonts"]:
        return None
    entry = FONTS["fonts"][font_id]["subsets"].get(subset)
    if not entry:
        return None
    key = f"{font_id}:{subset}"
    if key not in FACES:
        FACES[key] = Face(font_id, subset, entry)
    return FACES[key]


def script_of(ch: str) -> str | None:
    cp = ord(ch)
    if ("A" <= ch <= "Z") or ("a" <= ch <= "z") or (0xC0 <= cp <= 0x24F and cp not in (0xD7, 0xF7)):
        return "latin"
    if 0x400 <= cp <= 0x52F:
        return "cyrillic"
    if 0x900 <= cp <= 0x97F or 0xA8E0 <= cp <= 0xA8FF or 0x1CD0 <= cp <= 0x1CFF:
        return "devanagari"
    return None


def chain(font_id: str, script: str) -> list[Face]:
    """Mirror of fonts.ts faceChain for the shipped scripts."""
    out: list[Face] = []

    def push(f):
        if f and f not in out:
            out.append(f)

    def for_script(s):
        return (face(font_id, s) or face(SUPPORT["fallbacks"].get(font_id, {}).get(s), s)
                or face(SUPPORT["lastResort"][s], s))

    push(for_script(script))
    for s in SCRIPTS:
        push(face(font_id, s))
    for s in SCRIPTS:
        push(for_script(s))
    return out


def upper(text: str, lang: str) -> str:
    if lang in ("tr", "az"):
        text = text.replace("i", "İ").replace("ı", "I")
    return text.upper()


def lang_script(lang: str) -> str:
    return SUPPORT["languages"].get(lang, "latin")


def check_sample(preset: str, lang: str, case: str) -> list[str]:
    font_id = SUPPORT["presets"][preset]["font"]
    text = unicodedata.normalize("NFC", SAMPLES[lang])
    if case == "upper":
        text = upper(text, lang)
    problems = []
    for word in text.split():
        counts: dict[str, int] = {}
        for ch in word:
            s = script_of(ch)
            if s:
                counts[s] = counts.get(s, 0) + 1
        ws = max(counts, key=lambda s: (counts[s], s == lang_script(lang))) if counts else lang_script(lang)
        faces = chain(font_id, ws if ws in SCRIPTS else "latin")
        runs: list[tuple[Face, str]] = []
        for ch in word:
            cp = ord(ch)
            f = next((f for f in faces if cp in f.cps), None)
            if f is None or cp not in f.cmap:
                problems.append(f"{preset}/{lang}: no glyph for {ch!r} (U+{cp:04X}) in {word!r}")
                continue
            if runs and runs[-1][0] is f:
                runs[-1] = (f, runs[-1][1] + ch)
            else:
                runs.append((f, ch))
        for f, run in runs:
            if f.subset == "devanagari" and f.shape_notdef(run):
                problems.append(f"{preset}/{lang}: HarfBuzz .notdef shaping {run!r} with {f.key}")
    return problems


def real_level(preset: str, script: str) -> str:
    font_id = SUPPORT["presets"][preset]["font"]

    def covers(fid):
        f = face(fid, script)
        return f is not None and all(ord(c) in f.cmap for c in ALPHABET[script])

    if covers(font_id):
        return "native"
    fb = SUPPORT["fallbacks"].get(font_id, {}).get(script)
    if fb and covers(fb):
        return "fallback"
    return "unavailable"


def main() -> int:
    cases = preset_cases()
    errors: list[str] = []
    checked = deferred = skipped = 0
    for preset, row in SUPPORT["presets"].items():
        for script in SCRIPTS:
            real = real_level(preset, script)
            if row[script] != real:
                errors.append(f"table: {preset}/{script} says {row[script]}, fonts say {real}")
        for lang in UI_LANGS:
            script = lang_script(lang)
            level = row[script]
            if script == "cjk":
                deferred += level != "unavailable"
                skipped += level == "unavailable"
                continue
            if level == "unavailable":
                skipped += 1
                continue
            errors += check_sample(preset, lang, cases[preset])
            checked += 1
    print(f"font coverage: {checked} preset×language samples checked, {skipped} unavailable by design, "
          f"{deferred} CJK deferred (per-job subsets, UT3){'' if hb else ' (uharfbuzz missing: no shaping check)'}")
    if errors:
        print("FAILED:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1
    print("0 .notdef; the support table matches the fonts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
