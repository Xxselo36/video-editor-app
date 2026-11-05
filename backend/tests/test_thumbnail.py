"""The export's thumbnail (thumb.jpg): the Projekte tile, the editor's
done view and the Vorschau's finished frame show it, and on iOS Safari
that frame shows nothing else before a tap. It is a baseline JPEG with
4:2:0 chroma — the export thumbnails were 4:4:4 with 1x2 sampling on
every component (ffmpeg's mjpeg given the RGB candidate frame), the
poster that shows on the owner's iPhone is 4:2:0 — at most 540 px wide
and never upscaled, of the best-scoring candidate frame, in the video's
colours; when that step leaves no JPEG the simple grab makes one. GET
/jobs/{id}/thumbnail of an export stored without a thumbnail answers the
analysis' poster; one with a thumbnail, its thumbnail.

Real ffmpeg (the pipeline's, get_ffmpeg_path) on small lavfi clips. Run
from the repo root:
    python -m pytest backend/tests/test_thumbnail.py -q
"""
from __future__ import annotations

import re
import struct
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from PIL import Image, ImageStat

from backend import media, pipeline, storage
from backend.jobs import store

FF = pipeline.get_ffmpeg_path()
# The 4:2:0 layout: luma 2x2, both chroma components 1x1.
YUV420 = [(1, 2, 2), (2, 1, 1), (3, 1, 1)]
SECONDS = 6.0
# The window in which the clip shows a picture (black before and after):
# it holds the 4th of the 8 candidates (0.900, 1.414, 1.929, 2.443, …,
# 4.500 s for 6 s), and not the simple grab's 1 s.
SHOWN = (2.3, 2.6)


def _clip(path: Path, size: str, seconds: float = SECONDS,
          pix_fmt: str = "yuv420p") -> Path:
    """H.264 (1 s GOP) of `size`: black, testsrc2 in SHOWN."""
    a, b = SHOWN
    video = (f"color=c=black:s={size}:r=30:d={seconds}[bg];"
             f"testsrc2=s={size}:r=30:d={seconds}[fg];"
             f"[bg][fg]overlay=enable='between(t,{a},{b})'")
    subprocess.run([FF, "-y", "-v", "error", "-f", "lavfi", "-i", video,
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
                    "-pix_fmt", pix_fmt, str(path)], check=True)
    return path


def sof(path: Path) -> tuple[int, int, int, list[tuple[int, int, int, int]]]:
    """A JPEG's frame header: (marker, width, height, [(component id, H,
    V, Tq)]) of its SOF0 (0xFFC0, baseline) or SOF2 (0xFFC2,
    progressive) segment."""
    data = Path(path).read_bytes()
    assert data[:2] == b"\xff\xd8", "not a JPEG (no SOI)"
    i = 2
    while i + 4 <= len(data):
        assert data[i] == 0xFF, f"no marker at byte {i}"
        marker = data[i + 1]
        if marker == 0xFF:      # fill byte
            i += 1
            continue
        (length,) = struct.unpack(">H", data[i + 2:i + 4])
        if marker in (0xC0, 0xC2):
            seg = data[i + 4:i + 2 + length]
            _precision, height, width, nf = struct.unpack(">BHHB", seg[:6])
            comps = []
            for k in range(nf):
                cid, hv, tq = seg[6 + 3 * k:9 + 3 * k]
                comps.append((cid, hv >> 4, hv & 0x0F, tq))
            return 0xFF00 | marker, width, height, comps
        if marker == 0xDA:      # a scan before any frame header
            break
        i += 2 + length
    raise AssertionError("no SOF0/SOF2 frame header")


def _assert_thumb(path: Path, size: tuple[int, int]) -> float:
    """Baseline 4:2:0 JPEG of `size`; returns its mean luma (0-255)."""
    marker, w, h, comps = sof(path)
    assert marker == 0xFFC0, hex(marker)
    assert [(c, hs, vs) for c, hs, vs, _tq in comps] == YUV420, comps
    assert (w, h) == size
    with Image.open(path) as im:
        assert im.size == size
        return ImageStat.Stat(im.convert("L")).mean[0]


# ── the JPEG ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("src,pix_fmt,size", [
    ("1080x1920", "yuv420p", (540, 960)),   # an iPhone portrait export
    # Full-size chroma (left to choose, ffmpeg's mjpeg would keep it):
    # still 4:2:0.
    ("1080x1920", "yuv444p", (540, 960)),
    ("1920x1080", "yuv420p", (540, 304)),
    ("320x568", "yuv420p", (320, 568)),     # narrower: never upscaled
])
def test_the_thumbnail_is_a_420_jpeg_of_the_best_frame(tmp_path, capsys,
                                                       src, pix_fmt, size):
    clip = _clip(tmp_path / "primary.mp4", src, pix_fmt=pix_fmt)
    out = tmp_path / "thumb.jpg"
    pipeline._generate_thumbnail(str(clip), str(out))
    # The best-scoring candidate's frame (the one in SHOWN), taken from
    # the video at the thumbnail's size: not the black around it.
    assert _assert_thumb(out, size) > 60
    assert "[thumbnail]" not in capsys.readouterr().out
    # The simple grab (1 s) has the same layout: here a black frame.
    simple = tmp_path / "simple.jpg"
    pipeline._generate_thumbnail_simple(str(clip), str(simple))
    assert _assert_thumb(simple, size) < 5


def test_short_videos_get_the_simple_grab(tmp_path):
    """Under 3 s: the frame at 0.5 s; shorter than that, the first one
    (ffmpeg writes nothing at a time past the end, and exits 0)."""
    for seconds in (2.0, 0.4):
        clip = _clip(tmp_path / f"short{seconds}.mp4", "1080x1920", seconds)
        out = tmp_path / f"short{seconds}.jpg"
        pipeline._generate_thumbnail(str(clip), str(out))
        _assert_thumb(out, (540, 960))


@pytest.mark.parametrize("failure,code", [
    ("exit", "exit 1"),
    ("timeout", "TimeoutExpired"),
    ("no frame", "no frame"),        # exit 0, nothing written …
    ("empty", "empty"),              # … or an empty file
])
def test_a_failed_best_frame_falls_back_to_the_simple_grab(
        tmp_path, monkeypatch, capsys, failure, code):
    clip = _clip(tmp_path / "primary.mp4", "1080x1920")
    out = tmp_path / "thumb.jpg"
    # An older thumbnail at the path (a re-render into the same place):
    # never taken for the new one.
    out.write_bytes(b"older thumbnail")
    real_run = subprocess.run
    grabs = []

    def run(cmd, *args, **kwargs):
        if str(out) in cmd:          # a grab into thumb.jpg
            grabs.append(cmd)
            if len(grabs) == 1:      # the best frame's: fails
                if failure == "exit":
                    return subprocess.CompletedProcess(cmd, 1, "", "error")
                if failure == "timeout":
                    raise subprocess.TimeoutExpired(cmd, 20)
                if failure == "empty":
                    out.write_bytes(b"")
                return subprocess.CompletedProcess(cmd, 0, "", "")
        return real_run(cmd, *args, **kwargs)
    monkeypatch.setattr(pipeline.subprocess, "run", run)
    pipeline._generate_thumbnail(str(clip), str(out))
    assert len(grabs) == 2
    # The simple grab's frame (1 s: black in this clip), 4:2:0, 540 wide.
    assert _assert_thumb(out, (540, 960)) < 5
    log = capsys.readouterr().out
    assert f"[thumbnail] best frame not made ({code}), simple grab" in log
    assert str(tmp_path) not in log and "thumb.jpg" not in log


def test_no_thumbnail_leaves_no_file(tmp_path, capsys):
    """Nothing to grab (not a video): no thumb.jpg — the render stores
    none, and /thumbnail answers the poster — and one line in the log
    with a code, no path."""
    bad = tmp_path / "primary.mp4"
    bad.write_bytes(b"not a video")
    out = tmp_path / "thumb.jpg"
    out.write_bytes(b"older thumbnail")
    pipeline._generate_thumbnail(str(bad), str(out))
    assert not out.exists()
    [line] = capsys.readouterr().out.splitlines()
    # ffmpeg's exit status: 183 for "Invalid data found" (ffmpeg 6-7)
    assert re.fullmatch(r"\[thumbnail\] not made \(exit \d+\)", line), line


def _patches(path: Path) -> Path:
    """6 s of four colour patches (red, green, blue, a skin tone), as an
    export is stored: H.264 yuv420p, BT.709, limited range, tagged so."""
    graph = ("color=c=red:s=540x960:d=6:r=30[a];"
             "color=c=0x00C000:s=540x960:d=6:r=30[b];"
             "color=c=blue:s=540x960:d=6:r=30[c];"
             "color=c=0xE0A060:s=540x960:d=6:r=30[d];"
             "[a][b]hstack[ab];[c][d]hstack[cd];[ab][cd]vstack,"
             "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p")
    subprocess.run([FF, "-y", "-v", "error", "-f", "lavfi", "-i", graph,
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "1",
                    "-color_primaries", "bt709", "-color_trc", "bt709",
                    "-colorspace", "bt709", "-color_range", "tv", str(path)],
                   check=True)
    return path


def _patch_means(path: Path) -> list[tuple[int, ...]]:
    """The mean RGB of the middle of each patch, as a browser decodes the
    image (Pillow: a JPEG as JFIF, BT.601 full range)."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        out = []
        for fx, fy in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]:
            box = (int(w * fx) - w // 10, int(h * fy) - h // 10,
                   int(w * fx) + w // 10, int(h * fy) + h // 10)
            out.append(tuple(round(m) for m in ImageStat.Stat(im.crop(box)).mean))
        return out


def test_the_thumbnail_has_the_videos_colours(tmp_path):
    """A BT.709 export's thumbnail shows its colours: the done frame's
    still gives way to the video on a tap, the Projekte tile stands for
    it. (Converted straight to yuvj420p the matrix stayed BT.709 while
    every decoder reads JFIF as BT.601: green came out 35 levels off.)"""
    clip = _patches(tmp_path / "primary.mp4")
    ref = tmp_path / "ref.png"      # the video as a player shows it
    subprocess.run([FF, "-y", "-v", "error", "-ss", "3", "-i", str(clip),
                    "-frames:v", "1", "-vf",
                    "scale=in_color_matrix=bt709:in_range=tv,format=rgb24",
                    str(ref)], check=True)
    want = _patch_means(ref)
    for name, make in (("best frame", pipeline._generate_thumbnail),
                       ("simple grab", pipeline._generate_thumbnail_simple)):
        out = tmp_path / f"{name.replace(' ', '_')}.jpg"
        make(str(clip), str(out))
        _assert_thumb(out, (540, 960))
        got = _patch_means(out)
        worst = max(abs(a - b) for g, w in zip(got, want) for a, b in zip(g, w))
        assert worst <= 6, (name, got, want)


# ── GET /jobs/{id}/thumbnail ──────────────────────────────────────────

POSTER = b"\xff\xd8poster\xff\xd9"
THUMB = b"\xff\xd8thumbnail\xff\xd9"


def _export(put, *, poster: bool, exported: bool = True,
            thumb: bool = False):
    """A job after its first export, stored without a thumbnail (made
    best effort at render time) unless `thumb`; with the analysis'
    poster or without. `put(key, body)` stores an object.
    exported=False: before it."""
    job = store.create(None, {})
    p = f"jobs/{job.id}/"
    fields = {}
    if poster:
        put(p + "poster.jpg", POSTER)
        fields["poster_key"] = p + "poster.jpg"
    if exported:
        put(p + "r1/primary.mp4", b"export 1")
        thumb_key = None
        if thumb:
            thumb_key = p + "r1/thumb.jpg"
            put(thumb_key, THUMB)
        fields.update(status="done", renders_ok=1, render_gen=1,
                      output_keys={"primary": p + "r1/primary.mp4"},
                      thumb_key=thumb_key)
    else:
        put(p + "mezz.mp4", b"mezz")
        fields.update(status="awaiting_review", mezz_key=p + "mezz.mp4")
    store.update(job.id, **fields)
    return store.get(job.id)


def _thumbnail(client, job):
    # As the web asks for it (v: the export's generation).
    return client.get(f"/jobs/{job.id}/thumbnail", params={"v": 1},
                      follow_redirects=False)


def _assert_empty(r, status):
    assert (r.status_code, r.content) == (status, b"")
    assert r.headers["cache-control"] == "no-store"


def test_an_export_without_a_thumbnail_shows_the_poster(client, no_r2,
                                                        tmp_path):
    def put(key, body):
        src = tmp_path / key.replace("/", "_")
        src.write_bytes(body)
        media.put_file(src, key, content_type="image/jpeg")
    job = _export(put, poster=True)
    r = _thumbnail(client, job)
    assert (r.status_code, r.content) == (200, POSTER)
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "public, max-age=86400"
    # An export with its thumbnail gets that, never the poster (a source
    # frame without captions).
    r = _thumbnail(client, _export(put, poster=True, thumb=True))
    assert (r.status_code, r.content) == (200, THUMB)
    # Without a poster: the empty 404 as before (UX12); before the
    # export the empty 409, also with a poster (the page asks /poster).
    _assert_empty(_thumbnail(client, _export(put, poster=False)), 404)
    _assert_empty(_thumbnail(client, _export(put, poster=True,
                                             exported=False)), 409)
    # The poster's object gone: the empty 409, like a missing thumbnail.
    media.local_path(job.poster_key).unlink()
    _assert_empty(_thumbnail(client, job), 409)


def test_an_r2_export_without_a_thumbnail_redirects_to_the_poster(client, r2):
    def put(key, body):
        r2.put_object(Bucket=storage.bucket(), Key=key, Body=body)
    job = _export(put, poster=True)
    r = _thumbnail(client, job)
    assert r.status_code == 307, r.text
    assert r.headers["cache-control"] == media.REDIRECT_CACHE
    u = urlsplit(r.headers["location"])
    assert unquote(u.path) == f"/{storage.bucket()}/{job.poster_key}"
    assert parse_qs(u.query)["response-content-type"] == ["image/jpeg"]
    # An export with its thumbnail: to that, never to the poster.
    with_thumb = _export(put, poster=True, thumb=True)
    r = _thumbnail(client, with_thumb)
    assert r.status_code == 307, r.text
    location = unquote(urlsplit(r.headers["location"]).path)
    assert location == f"/{storage.bucket()}/{with_thumb.thumb_key}"
    _assert_empty(_thumbnail(client, _export(put, poster=False)), 404)
    _assert_empty(_thumbnail(client, _export(put, poster=True,
                                             exported=False)), 409)
