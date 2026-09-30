#!/usr/bin/env python3
"""Caption fonts for the v2 caption engine (UT2): web subsets + metric tables.

The caption engine (web/src/lib/captions/) lays text out from metric tables
instead of asking the canvas (ctx.measureText differs between Skia, CoreText
and FreeType), so line breaks and word positions are identical in Chrome,
Safari and on the render worker. This script produces those tables and the
web font files from the static TTFs in assets/caption-fonts/.

Outputs (committed; the --check mode keeps them honest in CI):
  web/public/fonts/captions/<font>.<subset>.woff2   latin (+ latin-ext) and
      cyrillic subsets; devanagari as .ttf, because the engine shapes
      Devanagari with HarfBuzz (web/src/lib/captions/shape-hb.ts), which
      needs sfnt bytes — the browser loads that one file for drawing and
      shaping.
  web/src/lib/captions/fonts.json   manifest (families, files, unicode
      ranges, hashes) + metric tables per font: unitsPerEm, ascender,
      descender, capHeight, xHeight, advances per codepoint of the shipped
      subsets and GPOS pair kerning flattened to those codepoints (stored
      as exact class tables: codepoints with identical kerning rows or
      columns share a class).

Modes:
  build-caption-fonts.py            write the outputs
  build-caption-fonts.py --check    rebuild in memory; exit 1 if a committed
                                    output differs, a TTF's hash differs from
                                    the manifest, or a size budget is broken
  build-caption-fonts.py --fetch    download the pinned upstream files
                                    (google/fonts @ GF_COMMIT), instantiate
                                    the variable fonts to static weights and
                                    write assets/caption-fonts/ (TTFs,
                                    LICENSES/, SOURCES.md). Needs network.

Budgets (review C17): the default style's font (Power: Montserrat Black,
latin subset) <= 60 KB; the latin subsets of all preset fonts <= 600 KB.

Requirements: scripts/requirements-caption-fonts.txt (pinned: the woff2
bytes depend on the fontTools and Brotli versions).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import ssl
import sys
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TTF_DIR = os.path.join(ROOT, "assets", "caption-fonts")
WEB_FONT_DIR = os.path.join(ROOT, "web", "public", "fonts", "captions")
FONTS_JSON = os.path.join(ROOT, "web", "src", "lib", "captions", "fonts.json")
WEB_FONT_URL = "/fonts/captions/"

# google/fonts is the upstream for every family; pinned so a rebuild is
# reproducible. METADATA.pb in each family folder names the designer repo.
GF_COMMIT = "23e54b51ddffbc7713c583748e3bd86f62b1fa4a"
GF_RAW = f"https://raw.githubusercontent.com/google/fonts/{GF_COMMIT}/"

KB = 1024
BUDGET_DEFAULT_FONT = 60 * KB  # Power's font, latin subset
BUDGET_LATIN_TILES = 600 * KB  # latin subsets of all preset fonts
DEFAULT_FONT = "montserrat-900"


@dataclass(frozen=True)
class Font:
    id: str  # engine font id (also the CSS family, prefixed "cc-")
    file: str  # static TTF in assets/caption-fonts/
    name: str  # human name
    weight: int
    italic: bool
    source: str  # path in google/fonts
    license: str  # licence path in google/fonts
    license_file: str  # name under assets/caption-fonts/LICENSES/
    spdx: str
    instance: dict = field(default_factory=dict)  # VF axis location, or {} if static upstream
    note: str = ""
    # (family, style) for instances the VF's STAT table cannot name
    names: tuple[str, str] | None = None


FONTS: list[Font] = [
    Font("montserrat-900", "Montserrat-Black.ttf", "Montserrat Black", 900, False,
         "ofl/montserrat/Montserrat[wght].ttf", "ofl/montserrat/OFL.txt", "Montserrat-OFL.txt", "OFL-1.1",
         {"wght": 900}),
    Font("montserrat-800", "Montserrat-ExtraBold.ttf", "Montserrat ExtraBold", 800, False,
         "ofl/montserrat/Montserrat[wght].ttf", "ofl/montserrat/OFL.txt", "Montserrat-OFL.txt", "OFL-1.1",
         {"wght": 800}),
    Font("luckiest-guy-400", "LuckiestGuy-Regular.ttf", "Luckiest Guy", 400, False,
         "apache/luckiestguy/LuckiestGuy-Regular.ttf", "apache/luckiestguy/LICENSE.txt",
         "LuckiestGuy-LICENSE.txt", "Apache-2.0"),
    Font("bangers-400", "Bangers-Regular.ttf", "Bangers", 400, False,
         "ofl/bangers/Bangers-Regular.ttf", "ofl/bangers/OFL.txt", "Bangers-OFL.txt", "OFL-1.1"),
    Font("poppins-800", "Poppins-ExtraBold.ttf", "Poppins ExtraBold", 800, False,
         "ofl/poppins/Poppins-ExtraBold.ttf", "ofl/poppins/OFL.txt", "Poppins-OFL.txt", "OFL-1.1"),
    Font("poppins-900", "Poppins-Black.ttf", "Poppins Black", 900, False,
         "ofl/poppins/Poppins-Black.ttf", "ofl/poppins/OFL.txt", "Poppins-OFL.txt", "OFL-1.1"),
    Font("inter-display-700", "InterDisplay-Bold.ttf", "Inter Display Bold", 700, False,
         "ofl/inter/Inter[opsz,wght].ttf", "ofl/inter/OFL.txt", "Inter-OFL.txt", "OFL-1.1",
         {"wght": 700, "opsz": 32},
         "Inter Bold at the display optical size (opsz 32, = upstream's Inter Display Bold): the size "
         "browsers pick automatically for text >= 32 px, and the look of the approved lab gallery. "
         "Named by the script (the VF's STAT table has no opsz=32 value).",
         ("Inter Display", "Bold")),
    Font("anton-400", "Anton-Regular.ttf", "Anton", 400, False,
         "ofl/anton/Anton-Regular.ttf", "ofl/anton/OFL.txt", "Anton-OFL.txt", "OFL-1.1"),
    Font("rubik-800", "Rubik-ExtraBold.ttf", "Rubik ExtraBold", 800, False,
         "ofl/rubik/Rubik[wght].ttf", "ofl/rubik/OFL.txt", "Rubik-OFL.txt", "OFL-1.1",
         {"wght": 800}),
    Font("playfair-display-800i", "PlayfairDisplay-ExtraBoldItalic.ttf", "Playfair Display ExtraBold Italic",
         800, True, "ofl/playfairdisplay/PlayfairDisplay-Italic[wght].ttf", "ofl/playfairdisplay/OFL.txt",
         "PlayfairDisplay-OFL.txt", "OFL-1.1", {"wght": 800}),
]

# CJK fallbacks are subset per job from the transcript's characters (UT3,
# backend/font_subset.py): a full Noto Sans CJK face is several MB. Declared
# here so the engine knows the family and can degrade gracefully until a
# job's subset (and its metrics, same format as a "fonts" entry) arrives.
DEFERRED = {
    "noto-sans-jp-800": {"name": "Noto Sans JP ExtraBold", "weight": 800, "lang": "ja",
                         "source": "ofl/notosansjp/NotoSansJP[wght].ttf"},
    "noto-sans-kr-800": {"name": "Noto Sans KR ExtraBold", "weight": 800, "lang": "ko",
                         "source": "ofl/notosanskr/NotoSansKR[wght].ttf"},
    "noto-sans-sc-800": {"name": "Noto Sans SC ExtraBold", "weight": 800, "lang": "zh",
                         "source": "ofl/notosanssc/NotoSansSC[wght].ttf"},
}


def parse_ranges(spec: str) -> list[tuple[int, int]]:
    out = []
    for part in spec.replace(" ", "").split(","):
        a, _, b = part.removeprefix("U+").partition("-")
        out.append((int(a, 16), int(b or a, 16)))
    return out


# Subsets per script: users download only the scripts their captions use.
#
# Every subset also carries the COMMON characters (space, digits,
# punctuation, currency) and is registered as its own font family
# ("cc-<font>-<subset>"). The engine draws word by word and lists the
# family of the word's script first, so "дела?" or "नमस्ते," is one font
# run in the browser (kerned/shaped with its punctuation), exactly like the
# full TTF on the render worker, and like the metric tables.
COMMON = ("U+0020-0040,U+005B-0060,U+007B-007E,U+00A0-00BF,U+00D7,U+00F7,U+2010-2027,U+202F-203A,U+2044,"
          # currency: KRW, VND, EUR, UAH, KZT, INR, TRY, RUB (USD, GBP, JPY are Latin-1)
          "U+20A9,U+20AB-20AC,U+20B4,U+20B8-20BA,U+20BD,U+2122,U+2190-2193,U+2212,U+2215")
SUBSETS: dict[str, list[tuple[int, int]]] = {
    # Latin letters: Basic Latin, Latin-1, Latin Extended-A (tr, pl, ...),
    # a few spacing modifiers. Enough for the 11 Latin-script UI languages.
    "latin": parse_ranges(COMMON + ",U+0041-005A,U+0061-007A,U+00C0-017F,U+0192,U+0218-021B,U+02BB-02BC,"
                          "U+02C6-02C7,U+02D8-02DD"),
    "cyrillic": parse_ranges(COMMON + ",U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"),
    # ZWJ/ZWNJ and the dotted circle take part in Devanagari shaping.
    "devanagari": parse_ranges(COMMON + ",U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20F0,U+25CC,U+A830-A839,"
                               "U+A8E0-A8FF"),
}

# A font gets a script's subset only if it has every one of these letters:
# a partial alphabet would put fallback glyphs in the middle of words.
REQUIRED = {
    "latin": "AaBbCcÄäÖöÜüßÉéÈèÊêÇçÑñÃãÕõÀàÌìÒòÙùĞğİıŞşĄąĆćĘęŁłŃńŚśŹźŻż",
    "cyrillic": "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "devanagari": "अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसहािीुूेैोौंँः्",
}


def in_ranges(cp: int, ranges: list[tuple[int, int]]) -> bool:
    return any(a <= cp <= b for a, b in ranges)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def range_string(cps: list[int]) -> str:
    """unicode-range descriptor for a sorted codepoint list."""
    parts, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        parts.append(f"U+{cps[i]:04X}" if i == j else f"U+{cps[i]:04X}-{cps[j]:04X}")
        i = j + 1
    return ",".join(parts)


def runs(values: dict[int, int]) -> list[list[int]]:
    """{cp: v} -> [[firstCp, v0, v1, ...], ...] over consecutive codepoints."""
    out: list[list[int]] = []
    for cp in sorted(values):
        if out and out[-1][0] + len(out[-1]) - 1 == cp:
            out[-1].append(values[cp])
        else:
            out.append([cp, values[cp]])
    return out


# ---------------------------------------------------------------- metrics

def kern_lookup_indices(font: TTFont) -> list[int]:
    if "GPOS" not in font or not font["GPOS"].table.FeatureList:
        return []
    idx: set[int] = set()
    for rec in font["GPOS"].table.FeatureList.FeatureRecord:
        if rec.FeatureTag == "kern":
            idx.update(rec.Feature.LookupListIndex)
    return sorted(idx)


def pair_subtables(lookup):
    for st in lookup.SubTable:
        if lookup.LookupType == 9:
            if st.ExtensionLookupType != 2:
                continue
            st = st.ExtSubTable
        elif lookup.LookupType != 2:
            continue
        yield st


def x_adv(value) -> int:
    return getattr(value, "XAdvance", 0) or 0 if value is not None else 0


def flatten_kerning(font: TTFont, cps_by_subset: dict[str, list[int]]) -> dict[tuple[int, int], int]:
    """GPOS 'kern' pair adjustments between codepoints of the same subset.

    Follows OpenType/HarfBuzz semantics: within one lookup the first
    subtable that applies wins (format 1 applies when the pair is listed,
    format 2 as soon as the first glyph is covered, even with a zero
    value); the lookups of the feature add up. Only XAdvance changes the
    width. Only pairs inside one subset are kept: a word is drawn with
    the subset family of its script first, so letters of two scripts
    are never in one font run (the browser splits them).
    """
    cmap = font.getBestCmap()
    lookups = [font["GPOS"].table.LookupList.Lookup[i] for i in kern_lookup_indices(font)]
    result: dict[tuple[int, int], int] = {}
    if not lookups:
        return result
    prepared = []
    for lk in lookups:
        subs = []
        for st in pair_subtables(lk):
            cov = {g: i for i, g in enumerate(st.Coverage.glyphs)}
            if st.Format == 1:
                sets = []
                for ps in st.PairSet:
                    sets.append({r.SecondGlyph: x_adv(r.Value1) + x_adv(getattr(r, "Value2", None))
                                 for r in ps.PairValueRecord})
                subs.append((1, cov, sets))
            else:
                c1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
                c2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
                matrix = [[x_adv(r.Value1) + x_adv(getattr(r, "Value2", None)) for r in rec.Class2Record]
                          for rec in st.Class1Record]
                subs.append((2, cov, (c1, c2, matrix)))
        prepared.append(subs)
    for cps in cps_by_subset.values():
        glyphs = [(cp, cmap[cp]) for cp in cps]
        for cp1, g1 in glyphs:
            for cp2, g2 in glyphs:
                total = 0
                for subs in prepared:
                    for fmt, cov, data in subs:
                        if g1 not in cov:
                            continue
                        if fmt == 1:
                            v = data[cov[g1]].get(g2)
                            if v is None:
                                continue
                            total += v
                            break
                        c1, c2, matrix = data
                        k1, k2 = c1.get(g1, 0), c2.get(g2, 0)
                        if k1 < len(matrix) and k2 < len(matrix[k1]):
                            total += matrix[k1][k2]
                        break
                if total:
                    result[(cp1, cp2)] = total
    return result


def kerning_classes(pairs: dict[tuple[int, int], int]) -> dict:
    """Exact class compression of a flattened pair table.

    Left codepoints with identical rows share a left class, right
    codepoints with identical columns share a right class. Class 0 is
    "no kerning"; values[(l - 1) * nRight + (r - 1)] for l, r >= 1.
    """
    if not pairs:
        return {"left": [], "right": [], "nRight": 0, "values": []}
    lefts = sorted({a for a, _ in pairs})
    rights = sorted({b for _, b in pairs})
    col_key = {b: tuple(pairs.get((a, b), 0) for a in lefts) for b in rights}
    right_class: dict[int, int] = {}
    col_ids: dict[tuple, int] = {}
    for b in rights:
        right_class[b] = col_ids.setdefault(col_key[b], len(col_ids) + 1)
    # rows over right classes (one representative per class)
    reps = {}
    for b in rights:
        reps.setdefault(right_class[b], b)
    row_key = {a: tuple(pairs.get((a, reps[c]), 0) for c in range(1, len(col_ids) + 1)) for a in lefts}
    left_class: dict[int, int] = {}
    row_ids: dict[tuple, int] = {}
    for a in lefts:
        left_class[a] = row_ids.setdefault(row_key[a], len(row_ids) + 1)
    values: list[int] = []
    for row in row_ids:  # insertion order == class order
        values.extend(row)
    return {"left": runs(left_class), "right": runs(right_class), "nRight": len(col_ids), "values": values}


def vertical_metrics(font: TTFont) -> dict:
    os2 = font["OS/2"]
    glyf = font["glyf"] if "glyf" in font else None
    cmap = font.getBestCmap()

    def glyph_top(ch: str) -> int:
        if glyf is None or ord(ch) not in cmap:
            return 0
        g = glyf[cmap[ord(ch)]]
        g.recalcBounds(glyf)
        return int(getattr(g, "yMax", 0) or 0)

    cap = getattr(os2, "sCapHeight", 0) or glyph_top("H")
    xh = getattr(os2, "sxHeight", 0) or glyph_top("x")
    return {
        "unitsPerEm": font["head"].unitsPerEm,
        "ascender": font["hhea"].ascent,
        "descender": font["hhea"].descent,
        "capHeight": cap,
        "xHeight": xh,
    }


# ---------------------------------------------------------------- subsets

def subset_options(script: str) -> ft_subset.Options:
    opts = ft_subset.Options()
    # Keep every layout feature: the browser draws with the subset, the
    # render worker with the full TTF, and both must shape identically.
    opts.layout_features = ["*"]
    opts.layout_scripts = ["*"]
    opts.hinting = False  # captions are large; saves ~30 %
    opts.desubroutinize = True
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    opts.name_languages = [0x409]
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.legacy_kern = False
    opts.drop_tables += ["DSIG", "STAT", "meta"]
    opts.flavor = None if script == "devanagari" else "woff2"
    return opts


def make_subset(ttf_bytes: bytes, cps: list[int], script: str) -> bytes:
    font = TTFont(io.BytesIO(ttf_bytes), recalcTimestamp=False)
    sub = ft_subset.Subsetter(subset_options(script))
    sub.populate(unicodes=cps)
    sub.subset(font)
    font.flavor = None if script == "devanagari" else "woff2"
    buf = io.BytesIO()
    font.save(buf, reorderTables=True)
    return buf.getvalue()


# ---------------------------------------------------------------- build

def build(ttf_dir: str = TTF_DIR) -> tuple[dict, dict[str, bytes]]:
    """Returns (fonts.json object, {web file name: bytes})."""
    manifest: dict = {
        "version": 1,
        "generator": "scripts/build-caption-fonts.py",
        "baseUrl": WEB_FONT_URL,
        "defaultFont": DEFAULT_FONT,
        "fonts": {},
        "deferred": {},
    }
    files: dict[str, bytes] = {}
    for f in FONTS:
        path = os.path.join(ttf_dir, f.file)
        with open(path, "rb") as fh:
            data = fh.read()
        font = TTFont(io.BytesIO(data))
        cmap = font.getBestCmap()
        cps_by_subset: dict[str, list[int]] = {}
        for script, ranges in SUBSETS.items():
            if not all(ord(c) in cmap for c in REQUIRED[script]):
                continue
            cps_by_subset[script] = sorted(cp for cp in cmap if in_ranges(cp, ranges))
        subsets = {}
        for script, cps in cps_by_subset.items():
            blob = make_subset(data, cps, script)
            ext = "ttf" if script == "devanagari" else "woff2"
            name = f"{f.id}.{script}.{ext}"
            files[name] = blob
            subsets[script] = {
                "family": f"cc-{f.id}-{script}",
                "file": name,
                "bytes": len(blob),
                "sha256": sha256(blob),
                "unicodeRange": range_string(cps),
            }
        hmtx = font["hmtx"]
        advances = {cp: hmtx[cmap[cp]][0] for cps in cps_by_subset.values() for cp in cps}
        kern = kerning_classes(flatten_kerning(font, cps_by_subset))
        entry = {
            "name": f.name,
            "weight": f.weight,
            "italic": f.italic,
            "ttf": f.file,
            "ttfBytes": len(data),
            "ttfSha256": sha256(data),
            "version": font["name"].getDebugName(5),
            "license": f.spdx,
            **vertical_metrics(font),
            "subsets": subsets,
            "advances": runs(advances),
            "kerning": kern,
        }
        manifest["fonts"][f.id] = entry
    for fid, d in DEFERRED.items():
        manifest["deferred"][fid] = {
            "name": d["name"],
            "family": f"cc-{fid}",
            "weight": d["weight"],
            "lang": d["lang"],
            "unitsPerEm": 1000,
            "source": d["source"],
            "note": "per-job subset (UT3); metrics arrive with the subset",
        }
    return manifest, files


def dump_json(obj, depth: int = 0) -> str:
    """Stable JSON: objects on separate lines down to depth 3, lists inline."""
    pad = "  " * depth
    if isinstance(obj, dict) and depth < 3 and obj:
        items = [f'{pad}  {json.dumps(k, ensure_ascii=False)}: {dump_json(v, depth + 1)}' for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def budgets(manifest: dict) -> list[str]:
    errors = []
    default = manifest["fonts"][DEFAULT_FONT]["subsets"]["latin"]["bytes"]
    if default > BUDGET_DEFAULT_FONT:
        errors.append(f"default style font {DEFAULT_FONT} latin = {default} B > {BUDGET_DEFAULT_FONT} B")
    latin = sum(e["subsets"]["latin"]["bytes"] for e in manifest["fonts"].values() if "latin" in e["subsets"])
    if latin > BUDGET_LATIN_TILES:
        errors.append(f"latin tile fonts = {latin} B > {BUDGET_LATIN_TILES} B")
    return errors


def report(manifest: dict) -> None:
    total_latin = 0
    for fid, e in manifest["fonts"].items():
        parts = []
        for script, s in e["subsets"].items():
            parts.append(f"{script} {s['bytes'] / KB:.1f} KB")
            if script == "latin":
                total_latin += s["bytes"]
        print(f"  {fid:24s} {', '.join(parts)}")
    d = manifest["fonts"][DEFAULT_FONT]["subsets"]["latin"]["bytes"]
    print(f"  default font ({DEFAULT_FONT}, latin): {d / KB:.1f} KB (budget {BUDGET_DEFAULT_FONT // KB} KB)")
    print(f"  all latin subsets: {total_latin / KB:.1f} KB (budget {BUDGET_LATIN_TILES // KB} KB)")


def write_outputs(manifest: dict, files: dict[str, bytes]) -> None:
    os.makedirs(WEB_FONT_DIR, exist_ok=True)
    for old in os.listdir(WEB_FONT_DIR):
        if old not in files:
            os.remove(os.path.join(WEB_FONT_DIR, old))
    for name, blob in files.items():
        with open(os.path.join(WEB_FONT_DIR, name), "wb") as fh:
            fh.write(blob)
    os.makedirs(os.path.dirname(FONTS_JSON), exist_ok=True)
    with open(FONTS_JSON, "w", encoding="utf-8") as fh:
        fh.write(dump_json(manifest) + "\n")


def check(manifest: dict, files: dict[str, bytes]) -> list[str]:
    errors = []
    expected_json = dump_json(manifest) + "\n"
    try:
        with open(FONTS_JSON, encoding="utf-8") as fh:
            committed = fh.read()
    except FileNotFoundError:
        committed = ""
    if committed != expected_json:
        errors.append(f"{os.path.relpath(FONTS_JSON, ROOT)} is stale (TTF, metrics or tool versions changed)")
    on_disk = set(os.listdir(WEB_FONT_DIR)) if os.path.isdir(WEB_FONT_DIR) else set()
    for name, blob in files.items():
        p = os.path.join(WEB_FONT_DIR, name)
        if name not in on_disk:
            errors.append(f"missing {os.path.relpath(p, ROOT)}")
            continue
        with open(p, "rb") as fh:
            if sha256(fh.read()) != sha256(blob):
                errors.append(f"{os.path.relpath(p, ROOT)} differs from a rebuild")
    for extra in sorted(on_disk - set(files)):
        errors.append(f"unexpected file web/public/fonts/captions/{extra}")
    return errors + budgets(manifest)


# ---------------------------------------------------------------- fetch

def _download(path: str, cache: str) -> bytes:
    dst = os.path.join(cache, GF_COMMIT, path)
    if os.path.exists(dst):
        with open(dst, "rb") as fh:
            return fh.read()
    url = GF_RAW + urllib.parse.quote(path)
    cafile = os.environ.get("SSL_CERT_FILE")
    ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    with urllib.request.urlopen(url, context=ctx, timeout=120) as r:
        data = r.read()
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as fh:
        fh.write(data)
    return data


def set_names(font: TTFont, family: str, style: str) -> None:
    """Name a static instance by hand (RIBBI family + style)."""
    name = font["name"]
    version = name.getDebugName(5) or ""
    ps = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    for nid in (16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    records = {1: family, 2: style, 3: f"{version.split(';')[0].replace('Version ', '')};{ps}",
               4: f"{family} {style}", 6: ps}
    for nid, text in records.items():
        name.setName(text, nid, 3, 1, 0x409)
        name.removeNames(nameID=nid, platformID=1)
    bold = style.lower().startswith("bold")
    italic = "italic" in style.lower()
    os2 = font["OS/2"]
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if bold else 0) | (1 if italic else 0)
    if not (bold or italic):
        os2.fsSelection |= 0b1000000
    font["head"].macStyle = (1 if bold else 0) | (2 if italic else 0)


def fetch(cache: str) -> None:
    import fontTools
    from fontTools.varLib import instancer

    os.makedirs(os.path.join(TTF_DIR, "LICENSES"), exist_ok=True)
    rows = []
    for f in FONTS:
        src = _download(f.source, cache)
        lic = _download(f.license, cache)
        font = TTFont(io.BytesIO(src), recalcTimestamp=False)
        if f.instance:
            font = instancer.instantiateVariableFont(font, dict(f.instance), updateFontNames=f.names is None)
            if f.names:
                set_names(font, *f.names)
        buf = io.BytesIO()
        font.save(buf)
        out = buf.getvalue() if f.instance else src  # static upstream files are copied byte for byte
        with open(os.path.join(TTF_DIR, f.file), "wb") as fh:
            fh.write(out)
        with open(os.path.join(TTF_DIR, "LICENSES", f.license_file), "wb") as fh:
            fh.write(lic)
        version = TTFont(io.BytesIO(out))["name"].getDebugName(5)
        how = ("instance " + ", ".join(f"{k}={v}" for k, v in f.instance.items())) if f.instance else "copied as is"
        rows.append((f, sha256(src), sha256(out), version, how))
    lines = [
        "# Caption fonts: sources",
        "",
        "Generated by `scripts/build-caption-fonts.py --fetch`; do not edit by hand.",
        "",
        f"- Upstream: [google/fonts](https://github.com/google/fonts) at commit `{GF_COMMIT}`",
        "  (files under `https://raw.githubusercontent.com/google/fonts/<commit>/<path>`).",
        "- Variable fonts are instantiated to the static weight with fontTools "
        f"{fontTools.version} (`varLib.instancer`, `updateFontNames=True`); static upstream files are copied "
        "byte for byte.",
        "- The web subsets in `web/public/fonts/captions/` and the metric tables in "
        "`web/src/lib/captions/fonts.json` are generated from these TTFs by the same script.",
        "- Each family's upstream project and commit are in `METADATA.pb` next to the source file at that commit.",
        "- CJK fallbacks (Noto Sans JP/KR/SC ExtraBold) are not stored here: they are subset per job (UT3).",
        "",
        "| File | Font | Version | Licence | google/fonts source | How | sha256 (source) | sha256 (file) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for f, src_sha, out_sha, version, how in rows:
        lines.append(
            f"| `{f.file}` | {f.name} | {version} | {f.spdx} (`LICENSES/{f.license_file}`) | `{f.source}` | {how} | "
            f"`{src_sha[:16]}…` | `{out_sha[:16]}…` |")
    notes = [f for f in FONTS if f.note]
    if notes:
        lines += ["", "Notes:", ""]
        lines += [f"- `{f.file}`: {f.note}" for f in notes]
    with open(os.path.join(TTF_DIR, "SOURCES.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"fetched {len(FONTS)} fonts into {os.path.relpath(TTF_DIR, ROOT)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="verify committed outputs and budgets (CI)")
    ap.add_argument("--fetch", action="store_true", help="download + instantiate the TTFs (network)")
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "cleocuts-caption-fonts"),
                    help="download cache for --fetch")
    args = ap.parse_args()
    if args.fetch:
        fetch(args.cache)
    manifest, files = build()
    if args.check:
        errors = check(manifest, files)
        report(manifest)
        if errors:
            print("caption fonts check FAILED:\n  " + "\n  ".join(errors), file=sys.stderr)
            return 1
        print("caption fonts check ok")
        return 0
    errors = budgets(manifest)
    write_outputs(manifest, files)
    report(manifest)
    if errors:
        print("budget exceeded:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
