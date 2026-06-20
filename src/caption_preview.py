"""Quick visual previews of every caption style for the GUI picker.

Renders a small PIL image per style ("EDITOR" sample word) so the user can
see what each style looks like before picking. Uses the same fonts and
colours as the real rendering pipeline so previews are accurate.

These previews are SIMPLIFIED:
  - one or two words on a neutral dark video-frame background
  - no per-word animation, just the visual style at a single instant
  - rendered as RGB PIL images at small size (~140 × 60 px)
"""
from __future__ import annotations

import os
from typing import Tuple
from PIL import Image, ImageDraw, ImageFont, ImageFilter


# ──────────────────────────────────────────────────────────────────────────────
# Font lookup helpers
# ──────────────────────────────────────────────────────────────────────────────

_ASSETS_FONTS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "fonts")
)


def _try_fonts(candidates, size) -> ImageFont.ImageFont:
    for entry in candidates:
        path, index = (entry, 0) if isinstance(entry, str) else entry
        try:
            if path.lower().endswith((".ttc", ".otc")) and index > 0:
                return ImageFont.truetype(path, size, index=index)
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _arial_black(size):
    return _try_fonts([
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
        "C:/Windows/Fonts/ariblk.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], size)


def _arial_regular(size):
    """The Clean renderer actually uses Arial (regular), not Arial Black —
    its weight comes from the multi-layer glow, not the font itself."""
    return _try_fonts([
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ], size)


def _impact(size):
    return _try_fonts([
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "C:/Windows/Fonts/impact.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], size)


def _bangers(size):
    return _try_fonts([
        os.path.join(_ASSETS_FONTS_DIR, "Bangers-Regular.ttf"),
        "/System/Library/Fonts/Supplemental/Impact.ttf",
    ], size)


def _avenir_italic(size):
    # macOS Avenir Next.ttc face order (verified by enumeration):
    #   0=Bold, 1=BoldItalic, 2=DemiBold, 3=DemiBoldItalic, 4=Italic,
    #   5=Medium, 6=MediumItalic, 7=Regular, 8=Heavy, 9=HeavyItalic,
    #   10=UltraLight, 11=UltraLightItalic.
    # Flash style uses HEAVY ITALIC → index 9.
    return _try_fonts([
        ("/System/Library/Fonts/Avenir Next.ttc", 9),
        ("/System/Library/Fonts/Avenir Next.ttc", 1),  # BoldItalic fallback
        "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
        "C:/Windows/Fonts/arialbi.ttf",
    ], size)


def _gillsans_bold(size):
    return _try_fonts([
        ("/System/Library/Fonts/Supplemental/GillSans.ttc", 1),
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    ], size)


def _script(size):
    return _try_fonts([
        "/System/Library/Fonts/Supplemental/Snell Roundhand.ttc",
        "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
        "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
    ], size)


# ──────────────────────────────────────────────────────────────────────────────
# Background
# ──────────────────────────────────────────────────────────────────────────────

def _bg(size: Tuple[int, int]) -> Image.Image:
    """Subtle vertical gradient so the captions read like they're on a video
    frame, not floating on the tile background."""
    w, h = size
    img = Image.new("RGB", (w, h), (40, 40, 46))
    for y in range(h):
        t = y / max(1, h - 1)
        # Slight gradient: a bit lighter at the top
        v = int(54 - 18 * t)
        ImageDraw.Draw(img).line([(0, y), (w, y)], fill=(v, v, v + 4))
    return img


def _draw_text_outline(draw, pos, text, font, fill, stroke=(0, 0, 0), stroke_w=3):
    """Cheap stroke by stamping the text in stroke colour around the target."""
    x, y = pos
    for dx in range(-stroke_w, stroke_w + 1):
        for dy in range(-stroke_w, stroke_w + 1):
            if dx * dx + dy * dy <= stroke_w * stroke_w:
                draw.text((x + dx, y + dy), text, font=font, fill=stroke)
    draw.text((x, y), text, font=font, fill=fill)


def _center_text(font, text, area_size):
    w, h = area_size
    bbox = font.getbbox(text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    return ((w - tw) // 2 - bbox[0], (h - th) // 2 - bbox[1]), (tw, th)


# ──────────────────────────────────────────────────────────────────────────────
# Per-style renderers
# ──────────────────────────────────────────────────────────────────────────────

def _render_clean(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img, "RGBA")
    font = _arial_black(int(size[1] * 0.42))
    pos, _ = _center_text(font, "EDITOR", size)
    _draw_text_outline(draw, pos, "EDITOR", font, (255, 255, 255), stroke=(0, 0, 0), stroke_w=2)
    return img


def _render_classic(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img)
    font = _arial_black(int(size[1] * 0.45))
    pos, _ = _center_text(font, "EDITOR", size)
    _draw_text_outline(draw, pos, "EDITOR", font, (255, 255, 255), stroke=(0, 0, 0), stroke_w=4)
    return img


def _render_highlight(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img, "RGBA")
    font = _impact(int(size[1] * 0.45))
    # Two-word sample so the box highlight reads: " IT EDITOR" with EDITOR boxed.
    text_left = "IT  "
    text_box = "EDITOR"
    bbox_l = font.getbbox(text_left)
    bbox_b = font.getbbox(text_box)
    total_w = (bbox_l[2] - bbox_l[0]) + (bbox_b[2] - bbox_b[0])
    th = max(bbox_l[3] - bbox_l[1], bbox_b[3] - bbox_b[1])
    x = (size[0] - total_w) // 2
    y = (size[1] - th) // 2 - bbox_b[1]
    # left word (non-active)
    _draw_text_outline(draw, (x, y), text_left, font, (255, 255, 255), stroke_w=2)
    # red box behind active word
    box_x = x + (bbox_l[2] - bbox_l[0])
    box_h = th + 6
    pad = 6
    draw.rectangle(
        [box_x - pad, y + bbox_b[1] - 3, box_x + (bbox_b[2] - bbox_b[0]) + pad, y + bbox_b[1] + box_h - 3],
        fill=(177, 16, 32),
    )
    _draw_text_outline(draw, (box_x, y), text_box, font, (255, 255, 255), stroke_w=0)
    return img


def _render_elegant(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img, "RGBA")
    script = _script(int(size[1] * 0.5))
    sans = _arial_black(int(size[1] * 0.4))
    # "the EDITOR" — "the" in sans white, "EDITOR" in gold script
    left = "the "
    right = "Editor"
    bl = sans.getbbox(left)
    br = script.getbbox(right)
    total_w = (bl[2] - bl[0]) + (br[2] - br[0]) + 4
    th = max(bl[3] - bl[1], br[3] - br[1])
    x = (size[0] - total_w) // 2
    y = (size[1] - th) // 2 - max(bl[1], br[1])
    _draw_text_outline(draw, (x, y), left, sans, (255, 255, 255), stroke_w=2)
    _draw_text_outline(draw, (x + (bl[2] - bl[0]) + 4, y), right, script, (232, 168, 56), stroke_w=2)
    return img


def _render_clipper(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img, "RGBA")
    font = _bangers(int(size[1] * 0.55))
    # "EDITOR" with the word in neon green to mimic the active-word colour
    pos, _ = _center_text(font, "EDITOR", size)
    _draw_text_outline(draw, pos, "EDITOR", font, (57, 255, 20), stroke=(0, 0, 0), stroke_w=4)
    return img


def _render_flash(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img, "RGBA")
    font = _avenir_italic(int(size[1] * 0.45))
    pos, _ = _center_text(font, "EDITOR", size)
    _draw_text_outline(draw, pos, "EDITOR", font, (0, 136, 204), stroke=(0, 0, 0), stroke_w=4)
    return img


def _render_punch(size):
    img = _bg(size)
    # Layer with soft glow
    glow_layer = Image.new("RGBA", size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    font = _gillsans_bold(int(size[1] * 0.5))
    text = "EDITOR"
    pos, _ = _center_text(font, text, size)
    # Stamp text in black, blur to make a glow halo
    for _ in range(2):
        glow_draw.text(pos, text, font=font, fill=(0, 0, 0, 200))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=4))
    img = Image.alpha_composite(img.convert("RGBA"), glow_layer).convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.text(pos, text, font=font, fill=(255, 220, 0))
    return img


def _render_subtle(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img)
    font = _arial_black(int(size[1] * 0.30))
    pos, _ = _center_text(font, "editor", size)
    _draw_text_outline(draw, pos, "editor", font, (235, 235, 235), stroke=(0, 0, 0), stroke_w=1)
    return img


def _render_none(size):
    img = _bg(size)
    draw = ImageDraw.Draw(img)
    font = _arial_black(int(size[1] * 0.28))
    pos, _ = _center_text(font, "no captions", size)
    draw.text(pos, "no captions", font=font, fill=(140, 140, 150))
    return img


_RENDERERS = {
    "clean": _render_clean,
    "classic": _render_classic,
    "highlight": _render_highlight,
    "elegant": _render_elegant,
    "clipper": _render_clipper,
    "flash": _render_flash,
    "punch": _render_punch,
    "subtle": _render_subtle,
    "none": _render_none,
}


# ──────────────────────────────────────────────────────────────────────────────
# Animated frame sequences
# ──────────────────────────────────────────────────────────────────────────────
# Each style returns a list of (PIL.Image, hold_ms). The GUI cycles through
# them with after() to give every tile a small animated demo of what the
# style actually does.

_SAMPLE_WORDS = ("EDITOR", "MUST", "WORK")


def _phrase_text_size(font, words, spacing):
    metrics_ascent, metrics_descent = font.getmetrics()
    line_h = metrics_ascent + metrics_descent
    total_w = 0
    widths = []
    for w in words:
        bb = font.getbbox(w)
        ww = bb[2] - bb[0]
        widths.append(ww)
        total_w += ww
    total_w += spacing * (len(words) - 1)
    return widths, total_w, line_h


def _phrase_positions(widths, total_w, area_w, spacing):
    """Return list of x-positions for each word so the phrase is centred."""
    x = (area_w - total_w) // 2
    out = []
    for ww in widths:
        out.append(x)
        x += ww + spacing
    return out


def _render_clean_word_glow(img_size, paint_outer, paint_mid, paint_inner, glow_scale=1.0):
    """Replicates the 3-tier Gaussian-blurred glow used by
    create_dynamic_word_clip in effects.py:
      - Layers 0-1: outer halo, max α 75, blur radius 25 (scaled)
      - Layers 2-3: mid halo,   max α 108, blur radius 15 (scaled)
      - Layers 4-5: inner halo, max α 157, blur radius 6  (scaled)
    Each paint_* callback paints word(s) onto a fresh RGBA layer with the
    right alpha multipliers for its tier.
    """
    layers = [Image.new("RGBA", img_size, (0, 0, 0, 0)) for _ in range(6)]
    for i in (0, 1):
        paint_outer(layers[i])
    for i in (2, 3):
        paint_mid(layers[i])
    for i in (4, 5):
        paint_inner(layers[i])
    r_outer = max(2, int(round(25 * glow_scale)))
    r_mid   = max(2, int(round(15 * glow_scale)))
    r_inner = max(1, int(round(6 * glow_scale)))
    for i in (0, 1):
        layers[i] = layers[i].filter(ImageFilter.GaussianBlur(radius=r_outer))
    for i in (2, 3):
        layers[i] = layers[i].filter(ImageFilter.GaussianBlur(radius=r_mid))
    for i in (4, 5):
        layers[i] = layers[i].filter(ImageFilter.GaussianBlur(radius=r_inner))
    result = Image.new("RGBA", img_size, (0, 0, 0, 0))
    for L in layers:
        result = Image.alpha_composite(result, L)
    return result


def _frames_clean(size):
    """Clean preview — words accumulate ("CLEAN" repeated) with same multi-
    layer glow + sharp text pipeline as src/effects.create_dynamic_word_clip.
    """
    w, h = size
    font = _arial_regular(int(h * 0.28))
    words = ("CLEAN", "CLEAN", "CLEAN", "CLEAN")
    spacing = 6
    line_split = 2

    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    widths = [font.getbbox(w_)[2] - font.getbbox(w_)[0] for w_ in words]

    def _line_xs(start_i, end_i):
        line_words_w = sum(widths[start_i:end_i]) + spacing * (end_i - start_i - 1)
        x = (w - line_words_w) // 2
        out = []
        for i in range(start_i, end_i):
            out.append(x)
            x += widths[i] + spacing
        return out

    xs_all = _line_xs(0, line_split) + _line_xs(line_split, len(words))
    total_h = line_h * 2 - int(line_h * 0.30)
    top_y = (h - total_h) // 2
    ys_all = (
        [top_y] * line_split
        + [top_y + line_h - int(line_h * 0.30)] * (len(words) - line_split)
    )
    glow_scale = h / 1080.0 * 6

    def _draw_tier(L, shown, offset_range, max_alpha):
        d = ImageDraw.Draw(L)
        for i in range(shown):
            if i % 3 == 2:
                continue
            for offset in offset_range:
                alpha = int(max_alpha * (1 - offset / offset_range.start))
                d.text((xs_all[i], ys_all[i]), words[i], font=font,
                       fill=(255, 255, 255, alpha))

    frames = []
    for shown in range(1, len(words) + 1):
        base = _bg(size).convert("RGBA")
        glow = _render_clean_word_glow(
            size,
            lambda L, s=shown: _draw_tier(L, s, range(6, 0, -1), 90),
            lambda L, s=shown: _draw_tier(L, s, range(4, 0, -1), 130),
            lambda L, s=shown: _draw_tier(L, s, range(3, 0, -1), 180),
            glow_scale=glow_scale,
        )
        base = Image.alpha_composite(base, glow)

        text_layer = Image.new("RGBA", size, (0, 0, 0, 0))
        td = ImageDraw.Draw(text_layer)
        for i in range(shown):
            _draw_text_outline(td, (xs_all[i], ys_all[i]), words[i], font,
                               (255, 255, 255), stroke=(0, 0, 0), stroke_w=1)
            td.text((xs_all[i], ys_all[i]), words[i], font=font,
                    fill=(255, 255, 255, 255))
        base = Image.alpha_composite(base, text_layer)
        frames.append((base.convert("RGB"), 430))
    return frames


def _frames_classic(size):
    """Classic preview — "CLASSIC CLASSIC CLASSIC" accumulating, Impact font,
    thick black outline, drop shadow."""
    return _frames_modern_accumulate(size, ("CLASSIC",) * 3, font_size_frac=0.30)


def _frames_modern_accumulate(size, words, font_size_frac=0.30):
    """Shared helper for Classic-like styles: Impact font, drop shadow,
    thick outline, words accumulate left-to-right with stable positions."""
    w, h = size
    font = _impact(int(h * font_size_frac))
    widths, total_w, line_h = _phrase_text_size(font, words, spacing=6)
    # If the full phrase doesn't fit, shrink the font until it does
    while total_w > w - 8 and font.size > 8:
        font = _impact(font.size - 1)
        widths, total_w, line_h = _phrase_text_size(font, words, spacing=6)
    xs = _phrase_positions(widths, total_w, w, spacing=6)
    y = (h - line_h) // 2
    shadow_offset = max(1, int(font.size / 14))
    stroke_w = max(2, int(font.size / 12))

    frames = []
    for shown in range(1, len(words) + 1):
        base = _bg(size).convert("RGBA")
        shadow_layer = Image.new("RGBA", size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow_layer)
        for i in range(shadow_offset, 0, -1):
            alpha = int(100 * (i / shadow_offset))
            for j in range(shown):
                sd.text((xs[j] + i, y + i), words[j], font=font,
                        fill=(0, 0, 0, alpha))
        base = Image.alpha_composite(base, shadow_layer)

        text_layer = Image.new("RGBA", size, (0, 0, 0, 0))
        td = ImageDraw.Draw(text_layer)
        for j in range(shown):
            _draw_text_outline(td, (xs[j], y), words[j], font,
                               (255, 255, 255), stroke=(0, 0, 0), stroke_w=stroke_w)
            td.text((xs[j], y), words[j], font=font,
                    fill=(255, 255, 255, 255))
        base = Image.alpha_composite(base, text_layer)
        frames.append((base.convert("RGB"), 430))
    return frames


def _frames_highlight(size):
    """Highlight preview — "HIGHLIGHT" x3 with the red box cycling between
    them. Font auto-shrinks if HIGHLIGHT is too wide for the tile."""
    w, h = size
    words = ("HIGHLIGHT",) * 3
    font = _impact(int(h * 0.30))
    widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    while total_w > w - 8 and font.size > 8:
        font = _impact(font.size - 1)
        widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    xs = _phrase_positions(widths, total_w, w, spacing=8)
    y = (h - line_h) // 2
    frames = []
    for active in range(len(words)):
        img = _bg(size).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        pad_x, pad_y = 4, 3
        ax = xs[active]
        aw = widths[active]
        d.rectangle(
            [ax - pad_x, y + 2, ax + aw + pad_x, y + line_h - pad_y],
            fill=(177, 16, 32),
        )
        for i, word in enumerate(words):
            _draw_text_outline(d, (xs[i], y), word, font,
                               (255, 255, 255),
                               stroke=(0, 0, 0),
                               stroke_w=0 if i == active else 2)
        frames.append((img, 380))
    return frames


def _frames_elegant(size):
    """Elegant preview — mirrors src/effects.create_elegant_phrase_subtitle:
      - "Special" words (nouns/verbs) in gold (#E8A838 @ 70%) + script font,
        script 30% larger than sans, ORANGE glow halo, fake-bold via offsets.
      - Regular words in white + bold sans, white glow halo.
      - No outline — definition comes purely from the glow.
      - Words accumulate left-to-right with stable layout.
    For the preview, "Elegant" repeats: gold script → white sans → gold script.
    """
    w, h = size
    sans = _try_fonts([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ], int(h * 0.30))
    script = _script(int(sans.size * 1.30))  # 30% larger, matches the renderer

    # word, is_special (script+gold) — gold "Elegant" sits in the MIDDLE
    # so the accumulation reads as: regular → eye-catching gold → regular.
    parts = [
        ("Elegant", False),
        ("Elegant", True),
        ("Elegant", False),
    ]
    spacing = 4

    def _measure():
        out = []
        for word, special in parts:
            fnt = script if special else sans
            bb = fnt.getbbox(word)
            out.append((word, special, fnt, bb[2] - bb[0]))
        return out

    measured = _measure()
    total = sum(m[3] for m in measured) + spacing * (len(measured) - 1)
    # Shrink to fit width if necessary
    while total > w - 6 and sans.size > 8:
        sans = _try_fonts([
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ], sans.size - 1)
        script = _script(int(sans.size * 1.30))
        measured = _measure()
        total = sum(m[3] for m in measured) + spacing * (len(measured) - 1)

    # Anchor on the bigger (script) font for vertical centring
    script_h = script.getmetrics()[0] + script.getmetrics()[1]
    y_base = (h - script_h) // 2

    # Pre-compute x positions for every word
    xs = []
    x_cursor = (w - total) // 2
    for (_, _, _, ww) in measured:
        xs.append(x_cursor)
        x_cursor += ww + spacing

    glow_scale = h / 1080.0 * 6  # ~0.29 for h=74

    def _paint_glow(L, shown, blur_alpha_mult, blur_radius):
        d = ImageDraw.Draw(L)
        for i in range(shown):
            word, special, fnt, _ = measured[i]
            if special:
                glow_color = (255, 140, 0)   # vivid orange for gold/script words
                stamps = 4
                base_alpha = blur_alpha_mult  # already high mult
            else:
                glow_color = (255, 255, 255)
                stamps = 2
                base_alpha = blur_alpha_mult // 2
            for _ in range(stamps):
                d.text((xs[i], y_base), word, font=fnt,
                       fill=(*glow_color, min(255, base_alpha)))

    def _build_glow(shown):
        # Three tiers matching the production renderer
        outer = Image.new("RGBA", size, (0, 0, 0, 0))
        _paint_glow(outer, shown, blur_alpha_mult=80, blur_radius=25)
        outer = outer.filter(ImageFilter.GaussianBlur(
            radius=max(2, int(25 * glow_scale))))

        mid = Image.new("RGBA", size, (0, 0, 0, 0))
        _paint_glow(mid, shown, blur_alpha_mult=120, blur_radius=12)
        mid = mid.filter(ImageFilter.GaussianBlur(
            radius=max(2, int(12 * glow_scale))))

        inner = Image.new("RGBA", size, (0, 0, 0, 0))
        _paint_glow(inner, shown, blur_alpha_mult=180, blur_radius=5)
        inner = inner.filter(ImageFilter.GaussianBlur(
            radius=max(1, int(5 * glow_scale))))

        out = Image.new("RGBA", size, (0, 0, 0, 0))
        for L in (outer, mid, inner):
            out = Image.alpha_composite(out, L)
        return out

    frames = []
    for shown in range(1, len(measured) + 1):
        base = _bg(size).convert("RGBA")
        base = Image.alpha_composite(base, _build_glow(shown))

        text_layer = Image.new("RGBA", size, (0, 0, 0, 0))
        td = ImageDraw.Draw(text_layer)
        for i in range(shown):
            word, special, fnt, _ = measured[i]
            if special:
                # Gold @ 70% opacity + fake-bold offsets (mirrors renderer)
                col = (232, 168, 56, 178)
                for ox, oy in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1)]:
                    td.text((xs[i] + ox, y_base + oy), word, font=fnt, fill=col)
                td.text((xs[i], y_base), word, font=fnt, fill=col)
            else:
                td.text((xs[i], y_base), word, font=fnt, fill=(255, 255, 255, 255))
        base = Image.alpha_composite(base, text_layer)

        frames.append((base.convert("RGB"), 500))
    return frames


def _frames_clipper(size):
    """Clipper preview — "CLIPPER" x3 with the green active-word highlight
    cycling between them (Bangers comic font)."""
    w, h = size
    words = ("CLIPPER",) * 3
    font = _bangers(int(h * 0.42))
    widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    while total_w > w - 8 and font.size > 8:
        font = _bangers(font.size - 1)
        widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    xs = _phrase_positions(widths, total_w, w, spacing=8)
    y = (h - line_h) // 2
    frames = []
    for active in range(len(words)):
        img = _bg(size).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        for i, word in enumerate(words):
            col = (57, 255, 20) if i == active else (255, 255, 255)
            _draw_text_outline(d, (xs[i], y), word, font, col,
                               stroke=(0, 0, 0), stroke_w=3)
        frames.append((img, 360))
    return frames


def _frames_flash(size):
    """Flash preview — "FLASH" x3 in Avenir Next *Heavy Italic*, blue active
    highlight cycles. Same font face the production ASS renderer requests."""
    w, h = size
    words = ("FLASH",) * 3
    font = _avenir_italic(int(h * 0.36))
    widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    while total_w > w - 8 and font.size > 8:
        font = _avenir_italic(font.size - 1)
        widths, total_w, line_h = _phrase_text_size(font, words, spacing=8)
    xs = _phrase_positions(widths, total_w, w, spacing=8)
    y = (h - line_h) // 2
    frames = []
    for active in range(len(words)):
        img = _bg(size).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        for i, word in enumerate(words):
            col = (0, 136, 204) if i == active else (255, 255, 255)
            _draw_text_outline(d, (xs[i], y), word, font, col,
                               stroke=(0, 0, 0), stroke_w=3)
        frames.append((img, 360))
    return frames


def _frames_punch(size):
    """Punch preview — "PUNCH" appears one frame at a time with a soft glow.
    Since Punch is the "one word at a time" style, the word reappears in
    place on each cycle (with a brief blank between to simulate the swap)."""
    w, h = size
    font = _gillsans_bold(int(h * 0.44))
    word = "PUNCH"
    bb = font.getbbox(word)
    word_w = bb[2] - bb[0]
    wx = (w - word_w) // 2 - bb[0]
    ascent, descent = font.getmetrics()
    wy = (h - (ascent + descent)) // 2

    # Render word frame
    word_img = _bg(size).convert("RGBA")
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for _ in range(2):
        gd.text((wx, wy), word, font=font, fill=(0, 0, 0, 200))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=4))
    word_img = Image.alpha_composite(word_img, glow)
    d = ImageDraw.Draw(word_img)
    d.text((wx, wy), word, font=font, fill=(255, 220, 0))

    # Empty frame (just bg) to suggest the gap between consecutive Punch words
    blank = _bg(size).convert("RGB")

    return [
        (word_img.convert("RGB"), 520),
        (blank, 120),
    ]


def _frames_subtle(size):
    """Subtle preview — one small word "subtle" that blinks in place.
    Mirrors the production "modern" subtitle style (Impact font) but with
    the subtle config: 0.75 fontsize multiplier, 2-px outline, lower
    position to match subtitle_position_y=0.90."""
    w, h = size
    word = "subtle"
    font = _impact(int(h * 0.28))
    bb = font.getbbox(word)
    word_w = bb[2] - bb[0]
    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    x = (w - word_w) // 2 - bb[0]
    y = int(h * 0.55) - line_h // 2
    shadow_offset = max(1, int(font.size / 16))
    stroke_w = max(1, int(font.size / 16))

    # Frame 1: word visible
    visible = _bg(size).convert("RGBA")
    shadow_layer = Image.new("RGBA", size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    for i in range(shadow_offset, 0, -1):
        alpha = int(80 * (i / shadow_offset))
        sd.text((x + i, y + i), word, font=font, fill=(0, 0, 0, alpha))
    visible = Image.alpha_composite(visible, shadow_layer)
    text_layer = Image.new("RGBA", size, (0, 0, 0, 0))
    td = ImageDraw.Draw(text_layer)
    _draw_text_outline(td, (x, y), word, font,
                       (235, 235, 235), stroke=(0, 0, 0), stroke_w=stroke_w)
    td.text((x, y), word, font=font, fill=(235, 235, 235, 255))
    visible = Image.alpha_composite(visible, text_layer)

    # Frame 2: empty (blank between blinks)
    blank = _bg(size).convert("RGB")

    return [
        (visible.convert("RGB"), 900),
        (blank, 280),
    ]


def _frames_none(size):
    return [(_render_none(size).convert("RGB"), 1500)]


_ANIMATORS = {
    "clean": _frames_clean,
    "classic": _frames_classic,
    "highlight": _frames_highlight,
    "elegant": _frames_elegant,
    "clipper": _frames_clipper,
    "flash": _frames_flash,
    "punch": _frames_punch,
    "subtle": _frames_subtle,
    "none": _frames_none,
}

_ANIM_CACHE: dict = {}


def render_caption_animation_frames(caption_key: str, size: Tuple[int, int] = (160, 72)):
    """Return [(PIL.Image, hold_ms), ...] for animating this style's preview.
    Cached per (key, size)."""
    cache_key = (caption_key, size)
    if cache_key in _ANIM_CACHE:
        return _ANIM_CACHE[cache_key]
    fn = _ANIMATORS.get(caption_key, _frames_none)
    try:
        frames = fn(size)
    except Exception:
        frames = [(_bg(size).convert("RGB"), 1000)]
    _ANIM_CACHE[cache_key] = frames
    return frames


# Tiny in-process cache keyed by (caption_key, size).
_CACHE: dict = {}


def render_caption_preview(caption_key: str, size: Tuple[int, int] = (160, 72)) -> Image.Image:
    """Return a PIL.Image preview of the given caption style. Cached."""
    key = (caption_key, size)
    if key in _CACHE:
        return _CACHE[key]
    renderer = _RENDERERS.get(caption_key, _render_none)
    try:
        img = renderer(size).convert("RGB")
    except Exception:
        img = _bg(size).convert("RGB")
    _CACHE[key] = img
    return img
