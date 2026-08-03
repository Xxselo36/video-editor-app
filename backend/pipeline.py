"""Web-pipeline: analyze → multi_clip_burn → concat → single MP4.

Re-uses the working Premiere-plugin code path (which already supports
voice triggers, caption presets, filler removal, etc.) and stitches the
per-segment clips into a single MP4 for the web user to download.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from src.ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path
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
    output_dir: str,
    smartcam_format: str,
    resolution: str,
    progress_cb: Callable[[str, float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> str | None:
    """Face-track-reframe the source for a target aspect (portrait/landscape).

    Re-uses the premiere-plugin SmartCam preprocess (YuNet face tracking
    + rule-of-thirds composition + letterbox-crop pre-pass + VFR→CFR
    conversion). Falls back to the original on failure.
    """
    def _sc_cb(msg: str) -> None:
        if progress_cb:
            progress_cb(msg, -1)

    out = _run_smartcam_preprocess(
        video_path=input_path,
        smartcam_format=smartcam_format,
        resolution_label=resolution,
        progress_cb=_sc_cb,
        cancel_check=cancel_check,
    )
    return out  # the premiere fn already writes to ~/Movies/Videos/.smartcut_plugin_cache


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
        "-ss", f"{start:.3f}",
        "-i", input_path,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-500:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg hook-extract failed:\n{tail}")


def _export_format(
    input_path: str,
    output_path: str,
    target_w: int,
    target_h: int,
) -> None:
    """Re-encode `input_path` to (target_w, target_h) with letterbox padding.

    Preserves the speaker (no cropping content out) — adds black bars
    on the dimension that doesn't match. Fast libx264 single-pass.
    """
    vf = (
        f"scale=w={target_w}:h={target_h}:force_original_aspect_ratio=decrease,"
        f"pad=w={target_w}:h={target_h}:x=(ow-iw)/2:y=(oh-ih)/2:color=black"
    )
    cmd = [
        get_ffmpeg_path(), "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-500:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg format-export failed:\n{tail}")


def _precheck_audio(input_path: str) -> dict:
    """Quick volume / clipping / silence check via ffmpeg volumedetect.

    Runs before the heavy pipeline so we can warn the user about a bad
    recording (muted mic, distortion, totally silent) within ~2 seconds
    instead of after a 5-minute render.

    Returns: {"mean_db": float|None, "max_db": float|None,
              "warnings": list[str]}
    """
    cmd = [
        get_ffmpeg_path(), "-hide_banner",
        "-i", input_path,
        "-af", "volumedetect",
        "-vn", "-sn", "-dn",
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


def _normalize_orientation(input_path: str, output_path: str) -> None:
    """Re-encode upload with rotation baked in, audio cleaned + LUFS-normalized.

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
    audio_chain = (
        "afftdn=nr=12:nf=-25,"  # light denoise, transparent on speech
        "loudnorm=I=-14:TP=-1.5:LRA=11"
    )
    # Cap longest side at 1920 (= 1080p output). iPhone 4K (2160×3840
    # portrait) on a small Railway container kills the libx264 encode
    # within minutes — 5-10× more pixels than 1080p with no visible
    # quality gain after the burn step re-encodes anyway. Aspect ratio
    # preserved. Even/odd-safe via -2.
    scale_filter = (
        "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(ih,iw),min(1920,ih),-2)'"
    )

    # HDR → SDR tonemap. iPhone videos (Dolby Vision / HLG) will clip to
    # pure white without this, because the 8-bit yuv420p output truncates
    # anything above SDR peak. Detect via ffprobe; skip on SDR input to
    # avoid unnecessary color-space round-trip on already-Rec709 content.
    is_hdr = _probe_hdr(input_path)
    vf = (
        f"{_HDR_TONEMAP_CHAIN},{scale_filter}" if is_hdr else scale_filter
    )

    cmd = [
        get_ffmpeg_path(), "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        # Tag output as BT.709 SDR so downstream players don't re-interpret
        # our tonemapped pixels as still-HDR.
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-af", audio_chain,
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else "(no stderr)"
        raise RuntimeError(
            f"ffmpeg orientation-normalize failed (hdr={is_hdr}):\n{tail}"
        )


def _ffmpeg_cuts_preview(
    input_path: str,
    segments: list[tuple[float, float]],
    output_path: str,
) -> None:
    """Produce a fast preview MP4 of the source with cut segments concatenated.

    Single-pass `filter_complex` so the user can scrub in the browser
    against the actual edit timeline (silence/fillers/voice-trigger
    ranges already removed). No captions burned in — those will be
    overlaid live in the UI for the review step.
    """
    if not segments:
        raise ValueError("no segments to preview")

    filters = []
    parts = []
    for i, (s, e) in enumerate(segments):
        filters.append(
            f"[0:v]trim={s:.3f}:{e:.3f},setpts=PTS-STARTPTS[v{i}]"
        )
        filters.append(
            f"[0:a]atrim={s:.3f}:{e:.3f},asetpts=PTS-STARTPTS[a{i}]"
        )
        parts.append(f"[v{i}][a{i}]")
    filters.append(
        f"{''.join(parts)}concat=n={len(segments)}:v=1:a=1[outv][outa]"
    )

    # Cap the preview at 720p on the longest side so iOS Safari can
    # play it inline — 4K MP4s often fail to start on the phone.
    filters[-1] = filters[-1].replace(
        "[outv]",
        "[outvfull]",
    )
    filters.append(
        "[outvfull]scale='if(gt(iw,ih),720,-2)':'if(gt(ih,iw),720,-2)'[outv]"
    )

    cmd = [
        get_ffmpeg_path(), "-y",
        "-i", input_path,
        "-filter_complex", ";".join(filters),
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg preview-cut failed:\n{tail}")


def _generate_thumbnail(input_path: str, output_path: str, at_seconds: float = 1.0) -> None:
    """Extract a JPG poster frame from the rendered video.

    ~320px wide, aspect-preserving. Used by the Library UI so we can
    show a visual for each project without loading the whole video.
    Silent on any failure — a missing thumbnail just means the card
    falls back to the plain text layout, nothing breaks.
    """
    cmd = [
        get_ffmpeg_path(), "-y",
        "-ss", str(at_seconds),
        "-i", input_path,
        "-frames:v", "1",
        "-vf", "scale=320:-2",
        "-q:v", "3",
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if result.returncode != 0 and at_seconds > 0:
            # Fallback: very short clips can't seek to 1s — try frame 0
            _generate_thumbnail(input_path, output_path, at_seconds=0.0)
    except Exception as e:
        print(f"[thumbnail] extract failed: {e}", flush=True)


def _ffmpeg_concat(clip_paths: list[str], output_path: str) -> None:
    """Concatenate clips through the concat demuxer, re-encoding output.

    The old `-c copy` version was fast but produced three visible
    artifacts at every cut boundary: audible clicks (raw AAC frame
    joins), occasional black frames (segment I-frame gaps), and AV
    drift (per-segment timebase rounding accumulates).

    Re-encoding on the output side fixes all three by re-writing every
    frame with a unified timebase and consistent codec params. Adds
    ~10-20s per render but the artifacts are gone.
    """
    if not clip_paths:
        raise ValueError("no clips to concat")

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False
    ) as f:
        list_path = f.name
        for p in clip_paths:
            f.write(f"file '{p}'\n")

    cmd = [
        get_ffmpeg_path(), "-y",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
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
) -> dict[str, Any]:
    """Normalize + run analysis. Returns dict with the pieces the render
    step + the subtitle-editor UI need.

    Result keys:
      - normalized_path: where the rotation-fixed MP4 lives
      - segments: list of (start, end) speech segments after cuts
      - subtitles: list of {start, end, text, original_start, original_end}
      - language: ISO code from Whisper
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    style_map = {"tight": "fast", "balanced": "smooth", "smooth": "smooth"}
    style = style_map.get(settings.get("style", "balanced"), "smooth")

    voice_triggers = settings.get("voice_triggers", True)
    remove_fillers = settings.get("remove_fillers", True)
    whisper_model = settings.get("whisper_model", "small")
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

    _stage("Checking audio…", 1)
    audio_precheck = _precheck_audio(input_path)

    _stage("Preparing video…", 3)
    normalized_path = str(Path(output_dir) / "normalized.mp4")
    _normalize_orientation(input_path, normalized_path)

    # Optional SmartCam reframe — runs ONCE for the primary aspect the
    # user selected. Other multi-format outputs derive from the rendered
    # primary via simple letterbox-pad in the render step.
    if settings.get("smartcam_enabled"):
        sc_format = settings.get("smartcam_format", "portrait")
        sc_resolution = settings.get("resolution", "1080")
        _stage(f"SmartCam tracking faces ({sc_format})…", 6)
        sc_out = _smartcam_reframe(
            normalized_path, output_dir, sc_format, sc_resolution,
            progress_cb=progress_cb,
        )
        if sc_out and Path(sc_out).exists():
            normalized_path = sc_out
        else:
            print("[smartcam] reframe returned no file — falling back to source",
                  flush=True)

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
    try:
        from backend.llm import cleanup_and_detect_bad_takes
        llm_input = [
            {
                "id": i,
                "text": s.get("text", ""),
                "start": s.get("start"),
                "end": s.get("end"),
            }
            for i, s in enumerate(subtitles)
        ]
        llm_res = cleanup_and_detect_bad_takes(
            llm_input, language=result.language,
        )
        # Apply cleaned text in place
        for i, s in enumerate(subtitles):
            cleaned = llm_res.get("cleaned", {}).get(i)
            if cleaned:
                s["text"] = cleaned
        # Build bad-take removal ranges from flagged phrase ids.
        # These get added to cut_ranges so the user can see + undo them
        # alongside the rule-based cuts in the timeline.
        bad_take_cut_ranges: list[tuple[float, float]] = []
        for pid in llm_res.get("bad_takes", []) or []:
            if 0 <= pid < len(subtitles):
                s = subtitles[pid]
                bs = float(s.get("original_start") or s.get("start") or 0)
                be = float(s.get("original_end") or s.get("end") or bs)
                if be > bs:
                    bad_take_cut_ranges.append((bs, be))
        # Apply bad-take cuts to segments + drop flagged subtitles.
        if bad_take_cut_ranges:
            print(f"[llm] {len(bad_take_cut_ranges)} bad-take range(s) flagged",
                  flush=True)
            segments = _apply_extra_cuts(segments, bad_take_cut_ranges)
            flagged = set(llm_res.get("bad_takes", []) or [])
            subtitles = [s for i, s in enumerate(subtitles) if i not in flagged]
    except Exception as e:
        print(f"[llm] cleanup pass failed (soft): {e}", flush=True)

    # Compute the cut ranges (inverse of kept segments) so the user can
    # see exactly what's being removed, and tap to disable individual
    # cuts on the timeline. Includes the LLM bad-takes from above.
    cut_ranges = _invert_segments(segments, duration)

    _stage("Building preview…", 95)
    preview_path = str(Path(output_dir) / "preview.mp4")
    _ffmpeg_cuts_preview(normalized_path, segments, preview_path)

    return {
        "normalized_path": normalized_path,
        "preview_path": preview_path,
        "segments": segments,
        "subtitles": subtitles,
        "duration": duration,
        "cut_ranges": cut_ranges,
        "language": result.language,
        "audio_warnings": audio_precheck.get("warnings", []),
        "audio_levels": {
            "mean_db": audio_precheck.get("mean_db"),
            "max_db": audio_precheck.get("max_db"),
        },
    }


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

    def _stage(msg: str, pct: float) -> None:
        if progress_cb:
            progress_cb(msg, pct)

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
    )

    if not clip_outputs:
        raise RuntimeError("Render produced no output clips.")

    clip_paths = [p for (p, _dur) in clip_outputs]
    primary_path = str(Path(output_dir) / "cleo_output.mp4")

    _stage("Stitching clips…", 80)
    _ffmpeg_concat(clip_paths, primary_path)

    # Poster-frame thumbnail for the Library card — one JPG per job
    # at a fixed filename beside the primary output so the endpoint
    # can find it without needing a schema field.
    thumbnail_path = str(Path(output_dir) / "cleo_thumbnail.jpg")
    _generate_thumbnail(primary_path, thumbnail_path)

    # Multi-format export: keep the primary as-is, derive additional
    # aspect ratios via simple letterbox pad. User picks which ones in
    # settings; default is just the primary.
    outputs: dict[str, str] = {"primary": primary_path}
    formats = settings.get("output_formats") or []
    if isinstance(formats, list) and formats:
        total = len([f for f in formats if f in EXPORT_FORMATS])
        for i, fmt in enumerate(formats):
            if fmt not in EXPORT_FORMATS:
                continue
            tw, th = EXPORT_FORMATS[fmt]
            _stage(f"Exporting {fmt}…", 80 + int(15 * (i + 1) / max(1, total)))
            fmt_path = str(
                Path(output_dir) / f"cleo_output_{fmt.replace(':', '-')}.mp4"
            )
            _export_format(primary_path, fmt_path, tw, th)
            outputs[fmt] = fmt_path

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
