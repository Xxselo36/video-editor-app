"""Per-job CJK font subsets (UT3, review C5): every transcript character
is covered, the web face stays small, and the metrics file has the
fonts.json entry format the web's registerCaptionFont reads."""
from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pytest

pytest.importorskip("fontTools")
pytest.importorskip("brotli")
from fontTools.ttLib import TTFont  # noqa: E402

from backend import font_subset as fs  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def _ja_transcript() -> str:
    """~10 minutes of Japanese: the app's own Japanese UI copy (natural
    text, ~5 000 characters, ~420 distinct ones — a monologue of that
    length uses about as many)."""
    text = (REPO / "web/src/i18n/messages/ja.ts").read_text(encoding="utf-8")
    return "".join(re.findall(r"[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef\u3002\u3001]", text))


def test_font_for_language():
    assert fs.font_for("ja") == "noto-sans-jp-800"
    assert fs.font_for("ko") == "noto-sans-kr-800"
    assert fs.font_for("zh") == "noto-sans-sc-800"
    assert fs.font_for("yue") == "noto-sans-sc-800"
    assert fs.font_for("de") is None and fs.font_for(None) is None


def test_ten_minute_ja_subset(tmp_path):
    text = _ja_transcript()
    assert len(text) > 3000
    m = fs.make("noto-sans-jp-800", text + " 123 OK?", tmp_path)
    woff2 = Path(m["files"]["woff2"])
    assert woff2.stat().st_size < 200 * 1024
    for kind in ("woff2", "ttf"):
        cmap = TTFont(m["files"][kind]).getBestCmap()
        assert not [c for c in set(text + "123OK?") if ord(c) not in cmap], kind
    assert m["missing"] == ""
    assert fs.covers(m, text) and not fs.covers(m, text + "鬱")
    metrics = json.loads(Path(m["files"]["json"]).read_text(encoding="utf-8"))
    assert {"name", "weight", "italic", "unitsPerEm", "ascender", "descender", "capHeight",
            "xHeight", "subsets", "advances", "kerning"} <= set(metrics)
    job = metrics["subsets"]["job"]
    assert job["family"] == m["family"] == f"cc-noto-sans-jp-800-{m['rev']}"
    assert job["file"] == woff2.name and job["bytes"] == woff2.stat().st_size
    assert metrics["unitsPerEm"] == 1000 and metrics["weight"] == 800
    adv = {r[0] + i: v for r in metrics["advances"] for i, v in enumerate(r[1:])}
    assert all(ord(c) in adv for c in set(text))
    assert adv[ord("あ")] == 1000        # a full-width kana
    assert set(metrics["kerning"]) == {"left", "right", "nRight", "values"}


def test_subset_matches_the_full_font_metrics(tmp_path):
    m = fs.make("noto-sans-kr-800", "안녕하세요, 여러분!", tmp_path)
    full = TTFont(fs.FONT_DIR / "NotoSansKR-ExtraBold.ttf", lazy=True)
    sub = TTFont(io.BytesIO(Path(m["files"]["ttf"]).read_bytes()))
    for ch in "안녕하세요":
        g_full, g_sub = full.getBestCmap()[ord(ch)], sub.getBestCmap()[ord(ch)]
        assert full["hmtx"][g_full] == sub["hmtx"][g_sub]


def test_store_and_public(tmp_path):
    made = {"noto-sans-sc-800": fs.make("noto-sans-sc-800", "你好世界", tmp_path)}
    puts = []
    subsets, sizes = fs.store(made, "jobs/abc/", lambda p, k, ct: puts.append((k, ct)) or 7)
    e = subsets["noto-sans-sc-800"]
    assert e["woff2"].startswith("jobs/abc/fonts/noto-sans-sc-800.") and e["chars"] == "世你好界"
    assert sorted(ct for _k, ct in puts) == ["application/json", "font/ttf", "font/woff2"]
    assert set(sizes.values()) == {7}
    pub = fs.public(subsets)
    assert pub == {"noto-sans-sc-800": {"family": e["family"], "rev": e["rev"],
                                        "json": Path(e["json"]).name}}
    assert fs.key_of(subsets, Path(e["ttf"]).name) == (e["ttf"], "font/ttf")
    assert fs.key_of(subsets, "other.woff2") is None


def test_for_doc(tmp_path):
    assert fs.for_doc({"language": "en", "words": [{"text": "hi"}]}, tmp_path) == {}
    out = fs.for_doc({"language": "ja", "words": [{"text": "今日"}, {"text": "は"}]}, tmp_path)
    assert list(out) == ["noto-sans-jp-800"]
