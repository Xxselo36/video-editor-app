"""Font subsets and metric tables for the caption engine (UT2 / UT3).

The caption engine (web/src/lib/captions/) measures text from metric
tables, never from the canvas: advances per codepoint and GPOS pair
kerning flattened to the shipped codepoints (fonts.json, one entry per
font, see web/src/lib/captions/metrics.ts FontJson). These helpers make
the tables and the subset files; scripts/build-caption-fonts.py uses them
for the shipped fonts and backend/font_subset.py for a job's CJK subset,
so both produce the same format.

Needs fontTools (and Brotli for woff2) — imported by the callers only.
"""
from __future__ import annotations

import hashlib
import io

from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont


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
    covered: set[str] = set()
    for lk in lookups:
        subs = []
        for st in pair_subtables(lk):
            cov = {g: i for i, g in enumerate(st.Coverage.glyphs)}
            covered.update(cov)
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
            if g1 not in covered:  # no subtable applies: no kerning
                continue
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

def subset_options(flavor: str | None) -> ft_subset.Options:
    """`flavor`: "woff2" for the browser, None for sfnt (.ttf: the render
    worker, and HarfBuzz shaping in the browser)."""
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
    opts.flavor = flavor
    return opts


def make_subset(ttf: bytes | TTFont, cps: list[int], flavor: str | None) -> bytes:
    """The subset of a font (TTF bytes, or a loaded TTFont — then it is
    changed in place) with the glyphs of `cps`."""
    font = ttf if isinstance(ttf, TTFont) else TTFont(io.BytesIO(ttf), recalcTimestamp=False)
    sub = ft_subset.Subsetter(subset_options(flavor))
    sub.populate(unicodes=cps)
    sub.subset(font)
    font.flavor = flavor
    buf = io.BytesIO()
    font.save(buf, reorderTables=True)
    return buf.getvalue()
