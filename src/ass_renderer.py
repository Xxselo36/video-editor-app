"""ASS (Advanced SubStation Alpha) renderer for animated caption styles.

Bypasses MoviePy's per-frame Python compositing in favor of libass, which
renders subtitles natively during ffmpeg encode. This is dramatically faster
for styles with per-word animations (color highlight, scale bounce, etc.).

Supported caption styles:
  * clipper, flash   — full phrase with active word in highlight color (bounce-in)
  * highlight        — full phrase with active word wrapped in a colored "box"
                       (implemented via a very thick highlight-colored outline
                       on the active word; libass fills the gaps between
                       letters so it reads as a solid block behind the word)
  * punch            — one word at a time, yellow with soft black glow

ASS animation tags used:
  {\\1c&HBBGGRR&}   primary text color (note BGR order!)
  {\\3c&HBBGGRR&}   outline color
  {\\bord N}        outline width
  {\\shad N}        shadow distance
  {\\be N}          blur edges (1-8) — used for the punch glow
  {\\fscxN\\fscyN}  scale percent
  {\\t(start_ms,end_ms,override)}  animated transition
  {\\pos(x,y)}      absolute position
"""

import os
from dataclasses import dataclass
from typing import List, Tuple


# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

def _hex_to_bgr(hex_color: str) -> str:
    """#RRGGBB -> ASS &HBBGGRR&"""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return "&H00FFFFFF&"
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return f"&H{b:02X}{g:02X}{r:02X}&"


def _rgb_to_bgr(rgb: Tuple[int, int, int]) -> str:
    r, g, b = rgb
    return f"&H{b:02X}{g:02X}{r:02X}&"


# ---------------------------------------------------------------------------
# Time formatting (ASS uses H:MM:SS.cc — centiseconds)
# ---------------------------------------------------------------------------

def _fmt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


# ---------------------------------------------------------------------------
# Font / style identification
# ---------------------------------------------------------------------------

# Caption keys that this renderer can handle.
# "highlight" and "punch" stay on the legacy PIL compositor — highlight
# needs a real rectangular box per active word and punch needs a soft
# multi-layer glow; both look noticeably better when PIL renders them
# pixel-perfect than what libass can approximate with its outline tags.
SUPPORTED_CAPTION_KEYS = {"clipper", "flash"}


def _font_for_caption(caption_key: str) -> Tuple[str, int, int]:
    """Return (fontname, bold_flag, italic_flag) for ASS V4+ style.
    libass looks up fonts by family name — picking the exact face name
    (e.g. "Avenir Next Heavy") makes CoreText return that weight directly
    instead of falling back to a thinner default."""
    if caption_key == "flash":
        return "Avenir Next Heavy", 0, 1
    if caption_key == "highlight":
        return "Impact", 0, 0
    if caption_key == "punch":
        return "Gill Sans", 1, 0
    # clipper default
    return "Bangers", 0, 0


def _assets_fonts_dir() -> str:
    """Absolute path to bundled fonts directory."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "assets", "fonts"))


def _find_impact_font() -> str:
    """Best-effort lookup of the Impact TTF on the current platform.
    Used for PIL-based word-width measurement when laying out the
    "highlight" caption style. Returns "" if no candidate found."""
    candidates = [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/Library/Fonts/Impact.ttf",
        os.path.expanduser("~/Library/Fonts/Impact.ttf"),
        "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
        "C:/Windows/Fonts/impact.ttf",
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return ""


def _measure_word_widths(words, font_path: str, fontsize: int):
    """Return (widths_list, text_height) or None if measurement fails.
    Uses PIL.ImageFont with the actual TTF so widths line up reasonably
    well with what libass will render."""
    try:
        from PIL import ImageFont
        font = ImageFont.truetype(font_path, fontsize)
    except Exception:
        return None
    widths = []
    for w in words:
        bbox = font.getbbox(w)
        widths.append(bbox[2] - bbox[0])
    sample = "AHg"  # mixed ascender/descender for representative height
    bb = font.getbbox(sample)
    height = bb[3] - bb[1]
    return widths, height


# ---------------------------------------------------------------------------
# Phrase data structure
# ---------------------------------------------------------------------------

@dataclass
class AssPhrase:
    """One phrase of N words to show as an animated subtitle group."""
    words: List[str]
    word_times: List[Tuple[float, float]]  # relative to phrase_start
    phrase_start: float                    # absolute time in the segment timeline
    phrase_end: float


# ---------------------------------------------------------------------------
# Per-phrase event generator
# ---------------------------------------------------------------------------

def _phrase_events(
    phrase: AssPhrase,
    caption_key: str,
    style_config: dict,
    video_size: Tuple[int, int],
    fontsize: int,
    bounce_ms: int = 150,
) -> List[str]:
    """Dispatch to the right render mode for this caption style."""
    if caption_key == "punch":
        return _punch_events(phrase, style_config, bounce_ms=180)
    return _color_highlight_events(phrase, style_config, bounce_ms)


def _color_highlight_events(
    phrase: AssPhrase, style_config: dict, bounce_ms: int
) -> List[str]:
    """clipper / flash — phrase with active word in highlight color."""
    upper_words = [w.upper() for w in phrase.words]
    n = len(upper_words)
    if n == 0:
        return []

    highlight_bgr = _hex_to_bgr(
        style_config.get("subtitle_highlight_color_hex", "#0088CC")
    )
    white_bgr = "&H00FFFFFF&"

    events: List[str] = []
    for active_i in range(n):
        wt_start_rel, _ = phrase.word_times[active_i]
        evt_start_abs = phrase.phrase_start + wt_start_rel
        if active_i + 1 < n:
            evt_end_abs = phrase.phrase_start + phrase.word_times[active_i + 1][0]
        else:
            evt_end_abs = phrase.phrase_end
        evt_end_abs = max(evt_start_abs + 0.05, min(evt_end_abs, phrase.phrase_end))

        parts: List[str] = []
        for i, word in enumerate(upper_words):
            if i == active_i:
                parts.append(f"{{\\1c{highlight_bgr}}}{word}{{\\1c{white_bgr}}}")
            else:
                parts.append(word)
        body = " ".join(parts)

        if active_i == 0 and bounce_ms > 0:
            body = (
                f"{{\\fscx112\\fscy112\\t(0,{bounce_ms},\\fscx100\\fscy100)}}"
                + body
            )

        events.append(
            f"Dialogue: 0,{_fmt_time(evt_start_abs)},{_fmt_time(evt_end_abs)},"
            f"Default,,0,0,0,,{body}"
        )

    return events


def _box_highlight_events(
    phrase: AssPhrase,
    style_config: dict,
    video_size: Tuple[int, int],
    fontsize: int,
    bounce_ms: int,
) -> List[str]:
    """highlight — phrase with active word inside a clean rectangular box.

    Layout strategy:
      1. Measure each word's pixel width with PIL.ImageFont so we can lay
         out the phrase ourselves.
      2. Anchor *both* text and the box drawing with \\an2 (bottom-centre)
         at the SAME baseline_y. That way the baseline is a known anchor
         and the box can be sized in baseline-relative coordinates so it
         hugs the cap height of the letters, not the full line box.
      3. Draw the rectangle with \\p1 so it has no line-leading padding.
      4. Layer 0: rectangles (behind). Layer 1: text (in front).
    Falls back to the colour-highlight trick if Impact isn't findable."""
    upper_words = [w.upper() for w in phrase.words]
    n = len(upper_words)
    if n == 0:
        return []

    font_path = _find_impact_font()
    if not font_path:
        return _color_highlight_events(phrase, style_config, bounce_ms)
    measurement = _measure_word_widths(upper_words, font_path, fontsize)
    if measurement is None:
        return _color_highlight_events(phrase, style_config, bounce_ms)
    widths, _measured_text_h = measurement

    video_w, video_h = video_size
    space_w = int(fontsize * 0.30)
    total_w = sum(widths) + space_w * (n - 1)
    x_start = (video_w - total_w) / 2.0

    # The user-facing position_y_frac means "where the visible centre of
    # the letters sits". From that we compute the baseline:
    #   baseline = letter_centre + cap_height/2
    position_y_frac = style_config.get("subtitle_position_y", 0.75)
    letter_centre_y = int(video_h * position_y_frac)
    cap_h_px = int(fontsize * 0.72)        # Impact cap height ≈ 72% of em size
    descender_px = int(fontsize * 0.20)
    baseline_y = letter_centre_y + cap_h_px // 2

    # Text anchored at \an2 places line-bottom (= baseline + descender) here.
    text_anchor_y = baseline_y + descender_px

    # Box anchored at \an2: rectangle is drawn from y=-box_h to y=v_pad,
    # so it extends slightly below the baseline (visual symmetry).
    h_pad = int(fontsize * 0.14)
    v_pad = int(fontsize * 0.08)
    box_inner_h = cap_h_px + v_pad * 2
    box_anchor_y = baseline_y + v_pad

    centers_x: List[float] = []
    x_cursor = x_start
    for ww in widths:
        centers_x.append(x_cursor + ww / 2.0)
        x_cursor += ww + space_w

    highlight_bgr = _hex_to_bgr(
        style_config.get("subtitle_highlight_color_hex", "#B11020")
    )

    phrase_start = phrase.phrase_start
    phrase_end = phrase.phrase_end

    events: List[str] = []

    # Layer 0 — red rectangle behind active word.
    for active_i in range(n):
        wt_start_rel, _ = phrase.word_times[active_i]
        evt_start_abs = phrase_start + wt_start_rel
        if active_i + 1 < n:
            evt_end_abs = phrase_start + phrase.word_times[active_i + 1][0]
        else:
            evt_end_abs = phrase_end
        evt_end_abs = max(evt_start_abs + 0.05, min(evt_end_abs, phrase_end))

        cx = centers_x[active_i]
        box_w = widths[active_i] + h_pad * 2
        w2 = box_w / 2.0
        # Drawing extends from y=-box_inner_h (top) up to y=0 (bottom).
        # With \an2 at (cx, box_anchor_y) the bottom of the drawing sits at
        # box_anchor_y on screen.
        draw = (
            f"m -{w2:.0f} -{box_inner_h} "
            f"l {w2:.0f} -{box_inner_h} "
            f"l {w2:.0f} 0 "
            f"l -{w2:.0f} 0"
        )
        body = (
            f"{{\\an2\\pos({cx:.0f},{box_anchor_y})"
            f"\\bord0\\shad0\\1c{highlight_bgr}\\p1}}{draw}{{\\p0}}"
        )
        events.append(
            f"Dialogue: 0,{_fmt_time(evt_start_abs)},{_fmt_time(evt_end_abs)},"
            f"Default,,0,0,0,,{body}"
        )

    # Layer 1 — text events, one per word, full phrase duration.
    for i, (word, cx) in enumerate(zip(upper_words, centers_x)):
        bounce = ""
        if bounce_ms > 0:
            bounce = (
                f"\\fscx112\\fscy112\\t(0,{bounce_ms},\\fscx100\\fscy100)"
            )
        body = f"{{\\an2\\pos({cx:.0f},{text_anchor_y}){bounce}}}{word}"
        events.append(
            f"Dialogue: 1,{_fmt_time(phrase_start)},{_fmt_time(phrase_end)},"
            f"Default,,0,0,0,,{body}"
        )

    return events


def _punch_events(
    phrase: AssPhrase, style_config: dict, bounce_ms: int = 180
) -> List[str]:
    """punch — one word at a time, yellow text with soft black glow.
    Punch sets `clean_words_per_phrase=1` so each phrase contains a single
    word; the loop below handles the generic case anyway."""
    upper_words = [w.upper() for w in phrase.words]
    n = len(upper_words)
    if n == 0:
        return []

    # Default yellow #FFDC00. The style normally sets this via
    # subtitle_highlight_color_hex but fall back if missing.
    text_bgr = _hex_to_bgr(
        style_config.get("subtitle_highlight_color_hex", "#FFDC00")
    )
    glow_bgr = "&H00000000&"
    glow_bord = style_config.get("_punch_glow_bord", 5)
    glow_be = style_config.get("_punch_glow_be", 3)

    events: List[str] = []
    for i in range(n):
        wt_start_rel, wt_end_rel = phrase.word_times[i]
        evt_start_abs = phrase.phrase_start + wt_start_rel
        evt_end_abs = phrase.phrase_start + wt_end_rel
        # Stretch a hair so libass keeps the word visible up to the next one
        if i + 1 < n:
            nxt_start = phrase.phrase_start + phrase.word_times[i + 1][0]
            evt_end_abs = min(evt_end_abs + 0.05, nxt_start)
        else:
            evt_end_abs = min(evt_end_abs + 0.05, phrase.phrase_end)
        evt_end_abs = max(evt_start_abs + 0.08, evt_end_abs)

        body = (
            f"{{\\1c{text_bgr}\\3c{glow_bgr}\\bord{glow_bord}\\be{glow_be}\\shad0}}"
            + upper_words[i]
        )
        if bounce_ms > 0:
            body = (
                f"{{\\fscx120\\fscy120\\t(0,{bounce_ms},\\fscx100\\fscy100)}}"
                + body
            )

        events.append(
            f"Dialogue: 0,{_fmt_time(evt_start_abs)},{_fmt_time(evt_end_abs)},"
            f"Default,,0,0,0,,{body}"
        )

    return events


# ---------------------------------------------------------------------------
# Full ASS file builder
# ---------------------------------------------------------------------------

def build_ass_file(
    phrases: List[AssPhrase],
    caption_key: str,
    style_config: dict,
    video_size: Tuple[int, int],
    output_path: str,
) -> None:
    """Write an ASS file with all the subtitle events. Caller is responsible
    for invoking ffmpeg with `-vf ass=<path>:fontsdir=<dir>`."""
    width, height = video_size
    fontsize_mult = style_config.get("subtitle_fontsize_multiplier", 1.0)
    # libass Fontsize maps to line height, while the legacy PIL path used
    # cap height — bump ~32% to match the perceived size.
    fontsize = max(53, int(height * 0.0726 * fontsize_mult))

    fontname, bold_flag, italic_flag = _font_for_caption(caption_key)

    # Outline (stroke) — match the visual weight of the PIL stroke_width
    stroke_w = style_config.get("subtitle_stroke_width", 5)
    outline = max(3, int(stroke_w * 0.9))

    # Position: alignment=2 = bottom-center; MarginV is the distance from
    # the bottom edge. The PIL path uses position_y as "where the vertical
    # center of the line sits, in fractions of video height".
    position_y = style_config.get("subtitle_position_y", 0.75)
    margin_v = max(10, int(height * (1.0 - position_y) - fontsize / 2))

    styles_block = (
        f"Style: Default,{fontname},{fontsize},"
        f"&H00FFFFFF&,&H000000FF&,&H00000000&,&H00000000&,"
        f"{bold_flag},{italic_flag},0,0,100,100,0,0,1,{outline},0,2,40,40,{margin_v},1"
    )

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{styles_block}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events: List[str] = []
    for ph in phrases:
        events.extend(
            _phrase_events(ph, caption_key, style_config, (width, height), fontsize)
        )

    content = header + "\n".join(events) + "\n"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)


# ---------------------------------------------------------------------------
# Helper: ffmpeg filter string
# ---------------------------------------------------------------------------

def build_ass_filter_arg(ass_path: str) -> str:
    """Build the value for -vf to apply this ASS file via libass.
    Escapes the colon-separated arguments. Includes our bundled fonts dir
    so the Bangers font is found in built/portable installs."""
    fontsdir = _assets_fonts_dir()
    # ffmpeg filter args use ':' as separator and '\' as escape inside values.
    # On absolute paths with ':' (Windows drive letter, but we already use
    # Posix paths) this would conflict — escape both colons in path values.
    _esc = lambda p: p.replace("\\", "/").replace(":", r"\:")
    return f"ass={_esc(ass_path)}:fontsdir={_esc(fontsdir)}"
