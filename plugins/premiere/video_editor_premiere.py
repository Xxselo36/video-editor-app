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
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import threading

# Path to the Video Editor installation
VIDEO_EDITOR_PATH = os.environ.get(
    "VIDEO_EDITOR_PATH",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

if VIDEO_EDITOR_PATH not in sys.path:
    sys.path.insert(0, VIDEO_EDITOR_PATH)


class VideoEditorHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Premiere Pro plugin."""

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._respond(200, {"status": "ok", "version": "1.0.0"})

        elif parsed.path == "/styles":
            from src.styles import get_style_info
            styles = get_style_info()
            self._respond(200, {"styles": styles})

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
                progress_callback=lambda msg, **kw: print(f"  {msg}"),
            )

            self._respond(200, result.to_dict())

        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _handle_export_xml(self, data):
        """Export analysis results as Premiere Pro XML."""
        video_path = data.get("video_path")
        segments = data.get("segments", [])
        subtitles = data.get("subtitles", [])
        fps = data.get("fps", 24)

        if not video_path:
            self._respond(400, {"error": "video_path required"})
            return

        xml = generate_premiere_xml(video_path, segments, subtitles, fps)
        self._respond(200, {"xml": xml})

    def _handle_export_edl(self, data):
        """Export analysis results as EDL (Edit Decision List)."""
        segments = data.get("segments", [])
        fps = data.get("fps", 24)
        title = data.get("title", "Video Editor Export")

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


def generate_premiere_xml(video_path, segments, subtitles, fps=24):
    """
    Generate a Premiere Pro compatible XML (FCP7 XML format).

    This XML can be imported into Premiere Pro to create a sequence
    with cuts and subtitle markers.
    """
    filename = os.path.basename(video_path)
    total_frames = sum(int((end - start) * fps) for start, end in segments)

    clips_xml = []
    timeline_frame = 0

    for i, (seg_start, seg_end) in enumerate(segments):
        in_frame = int(seg_start * fps)
        out_frame = int(seg_end * fps)
        duration_frames = out_frame - in_frame

        clips_xml.append(f"""
                    <clipitem id="clip-{i+1}">
                        <name>{filename} - Segment {i+1}</name>
                        <duration>{duration_frames}</duration>
                        <rate><timebase>{int(fps)}</timebase></rate>
                        <in>{in_frame}</in>
                        <out>{out_frame}</out>
                        <start>{timeline_frame}</start>
                        <end>{timeline_frame + duration_frames}</end>
                        <file id="file-1">
                            <name>{filename}</name>
                            <pathurl>file://localhost{video_path}</pathurl>
                            <rate><timebase>{int(fps)}</timebase></rate>
                        </file>
                    </clipitem>""")

        timeline_frame += duration_frames

    # Subtitle markers
    markers_xml = []
    for sub in subtitles:
        frame = int(sub["start"] * fps)
        markers_xml.append(f"""
                <marker>
                    <name>{sub["text"]}</name>
                    <in>{frame}</in>
                    <out>{int(sub["end"] * fps)}</out>
                    <comment>Subtitle</comment>
                </marker>""")

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence>
        <name>Video Editor - {filename}</name>
        <duration>{total_frames}</duration>
        <rate><timebase>{int(fps)}</timebase></rate>
        <media>
            <video>
                <track>{"".join(clips_xml)}
                </track>
            </video>
        </media>{"".join(markers_xml)}
    </sequence>
</xmeml>"""
    return xml


def generate_edl(segments, fps=24, title="Video Editor Export"):
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


def start_server(port=8456):
    """Start the local backend server."""
    server = HTTPServer(("127.0.0.1", port), VideoEditorHandler)
    print(f"Video Editor backend running on http://127.0.0.1:{port}")
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
    parser = argparse.ArgumentParser(description="Video Editor - Premiere Pro Backend")
    parser.add_argument("--port", type=int, default=8456)
    args = parser.parse_args()
    start_server(port=args.port)
