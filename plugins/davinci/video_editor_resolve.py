"""
Video Editor - DaVinci Resolve Plugin

Integrates the Video Editor's transcription and silence detection
directly into DaVinci Resolve via Resolve's native UIManager + HTTP backend.

Architecture:
    Resolve UIManager (this script)  <-->  HTTP  <-->  video_editor_premiere.py (port 8456)

The same backend is reused — /analyze, /job-status, /export-xml are identical.
The FCP7 XML output works in Resolve via ImportTimelineFromFile().

Installation:
    1. Copy this file to:
       macOS:   /Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/
       Windows: %PROGRAMDATA%\\Blackmagic Design\\DaVinci Resolve\\Fusion\\Scripts\\Edit\\
       Linux:   /opt/resolve/Fusion/Scripts/Edit/
    2. Place video_editor_config.json next to it with:
       {"video_editor_path": "/path/to/video-editor-app"}
    3. Start the backend (or open Video Editor app — backend starts automatically)
    4. In Resolve:  Workspace -> Scripts -> Edit -> video_editor_resolve
"""

import sys
import os
import json
import re
import threading
import urllib.request
import urllib.error
import urllib.parse

# Backend URL (same server as Premiere plugin)
API_URL = "http://127.0.0.1:8456"

# Style definitions
STYLES = {
    1: ("Clean",    "clean",    "Tight cuts, phrase subtitles (4 words accumulating)"),
    2: ("Fast",     "fast",     "Fast cuts, word-by-word subtitles"),
    3: ("Balanced", "balanced", "Balanced cuts, word-by-word subtitles"),
    4: ("Smooth",   "smooth",   "Smooth cuts, word-by-word subtitles"),
    5: ("Minimal",  "minimal",  "Tight cuts, no subtitles"),
}

MODELS = {
    1: "tiny",
    2: "base",
    3: "small",
    4: "medium",
    5: "large",
}


# ============================================================================
# Resolve API helpers
# ============================================================================

def get_current_clip_path(resolve_app):
    """Get the source file path of the first clip on V1 of the active timeline."""
    try:
        project = resolve_app.GetProjectManager().GetCurrentProject()
        if not project:
            return None, None, None
        timeline = project.GetCurrentTimeline()
        if not timeline:
            return None, None, None

        clips = timeline.GetItemListInTrack("video", 1)
        if not clips or len(clips) == 0:
            return project, timeline, None

        clip = clips[0]
        media_pool_item = clip.GetMediaPoolItem()
        if media_pool_item:
            props = media_pool_item.GetClipProperty()
            file_path = props.get("File Path", "")
            if file_path and os.path.isfile(file_path):
                return project, timeline, file_path

        return project, timeline, None
    except Exception:
        return None, None, None


# ============================================================================
# HTTP helpers (urllib, no external deps)
# ============================================================================

def call_backend(path, timeout=10):
    """GET request to the backend, returns parsed JSON or None."""
    url = "{}{}".format(API_URL, path)
    try:
        response = urllib.request.urlopen(url, timeout=timeout)
        return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def check_backend():
    """Returns True if backend is reachable."""
    data = call_backend("/health", timeout=3)
    return data is not None and data.get("status") == "ok"


# ============================================================================
# SRT parser (mini, no external deps)
# ============================================================================

def parse_srt(srt_path):
    """Parse an SRT file into a list of {"start": float, "end": float, "text": str}."""
    if not srt_path or not os.path.isfile(srt_path):
        return []
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()

    entries = []
    blocks = re.split(r"\n\s*\n", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue
        ts_line = None
        text_start = 0
        for i, line in enumerate(lines):
            if "-->" in line:
                ts_line = line
                text_start = i + 1
                break
        if not ts_line:
            continue
        parts = ts_line.split("-->")
        if len(parts) != 2:
            continue
        start = _srt_time_to_seconds(parts[0].strip())
        end = _srt_time_to_seconds(parts[1].strip())
        text = " ".join(lines[text_start:]).strip()
        if start is not None and end is not None and text:
            entries.append({"start": start, "end": end, "text": text})
    return entries


def _srt_time_to_seconds(ts):
    """Convert SRT timestamp (HH:MM:SS,mmm) to float seconds."""
    ts = ts.replace(",", ".")
    m = re.match(r"(\d+):(\d+):(\d+)\.(\d+)", ts)
    if not m:
        return None
    h, mi, s, ms = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
    return h * 3600 + mi * 60 + s + ms / 1000.0


# ============================================================================
# Resolve: Import XML + SRT into new timeline
# ============================================================================

def import_into_resolve(resolve_app, xml_path, srt_path, clip_name, style_name):
    """
    Import FCP7 XML as a new timeline in Resolve.
    Creates a subfolder in the Media Pool, imports the XML, and adds subtitles.
    Returns (success: bool, message: str).
    """
    try:
        project = resolve_app.GetProjectManager().GetCurrentProject()
        if not project:
            return False, "No project open in Resolve"

        media_pool = project.GetMediaPool()
        root = media_pool.GetRootFolder()

        # Create subfolder (like a Bin in Premiere)
        folder_name = "{} - {}".format(clip_name, style_name)
        folder = media_pool.AddSubFolder(root, folder_name)
        if folder:
            media_pool.SetCurrentFolder(folder)
        else:
            media_pool.SetCurrentFolder(root)

        # Import FCP7 XML as new timeline
        timeline_name = "Video Editor - {}".format(clip_name)
        new_timeline = media_pool.ImportTimelineFromFile(xml_path, {
            "timelineName": timeline_name,
            "importSourceClips": True,
        })

        if not new_timeline:
            return False, "ImportTimelineFromFile failed"

        # Open the new timeline
        project.SetCurrentTimeline(new_timeline)

        # Add subtitles from SRT
        sub_count = 0
        if srt_path and os.path.isfile(srt_path):
            subs = parse_srt(srt_path)
            if subs:
                sub_count = _add_subtitles_to_timeline(new_timeline, subs)

        msg = "Created timeline '{}'".format(timeline_name)
        if sub_count > 0:
            msg += " + {} subtitles".format(sub_count)
        return True, msg

    except Exception as e:
        return False, "Import error: {}".format(e)


def _add_subtitles_to_timeline(timeline, subtitles):
    """Add SRT entries to a subtitle track on the timeline."""
    try:
        fps_str = timeline.GetSetting("timelineFrameRate")
        fps = float(fps_str) if fps_str else 24.0

        timeline.AddTrack("subtitle")
        sub_track_idx = timeline.GetTrackCount("subtitle")

        count = 0
        for sub in subtitles:
            start_frame = int(sub["start"] * fps)
            end_frame = int(sub["end"] * fps)
            if end_frame <= start_frame:
                continue
            try:
                timeline.InsertSubtitleInTrack(sub_track_idx, sub["text"], start_frame, end_frame)
                count += 1
            except Exception:
                try:
                    timeline.AddSubtitleToTrack(sub_track_idx, sub["text"], start_frame, end_frame)
                    count += 1
                except Exception:
                    pass
        return count
    except Exception:
        return 0


# ============================================================================
# UI using Resolve's native UIManager (fusion.UIManager + bmd.UIDispatcher)
# ============================================================================

# Globals provided by Resolve when running from Workspace -> Scripts
# resolve, fusion, bmd are automatically available

winID = "com.videoeditor.resolve"

ui = fusion.UIManager
dispatcher = bmd.UIDispatcher(ui)

# Check for existing instance
existing = ui.FindWindow(winID)
if existing:
    existing.Show()
    existing.Raise()
    exit()

# State
_processing = False
_poll_timer = None

# Dark stylesheet matching Resolve theme
_STYLESHEET = """
    QWidget { background-color: #1a1a1f; color: #f0f0f2; font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; }
    QLabel { background-color: transparent; }
    QComboBox { background-color: #222228; border: 1px solid #2a2a32; border-radius: 4px; padding: 6px 8px; color: #f0f0f2; }
    QComboBox:focus { border-color: #6c5ce7; }
    QComboBox QAbstractItemView { background-color: #222228; color: #f0f0f2; selection-background-color: #6c5ce7; }
    QPushButton#processBtn { background-color: #6c5ce7; color: white; border: none; border-radius: 6px; padding: 12px; font-size: 13px; font-weight: bold; }
    QPushButton#processBtn:hover { background-color: #7c6cf7; }
    QPushButton#processBtn:disabled { background-color: #2d2640; color: #5a5a64; }
    QProgressBar { background-color: #2d2640; border: none; border-radius: 2px; height: 4px; text-align: center; }
    QProgressBar::chunk { background-color: #6c5ce7; border-radius: 2px; }
"""

# Build window
win = dispatcher.AddWindow({
    'ID': winID,
    'WindowTitle': "Video Editor",
    'Geometry': [300, 200, 350, 460],
    'StyleSheet': _STYLESHEET,
}, [
    ui.VGroup({'Spacing': 8, 'Weight': 0}, [
        # Header
        ui.Label({
            'Text': "<b style='font-size:16px; color:#f0f0f2;'>VIDEO EDITOR</b>",
            'Alignment': { 'AlignLeft': True },
            'Weight': 0,
        }),
        ui.Label({
            'ID': 'subtitle',
            'Text': "<span style='font-size:10px; color:#5a5a64;'>AI-powered video editing — DaVinci Resolve</span>",
            'Weight': 0,
        }),

        ui.VGap(4),

        # Clip info
        ui.Label({
            'ID': 'clipInfo',
            'Text': "No clip detected — add a clip to the timeline",
            'StyleSheet': "background-color: #131316; border: 1px solid #2a2a32; border-radius: 6px; padding: 8px; color: #8e8e96; font-size: 11px;",
            'Weight': 0,
            'WordWrap': True,
        }),

        ui.VGap(4),

        # Style
        ui.Label({
            'Text': "<b style='font-size:10px; color:#8e8e96;'>STYLE</b>",
            'Weight': 0,
        }),
        ui.ComboBox({
            'ID': 'styleCombo',
            'Weight': 0,
        }),
        ui.Label({
            'ID': 'styleDesc',
            'Text': "<span style='font-size:10px; color:#5a5a64;'>Tight cuts, phrase subtitles (4 words accumulating)</span>",
            'Weight': 0,
        }),

        ui.VGap(2),

        # Whisper Model
        ui.Label({
            'Text': "<b style='font-size:10px; color:#8e8e96;'>WHISPER MODEL</b>",
            'Weight': 0,
        }),
        ui.ComboBox({
            'ID': 'modelCombo',
            'Weight': 0,
        }),

        ui.VGap(6),

        # Process button
        ui.Button({
            'ID': 'processBtn',
            'Text': "Process Selected Clip",
            'Weight': 0,
        }),

        # Progress bar
        ui.Label({
            'ID': 'progressBar',
            'Text': "",
            'StyleSheet': "background-color: #2d2640; border-radius: 2px; min-height: 4px; max-height: 4px;",
            'Weight': 0,
            'Hidden': True,
        }),

        # Status
        ui.Label({
            'ID': 'statusLabel',
            'Text': "",
            'StyleSheet': "padding: 8px; border-radius: 6px; font-size: 11px;",
            'Weight': 0,
            'WordWrap': True,
            'Hidden': True,
        }),

        ui.VGap(0, 1),

        # Connection indicator
        ui.Label({
            'ID': 'connLabel',
            'Text': "<span style='font-size:10px; color:#5a5a64;'>Checking backend...</span>",
            'Alignment': { 'AlignHCenter': True },
            'Weight': 0,
        }),
    ]),
])

itm = win.GetItems()

# Populate combos
for idx in sorted(STYLES.keys()):
    itm['styleCombo'].AddItem(STYLES[idx][0])
itm['styleCombo'].CurrentIndex = 0

for idx in sorted(MODELS.keys()):
    itm['modelCombo'].AddItem(MODELS[idx])
itm['modelCombo'].CurrentIndex = 3  # "medium" default


# ============================================================================
# UI helper functions
# ============================================================================

def get_selected_style():
    idx = itm['styleCombo'].CurrentIndex + 1
    return STYLES.get(idx, STYLES[1])

def get_selected_model():
    idx = itm['modelCombo'].CurrentIndex + 1
    return MODELS.get(idx, "medium")

def set_status(level, message):
    colors = {
        "info":    ("background-color: #1a1a3c; color: #7a8eff;",),
        "success": ("background-color: #0a2a0a; color: #00c853;",),
        "error":   ("background-color: #2a0a0a; color: #ef5350;",),
    }
    style_str = colors.get(level, ("color: #8e8e96;",))[0]
    itm['statusLabel'].StyleSheet = style_str + " padding: 8px; border-radius: 6px; font-size: 11px;"
    itm['statusLabel'].Text = message
    itm['statusLabel'].Hidden = False

def set_progress_visible(visible):
    itm['progressBar'].Hidden = not visible

def set_progress(pct):
    pct = max(0, min(100, int(pct)))
    filled_w = int(3.1 * pct)  # ~310px max width
    bar_css = (
        "min-height: 4px; max-height: 4px; border-radius: 2px; "
        "background: qlineargradient(x1:0, y1:0, x2:1, y2:0, "
        "stop:0 #6c5ce7, stop:{} #6c5ce7, stop:{} #2d2640, stop:1 #2d2640);"
    ).format(pct / 100.0, pct / 100.0 + 0.001)
    itm['progressBar'].StyleSheet = bar_css
    itm['progressBar'].Hidden = False

def update_clip_info():
    _, _, path = get_current_clip_path(resolve)
    if path:
        name = os.path.basename(path)
        itm['clipInfo'].Text = "<b style='color:#f0f0f2;'>{}</b>".format(name)
    else:
        itm['clipInfo'].Text = "No clip detected — add a clip to the timeline"

def update_connection():
    ok = check_backend()
    if ok:
        itm['connLabel'].Text = "<span style='font-size:10px; color:#00c853;'>● Connected to Video Editor</span>"
    else:
        itm['connLabel'].Text = "<span style='font-size:10px; color:#ef5350;'>● Open Video Editor app to connect</span>"


# ============================================================================
# Event handlers
# ============================================================================

def OnClose(ev):
    dispatcher.ExitLoop()

def OnStyleChanged(ev):
    _, _, desc = get_selected_style()
    itm['styleDesc'].Text = "<span style='font-size:10px; color:#5a5a64;'>{}</span>".format(desc)

def OnProcess(ev):
    global _processing
    if _processing:
        return

    # Get clip
    _, _, clip_path = get_current_clip_path(resolve)
    if not clip_path:
        set_status("error", "No clip found on the timeline.")
        return

    if not check_backend():
        set_status("error", "Backend offline — start the Video Editor app first.")
        return

    _processing = True
    itm['processBtn'].Text = "Processing..."
    itm['processBtn'].Enabled = False
    set_progress(5)
    set_status("info", "Starting analysis...")

    style_label, style_value, _ = get_selected_style()
    model = get_selected_model()

    # Start analysis in background thread
    def run_analysis():
        url = "/analyze?video_path={}&style={}&whisper_model={}".format(
            urllib.parse.quote(clip_path, safe=''), style_value, model)
        data = call_backend(url, timeout=15)
        if data and data.get("error"):
            dispatcher.dispatch_to_main(lambda: on_analysis_error(data["error"]))
        elif data is None:
            dispatcher.dispatch_to_main(lambda: on_analysis_error("Could not reach backend"))
        else:
            # Started, begin polling
            poll_job_status(clip_path, style_label, style_value)

    threading.Thread(target=run_analysis, daemon=True).start()

def poll_job_status(clip_path, style_label, style_value):
    """Poll /job-status in a background thread until done or error."""
    import time
    while True:
        time.sleep(2)
        data = call_backend("/job-status", timeout=5)
        if not data:
            continue

        pct = data.get("progress", 0)
        msg = data.get("message", "")
        status = data.get("status", "")

        # Update UI from this thread (Resolve's UIManager is thread-safe for text updates)
        try:
            set_progress(pct)
            if msg:
                set_status("info", msg)
        except Exception:
            pass

        if status == "done":
            on_analysis_done(data, clip_path, style_label, style_value)
            return
        elif status == "error":
            on_analysis_error(data.get("error", "Analysis failed"))
            return

def on_analysis_done(job_data, clip_path, style_label, style_value):
    global _processing
    try:
        set_progress(90)
        set_status("info", "Creating edited timeline...")

        cuts = job_data.get("segments_count", 0)

        # Fetch XML + SRT
        xml_data = call_backend("/export-xml", timeout=30)
        if not xml_data or xml_data.get("error"):
            err = (xml_data or {}).get("error", "Export failed")
            on_analysis_error(err)
            return

        xml_path = xml_data.get("xml_path", "")
        srt_path = xml_data.get("srt_path", "")
        clip_name = os.path.splitext(os.path.basename(clip_path))[0]

        # Import into Resolve
        ok, msg = import_into_resolve(resolve, xml_path, srt_path, clip_name, style_label)

        if ok:
            set_progress(100)
            final_msg = "Done! {} cuts".format(cuts)
            if srt_path:
                final_msg += " + subtitles"
            final_msg += ". ({})".format(style_label)
            set_status("success", final_msg)
        else:
            set_status("error", msg)

    except Exception as e:
        set_status("error", str(e))
    finally:
        _processing = False
        itm['processBtn'].Text = "Process Selected Clip"
        itm['processBtn'].Enabled = True

def on_analysis_error(error_msg):
    global _processing
    set_status("error", str(error_msg))
    _processing = False
    itm['processBtn'].Text = "Process Selected Clip"
    itm['processBtn'].Enabled = True


# ============================================================================
# Wire up events
# ============================================================================

win.On[winID].Close = OnClose
win.On['processBtn'].Clicked = OnProcess
win.On['styleCombo'].CurrentIndexChanged = OnStyleChanged


# ============================================================================
# Initial state + show window
# ============================================================================

update_clip_info()

# Connection check + periodic clip detection in background
def periodic_updates():
    import time
    while True:
        try:
            update_connection()
            if not _processing:
                update_clip_info()
        except Exception:
            pass
        time.sleep(5)

threading.Thread(target=periodic_updates, daemon=True).start()

win.Show()
dispatcher.RunLoop()
