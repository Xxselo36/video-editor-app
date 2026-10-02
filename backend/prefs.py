"""A signed-in user's remembered upload defaults (UX6, GET/PUT /me/prefs).

    {target_aspect, style, remove_fillers, voice_triggers,
     spoken_language, caption_style_by_aspect: {aspect: {presetId,
     overrides}}}

Every key is optional. The start screen saves the first five ("Save as
default"); caption_style_by_aspect is the editor's remembered caption
style per format (review E7), read by backend/doc.py resolve_style when
an analysis ends. Signed-out users keep the same object in their
browser (localStorage cleocuts.prefs.v1).

Stored as JSON in the accounts database's meta table under
"prefs:<user id>" (SQLite or Postgres, whichever backend/accounts.py
uses): one small row per user, no schema migration. A PUT merges: the
keys it names replace the stored ones (null removes one); a value that
doesn't validate is refused (400 bad_prefs) — nothing is stored then.
"""
from __future__ import annotations

import json
from typing import Any

from backend import doc as edit_doc
from backend.whisper_groq import SPOKEN_LANGUAGES

STYLES = ("tight", "smooth", "none")
KEY_PREFIX = "prefs:"
# A stored prefs object is tiny; anything bigger is not from our client.
MAX_BYTES = 16_000


class BadPrefs(ValueError):
    """A prefs body that doesn't validate: `field` names the key."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


def _check(key: str, value: Any) -> Any:
    if key == "target_aspect":
        ok = value in edit_doc.ASPECTS
    elif key == "style":
        if value == "balanced":       # the old name of "smooth"
            value = "smooth"
        ok = value in STYLES
    elif key in ("remove_fillers", "voice_triggers"):
        ok = isinstance(value, bool)
    elif key == "spoken_language":
        ok = value == "auto" or value in SPOKEN_LANGUAGES
    elif key == "caption_style_by_aspect":
        if not isinstance(value, dict):
            raise BadPrefs(key)
        out: dict[str, Any] = {}
        for aspect, ref in value.items():
            style = edit_doc.style_ref(ref) if aspect in edit_doc.ASPECTS else None
            if style is None:
                raise BadPrefs(key)
            try:
                style["overrides"] = edit_doc.validate_overrides(style["overrides"])
            except edit_doc.DocError:
                raise BadPrefs(key) from None
            out[aspect] = style
        return out
    else:
        raise BadPrefs(key)
    if not ok:
        raise BadPrefs(key)
    return value


def merge(current: dict[str, Any] | None, patch: Any) -> dict[str, Any]:
    """`current` with the keys of `patch` applied (null removes a key).
    Raises BadPrefs for an unknown key or a bad value."""
    if not isinstance(patch, dict):
        raise BadPrefs("body")
    out = dict(current or {})
    for key, value in patch.items():
        if value is None:
            if key not in PUBLIC_KEYS:
                raise BadPrefs(key)
            out.pop(key, None)
        else:
            out[key] = _check(key, value)
    if len(json.dumps(out)) > MAX_BYTES:
        raise BadPrefs("body")
    return out


PUBLIC_KEYS = ("target_aspect", "style", "remove_fillers", "voice_triggers",
               "spoken_language", "caption_style_by_aspect")


def _parse(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    # Only what still validates (a later release may store more).
    out: dict[str, Any] = {}
    for key in PUBLIC_KEYS:
        if key in value:
            try:
                out[key] = _check(key, value[key])
            except BadPrefs:
                pass
    return out


def get(user_id: str) -> dict[str, Any] | None:
    """The user's prefs, or None when they never saved any."""
    from backend import accounts
    return _parse(accounts.meta_get(KEY_PREFIX + user_id))


def put(user_id: str, patch: Any) -> dict[str, Any]:
    """Merge `patch` into the user's prefs (one transaction, row-locked
    per user) and return the stored result. Raises BadPrefs."""
    from backend import accounts
    key = KEY_PREFIX + user_id
    # Validated before the transaction too: a bad body never opens one.
    merge(None, patch)

    def _do(conn: Any) -> dict[str, Any]:
        row = conn.execute("SELECT value FROM meta WHERE key = ?",
                           (key,)).fetchone()
        merged = merge(_parse(row["value"] if row else None), patch)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(merged, separators=(",", ":"))))
        return merged
    return accounts._tx(_do, lock_key=key)


def delete(user_id: str) -> None:
    """Forget the user's prefs (account deletion)."""
    from backend import accounts
    accounts._tx(lambda conn: conn.execute(
        "DELETE FROM meta WHERE key = ?", (KEY_PREFIX + user_id,)),
        lock_key=KEY_PREFIX + user_id)
