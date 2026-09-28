"""Web-pipeline: analyze → multi_clip_burn → concat → single MP4.

Re-uses the working Premiere-plugin code path (which already supports
voice triggers, caption presets, filler removal, etc.) and stitches the
per-segment clips into a single MP4 for the web user to download.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from src.ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path


def _ffmpeg_threads() -> int:
    """Thread cap for every ffmpeg encode/decode on the API box
    (CLEO_FFMPEG_THREADS, default 4; 0 = ffmpeg's own default).

    Without a cap x264 sizes its thread pool from the CPU count it sees
    (1.5x cores): a 1080p normalize took 0.55 GB at 4 threads but 1.8 GB
    at 64, and concurrent jobs just fight over the same cores. Read on
    every call so the Modal worker can lift it (modal_render.py)."""
    try:
        return max(0, int(os.environ.get("CLEO_FFMPEG_THREADS", "4")))
    except ValueError:
        return 4


def _threads() -> list[str]:
    """`-threads N` for one input (decoder) or output (encoder), or
    nothing when uncapped."""
    n = _ffmpeg_threads()
    return ["-threads", str(n)] if n else []

# Per-clip caption burns are only an intermediate (they get re-encoded
# by the final concat), so encode them fast. Benchmark (90 s 1080x1920,
# 12 clips): veryfast burn + veryfast/crf 20 final vs. medium + medium/
# crf 16 was 27 % faster, 39 % smaller, SSIM 0.995. The Premiere plugin
# keeps its own default ("medium") since its clips are final output.
os.environ.setdefault("CLEO_BURN_PRESET", "veryfast")
from src.plugin_api import analyze_video
from plugins.premiere.video_editor_premiere import (
    _multi_clip_burn,
    _run_smartcam_preprocess,
)


# Multi-format export targets in (width, height) at 1080p baseline.
EXPORT_FORMATS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
}


# HDR transfer functions we tone-map to SDR. iPhone Dolby Vision is
# smpte2084 (PQ); iPhone HDR Video (HLG mode) is arib-std-b67. Both must
# be tone-mapped or the 4K→1080p re-encode clips highlights to pure
# white (skin blown out, walls solid #FFFFFF, no highlight roll-off).
_HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}


def _probe_hdr(input_path: str) -> bool:
    """Return True if the input video is HDR (PQ or HLG).

    ffprobe returns the transfer characteristics; if it's a known HDR
    transfer function, we need the tonemap chain in the encode step.
    Falls back to False on any probe failure — safer to skip tonemap
    than to accidentally apply it to SDR content.
    """
    cmd = [
        get_ffprobe_path(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=color_transfer,color_primaries",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            return False
        output = result.stdout.strip().lower()
        for line in output.splitlines():
            if line.strip() in _HDR_TRANSFERS:
                return True
        return False
    except Exception:
        return False


# Filter chain that maps HDR (BT.2020 + PQ/HLG) to SDR (BT.709 + gamma).
# Uses the `hable` operator — the closest-to-Rec-709-camera-neutral
# tonemap, avoids the "grey wash" of `reinhard` and the "crushed shadows"
# of `mobius`. `npl=100` is the SDR display peak luminance in nits.
# `desat=0` keeps saturation — we want the color grade to survive the
# down-conversion, not get flattened.
_HDR_TONEMAP_CHAIN = (
    "zscale=t=linear:npl=100,"
    "tonemap=tonemap=hable:desat=0,"
    "zscale=p=bt709:t=bt709:m=bt709:r=tv"
)


def _smartcam_reframe(
    input_path: str,
    output_path: str,
    smartcam_format: str,
    resolution: str,
    progress_cb: Callable[[str, float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> str | None:
    """Face-track-reframe the source for a target aspect (portrait/landscape).

    Re-uses the premiere-plugin SmartCam preprocess (YuNet face tracking
    + rule-of-thirds composition + letterbox-crop pre-pass + VFR→CFR
    conversion). Returns `output_path` on success, None on failure (the
    caller keeps the original).

    `output_path` is job-scoped: the plugin's own default name
    (<input basename>_smartcam_<unix second>.mp4 in a shared cache dir)
    is the same for every web job ("normalized") that starts SmartCam
    in the same second, so two concurrent jobs could write — and hand
    out — each other's video.
    """
    def _sc_cb(msg: str) -> None:
        if progress_cb:
            progress_cb(msg, -1)

    return _run_smartcam_preprocess(
        video_path=input_path,
        smartcam_format=smartcam_format,
        resolution_label=resolution,
        progress_cb=_sc_cb,
        cancel_check=cancel_check,
        output_path=output_path,
        threads=_ffmpeg_threads() or None,
    )


def _extract_hook_clip(
    input_path: str,
    output_path: str,
    start: float,
    end: float,
) -> None:
    """Cut a single hook clip out of the final rendered video.

    Re-encodes (not stream-copy) so the trim lands on an exact frame,
    not the prior keyframe. Hooks tend to start mid-sentence so we
    can't rely on keyframe boundaries.
    """
    duration = max(0.5, end - start)
    cmd = [
        get_ffmpeg_path(), "-y",
        *_threads(),
        "-ss", f"{start:.3f}",
        "-i", input_path,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        *_threads(),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-500:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg hook-extract failed:\n{tail}")


def _video_size(path: str) -> tuple[int, int] | None:
    """(width, height) of the first video stream as stored, or None."""
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
             path], capture_output=True, text=True, timeout=15)
        w, h = r.stdout.strip().split("x")[:2]
        return int(w), int(h)
    except Exception:
        return None


def _export_format(
    input_path: str,
    output_path: str,
    target_w: int,
    target_h: int,
) -> None:
    """Re-encode `input_path` to (target_w, target_h) with letterbox padding.

    Preserves the speaker (no cropping content out) — adds black bars
    on the dimension that doesn't match. Fast libx264 single-pass.
    If the input already has the target size (e.g. a 9:16 export of a
    9:16 primary), it is hard-linked instead — same bytes, no second
    encode and no extra storage.
    """
    if _video_size(input_path) == (target_w, target_h):
        try:
            Path(output_path).unlink(missing_ok=True)
            os.link(input_path, output_path)
        except OSError:
            shutil.copyfile(input_path, output_path)
        return
    vf = (
        f"scale=w={target_w}:h={target_h}:force_original_aspect_ratio=decrease,"
        f"pad=w={target_w}:h={target_h}:x=(ow-iw)/2:y=(oh-ih)/2:color=black"
    )
    cmd = [
        get_ffmpeg_path(), "-y",
        *_threads(),
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        *_threads(),
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-500:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg format-export failed:\n{tail}")


def _precheck_audio(input_path: str, max_seconds: float | None = None) -> dict:
    """Quick volume / clipping / silence check via ffmpeg volumedetect.

    Runs before the heavy pipeline so we can warn the user about a bad
    recording (muted mic, distortion, totally silent) within ~2 seconds
    instead of after a 5-minute render. `max_seconds`: only look at the
    start (see _max_seconds in analyze_only).

    Returns: {"mean_db": float|None, "max_db": float|None,
              "warnings": list[str]}
    """
    cmd = [
        get_ffmpeg_path(), "-hide_banner",
        "-i", input_path,
        "-af", "volumedetect",
        "-vn", "-sn", "-dn",
        *(["-t", f"{max_seconds:.3f}"] if max_seconds else []),
        "-f", "null", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

    mean_db: float | None = None
    max_db: float | None = None
    for line in result.stderr.split("\n"):
        if "mean_volume:" in line:
            try:
                mean_db = float(line.split("mean_volume:")[1].replace("dB", "").strip())
            except (ValueError, IndexError):
                pass
        elif "max_volume:" in line:
            try:
                max_db = float(line.split("max_volume:")[1].replace("dB", "").strip())
            except (ValueError, IndexError):
                pass

    warnings: list[str] = []
    # Silent / no input
    if mean_db is None or (max_db is not None and max_db < -50):
        warnings.append(
            "Audio looks silent — check your microphone is on and not muted."
        )
    elif mean_db < -45:
        warnings.append(
            "Audio is very quiet — speak closer to the microphone for best results."
        )
    elif mean_db < -35:
        warnings.append(
            "Audio is on the quiet side but should still work."
        )

    # Clipping / distortion
    if max_db is not None and max_db >= -0.3:
        warnings.append(
            "Audio is clipping at peaks — recording too loud, distortion likely."
        )

    return {"mean_db": mean_db, "max_db": max_db, "warnings": warnings}


# 720p editor proxy, written next to the normalized file. Every preview
# build (analysis preview, edit rebuilds, recompute-scenes) cuts from it
# — about 7x less CPU per save than decoding the 1080p/4K mezzanine;
# the render keeps using the normalized file. See preview_source().
PROXY_NAME = "proxy.mp4"
_PROXY_MAX_SIDE = 720
# Long side capped, aspect kept, even sizes. (Unlike the if(gt())/
# if(gt()) pair used elsewhere this also caps square video, where
# both sides would be -2 = "keep the input size".)
_PROXY_SCALE = (
    f"scale=w='if(gte(iw,ih),min({_PROXY_MAX_SIDE},iw),-2)':"
    f"h='if(gte(iw,ih),-2,min({_PROXY_MAX_SIDE},ih))'"
)


def _proxy_video_args() -> list[str]:
    """Encoder settings of the proxy: veryfast crf 26 (a preview source,
    not a mezzanine), same 1 s GOP as the normalized file so the per-
    segment seeks of _ffmpeg_cuts_preview stay cheap."""
    return [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        *_threads(),
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
    ]


def preview_source(normalized_path: str) -> str:
    """The file edit previews are cut from: the 720p proxy next to
    `normalized_path` when there is one, else `normalized_path` itself
    (jobs analysed before proxies existed, or a failed proxy encode).

    The proxy always shows the same frames on the same timeline as the
    normalized file it sits next to (analyze_only makes sure of that,
    also for SmartCam), so segment times apply to both unchanged.
    """
    if not normalized_path:
        return normalized_path
    proxy = Path(normalized_path).with_name(PROXY_NAME)
    return str(proxy) if proxy.is_file() else normalized_path


def _default_streams(input_path: str) -> tuple[int | None, int | None]:
    """(video, audio) stream indexes ffmpeg's automatic stream selection
    picks: the video with the most pixels (cover art excluded), the audio
    with the most channels; a stream flagged "default" gets ffmpeg's
    bonus, ties go to the lower index. Raises when ffprobe fails.

    The normalize+proxy call needs explicit maps (a filter_complex
    output), and they must select what the plain `-vf` call selected.
    """
    r = subprocess.run(
        [get_ffprobe_path(), "-v", "error",
         "-show_entries",
         "stream=index,codec_type,width,height,channels"
         ":stream_disposition=default,attached_pic",
         "-of", "json", input_path],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {r.stderr[-300:]}")
    best: dict[str, tuple[int | None, int]] = {
        "video": (None, -1), "audio": (None, -1),
    }
    for st in json.loads(r.stdout or "{}").get("streams") or []:
        kind = st.get("codec_type")
        disp = st.get("disposition") or {}
        if kind == "video":
            if disp.get("attached_pic"):
                continue
            score = int(st.get("width") or 0) * int(st.get("height") or 0)
        elif kind == "audio":
            score = int(st.get("channels") or 0)
        else:
            continue
        score += 5_000_000 * (1 if disp.get("default") else 0)
        if score > best[kind][1]:
            best[kind] = (int(st["index"]), score)
    return best["video"][0], best["audio"][0]


def _normalize_orientation(
    input_path: str,
    output_path: str,
    max_side: int = 1920,
    max_seconds: float | None = None,
    proxy_path: str | None = None,
) -> bool:
    """Re-encode upload with rotation baked in, audio cleaned + LUFS-normalized.

    `max_seconds` cuts the output there (everything downstream works on
    this file); see _max_seconds in analyze_only.

    `proxy_path`: also write the 720p editor proxy (PROXY_NAME) from the
    same decode — a `split` of the filtered video into a second output.
    Returns True when the proxy was written. The proxy is optional: if
    the combined call fails, the plain normalize runs again on its own
    (returns False), so a proxy problem can never fail an analysis.

    Three passes folded into one ffmpeg call:
      1) Re-encode video without -noautorotate so rotation metadata
         (iPhone/most mobile cams) is baked into pixels. MoviePy ignores
         the rotation tag, which is why portrait phone uploads used to
         come out landscape.
      2) `afftdn` light noise reduction — removes hiss / room tone /
         fan noise without artifacting the speech.
      3) `loudnorm` to -14 LUFS / -1.5 dBTP / 11 LU range — the modern
         streaming-platform standard (YouTube, TikTok, Spotify all
         target -14 LUFS).

    Uses libx264 because bundled imageio_ffmpeg's videotoolbox is broken.
    """
    # AUDIO: bit-perfect passthrough via -c:a copy (see cmd list below).
    # Prior 'anull filter + AAC 192k re-encode' still lost quality on
    # quiet iPhone audio — audible as hollow/squeaky artifacts when
    # user played back with volume boosted. Skipping the normalize
    # re-encode entirely means the burn step is the ONLY lossy AAC
    # pass, and at 320k that's transparent for speech.
    # Cap longest side at `max_side`. Default 1920 (1080p) for the
    # Railway fast path; caller passes 3840 for 4K when user opts in.
    # Aspect ratio preserved. Even/odd-safe via -2.
    scale_filter = (
        f"scale='if(gt(iw,ih),min({max_side},iw),-2)':"
        f"'if(gt(ih,iw),min({max_side},ih),-2)'"
    )

    # HDR → SDR tonemap. iPhone videos (Dolby Vision / HLG) will clip to
    # pure white without this, because the 8-bit yuv420p output truncates
    # anything above SDR peak. Detect via ffprobe; skip on SDR input to
    # avoid unnecessary color-space round-trip on already-Rec709 content.
    is_hdr = _probe_hdr(input_path)
    vf = (
        f"{_HDR_TONEMAP_CHAIN},{scale_filter}" if is_hdr else scale_filter
    )
    cut = ["-t", f"{max_seconds:.3f}"] if max_seconds else []

    head = [get_ffmpeg_path(), "-y", *_threads(), "-i", input_path]
    main_out = [
        # 'fast' preset + crf 18 — the normalized file is re-encoded
        # during burn, so investing extra encode time here pays off in
        # the final quality. Fast (~40% slower than veryfast) still
        # fits Railway's CPU budget for typical 60-90s videos, and
        # crf 18 is visually near-lossless as a source for the burn.
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        *_threads(),
        # Force a keyframe every ~1s. The web editor plays this file
        # directly and seeks over cut regions; sparse keyframes
        # (libx264's default ~10s) made the browser buffer for
        # hundreds of ms at every hop → visibly frozen playback.
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p",
        # Tag output as BT.709 SDR so downstream players don't re-interpret
        # our tonemapped pixels as still-HDR.
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        # Bit-perfect audio passthrough — copies the source AAC stream
        # unchanged. No re-encode, no filter, no quality loss.
        "-c:a", "copy",
        *cut,
        "-movflags", "+faststart",
        output_path,
    ]

    if proxy_path:
        # Written under a temp name and renamed when complete, so a
        # half-written proxy is never picked up by preview_source().
        tmp_proxy = str(Path(proxy_path).with_suffix(".tmp.mp4"))
        try:
            v_idx, a_idx = _default_streams(input_path)
        except Exception as e:
            print(f"[normalize] stream probe failed, no proxy in this "
                  f"pass: {e}", flush=True)
            v_idx = a_idx = None
        if v_idx is not None:
            cmd = [
                *head,
                # split's second output has no label: ffmpeg attaches it
                # to the first output file (normalized), whose audio is
                # then still auto-selected exactly as with plain -vf.
                "-filter_complex",
                f"[0:{v_idx}]{vf},split=2[proxy_in];"
                f"[proxy_in]{_PROXY_SCALE}[proxy]",
                *main_out,
                "-map", "[proxy]",
                *(["-map", f"0:{a_idx}"] if a_idx is not None else []),
                *_proxy_video_args(),
                "-c:a", "copy",
                *cut,
                "-movflags", "+faststart",
                tmp_proxy,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0 and Path(tmp_proxy).is_file():
                os.replace(tmp_proxy, proxy_path)
                return True
            Path(tmp_proxy).unlink(missing_ok=True)
            tail = result.stderr[-800:] if result.stderr else "(no stderr)"
            if "No space left on device" in tail:
                raise RuntimeError(
                    f"ffmpeg orientation-normalize failed (hdr={is_hdr}):\n{tail}"
                )
            print(f"[normalize] normalize+proxy failed, retrying without "
                  f"proxy:\n{tail}", flush=True)

    cmd = [*head, "-vf", vf, *main_out]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else "(no stderr)"
        raise RuntimeError(
            f"ffmpeg orientation-normalize failed (hdr={is_hdr}):\n{tail}"
        )
    return False


def _make_proxy(source_path: str, proxy_path: str) -> bool:
    """Write the 720p editor proxy of `source_path` in a pass of its own
    (SmartCam output, or a normalize that couldn't produce it). Returns
    False — and leaves no proxy behind — on failure; previews then fall
    back to the full-size file."""
    tmp_proxy = str(Path(proxy_path).with_suffix(".tmp.mp4"))
    cmd = [
        get_ffmpeg_path(), "-y", *_threads(),
        "-i", source_path,
        "-map", "0:V:0", "-map", "0:a:0?",
        "-vf", _PROXY_SCALE,
        *_proxy_video_args(),
        "-c:a", "copy",
        "-movflags", "+faststart",
        tmp_proxy,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0 and Path(tmp_proxy).is_file():
        os.replace(tmp_proxy, proxy_path)
        return True
    Path(tmp_proxy).unlink(missing_ok=True)
    Path(proxy_path).unlink(missing_ok=True)
    tail = result.stderr[-400:] if result.stderr else "(no stderr)"
    print(f"[proxy] encode failed, previews use the full file:\n{tail}",
          flush=True)
    return False


# A segment may start this much before its predecessor ends (float
# noise in editor values) and still count as "in order": the single-
# pass build then holds at most that stretch of decoded frames.
_ORDER_SLACK_S = 0.1


def _ascending_runs(
    segments: list[tuple[float, float]],
) -> list[list[tuple[float, float]]]:
    """Split `segments` (timeline order) into maximal runs whose source
    ranges ascend without overlapping. One run = the plain in-order case."""
    runs: list[list[tuple[float, float]]] = []
    for s, e in segments:
        s, e = float(s), float(e)
        if runs and s >= runs[-1][-1][1] - _ORDER_SLACK_S:
            runs[-1].append((s, e))
        else:
            runs.append([(s, e)])
    return runs


# Cap the preview at 720p on the longest side so iOS Safari can play it
# inline — 4K MP4s often fail to start on the phone.
_PREVIEW_SCALE = "scale='if(gt(iw,ih),720,-2)':'if(gt(ih,iw),720,-2)'"

# Ascending timelines up to this many segments take the one-pass trim/
# concat filter graph. Its cost grows much faster than the segment count
# (every decoded frame visits every branch): on a 5 min 720p proxy 25
# segments took 9 s, 100 25 s, 200 60 s and 1000 more than 10 min.
_FILTER_MAX_SEGMENTS = 24

# The concat demuxer ends a segment at the first packet of ANY stream
# whose decoding timestamp reaches its outpoint; read this far past the
# segment end so no frame of it is cut off (the exact end comes from its
# `duration` + concatdec_select).
_CONCAT_SLACK_S = 0.1


def _preview_filter(
    segments: list[tuple[float, float]],
    offset: float = 0.0,
) -> str:
    """trim/atrim + concat graph for ascending `segments`; times are
    shifted by `offset` (the input's -ss). Output pads [outv] [outa]."""
    filters = []
    parts = []
    for i, (s, e) in enumerate(segments):
        s = max(0.0, s - offset)
        e = max(0.0, e - offset)
        filters.append(
            f"[0:v]trim={s:.3f}:{e:.3f},setpts=PTS-STARTPTS[v{i}]"
        )
        filters.append(
            f"[0:a]atrim={s:.3f}:{e:.3f},asetpts=PTS-STARTPTS[a{i}]"
        )
        parts.append(f"[v{i}][a{i}]")
    filters.append(
        f"{''.join(parts)}concat=n={len(segments)}:v=1:a=1[outvfull][outa]"
    )
    filters.append(f"[outvfull]{_PREVIEW_SCALE}[outv]")
    return ";".join(filters)


def _preview_video_args() -> list[str]:
    return [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
        *_threads(),
        # Force a keyframe every ~1s. Without this, libx264 ultrafast
        # produces GOPs of ~10s, which makes seeking + decoding at
        # segment concat points visibly stutter — the user sees the
        # transitions as 'hangs' when the preview swaps in after a
        # rebuild. Dense keyframes also let currentTime restore snap
        # instantly on src swap.
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
    ]


def _run_preview_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg preview-cut failed:\n{tail}")


def _start_time(path: str) -> float:
    """The container's start timestamp (0 for our own encodes)."""
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries",
             "format=start_time", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=15)
        value = float((r.stdout or "").strip() or 0.0)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _ffmpeg_cuts_preview(
    input_path: str,
    segments: list[tuple[float, float]],
    output_path: str,
) -> None:
    """Produce a fast preview MP4 of the source with cut segments concatenated.

    Lets the user scrub in the browser against the actual edit timeline
    (silence/fillers/voice-trigger ranges already removed). No captions
    burned in — those will be overlaid live in the UI for the review
    step. Callers pass preview_source(normalized_path) as `input_path`.

    A few segments in ascending source order: one `filter_complex` pass.
    Out of order (the editor's move-left/right) or overlapping, that
    pass would buffer every decoded frame between the moved clip's
    source position and its turn in the concat — ~100 MB per kept
    second at 1080p (measured 1.7 GB for 14 s, 4.6 GB for 60 s: two
    clicks could OOM the box) — and with many segments it gets very slow
    (_FILTER_MAX_SEGMENTS). Those go through _concat_preview instead:
    one pass, memory of a plain decode + encode, and a cost that grows
    only by ~15 ms per segment, whatever the order.
    """
    if not segments:
        raise ValueError("no segments to preview")

    ff = get_ffmpeg_path()
    if (len(segments) <= _FILTER_MAX_SEGMENTS
            and len(_ascending_runs(segments)) == 1):
        _run_preview_ffmpeg([
            ff, "-y", *_threads(),
            "-i", input_path,
            "-filter_complex", _preview_filter(segments),
            "-map", "[outv]", "-map", "[outa]",
            *_preview_video_args(),
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path,
        ])
        return
    _concat_preview(ff, input_path, segments, output_path)


def _concat_preview(
    ff: str,
    input_path: str,
    segments: list[tuple[float, float]],
    output_path: str,
) -> None:
    """One ffmpeg pass over `segments` in timeline order: the concat
    demuxer reads each one from the source (seek to its inpoint, ≤ 1 GOP
    decoded before it), concatdec_select drops the frames around each
    cut, and the result is encoded once. Each segment starts exactly at
    the sum of the lengths before it (its `duration`), so the editor's
    preview_segments math holds; the audio is re-laid on the timestamps
    (silence into gaps, overlaps trimmed) so A/V sync resets at every
    join. The list file sits next to the output (the job folder, on
    the work volume)."""
    # inpoints are the container's own timestamps; the filter path's
    # trim times are relative to its start.
    offset = _start_time(input_path)
    source = os.path.abspath(input_path).replace("'", "'\\''")
    out_dir = os.path.dirname(os.path.abspath(output_path))
    work = tempfile.mkdtemp(prefix="cleo_preview_", dir=out_dir)
    try:
        list_path = os.path.join(work, "segments.txt")
        with open(list_path, "w") as f:
            for s, e in segments:
                s, e = float(s), float(e)
                f.write(f"file '{source}'\n"
                        f"inpoint {offset + s:.6f}\n"
                        f"outpoint {offset + e + _CONCAT_SLACK_S:.6f}\n"
                        f"duration {e - s:.6f}\n")
        _run_preview_ffmpeg([
            ff, "-y", *_threads(),
            # Keep the demuxer's timestamps: concatdec_select compares
            # them with each segment's start (by default the CLI shifts
            # them by the frames decoded before the first inpoint).
            "-copyts",
            "-f", "concat", "-safe", "0", "-segment_time_metadata", "1",
            "-i", list_path,
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", f"select=concatdec_select,{_PREVIEW_SCALE}",
            "-af", ("aselect=concatdec_select,"
                    "aresample=async=1:min_hard_comp=0.01:first_pts=0"),
            *_preview_video_args(),
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path,
        ])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _generate_thumbnail(input_path: str, output_path: str, at_seconds: float = 1.0) -> None:
    """Extract a JPG poster frame from the rendered video.

    Instead of dumb "grab frame at 1s" (often black/blur/loading screen),
    scan candidate frames and pick the one with the highest visual
    interest score: brightness (not black) × edge density (not blur).
    Falls back to the simple 1s grab on any error.
    """
    # Probe duration; if too short (<3s) just grab frame 0.
    try:
        probe = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries",
             "format=duration", "-of",
             "default=noprint_wrappers=1:nokey=1", input_path],
            capture_output=True, text=True, timeout=10,
        )
        duration = float((probe.stdout or "0").strip() or 0)
    except Exception:
        duration = 0.0

    if duration < 3.0:
        _generate_thumbnail_simple(input_path, output_path, at_seconds=0.5)
        return

    best_path = _pick_best_frame(input_path, duration)
    if best_path is None:
        _generate_thumbnail_simple(input_path, output_path, at_seconds=at_seconds)
        return

    # Rescale + JPG-encode the chosen frame at the same size as before
    cmd = [
        get_ffmpeg_path(), "-y",
        "-i", best_path,
        "-vf", "scale=320:-2",
        "-q:v", "3",
        *_threads(),
        output_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    finally:
        try:
            Path(best_path).unlink()
        except Exception:
            pass


def _generate_thumbnail_simple(
    input_path: str, output_path: str, at_seconds: float = 1.0,
) -> None:
    """Fallback: grab a single frame at the given timestamp."""
    cmd = [
        get_ffmpeg_path(), "-y",
        *_threads(),
        "-ss", str(at_seconds),
        "-i", input_path,
        "-frames:v", "1",
        "-vf", "scale=320:-2",
        "-q:v", "3",
        *_threads(),
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if result.returncode != 0 and at_seconds > 0:
            _generate_thumbnail_simple(input_path, output_path, at_seconds=0.0)
    except Exception as e:
        print(f"[thumbnail] extract failed: {e}", flush=True)


def _pick_best_frame(
    input_path: str, duration: float, num_candidates: int = 8,
) -> str | None:
    """Sample `num_candidates` frames spread across the video's middle
    60%, score each on brightness × sharpness, return the path to the
    best. Skips the first 15% (often loading / talking-head intro) and
    the last 25% (outro / hand-in-frame reaching for phone).
    """
    start = duration * 0.15
    end = duration * 0.75
    if end <= start:
        return None
    spacing = (end - start) / max(1, num_candidates - 1)

    tmp_dir = tempfile.mkdtemp(prefix="cleo_thumb_")
    best_score = -1.0
    best_path: str | None = None

    try:
        for i in range(num_candidates):
            t = start + i * spacing
            candidate = str(Path(tmp_dir) / f"cand_{i:02d}.png")
            # Scale down for cheap analysis + always yuv420p so tone-
            # mapped HDR sources don't blow up the encode.
            extract_cmd = [
                get_ffmpeg_path(), "-y",
                *_threads(),
                "-ss", f"{t:.3f}",
                "-i", input_path,
                "-frames:v", "1",
                "-vf", "scale=320:-2",
                "-pix_fmt", "yuv420p",
                *_threads(),
                candidate,
            ]
            r = subprocess.run(
                extract_cmd, capture_output=True, text=True, timeout=10,
            )
            if r.returncode != 0 or not Path(candidate).exists():
                continue
            score = _score_frame(candidate)
            if score > best_score:
                best_score = score
                # If we already had a best_path, drop the old file
                if best_path and best_path != candidate:
                    try:
                        Path(best_path).unlink()
                    except Exception:
                        pass
                best_path = candidate
            else:
                try:
                    Path(candidate).unlink()
                except Exception:
                    pass
        return best_path
    except Exception as e:
        print(f"[thumbnail] frame-pick failed: {e}", flush=True)
        return best_path


def _score_frame(image_path: str) -> float:
    """Score = brightness × sharpness. Both normalised to 0-1.

    - Brightness: mean pixel value / 255. Kills black or almost-black
      frames. Also lightly penalises blown-out white frames via a
      distance-from-middle curve.
    - Sharpness: variance of the Laplacian, a classic quick blur
      detector. High variance = strong edges = not blurry.
    """
    try:
        import numpy as np
        import cv2  # opencv-python-headless in requirements
    except Exception:
        return 0.0
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None or img.size == 0:
        return 0.0
    mean = float(np.mean(img)) / 255.0
    # Kill pure black or pure white. Prefer mid-tone.
    brightness_ok = 1.0 - abs(mean - 0.5) * 1.6
    brightness_ok = max(0.0, brightness_ok)
    # Sharpness: variance of Laplacian. Real speaker frames land
    # around 200-2000. Cap at 500 to normalise.
    lap = cv2.Laplacian(img, cv2.CV_64F)
    sharp_raw = float(lap.var())
    sharp = min(1.0, sharp_raw / 500.0)
    return brightness_ok * sharp


def _ffmpeg_concat(
    clip_paths: list[str],
    output_path: str,
    source_audio_path: str | None = None,
    audio_segments: list[tuple[float, float]] | None = None,
) -> None:
    """Concatenate clips through the concat demuxer, re-encoding video
    AND rebuilding audio directly from the source.

    Audio strategy:
      - If source_audio_path + audio_segments given, we DISCARD the
        per-segment burned audio (MoviePy's numpy pipeline was subtly
        altering it) and rebuild the audio timeline by atrim+concat
        directly from the source. One AAC re-encode, no numpy round-
        trip → audio stays character-identical to the recording.
      - Otherwise falls back to stream-copying the burned audio.
    """
    if not clip_paths:
        raise ValueError("no clips to concat")

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False
    ) as f:
        list_path = f.name
        for p in clip_paths:
            f.write(f"file '{p}'\n")

    use_source_audio = bool(source_audio_path and audio_segments)

    # Bit-perfect audio path: extract each segment from source AAC with
    # -c:a copy (no decode, no re-encode), concat via demuxer with copy.
    # Result byte-matches the source samples in the kept ranges — no
    # numpy round-trip, no AAC re-encode. Downside: -ss on AAC copy
    # snaps cuts to the nearest AAC frame (~21ms at 48kHz), which is
    # below the audibility threshold.
    audio_only_path: str | None = None
    if use_source_audio:
        audio_segs_dir = tempfile.mkdtemp(prefix="cleo_audio_")
        # Extract to .m4a (MP4 container) instead of raw .aac (ADTS).
        # iPhone AAC lives natively in MP4 — matching the container
        # keeps the AAC bitstream bit-identical without ADTS wrapping
        # that concat demuxer sometimes rejects.
        m4a_seg_paths: list[str] = []
        for i, (s, e) in enumerate(audio_segments):
            m4a_path = str(Path(audio_segs_dir) / f"a_{i:04d}.m4a")
            extract_cmd = [
                get_ffmpeg_path(), "-y",
                "-ss", f"{s:.3f}", "-to", f"{e:.3f}",
                "-i", source_audio_path,
                "-vn", "-c:a", "copy",
                # The input seek lands on the VIDEO keyframe before `s`
                # (up to 10 s early in a SmartCam mux); stream copy kept
                # all audio from there, so kept ranges came out too long
                # and the audio drifted off the picture. Drop it.
                "-copypriorss", "0",
                "-avoid_negative_ts", "make_zero",
                m4a_path,
            ]
            r = subprocess.run(extract_cmd, capture_output=True, text=True)
            if r.returncode == 0 and Path(m4a_path).exists():
                m4a_seg_paths.append(m4a_path)
            else:
                # Surface the failure loudly so we don't silently fall
                # back to MoviePy's degraded audio.
                print(f"[audio-extract] seg {i} failed: "
                      f"{r.stderr[-400:] if r.stderr else '(no stderr)'}",
                      flush=True)
        if m4a_seg_paths and len(m4a_seg_paths) == len(audio_segments):
            audio_list_path = str(Path(audio_segs_dir) / "list.txt")
            with open(audio_list_path, "w") as f:
                for p in m4a_seg_paths:
                    f.write(f"file '{p}'\n")
            audio_only_path = str(Path(audio_segs_dir) / "concat.m4a")
            concat_a_cmd = [
                get_ffmpeg_path(), "-y",
                "-f", "concat", "-safe", "0",
                "-i", audio_list_path,
                "-c:a", "copy",
                audio_only_path,
            ]
            r = subprocess.run(concat_a_cmd, capture_output=True, text=True)
            if r.returncode != 0:
                print(f"[audio-concat] failed: "
                      f"{r.stderr[-400:] if r.stderr else '(no stderr)'}",
                      flush=True)
                audio_only_path = None
            else:
                print(f"[audio] bit-perfect track built from source "
                      f"({len(audio_segments)} segments)", flush=True)
        else:
            print(f"[audio] source-audio path aborted — "
                  f"{len(m4a_seg_paths)}/{len(audio_segments)} segments "
                  "extracted; falling back to MoviePy audio",
                  flush=True)

    cmd = [
        get_ffmpeg_path(), "-y",
        *_threads(),
        # +genpts on the INPUT parser fills in missing PTS from DTS so
        # concat-demuxer segments join cleanly without inheriting the
        # tiny AAC-frame-boundary offsets that stacked as A/V drift.
        "-fflags", "+genpts",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
    ]
    if audio_only_path:
        cmd += ["-i", audio_only_path, "-map", "0:v", "-map", "1:a"]

    cmd += [
        # Final encode — runs once per render. Defaults tuned with a
        # benchmark (CLEO_FINAL_PRESET / CLEO_FINAL_CRF override).
        "-c:v", "libx264",
        "-preset", os.environ.get("CLEO_FINAL_PRESET", "veryfast"),
        "-crf", os.environ.get("CLEO_FINAL_CRF", "20"),
        *_threads(),
        "-pix_fmt", "yuv420p",
        # -vsync 1 (default) with +genpts on input preserves source fps.
        # Previous -r 30 forced re-timing which caused drift on 60fps
        # or 29.97 source. Removed.
        # Audio: bit-perfect copy of source AAC.
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if use_source_audio:
            shutil.rmtree(audio_segs_dir, ignore_errors=True)
        Path(list_path).unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg concat failed: {result.stderr[-800:]}"
        )


def analyze_only(
    input_path: str,
    output_dir: str,
    settings: dict[str, Any],
    progress_cb: Callable[[str, float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    on_normalized: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Normalize + run analysis. Returns dict with the pieces the render
    step + the subtitle-editor UI need.

    `on_normalized` is called once, right after normalized.mp4 (and the
    editor proxy) were written and before SmartCam / analysis: nothing
    reads `input_path` after that point, so the web backend deletes the
    upload there instead of keeping a second full-size copy for the
    whole analysis. An exception from it is logged, not raised.

    Result keys:
      - normalized_path: where the rotation-fixed MP4 lives
      - preview_path: the cut preview (built from preview_source())
      - segments: list of (start, end) speech segments after cuts
      - subtitles: list of {start, end, text, original_start, original_end}
      - language: ISO code from Whisper
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    style_map = {"tight": "fast", "balanced": "smooth", "smooth": "smooth"}
    style = style_map.get(settings.get("style", "balanced"), "smooth")

    voice_triggers = settings.get("voice_triggers", True)
    remove_fillers = settings.get("remove_fillers", True)
    # 'medium' catches short wake words ('Cleo cut', 'Cleo go') that
    # 'small' regularly swallows. Slower (~2x) but the voice-trigger
    # feature simply doesn't work reliably on 'small'.
    whisper_model = settings.get("whisper_model", "medium")
    cut_keywords = settings.get("cut_keywords")
    continue_keywords = settings.get("continue_keywords")

    def _stage(msg: str, pct: float) -> None:
        if progress_cb:
            progress_cb(msg, pct)

    def _analyze_cb(msg: str, step=None, total_steps=None, progress=None) -> None:
        if progress is not None:
            pct = 90 * (progress if progress <= 1 else progress / 100)
        elif step is not None and total_steps:
            pct = 10 + 80 * (step / total_steps)
        else:
            pct = None
        if progress_cb:
            progress_cb(msg, pct if pct is not None else -1)

    # Set by the web backend (never by the client) when the minutes
    # quota is enforced: the length that was charged plus a small
    # tolerance. The charge is based on the container's duration header,
    # which the uploader controls — without the cap a file claiming 1 s
    # would still be transcribed and cleaned up in full.
    try:
        max_seconds = float(settings.get("_max_seconds") or 0) or None
    except (TypeError, ValueError):
        max_seconds = None

    _stage("Checking audio…", 1)
    audio_precheck = _precheck_audio(input_path, max_seconds=max_seconds)

    _stage("Preparing video…", 3)
    normalized_path = str(Path(output_dir) / "normalized.mp4")
    # Resolution: 'resolution' setting is a string like '1080', '1440',
    # '2160'. Map to max longest side. Default 1080p to preserve the
    # Railway budget for casual users; 4K opt-in for creators.
    _res_str = str(settings.get("resolution", "1080"))
    _res_map = {"1080": 1920, "1440": 2560, "2160": 3840, "4k": 3840}
    _max_side = _res_map.get(_res_str.lower(), 1920)
    print(f"[render] resolution setting='{_res_str}' → "
          f"longest-side max={_max_side}", flush=True)
    smartcam = bool(settings.get("smartcam_enabled"))
    proxy_path = str(Path(output_dir) / PROXY_NAME)
    # A stale proxy (a re-run in the same folder) must never outlive the
    # file it was made from.
    Path(proxy_path).unlink(missing_ok=True)
    # SmartCam replaces normalized.mp4 with a reframed video, so its
    # proxy is made from that output below; otherwise it comes out of
    # the normalize pass itself.
    has_proxy = _normalize_orientation(
        input_path, normalized_path, max_side=_max_side,
        max_seconds=max_seconds,
        proxy_path=None if smartcam else proxy_path,
    )
    if not smartcam and not has_proxy:
        _make_proxy(normalized_path, proxy_path)

    if on_normalized is not None:
        try:
            on_normalized()
        except Exception as e:
            print(f"[normalize] on_normalized callback failed: {e}",
                  flush=True)

    # Optional SmartCam reframe — runs ONCE for the primary aspect the
    # user selected. Other multi-format outputs derive from the rendered
    # primary via simple letterbox-pad in the render step.
    if smartcam:
        sc_format = settings.get("smartcam_format", "portrait")
        sc_resolution = settings.get("resolution", "1080")
        _stage(f"SmartCam tracking faces ({sc_format})…", 6)
        # Written straight into this job's folder (job-scoped name; the
        # plugin's shared-cache default collides between jobs).
        sc_dest = str(Path(output_dir) / "normalized_smartcam.mp4")
        sc_out = _smartcam_reframe(
            normalized_path, sc_dest, sc_format, sc_resolution,
            progress_cb=progress_cb,
        )
        if sc_out and Path(sc_out).exists():
            if os.path.abspath(sc_out) != os.path.abspath(sc_dest):
                shutil.move(sc_out, sc_dest)
            # Drop the now-unused plain normalized.mp4.
            Path(normalized_path).unlink(missing_ok=True)
            normalized_path = sc_dest
        else:
            Path(sc_dest).unlink(missing_ok=True)  # partial output
            print("[smartcam] reframe returned no file — falling back to source",
                  flush=True)
        _stage("Preparing preview…", 9)
        _make_proxy(normalized_path, proxy_path)

    _stage("Analyzing audio…", 10)
    result = analyze_video(
        video_path=normalized_path,
        whisper_model=whisper_model,
        style=style,
        remove_fillers=remove_fillers,
        voice_triggers=voice_triggers,
        cut_keywords=cut_keywords,
        continue_keywords=continue_keywords,
        progress_callback=_analyze_cb,
        cancel_check=cancel_check,
    )

    segments = result.segments
    subtitles = result.subtitles if isinstance(result.subtitles, list) else []

    if not segments:
        raise RuntimeError("No speech detected in the video.")

    duration = result.duration

    # LLM cleanup + bad-take detection. Runs only if ANTHROPIC_API_KEY
    # is set; soft-fails to no-op otherwise so dev works without a key.
    _stage("Polishing transcript…", 85)
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    print(f"[llm] cleanup starting — API key present: {has_key}, "
          f"{len(subtitles)} subtitles to process", flush=True)
    try:
        from backend.llm import cleanup_transcript
        # Text cleanup only — typos, brand names, filler vocalisations
        # in the visible transcript. Does NOT decide any cuts. Failed
        # takes are handled by voice triggers ("Cleo cut/go"), which
        # the user controls explicitly during recording.
        llm_input = [
            {
                "id": i,
                "text": s.get("text", ""),
                "start": s.get("start"),
                "end": s.get("end"),
            }
            for i, s in enumerate(subtitles)
        ]
        cleaned = cleanup_transcript(llm_input, language=result.language)
        print(f"[llm] cleanup — {len(cleaned)} phrase(s) rewritten",
              flush=True)
        for i, s in enumerate(subtitles):
            c = cleaned.get(i)
            if c:
                s["text"] = c
    except Exception as e:
        import traceback
        print(f"[llm] cleanup pass failed (soft): {e}\n"
              f"{traceback.format_exc()}", flush=True)

    # Compute the cut ranges (inverse of kept segments) so the user can
    # see exactly what's being removed, and tap to disable individual
    # cuts on the timeline. Includes the LLM bad-takes from above.
    cut_ranges = _invert_segments(segments, duration)

    _stage("Building preview…", 95)
    preview_path = str(Path(output_dir) / "preview.mp4")
    _ffmpeg_cuts_preview(preview_source(normalized_path), segments,
                         preview_path)

    return {
        "normalized_path": normalized_path,
        "preview_path": preview_path,
        "segments": segments,
        "subtitles": subtitles,
        "duration": duration,
        "cut_ranges": cut_ranges,
        "language": result.language,
        "scene_events": getattr(result, "scene_events", None) or [],
        "audio_warnings": audio_precheck.get("warnings", []),
        "audio_levels": {
            "mean_db": audio_precheck.get("mean_db"),
            "max_db": audio_precheck.get("max_db"),
        },
    }


def _apply_segment_effects(
    input_path: str,
    output_path: str,
    segments: list[tuple[float, float] | list[float]],
    effects: list[dict],
) -> None:
    """Apply per-segment speed / fade / volume via ffmpeg filter_complex.

    The concat output is a linear video where segment N runs from
    `sum(prev durations)` to `sum(prev durations) + segment_N_duration`.
    We split the video into those slices, apply per-slice filters, and
    concat back. Effects supported:
      - speed: setpts (video) + atempo (audio). Chained for >2x / <0.5x.
      - fadeIn / fadeOut: video fade + afade at slice boundary.
      - volume: audio scale.
    """
    if not segments or not effects:
        raise ValueError("nothing to apply")
    # Compute per-slice bounds in OUTPUT time.
    durations = [max(0.0, float(s[1]) - float(s[0])) for s in segments]
    total = sum(durations)
    if total <= 0:
        raise ValueError("segments have zero total duration")

    filter_parts: list[str] = []
    concat_v: list[str] = []
    concat_a: list[str] = []
    cursor = 0.0
    for i, (dur, eff) in enumerate(zip(durations, effects)):
        s_start = cursor
        s_end = cursor + dur
        cursor = s_end
        # Only a MISSING value means default: `x or 1.0` used to turn
        # volume 0 (mute) back into full volume.
        def _num(key: str, default: float) -> float:
            v = eff.get(key)
            try:
                return default if v is None else float(v)
            except (TypeError, ValueError):
                return default
        speed = _num("speed", 1.0)
        if speed <= 0:
            speed = 1.0
        fade_in = max(0.0, _num("fadeIn", 0.0))
        fade_out = max(0.0, _num("fadeOut", 0.0))
        volume = max(0.0, _num("volume", 1.0))

        v_chain = [
            f"[0:v]trim=start={s_start:.3f}:end={s_end:.3f}",
            "setpts=PTS-STARTPTS",
        ]
        a_chain = [
            f"[0:a]atrim=start={s_start:.3f}:end={s_end:.3f}",
            "asetpts=PTS-STARTPTS",
        ]
        # Speed via setpts + atempo (atempo capped 0.5-2.0 per stage)
        if abs(speed - 1.0) > 0.001:
            v_chain.append(f"setpts=PTS/{speed:.4f}")
            remaining = speed
            while remaining > 2.0:
                a_chain.append("atempo=2.0")
                remaining /= 2.0
            while remaining < 0.5:
                a_chain.append("atempo=0.5")
                remaining /= 0.5
            if abs(remaining - 1.0) > 0.001:
                a_chain.append(f"atempo={remaining:.4f}")
        # Effective slice duration after speed change
        eff_dur = dur / speed if speed > 0 else dur
        if fade_in > 0:
            fi = min(fade_in, eff_dur / 2)
            v_chain.append(f"fade=t=in:st=0:d={fi:.3f}")
            a_chain.append(f"afade=t=in:st=0:d={fi:.3f}")
        if fade_out > 0:
            fo = min(fade_out, eff_dur / 2)
            v_chain.append(
                f"fade=t=out:st={max(0.0, eff_dur - fo):.3f}:d={fo:.3f}",
            )
            a_chain.append(
                f"afade=t=out:st={max(0.0, eff_dur - fo):.3f}:d={fo:.3f}",
            )
        if abs(volume - 1.0) > 0.001:
            a_chain.append(f"volume={volume:.4f}")
        # Output label goes right after the last filter — a comma
        # before it ("…,[v0]") is an empty filter and ffmpeg rejects
        # the whole graph, which silently dropped every effect.
        filter_parts.append(",".join(v_chain) + f"[v{i}]")
        filter_parts.append(",".join(a_chain) + f"[a{i}]")
        concat_v.append(f"[v{i}]")
        concat_a.append(f"[a{i}]")

    n = len(durations)
    # concat wants alternating streams: v0,a0,v1,a1,...
    interleaved = "".join(
        f"[v{i}][a{i}]" for i in range(n)
    )
    filter_parts.append(
        f"{interleaved}concat=n={n}:v=1:a=1[outv][outa]"
    )
    filter_complex = ";".join(filter_parts)

    # Linux caps a single argv string at 128 KiB; long timelines (many
    # hundreds of clips) exceed that, which used to raise E2BIG and drop
    # every effect. Hand long graphs to ffmpeg through a file instead.
    graph_args = ["-filter_complex", filter_complex]
    script_path = None
    if len(filter_complex) > 100_000:
        fd, script_path = tempfile.mkstemp(suffix=".ffgraph", text=True)
        with os.fdopen(fd, "w") as fh:
            fh.write(filter_complex)
        graph_args = ["-filter_complex_script", script_path]

    cmd = [
        get_ffmpeg_path(), "-y",
        *_threads(),
        "-i", input_path,
        *graph_args,
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        *_threads(),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k",
        "-movflags", "+faststart",
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    finally:
        if script_path:
            try:
                os.unlink(script_path)
            except OSError:
                pass
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg segment-effects failed: {result.stderr[-800:]}"
        )


class RenderUnavailableError(RuntimeError):
    """The render worker (Modal) still failed after its retries and the
    local fallback is off. The web backend turns any render exception
    into `render_failed` (job back to review; renders aren't charged)."""


def _env_flag(name: str) -> bool | None:
    v = os.environ.get(name, "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return None


def _modal_configured() -> bool:
    return bool(os.environ.get("MODAL_TOKEN_ID"))


def local_render_fallback_enabled() -> bool:
    """May a render run in-process (MoviePy burn on the API box)?

    CLEO_LOCAL_RENDER_FALLBACK=1/0; unset = only when Modal isn't
    configured (local dev). With Modal on, a Modal outage must not move
    ~12 CPU-s per output second and ~1.4 GB RSS per render onto the API
    box, exactly when it is busiest.
    """
    flag = _env_flag("CLEO_LOCAL_RENDER_FALLBACK")
    return (not _modal_configured()) if flag is None else flag


def _modal_retry_delays() -> list[float]:
    """Backoff before each Modal retry: CLEO_MODAL_RETRY_DELAYS, seconds,
    comma-separated. Default "10,30" = up to 2 retries (3 attempts)."""
    raw = os.environ.get("CLEO_MODAL_RETRY_DELAYS", "10,30")
    try:
        return [max(0.0, float(x)) for x in raw.split(",") if x.strip()]
    except ValueError:
        return [10.0, 30.0]


def _modal_retryable(exc: BaseException) -> bool:
    # A render that hit Modal's function timeout will hit it again.
    return type(exc).__name__ != "FunctionTimeoutError"


# ── Modal volume folders ─────────────────────────────────────────────
# Each render copies the normalized source (and its outputs) into a
# random /<folder> of the Modal volume. _try_modal_render removes it when
# it ends, but a process killed mid-render (deploy after the shutdown
# grace) never gets there, and a call that could not be cancelled may
# still write into it later. So every folder is recorded in a ledger on
# the work volume before anything is uploaded — one empty marker file
# per folder, set by the web backend (MODAL_LEDGER_DIR) — and
# sweep_modal_folders() removes what is left (at boot and hourly).
MODAL_LEDGER_DIR: str | None = None
_MODAL_VOLUME = "cleocuts-render-volume"
# A marker stays until its folder can no longer be written to: longer
# than any call of it can run (3 attempts × the 30 min function timeout
# + backoff).
_MODAL_ORPHAN_AGE_S = 2 * 3600
_MODAL_ACTIVE: set[str] = set()   # folders of renders running here
_MODAL_LOCK = threading.Lock()


def _modal_ledger_path(folder: str) -> Path | None:
    return Path(MODAL_LEDGER_DIR) / folder if MODAL_LEDGER_DIR else None


def _modal_ledger_add(folder: str) -> None:
    path = _modal_ledger_path(folder)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    except OSError as e:  # bookkeeping never fails a render
        print(f"[modal] could not record volume folder {folder}: {e}",
              flush=True)


def _modal_ledger_drop(folder: str) -> None:
    path = _modal_ledger_path(folder)
    if path is not None:
        path.unlink(missing_ok=True)


def _remove_modal_folder(vol, folder: str) -> bool:
    """Delete /<folder> from the volume. True once it is gone."""
    try:
        vol.remove_file(f"/{folder}", recursive=True)
    except Exception as e:
        if type(e).__name__ == "NotFoundError":
            return True
        print(f"[modal] removing volume folder {folder} failed: {e}",
              flush=True)
        return False
    return True


def _cancel_modal_call(call) -> bool:
    """Stop a failed attempt's call, so it can't keep writing into the
    folder the next attempt renders into. True if Modal confirmed."""
    try:
        call.cancel()
        return True
    except Exception as e:
        print(f"[modal] cancelling the failed call failed: {e}", flush=True)
        return False


def sweep_modal_folders(now: float | None = None) -> int:
    """Remove the volume folders in the ledger that no render of this
    process uses (left by a restart or an uncancelled call); a marker
    is dropped once its folder is gone and older than
    _MODAL_ORPHAN_AGE_S. Returns the number of markers dropped."""
    ledger = Path(MODAL_LEDGER_DIR) if MODAL_LEDGER_DIR else None
    if ledger is None or not ledger.is_dir() or not _modal_configured():
        return 0
    now = time.time() if now is None else now
    with _MODAL_LOCK:
        active = set(_MODAL_ACTIVE)
    markers = [p for p in ledger.iterdir()
               if p.is_file() and p.name not in active]
    if not markers:
        return 0
    try:
        import modal
        vol = modal.Volume.from_name(_MODAL_VOLUME)
    except Exception as e:
        print(f"[modal] volume sweep skipped: {e}", flush=True)
        return 0
    dropped = 0
    for marker in markers:
        try:
            age = now - marker.stat().st_mtime
        except OSError:
            continue
        if _remove_modal_folder(vol, marker.name) and age > _MODAL_ORPHAN_AGE_S:
            marker.unlink(missing_ok=True)
            dropped += 1
    return dropped


def _try_modal_render(
    normalized_path: str,
    segments: list[tuple[float, float]],
    subtitles: list[dict],
    caption_preset: str,
    cut_style: str,
    language: str | None,
    output_formats: list[str],
    primary_out_path: str,
    thumbnail_out_path: str,
    output_dir: str,
    _stage,
    cancel_check: Callable[[], bool] | None = None,
) -> bool:
    """Offload the burn+concat step to a Modal.com worker.

    Returns False if Modal isn't configured (MODAL_TOKEN_ID unset), True
    once the outputs are on disk. A failed attempt (outage, quota,
    crashed container) is retried after the CLEO_MODAL_RETRY_DELAYS
    backoff; when all attempts failed it raises RenderUnavailableError
    and the caller decides whether a local render may take over
    (local_render_fallback_enabled). Never silently returns False after
    a failure.
    """
    if not _modal_configured():
        return False
    try:
        import modal
    except ImportError as e:
        raise RenderUnavailableError("modal package not installed") from e

    import traceback
    import uuid
    from backend import costs

    # The volume folder of this render (Modal's `job_id` parameter).
    job_id = uuid.uuid4().hex[:12]
    input_filename = os.path.basename(normalized_path)
    delays = _modal_retry_delays()
    attempts = len(delays) + 1
    vol = None
    uploaded = False
    touched = False     # something may be in /<job_id> on the volume
    abandoned = False   # a call that may still write there wasn't cancelled
    last_exc: BaseException | None = None
    attempt = 0
    with _MODAL_LOCK:
        _MODAL_ACTIVE.add(job_id)
    _modal_ledger_add(job_id)
    try:
        for attempt in range(1, attempts + 1):
            try:
                if vol is None:
                    vol = modal.Volume.from_name(_MODAL_VOLUME)
                if not uploaded:
                    _stage("Uploading to Modal storage…", 5)
                    # Stream file into Modal Volume — no Railway RAM spike
                    # from reading the whole file. Volume SDK chunks it
                    # internally. force: a retry may overwrite a partial
                    # upload of the failed attempt.
                    touched = True
                    with vol.batch_upload(force=True) as batch:
                        batch.put_file(normalized_path,
                                       f"/{job_id}/{input_filename}")
                    uploaded = True

                _stage(f"Rendering {len(segments)} clip(s) on Modal…", 10)
                # Modal 1.x renamed lookup → from_name
                fn = modal.Function.from_name(
                    "cleocuts-render", "render_burn_concat")
                _modal_t0 = time.monotonic()
                call = None
                try:
                    # spawn + get (not remote): a failed attempt's call can
                    # be cancelled before the retry renders into the same
                    # folder — it may only have failed on our side.
                    call = fn.spawn(
                        job_id=job_id,
                        input_filename=input_filename,
                        segments=[[float(s), float(e)] for s, e in segments],
                        subtitles=subtitles,
                        caption_preset=caption_preset,
                        cut_style=cut_style,
                        language=language,
                        output_formats=list(output_formats),
                    )
                    result_map = call.get()
                except BaseException:
                    if call is None or not _cancel_modal_call(call):
                        abandoned = True
                    raise
                finally:
                    # Failed attempts are billed by Modal too.
                    costs.record_modal(time.monotonic() - _modal_t0)

                _stage("Downloading from Modal…", 88)
                _download_modal_outputs(
                    vol, job_id, result_map, primary_out_path,
                    thumbnail_out_path, output_dir,
                )
                print(f"[modal] render complete for job {job_id} "
                      f"(attempt {attempt}/{attempts})", flush=True)
                return True
            except Exception as e:
                last_exc = e
                costs.record_event("modal_failed")
                print(f"[modal] render attempt {attempt}/{attempts} failed: "
                      f"{e}\n{traceback.format_exc()}", flush=True)
                if attempt >= attempts or not _modal_retryable(e):
                    break
                delay = delays[attempt - 1]
                _stage(f"Render worker unavailable, retrying in "
                       f"{delay:.0f} s…", 10)
                waited = 0.0
                while waited < delay:
                    if cancel_check and cancel_check():
                        raise InterruptedError("Cancelled")
                    step = min(1.0, delay - waited)
                    time.sleep(step)
                    waited += step
        raise RenderUnavailableError(
            f"Modal render failed after {attempt} attempt(s): "
            f"{type(last_exc).__name__}: {last_exc}"
        ) from last_exc
    finally:
        # Drop this job's files from the volume so it doesn't accumulate
        # — after failures too, not only on success. Non-fatal: what
        # can't be removed now stays in the ledger for the sweep.
        with _MODAL_LOCK:
            _MODAL_ACTIVE.discard(job_id)
        gone = not touched or (vol is not None
                               and _remove_modal_folder(vol, job_id))
        if gone and not abandoned:
            _modal_ledger_drop(job_id)


def _download_modal_outputs(
    vol,
    job_id: str,
    result_map: dict[str, str],
    primary_out_path: str,
    thumbnail_out_path: str,
    output_dir: str,
) -> None:
    """Stream each result file out of the Modal Volume. Each file goes to
    a temp name first, so a download that dies half-way never replaces
    the outputs of an earlier successful render."""
    # result_map is {"primary": "output.mp4", "_thumbnail": "thumbnail.jpg", "9:16": "output_9-16.mp4", ...}
    primary_fname = result_map.get("primary")
    if not primary_fname:
        raise RuntimeError("Modal returned no primary output")
    for fmt in ["primary"] + [f for f in result_map if f != "primary"]:
        fname = result_map[fmt]
        if fmt == "primary":
            local_out = primary_out_path
        elif fmt == "_thumbnail":
            local_out = thumbnail_out_path
        else:
            local_out = str(
                Path(output_dir) / f"cleo_output_{fmt.replace(':', '-')}.mp4"
            )
            if fname == primary_fname and Path(primary_out_path).exists():
                # Same file as the primary (export already had the
                # target size) — link it instead of downloading twice.
                Path(local_out).unlink(missing_ok=True)
                try:
                    os.link(primary_out_path, local_out)
                except OSError:
                    shutil.copyfile(primary_out_path, local_out)
                continue
        part = local_out + ".part"
        try:
            with open(part, "wb") as out_f:
                for chunk in vol.read_file(f"/{job_id}/{fname}"):
                    out_f.write(chunk)
            os.replace(part, local_out)
        finally:
            Path(part).unlink(missing_ok=True)


def _apply_extra_cuts(
    segments: list[tuple[float, float]],
    extra_cuts: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Subtract extra cut ranges from the existing speech segments.

    Used to fold LLM bad-take ranges into the segments after the regular
    pipeline computed silence/filler/voice-trigger cuts.
    """
    out: list[tuple[float, float]] = list(segments)
    for cs, ce in extra_cuts:
        new: list[tuple[float, float]] = []
        for s, e in out:
            if ce <= s or cs >= e:
                new.append((s, e))
            elif cs <= s and ce >= e:
                continue
            elif cs <= s:
                new.append((ce, e))
            elif ce >= e:
                new.append((s, cs))
            else:
                new.append((s, cs))
                new.append((ce, e))
        out = new
    return [(s, e) for (s, e) in out if e - s > 0.05]


def _invert_segments(
    segments: list[tuple[float, float]],
    duration: float,
) -> list[dict]:
    """Compute the removed-time ranges, ordered, with stable IDs.

    These are what the user sees on the cut-timeline. Each cut gets an
    integer id so the frontend can pass back which ones to "undo".
    """
    cuts: list[dict] = []
    cursor = 0.0
    for start, end in segments:
        if start - cursor > 0.05:
            cuts.append({
                "start": round(cursor, 3),
                "end": round(start, 3),
            })
        cursor = end
    if duration - cursor > 0.05:
        cuts.append({"start": round(cursor, 3), "end": round(duration, 3)})
    for i, c in enumerate(cuts):
        c["id"] = i
    return cuts


def _segments_from_disabled_cuts(
    original_segments: list[tuple[float, float]],
    cut_ranges: list[dict],
    disabled_ids: list[int],
    duration: float,
) -> list[tuple[float, float]]:
    """Rebuild segments after the user un-checked some cuts.

    For each disabled cut we extend the kept-segments to re-include
    that range, then merge adjacent / overlapping ones.
    """
    if not disabled_ids:
        return original_segments
    disabled_set = {int(i) for i in disabled_ids}
    re_added = [
        (c["start"], c["end"]) for c in cut_ranges
        if c["id"] in disabled_set
    ]
    merged = sorted(list(original_segments) + re_added)
    out: list[tuple[float, float]] = []
    for s, e in merged:
        if out and s <= out[-1][1] + 0.05:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return [(max(0.0, s), min(duration, e)) for s, e in out if e - s > 0.05]


_DEFAULT_FX = {"speed": 1.0, "fadeIn": 0.0, "fadeOut": 0.0, "volume": 1.0}


def _merge_for_render(
    segments: list,
    effects: list[dict],
    min_gap: float = 0.3,
) -> tuple[list[tuple[float, float]], list[dict]]:
    """Merge clips separated by a tiny FORWARD gap (<= min_gap) into one,
    once, up front — so the burned video, the rebuilt audio and the
    per-segment effects pass all see the same clip boundaries.

    (Previously only the video burn merged, so audio / effect slices
    were computed from the unmerged durations and drifted by the sum
    of the merged gaps.) Two clips are only merged when neither has a
    fade and their speed/volume match, so each merged clip still has a
    single, correct effect. Effects are returned aligned 1:1 with the
    merged segments; a mismatched effects list is ignored.
    """
    segs = [(float(s), float(e)) for s, e in segments]
    if len(effects) != len(segs):
        effects = []
    fx = [dict(_DEFAULT_FX, **(effects[i] if effects else {})) for i in range(len(segs))]
    if not segs:
        return [], []
    out_s = [list(segs[0])]
    out_fx = [fx[0]]
    for (s, e), f in zip(segs[1:], fx[1:]):
        prev = out_fx[-1]
        gap = s - out_s[-1][1]
        mergeable = (
            -1e-6 <= gap <= min_gap
            and prev["fadeIn"] == 0 and prev["fadeOut"] == 0
            and f["fadeIn"] == 0 and f["fadeOut"] == 0
            and prev["speed"] == f["speed"] and prev["volume"] == f["volume"]
        )
        if mergeable:
            out_s[-1][1] = max(out_s[-1][1], e)
        else:
            out_s.append([s, e])
            out_fx.append(f)
    return [(a, b) for a, b in out_s], out_fx


def render_only(
    normalized_path: str,
    output_dir: str,
    segments: list,
    subtitles: list,
    settings: dict[str, Any],
    language: str | None = None,
    cut_ranges: list[dict] | None = None,
    disabled_cuts: list[int] | None = None,
    duration: float | None = None,
    progress_cb: Callable[[str, float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Render edited subtitles + segments into the final MP4.

    If the user un-checked some cuts in the timeline UI, we expand the
    segment list to re-include those ranges before handing off to the
    burn step.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    caption_preset = settings.get("caption_preset", "clean")

    if disabled_cuts and cut_ranges and duration:
        segments = _segments_from_disabled_cuts(
            segments, cut_ranges, disabled_cuts, duration,
        )

    # min_gap=0: every gap between web-editor segments is a deliberate
    # cut (silence, filler word, failed take, user trim). Bridging gaps
    # up to 0.3 s — the Premiere plugin's encode-count optimisation —
    # put short cut 'äh's back into the final video.
    segments, seg_effects = _merge_for_render(
        segments, settings.get("segment_effects") or [], min_gap=0.0,
    )

    def _stage(msg: str, pct: float) -> None:
        if progress_cb:
            progress_cb(msg, pct)

    # Modal offload: if MODAL_TOKEN_ID is set, ship the render step to
    # Modal.com's pay-per-second workers. 3-5× faster than Railway CPU
    # (more parallelism + better CPUs) at ~1/3 the cost. Failed attempts
    # are retried (10 s / 30 s backoff); rendering locally instead is
    # only allowed by CLEO_LOCAL_RENDER_FALLBACK (default: only without
    # Modal) — otherwise the render fails and the job goes back to review.
    primary_path = str(Path(output_dir) / "cleo_output.mp4")
    thumbnail_path = str(Path(output_dir) / "cleo_thumbnail.jpg")
    modal_ok = False
    try:
        modal_ok = _try_modal_render(
            normalized_path=normalized_path,
            segments=segments,
            subtitles=subtitles,
            caption_preset=caption_preset,
            cut_style=settings.get("style", "balanced"),
            language=language,
            output_formats=settings.get("output_formats") or [],
            primary_out_path=primary_path,
            thumbnail_out_path=thumbnail_path,
            output_dir=output_dir,
            _stage=_stage,
            cancel_check=cancel_check,
        )
    except RenderUnavailableError as e:
        if not local_render_fallback_enabled():
            raise
        print(f"[modal] {e} — rendering locally "
              "(CLEO_LOCAL_RENDER_FALLBACK=1)", flush=True)

    if not modal_ok:
        if not local_render_fallback_enabled():
            raise RenderUnavailableError(
                "no render worker: MODAL_TOKEN_ID is not set and "
                "CLEO_LOCAL_RENDER_FALLBACK=0"
            )
        # Local path (dev without Modal, or explicitly allowed fallback)
        _stage(f"Rendering {len(segments)} clip(s)…", 0)
        burn_dir = tempfile.mkdtemp(prefix="cleo_burn_", dir=output_dir)
        clip_outputs = _multi_clip_burn(
            input_video=normalized_path,
            segments=segments,
            subtitles=subtitles,
            caption_preset=caption_preset,
            output_dir=burn_dir,
            cut_style=settings.get("style", "balanced"),
            cancel_check=cancel_check,
            language=language,
            progress_cb=_stage,
            merge_gap=0.0,  # already merged above, in sync with audio/effects
        )

        if not clip_outputs:
            raise RuntimeError("Render produced no output clips.")

        clip_paths = [p for (p, _dur) in clip_outputs]

        _stage("Stitching clips…", 80)
        # Pass source audio + original segment times so concat rebuilds
        # the audio track directly from normalized.mp4 (bit-perfect
        # source copy) instead of stream-copying MoviePy's numpy-
        # processed audio out of each burned segment.
        try:
            _ffmpeg_concat(
                clip_paths, primary_path,
                source_audio_path=normalized_path,
                audio_segments=segments,
            )
        finally:
            # Per-clip burns are only concat input — don't keep them.
            shutil.rmtree(burn_dir, ignore_errors=True)

        _generate_thumbnail(primary_path, thumbnail_path)

    # Per-segment effects (speed / fade / volume) from timeline editor.
    # Applied after concat so we can build a filter_complex that maps
    # each segment slice to its own filter chain. If any effect is a
    # no-op across the board, skip the pass entirely to save encode time.
    effects = seg_effects
    fx_applied = False
    if effects and any(
        (e.get("speed", 1.0) != 1.0)
        or (e.get("fadeIn", 0.0) > 0)
        or (e.get("fadeOut", 0.0) > 0)
        or (e.get("volume", 1.0) != 1.0)
        for e in effects
    ):
        try:
            fx_path = str(Path(output_dir) / "cleo_output_fx.mp4")
            _stage("Applying effects…", 92)
            _apply_segment_effects(
                primary_path, fx_path, segments, effects,
            )
            if Path(fx_path).exists():
                # Swap in the effects output as the new primary.
                try:
                    Path(primary_path).unlink()
                except Exception:
                    pass
                Path(fx_path).rename(primary_path)
                fx_applied = True
                # Regenerate thumbnail from post-fx primary.
                _generate_thumbnail(primary_path, thumbnail_path)
        except Exception as e:
            print(f"[effects] failed, using un-effected output: {e}",
                  flush=True)

    # Assemble outputs dict. Modal path already wrote extra-format files
    # to output_dir; local path still needs to encode them below.
    outputs: dict[str, str] = {"primary": primary_path}
    formats = settings.get("output_formats") or []
    valid_formats = [f for f in formats if f in EXPORT_FORMATS] if isinstance(formats, list) else []
    if modal_ok and not fx_applied:
        # Just pick up whatever Modal already wrote — no re-encoding.
        # (With effects applied, Modal's extra formats were cut from the
        # pre-effects primary, so they are re-exported below instead.)
        for fmt in valid_formats:
            fmt_path = str(
                Path(output_dir) / f"cleo_output_{fmt.replace(':', '-')}.mp4"
            )
            if Path(fmt_path).exists():
                outputs[fmt] = fmt_path
    if valid_formats and (not modal_ok or fx_applied):
        # Run all extra-format exports in parallel — each is an independent
        # ffmpeg pass off the same primary file, so they don't contend
        # on shared state. Cuts multi-format export time roughly Nx.
        from concurrent.futures import ThreadPoolExecutor
        _stage(f"Exporting {len(valid_formats)} extra format(s)…", 85)

        def _do_export(fmt: str) -> tuple[str, str]:
            tw, th = EXPORT_FORMATS[fmt]
            fmt_path = str(
                Path(output_dir) / f"cleo_output_{fmt.replace(':', '-')}.mp4"
            )
            _export_format(primary_path, fmt_path, tw, th)
            return fmt, fmt_path

        with ThreadPoolExecutor(max_workers=min(4, len(valid_formats))) as ex:
            for fmt, path in ex.map(_do_export, valid_formats):
                outputs[fmt] = path

    # Optional hook-clip generation: LLM picks the top short-form moments
    # out of the final timeline, ffmpeg slices them as standalone MP4s.
    # Only meaningful for content over ~2 min (single-clip videos have
    # nothing to slice into hooks).
    hook_clips: list[dict[str, Any]] = []
    if (
        settings.get("hook_clips_enabled", True)
        and len(subtitles) >= 4
        and duration is not None
        and duration >= 90.0
    ):
        try:
            from backend.llm import detect_hook_moments
            _stage("Finding hook moments…", 95)
            hooks = detect_hook_moments(
                [
                    {
                        "id": i,
                        "text": s.get("text", ""),
                        "start": s.get("start", 0.0),
                        "end": s.get("end", 0.0),
                    }
                    for i, s in enumerate(subtitles)
                ],
                language=language,
            )
            for i, h in enumerate(hooks):
                clip_path = str(Path(output_dir) / f"cleo_hook_{i + 1}.mp4")
                _stage(f"Cutting hook {i + 1}/{len(hooks)}…", 96 + i)
                try:
                    _extract_hook_clip(
                        primary_path, clip_path, h["start"], h["end"],
                    )
                    hook_clips.append({
                        "key": f"hook_{i + 1}",
                        "title": h.get("title", f"Hook {i + 1}"),
                        "reason": h.get("reason", ""),
                        "start": h["start"],
                        "end": h["end"],
                        "path": clip_path,
                    })
                    outputs[f"hook_{i + 1}"] = clip_path
                except Exception as e:
                    print(f"[hooks] clip {i + 1} extract failed: {e}",
                          flush=True)
        except Exception as e:
            print(f"[hooks] detection failed (soft): {e}", flush=True)

    _stage("Done", 100)
    return {"outputs": outputs, "hook_clips": hook_clips}
