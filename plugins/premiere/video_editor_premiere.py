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

# Caption preset configurations — override style subtitle settings
CAPTION_PRESETS = {
    "classic": {
        "subtitle_font": "Arial Black",
        "subtitle_color": (255, 255, 255),
        "subtitle_outline_color": "#000000",
        "subtitle_stroke_width": 3,
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_highlight_color_hex": None,
    },
    "karaoke": {
        "subtitle_font": "Arial Black",
        "subtitle_color": (255, 255, 255),
        "subtitle_highlight_color_hex": "#6c5ce7",
        "subtitle_position": "center",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": False,
    },
    "boxed": {
        "subtitle_font": "Arial",
        "subtitle_color": (255, 255, 255),
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": True,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.7,
        "subtitle_stroke_width": 0,
    },
    "neon": {
        "subtitle_font": "Arial Black",
        "subtitle_color": (0, 255, 213),
        "subtitle_outline_color": "#00ffd5",
        "subtitle_stroke_width": 0,
        "subtitle_position": "center",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": False,
    },
    "bold": {
        "subtitle_font": "Impact",
        "subtitle_color": (255, 255, 255),
        "subtitle_stroke_width": 2,
        "subtitle_position": "center",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": False,
    },
    "minimal": {
        "subtitle_font": "Arial",
        "subtitle_color": (180, 180, 180),
        "subtitle_stroke_width": 1,
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.90,
        "subtitle_fontsize_multiplier": 0.7,
        "subtitle_bg_enabled": False,
    },
    "gradient": {
        "subtitle_font": "Arial Black",
        "subtitle_color": (255, 255, 255),
        "subtitle_highlight_color_hex": "#e84393",
        "subtitle_position": "center",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": False,
    },
    "none": {
        "enable_subtitles": False,
    },
}

# Async job tracking for non-blocking analysis
_job_lock = threading.Lock()
_current_job = {
    "status": "idle",
    "progress": 0,
    "message": "",
    "segments_count": 0,
    "subtitles_count": 0,
    "fillers_count": 0,
    "error": None,
    # Enhanced progress tracking
    "transcript_words": [],   # [{"word": str, "is_filler": bool, "start": float, "end": float}]
    "segments": [],           # [{"start": float, "end": float, "type": "speech"|"silence"|"filler"}]
    "stats": {
        "cuts": 0,
        "silence_removed": 0.0,
        "fillers_removed": 0.0,
        "original_duration": 0.0,
        "edited_duration": 0.0,
    },
    "phases": [],             # [{"name": str, "status": "pending"|"running"|"done", "detail": str}]
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


def _parse_bool(value, default=True):
    """Parse a bool from request data (handles str, bool, None)."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("1", "true", "yes")
    return bool(value)


def _parse_keywords(value):
    """Parse a comma-separated keyword list from the panel.

    Empty / missing → None (backend falls back to its own defaults).
    Whitespace and empty entries are stripped.
    """
    if not value:
        return None
    if isinstance(value, list):
        items = value
    else:
        items = str(value).split(",")
    cleaned = [s.strip() for s in items if s and s.strip()]
    return cleaned or None


def _update_phases(message, phases):
    """Update phase statuses based on progress message keywords."""
    msg_lower = message.lower()

    # Phase detection mapping: keyword -> phase index
    phase_triggers = [
        (["transcrib", "whisper", "loading whisper", "extracting audio"], 0),
        (["detecting speech", "silence detection", "speech segments", "silence segments", "analyzing audio", "analyzing silence"], 1),
        (["filler word", "detecting filler", "removing filler"], 2),
        (["optimizing cut", "smart cut", "mapping subtitle"], 3),
    ]

    for keywords, idx in phase_triggers:
        if idx < len(phases):
            for kw in keywords:
                if kw in msg_lower:
                    # Mark this phase as running
                    if phases[idx]["status"] != "done":
                        phases[idx]["status"] = "running"
                        phases[idx]["detail"] = message
                    # Mark all previous phases as done
                    for prev in range(idx):
                        if phases[prev]["status"] != "done":
                            phases[prev]["status"] = "done"
                    break

    # Extract numeric details from messages
    for idx, phase in enumerate(phases):
        if phase["status"] == "running":
            # Try to extract counts from messages like "Found 15 silence segments"
            import re
            count_match = re.search(r'(\d+)\s+(speech|silence|subtitle|filler)', msg_lower)
            if count_match:
                phase["detail"] = message


def _build_transcript_words(subtitles, fillers):
    """Build transcript word list from subtitles, marking fillers."""
    filler_words_set = set()
    filler_ranges = []
    for f in fillers:
        filler_words_set.add(f["word"].lower().strip())
        filler_ranges.append((f["start"], f["end"]))

    words = []
    for sub in subtitles:
        # Use original timestamps if available, otherwise mapped timestamps
        orig_start = sub.get("original_start", sub["start"])
        orig_end = sub.get("original_end", sub["end"])
        text = sub.get("text", "").strip()
        if not text:
            continue

        # Check if this word overlaps with any filler range
        is_filler = False
        for fs, fe in filler_ranges:
            if orig_start < fe and orig_end > fs:
                is_filler = True
                break

        words.append({
            "word": text,
            "is_filler": is_filler,
            "start": round(orig_start, 3),
            "end": round(orig_end, 3),
        })
    return words


def _build_timeline_segments(speech_segments, fillers, duration):
    """Build timeline segments with types for visualization."""
    if not speech_segments or duration <= 0:
        return []

    # Build filler ranges for overlap checking
    filler_ranges = [(f["start"], f["end"]) for f in fillers]

    timeline = []
    prev_end = 0.0

    for start, end in sorted(speech_segments):
        # Add silence gap before this speech segment
        if start > prev_end + 0.01:
            timeline.append({
                "start": round(prev_end, 3),
                "end": round(start, 3),
                "type": "silence",
            })

        # Check if this speech segment contains filler overlap
        # Split into sub-segments if needed (simplified: mark whole segment)
        has_filler = False
        for fs, fe in filler_ranges:
            if start < fe and end > fs:
                has_filler = True
                break

        timeline.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "type": "speech",
        })

        prev_end = end

    # Add trailing silence
    if prev_end < duration - 0.01:
        timeline.append({
            "start": round(prev_end, 3),
            "end": round(duration, 3),
            "type": "silence",
        })

    # Add filler segments as separate entries for visualization
    for f in fillers:
        timeline.append({
            "start": round(f["start"], 3),
            "end": round(f["end"], 3),
            "type": "filler",
        })

    return timeline


# ----------------------------------------------------------------------------
# Subprocess tracking — /cancel walks this set and SIGTERMs each running
# ffmpeg / MoviePy child so the user gets an instant abort instead of having
# to wait for the current render to finish.
# ----------------------------------------------------------------------------
_active_subprocs = set()
_active_subprocs_lock = threading.Lock()


def _track_subprocess(proc):
    with _active_subprocs_lock:
        _active_subprocs.add(proc)
    return proc


def _untrack_subprocess(proc):
    with _active_subprocs_lock:
        _active_subprocs.discard(proc)


def _kill_active_subprocesses():
    """Hard-kill every render-related child process.

    Tracked subprocesses (our own subprocess.Popen handles) are
    terminated directly. We *also* walk this Python process's children
    via psutil and kill any ffmpeg/ffprobe descendants — MoviePy's
    `write_videofile` spawns ffmpeg internally via its own Popen, which
    isn't in our tracked set. Without this, cancel left a 600%-CPU
    ffmpeg orphan chewing the source clip in the background.
    """
    import time as _time
    # 1) Tracked subprocs (our own ffmpeg extract calls in _multi_clip_burn)
    with _active_subprocs_lock:
        procs = list(_active_subprocs)
    for p in procs:
        try:
            if p.poll() is None:
                p.terminate()
        except Exception:
            pass

    # 2) ffmpeg/ffprobe descendants of the current Python process — this
    #    catches the MoviePy-spawned writer and the SmartCam OpenCV reads.
    children_killed = []
    try:
        import psutil
        me = psutil.Process(os.getpid())
        for child in me.children(recursive=True):
            try:
                name = (child.name() or "").lower()
                if "ffmpeg" in name or "ffprobe" in name:
                    child.terminate()
                    children_killed.append(child.pid)
            except Exception:
                pass
    except Exception as e:
        print(f"[kill] psutil walk failed: {e}", flush=True)

    _time.sleep(0.3)

    # Force-kill anything that survived SIGTERM
    for p in procs:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    try:
        import psutil
        me = psutil.Process(os.getpid())
        for child in me.children(recursive=True):
            try:
                name = (child.name() or "").lower()
                if "ffmpeg" in name or "ffprobe" in name:
                    child.kill()
            except Exception:
                pass
    except Exception:
        pass
    if children_killed:
        print(f"[kill] terminated ffmpeg children: {children_killed}",
              flush=True)


class VideoEditorHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Premiere Pro plugin."""

    _last_result = None
    _last_xml_path = None
    # Cancellation flag — flipped by POST /cancel. The analyze worker and
    # the multi-clip render loop both poll it between heavy steps and
    # bail out fast when the user hits Cancel in the panel.
    _cancel_requested = False
    # Reference to the currently-running analyze worker thread.
    _worker_thread = None
    # Number of finalize calls currently in flight. Finalize runs in the
    # HTTP request thread (synchronous), so we count it explicitly so
    # /cancel knows when ALL background work has stopped.
    _finalize_count = 0
    _finalize_lock = threading.Lock()
    # Monoton steigender Counter pro erfolgreichem Run — wird für die
    # Sequenz-Beschriftung "SmartCut · Clipper · #3" genutzt, damit der
    # User mehrere Runs des gleichen Source-Videos unterscheiden kann.
    _run_counter = 0
    _run_counter_lock = threading.Lock()

    # Endpoints that require an active SmartCut license. /health, /styles
    # and /license-status are intentionally NOT here so plugins can probe
    # the backend without licensing.
    _LICENSE_GATED_PATHS = {
        "/analyze", "/render-srt-overlay",
        "/export-edl", "/export-xml",
    }

    @staticmethod
    def _license_check():
        """Return (ok, msg). Defaults to allow-through if license module
        can't be imported (e.g. running outside the app bundle)."""
        try:
            from src.license import check_license
            return check_license()
        except Exception:
            return True, "license module unavailable"

    def _gate_license(self):
        """If the requested path needs a license and there isn't one, send a
        403 + structured error and return True (= request was handled)."""
        from urllib.parse import urlparse as _up
        path = _up(self.path).path
        if path not in self._LICENSE_GATED_PATHS:
            return False
        ok, msg = self._license_check()
        if ok:
            return False
        self._respond(403, {
            "error": "license_required",
            "message": msg or "SmartCut license is inactive. "
                              "Please open SmartCut and re-activate.",
        })
        return True

    def do_GET(self):
        if self._gate_license():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            ok, msg = self._license_check()
            self._respond(200, {
                "status": "ok",
                "version": "1.0.0",
                "licensed": bool(ok),
                "license_message": msg,
            })

        elif parsed.path == "/license-status":
            ok, msg = self._license_check()
            self._respond(200, {"licensed": bool(ok), "message": msg})

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

        elif parsed.path == "/subtitles":
            # GET /subtitles — return current subtitles from last analyze
            # (used by panel to render the editor UI).
            if not VideoEditorHandler._last_result:
                self._respond(400, {"error": "No analyze result"})
            else:
                subs = VideoEditorHandler._last_result.get("subtitles", [])
                self._respond(200, {"subtitles": subs})

        elif parsed.path == "/thumbnail":
            # GET /thumbnail?video_path=... — return a base64-encoded JPEG
            # thumbnail (192px wide) of the video so the panel can show
            # the actual clip instead of just its filename.
            data = {k: v[0] for k, v in params.items()}
            video_path = data.get("video_path", "")
            if not video_path or not os.path.isfile(video_path):
                self._respond(400, {"error": "video_path missing or not a file"})
            else:
                try:
                    b64 = _make_thumbnail_b64(video_path)
                    self._respond(200, {"thumbnail": b64})
                except Exception as e:
                    self._respond(500, {"error": str(e)})

        elif parsed.path == "/probe-orientation":
            # GET /probe-orientation?video_path=... — fast orientation check so
            # the plugin UI can grey out incompatible options before /analyze.
            data = {k: v[0] for k, v in params.items()}
            video_path = data.get("video_path", "")
            if not video_path or not os.path.isfile(video_path):
                self._respond(400, {"error": "video_path missing or not a file"})
            else:
                self._respond(200, {"orientation": _detect_orientation(video_path)})

        else:
            self._respond(404, {"error": "Not found"})

    def do_POST(self):
        if self._gate_license():
            return
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
        elif parsed.path == "/finalize-with-overlay":
            self._handle_finalize_with_overlay(data)
        elif parsed.path == "/cancel":
            # The /cancel endpoint is intentionally BLOCKING: it returns
            # only once the worker thread has fully exited and all child
            # ffmpegs are dead. That way the panel can rely on a clean
            # state the moment /cancel responds, and the user can click
            # Process immediately after with no 409s, no "previous run
            # still finishing", no auto-aborts.
            VideoEditorHandler._cancel_requested = True
            with _job_lock:
                if _current_job["status"] == "processing":
                    _current_job["status"] = "cancelling"
                    _current_job["message"] = "Cancelling…"
            print("[VideoEditor] /cancel — cancellation requested", flush=True)
            try:
                _kill_active_subprocesses()
            except Exception as _e:
                print(f"[VideoEditor] kill subprocs failed: {_e}", flush=True)

            # Wait for the analyze worker thread to exit.
            worker = VideoEditorHandler._worker_thread
            if worker is not None and worker.is_alive():
                worker.join(timeout=15.0)

            # ALSO wait for any in-flight finalize call (runs in its own
            # HTTP request thread, can't be join()ed directly). Poll the
            # counter — most cancellations clear it in <1s now that we
            # SIGKILL the ffmpeg children that were blocking MoviePy.
            import time as _time
            deadline = _time.time() + 15.0
            while _time.time() < deadline:
                with VideoEditorHandler._finalize_lock:
                    if VideoEditorHandler._finalize_count == 0:
                        break
                # Re-kill stragglers each cycle; MoviePy will sometimes
                # respawn after the first kill.
                try:
                    _kill_active_subprocesses()
                except Exception:
                    pass
                _time.sleep(0.2)
            # One final cleanup pass.
            try:
                _kill_active_subprocesses()
            except Exception:
                pass

            # Wipe all cached analyze state so a new run starts from a
            # truly clean slate — no piled-up subtitles, no stale XML
            # path being re-imported, no leftover transcript/segments
            # from the cancelled run.
            VideoEditorHandler._last_result = None
            VideoEditorHandler._last_xml_path = None
            with _job_lock:
                _current_job.update({
                    "status": "cancelled",
                    "progress": 0,
                    "message": "Cancelled by user",
                    "segments_count": 0,
                    "subtitles_count": 0,
                    "fillers_count": 0,
                    "error": None,
                    "transcript_words": [],
                    "segments": [],
                    "stats": {
                        "cuts": 0, "silence_removed": 0.0,
                        "fillers_removed": 0.0,
                        "original_duration": 0.0, "edited_duration": 0.0,
                    },
                    "phases": [],
                })

            print("[VideoEditor] /cancel — cancellation complete", flush=True)
            self._respond(200, {"cancelled": True})
        else:
            self._respond(404, {"error": "Not found"})

    def _handle_analyze(self, data):
        """Run video analysis and return structured results."""
        original_video_path = data.get("video_path")
        if not original_video_path or not os.path.isfile(original_video_path):
            self._respond(400, {"error": f"Video file not found: {original_video_path}"})
            return

        whisper_model = data.get("whisper_model", "medium")
        style = _map_cut_to_style(data.get("style", "clean"))
        remove_fillers = _parse_bool(data.get("remove_fillers"), default=True)
        smart_cut = _parse_bool(data.get("smart_cut"), default=True)
        filler_sensitivity = data.get("filler_sensitivity", "medium")
        voice_triggers = _parse_bool(data.get("voice_triggers"), default=False)
        cut_keywords = _parse_keywords(data.get("cut_keywords"))
        continue_keywords = _parse_keywords(data.get("continue_keywords"))
        smartcam_enabled = _parse_bool(data.get("smartcam_enabled"), default=False)
        smartcam_format = data.get("smartcam_format", "portrait")
        resolution = data.get("resolution", "1080")

        # SmartCam preprocess (face-tracking reframe BEFORE silence/cut analysis).
        # On success the rest of the pipeline operates on the reframed video,
        # so subtitle timings + cut offsets line up with the final crop.
        effective_path = original_video_path
        smartcam_video_path = None
        if smartcam_enabled:
            reframed = _run_smartcam_preprocess(
                original_video_path, smartcam_format, resolution,
                progress_cb=lambda m: print(f"  {m}"),
            )
            if reframed:
                effective_path = reframed
                smartcam_video_path = reframed

        try:
            from src.plugin_api import analyze_video

            result = analyze_video(
                video_path=effective_path,
                whisper_model=whisper_model,
                style=style,
                remove_fillers=remove_fillers,
                smart_cut=smart_cut,
                filler_sensitivity=filler_sensitivity,
                voice_triggers=voice_triggers,
                cut_keywords=cut_keywords,
                continue_keywords=continue_keywords,
                progress_callback=lambda msg, step=None, total_steps=None, progress=None: print(f"  {msg}"),
            )

            result_dict = result.to_dict()
            # to_dict() strips original_start/original_end — but the
            # subtitle burn-in step needs SOURCE timestamps. Re-attach
            # the full mapped subtitle dicts from `result.subtitles`.
            result_dict["subtitles"] = list(result.subtitles) if isinstance(result.subtitles, list) else result_dict["subtitles"]
            # Surface SmartCam metadata so the host app (Premiere ExtendScript /
            # DaVinci Lua) imports the reframed clip rather than the original.
            result_dict["smartcam_enabled"] = smartcam_enabled
            result_dict["smartcam_format"] = smartcam_format if smartcam_enabled else None
            result_dict["smartcam_video_path"] = smartcam_video_path
            result_dict["original_video_path"] = original_video_path
            # Store for GET-based export workflow
            VideoEditorHandler._last_result = result_dict
            VideoEditorHandler._last_result["style"] = style

            self._respond(200, result_dict)

        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _handle_analyze_async(self, data):
        """Start video analysis in a background thread (non-blocking)."""
        original_video_path = data.get("video_path")
        if not original_video_path or not os.path.isfile(original_video_path):
            self._respond(400, {"error": f"Video file not found: {original_video_path}"})
            return

        whisper_model = data.get("whisper_model", "medium")
        style = _map_cut_to_style(data.get("style", "clean"))
        remove_fillers = _parse_bool(data.get("remove_fillers"), default=True)
        smart_cut = _parse_bool(data.get("smart_cut"), default=True)
        filler_sensitivity = data.get("filler_sensitivity", "medium")
        caption_preset = data.get("caption_preset", "classic")
        smartcam_enabled = _parse_bool(data.get("smartcam_enabled"), default=False)
        voice_triggers = _parse_bool(data.get("voice_triggers"), default=False)
        cut_keywords = _parse_keywords(data.get("cut_keywords"))
        continue_keywords = _parse_keywords(data.get("continue_keywords"))
        try:
            trim_start = float(data.get("trim_start", "")) if data.get("trim_start") else None
        except (TypeError, ValueError):
            trim_start = None
        try:
            trim_end = float(data.get("trim_end", "")) if data.get("trim_end") else None
        except (TypeError, ValueError):
            trim_end = None
        smartcam_format = data.get("smartcam_format", "portrait")
        resolution = data.get("resolution", "1080")
        # Untertitel-Position (0..1, oben→unten) und Größen-Multiplier vom
        # Panel. Defaults entsprechen den styles.py-Werten.
        try:
            sub_pos = float(data.get("sub_pos", 0.85))
        except (TypeError, ValueError):
            sub_pos = 0.85
        try:
            sub_size = float(data.get("sub_size", 1.0))
        except (TypeError, ValueError):
            sub_size = 1.0
        sub_pos = max(0.05, min(0.98, sub_pos))
        sub_size = max(0.4, min(2.0, sub_size))

        with _job_lock:
            if _current_job["status"] in ("processing", "cancelling"):
                self._respond(409, {
                    "error": (
                        "Cancelling previous run — please wait"
                        if _current_job["status"] == "cancelling"
                        else "Analysis already in progress"
                    )
                })
                return

        # Previous-worker check removed along with the Cancel button —
        # without cancellation there's no scenario where the worker is
        # alive while status != "processing". (Status check above
        # already rejects in that case.)
            _current_job.update({
                "status": "processing",
                "progress": 0,
                "message": "Starting analysis...",
                "segments_count": 0,
                "subtitles_count": 0,
                "fillers_count": 0,
                "error": None,
                "transcript_words": [],
                "segments": [],
                "stats": {
                    "cuts": 0,
                    "silence_removed": 0.0,
                    "fillers_removed": 0.0,
                    "original_duration": 0.0,
                    "edited_duration": 0.0,
                },
                "phases": [
                    {"name": "Transcribing audio", "status": "pending", "detail": ""},
                    {"name": "Detecting speech segments", "status": "pending", "detail": ""},
                    {"name": "Detecting filler words", "status": "pending", "detail": ""},
                    {"name": "Optimizing cuts", "status": "pending", "detail": ""},
                ],
            })

        # Clear cancellation flag AND any cached prior-run data so a
        # mid-run /subtitles fetch can't return stale subtitles from the
        # previous analyze (which was producing the "subtitles piled up"
        # state in the editor between runs).
        VideoEditorHandler._cancel_requested = False
        VideoEditorHandler._last_result = None
        VideoEditorHandler._last_xml_path = None

        def _cancel_check():
            return VideoEditorHandler._cancel_requested

        def run_analysis():
            try:
                from src.plugin_api import analyze_video

                def progress_cb(msg, step=None, total_steps=None, progress=None):
                    if _cancel_check():
                        raise InterruptedError("Cancelled by user")
                    translated = _translate_progress(msg)
                    with _job_lock:
                        _current_job["message"] = translated
                        if progress is not None:
                            pct = int(progress * 100) if progress <= 1 else int(progress)
                            _current_job["progress"] = min(pct, 99)
                        elif step and total_steps:
                            _current_job["progress"] = min(int((step / total_steps) * 100), 99)
                        # Update phases based on progress message
                        _update_phases(translated, _current_job["phases"])
                    print(f"  {translated}")

                # If the user trimmed the clip in Premiere, slice that
                # range out of the source first. ffmpeg stream-copy is
                # near-instant for typical MP4/MOV sources and gives
                # SmartCam / Whisper / silence-detection only the bytes
                # the user actually wants edited.
                analyze_input_path = original_video_path
                if (trim_start is not None and trim_end is not None
                        and trim_end > trim_start):
                    with _job_lock:
                        _current_job["message"] = (
                            f"Trimming source ({trim_start:.1f}s – "
                            f"{trim_end:.1f}s)…"
                        )
                    trimmed = _extract_trim_range(
                        original_video_path, trim_start, trim_end,
                    )
                    if trimmed:
                        analyze_input_path = trimmed
                        print(f"[trim] using {trimmed}", flush=True)

                # SmartCam preprocess — reframe before analysis so cut+subtitle
                # offsets line up with the final crop.
                effective_path = analyze_input_path
                smartcam_video_path = None
                if smartcam_enabled:
                    with _job_lock:
                        _current_job["message"] = "SmartCam: tracking faces…"
                    def _sc_cb(m):
                        with _job_lock:
                            _current_job["message"] = m
                        print(f"  {m}")
                    reframed = _run_smartcam_preprocess(
                        analyze_input_path, smartcam_format, resolution,
                        progress_cb=_sc_cb,
                        cancel_check=_cancel_check,
                    )
                    if reframed:
                        effective_path = reframed
                        smartcam_video_path = reframed

                result = analyze_video(
                    video_path=effective_path,
                    whisper_model=whisper_model,
                    style=style,
                    remove_fillers=remove_fillers,
                    smart_cut=smart_cut,
                    filler_sensitivity=filler_sensitivity,
                    voice_triggers=voice_triggers,
                    cut_keywords=cut_keywords,
                    continue_keywords=continue_keywords,
                    progress_callback=progress_cb,
                    cancel_check=_cancel_check,
                )

                result_dict = result.to_dict()
                # to_dict() strips original_start/original_end — re-attach
                # the full mapped subtitle dicts so the burn-in step can
                # use source-clip timestamps.
                if isinstance(result.subtitles, list):
                    result_dict["subtitles"] = list(result.subtitles)
                result_dict["style"] = style
                result_dict["caption_preset"] = caption_preset
                result_dict["smartcam_enabled"] = smartcam_enabled
                result_dict["smartcam_format"] = smartcam_format if smartcam_enabled else None
                result_dict["smartcam_video_path"] = smartcam_video_path
                result_dict["original_video_path"] = original_video_path
                result_dict["sub_pos"] = sub_pos
                result_dict["sub_size"] = sub_size
                # Whisper-detected language for downstream Elegant POS
                # tagging — "de", "en", oder anderer ISO-Code.
                try:
                    result_dict["language"] = getattr(result, "language", None)
                except Exception:
                    result_dict["language"] = None
                VideoEditorHandler._last_result = result_dict

                # Build enhanced progress data from result
                duration = result_dict.get("duration", 0)
                segments = result_dict.get("segments", [])
                fillers = result_dict.get("fillers", []) or []
                subtitles = result_dict.get("subtitles", [])

                # Build transcript words list from subtitles with filler marking
                transcript_words = _build_transcript_words(subtitles, fillers)

                # Build timeline segments (speech/silence/filler)
                timeline_segments = _build_timeline_segments(segments, fillers, duration)

                # Calculate stats
                edited_duration = sum(e - s for s, e in segments)
                silence_removed = duration - edited_duration
                filler_duration = sum(f["end"] - f["start"] for f in fillers)

                with _job_lock:
                    # Mark all phases done
                    for phase in _current_job["phases"]:
                        phase["status"] = "done"
                    _current_job.update({
                        "status": "done",
                        "progress": 100,
                        "message": "Analysis complete",
                        "segments_count": len(segments),
                        "subtitles_count": len(subtitles),
                        "fillers_count": len(fillers),
                        "transcript_words": transcript_words,
                        "segments": timeline_segments,
                        "stats": {
                            "cuts": len(segments),
                            "silence_removed": round(silence_removed, 1),
                            "fillers_removed": round(filler_duration, 1),
                            "original_duration": round(duration, 1),
                            "edited_duration": round(edited_duration, 1),
                        },
                    })

            except InterruptedError:
                # User cancelled mid-run — record clean cancellation
                # state so the panel knows it can re-enable Process.
                with _job_lock:
                    _current_job.update({
                        "status": "cancelled",
                        "message": "Cancelled by user",
                    })
                print("[VideoEditor] worker exited (cancelled)", flush=True)
            except Exception as e:
                # If we were cancelling, treat any inner exception as
                # cancellation finish rather than error.
                with _job_lock:
                    if (_current_job.get("status") == "cancelling"
                            or VideoEditorHandler._cancel_requested):
                        _current_job.update({
                            "status": "cancelled",
                            "message": "Cancelled by user",
                        })
                    else:
                        _current_job.update({
                            "status": "error",
                            "error": str(e),
                            "message": f"Error: {e}",
                        })

        thread = threading.Thread(target=run_analysis, daemon=True)
        VideoEditorHandler._worker_thread = thread
        thread.start()

        self._respond(200, {"status": "started"})

    def _handle_job_status(self):
        """Return current async job status with enhanced progress data."""
        with _job_lock:
            response = dict(_current_job)
            # Deep-copy mutable nested fields so JSON serialization is safe
            response["stats"] = dict(_current_job.get("stats", {}))
            response["phases"] = [dict(p) for p in _current_job.get("phases", [])]
            # Include fillers from last result when done (needed by onAnalysisDone)
            if response["status"] == "done" and VideoEditorHandler._last_result:
                response["fillers"] = VideoEditorHandler._last_result.get("fillers")
            self._respond(200, response)

    def _handle_export_xml_from_last(self, data):
        """Export last analysis result as XML (for GET-based workflow)."""
        if not VideoEditorHandler._last_result:
            self._respond(400, {"error": "No analysis result. Run /analyze first."})
            return
        # Merge URL query params on top of the stored analysis result so callers
        # can pass options like match_filenames=true (used by the DaVinci plugin).
        merged = dict(VideoEditorHandler._last_result)
        merged.update(data)
        # If SmartCam preprocessed the input, point the XML export at the
        # reframed file. Otherwise fall back to whatever video_path the
        # client passed (the original input).
        if merged.get("smartcam_enabled") and merged.get("smartcam_video_path"):
            merged["video_path"] = merged["smartcam_video_path"]
        self._handle_export_xml(merged)

    def _handle_export_xml(self, data):
        """Export analysis results as Premiere Pro XML and save to file."""
        try:
            # When SmartCam was used during /analyze, the timeline should
            # reference the reframed clip — not the original landscape file.
            if data.get("smartcam_enabled") and data.get("smartcam_video_path"):
                video_path = data.get("smartcam_video_path")
            else:
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
            # The DaVinci Lua plugin passes skip_normalize=true because DaVinci
            # handles rotation itself and chokes on the large high-bitrate H.264
            # produced by ultrafast x264 in the normalize step. Premiere callers
            # do not pass this flag and keep their existing behaviour.
            if str(data.get("skip_normalize", "")).lower() in ("1", "true", "yes"):
                xml_video_path = video_path
            else:
                xml_video_path = _normalize_rotation(video_path)

            # Get target ratio from style config (e.g. Clean has "9:16")
            # Only apply vertical reframing if the source video is already vertical (portrait)
            from src.styles import get_style
            config = get_style(style)

            # Apply caption preset overrides
            caption_preset = data.get("caption_preset", "classic")
            if caption_preset in CAPTION_PRESETS:
                config.update(CAPTION_PRESETS[caption_preset])

            target_ratio = None
            # SmartCam owns the framing — if we reframed the input, the
            # sequence dimensions must match the reframed file. This avoids
            # Premiere creating a 16:9 sequence and letterboxing the
            # portrait clip inside it.
            if data.get("smartcam_enabled") and data.get("smartcam_video_path"):
                if data.get("smartcam_format") == "portrait":
                    target_ratio = "9:16"
                elif data.get("smartcam_format") == "landscape":
                    target_ratio = "16:9"
            elif config.get("auto_reframe"):
                probe = _probe_video(xml_video_path)
                if probe["height"] > probe["width"]:
                    # Source is portrait — apply target ratio (e.g. "9:16")
                    target_ratio = config.get("target_ratio")
                # Source is landscape — keep original dimensions, no reframing

            import tempfile

            # Use original filename for display in Premiere (not normalized temp name).
            # When match_filenames=true (passed by the DaVinci Lua plugin), use the
            # basename of the actual file the XML points to, so DaVinci's stricter
            # clip lookup matches the on-disk filename instead of failing with
            # "clip not found". Premiere callers do not pass this flag, so their
            # behaviour is unchanged.
            if str(data.get("match_filenames", "")).lower() in ("1", "true", "yes"):
                original_name = os.path.basename(xml_video_path)
            else:
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

            # Cap overlay resolution at 1920px on the long side. ProRes 4444 at
            # 4K + 60fps for 30s would be ~4GB and frequently fails to render.
            # DaVinci scales the overlay to timeline resolution at composite.
            MAX_DIM = 1920
            if max(width, height) > MAX_DIM:
                scale = MAX_DIM / max(width, height)
                width = int(width * scale) // 2 * 2  # keep even (encoder requirement)
                height = int(height * scale) // 2 * 2

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

    def _handle_finalize_with_overlay(self, data):
        # Reject if a previous run is still cancelling — we don't want
        # two threads writing into the cache dir at the same time.
        with _job_lock:
            if _current_job["status"] == "cancelling":
                self._respond(409, {"error": "Cancelling previous run — please wait"})
                return
        # Bump active-finalize counter so /cancel knows there's work to
        # wait for. Always decrement in finally so an early return or
        # exception can't leave the counter stuck.
        with VideoEditorHandler._finalize_lock:
            VideoEditorHandler._finalize_count += 1
        try:
            return self._handle_finalize_with_overlay_inner(data)
        finally:
            with VideoEditorHandler._finalize_lock:
                VideoEditorHandler._finalize_count = max(
                    0, VideoEditorHandler._finalize_count - 1)

    def _handle_finalize_with_overlay_inner(self, data):
        """One-shot endpoint that turns edited subtitles into a complete
        Premiere import bundle:
          1. Stash user-edited subtitle text on _last_result.
          2. Write a fresh SRT from the edits.
          3. Render a black-background overlay video matching the caption
             style (Premiere imports it on V2 with Screen blend mode so the
             black becomes transparent).
          4. Build the cuts XML pointing at the SmartCam reframed clip.
          5. Return {xml_path, overlay_path, srt_path}.
        """
        try:
            edited_subs = data.get("subtitles") or []
            style = data.get("style", "clean")
            caption_preset = data.get("caption_preset", "classic")
            video_path = data.get("video_path", "")
            # Subtitle-Position/Größe override (vom Panel)
            try:
                sub_pos_req = float(data.get("sub_pos")) if data.get("sub_pos") is not None else None
            except (TypeError, ValueError):
                sub_pos_req = None
            try:
                sub_size_req = float(data.get("sub_size")) if data.get("sub_size") is not None else None
            except (TypeError, ValueError):
                sub_size_req = None

            if not VideoEditorHandler._last_result:
                self._respond(400, {"error": "No analyze result; run /analyze first"})
                return

            # Persist the edited subtitles into the stored result so later
            # /export-xml calls and the SRT match what the user actually
            # confirmed in the editor. Keep BOTH timestamp pairs:
            #   start/end             = timeline (post-cut) coordinates
            #   original_start/end    = source-clip coordinates
            # We burn at source coords so Premiere's cuts line everything
            # up correctly.
            stored = VideoEditorHandler._last_result
            normalized = []
            for s in edited_subs:
                try:
                    text = (s.get("text") or "").strip()
                    if not text:
                        continue
                    normalized.append({
                        "start": float(s.get("start", 0)),
                        "end": float(s.get("end", 0)),
                        "original_start": float(s.get("original_start",
                                                       s.get("start", 0))),
                        "original_end": float(s.get("original_end",
                                                     s.get("end", 0))),
                        "text": text,
                    })
                except Exception:
                    continue
            stored["subtitles"] = normalized

            # --- Pick the source video the timeline will reference ---
            # Prefer the SmartCam reframed clip when available so the
            # rendered overlay matches the timeline's resolution.
            sc_path = stored.get("smartcam_video_path")
            if sc_path and os.path.isfile(sc_path):
                source_path = sc_path
                _src_reason = "smartcam"
            elif video_path and os.path.isfile(video_path):
                source_path = video_path
                _src_reason = "video_path"
            else:
                source_path = stored.get("original_video_path", "")
                _src_reason = "original_video_path"
            if not source_path or not os.path.isfile(source_path):
                self._respond(400, {"error": "Could not resolve source video"})
                return
            print(f"[finalize] source_path={source_path}", flush=True)
            print(f"[finalize] source reason={_src_reason}", flush=True)
            print(f"[finalize] smartcam_enabled={stored.get('smartcam_enabled')}",
                  flush=True)
            try:
                _src_p = _probe_video(source_path)
                print(f"[finalize] source dims={_src_p.get('width')}x{_src_p.get('height')} rot={_src_p.get('rotation')}",
                      flush=True)
            except Exception:
                pass

            probe = _probe_video(source_path)
            width = probe.get("width", 1920)
            height = probe.get("height", 1080)
            fps = probe.get("fps", 30) or 30
            duration = probe.get("duration", 0) or 0
            if duration <= 0:
                # Fallback to duration from analyze
                duration = float(stored.get("duration") or 0)

            # --- Write SRT at TIMELINE timestamps ---
            # We cut+concat the kept segments before burning, so the
            # subtitle timeline timestamps match the concatenated clip's
            # frame positions exactly.
            import tempfile, time as _time
            cache_dir = os.environ.get("CLEO_CACHE_DIR") or os.path.expanduser(
                "~/Movies/Videos/.smartcut_plugin_cache"
            )
            os.makedirs(cache_dir, exist_ok=True)
            stamp = int(_time.time()) % 1000000
            srt_path = os.path.join(cache_dir, f"subtitles_{stamp}.srt")
            with open(srt_path, "w", encoding="utf-8") as f:
                for i, s in enumerate(normalized, 1):
                    f.write(f"{i}\n")
                    f.write(f"{_srt_time(s['start'])} --> {_srt_time(s['end'])}\n")
                    f.write(f"{s['text']}\n\n")

            # --- Multi-clip burn-in: one mp4 per kept segment ---
            # Each segment gets its own ffmpeg pass that extracts the
            # range AND burns the subs that fall inside it (timestamps
            # shifted clip-relative). The XML then places each as a
            # separate clipitem on V1 — Premiere shows the cuts as
            # individually movable clips.
            kept_segments = stored.get("segments", [])
            seg_pairs = []
            for seg in kept_segments:
                if isinstance(seg, dict):
                    seg_pairs.append((float(seg.get("start", 0)),
                                      float(seg.get("end", 0))))
                else:
                    seg_pairs.append((float(seg[0]), float(seg[1])))
            seg_pairs = [(s, e) for (s, e) in seg_pairs if e > s]

            clip_dir = os.path.join(cache_dir, f"clips_{stamp}")
            os.makedirs(clip_dir, exist_ok=True)
            # Reset cancel flag + mark the global job state as "processing"
            # so /analyze and /finalize reject overlapping clicks. We restore
            # the state to "done" / "cancelled" on the way out.
            VideoEditorHandler._cancel_requested = False
            with _job_lock:
                _current_job["status"] = "processing"
                _current_job["message"] = "Rendering subtitles…"

            def _fin_cancel():
                return VideoEditorHandler._cancel_requested

            # Resolve sub_pos / sub_size: payload override > analyze-time
            # stash > defaults
            sub_pos = sub_pos_req if sub_pos_req is not None \
                else float(stored.get("sub_pos", 0.85))
            sub_size = sub_size_req if sub_size_req is not None \
                else float(stored.get("sub_size", 1.0))
            sub_pos = max(0.05, min(0.98, sub_pos))
            sub_size = max(0.4, min(2.0, sub_size))
            # Clip-Name-Prefix für die einzelnen seg-Files. Wir greifen
            # die Run-Nummer hier noch nicht, weil die erst weiter unten
            # vergeben wird — also Source-Filename als stabilen Suffix.
            _orig = stored.get("original_video_path", "") or ""
            _name_for_clips = os.path.splitext(os.path.basename(_orig))[0]
            import re as _re2
            _name_for_clips = _re2.sub(r"_SmartCut_\d{4}(_\d+)?$", "",
                                       _name_for_clips)
            _name_for_clips = _re2.sub(r"[^A-Za-z0-9_-]+", "_",
                                       _name_for_clips) or "Clip"
            _name_for_clips = _name_for_clips[:30]
            # Caption-Style anhängen, damit die Clip-Files im Cache
            # auch nach Style differenzierbar bleiben.
            _name_for_clips = f"{_name_for_clips}_{caption_preset}"
            _job_language = stored.get("language") or "de"
            print(f"[finalize] detected language={_job_language}", flush=True)
            try:
                burned_clips = _multi_clip_burn(
                    source_path, seg_pairs, normalized, caption_preset,
                    clip_dir, cut_style=style, cancel_check=_fin_cancel,
                    sub_pos=sub_pos, sub_size=sub_size,
                    clip_name_prefix=_name_for_clips,
                    language=_job_language,
                )
            except Exception as _e:
                with _job_lock:
                    _current_job.update({
                        "status": "cancelled" if _fin_cancel() else "error",
                        "message": str(_e),
                    })
                self._respond(500, {"error": str(_e)})
                return

            if _fin_cancel():
                with _job_lock:
                    _current_job.update({
                        "status": "cancelled",
                        "message": "Cancelled by user",
                    })
                self._respond(499, {"error": "cancelled"})
                return
            if not burned_clips:
                with _job_lock:
                    _current_job.update({
                        "status": "error",
                        "message": "multi-clip burn failed",
                    })
                self._respond(500, {"error": "multi-clip burn failed"})
                return

            # --- Build multi-source XML ---
            target_ratio = None
            if stored.get("smartcam_enabled"):
                fmt_ = stored.get("smartcam_format")
                target_ratio = "9:16" if fmt_ == "portrait" else "16:9"

            # Sequenz-Name: "Clipper · #3" — Caption-Style + Run-Nummer.
            # Damit kann der User mehrere Runs des gleichen Source-
            # Videos im Project-Bin auseinander halten.
            _caption_labels = {
                "clean":     "Clean",
                "classic":   "Classic",
                "highlight": "Highlight",
                "elegant":   "Elegant",
                "clipper":   "Clipper",
                "flash":     "Flash",
                "punch":     "Punch",
                "subtle":    "Subtle",
                "none":      "No Captions",
            }
            _cap_label = _caption_labels.get(caption_preset, caption_preset.title())
            with VideoEditorHandler._run_counter_lock:
                VideoEditorHandler._run_counter += 1
                _run_no = VideoEditorHandler._run_counter
            _pretty_name = f"{_cap_label} · #{_run_no}"
            try:
                xml = generate_premiere_xml_multi(
                    burned_clips,
                    fps=None,
                    target_ratio=target_ratio,
                    style=style,
                    original_name=_pretty_name,
                )
            except Exception as xe:
                self._respond(500, {"error": f"XML build failed: {xe}"})
                return

            xml_path = os.path.join(cache_dir, f"smartcut_{stamp}.xml")
            with open(xml_path, "w", encoding="utf-8") as f:
                f.write(xml)
            VideoEditorHandler._last_xml_path = xml_path

            with _job_lock:
                _current_job.update({
                    "status": "done",
                    "progress": 100,
                    "message": "Render complete",
                })

            self._respond(200, {
                "xml_path": xml_path,
                "srt_path": srt_path,
                "clip_count": len(burned_clips),
                "width": width,
                "height": height,
            })
        except Exception as e:
            import traceback as _tb
            _tb.print_exc()
            self._respond(500, {"error": str(e)})

    def _export_xml_internal(self, data, srt_path_override=None, respond=True):
        """Internal version of _handle_export_xml that stores the produced
        XML path on the handler for downstream use, optionally skipping the
        HTTP response."""
        try:
            if data.get("smartcam_enabled") and data.get("smartcam_video_path"):
                video_path = data.get("smartcam_video_path")
            else:
                video_path = data.get("video_path")
            segments = data.get("segments", [])
            subtitles = data.get("subtitles", [])
            fps = data.get("fps") or None
            style = data.get("style", "clean")

            if not video_path:
                if respond:
                    self._respond(400, {"error": "video_path required"})
                return

            if str(data.get("skip_normalize", "")).lower() in ("1", "true", "yes"):
                xml_video_path = video_path
            else:
                xml_video_path = _normalize_rotation(video_path)

            from src.styles import get_style
            config = get_style(style)
            caption_preset = data.get("caption_preset", "classic")
            if caption_preset in CAPTION_PRESETS:
                config.update(CAPTION_PRESETS[caption_preset])

            target_ratio = None
            if data.get("smartcam_enabled") and data.get("smartcam_video_path"):
                if data.get("smartcam_format") == "portrait":
                    target_ratio = "9:16"
                elif data.get("smartcam_format") == "landscape":
                    target_ratio = "16:9"
            elif config.get("auto_reframe"):
                probe = _probe_video(xml_video_path)
                if probe["height"] > probe["width"]:
                    target_ratio = config.get("target_ratio")

            if str(data.get("match_filenames", "")).lower() in ("1", "true", "yes"):
                original_name = os.path.basename(xml_video_path)
            else:
                original_name = os.path.basename(video_path)

            enable_subs = config.get("enable_subtitles", True)
            if not enable_subs:
                subtitles = []

            xml = generate_premiere_xml(
                xml_video_path, segments, subtitles, fps,
                target_ratio=target_ratio, style=style,
                subtitle_images=None,
                original_name=original_name,
            )
            import tempfile, time as _time
            video_base = os.path.splitext(os.path.basename(video_path))[0][:20]
            run_ts = int(_time.time()) % 100000
            tmp_xml = os.path.join(tempfile.gettempdir(),
                                   f"smartcut_{video_base}_{run_ts}.xml")
            with open(tmp_xml, "w", encoding="utf-8") as f:
                f.write(xml)
            VideoEditorHandler._last_xml_path = tmp_xml
            if respond:
                self._respond(200, {"xml_path": tmp_xml})
        except Exception as e:
            if respond:
                self._respond(500, {"error": str(e)})
            else:
                raise

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


def _map_cut_to_style(name):
    """Translate the panel's new cut-style names (smooth/balanced/tight)
    into the closest matching key in src/styles.py STYLES (which still
    uses the legacy combined preset names: clean/fast/balanced/smooth/
    minimal). Any value that's already a valid STYLES key passes through
    unchanged.
    """
    try:
        from src.styles import STYLES
    except Exception:
        return name or "clean"
    if name in STYLES:
        return name
    mapping = {
        "tight":   "fast",     # tight cuts = aggressive silence removal
        "smooth":  "smooth",
        "balanced": "balanced",
    }
    return mapping.get(name, "clean")


def _srt_time(seconds):
    """Format a float seconds value as an SRT timestamp."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# Per-caption-preset libass style hints used by /finalize-with-overlay. These
# don't perfectly mirror the standalone (the standalone uses PIL + MoviePy
# with per-word animations), but they give each preset a distinct look in
# the Premiere overlay without needing the full standalone renderer.
_CAPTION_STYLE_HINTS = {
    "classic":   {"font": "Helvetica", "size_pct": 0.045, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 4, "bold": 1,
                  "align": 2, "margin_pct": 0.06},
    "clean":     {"font": "Helvetica", "size_pct": 0.040, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 3, "bold": 1,
                  "align": 2, "margin_pct": 0.06},
    "highlight": {"font": "Impact",    "size_pct": 0.052, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 4, "bold": 1,
                  "align": 2, "margin_pct": 0.06},
    "elegant":   {"font": "Georgia",   "size_pct": 0.042, "color": "F8D77A",
                  "outline_color": "000000", "outline": 2, "bold": 1,
                  "align": 2, "margin_pct": 0.07},
    "clipper":   {"font": "Bangers",   "size_pct": 0.060, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 5, "bold": 0,
                  "align": 2, "margin_pct": 0.08},
    "flash":     {"font": "Avenir Next Heavy Italic",
                  "size_pct": 0.055, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 5, "bold": 1,
                  "italic": 1, "align": 2, "margin_pct": 0.08},
    "punch":     {"font": "Gill Sans", "size_pct": 0.070, "color": "FFEB3B",
                  "outline_color": "000000", "outline": 6, "bold": 1,
                  "align": 2, "margin_pct": 0.08},
    "subtle":    {"font": "Helvetica", "size_pct": 0.030, "color": "FFFFFF",
                  "outline_color": "000000", "outline": 2, "bold": 1,
                  "align": 2, "margin_pct": 0.05},
}


def _render_segment_with_standalone_captions(
    input_video, output_path, subtitles, cut_style, caption_preset,
    preloaded_clip=None, return_clips_only=False, time_offset=0.0,
    sub_pos=None, sub_size=None, language=None,
):
    """Render a single cut segment with subtitles burned in using the
    SAME MoviePy/PIL renderer the standalone GUI uses. This gives the
    plugin pixel-identical output to the desktop app (Bangers font for
    Clipper, green word highlight + bounce, Punch yellow glow, etc.).

    `subtitles` are clip-relative dicts: [{"start", "end", "text"}, ...].
    Returns True on success.
    """
    try:
        from moviepy.editor import VideoFileClip, CompositeVideoClip
        from src.styles import build_combined_style
        from src.audio import Subtitle as _Sub
        from src.effects import (
            create_modern_subtitle,
            create_clean_phrase_subtitle,
            create_elegant_phrase_subtitle,
            create_highlight_phrase_subtitle,
            build_elegant_word_clips,
        )

        # Resolve full style config (cut overrides + caption overrides on
        # minimal base). _caption_key tells us which renderer route.
        config = build_combined_style(cut_style, caption_preset)
        enable_subs = config.get("enable_subtitles", True)

        if preloaded_clip is not None:
            # Pfad des Standalone-Patterns: master clip wird einmal von
            # _multi_clip_burn geladen, subclips werden per Segment
            # weitergereicht. So gibt's keinen ffmpeg-Re-Encode-Schritt
            # zwischen mp4v-OpenCV-Output und MoviePy — exakt wie der
            # Standalone es macht.
            clip = preloaded_clip
            _close_base_clip = False
        else:
            clip = VideoFileClip(input_video)
            _close_base_clip = True
        # Probe Audio-Sample-Rate vom Input — MoviePy schreibt sonst mit
        # default 44100, was bei einem 48 kHz Source-Audio zu Resampling
        # über die Pipe führt und A/V-Drift produziert.
        try:
            _src_probe = _probe_video(input_video)
            _audio_fps = int(_src_probe.get("audio_sample_rate") or 48000)
        except Exception:
            _audio_fps = 48000

        # MoviePy AV-Sync-Fix: write_videofile pipt sonst Video- UND
        # Audio-Frames im selben Subprocess durch ffmpeg, was bei
        # Composite-Clips reproducibly Audio um 1–5 s nach vorn schiebt.
        # Mit temp_audiofile + remove_temp=True schreibt MoviePy Audio
        # erst in eine separate Datei und muxt am Ende — das ist der
        # gleiche Weg wie der Standalone-Encoder.
        _out_dir = os.path.dirname(os.path.abspath(output_path)) or "."
        _out_stem = os.path.splitext(os.path.basename(output_path))[0]
        _tmp_audio = os.path.join(_out_dir, f"_tmp_aud_{_out_stem}.m4a")

        if not enable_subs or not subtitles:
            if return_clips_only:
                return []  # no caption clips to add
            # No captions — just write the segment through (re-encode for
            # consistent codec) and we're done.
            clip.write_videofile(
                output_path,
                codec="libx264", audio_codec="aac",
                audio_bitrate="192k", audio_fps=_audio_fps,
                preset="fast",
                temp_audiofile=_tmp_audio, remove_temp=True,
                ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "18", "-bf", "0", "-avoid_negative_ts", "make_zero"],
                threads=4, logger=None,
            )
            if _close_base_clip:
                clip.close()
            return os.path.isfile(output_path)

        # Build subtitle list (MoviePy Subtitle dataclass)
        valid_subs = []
        for s in subtitles:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            dur = float(s.get("end", 0)) - float(s.get("start", 0))
            if dur < 0.05:
                continue
            valid_subs.append(_Sub(
                start=float(s["start"]), end=float(s["end"]), text=text,
            ))

        if not valid_subs:
            if return_clips_only:
                return []
            clip.write_videofile(
                output_path,
                codec="libx264", audio_codec="aac",
                audio_bitrate="192k", audio_fps=_audio_fps,
                preset="fast",
                temp_audiofile=_tmp_audio, remove_temp=True,
                ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "18", "-bf", "0", "-avoid_negative_ts", "make_zero"],
                threads=4, logger=None,
            )
            if _close_base_clip:
                clip.close()
            return os.path.isfile(output_path)

        style = config.get("subtitle_style", "modern")
        # User-Overrides aus dem Panel: subtitle_position_y und der
        # fontsize_multiplier werden ggf. überschrieben.
        _effective_pos = sub_pos if sub_pos is not None \
            else config.get("subtitle_position_y", 0.75)
        _base_size_mult = config.get("subtitle_fontsize_multiplier", 1.0)
        _effective_size_mult = (_base_size_mult * float(sub_size)) \
            if sub_size is not None else _base_size_mult
        print(f"[caption-config] style={style} preset={caption_preset} "
              f"sub_pos(req)={sub_pos} effective_pos={_effective_pos} "
              f"size_mult(req)={sub_size} effective_mult={_effective_size_mult} "
              f"words_per_phrase={config.get('clean_words_per_phrase', 'na')}",
              flush=True)
        subtitle_config = {
            "subtitle_color": config.get("subtitle_color", (255, 255, 255)),
            "subtitle_fontsize": config.get("subtitle_fontsize"),
            "subtitle_fontsize_multiplier": _effective_size_mult,
            "subtitle_effect": config.get("subtitle_effect"),
            "subtitle_stroke_width": config.get("subtitle_stroke_width", 4),
            "subtitle_position_y": _effective_pos,
            "subtitle_highlight_color_hex": config.get("subtitle_highlight_color_hex"),
            "_highlight_font": config.get("_highlight_font", "bangers"),
            "subtitle_uppercase": config.get("subtitle_uppercase", False),
            "subtitle_shadow": config.get("subtitle_shadow", False),
            "_font_candidates": config.get("_font_candidates"),
            "_highlight_mode": config.get("_highlight_mode", "color"),
            "_highlight_box_radius": config.get("_highlight_box_radius", 14),
        }

        all_clips = []

        if style in ("clean", "elegant", "highlight"):
            words_per_phrase = config.get("clean_words_per_phrase", 4)
            # Elegant nutzt eine größere Script-Schrift für NOUN/VERB-
            # Wörter — 4 Wörter pro Phrase füllen damit das ganze Bild.
            # Auf 3 Wörter reduzieren → max 1-2 kurze Zeilen, alles
            # sicher im Frame.
            if style == "elegant":
                words_per_phrase = min(3, words_per_phrase)

            # Highlight: split multi-word segments into individual words
            if style == "highlight":
                split_subs = []
                for s in valid_subs:
                    sub_words = s.text.strip().split()
                    if len(sub_words) <= 1:
                        split_subs.append(s)
                    else:
                        word_dur = (s.end - s.start) / len(sub_words)
                        for wi, sw in enumerate(sub_words):
                            ws = s.start + wi * word_dur
                            we = s.start + (wi + 1) * word_dur
                            split_subs.append(_Sub(ws, we, sw))
                valid_subs = split_subs

            # Elegant needs POS tagging (golden nouns + verbs). Import the
            # tagger lazily — it's optional and may pull spaCy/transformers.
            pos_tagger = None
            if style == "elegant":
                try:
                    from src.pos_tagger import tag_phrase as _tag
                    pos_tagger = _tag
                except Exception as _e:
                    print(f"[caption] pos_tagger unavailable: {_e}", flush=True)

            # Group into phrases. After splitting, fix any trailing
            # group that ends up with a single word — that looks bad
            # for the highlight style (lonely word floating in the
            # frame). Merge it into the previous phrase so the user
            # always sees a 2- or 3-word context.
            phrases = []
            for i in range(0, len(valid_subs), words_per_phrase):
                phrases.append(valid_subs[i:i + words_per_phrase])
            if (style == "highlight" and len(phrases) >= 2
                    and len(phrases[-1]) < 2):
                tail = phrases.pop()
                phrases[-1] = phrases[-1] + tail

            global_word_offset = 0
            for phrase_idx, phrase_subs in enumerate(phrases):
                words = [s.text.strip() for s in phrase_subs]
                phrase_start_t = phrase_subs[0].start
                if phrase_idx + 1 < len(phrases):
                    phrase_end_t = phrases[phrase_idx + 1][0].start
                else:
                    phrase_end_t = phrase_subs[-1].end
                phrase_dur = max(0.1, phrase_end_t - phrase_start_t)

                # POS tag this phrase for elegant. Language von der
                # Whisper-Erkennung (durchgereicht via _multi_clip_burn);
                # falls leer/unbekannt → "de" als bisheriger Default.
                phrase_pos_tags = None
                if style == "elegant" and pos_tagger is not None:
                    _lang = language or "de"
                    try:
                        phrase_pos_tags = pos_tagger(
                            words, language=_lang,
                            global_offset=global_word_offset,
                        )
                    except Exception as _e:
                        print(f"[caption] pos_tag error: {_e}", flush=True)
                global_word_offset += len(words)

                if style == "highlight":
                    word_times = [(s.start - phrase_start_t,
                                    s.end - phrase_start_t) for s in phrase_subs]
                    try:
                        phrase_clip = create_highlight_phrase_subtitle(
                            words=words, active_index=0, duration=phrase_dur,
                            video_size=clip.size, subtitle_config=subtitle_config,
                            word_times=word_times,
                        )
                        if phrase_clip:
                            all_clips.append(phrase_clip.set_start(phrase_start_t + time_offset))
                    except Exception as e:
                        print(f"[caption] highlight error: {e}", flush=True)
                    continue

                if style == "elegant":
                    try:
                        word_clips = build_elegant_word_clips(
                            words=words,
                            video_size=clip.size,
                            subtitle_config=subtitle_config,
                            pos_tags=phrase_pos_tags,
                        )
                        for word_idx, sub in enumerate(phrase_subs):
                            if word_idx >= len(word_clips):
                                break
                            wc = word_clips[word_idx]
                            hold = max(0.05, phrase_end_t - sub.start)
                            all_clips.append(
                                wc.set_start(sub.start + time_offset).set_duration(hold)
                            )
                    except Exception as e:
                        print(f"[caption] elegant error: {e}", flush=True)
                    continue

                # Clean: word-by-word accumulation
                for word_idx, sub in enumerate(phrase_subs):
                    next_t = (phrase_subs[word_idx + 1].start
                              if word_idx + 1 < len(phrase_subs)
                              else phrase_end_t)
                    dur = max(0.05, next_t - sub.start)
                    try:
                        pc = create_clean_phrase_subtitle(
                            words=words, active_index=word_idx,
                            duration=dur, video_size=clip.size,
                            subtitle_config=subtitle_config,
                        )
                        if pc is not None:
                            all_clips.append(pc.set_start(sub.start + time_offset))
                    except Exception as e:
                        print(f"[caption] clean error: {e}", flush=True)
        else:
            # Modern / classic / punch / subtle / etc — word/phrase based
            # First step: if the caption preset wants 1 word per render
            # (clean_words_per_phrase=1, e.g. Punch), split any multi-word
            # Whisper subs into individual word subs.
            _cwp = int(config.get("clean_words_per_phrase", 0))
            if _cwp == 1:
                split = []
                for s in valid_subs:
                    words_in = s.text.strip().split()
                    if len(words_in) <= 1:
                        split.append(s)
                    else:
                        wdur = (s.end - s.start) / len(words_in)
                        for wi, w in enumerate(words_in):
                            split.append(_Sub(
                                start=s.start + wi * wdur,
                                end=s.start + (wi + 1) * wdur,
                                text=w,
                            ))
                valid_subs = split

            _wp = int(config.get("modern_words_per_phrase", 1))
            subs_to_render = list(valid_subs)
            if _wp > 1:
                # Accumulation: each word adds to the previous within phrase
                groups = []
                i = 0
                while i < len(valid_subs):
                    groups.append(valid_subs[i:i + _wp])
                    i += _wp
                expanded = []
                for gi, group in enumerate(groups):
                    if gi + 1 < len(groups):
                        phrase_end = groups[gi + 1][0].start
                    else:
                        phrase_end = group[-1].end
                    for wi, sub_ in enumerate(group):
                        text = " ".join(s.text.strip() for s in group[:wi + 1])
                        if wi + 1 < len(group):
                            state_end = group[wi + 1].start
                        else:
                            state_end = phrase_end
                        expanded.append(_Sub(
                            start=sub_.start,
                            end=max(sub_.start + 0.05, state_end),
                            text=text,
                        ))
                subs_to_render = expanded

            for sub in subs_to_render:
                dur = sub.end - sub.start
                if dur < 0.05 or not sub.text.strip():
                    continue
                try:
                    sub_clips = create_modern_subtitle(
                        sub.text, dur, clip.size, style, subtitle_config,
                    )
                    for sc in sub_clips:
                        if sc is not None:
                            all_clips.append(sc.set_start(sub.start + time_offset))
                except Exception as e:
                    print(f"[caption] modern error: {e}", flush=True)

        if return_clips_only:
            # Caller (z.B. _multi_clip_burn concat-pattern) assembled
            # selbst — wir geben nur die Caption-Clips zurück, schon
            # mit time_offset auf der globalen Timeline positioniert.
            return all_clips

        if all_clips:
            final = CompositeVideoClip([clip] + all_clips)
        else:
            final = clip

        final.write_videofile(
            output_path,
            codec="libx264", audio_codec="aac",
            audio_bitrate="192k", audio_fps=_audio_fps,
            preset="fast",
            temp_audiofile=_tmp_audio, remove_temp=True,
            ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "18", "-bf", "0", "-avoid_negative_ts", "make_zero"],
            threads=4, logger=None,
        )
        try:
            if _close_base_clip:
                clip.close()
            # final.close() würde sonst den base clip (= subclip vom
            # master) mitschließen und damit auch den geteilten Audio-
            # Reader vom master. Nur dann schließen wenn wir den Master
            # selbst besitzen (preloaded_clip=None Fall).
            if _close_base_clip:
                final.close()
        except Exception:
            pass
        return os.path.isfile(output_path)
    except Exception as e:
        import traceback as _tb
        print(f"[caption render] FAILED: {e}", flush=True)
        _tb.print_exc()
        return False


def _bundled_fonts_dir():
    """Path to the bundled fonts directory (Bangers etc.). Returns None
    if it can't be located — libass will fall back to system fonts."""
    # Walk up from this file looking for assets/fonts
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(4):
        candidate = os.path.join(here, *([".."] * up), "assets", "fonts")
        candidate = os.path.normpath(candidate)
        if os.path.isdir(candidate):
            return candidate
    return None


def _multi_clip_burn(input_video, segments, subtitles, caption_preset,
                     output_dir, cut_style="balanced", cancel_check=None,
                     sub_pos=None, sub_size=None, clip_name_prefix=None,
                     language=None):
    """Per-Segment MoviePy render mit fresh VideoFileClip pro Segment.

    Returns list of (file_path, duration) tuples in timeline order.
    """
    if not segments:
        return []

    try:
        from moviepy.editor import VideoFileClip
    except Exception as e:
        print(f"[multi-clip] MoviePy import failed: {e}", flush=True)
        return []

    outputs = []
    for i, (s_start, s_end) in enumerate(segments):
        if cancel_check and cancel_check():
            print("[multi-clip] cancelled — stopping render loop",
                  flush=True)
            return outputs
        seg_dur = s_end - s_start
        if seg_dur <= 0:
            continue

        clip_subs = []
        for sub in subtitles:
            os_ = sub.get("original_start", sub.get("start", 0))
            oe_ = sub.get("original_end", sub.get("end", 0))
            text = (sub.get("text") or "").strip()
            if not text:
                continue
            if oe_ <= s_start or os_ >= s_end:
                continue
            cs = max(0.0, os_ - s_start)
            ce = min(seg_dur, oe_ - s_start)
            if ce - cs <= 0.05:
                continue
            clip_subs.append({"start": cs, "end": ce, "text": text})

        try:
            full_clip = VideoFileClip(input_video)
            sub_clip = full_clip.subclip(s_start, s_end)
            if i == 0:
                print(f"[multi-clip] master.size={full_clip.size}, "
                      f"sub.size={sub_clip.size}", flush=True)
        except Exception as e:
            print(f"[multi-clip] seg {i} open/subclip failed: {e}",
                  flush=True)
            try: full_clip.close()
            except Exception: pass
            continue

        # Lesbarer File-/Clip-Name in Premiere: <SourceName>_part_01.mp4
        # statt seg_001.mp4. Fallback bleibt "seg" wenn kein Prefix da ist.
        if clip_name_prefix:
            out_path = os.path.join(
                output_dir, f"{clip_name_prefix}_part_{i+1:02d}.mp4"
            )
        else:
            out_path = os.path.join(output_dir, f"seg_{i:03d}.mp4")
        try:
            ok = _render_segment_with_standalone_captions(
                input_video, out_path, clip_subs, cut_style,
                caption_preset, preloaded_clip=sub_clip,
                sub_pos=sub_pos, sub_size=sub_size,
                language=language,
            )
        finally:
            try: full_clip.close()
            except Exception: pass

        if not ok or not os.path.isfile(out_path):
            print(f"[multi-clip] seg {i} render failed", flush=True)
            continue

        actual_dur = _probe_video(out_path).get("duration", seg_dur)
        outputs.append((out_path, actual_dur))
    return outputs


def _cut_concat_burn(input_video, segments, srt_path, output_path,
                     caption_preset):
    """Single-pass ffmpeg: cut `input_video` to the kept `segments`,
    concatenate them, then burn subtitles (at *timeline* timestamps).

    The result is one finished clip. The plugin imports it as a single
    V1 clip with no further cuts — that way subtitle timing is exact
    (no source vs. timeline drift across cut boundaries).
    """
    if not segments:
        return False
    hint = _CAPTION_STYLE_HINTS.get(caption_preset,
                                    _CAPTION_STYLE_HINTS["classic"])
    probe = _probe_video(input_video)
    width = probe.get("width", 1920)
    height = probe.get("height", 1080)

    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    fontsize = max(16, int(height * hint["size_pct"]))
    margin_v = max(20, int(height * hint["margin_pct"]))
    parts = [
        f"PlayResX={width}",
        f"PlayResY={height}",
        f"FontName={hint['font']}",
        f"FontSize={fontsize}",
        f"PrimaryColour=&H00{hint['color']}",
        f"OutlineColour=&H00{hint['outline_color']}",
        f"Outline={hint['outline']}",
        f"Alignment={hint['align']}",
        f"MarginV={margin_v}",
        f"Bold={hint.get('bold', 0)}",
    ]
    if hint.get("italic"):
        parts.append(f"Italic={hint['italic']}")
    style = ",".join(parts)
    escaped_srt = (srt_path.replace("\\", "\\\\")
                   .replace(":", "\\:")
                   .replace("'", "\\'"))

    # Build filter graph: trim each segment, reset PTS, then concat them.
    # The concat filter takes alternating v,a,v,a,... streams.
    filter_parts = []
    pairs = []
    for i, (s, e) in enumerate(segments):
        filter_parts.append(
            f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]"
        )
        filter_parts.append(
            f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]"
        )
        pairs.append(f"[v{i}][a{i}]")
    n = len(segments)
    filter_parts.append(
        f"{''.join(pairs)}concat=n={n}:v=1:a=1[catv][cata]"
    )
    # Burn subtitles on the concatenated video stream at TIMELINE coords.
    filter_parts.append(
        f"[catv]subtitles='{escaped_srt}':force_style='{style}'[outv]"
    )
    filter_complex = ";".join(filter_parts)

    cmd = [
        ffmpeg, "-y",
        "-i", input_video,
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[cata]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                         **kwargs)
    if res.returncode != 0:
        print(f"[cut+burn] ffmpeg stderr: {res.stderr[-600:]}", flush=True)
        return False
    return os.path.isfile(output_path)


def _burn_subtitles_into_video(input_video, srt_path, output_path,
                                caption_preset):
    """Burn subtitles directly into a video copy using ffmpeg's libass
    filter, styled per the chosen SmartCut caption preset.

    This is the Premiere-plugin equivalent of the standalone GUI's
    burn-in flow — Premiere can't reliably composite a separate overlay
    track (Screen blend mode requires undocumented QE-DOM access and
    alpha-channel ProRes was being ignored), so we hand it a single
    finished clip with subtitles baked in.
    """
    hint = _CAPTION_STYLE_HINTS.get(caption_preset,
                                    _CAPTION_STYLE_HINTS["classic"])

    probe = _probe_video(input_video)
    width = probe.get("width", 1920)
    height = probe.get("height", 1080)

    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    fontsize = max(16, int(height * hint["size_pct"]))
    margin_v = max(20, int(height * hint["margin_pct"]))
    outline = hint["outline"]

    parts = [
        f"PlayResX={width}",
        f"PlayResY={height}",
        f"FontName={hint['font']}",
        f"FontSize={fontsize}",
        f"PrimaryColour=&H00{hint['color']}",
        f"OutlineColour=&H00{hint['outline_color']}",
        f"Outline={outline}",
        f"Alignment={hint['align']}",
        f"MarginV={margin_v}",
        f"Bold={hint.get('bold', 0)}",
    ]
    if hint.get("italic"):
        parts.append(f"Italic={hint['italic']}")
    style = ",".join(parts)

    escaped_srt = (srt_path.replace("\\", "\\\\")
                   .replace(":", "\\:")
                   .replace("'", "\\'"))

    cmd = [
        ffmpeg, "-y",
        "-i", input_video,
        "-vf", f"subtitles='{escaped_srt}':force_style='{style}'",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                         **kwargs)
    if res.returncode != 0:
        print(f"[burn] ffmpeg stderr: {res.stderr[-400:]}", flush=True)
        return False
    return os.path.isfile(output_path)


def _extract_trim_range(video_path, start_sec, end_sec):
    """Extract `start_sec` → `end_sec` from `video_path` to a fresh MP4
    using ffmpeg stream copy (near-instant — no re-encode). Returns the
    new file path on success, or None to let the caller fall back to
    the full source.
    """
    import tempfile
    import time as _time
    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    cache_dir = os.environ.get("CLEO_CACHE_DIR") or os.path.expanduser(
        "~/Movies/Videos/.smartcut_plugin_cache"
    )
    os.makedirs(cache_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(video_path))[0][:32]
    stamp = int(_time.time()) % 1000000
    out_path = os.path.join(cache_dir, f"{base}_trim_{stamp}.mp4")

    duration = max(0.05, end_sec - start_sec)
    # `-ss` BEFORE `-i` does fast seek to the nearest keyframe; combined
    # with `-c copy` the extract finishes in well under a second for
    # typical clips. We accept the keyframe-snap rather than re-encoding
    # so the user's Process click feels instant.
    cmd = [
        ffmpeg, "-y",
        "-ss", str(start_sec),
        "-i", video_path,
        "-t", str(duration),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        out_path,
    ]
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    res = subprocess.run(cmd, capture_output=True, timeout=60, **kwargs)
    if res.returncode != 0 or not os.path.isfile(out_path):
        # Stream-copy can fail on some codec/container combos. Retry
        # with a re-encode — slower but always works.
        cmd_reenc = [
            ffmpeg, "-y",
            "-ss", str(start_sec),
            "-i", video_path,
            "-t", str(duration),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            out_path,
        ]
        res2 = subprocess.run(cmd_reenc, capture_output=True,
                              timeout=300, **kwargs)
        if res2.returncode != 0 or not os.path.isfile(out_path):
            err = (res2.stderr.decode(errors="ignore") if res2.stderr
                   else "")[-300:]
            print(f"[trim] both passes failed: {err}", flush=True)
            return None
    return out_path


def _make_thumbnail_b64(video_path, width=720, at_seconds=1.0):
    """Extract a frame from `video_path` at ~at_seconds, resize to
    `width`px wide, and return it as a base64 data URL (JPEG).

    720px wide gives a crisp 2-3x render on the panel's 180px thumbnail
    slot (retina-ready). Quality `q:v 3` is near-visually-lossless and
    still keeps base64 payloads under ~50KB for a typical 720p frame.
    """
    import base64
    import tempfile

    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    out = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    out.close()
    cmd = [
        ffmpeg, "-y",
        "-ss", str(at_seconds),
        "-i", video_path,
        "-frames:v", "1",
        "-vf", f"scale={width}:-2",
        "-q:v", "3",
        out.name,
    ]
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    res = subprocess.run(cmd, capture_output=True, timeout=10, **kwargs)
    # If the seek went past the end (very short clip), retry at t=0.
    if res.returncode != 0 or not os.path.isfile(out.name) or os.path.getsize(out.name) == 0:
        cmd[3] = "0"
        res = subprocess.run(cmd, capture_output=True, timeout=10, **kwargs)
    if res.returncode != 0 or not os.path.isfile(out.name):
        try: os.remove(out.name)
        except Exception: pass
        return ""
    with open(out.name, "rb") as f:
        data = f.read()
    try: os.remove(out.name)
    except Exception: pass
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def _detect_orientation(video_path):
    """Probe video and return 'landscape', 'portrait' or 'square'.
    Honors the rotation tag so phone videos encoded as 1920x1080 with a
    90/270° rotation read correctly as portrait. Self-contained — does not
    depend on the standalone GUI module."""
    try:
        from src.ffmpeg_utils import get_ffprobe_path
        ffprobe = get_ffprobe_path()
    except Exception:
        ffprobe = "ffprobe"
    try:
        cmd = [
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_streams",
            "-of", "json", video_path,
        ]
        out = subprocess.check_output(
            cmd, timeout=8, stderr=subprocess.DEVNULL,
        ).decode()
        data = json.loads(out)
        stream = data["streams"][0]
        w = int(stream["width"])
        h = int(stream["height"])
        rotation = 0
        try:
            tags = stream.get("tags") or {}
            if "rotate" in tags:
                rotation = int(float(tags["rotate"]))
        except Exception:
            pass
        try:
            for sd in stream.get("side_data_list") or []:
                if sd.get("side_data_type") == "Display Matrix":
                    rotation = int(float(sd.get("rotation", 0)))
                    break
        except Exception:
            pass
        if abs(rotation) % 180 == 90:
            w, h = h, w
        if h == 0:
            return "landscape"
        r = w / h
        if r > 1.2:
            return "landscape"
        if r < 0.83:
            return "portrait"
        return "square"
    except Exception:
        return "landscape"


def _run_smartcam_preprocess(video_path, smartcam_format, resolution_label,
                             progress_cb=None, cancel_check=None):
    """Reframe `video_path` with face-tracking before the main /analyze
    pipeline. Returns the path to the reframed video on success, or None
    on failure (caller falls back to the original).

    Mirrors the standalone GUI's `_smartcam_preprocess` flow:
      - Portrait output: target 1080x1920 (or 720x1280 at 720p)
      - Landscape output: target 1920x1080 (or 1280x720 at 720p)
      - Same-aspect input → zoom_factor=1.3 (Speaker Focus)
      - Cross-aspect input → zoom_factor=1.0 (pure reframe)
      - Output is re-encoded to H.264 yuv420p so Premiere/Resolve can play
        it cleanly (OpenCV's mp4v codec triggers frame-fetch errors in NLEs).
      - Output is stored in `~/Movies/Videos/.smartcut_plugin_cache/` so it
        persists across `/tmp` cleanups while still being out of the user's
        normal output folder.
    """
    try:
        import time as _time
        from pathlib import Path
        import tempfile
        from src.effects import smartcam_reframe_file
        from src.ffmpeg_utils import get_ffmpeg_path

        resolution = str(resolution_label or "1080")
        smartcam_format = (smartcam_format or "portrait").lower()
        if smartcam_format == "portrait":
            target_size = (720, 1280) if resolution == "720" else (1080, 1920)
        else:
            target_size = (1280, 720) if resolution == "720" else (1920, 1080)

        orient = _detect_orientation(video_path)
        same_aspect = (
            (orient == "landscape" and smartcam_format == "landscape")
            or (orient == "portrait" and smartcam_format == "portrait")
            or (orient == "square" and smartcam_format == "landscape")
        )
        # Same-aspect (Hoch→Hoch, Quer→Quer): zoom 1.3 als klassischer
        # "Speaker Focus".
        # Cross-aspect (Quer→Hoch): zoom 1.1 — der 9:16-Streifen aus
        # 16:9 ist eh schon eng, ein leichter zusätzlicher Zoom (10%)
        # hilft trotzdem gegen Hintergrund-Bereiche neben dem Sprecher.
        zoom_factor = 1.3 if same_aspect else 1.1
        print(f"[SmartCam/plugin] input={orient} out={smartcam_format} "
              f"zoom={zoom_factor} target={target_size}", flush=True)

        # Persistent cache so Premiere/DaVinci can still resolve the clip
        # after a system reboot (vs. /tmp which gets wiped). Web/server
        # deploys override via CLEO_CACHE_DIR — same code, different home.
        _cache_env = os.environ.get("CLEO_CACHE_DIR")
        if _cache_env:
            cache_dir = Path(_cache_env)
        else:
            cache_dir = Path.home() / "Movies" / "Videos" / ".smartcut_plugin_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        base = os.path.splitext(os.path.basename(video_path))[0][:32]
        stamp = int(_time.time()) % 1000000
        video_only_dir = tempfile.mkdtemp(prefix="smartcam_pre_")
        video_only = os.path.join(video_only_dir, "video.mp4")
        final_path = str(cache_dir / f"{base}_smartcam_{stamp}.mp4")

        def _cb(phase, frame_idx, total):
            if progress_cb is None:
                return
            if phase == "track":
                pct = (frame_idx / max(1, total)) * 0.5
                msg = f"SmartCam: tracking faces ({int(pct * 100)}%)"
            else:
                pct = 0.5 + (frame_idx / max(1, total)) * 0.49
                verb = "Speaker zoom" if same_aspect else "reframing"
                msg = f"SmartCam: {verb} ({int(pct * 100)}%)"
            try:
                progress_cb(msg)
            except Exception:
                pass

        # Auto-Letterbox-Crop: wenn der Input von Premiere mit Letterbox
        # gerendert wurde (z.B. Querformat-Clip in 9:16-Sequenz → schwarze
        # Balken oben/unten), würde SmartCam diese Balken mit-cropen und
        # den Sprecher zu einem schmalen Streifen mit schwarzen Bereichen
        # quetschen. ffmpeg cropdetect findet die tatsächliche Content-
        # Region und wir cropen mit ffmpeg vor SmartCam.
        crop_input = video_path
        try:
            ff = get_ffmpeg_path()
            # cropdetect: lese 30 frames, schwellwert 24 (default), runde
            # auf 16. Output via stderr in Form: `crop=W:H:X:Y`
            cd_cmd = [
                ff, "-i", video_path,
                "-vf", "cropdetect=24:16:0",
                "-frames:v", "60",
                "-an",
                "-f", "null", "-",
            ]
            cd_res = subprocess.run(cd_cmd, capture_output=True, timeout=20)
            cd_err = (cd_res.stderr.decode(errors="ignore")
                      if cd_res.stderr else "")
            import re as _re
            crop_matches = _re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", cd_err)
            if crop_matches:
                # nimm die letzte (stabilste) Detection
                cw, ch, cx, cy = map(int, crop_matches[-1])
                _src_info = _probe_video(video_path)
                _sw = int(_src_info.get("width") or 0)
                _sh = int(_src_info.get("height") or 0)
                # nur croppen wenn der detektierte Bereich ECHT kleiner
                # ist (mehr als 5% Differenz auf einer Achse), sonst lass
                # die Source unverändert.
                if (_sw and _sh
                        and (cw < _sw * 0.95 or ch < _sh * 0.95)):
                    cropped_path = os.path.join(video_only_dir, "decroped.mp4")
                    crop_cmd = [
                        ff, "-y", "-i", video_path,
                        "-vf", f"crop={cw}:{ch}:{cx}:{cy}",
                        "-c:v", "h264_videotoolbox", "-b:v", "12M",
                        "-pix_fmt", "yuv420p",
                        "-c:a", "copy",
                        "-movflags", "+faststart",
                        cropped_path,
                    ]
                    cr_res = subprocess.run(crop_cmd, capture_output=True,
                                            timeout=120)
                    if cr_res.returncode == 0 and os.path.isfile(cropped_path):
                        crop_input = cropped_path
                        print(f"[SmartCam/plugin] letterbox-crop OK: "
                              f"{_sw}x{_sh} → {cw}x{ch} (+{cx},{cy})",
                              flush=True)
                    else:
                        print("[SmartCam/plugin] letterbox-crop failed, "
                              "using original", flush=True)
                else:
                    print(f"[SmartCam/plugin] no letterbox detected "
                          f"(src={_sw}x{_sh}, crop={cw}x{ch})", flush=True)
        except Exception as e:
            print(f"[SmartCam/plugin] cropdetect error: {e}", flush=True)

        # VFR → CFR pre-convert: iPhone-Videos sind oft Variable Frame
        # Rate. OpenCV liest Frames ohne PTS und schreibt sie bei
        # uniformer 1/fps-Spacing — der Frame-Inhalt landet dadurch an
        # falschen Zeitpunkten gegenüber dem (real-timed) Audio. Über
        # die Clip-Länge baut sich der Versatz auf ("Bild kommt nach").
        # Wir transkodieren den Input vor OpenCV mit `-vsync cfr -r fps`
        # zu echtem CFR — danach stimmen Frame-Index und Wallclock-
        # Position überein, OpenCV's Annahmen passen.
        cfr_input = crop_input
        try:
            _src_probe = _probe_video(crop_input)
            _src_fps = float(_src_probe.get("fps") or 30.0)
            cfr_path = os.path.join(video_only_dir, "input_cfr.mp4")
            if progress_cb:
                try:
                    progress_cb("SmartCam: preparing source frame timing…")
                except Exception:
                    pass
            # Apple-Hardware-Encoder ist 5-10× schneller als libx264.
            # Bei 4K60-iPhone-Material killt libx264 die Bearbeitungs-
            # Zeit (10 min für 90 Sek Material). Videotoolbox encodet
            # in Echtzeit oder schneller.
            cfr_cmd = [
                get_ffmpeg_path(), "-y",
                "-i", crop_input,
                "-vsync", "cfr",
                "-r", f"{_src_fps:.6f}",
                "-c:v", "h264_videotoolbox", "-b:v", "12M",
                "-pix_fmt", "yuv420p",
                "-c:a", "copy",
                "-movflags", "+faststart",
                cfr_path,
            ]
            cfr_res = subprocess.run(cfr_cmd, capture_output=True)
            # Fallback auf libx264 wenn Videotoolbox nicht verfügbar
            # (z.B. Linux- oder Windows-Build).
            if cfr_res.returncode != 0 or not os.path.isfile(cfr_path):
                cfr_cmd_sw = [
                    get_ffmpeg_path(), "-y",
                    "-i", crop_input,
                    "-vsync", "cfr",
                    "-r", f"{_src_fps:.6f}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-bf", "0",
                    "-c:a", "copy",
                    "-movflags", "+faststart",
                    cfr_path,
                ]
                cfr_res = subprocess.run(cfr_cmd_sw, capture_output=True)
            if cfr_res.returncode == 0 and os.path.isfile(cfr_path):
                cfr_input = cfr_path
                print(f"[SmartCam/plugin] CFR pre-convert OK ({_src_fps:.4f} fps)",
                      flush=True)
            else:
                err = (cfr_res.stderr.decode(errors="ignore")
                       if cfr_res.stderr else "")[-200:]
                print(f"[SmartCam/plugin] CFR pre-convert failed: {err}",
                      flush=True)
        except Exception as e:
            print(f"[SmartCam/plugin] CFR pre-convert error: {e}",
                  flush=True)

        ok = smartcam_reframe_file(
            cfr_input, video_only, target_size,
            progress_cb=_cb,
            zoom_factor=zoom_factor,
            cancel_check=cancel_check,
        )
        if not ok or not os.path.isfile(video_only):
            print("[SmartCam/plugin] reframe failed — using original",
                  flush=True)
            return None

        # Mux original audio back into the silent OpenCV reframe AND
        # transkode mp4v → h264.
        #
        # AV-Sync ROOT CAUSE: iPhone-Phone-Videos haben oft eine `elst`
        # (Edit List) atom, die das Audio um 30–80 ms gegenüber dem
        # Video versetzt (für initial-sync Korrektur). Beim Standard-
        # Mux übernimmt ffmpeg den Audio-start_time-Offset → das SmartCam-
        # File hat dann z.B. audio.start_time=0.056 und video.start_time=0.
        # MoviePy seekt im subclip() Video und Audio bei dem gleichen
        # Wert, was den Offset kumulativ macht ("Bild kommt nach"). Fix:
        # beide Streams mit setpts/asetpts auf PTS-STARTPTS normalisieren —
        # dann starten beide garantiert bei t=0.
        # Im SmartCam-Mux beides fixen:
        # - `-bf 0`: keine B-Frames, sonst hat das Video DTS=-63ms beim
        #   ersten Frame. MoviePy seekt B-Frame-Streams unzuverlässig
        #   beim subclip — das ist Quelle des "Bild kommt nach Audio".
        # - `aresample=async=1:first_pts=0`: zwingt den ersten Audio-
        #   sample auf pts=0 statt AAC-encoder-priming-Delay von -23ms.
        # - `-avoid_negative_ts make_zero -fflags +genpts`: re-generiert
        #   alle PTS ab 0, fängt evtl. übriggebliebene Offsets ab.
        # Hardware-Encode via Apple Videotoolbox (5-10× schneller als
        # libx264). Bei iPhone 4K60 reduziert das den Mux-Schritt von
        # mehreren Minuten auf Sekunden. Fallback auf libx264 wenn
        # Videotoolbox auf der Plattform fehlt.
        mux_cmd = [
            get_ffmpeg_path(), "-y",
            "-fflags", "+genpts",
            "-i", video_only,
            "-i", cfr_input,
            "-filter_complex",
            "[0:v]setpts=PTS-STARTPTS[v];"
            "[1:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "h264_videotoolbox", "-b:v", "12M",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            "-shortest",
            final_path,
        ]
        mux = subprocess.run(mux_cmd, capture_output=True)
        if mux.returncode != 0 or not os.path.isfile(final_path):
            # Fallback Software-Encoder
            mux_sw = [
                get_ffmpeg_path(), "-y",
                "-fflags", "+genpts",
                "-i", video_only,
                "-i", cfr_input,
                "-filter_complex",
                "[0:v]setpts=PTS-STARTPTS[v];"
                "[1:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a]",
                "-map", "[v]", "-map", "[a]",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-bf", "0",
                "-c:a", "aac", "-b:a", "192k",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart",
                "-shortest",
                final_path,
            ]
            mux = subprocess.run(mux_sw, capture_output=True)
        if mux.returncode != 0 or not os.path.isfile(final_path):
            stderr = mux.stderr.decode(errors="ignore") if mux.stderr else ""
            print(f"[SmartCam/plugin] ffmpeg re-encode failed:\n{stderr[:500]}",
                  flush=True)
            # Try a fallback: just re-encode video without audio mux (no audio
            # input). Still produces a playable Premiere clip.
            alt_cmd = [
                get_ffmpeg_path(), "-y",
                "-i", video_only,
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                final_path,
            ]
            alt = subprocess.run(alt_cmd, capture_output=True)
            if alt.returncode != 0 or not os.path.isfile(final_path):
                return None
        return final_path
    except Exception as e:
        import traceback as _tb
        print(f"[SmartCam/plugin] EXCEPTION: {e}", flush=True)
        _tb.print_exc()
        return None


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
        "codec_name": "", "color_range": "", "color_space": "",
        "color_transfer": "", "color_primaries": "",
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

        # Color metadata
        info["codec_name"] = stream.get("codec_name", "")
        info["color_range"] = stream.get("color_range", "")
        info["color_space"] = stream.get("color_space", "")
        info["color_transfer"] = stream.get("color_transfer", "")
        info["color_primaries"] = stream.get("color_primaries", "")
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

    # Only normalize if rotation is detected — skip re-encoding to avoid color shifts
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

    source_duration = probe.get("duration", 0)

    # Validate cache: file must exist AND have a duration close to the source.
    # A previous run could have been killed mid-encode and left a truncated
    # file in the cache; the previous "size > 0" check let those through.
    if os.path.exists(norm_path) and os.path.getsize(norm_path) > 0:
        cached_duration = _probe_video(norm_path).get("duration", 0)
        if source_duration > 0 and cached_duration >= source_duration * 0.95:
            print(f"[VideoEditor] Using cached normalized video: {norm_path}")
            return norm_path
        print(f"[VideoEditor] Cached normalized video truncated ({cached_duration:.1f}s vs source {source_duration:.1f}s) — re-rendering")
        try:
            os.remove(norm_path)
        except OSError:
            pass

    try:
        from src.ffmpeg_utils import get_ffmpeg_path
        ffmpeg = get_ffmpeg_path()
    except Exception:
        ffmpeg = "ffmpeg"

    # Preserve color metadata to prevent brightness shift
    color_args = []
    if probe.get("color_range"):
        cr = "tv" if probe["color_range"] == "tv" else "pc"
        color_args += ["-color_range", cr]
    if probe.get("color_space"):
        color_args += ["-colorspace", probe["color_space"]]
    if probe.get("color_transfer"):
        color_args += ["-color_trc", probe["color_transfer"]]
    if probe.get("color_primaries"):
        color_args += ["-color_primaries", probe["color_primaries"]]

    cmd = [
        ffmpeg, "-i", video_path,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
    ] + color_args + [
        "-c:a", "copy",
        "-y", norm_path,
    ]

    print(f"[VideoEditor] Normalizing rotation ({rot}°)...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode != 0:
        print(f"[VideoEditor] Normalization failed: {result.stderr[-200:]}")
        try:
            if os.path.exists(norm_path):
                os.remove(norm_path)  # do not let a partial file poison the cache
        except OSError:
            pass
        return video_path

    # Final defence: even if ffmpeg returned 0, verify the output covers the
    # full source duration. Some ffmpeg builds report success on truncated
    # output (e.g. when the encoder was killed by Windows OOM mid-write).
    if source_duration > 0:
        out_duration = _probe_video(norm_path).get("duration", 0)
        if out_duration < source_duration * 0.95:
            print(f"[VideoEditor] Normalized output truncated ({out_duration:.1f}s vs source {source_duration:.1f}s) — discarding")
            try:
                os.remove(norm_path)
            except OSError:
                pass
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


def generate_premiere_xml_multi(clip_files, fps=None, target_ratio=None,
                                 style="clean", original_name=None):
    """Build an FCP7 XML for a sequence whose V1 track is a chain of N
    different source files placed back-to-back (each with subs already
    burned in). Audio mirrors the video layout on A1.

    `clip_files` = [(path, duration_seconds), ...] in timeline order.
    """
    if not clip_files:
        raise ValueError("No clips provided")

    # Probe the first clip for sequence framerate / dimensions.
    first_info = _probe_video(clip_files[0][0])
    if fps is None or fps == 0:
        fps = first_info["fps"]
    width = first_info["width"]
    height = first_info["height"]
    audio_channels = first_info.get("audio_channels", 2) or 2
    audio_sample_rate = first_info.get("audio_sample_rate", 48000) or 48000

    # target_ratio overrides the sequence dimensions (SmartCam reframe case).
    if target_ratio:
        try:
            rw, rh = target_ratio.split(":")
            ratio = int(rw) / int(rh)
            orig_w, orig_h = width, height
            if ratio < 1:
                width = min(orig_w, orig_h)
                height = int(width / ratio)
            else:
                height = min(orig_w, orig_h)
                width = int(height * ratio)
        except (ValueError, ZeroDivisionError):
            pass

    timebase, ntsc = _fps_to_timebase_ntsc(fps)
    ntsc_str = "TRUE" if ntsc else "FALSE"
    seq_uuid = str(uuid.uuid4())

    def fr(t):
        # Convert seconds to frames at the sequence timebase
        return int(round(t * timebase))

    # Build per-clip <clipitem> entries for V1 and A1
    v_items = []
    a_items = []
    timeline_pos = 0
    for idx, (path, dur) in enumerate(clip_files):
        if dur <= 0:
            continue
        file_id = f"file-{idx + 1}"
        clip_id = f"clipitem-{idx + 1}"
        a_clip_id = f"clipitem-a-{idx + 1}"
        a_file_id = file_id  # same source
        name = os.path.basename(path)
        pathurl = _make_pathurl(path)
        clip_frames = fr(dur)
        if clip_frames <= 0:
            clip_frames = 1

        seq_start = timeline_pos
        seq_end = timeline_pos + clip_frames
        in_pt = 0
        out_pt = clip_frames

        # The first reference of each file emits the full <file> block; later
        # references could re-use by id, but for safety we emit each clip's
        # <file> independently since Premiere will dedupe on pathurl.
        file_block = f"""
                <file id="{file_id}">
                    <name>{name}</name>
                    <pathurl>{pathurl}</pathurl>
                    <rate>
                        <timebase>{timebase}</timebase>
                        <ntsc>{ntsc_str}</ntsc>
                    </rate>
                    <duration>{clip_frames}</duration>
                    <media>
                        <video>
                            <samplecharacteristics>
                                <rate>
                                    <timebase>{timebase}</timebase>
                                    <ntsc>{ntsc_str}</ntsc>
                                </rate>
                                <width>{first_info['width']}</width>
                                <height>{first_info['height']}</height>
                            </samplecharacteristics>
                        </video>
                        <audio>
                            <samplecharacteristics>
                                <depth>16</depth>
                                <samplerate>{audio_sample_rate}</samplerate>
                            </samplecharacteristics>
                            <channelcount>{audio_channels}</channelcount>
                        </audio>
                    </media>
                </file>"""

        v_items.append(f"""
                    <clipitem id="{clip_id}">
                        <name>{name}</name>
                        <enabled>TRUE</enabled>
                        <duration>{clip_frames}</duration>
                        <rate>
                            <timebase>{timebase}</timebase>
                            <ntsc>{ntsc_str}</ntsc>
                        </rate>
                        <start>{seq_start}</start>
                        <end>{seq_end}</end>
                        <in>{in_pt}</in>
                        <out>{out_pt}</out>
                        {file_block}
                        <link>
                            <linkclipref>{clip_id}</linkclipref>
                            <mediatype>video</mediatype>
                            <trackindex>1</trackindex>
                            <clipindex>{idx + 1}</clipindex>
                        </link>
                        <link>
                            <linkclipref>{a_clip_id}</linkclipref>
                            <mediatype>audio</mediatype>
                            <trackindex>1</trackindex>
                            <clipindex>{idx + 1}</clipindex>
                        </link>
                    </clipitem>""")

        a_items.append(f"""
                        <clipitem id="{a_clip_id}">
                            <name>{name}</name>
                            <enabled>TRUE</enabled>
                            <duration>{clip_frames}</duration>
                            <rate>
                                <timebase>{timebase}</timebase>
                                <ntsc>{ntsc_str}</ntsc>
                            </rate>
                            <start>{seq_start}</start>
                            <end>{seq_end}</end>
                            <in>{in_pt}</in>
                            <out>{out_pt}</out>
                            <file id="{a_file_id}"/>
                            <sourcetrack>
                                <mediatype>audio</mediatype>
                                <trackindex>1</trackindex>
                            </sourcetrack>
                            <link>
                                <linkclipref>{clip_id}</linkclipref>
                                <mediatype>video</mediatype>
                                <trackindex>1</trackindex>
                                <clipindex>{idx + 1}</clipindex>
                            </link>
                            <link>
                                <linkclipref>{a_clip_id}</linkclipref>
                                <mediatype>audio</mediatype>
                                <trackindex>1</trackindex>
                                <clipindex>{idx + 1}</clipindex>
                            </link>
                        </clipitem>""")

        timeline_pos = seq_end

    total_frames = timeline_pos

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence id="sequence-1" TL.SQAudioVisibleBase="0" TL.SQVideoVisibleBase="0" TL.SQVisibleBaseTime="0" TL.SQAVDividerPosition="0.5" TL.SQHideShyTracks="0" TL.SQHeaderHeight="20" TL.SQVisibleBaseHeight="20" Monitor.ProgramZoomOut="0" Monitor.ProgramZoomIn="0" TL.SQTimePerPixel="0.13653136531365313" MZ.EditLine="0" MZ.Sequence.PreviewFrameSizeHeight="{height}" MZ.Sequence.PreviewFrameSizeWidth="{width}" MZ.Sequence.AudioTimeDisplayFormat="200" MZ.Sequence.PreviewRenderingClassID="1061109567" MZ.Sequence.PreviewRenderingPresetCodec="1634755443" MZ.Sequence.PreviewRenderingPresetPath="EncoderPresets/SequencePreview/795454d9-d3c2-429d-9474-923ab13b7018/QuickTime.epr" MZ.Sequence.PreviewUseMaxRenderQuality="false" MZ.Sequence.PreviewUseMaxBitDepth="false" MZ.Sequence.EditingModeGUID="9678af98-a7b7-4bdb-b477-7ac9c8df4a4e" MZ.Sequence.VideoTimeDisplayFormat="102" MZ.WorkOutPoint="0" MZ.WorkInPoint="0" explodedTracks="true">
        <uuid>{seq_uuid}</uuid>
        <duration>{total_frames}</duration>
        <rate>
            <timebase>{timebase}</timebase>
            <ntsc>{ntsc_str}</ntsc>
        </rate>
        <name>SmartCut - {original_name or os.path.basename(clip_files[0][0])}</name>
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
                        <pixelaspectratio>square</pixelaspectratio>
                        <fielddominance>none</fielddominance>
                        <colordepth>24</colordepth>
                    </samplecharacteristics>
                </format>
                <track>{"".join(v_items)}
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>
                <track>
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>
            </video>
            <audio>
                <numOutputChannels>2</numOutputChannels>
                <format>
                    <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>{audio_sample_rate}</samplerate>
                    </samplecharacteristics>
                </format>
                <outputs>
                    <group>
                        <index>1</index>
                        <numchannels>1</numchannels>
                        <downmix>0</downmix>
                        <channel>
                            <index>1</index>
                        </channel>
                    </group>
                    <group>
                        <index>2</index>
                        <numchannels>1</numchannels>
                        <downmix>0</downmix>
                        <channel>
                            <index>2</index>
                        </channel>
                    </group>
                </outputs>
                <track>{"".join(a_items)}
                    <enabled>TRUE</enabled>
                    <locked>FALSE</locked>
                </track>
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
        </timecode>
    </sequence>
</xmeml>
"""
    return xml


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

    # Color / codec metadata for XML
    codec_name = info.get("codec_name", "")
    color_range = info.get("color_range", "")

    # Map ffprobe codec to FCP7 XML codec name/appspecificdata
    # This tells Premiere how to interpret levels correctly
    _codec_map = {
        "h264": ("AVC Coding", "avc1"),
        "hevc": ("HEVC Coding", "hvc1"),
        "prores": ("Apple ProRes", "apch"),
        "mjpeg": ("Photo - JPEG", "jpeg"),
    }
    fcp_codec_name, fcp_codec_type = _codec_map.get(codec_name, ("", ""))

    # Build codec XML block (if we know the codec)
    codec_xml = ""
    if fcp_codec_name:
        codec_xml = f"""<codec>
                                            <name>{fcp_codec_name}</name>
                                            <appspecificdata>
                                                <appname>Final Cut Pro</appname>
                                                <appmanufacturer>Apple Inc.</appmanufacturer>
                                                <data>
                                                    <qtcodec>
                                                        <codecname>{fcp_codec_name}</codecname>
                                                        <codectypename>{fcp_codec_type}</codectypename>
                                                        <codecvendor>appl</codecvendor>
                                                    </qtcodec>
                                                </data>
                                            </appspecificdata>
                                        </codec>"""

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
                                        {codec_xml}
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

    # Always include an empty V2 track even when no subtitle clipitems —
    # the Premiere plugin's overlay-based subtitle workflow imports an
    # overlay clip onto V2 after the XML is loaded, which requires V2 to
    # exist. An empty <track> is valid FCP7 XML and renders as a blank
    # second video track.
    if not subtitle_track:
        subtitle_track = """
                <track>
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
                        {codec_xml}
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
