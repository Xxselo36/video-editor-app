"""Every video encode writes limited-range BT.709, tagged so
(src/ffmpeg_utils.py), whichever ffmpeg renders (imageio-ffmpeg 0.7
bundles ffmpeg 7, 0.8 ffmpeg 9).

ffmpeg 9 no longer turns a full-range source (yuvj420p, colour range pc:
Android phones, messenger re-encodes) into limited range for -pix_fmt
yuv420p or format=yuv420p, and ignores -color_primaries / -color_trc
for frames that carry none: the live export of docs/raw.mp4 came out
full range (Y p1/p99 0/255 where ffmpeg 7's had 16/235) with only its
matrix tagged - crushed blacks and clipped highlights in a player that
ignores the range flag.

The sources are made here (no binary media in git): a luma ramp over
every level of the range plus four colour patches, x264 lossless, the
range and colour tags set in the bitstream only (h264_metadata), so the
coded values are exactly those written.

- A full-range source through every encode (normalize + proxy, the
  SmartCam proxy, v2's select and per-clip paths, the v1 burn, effects,
  extra format, hook clip, edit preview, centre crop): yuv420p, limited
  range, BT.709 tags, and the pixels converted (Y = 16 + Y_full * 219 /
  255 at p1 and p99), not just the tag.
- A limited BT.709 source keeps its levels: Y range and patch colours
  as they came in (the v1 burn used to write them as untagged BT.601).
- Which matrix an untagged upload is read with (untagged_matrix).
- An RGB upload (QuickTime Animation, HD, untagged) is converted with
  BT.709 by the normalize, the desktop app and the plugin.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from backend import captions_v2 as C
from backend import pipeline
from src import ffmpeg_utils as fu

FF = pipeline.get_ffmpeg_path()
W, H, FPS, SECONDS = 360, 640, 30, 3.0
RAMP_H = 448            # rows 0..447: the luma ramp; below: the patches
# (R, G, B) of the patches: red, green, blue, a skin tone
PATCH_RGB = [(220, 40, 40), (40, 200, 60), (40, 60, 220), (224, 160, 112)]
SPEC = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
        "language": "en", "words": [], "fonts": []}
TAGS = {"pix_fmt": "yuv420p", "color_range": "tv", "color_space": "bt709",
        "color_primaries": "bt709", "color_transfer": "bt709"}


def _ycbcr(rgb, kr, kb, full):
    r, g, b = (c / 255.0 for c in rgb)
    y = kr * r + (1 - kr - kb) * g + kb * b
    cb, cr = (b - y) / (2 * (1 - kb)), (r - y) / (2 * (1 - kr))
    if full:
        return round(255 * y), round(128 + 255 * cb), round(128 + 255 * cr)
    return round(16 + 219 * y), round(128 + 224 * cb), round(128 + 224 * cr)


def _source(path: Path, *, full: bool) -> Path:
    """`full`: full range, matrix untagged (docs/raw.mp4's tags), the
    patches in BT.601; else limited BT.709, tagged so. Coded values
    exactly as written (x264 lossless, tags set in the bitstream)."""
    lo, hi = (0, 255) if full else (16, 235)
    Y = np.empty((H, W), np.uint8)
    U = np.full((H // 2, W // 2), 128, np.uint8)
    V = np.full((H // 2, W // 2), 128, np.uint8)
    Y[:RAMP_H] = np.round(lo + (hi - lo) * np.arange(W) / (W - 1)).astype(np.uint8)
    kr, kb = (0.299, 0.114) if full else (0.2126, 0.0722)
    pw = W // len(PATCH_RGB)
    for k, rgb in enumerate(PATCH_RGB):
        y, cb, cr = _ycbcr(rgb, kr, kb, full)
        Y[RAMP_H:, k * pw:(k + 1) * pw] = y
        U[RAMP_H // 2:, k * pw // 2:(k + 1) * pw // 2] = cb
        V[RAMP_H // 2:, k * pw // 2:(k + 1) * pw // 2] = cr
    frame = Y.tobytes() + U.tobytes() + V.tobytes()
    vui = ("video_full_range_flag=1" if full else
           "video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1"
           ":matrix_coefficients=1")
    subprocess.run([FF, "-y", "-v", "error",
                    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{W}x{H}",
                    "-r", str(FPS), "-i", "-",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={SECONDS}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-g", "30",
                    "-bsf:v", f"h264_metadata={vui}",
                    "-c:a", "aac", "-shortest", str(path)],
                   input=frame * round(SECONDS * FPS), check=True)
    return path


def _tags(path: Path) -> dict:
    r = subprocess.run([pipeline.get_ffprobe_path(), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=" + ",".join(TAGS), "-of", "json", str(path)],
                       capture_output=True, text=True, check=True)
    st = json.loads(r.stdout)["streams"][0]
    return {k: st.get(k, "unknown") for k in TAGS}


def _plane(path: Path, name: str, frames: int = 4) -> np.ndarray:
    """The coded values of plane y / u / v of the first `frames` frames
    (extractplanes: no conversion, ffmpeg 7 and 9 alike)."""
    raw = subprocess.run([FF, "-v", "error", "-i", str(path), "-map", "0:v:0",
                          "-frames:v", str(frames), "-vf", f"extractplanes={name}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    w, h = _size(path)
    if name != "y":
        w, h = w // 2, h // 2
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w)


def _size(path: Path) -> tuple[int, int]:
    r = subprocess.run([pipeline.get_ffprobe_path(), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
                        str(path)], capture_output=True, text=True, check=True)
    w, h = r.stdout.strip().split("x")[:2]
    return int(w), int(h)


def _ramp_y(path: Path) -> tuple[float, float]:
    """Y p1 / p99 of the ramp (the frame's top 70 %)."""
    y = _plane(path, "y")
    y = y[:, :int(y.shape[1] * 0.7)]
    return float(np.percentile(y, 1)), float(np.percentile(y, 99))


# Each source checked where it is made: what the tests take it for.
@pytest.fixture(scope="module")
def full(tmp_path_factory):
    path = _source(tmp_path_factory.mktemp("range") / "full.mp4", full=True)
    assert _tags(path)["color_range"] == "pc"
    assert _tags(path)["color_space"] == "unknown"
    assert _ramp_y(path) == (2.0, 253.0)
    return path


@pytest.fixture(scope="module")
def limited(tmp_path_factory):
    path = _source(tmp_path_factory.mktemp("range") / "limited709.mp4", full=False)
    assert _tags(path) == TAGS
    assert _ramp_y(path) == (18.0, 233.0)
    return path


# The bars sources: PATCH_RGB side by side, full height, 2 s. HD, so an
# untagged Y'CbCr video this size is read as BT.709 (untagged_matrix).
BARS_W, BARS_H = 1280, 720
# The bars as limited-range BT.709 Y'CbCr: what every encode should write
BARS_709 = [_ycbcr(rgb, 0.2126, 0.0722, False) for rgb in PATCH_RGB]


def _bars_rgb() -> bytes:
    row = np.repeat(np.array(PATCH_RGB, np.uint8), BARS_W // len(PATCH_RGB), axis=0)
    return np.ascontiguousarray(np.broadcast_to(row, (BARS_H, BARS_W, 3))).tobytes()


@pytest.fixture(scope="module")
def rgb(tmp_path_factory):
    """An RGB upload: QuickTime Animation (qtrle, rgb24: screen
    recordings, motion graphics; PNG, rawvideo and UtVideo are RGB too),
    lossless, no colour tags."""
    path = tmp_path_factory.mktemp("range") / "rgb.mov"
    subprocess.run([FF, "-y", "-v", "error",
                    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{BARS_W}x{BARS_H}",
                    "-r", str(FPS), "-i", "-",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-vf", f"loop=loop={2 * FPS - 1}:size=1", "-c:v", "qtrle",
                    "-c:a", "aac", "-shortest", str(path)],
                   input=_bars_rgb(), check=True)
    colors = fu.source_colors(path)
    assert colors["pix_fmt"] == "rgb24"
    assert colors["color_space"] in ("", "unknown") and colors["color_range"] in ("", "unknown")
    return path


def _assert_limited_bt709(out: Path, src_p1: float, src_p99: float) -> None:
    assert _tags(out) == TAGS, out.name
    p1, p99 = _ramp_y(out)
    # converted, not re-tagged: full Y -> 16 + Y * 219 / 255
    assert p1 == pytest.approx(16 + src_p1 * 219 / 255, abs=1.5), (out.name, p1)
    assert p99 == pytest.approx(16 + src_p99 * 219 / 255, abs=1.5), (out.name, p99)


SEGS = [(0.4, 1.4), (1.8, 2.8)]               # in order: v2's select path
SEGS_PC = [(1.8, 2.8), (0.4, 1.4)]            # out of order: per-clip path


def _render(kind: str, src: Path, d: Path) -> list[Path]:
    """The files encode path `kind` writes from `src` (as its input)."""
    if kind == "normalize":
        mezz, proxy = d / "normalized.mp4", d / pipeline.PROXY_NAME
        assert pipeline._normalize_orientation(str(src), str(mezz), proxy_path=str(proxy),
                                               cfr_rate="30")
        return [mezz, proxy]
    if kind == "normalize_plain":
        mezz = d / "normalized.mp4"
        pipeline._normalize_orientation(str(src), str(mezz))
        return [mezz]
    if kind == "proxy":                      # SmartCam's / the fallback proxy
        proxy = d / pipeline.PROXY_NAME
        assert pipeline._make_proxy(str(src), str(proxy))
        return [proxy]
    if kind in ("v2_select", "v2_per_clip"):
        out = d / "v2.mp4"
        segs = SEGS if kind == "v2_select" else SEGS_PC
        info = C.render_primary(str(src), str(out), segs, None, SPEC, d / "w")
        assert info["path"] == ("select" if kind == "v2_select" else "segments")
        return [out]
    if kind == "v1":
        pytest.importorskip("moviepy")
        files = pipeline.render_to_dir(str(src), str(d / "v1"), SEGS, [], [], "clipper",
                                       "tight", "en", [], [], parallelism=2)
        return [Path(files["primary"])]
    if kind == "effects":
        out = d / "fx.mp4"
        pipeline._apply_segment_effects(str(src), str(out), [(0.0, 1.5), (1.5, 3.0)],
                                        [{"volume": 0.5}, {}])
        return [out]
    if kind == "format":
        out = d / "1x1.mp4"
        pipeline._export_format(str(src), str(out), 360, 360)
        return [out]
    if kind == "hook":
        out = d / "hook.mp4"
        pipeline._extract_hook_clip(str(src), str(out), 0.5, 2.5)
        return [out]
    if kind == "preview":
        out = d / "preview.mp4"
        pipeline._ffmpeg_cuts_preview(str(src), SEGS, str(out))
        return [out]
    if kind == "centre_crop":
        out = d / "crop.mp4"
        assert pipeline.centre_crop(str(src), str(out), "portrait")
        return [out]
    if kind == "desktop":                    # the desktop app's fast editor
        from src.fast_editor import FastVideoEditor
        editor = FastVideoEditor(str(src), output_dir=str(d / "desktop"))
        return [Path(editor.edit_fast(remove_silence=False, add_subtitles=False))]
    if kind == "plugin":                     # the Premiere plugin's caption burn
        from plugins.premiere import video_editor_premiere as vep
        srt, out = d / "captions.srt", d / "burn.mp4"
        srt.write_text("1\n00:00:01,000 --> 00:00:01,500\nHi\n\n")
        assert vep._burn_subtitles_into_video(str(src), str(srt), str(out), "classic")
        return [out]
    raise AssertionError(kind)


PATHS = ["normalize", "normalize_plain", "proxy", "v2_select", "v2_per_clip", "v1",
         "effects", "format", "hook", "preview", "centre_crop"]


@pytest.mark.parametrize("kind", PATHS)
def test_a_full_range_source_comes_out_limited_bt709(full, tmp_path, kind):
    src_p1, src_p99 = _ramp_y(full)
    for out in _render(kind, full, tmp_path):
        if kind == "format":                 # the bars: limited black
            assert _tags(out) == TAGS
            y = _plane(out, "y")
            assert int(y[:, :, :8].max()) <= 17 and int(y[:, :, :8].min()) >= 15
            continue
        _assert_limited_bt709(out, src_p1, src_p99)


def _patch_means(path: Path) -> list[tuple[float, float, float]]:
    """Mean Y, U, V of the middle of each patch (bottom 30 %)."""
    w, h = _size(path)
    ys, us, vs = _plane(path, "y"), _plane(path, "u"), _plane(path, "v")
    top = int(h * (RAMP_H + (H - RAMP_H) // 4) / H)
    bot = int(h * (H - (H - RAMP_H) // 4) / H)
    out = []
    pw = w / len(PATCH_RGB)
    for k in range(len(PATCH_RGB)):
        x0, x1 = int(k * pw + pw / 4), int((k + 1) * pw - pw / 4)
        out.append((float(ys[:, top:bot, x0:x1].mean()),
                    float(us[:, top // 2:bot // 2, x0 // 2:x1 // 2].mean()),
                    float(vs[:, top // 2:bot // 2, x0 // 2:x1 // 2].mean())))
    return out


@pytest.mark.parametrize("kind", ["normalize", "v2_select", "v2_per_clip", "v1", "preview"])
def test_a_limited_bt709_source_keeps_its_levels(limited, tmp_path, kind):
    """No range or matrix change for the usual phone video (an iPhone's):
    the ramp's ends and the patches' Y / Cb / Cr as they came in. (The v1
    burn wrote MoviePy's RGB as untagged BT.601: the red patch's Cr came
    out 18 levels off.)"""
    want_y = _ramp_y(limited)
    want = _patch_means(limited)
    for out in _render(kind, limited, tmp_path):
        assert _tags(out) == TAGS, out.name
        p1, p99 = _ramp_y(out)
        assert abs(p1 - want_y[0]) <= 1 and abs(p99 - want_y[1]) <= 1, (out.name, p1, p99)
        got = _patch_means(out)
        worst = max(abs(a - b) for g, w in zip(got, want) for a, b in zip(g, w))
        assert worst <= 1.5, (out.name, got, want)


def _bar_means(path: Path) -> list[tuple[float, float, float]]:
    """Mean Y, U, V of the middle of each bar (the bars sources)."""
    w, h = _size(path)
    ys, us, vs = _plane(path, "y"), _plane(path, "u"), _plane(path, "v")
    pw = w / len(PATCH_RGB)
    out = []
    for k in range(len(PATCH_RGB)):
        x0, x1 = int(k * pw + pw / 4), int((k + 1) * pw - pw / 4)
        out.append((float(ys[:, h // 4:3 * h // 4, x0:x1].mean()),
                    float(us[:, h // 8:3 * h // 8, x0 // 2:x1 // 2].mean()),
                    float(vs[:, h // 8:3 * h // 8, x0 // 2:x1 // 2].mean())))
    return out


def _off(got, want) -> float:
    return max(abs(a - b) for g, w in zip(got, want) for a, b in zip(g, w))


@pytest.mark.parametrize("kind", ["normalize", "desktop", "plugin"])
def test_an_rgb_upload_is_converted_with_bt709(rgb, tmp_path, kind):
    """An RGB upload has no matrix to keep: converted with BT.709, as it
    is tagged - by the web normalize (+ proxy) and by
    src/ffmpeg_utils.outside_encode (the desktop app, the plugin). Taken
    for an untagged HD video and passed through (format=yuv420p), it was
    converted with BT.601 under the BT.709 tags: the bars' Y'CbCr up to
    17 levels off (the green's Y 133 for 150), on ffmpeg 7 and 9."""
    for out in _render(kind, rgb, tmp_path):
        assert _tags(out) == TAGS, out.name
        got = _bar_means(out)
        assert _off(got, BARS_709) <= 1.5, (out.name, got, BARS_709)


def test_untagged_uploads_are_read_as_players_read_them():
    """Above SD an untagged video counts as BT.709 (WebKit, Android): its
    values kept, as ffmpeg 7 kept them; up to SD (720x576 either way) as
    BT.601, converted."""
    assert fu.untagged_matrix(720, 1280) == "bt709"
    assert fu.untagged_matrix(1920, 1080) == "bt709"
    assert fu.untagged_matrix(640, 480) == "bt601"
    assert fu.untagged_matrix(576, 720) == "bt601"
    assert fu.untagged_matrix(854, 480) == "bt709"
    hd = {"pix_fmt": "yuvj420p", "color_range": "pc", "color_space": "",
          "width": 720, "height": 1280}
    assert "iall=bt709:irange=pc" in fu.to_bt709_tv(hd)
    assert "iall=bt601-6-625:irange=pc" in fu.to_bt709_tv({**hd, "width": 640,
                                                            "height": 480})
    # our own untagged files (MoviePy's, OpenCV's) are BT.601
    assert "iall=bt601-6-625" in fu.to_bt709_tv(hd, untagged="bt601")
    tagged601 = {**hd, "color_space": "bt470bg"}
    assert "iall=bt601-6-625:irange=pc" in fu.to_bt709_tv(tagged601)
    # limited BT.709 already: nothing converted, only the tags
    assert fu.to_bt709_tv({"pix_fmt": "yuv420p", "color_range": "tv",
                           "color_space": "bt709"}) == f"format=yuv420p,{fu.BT709_TV_TAGS}"
    assert fu.to_bt709_tv(None) == fu.TO_BT709_TV


def test_only_ycbcr_is_read_by_its_matrix():
    """Y'CbCr, planar or packed, is read by its matrix (its tag, else
    untagged_matrix: an untagged HD one passes as it is). RGB, gray, a
    palette, Bayer and XYZ have none, whatever their tags say: swscale
    converts them, RGB with BT.709 (TO_BT709_TV). Every pixel format
    ffprobe describes, by its descriptor."""
    r = subprocess.run([pipeline.get_ffprobe_path(), "-v", "error", "-show_pixel_formats",
                        "-of", "json"], capture_output=True, text=True, check=True)
    formats = [f for f in json.loads(r.stdout)["pixel_formats"] if not f["flags"]["hwaccel"]]
    assert len(formats) > 150
    for f in formats:
        ycbcr = (not f["flags"]["rgb"] and not f["flags"]["palette"]
                 and f["nb_components"] >= 3 and not f["name"].startswith("xyz"))
        for space in ("", "bt709"):          # untagged HD, or tagged BT.709
            conv = fu.to_bt709_tv({"pix_fmt": f["name"], "color_range": "tv",
                                   "color_space": space, "width": 1280, "height": 720})
            assert (conv != fu.TO_BT709_TV) == ycbcr, (f["name"], space, conv)


def test_the_v2_graph_converts_the_probed_mezz():
    """v2 converts the mezz by its probed colours (probe() gives the
    render's src them): right after the select, or after each clip's
    trim - before its fades, which end on limited black. An untagged
    mezz (SmartCam's: OpenCV writes BT.601) is read as BT.601."""
    colors = {"pix_fmt": "yuvj420p", "color_range": "pc", "color_space": "bt709",
              "width": 720, "height": 1280}
    src = {"W": 720, "H": 1280, "rate": "30", "fps": 30.0, "cfr": True,
           "audio": False, "start": 0.0, "colors": colors}
    conv = fu.to_bt709_tv(colors, untagged="bt601")
    assert "colorspace=iall=bt709:irange=pc" in conv
    clips = C.clip_plan([(0.0, 1.0), (2.0, 3.0)], None, 30.0)
    _inputs, graph, _audio = C.build_graph(clips, src, layer=None)
    assert f"setpts=N*1/30/TB,{conv}[vcat]" in graph
    clips = C.clip_plan([(2.0, 3.0), (0.0, 1.0)], [{"fadeIn": 0.3}, {}], 30.0)
    _inputs, graph, _audio = C.build_graph(clips, src, layer=None)
    assert graph.count(f"setpts=PTS-STARTPTS,{conv},fps=30/1,") == 2
    assert graph.index(conv) < graph.index("fade=t=in")
    untagged = {**colors, "pix_fmt": "yuv420p", "color_range": "", "color_space": ""}
    _inputs, graph, _audio = C.build_graph(clips, {**src, "colors": untagged}, layer=None)
    assert "colorspace=iall=bt601-6-625:irange=tv" in graph
    limited = {**colors, "pix_fmt": "yuv420p", "color_range": "tv"}
    _inputs, graph, _audio = C.build_graph(clips, {**src, "colors": limited}, layer=None)
    assert "colorspace=iall" not in graph and fu.BT709_TV_TAGS in graph
    assert C.probe.__doc__ and "colors" in C.probe.__doc__
