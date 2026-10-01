"""Per-job CJK caption font subsets (UT3, review C5).

A full Noto Sans JP/KR/SC face is 6–11 MB; a job only needs the
characters its transcript uses. For ja / ko / zh / yue transcripts the
analysis subsets the static 800 instance in assets/caption-fonts/cjk/
(fontTools, the pyftsubset engine) to those characters plus punctuation,
digits and basic Latin, and stores three files under jobs/{id}/fonts/:

    {font}.{rev}.woff2   the browser's face
    {font}.{rev}.ttf     the render worker's (UT4): the same glyphs, so
                         outlines and metrics match the preview
    {font}.{rev}.json    metrics in the fonts.json entry format, for the
                         web's registerCaptionFont(font, json, baseUrl) —
                         subsets.job.file names the woff2 relative to
                         GET /jobs/{id}/fonts/

`rev` is the first 8 hex digits of the woff2's sha256 (the CSS family is
cc-{font}-{rev}, so a refreshed subset never collides with a loaded one).
job.font_subsets = {font: {family, rev, chars, json, woff2, ttf (keys)}}.
POST /jobs/{id}/fonts/refresh re-subsets when an edit adds characters.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Any, Iterable

from backend import doc as edit_doc

FONT_DIR = Path(__file__).resolve().parents[1] / "assets" / "caption-fonts" / "cjk"
FONT_FILES = {
    "noto-sans-jp-800": ("NotoSansJP-ExtraBold.ttf", "Noto Sans JP ExtraBold"),
    "noto-sans-kr-800": ("NotoSansKR-ExtraBold.ttf", "Noto Sans KR ExtraBold"),
    "noto-sans-sc-800": ("NotoSansSC-ExtraBold.ttf", "Noto Sans SC ExtraBold"),
}
# Always in the subset, besides the transcript's own characters: basic
# Latin (digits, punctuation, letters) and the CJK marks an edit is most
# likely to add (、。「」『』・ー). Anything else an edit adds comes with
# POST /jobs/{id}/fonts/refresh.
BASE_RANGES = [(0x20, 0x7E), (0x3001, 0x3002), (0x300C, 0x300F),
               (0x30FB, 0x30FC)]
CONTENT_TYPES = {"woff2": "font/woff2", "ttf": "font/ttf", "json": "application/json"}


def font_for(language: str | None) -> str | None:
    """The CJK fallback font of a transcript language, or None."""
    if edit_doc.script_of_lang(language) != "cjk":
        return None
    return edit_doc.support()["cjk"].get(edit_doc.norm_lang(language))


def text_of(words: Iterable[dict]) -> str:
    return "".join(str(w.get("text") or "") for w in words or ())


def chars_needed(text: str) -> str:
    """The characters of `text` outside the base ranges, sorted, once."""
    cps = {ord(c) for c in text if not c.isspace()}
    return "".join(chr(c) for c in sorted(cps)
                   if not any(a <= c <= b for a, b in BASE_RANGES))


def covers(entry: dict | None, text: str) -> bool:
    """Does a stored subset (job.font_subsets[font]) hold every character
    of `text`? (Characters the font itself lacks count as held.)"""
    if not entry:
        return False
    have = set(entry.get("chars") or "") | set(entry.get("missing") or "")
    return set(chars_needed(text)) <= have


def make(font_id: str, text: str, out_dir: str | Path) -> dict[str, Any]:
    """Subset `font_id` to the characters of `text` into `out_dir`.
    Returns {font, family, rev, chars, missing, files: {woff2, ttf, json:
    path}}."""
    from fontTools.ttLib import TTFont

    from backend import font_metrics as fm

    file, name = FONT_FILES[font_id]
    full = TTFont(str(FONT_DIR / file), lazy=True)
    cmap = full.getBestCmap()
    wanted = chars_needed(text)
    have = "".join(c for c in wanted if ord(c) in cmap)
    missing = "".join(c for c in wanted if ord(c) not in cmap)
    cps = sorted({cp for a, b in BASE_RANGES for cp in range(a, b + 1) if cp in cmap}
                 | {ord(c) for c in have})
    vmetrics = fm.vertical_metrics(full)
    version = full["name"].getDebugName(5)
    full.close()
    ttf = fm.make_subset((FONT_DIR / file).read_bytes(), cps, None)
    font = TTFont(io.BytesIO(ttf))
    woff2 = io.BytesIO()
    font.flavor = "woff2"
    font.save(woff2)
    woff2_bytes = woff2.getvalue()
    font = TTFont(io.BytesIO(ttf))
    sub_cmap = font.getBestCmap()
    cps = [cp for cp in cps if cp in sub_cmap]
    hmtx = font["hmtx"]
    rev = fm.sha256(woff2_bytes)[:8]
    base = f"{font_id}.{rev}"
    metrics = {
        "name": name,
        "weight": 800,
        "italic": False,
        "ttf": f"{base}.ttf",
        "ttfBytes": len(ttf),
        "ttfSha256": fm.sha256(ttf),
        "version": version,
        "license": "OFL-1.1",
        **vmetrics,
        "subsets": {"job": {
            "family": f"cc-{font_id}-{rev}",
            "file": f"{base}.woff2",
            "bytes": len(woff2_bytes),
            "sha256": fm.sha256(woff2_bytes),
            "unicodeRange": fm.range_string(cps),
        }},
        "advances": fm.runs({cp: hmtx[sub_cmap[cp]][0] for cp in cps}),
        "kerning": fm.kerning_classes(fm.flatten_kerning(font, {"job": cps})),
    }
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    files = {"woff2": out / f"{base}.woff2", "ttf": out / f"{base}.ttf",
             "json": out / f"{base}.json"}
    files["woff2"].write_bytes(woff2_bytes)
    files["ttf"].write_bytes(ttf)
    files["json"].write_text(json.dumps(metrics, ensure_ascii=False, separators=(",", ":")),
                             encoding="utf-8")
    return {"font": font_id, "family": metrics["subsets"]["job"]["family"], "rev": rev,
            "chars": have, "missing": missing,
            "files": {k: str(v) for k, v in files.items()}}


def for_doc(doc: dict | None, out_dir: str | Path) -> dict[str, dict[str, Any]]:
    """The subsets a doc needs ({} for a non-CJK transcript). Never
    raises: a failed subset only means the browser's own CJK font until a
    refresh (logged)."""
    if not doc:
        return {}
    font_id = font_for(doc.get("language"))
    if not font_id:
        return {}
    try:
        return {font_id: make(font_id, text_of(doc.get("words")), out_dir)}
    except Exception as e:
        print(f"[fonts] {font_id} subset failed: {type(e).__name__}: {e}", flush=True)
        return {}


def store(made: dict[str, dict[str, Any]], prefix: str, put) -> tuple[dict, dict]:
    """Upload made subsets with put(path, key, content_type) -> size.
    Returns (job.font_subsets, {key: size})."""
    subsets: dict[str, dict] = {}
    sizes: dict[str, int] = {}
    for font_id, m in made.items():
        entry = {"family": m["family"], "rev": m["rev"], "chars": m["chars"],
                 "missing": m["missing"]}
        for kind, path in m["files"].items():
            key = f"{prefix}fonts/{os.path.basename(path)}"
            sizes[key] = put(path, key, CONTENT_TYPES[kind])
            entry[kind] = key
        subsets[font_id] = entry
    return subsets, sizes


def public(font_subsets: dict | None) -> dict[str, dict[str, str]]:
    """What the client sees (no keys): {font: {family, rev, json}} — json
    is the metrics file's name under GET /jobs/{id}/fonts/."""
    out = {}
    for font_id, e in (font_subsets or {}).items():
        if isinstance(e, dict) and e.get("json"):
            out[font_id] = {"family": e.get("family"), "rev": e.get("rev"),
                            "json": os.path.basename(e["json"])}
    return out


def key_of(font_subsets: dict | None, name: str) -> tuple[str, str] | None:
    """(key, content type) of a subset file by its name, or None."""
    for e in (font_subsets or {}).values():
        for kind in ("woff2", "ttf", "json"):
            key = (e or {}).get(kind)
            if key and os.path.basename(key) == name:
                return key, CONTENT_TYPES[kind]
    return None


def refresh(job_store: Any, job_id: str, job: Any, text: str,
            workspace: str | Path) -> dict[str, dict]:
    """Re-subset the job's CJK font to the characters of `text` when the
    stored subset doesn't hold them all, store the files next to the
    job's media and record them (job.font_subsets, media_bytes); the
    replaced files are queued for deletion. Returns the job's
    font_subsets. Raises when the subset can't be made or stored. Used by
    POST /jobs/{id}/fonts/refresh and before a v2 render (UT4)."""
    import shutil
    import time

    from backend import media

    font_id = font_for((job.doc or {}).get("language") or job.language)
    current = dict(job.font_subsets or {})
    if not font_id or covers(current.get(font_id), text):
        return current
    where = media.store_of(job)
    ws = Path(workspace)
    try:
        made = make(font_id, text, ws)
        subsets, sizes = store(
            {font_id: made}, media.job_prefix(job_id),
            lambda path, key, ctype: media.put_file(path, key, content_type=ctype,
                                                    store=where))
    finally:
        shutil.rmtree(ws, ignore_errors=True)
    old = current.get(font_id) or {}
    stale = [old.get(k) for k in ("woff2", "ttf", "json")
             if old.get(k) and old.get(k) != subsets[font_id].get(k)]

    def change(cur: Any) -> dict:
        return {"font_subsets": {**(cur.font_subsets or {}), **subsets},
                "media_bytes": {**{k: v for k, v in (cur.media_bytes or {}).items()
                                   if k not in stale}, **sizes}}
    job_store.modify(job_id, change)
    if stale:
        try:
            job_store.gc_add(stale, time.time(), store=where)
        except Exception as e:  # best effort, like main._gc_later
            print(f"[fonts] could not queue {stale} for deletion: {e}", flush=True)
    cur = job_store.get(job_id)
    return dict(cur.font_subsets if cur else {**current, **subsets})
