"""Caption styles in /me/prefs (backend/prefs.py): the v2 Style tab's
"Save as default" (caption_style_default: stored, merged with the other
keys, validated (no per-caption overrides), size-limited) and the start
screen's "Last used" (caption_style_last: a preset id or "none")."""
from __future__ import annotations

import pytest

from backend import prefs


def test_prefs_caption_style_default(client, auth_on, bearer):
    h = bearer("user_style")
    r = client.put("/me/prefs", headers=h, json={"style": "tight", "caption_style_default": {
        "presetId": "karaoke", "overrides": {"sizeScale": 1.2, "highlightColor": "#FFE600"}}})
    assert r.status_code == 200, r.text
    assert r.json()["caption_style_default"] == {
        "presetId": "karaoke", "overrides": {"sizeScale": 1.2, "highlightColor": "#FFE600"}}
    assert client.get("/me/prefs", headers=h).json()["caption_style_default"]["presetId"] == "karaoke"
    # other keys stay when the upload defaults are saved again
    r = client.put("/me/prefs", headers=h, json={"style": "smooth"})
    assert r.json()["caption_style_default"]["presetId"] == "karaoke"
    # a v1 alias is stored as its v2 style; null removes it
    r = client.put("/me/prefs", headers=h, json={"caption_style_default": {"presetId": "clean"}})
    assert r.json()["caption_style_default"] == {"presetId": "minimal", "overrides": {}}
    r = client.put("/me/prefs", headers=h, json={"caption_style_default": None})
    assert "caption_style_default" not in r.json()
    assert r.json()["style"] == "smooth"


@pytest.mark.parametrize("value", [
    "power",                                                  # not an object
    {"presetId": "bogus"},
    {"presetId": "power", "overrides": {"sizeScale": 9}},
    {"presetId": "power", "overrides": {"captions": {"w0001": {"y": 0.3}}}},  # one video's
    {"presetId": "power", "overrides": [1]},
    {"presetId": "power", "extra": 1},
])
def test_prefs_caption_style_default_refused(client, auth_on, bearer, value):
    h = bearer("user_style_bad")
    r = client.put("/me/prefs", headers=h, json={"caption_style_default": value})
    assert r.status_code == 400
    assert r.json()["detail"]["field"] == "caption_style_default"
    assert client.get("/me/prefs", headers=h).json() == {}


def test_prefs_caption_style_default_size_limit(monkeypatch):
    monkeypatch.setattr(prefs, "CAPTION_STYLE_MAX_BYTES", 40)
    with pytest.raises(prefs.BadPrefs):
        prefs.merge(None, {"caption_style_default": {
            "presetId": "power", "overrides": {"textColor": "#FFFFFF", "highlightColor": "#FFE600"}}})
    assert prefs.merge(None, {"caption_style_default": {"presetId": "power"}}) == {
        "caption_style_default": {"presetId": "power", "overrides": {}}}


def test_stale_value_is_dropped_on_read():
    import json
    raw = json.dumps({"style": "tight", "caption_style_default": {"presetId": "gone"}})
    assert prefs._parse(raw) == {"style": "tight"}


def test_caption_style_last_roundtrip(client, auth_on, bearer):
    h = bearer("user_last")
    r = client.put("/me/prefs", headers=h, json={
        "target_aspect": "original", "caption_style_last": " Karaoke "})
    assert r.status_code == 200, r.text
    want = {"target_aspect": "original", "caption_style_last": "karaoke"}
    assert r.json() == want
    assert client.get("/me/prefs", headers=h).json() == want
    # "No captions" is remembered too; null removes it.
    r = client.put("/me/prefs", headers=h, json={"caption_style_last": "none"})
    assert r.json() == {**want, "caption_style_last": "none"}
    r = client.put("/me/prefs", headers=h, json={"caption_style_last": None})
    assert r.json() == {"target_aspect": "original"}


@pytest.mark.parametrize("value", [
    "bogus", "", 7, True, {"presetId": "power"},
    "clean",                     # a v1 alias: only v2 presets are offered
])
def test_caption_style_last_refused_when_unknown(client, auth_on, bearer,
                                                 value):
    h = bearer("user_last_bad")
    r = client.put("/me/prefs", headers=h, json={"caption_style_last": value})
    assert r.status_code == 400
    assert r.json()["code"] == "bad_prefs"
    assert r.json()["detail"]["field"] == "caption_style_last"
    assert client.get("/me/prefs", headers=h).json() == {}
