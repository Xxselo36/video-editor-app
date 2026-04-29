"""
Video Editor - Premiere Pro Backend Server

Runs as a local HTTP server that the Premiere Pro CEP panel communicates with.
Provides video analysis (transcription, silence detection) and outputs
results in Premiere-compatible formats.

The CEP panel (HTML/JS) sends requests to this server, which runs
the analysis and returns structured data that the panel applies to
the Premiere timeline via ExtendScript.

Usage:
    python video_editor_premiere.py [--port 8456]
"""

import json
import os
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, quote
import threading
import uuid

# Path to the Video Editor installation
VIDEO_EDITOR_PATH = os.environ.get(
    "VIDEO_EDITOR_PATH",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

if VIDEO_EDITOR_PATH not in sys.path:
    sys.path.insert(0, VIDEO_EDITOR_PATH)

# Async job tracking for non-blocking analysis
_job_lock = threading.Lock()
_current_job = {
    "status": "idle",
    "progress": 0,
    "message": "",
    "segments_count": 0,
    "subtitles_count": 0,
    "error": None,
}

# German → English translations for progress messages shown in the panel
_TRANSLATIONS = [
    ("Extrahiere Audio aus Video", "Extracting audio from video"),
    ("Transkribiere Audio mit Whisper", "Transcribing audio with Whisper"),
    ("Lade Whisper Modell", "Loading Whisper model"),
    ("Analysiere Audio fuer Stille-Erkennung", "Analyzing audio for silence detection"),
    ("Sprach-Segmente", "speech segments"),
    ("Stille-Segmente gefunden", "silence segments found"),
    ("Stille-Segmente", "silence segments"),
    ("Analysiere Beats mit librosa", "Analyzing beats with librosa"),
    ("Analysiere Beats", "Analyzing beats"),
    ("Analysiere Bass-Drops", "Analyzing bass drops"),
    ("Analysiere Lautstaerke-Events", "Analyzing volume events"),
    ("Analysiere Stille", "Analyzing silence"),
    ("Analysiere Gesichter", "Analyzing faces"),
    ("Analysiere Video für Actions", "Analyzing video for actions"),
    ("Untertitel-Segmente erstellt", "subtitle segments created"),
    ("Untertitel-Segmente erkannt", "subtitle segments detected"),
    ("Untertitel hinzugefügt", "subtitles added"),
    ("Untertitel", "subtitles"),
    ("Transkribiere Audio", "Transcribing audio"),
    ("Lade Video", "Loading video"),
]


def _translate_progress(msg):
    """Translate German progress messages to English for the panel."""
    result = msg
    for de, en in _TRANSLATIONS:
        result = result.replace(de, en)
    return result


class VideoEditorHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Premiere Pro plugin."""

    _last_result = None

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._respond(200, {"status": "ok", "version": "1.0.0"})

        elif parsed.path == "/styles":
            from src.styles import get_style_info
            styles = get_style_info()
            self._respond(200, {"styles": styles})

        elif parsed.path == "/analyze":
            # GET /analyze — starts async analysis, returns immediately
            data = {k: v[0] for k, v in params.items()}
            self._handle_analyze_async(data)

        elif parsed.path == "/job-status":
            self._handle_job_status()

        elif parsed.path == "/export-xml":
            # GET /export-xml - uses last stored analysis result
            data = {k: v[0] for k, v in params.items()}
            self._handle_export_xml_from_last(data)

        elif parsed.path == "/subtitle-data":
            # GET /subtitle-data - returns subtitle timing/text as JSON for MOGRT placement
            self._handle_subtitle_data()

        elif parsed.path == "/render-srt-overlay":
            # GET /render-srt-overlay - render SRT to ProRes 4444 overlay (for DaVinci Resolve plugin)
            data = {k: v[0] for k, v in params.items()}
            self._handle_render_srt_overlay(data)

        else:
            self._respond(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")

        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._respond(400, {"error": "Invalid JSON"})
            return

        if parsed.path == "/analyze":
            self._handle_analyze(data)
        elif parsed.path == "/export-edl":
            self._handle_export_edl(data)
        elif parsed.path == "/export-xml":
            self._handle_export_xml(data)
        else:
            self._respond(404, {"error": "Not found"})

    def _handle_analyze(self, data):
        """Run video analysis and return structured results."""
        video_path = data.get("video_path")
        if not video_path or not os.path.isfile(video_path):
            self._respond(400, {"error": f"Video file not found: {video_path}"})
            return

        whisper_model = data.get("whisper_model", "medium")
        style = data.get("style", "clean")

        try:
            from src.plugin_api import analyze_video

            result = analyze_video(
                video_path=video_path,
                whisper_model=whisper_model,
                style=style,
                progress_callback=lambda msg, step=None, total_steps=None, progress=None: print(f"  {msg}"),
            )

            result_dict = result.to_dict()
            # Store for GET-based export workflow
            VideoEditorHandler._last_result = result_dict
            VideoEditorHandler._last_result["style"] = style

            self._respond(200, result_dict)

        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _handle_analyze_async(self, data):
        """Start video analysis in a background thread (non-blocking)."""
        video_path = data.get("video_path")
        if not video_path or not os.path.isfile(video_path):
            self._respond(400, {"error": f"Video file not found: {video_path}"})
            return

        whisper_model = data.get("whisper_model", "medium")
        style = data.get("style", "clean")

        with _job_lock:
            if _current_job["status"] == "processing":
                self._respond(409, {"error": "Analysis already in progress"})
                return
            _current_job.update({
                "status": "processing",
                "progress": 0,
                "message": "Starting analysis...",
                "segments_count": 0,
                "subtitles_count": 0,
                "error": None,
            })

        def run_analysis():
            try:
                from src.plugin_api import analyze_video

                def progress_cb(msg, step=None, total_steps=None, progress=None):
                    translated = _translate_progress(msg)
                    with _job_lock:
                        _current_job["message"] = translated
                        if progress is not None:
                            pct = int(progress * 100) if progress <= 1 else int(progress)
                            _current_job["progress"] = min(pct, 99)
                        elif step and total_steps:
                            _current_job["progress"] = min(int((step / total_steps) * 100), 99)
                    print(f"  {translated}")

                result = analyze_video(
                    video_path=video_path,
                    whisper_model=whisper_model,
                    style=style,
                    progress_callback=progress_cb,
                )

                result_dict = result.to_dict()
                result_dict["style"] = style
                VideoEditorHandler._last_result = result_dict

                with _job_lock:
                    _current_job.update({
                        "status": "done",
                        "progress": 100,
                        "message": "Analysis complete",
                        "segments_count": len(result_dict.get("segments", [])),
                        "subtitles_count": len(result_dict.get("subtitles", [])),
                    })

            except Exception as e:
                with _job_lock:
                    _current_job.update({
                        "status": "error",
                        "error": str(e),
                        "message": f"Error: {e}",
                    })

        thread = threading.Thread(target=run_analysis, daemon=True)
        thread.start()

        self._respond(200, {"status": "started"})

    def _handle_job_status(self):
        """Return current async job status."""
        with _job_lock:
            self._respond(200, dict(_current_job))

    def _handle_export_xml_from_last(self, data):
        """Export last analysis result as XML (for GET-based workflow)."""
        if not VideoEditorHandler._last_result:
            self._respond(400, {"error": "No analysis result. Run /analyze first."})
            return
        result = VideoEditorHandler._last_result
        self._handle_export_xml(result)

    def _handle_export_xml(self, data):
        """Export analysis results as Premiere Pro XML and save to file."""
        try:
            video_path = data.get("video_path")
            segments = data.get("segments", [])
            subtitles = data.get("subtitles", [])
            fps = data.get("fps") or None  # None = auto-detect from video
            style = data.get("style", "clean")

            if not video_path:
                self._respond(400, {"error": "video_path required"})
                return

            # Normalize rotation: if video has rotation metadata, create a copy
            # with rotation baked into pixels so Premiere shows it correctly.
            xml_video_path = _normalize_rotation(video_path)

            # Get target ratio from style config (e.g. Clean has "9:16")
            # Only apply vertical reframing if the source video is already vertical (portrait)
            from src.styles import get_style
            config = get_style(style)
            target_ratio = None
            if config.get("auto_reframe"):
                probe = _probe_video(xml_video_path)
                if probe["height"] > probe["width"]:
                    # Source is portrait — apply target ratio (e.g. "9:16")
                    target_ratio = config.get("target_ratio")
                # Source is landscape — keep original dimensions, no reframing

            import tempfile

            # Use original filename for display in Premiere (not normalized temp name)
            original_name = os.path.basename(video_path)

            # For styles with subtitles disabled (e.g. minimal), discard all subtitle data
            enable_subs = config.get("enable_subtitles", True)
            if not enable_subs:
                subtitles = []
                print(f"[VideoEditor] Style '{style}': subtitles disabled — cleared subtitle data")

            # No subtitle images on V2 — captions go on U1 via SRT
            xml = generate_premiere_xml(
                xml_video_path, segments, subtitles, fps,
                target_ratio=target_ratio, style=style,
                subtitle_images=None,
                original_name=original_name,
            )

            # Unique filenames per export using video name
            import time as _time
            video_base = os.path.splitext(os.path.basename(video_path))[0][:20]
            run_ts = int(_time.time()) % 100000

            xml_path = os.path.join(tempfile.gettempdir(), f"video_editor_{run_ts}.xml")
            with open(xml_path, "w", encoding="utf-8") as f:
                f.write(xml)

            # Generate SRT with phrase-grouped timing (matching standalone app)
            srt_path = None
            if subtitles and enable_subs:
                srt_path = os.path.join(tempfile.gettempdir(), f"{video_base}_{run_ts}.srt")
                sub_data = _generate_subtitle_text_data(subtitles, segments, style)
                srt_content = _generate_srt_from_text_data(sub_data)
                with open(srt_path, "w", encoding="utf-8") as f:
                    f.write(srt_content)

            print(f"[VideoEditor] Export: style={style}, segments={len(segments)}, srt={'YES: ' + srt_path if srt_path else 'NO'}")
            resp = {"xml_path": xml_path, "srt_path": srt_path}
            self._respond(200, resp)
        except Exception as e:
            self._respond(500, {"error": f"XML export failed: {e}"})

    def _handle_subtitle_data(self):
        """Return subtitle timing/text as JSON for MOGRT placement."""
        if not VideoEditorHandler._last_result:
            self._respond(400, {"error": "No analysis result. Run /analyze first."})
            return
        result = VideoEditorHandler._last_result
        subtitles = result.get("subtitles", [])
        # Return simplified list with start, end, text
        subs = [{"start": s["start"], "end": s["end"], "text": s.get("text", "").upper()} for s in subtitles if s.get("text", "").strip()]
        self._respond(200, {"subtitles": subs, "count": len(subs)})

    def _handle_render_srt_overlay(self, data):
        """Render SRT subtitles to a ProRes 4444 overlay video.

        Used by the DaVinci Resolve Lua plugin so it does not need a local
        Python interpreter. Same logic as plugins/davinci/render_srt_overlay.py.
        """
        try:
            srt_path = data.get("srt_path", "")
            output_path = data.get("output_path", "")
            width = int(data.get("width", 1920))
            height = int(data.get("height", 1080))
            duration = float(data.get("duration", 0))
            fps = int(data.get("fps", 30))

            if not srt_path or not os.path.isfile(srt_path):
                self._respond(400, {"error": f"SRT not found: {srt_path}"})
                return
            if not output_path:
                self._respond(400, {"error": "output_path required"})
                return
            if duration <= 0:
                self._respond(400, {"error": "duration must be > 0"})
                return

            try:
                from imageio_ffmpeg import get_ffmpeg_exe
                ffmpeg = get_ffmpeg_exe()
            except Exception:
                ffmpeg = "ffmpeg"

            fontsize = max(16, int(height * 0.028))
            margin_v = max(20, int(height * 0.05))
            outline = max(1, int(fontsize * 0.08))

            style = (
                f"PlayResX={width},"
                f"PlayResY={height},"
                f"FontName=Helvetica,"
                f"FontSize={fontsize},"
                f"PrimaryColour=&H00FFFFFF,"
                f"OutlineColour=&H80000000,"
                f"Outline={outline},"
                f"Alignment=2,"
                f"MarginV={margin_v},"
                f"Bold=1"
            )

            escaped_srt = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

            cmd = [
                ffmpeg, "-y",
                "-f", "lavfi",
                "-i", f"color=black:s={width}x{height}:d={duration}:r={fps}",
                "-vf", f"subtitles='{escaped_srt}':force_style='{style}'",
                "-c:v", "prores_ks",
                "-profile:v", "0",
                "-pix_fmt", "yuv422p10le",
                output_path,
            ]

            kwargs = {}
            if sys.platform == "win32":
                kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, **kwargs)
            if result.returncode == 0 and os.path.isfile(output_path):
                size_mb = os.path.getsize(output_path) / (1024 * 1024)
                self._respond(200, {"path": output_path, "size_mb": round(size_mb, 1)})
            else:
                err = result.stderr[-500:] if result.stderr else "ffmpeg failed"
                self._respond(500, {"error": err})
        except Exception as e:
            self._respond(500, {"error": f"render_srt_overlay failed: {e}"})

    def _handle_export_edl(self, data):
        """Export analysis results as EDL (Edit Decision List)."""
        segments = data.get("segments", [])
        fps = data.get("fps", 24)
        title = data.get("title", "SmartCut Export")

        edl = generate_edl(segments, fps, title)
        self._respond(200, {"edl": edl})

    def _respond(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[VideoEditor] {args[0]}")


def _probe_video(video_path):
    """Detect video and audio properties using ffprobe."""
    try:
        from src.ffmpeg_utils import get_ffprobe_path
        ffprobe = get_ffprobe_path()
    except Exception:
        ffprobe = "ffprobe"

    info = {
        "width": 1920, "height": 1080, "fps": 24.0, "duration": 0.0,
        "audio_channels": 2, "audio_sample_rate": 48000,
    }

    try:
        # Probe video stream — use -show_streams to get all data including side_data & tags
        cmd = [
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_streams", "-show_format",
            "-of", "json",
            video_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout)
        stream = data.get("streams", [{}])[0]
        fmt = data.get("format", {})

        w = int(stream.get("width", 1920))
        h = int(stream.get("height", 1080))

        # Check for rotation (phone videos: 90° or 270° = swap w/h)
        rotation_raw = 0
        # Method 1: side_data_list (display matrix)
        side_data = stream.get("side_data_list", [])
        for sd in side_data:
            if "rotation" in sd:
                rotation_raw = int(float(sd["rotation"]))
                break
        # Method 2: stream tags (older metadata format)
        if rotation_raw == 0:
            tags = stream.get("tags", {})
            if "rotate" in tags:
                rotation_raw = int(float(tags["rotate"]))

        # Don't swap dimensions — apply rotation via ExtendScript after import.
        # Store rotation so we can set target_ratio for correct sequence dimensions.
        info["width"] = w
        info["height"] = h
        info["rotation"] = abs(rotation_raw)       # 0, 90, or 270
        info["rotation_raw"] = rotation_raw         # signed: -90, 90, etc.

        fps_str = stream.get("r_frame_rate", "24/1")
        if "/" in fps_str:
            num, den = fps_str.split("/")
            info["fps"] = float(num) / float(den) if float(den) else 24.0
        else:
            info["fps"] = float(fps_str)

        info["duration"] = float(stream.get("duration", 0))
        if info["duration"] <= 0:
            info["duration"] = float(fmt.get("duration", 0))
    except Exception:
        pass

    try:
        # Probe audio stream
        cmd = [
            ffprobe, "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=channels,sample_rate",
            "-of", "json",
            video_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout)
        astream = data.get("streams", [{}])[0]
        info["audio_channels"] = int(astream.get("channels", 2))
        info["audio_sample_rate"] = int(astream.get("sample_rate", 48000))
    except Exception:
        pass

    return info


def _normalize_rotation(video_path):
    """If video has rotation metadata, create a copy with rotation baked into pixels.

    ffmpeg auto-rotates by default during encoding, producing a file with
    correct pixel orientation and no rotation metadata. This ensures Premiere
    shows the video correctly without any ExtendScript hacks.

    Returns the path to the normalized file, or the original path if no rotation.
    """
    probe = _probe_video(video_path)
    rot = probe.get("rotation", 0)

    if rot == 0:
        return video_path

    import hashlib
    import tempfile

    # Cache key: original path + modification time + rotation
    mtime = os.path.getmtime(video_path)
    key = f"{video_path}:{mtime}:{rot}"
    hash_str = hashlib.md5(key.encode()).hexdigest()[:12]
    basename = os.path.splitext(os.path.basename(video_path))[0][:20]
    norm_path = os.path.join(tempfile.gettempdir(), f"ve_norm_{basename}_{hash_str}.mp4")

    if os.path.exists(norm_path) and os.path.getsize(norm_path) > 0:
        print(f"[VideoEditor] Using cached normalized video: {norm_path}")
        return norm_path

    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    cmd = [
        ffmpeg, "-i", video_path,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "copy",
        "-y", norm_path,
    ]

    print(f"[VideoEditor] Normalizing rotation ({rot}°)...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode != 0:
        print(f"[VideoEditor] Normalization failed: {result.stderr[-200:]}")
        return video_path

    print(f"[VideoEditor] Normalized video saved: {norm_path}")
    return norm_path


def _fps_to_timebase_ntsc(fps):
    """Convert a float fps to (timebase, ntsc) tuple for FCP7 XML."""
    rounded = round(fps, 2)
    ntsc_map = {
        23.98: (24, True), 23.976: (24, True),
        29.97: (30, True),
        59.94: (60, True),
    }
    if rounded in ntsc_map:
        return ntsc_map[rounded]
    return (round(fps), False)


def _make_pathurl(video_path):
    """Convert a local file path to a file://localhost/ URL."""
    abs_path = os.path.abspath(video_path)
    # Normalize to forward slashes (Windows backslashes break FCP7 XML)
    abs_path = abs_path.replace("\\", "/")
    # On Windows, prepend / before drive letter (C:/... -> /C:/...)
    if not abs_path.startswith("/"):
        abs_path = "/" + abs_path
    # URL-encode the path (spaces -> %20, etc.) but keep / and :
    encoded = quote(abs_path, safe="/:")
    return f"file://localhost{encoded}"


def _generate_timeline_srt(subtitles, segments):
    """Generate SRT with times mapped to the edited timeline (not source video)."""
    timeline_subs = []
    for sub in subtitles:
        tl_start = None
        tl_end = None
        tl_pos = 0.0
        for seg_start, seg_end in segments:
            seg_dur = seg_end - seg_start
            overlap_start = max(sub["start"], seg_start)
            overlap_end = min(sub["end"], seg_end)
            if overlap_start < overlap_end:
                if tl_start is None:
                    tl_start = tl_pos + (overlap_start - seg_start)
                tl_end = tl_pos + (overlap_end - seg_start)
            tl_pos += seg_dur

        if tl_start is not None and tl_end is not None and tl_end > tl_start:
            timeline_subs.append({"start": tl_start, "end": tl_end, "text": sub.get("text", "")})

    return _generate_srt(timeline_subs)


def _render_subtitle_png(draw, font, text, width, height, sub_color, stroke_color, outline_size, shadow_offset):
    """Render styled subtitle text with multi-line wrapping, matching standalone create_dynamic_subtitle."""
    fontsize = font.size if hasattr(font, 'size') else 50

    # Split text into words and measure each (matching standalone effects.py)
    words = text.split()
    if not words:
        return

    spacing = int(fontsize * 0.3)  # 30% fontsize between words
    max_line_width = width * 0.85  # 85% of video width

    # Measure word widths
    word_widths = []
    for w in words:
        try:
            ww = int(font.getlength(w))
        except Exception:
            bbox = font.getbbox(w)
            ww = bbox[2] - bbox[0]
        word_widths.append(ww)

    # Break into lines (greedy left-to-right, matching standalone)
    lines = []  # [(start_idx, end_idx), ...]
    current_start = 0
    current_width = 0
    for i, ww in enumerate(word_widths):
        test_width = current_width + ww + (spacing if current_width > 0 else 0)
        if test_width > max_line_width and current_width > 0:
            lines.append((current_start, i))
            current_start = i
            current_width = ww
        else:
            current_width = test_width
    lines.append((current_start, len(words)))

    # Calculate vertical layout (matching standalone: centered at 70% down)
    line_height = int(fontsize * 1.3)
    total_height = line_height * len(lines)
    base_y = int(height * 0.70) - total_height // 2

    # Render each line
    for line_idx, (start, end) in enumerate(lines):
        line_words = words[start:end]
        line_widths = word_widths[start:end]

        # Line width = sum of word widths + spacing between
        line_w = sum(line_widths) + spacing * (len(line_widths) - 1)

        # Center horizontally
        x_pos = (width - line_w) // 2
        y_pos = base_y + line_idx * line_height

        # Build the line text for rendering
        line_text = " ".join(line_words)

        # Shadow (matching standalone: soft fading)
        for s in range(shadow_offset, 0, -1):
            alpha = int(100 * (s / shadow_offset))
            draw.text((x_pos + s, y_pos + s), line_text, font=font, fill=(0, 0, 0, alpha))

        # Outline (matching standalone: draw at all offset positions)
        for ox in range(-outline_size, outline_size + 1):
            for oy in range(-outline_size, outline_size + 1):
                if ox != 0 or oy != 0:
                    draw.text((x_pos + ox, y_pos + oy), line_text, font=font, fill=stroke_color)

        # Main text
        r, g, b = sub_color
        draw.text((x_pos, y_pos), line_text, font=font, fill=(r, g, b, 255))


def _generate_subtitle_images(subtitles, segments, width, height, style):
    """Generate individual RGBA PNG images per subtitle, matching standalone app.

    Subtitles from plugin_api are ALREADY mapped to timeline positions.
    For "clean" style: groups words into phrases of 4, accumulating display.
    For other styles: each word is its own clip.

    Returns list of dicts: [{"path": ..., "tl_start": ..., "tl_end": ..., "text": ...}, ...]
    """
    from PIL import Image, ImageDraw, ImageFont

    # Get style config first
    try:
        from src.styles import get_style
        config = get_style(style)
    except Exception:
        config = {}

    sub_color = config.get("subtitle_color", (255, 255, 255))
    stroke_w = config.get("subtitle_stroke_width", 4)
    enabled = config.get("enable_subtitles", True)
    sub_style = config.get("subtitle_style", "modern")
    if not enabled:
        return []

    # Subtitles already have timeline-mapped start/end from plugin_api
    # Filter matching standalone: clean >= 0.15s, others >= 0.2s
    min_dur = 0.15 if sub_style == "clean" else 0.2
    valid_subs = [s for s in subtitles
                  if s.get("text", "").strip() and (s["end"] - s["start"]) >= min_dur]

    if not valid_subs:
        return []

    # Font size: matching standalone → max(50, int(h / 25))
    fontsize = max(50, int(height / 25))
    mult = config.get("subtitle_fontsize_multiplier", 1.0)
    fontsize = int(fontsize * mult)

    # Font loading (same priority as standalone effects.py)
    font_paths = [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    font = None
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, fontsize)
                break
            except Exception:
                continue
    if font is None:
        font = ImageFont.load_default()

    shadow_offset = max(4, int(fontsize / 12))
    outline_size = max(2, stroke_w)
    stroke_color = (0, 0, 0, 255)

    import tempfile, time
    # Unique folder per export — never delete old ones so Premiere keeps linking
    run_id = int(time.time() * 1000) % 1000000
    sub_dir = os.path.join(tempfile.gettempdir(), f"video_editor_subs_{run_id}")
    os.makedirs(sub_dir, exist_ok=True)

    results = []
    img_idx = 0

    if sub_style == "clean":
        # --- CLEAN STYLE: Phrase-based accumulating subtitles ---
        # Group words into phrases of N (matching standalone editor.py)
        words_per_phrase = config.get("clean_words_per_phrase", 4)

        phrases = []
        for i in range(0, len(valid_subs), words_per_phrase):
            phrases.append(valid_subs[i:i + words_per_phrase])

        for phrase in phrases:
            words = [s["text"].strip() for s in phrase]

            for word_idx in range(len(phrase)):
                # Accumulating: show all words up to current
                shown_text = " ".join(words[:word_idx + 1]).upper()

                # Timing: word's own duration (matching standalone editor.py line 773)
                # dur = sub.end - sub.start; clip.set_start(sub.start)
                tl_start = phrase[word_idx]["start"]
                tl_end = phrase[word_idx]["end"]

                # Minimum duration 0.1s (matching standalone editor.py line 774)
                if tl_end - tl_start < 0.1:
                    tl_end = tl_start + 0.1

                # Render PNG
                img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
                draw = ImageDraw.Draw(img)
                _render_subtitle_png(draw, font, shown_text, width, height,
                                     sub_color, stroke_color, outline_size, shadow_offset)

                png_path = os.path.join(sub_dir, f"sub_{img_idx:04d}.png")
                img.save(png_path)

                # Display name shows the accumulating text
                display_name = shown_text[:40]
                results.append({
                    "path": png_path,
                    "tl_start": tl_start,
                    "tl_end": tl_end,
                    "text": display_name,
                })
                img_idx += 1
    else:
        # --- OTHER STYLES: Each word is its own clip ---
        for sub in valid_subs:
            text = sub["text"].upper()

            img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            _render_subtitle_png(draw, font, text, width, height,
                                 sub_color, stroke_color, outline_size, shadow_offset)

            png_path = os.path.join(sub_dir, f"sub_{img_idx:04d}.png")
            img.save(png_path)

            results.append({
                "path": png_path,
                "tl_start": sub["start"],
                "tl_end": sub["end"],
                "text": sub["text"],
            })
            img_idx += 1

    print(f"[VideoEditor] Generated {len(results)} subtitle images ({width}x{height}, style={sub_style}) in {sub_dir}")
    return results


def _generate_subtitle_text_data(subtitles, segments, style):
    """Generate subtitle timing + text data for XML text generators (no PNGs).

    Same phrase grouping logic as _generate_subtitle_images but only returns
    timing and text — no image rendering needed.
    """
    from src.styles import get_style
    config = get_style(style)
    sub_style = config.get("subtitle_style", "modern")
    enabled = config.get("enable_subtitles", True)
    if not enabled:
        return []

    min_dur = 0.15 if sub_style == "clean" else 0.2
    valid_subs = [s for s in subtitles
                  if s.get("text", "").strip() and (s["end"] - s["start"]) >= min_dur]

    if not valid_subs:
        return []

    results = []

    if sub_style == "clean":
        words_per_phrase = config.get("clean_words_per_phrase", 4)
        phrases = []
        for i in range(0, len(valid_subs), words_per_phrase):
            phrases.append(valid_subs[i:i + words_per_phrase])

        for phrase in phrases:
            words = [s["text"].strip() for s in phrase]
            for word_idx in range(len(phrase)):
                shown_text = " ".join(words[:word_idx + 1]).upper()
                tl_start = phrase[word_idx]["start"]
                tl_end = phrase[word_idx]["end"]
                if tl_end - tl_start < 0.1:
                    tl_end = tl_start + 0.1
                results.append({
                    "tl_start": tl_start,
                    "tl_end": tl_end,
                    "text": shown_text,
                })
    else:
        for sub in valid_subs:
            results.append({
                "tl_start": sub["start"],
                "tl_end": sub["end"],
                "text": sub["text"].upper(),
            })

    print(f"[VideoEditor] Generated {len(results)} subtitle text entries (style={sub_style})")
    return results


def _generate_srt(subtitles):
    """Generate SRT subtitle file content from subtitle list."""
    lines = []
    for i, sub in enumerate(subtitles, 1):
        start = _seconds_to_srt_time(sub["start"])
        end = _seconds_to_srt_time(sub["end"])
        text = sub.get("text", "")
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def _generate_srt_from_text_data(text_data):
    """Generate SRT from phrase-grouped text data (from _generate_subtitle_text_data)."""
    lines = []
    for i, entry in enumerate(text_data, 1):
        start = _seconds_to_srt_time(entry["tl_start"])
        end = _seconds_to_srt_time(entry["tl_end"])
        text = entry.get("text", "")
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def _seconds_to_srt_time(seconds):
    """Convert seconds to SRT time format (HH:MM:SS,mmm)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _get_subtitle_style_params(style_name, video_height):
    """Get subtitle styling parameters based on the style name.

    Returns dict with fontsize, font, color (r,g,b,a), align, and
    whether subtitles are enabled for this style.
    """
    from src.styles import get_style
    try:
        config = get_style(style_name)
    except (ValueError, ImportError):
        config = {}

    enabled = config.get("enable_subtitles", True)
    sub_style = config.get("subtitle_style", "modern")
    sub_color = config.get("subtitle_color", (255, 255, 255))
    stroke_w = config.get("subtitle_stroke_width", 4)

    # Font size for Premiere Text generator (in points, not pixels)
    # Premiere's Text generator uses smaller point sizes than standalone app's pixel sizes
    if sub_style == "clean":
        fontsize = 42
    elif sub_style == "karaoke":
        fontsize = 38
    elif sub_style == "box":
        fontsize = 36
    else:  # modern (default)
        fontsize = 36

    # Apply fontsize multiplier if present
    multiplier = config.get("subtitle_fontsize_multiplier", 1.0)
    fontsize = int(fontsize * multiplier)

    # Override fontsize if explicitly set in style
    if config.get("subtitle_fontsize"):
        fontsize = config["subtitle_fontsize"]

    return {
        "enabled": enabled,
        "sub_style": sub_style,
        "fontsize": fontsize,
        "color": {"red": sub_color[0], "green": sub_color[1], "blue": sub_color[2], "alpha": 255},
        "stroke_width": stroke_w,
        "align": 2,  # center
    }


def generate_premiere_xml(video_path, segments, subtitles, fps=None, target_ratio=None, style="clean", subtitle_overlay_path=None, subtitle_images=None, original_name=None):
    """
    Generate a Premiere Pro compatible XML (FCP7 XML format).

    Uses ffprobe to detect video properties for a complete, valid XML
    that Premiere Pro 2026 can import.
    """
    # Probe video for real properties
    info = _probe_video(video_path)
    if fps is None or fps == 0:
        fps = info["fps"]
    width = info["width"]
    height = info["height"]
    file_width = width    # Original dims for file reference
    file_height = height
    audio_channels = info["audio_channels"]
    audio_sample_rate = info["audio_sample_rate"]

    # Apply target ratio if specified (e.g. "9:16" for vertical)
    # This changes width/height for the SEQUENCE, file ref stays at original
    if target_ratio:
        try:
            rw, rh = target_ratio.split(":")
            ratio = int(rw) / int(rh)
            orig_w, orig_h = width, height
            if ratio < 1:  # Portrait (e.g. 9:16)
                width = min(orig_w, orig_h)
                height = int(width / ratio)
            else:  # Landscape
                height = min(orig_w, orig_h)
                width = int(height * ratio)
        except (ValueError, ZeroDivisionError):
            pass

    timebase, ntsc = _fps_to_timebase_ntsc(fps)
    ntsc_str = "TRUE" if ntsc else "FALSE"

    filename = original_name if original_name else os.path.basename(video_path)
    pathurl = _make_pathurl(video_path)
    seq_uuid = str(uuid.uuid4())

    # Source file total frames
    source_duration_frames = int(info["duration"] * timebase) if info["duration"] > 0 else 999999

    # Timeline total frames
    total_timeline_frames = 0
    for seg_start, seg_end in segments:
        in_f = int(seg_start * timebase)
        out_f = int(seg_end * timebase)
        total_timeline_frames += (out_f - in_f)

    # Rate block reused everywhere
    rate_xml = f"""<rate>
                            <timebase>{timebase}</timebase>
                            <ntsc>{ntsc_str}</ntsc>
                        </rate>"""

    # --- Build clipitems ---
    video_clips = []
    audio_clips_list = []  # Single stereo track (Premiere expects stereo)
    timeline_frame = 0

    for i, (seg_start, seg_end) in enumerate(segments):
        in_frame = int(seg_start * timebase)
        out_frame = int(seg_end * timebase)
        dur = out_frame - in_frame
        clip_num = i + 1

        vid_id = f"clipitem-v{clip_num}"
        aud_id = f"clipitem-a1-{clip_num}"

        # File reference: full definition only on first clip
        if i == 0:
            file_ref = f"""<file id="file-1">
                            <name>{filename}</name>
                            <pathurl>{pathurl}</pathurl>
                            {rate_xml}
                            <duration>{source_duration_frames}</duration>
                            <timecode>
                                {rate_xml}
                                <string>00:00:00:00</string>
                                <frame>0</frame>
                                <displayformat>NDF</displayformat>
                            </timecode>
                            <media>
                                <video>
                                    <samplecharacteristics>
                                        {rate_xml}
                                        <width>{file_width}</width>
                                        <height>{file_height}</height>
                                        <anamorphic>FALSE</anamorphic>
                                        <pixelaspectratio>square</pixelaspectratio>
                                        <fielddominance>none</fielddominance>
                                    </samplecharacteristics>
                                </video>
                                <audio>
                                    <samplecharacteristics>
                                        <depth>16</depth>
                                        <samplerate>{audio_sample_rate}</samplerate>
                                    </samplecharacteristics>
                                    <channelcount>2</channelcount>
                                </audio>
                            </media>
                        </file>"""
        else:
            file_ref = '<file id="file-1"/>'

        # Link block — video + one stereo audio track
        links = f"""<link>
                            <linkclipref>{vid_id}</linkclipref>
                            <mediatype>video</mediatype>
                            <trackindex>1</trackindex>
                            <clipindex>{clip_num}</clipindex>
                        </link>
                        <link>
                            <linkclipref>{aud_id}</linkclipref>
                            <mediatype>audio</mediatype>
                            <trackindex>1</trackindex>
                            <clipindex>{clip_num}</clipindex>
                            <groupindex>1</groupindex>
                        </link>"""

        # Video clipitem
        video_clips.append(f"""
                        <clipitem id="{vid_id}">
                            <masterclipid>masterclip-1</masterclipid>
                            <name>{filename}</name>
                            <enabled>TRUE</enabled>
                            <duration>{source_duration_frames}</duration>
                            {rate_xml}
                            <start>{timeline_frame}</start>
                            <end>{timeline_frame + dur}</end>
                            <in>{in_frame}</in>
                            <out>{out_frame}</out>
                            <alphatype>none</alphatype>
                            <pixelaspectratio>square</pixelaspectratio>
                            <anamorphic>FALSE</anamorphic>
                            {file_ref}
                            {links}
                        </clipitem>""")

        # Audio clipitem — always stereo for Premiere compatibility
        audio_clips_list.append(f"""
                        <clipitem id="{aud_id}" premiereChannelType="stereo">
                            <masterclipid>masterclip-1</masterclipid>
                            <name>{filename}</name>
                            <enabled>TRUE</enabled>
                            <duration>{source_duration_frames}</duration>
                            {rate_xml}
                            <start>{timeline_frame}</start>
                            <end>{timeline_frame + dur}</end>
                            <in>{in_frame}</in>
                            <out>{out_frame}</out>
                            <file id="file-1"/>
                            <sourcetrack>
                                <mediatype>audio</mediatype>
                                <trackindex>1</trackindex>
                            </sourcetrack>
                            {links}
                        </clipitem>""")

        timeline_frame += dur

    # Subtitle track on V2 — editable text generators
    subtitle_track = ""
    if subtitle_images:
        sub_clipitems = []
        for si, sub_img in enumerate(subtitle_images):
            sub_start_frame = int(sub_img["tl_start"] * timebase)
            sub_end_frame = int(sub_img["tl_end"] * timebase)
            sub_dur_frames = sub_end_frame - sub_start_frame
            if sub_dur_frames <= 0:
                continue
            sub_text = sub_img.get("text", f"Sub {si+1}")
            # Escape XML special chars in text
            safe_text = sub_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

            sub_clipitems.append(f"""
                    <generatoritem id="subtitle-{si}">
                        <name>{safe_text}</name>
                        <enabled>TRUE</enabled>
                        <duration>{sub_dur_frames}</duration>
                        {rate_xml}
                        <start>{sub_start_frame}</start>
                        <end>{sub_end_frame}</end>
                        <in>0</in>
                        <out>{sub_dur_frames}</out>
                        <anamorphic>FALSE</anamorphic>
                        <alphatype>black</alphatype>
                        <effect>
                            <name>Text</name>
                            <effectid>Text</effectid>
                            <effecttype>generator</effecttype>
                            <mediatype>video</mediatype>
                            <parameter authoringApp="PremierePro">
                                <parameterid>str</parameterid>
                                <name>Text</name>
                                <value>{safe_text}</value>
                            </parameter>
                            <parameter authoringApp="PremierePro">
                                <parameterid>fontsize</parameterid>
                                <name>Font Size</name>
                                <value>48</value>
                            </parameter>
                            <parameter authoringApp="PremierePro">
                                <parameterid>fontalign</parameterid>
                                <name>Font Alignment</name>
                                <value>2</value>
                            </parameter>
                            <parameter authoringApp="PremierePro">
                                <parameterid>fontcolor</parameterid>
                                <name>Font Color</name>
                                <value>
                                    <red>255</red>
                                    <green>255</green>
                                    <blue>255</blue>
                                    <alpha>255</alpha>
                                </value>
                            </parameter>
                        </effect>
                    </generatoritem>""")

        if sub_clipitems:
            subtitle_track = f"""
                <track>{"".join(sub_clipitems)}
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>"""

    # Markers (kept for timeline reference)
    markers_xml = ""

    # Build audio — single stereo track
    audio_tracks_xml = f"""
                <track>{"".join(audio_clips_list)}
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>"""

    output_groups = """
                    <group>
                        <index>1</index>
                        <numchannels>2</numchannels>
                        <downmix>0</downmix>
                        <channel>
                            <index>1</index>
                        </channel>
                        <channel>
                            <index>2</index>
                        </channel>
                    </group>"""

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence id="sequence-1">
        <uuid>{seq_uuid}</uuid>
        <duration>{total_timeline_frames}</duration>
        <rate>
            <timebase>{timebase}</timebase>
            <ntsc>{ntsc_str}</ntsc>
        </rate>
        <name>SmartCut - {filename}</name>
        <media>
            <video>
                <format>
                    <samplecharacteristics>
                        <rate>
                            <timebase>{timebase}</timebase>
                            <ntsc>{ntsc_str}</ntsc>
                        </rate>
                        <width>{width}</width>
                        <height>{height}</height>
                        <anamorphic>FALSE</anamorphic>
                        <pixelaspectratio>square</pixelaspectratio>
                        <fielddominance>none</fielddominance>
                        <colordepth>24</colordepth>
                    </samplecharacteristics>
                </format>
                <track>{"".join(video_clips)}
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>{subtitle_track}
            </video>
            <audio>
                <numOutputChannels>2</numOutputChannels>
                <format>
                    <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>{audio_sample_rate}</samplerate>
                    </samplecharacteristics>
                </format>
                <outputs>{output_groups}
                </outputs>{audio_tracks_xml}
            </audio>
        </media>
        <timecode>
            <rate>
                <timebase>{timebase}</timebase>
                <ntsc>{ntsc_str}</ntsc>
            </rate>
            <string>00:00:00:00</string>
            <frame>0</frame>
            <displayformat>NDF</displayformat>
        </timecode>{markers_xml}
    </sequence>
</xmeml>"""
    return xml


def generate_edl(segments, fps=24, title="SmartCut Export"):
    """
    Generate an EDL (Edit Decision List) from speech segments.

    EDL is a universal format supported by virtually all NLEs.
    """
    lines = [f"TITLE: {title}", "FCM: NON-DROP FRAME", ""]

    for i, (seg_start, seg_end) in enumerate(segments):
        edit_num = f"{i+1:03d}"
        src_in = _seconds_to_timecode(seg_start, fps)
        src_out = _seconds_to_timecode(seg_end, fps)

        # Calculate record (timeline) timecodes
        if i == 0:
            rec_in = "00:00:00:00"
        else:
            prev_durations = sum(end - start for start, end in segments[:i])
            rec_in = _seconds_to_timecode(prev_durations, fps)

        duration = seg_end - seg_start
        prev_durations = sum(end - start for start, end in segments[:i])
        rec_out = _seconds_to_timecode(prev_durations + duration, fps)

        lines.append(f"{edit_num}  AX       V     C        {src_in} {src_out} {rec_in} {rec_out}")

    return "\n".join(lines)


def _seconds_to_timecode(seconds, fps=24):
    """Convert seconds to SMPTE timecode (HH:MM:SS:FF)."""
    total_frames = int(seconds * fps)
    ff = total_frames % int(fps)
    total_seconds = total_frames // int(fps)
    ss = total_seconds % 60
    mm = (total_seconds // 60) % 60
    hh = total_seconds // 3600
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_server(port=8456):
    """Start the local backend server."""
    server = ThreadedHTTPServer(("127.0.0.1", port), VideoEditorHandler)
    print(f"SmartCut backend running on http://127.0.0.1:{port}")
    print("Waiting for Premiere Pro plugin requests...")
    print("Endpoints:")
    print(f"  GET  /health    - Health check")
    print(f"  GET  /styles    - Available styles")
    print(f"  POST /analyze   - Analyze video (transcription + cuts)")
    print(f"  POST /export-xml - Export as Premiere XML")
    print(f"  POST /export-edl - Export as EDL")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="SmartCut - Premiere Pro Backend")
    parser.add_argument("--port", type=int, default=8456)
    args = parser.parse_args()
    start_server(port=args.port)
