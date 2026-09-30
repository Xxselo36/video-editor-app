"""Which font files the caption burn opens when the code runs from an image
layout. Run as a script (a fresh interpreter, so `src` is imported from the
layout, not from the repo):

    python font_probe.py <image /app dir> <preset> [<preset> ...]

Prints one line `FONT_PROBE {"<preset>": {"fonts": [paths], "clips": n}}`.
"""
import json
import os
import sys

app = os.path.abspath(sys.argv[1])
sys.path.insert(0, app)

from PIL import ImageFont  # noqa: E402

_orig = ImageFont.truetype
opened: list = []


def _spy(font=None, size=10, index=0, *a, **k):
    f = _orig(font, size, index, *a, **k)
    # The file really loaded: for a missing path Pillow searches the font
    # dirs for the same file name, so `font` can differ from f.path.
    opened.append(os.path.normpath(str(getattr(f, "path", None) or font)))
    return f


ImageFont.truetype = _spy

import src.effects  # noqa: E402

if os.path.dirname(os.path.abspath(src.effects.__file__)) != os.path.join(app, "src"):
    raise SystemExit(f"src imported from the wrong place: {src.effects.__file__}")

from moviepy.editor import ColorClip  # noqa: E402
from plugins.premiere import video_editor_premiere as vep  # noqa: E402

base = ColorClip((540, 960), color=(0, 0, 0), duration=3)
subs = [{"start": 0.0, "end": 0.4, "text": "Nobody"},
        {"start": 0.4, "end": 0.8, "text": "waits"},
        {"start": 0.8, "end": 1.2, "text": "ten"},
        {"start": 1.2, "end": 1.6, "text": "seconds"}]
out = {}
for preset in sys.argv[2:]:
    opened.clear()
    clips = vep._render_segment_with_standalone_captions(
        None, "/dev/null", subs, "tight", preset, preloaded_clip=base,
        return_clips_only=True)
    out[preset] = {"fonts": sorted(set(opened)),
                   "clips": len(clips) if isinstance(clips, list) else -1}
print("FONT_PROBE " + json.dumps(out), flush=True)
