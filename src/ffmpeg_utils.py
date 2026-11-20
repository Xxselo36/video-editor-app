"""
FFmpeg/FFprobe Pfad-Aufloesung fuer Nuitka Bundle und Entwicklung.

Prueft in dieser Reihenfolge:
1. Nuitka Bundle (neben der kompilierten Binary)
2. imageio_ffmpeg (pip-installierte ffmpeg Binary)
3. System PATH
"""

import os
import re
import sys
import shutil
import platform
import subprocess
import tempfile
from pathlib import Path
from functools import lru_cache

# No console window per ffmpeg / ffprobe call in the windowless Windows
# build (CREATE_NO_WINDOW), as for every other process the app starts
from .platform_utils import get_subprocess_kwargs

_IS_WINDOWS = platform.system() == "Windows"


def _is_bundled() -> bool:
    """Prueft ob wir in einem Nuitka-kompilierten Bundle laufen."""
    return getattr(sys, 'frozen', False) or '__compiled__' in globals()


def _get_bundle_dir() -> Path:
    """Gibt das Verzeichnis der ausfuehrbaren Datei zurueck."""
    if _is_bundled():
        # Nuitka: sys.executable zeigt auf die kompilierte Binary
        # In .app Bundle: VideoEditor.app/Contents/MacOS/gui
        return Path(sys.executable).parent
    # Entwicklung: Verzeichnis des Skripts
    return Path(__file__).parent.parent.resolve()


@lru_cache(maxsize=1)
def get_ffmpeg_path() -> str:
    """Gibt den Pfad zu ffmpeg zurueck."""
    bundle_dir = _get_bundle_dir()

    # 1. Nuitka Bundle: search for ffmpeg binary in bundle directory
    if _is_bundled():
        import glob
        for pattern in [
            str(bundle_dir / 'imageio_ffmpeg' / 'binaries' / 'ffmpeg*'),
            str(bundle_dir / 'ffmpeg*'),
        ]:
            matches = glob.glob(pattern)
            for m in matches:
                if os.path.isfile(m) and os.access(m, os.X_OK):
                    return m

    # 2. imageio_ffmpeg (Entwicklung + Bundle)
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except (ImportError, Exception):
        pass

    # 3. System PATH
    system_ffmpeg = shutil.which('ffmpeg')
    if system_ffmpeg:
        return system_ffmpeg

    # Fallback: hoffen dass es im PATH ist
    return 'ffmpeg'


@lru_cache(maxsize=8)
def ffmpeg_major_version(ffmpeg: str) -> int | None:
    """Major version of the ffmpeg at `ffmpeg` ("ffmpeg version 7.0.2-
    static", "… n9.0.2-17-g…", "… 6.1.1-3ubuntu5"); None for a git
    snapshot ("N-117231-g…") or an ffmpeg that doesn't run."""
    try:
        out = subprocess.run([ffmpeg, "-version"], capture_output=True,
                             text=True, timeout=15, check=False,
                             **get_subprocess_kwargs()).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"ffmpeg version n?(\d+)\.", out or "")
    return int(m.group(1)) if m else None


@lru_cache(maxsize=8)
def knows_alpha_mode(ffmpeg: str) -> bool:
    """Does the ffmpeg at `ffmpeg` know frames' alpha modes (straight /
    premultiplied, the -alpha_mode option: ffmpeg 9 does, 7 doesn't)?"""
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-h", "full"],
                             capture_output=True, text=True, timeout=30,
                             check=False, **get_subprocess_kwargs()).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "\n  -alpha_mode " in (out or "")


# Linux caps one argv string at 128 KiB: a longer filter graph goes to
# ffmpeg in a file.
FILTER_GRAPH_ARG_MAX = 100_000


def filter_complex_args(graph: str, work_dir=None):
    """(ffmpeg arguments that give it the filter graph `graph`, path of a
    file to delete once ffmpeg is done or None). Inline up to
    FILTER_GRAPH_ARG_MAX characters; longer, from a file, with the option
    this ffmpeg has: -/filter_complex FILE from ffmpeg 7.0 on (ffmpeg 9
    has no -filter_complex_script any more), -filter_complex_script FILE
    before 7.0."""
    if len(graph) <= FILTER_GRAPH_ARG_MAX:
        return ["-filter_complex", graph], None
    fd, path = tempfile.mkstemp(suffix=".ffgraph", text=True,
                                dir=str(work_dir) if work_dir else None)
    with os.fdopen(fd, "w") as fh:
        fh.write(graph)
    major = ffmpeg_major_version(get_ffmpeg_path())
    if major is not None and major < 7:
        return ["-filter_complex_script", path], path
    return ["-/filter_complex", path], path


# ── The colour every video encode writes ──────────────────────────────
# H.264 as players expect it: 8-bit 4:2:0, limited ("tv") range, BT.709
# matrix, and tagged so (range, matrix, primaries, transfer) - the
# pixels converted, not only the tags. Every encode of the web backend,
# the plugins and the desktop app ends in BT709_TV_ARGS with a filter of
# this section. Measured on ffmpeg 7.0.2 and 9.0.2 (imageio-ffmpeg 0.7 /
# 0.8): ffmpeg 9 no longer turns a full-range source (yuvj420p, colour
# range pc: Android phones, messenger re-encodes) into limited range for
# -pix_fmt yuv420p or format=yuv420p - the live export of docs/raw.mp4
# had Y p1/p99 0/255 where ffmpeg 7's had 16/235: crushed blacks and
# clipped highlights in a player that ignores the range flag - and it
# ignores -color_primaries / -color_trc for frames that carry none (the
# exports lost both tags).

# The tags on the frames: both versions encode a frame's tags, ffmpeg 9
# only those for primaries and transfer.
BT709_TV_TAGS = ("setparams=range=tv:colorspace=bt709"
                 ":color_primaries=bt709:color_trc=bt709")

# The encoder's side of it (ffmpeg 7 takes these as the stream's tags,
# ffmpeg 9 makes a frame that differs in range or matrix agree first).
BT709_TV_ARGS = ["-pix_fmt", "yuv420p", "-color_range", "tv",
                 "-colorspace", "bt709", "-color_primaries", "bt709",
                 "-color_trc", "bt709"]

# Any frame to limited-range BT.709 yuv420p without probing: RGB
# (MoviePy's frames, an RGB upload: to_bt709_tv), or a file not probed.
# A YUV frame is read with its own tags, an untagged one as BT.601
# (swscale's default); RGB is converted with BT.709. A limited BT.709
# frame passes bit-exact on both versions. The flags: without them the
# matrix conversion came out 1-2 levels dark (mean RGB -1.9/-0.9/-2.0 on
# docs/raw.mp4, both versions), with them within 0.25 of exact; RGB in,
# mean RGB error 0.52 (0.57 without).
_ACCURATE = "accurate_rnd+full_chroma_int+full_chroma_inp"
TO_BT709_TV = (f"scale=out_color_matrix=bt709:out_range=tv:flags={_ACCURATE},"
               f"format=yuv420p,{BT709_TV_TAGS}")

# vf_colorspace's name for an input matrix (iall); its "fast" mode
# converts the matrix and range only (no gamut), as swscale does.
_COLORSPACE_IALL = {"bt709": "bt709", "bt601": "bt601-6-625",
                    "smpte240m": "smpte240m", "bt2020": "bt2020"}
_TAG_MATRIX = {"bt709": "bt709", "bt470bg": "bt601", "smpte170m": "bt601",
               "bt601": "bt601", "fcc": "bt601", "smpte240m": "smpte240m",
               "bt2020nc": "bt2020", "bt2020_ncl": "bt2020",
               "bt2020c": "bt2020", "bt2020_cl": "bt2020"}
# Pixel formats that aren't Y'CbCr (names as ffprobe gives them, every
# one ffmpeg 7 and 9 know): RGB in any order and depth, gray (+ alpha),
# a palette, monochrome, Bayer, XYZ. Every other one is Y'CbCr (yuv*,
# nv*, p010, uyvy422, yuyv422, y210, ...).
_NOT_YCBCR = ("rgb", "bgr", "argb", "abgr", "0rgb", "0bgr", "gbr", "x2rgb",
              "x2bgr", "gray", "ya", "pal", "mono", "bayer", "xyz")


# The matrix of an untagged file of our own (a mezz, proxy, render or
# clip read again): every untagged one we ever wrote is BT.601 - OpenCV
# writes it so (SmartCam's reframe), MoviePy did (v1 exports, before
# they were tagged), and what was made from them kept it. Every other
# encode tags its own.
OWN_UNTAGGED = "bt601"


def untagged_matrix(width: int, height: int) -> str:
    """The matrix a player reads an untagged video with: BT.601 up to SD
    (720x576 either way), BT.709 above - Android's guess, and WebKit's
    (measured: untagged 1280x720 and 720x1280 shown as BT.709, 640x480
    as BT.601). It keeps an untagged HD upload's colours as ffmpeg 7 did
    (values kept, tagged BT.709); ffmpeg and Chromium read every
    untagged video as BT.601, so no single guess fits every player."""
    sd = (width <= 720 and height <= 576) or (height <= 720 and width <= 576)
    return "bt601" if sd else "bt709"


def source_colors(path) -> dict | None:
    """{pix_fmt, color_range, color_space, color_transfer, width, height}
    of the first video stream (to_bt709_tv's input), or None when
    ffprobe can't tell."""
    import json
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", ("stream=pix_fmt,color_range,color_space,"
                               "color_transfer,width,height"),
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
            **get_subprocess_kwargs())
        st = (json.loads(r.stdout or "{}").get("streams") or [None])[0]
        if not st or not st.get("pix_fmt"):
            return None
        return {"pix_fmt": st["pix_fmt"],
                "color_range": st.get("color_range") or "",
                "color_space": st.get("color_space") or "",
                "color_transfer": st.get("color_transfer") or "",
                "width": int(st.get("width") or 0),
                "height": int(st.get("height") or 0)}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        return None


# PQ (Dolby Vision, HDR10) and HLG: HDR transfers.
HDR_TRANSFERS = ("smpte2084", "arib-std-b67")


def outside_encode(path) -> tuple[str, list[str]]:
    """(filter, encoder arguments) of an encode that reads a file from
    outside - the plugin's media, the desktop app's input: limited-range
    BT.709 (to_bt709_tv, an untagged file read as a player reads it). An
    HDR file isn't tone-mapped by these encodes (the web normalize does
    that first): it stays yuv420p with its own tags, as before."""
    colors = source_colors(path)
    if colors and colors.get("color_transfer") in HDR_TRANSFERS:
        return "null", ["-pix_fmt", "yuv420p"]
    return to_bt709_tv(colors), list(BT709_TV_ARGS)


def to_bt709_tv(colors: dict | None, untagged: str | None = None) -> str:
    """The filter chain that turns a video with these properties
    (source_colors) into limited-range BT.709 yuv420p, tagged so. An
    untagged video's matrix: `untagged` when the caller knows it (one
    of our own files: OWN_UNTAGGED), else - a file from outside: an
    upload, the desktop app's input - as a player reads it
    (untagged_matrix).
    Already limited BT.709: no conversion at all. Else vf_colorspace
    (fast: matrix and range only) with the input named explicitly: the
    same pixels on both versions. swscale's range conversion on ffmpeg 9
    puts the chroma half a level high (coded U/V means against the exact
    conversion, 2 s of docs/raw.mp4 at crf 16: +0.49/+0.33; vf_colorspace
    on 7 and 9, and swscale on 7: -0.04/+0.15, x264's own). Not probed
    (None), not Y'CbCr or a matrix it doesn't take: TO_BT709_TV."""
    if not colors:
        return TO_BT709_TV
    pix_fmt = str(colors.get("pix_fmt") or "")
    if not pix_fmt or pix_fmt.startswith(_NOT_YCBCR):
        # RGB (QuickTime Animation, PNG, rawvideo, UtVideo), gray, a
        # palette: no Y'CbCr matrix to keep, whatever its tags or size.
        # format=yuv420p alone converted RGB with BT.601 under the BT.709
        # tags (measured: up to 26 RGB levels off, on 7 and 9).
        return TO_BT709_TV
    full = pix_fmt.startswith("yuvj") or colors.get("color_range") == "pc"
    tag = str(colors.get("color_space") or "").lower()
    if tag in ("", "unknown", "reserved"):
        matrix = untagged or untagged_matrix(int(colors.get("width") or 0),
                                             int(colors.get("height") or 0))
    else:
        matrix = _TAG_MATRIX.get(tag, "")
    if matrix == "bt709" and not full:
        return f"format=yuv420p,{BT709_TV_TAGS}"
    iall = _COLORSPACE_IALL.get(matrix)
    if iall is None:
        return TO_BT709_TV
    # 4:2:0 in, as vf_colorspace keeps the subsampling (yuvj stays full:
    # the explicit irange below names its range)
    return ("format=yuv420p|yuvj420p|yuv420p10le,"
            f"colorspace=iall={iall}:irange={'pc' if full else 'tv'}"
            ":all=bt709:range=tv:fast=1:format=yuv420p,"
            f"{BT709_TV_TAGS}")


def ensure_ffmpeg_in_path():
    """Fuegt das ffmpeg-Verzeichnis zum PATH hinzu, damit auch
    Drittbibliotheken (z.B. whisper) ffmpeg finden koennen."""
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path and ffmpeg_path != 'ffmpeg':
        ffmpeg_dir = str(Path(ffmpeg_path).parent)
        if ffmpeg_dir not in os.environ.get('PATH', ''):
            os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')


@lru_cache(maxsize=1)
def get_ffprobe_path() -> str:
    """Gibt den Pfad zu ffprobe zurueck."""
    bundle_dir = _get_bundle_dir()

    ffprobe_name = 'ffprobe.exe' if _IS_WINDOWS else 'ffprobe'

    # 1. Nuitka Bundle: ffprobe neben der Binary or in imageio_ffmpeg/binaries/
    if _is_bundled():
        bundled_ffprobe = bundle_dir / ffprobe_name
        if bundled_ffprobe.is_file():
            return str(bundled_ffprobe)
        # Search in imageio_ffmpeg/binaries/ (same as ffmpeg)
        import glob
        for pattern in [
            str(bundle_dir / 'imageio_ffmpeg' / 'binaries' / 'ffprobe*'),
            str(bundle_dir / 'ffprobe*'),
        ]:
            matches = glob.glob(pattern)
            for m in matches:
                if os.path.isfile(m) and os.access(m, os.X_OK):
                    return m

    # 2. Derive from ffmpeg path (ffprobe is usually next to ffmpeg)
    ffmpeg = get_ffmpeg_path()
    if ffmpeg and ffmpeg != 'ffmpeg':
        ffprobe_next = Path(ffmpeg).parent / ffprobe_name
        if ffprobe_next.is_file():
            return str(ffprobe_next)

    # 3. ffprobe neben dem Projektverzeichnis (Entwicklung)
    dev_ffprobe = bundle_dir / 'bin' / ffprobe_name
    if dev_ffprobe.is_file():
        return str(dev_ffprobe)

    # 4. System PATH
    system_ffprobe = shutil.which('ffprobe')
    if system_ffprobe:
        return system_ffprobe

    # Fallback: hoffen dass es im PATH ist
    return ffprobe_name
