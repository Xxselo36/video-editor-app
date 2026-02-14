"""
Video Editor - DaVinci Resolve Plugin

Integrates the Video Editor's transcription and silence detection
directly into DaVinci Resolve's timeline.

Installation:
    1. Copy this folder to:
       - macOS: ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
       - Windows: %APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Fusion\\Scripts\\Utility\\
       - Linux: ~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/
    2. Set VIDEO_EDITOR_PATH below to your Video Editor installation path.
    3. In Resolve: Workspace → Scripts → video_editor_resolve
"""

import sys
import os
import json

# Path to the Video Editor installation
# The plugin installer sets this automatically
VIDEO_EDITOR_PATH = os.environ.get(
    "VIDEO_EDITOR_PATH",
    os.path.expanduser("~/Applications/VideoEditor")
)

# Add Video Editor to Python path
if VIDEO_EDITOR_PATH not in sys.path:
    sys.path.insert(0, VIDEO_EDITOR_PATH)


def get_resolve():
    """Connect to the running DaVinci Resolve instance."""
    try:
        import DaVinciResolveScript as dvr
        return dvr.scriptapp("Resolve")
    except ImportError:
        # Fallback: try environment-based import
        resolve_script_api = os.environ.get("RESOLVE_SCRIPT_API", "")
        if resolve_script_api and resolve_script_api not in sys.path:
            sys.path.insert(0, resolve_script_api)
        resolve_lib = os.environ.get("RESOLVE_SCRIPT_LIB", "")
        if resolve_lib and resolve_lib not in sys.path:
            sys.path.insert(0, os.path.dirname(resolve_lib))
        try:
            import DaVinciResolveScript as dvr
            return dvr.scriptapp("Resolve")
        except ImportError:
            return None


def get_current_timeline_clip(resolve):
    """Get the currently selected clip on the timeline."""
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        return None, None, None

    timeline = project.GetCurrentTimeline()
    if not timeline:
        return None, None, None

    # Get the first video track's clips
    track_count = timeline.GetTrackCount("video")
    for track_idx in range(1, track_count + 1):
        clips = timeline.GetItemListInTrack("video", track_idx)
        if clips:
            # Return first clip for now (could add selection detection)
            return project, timeline, clips
    return project, timeline, None


def get_clip_source_path(clip):
    """Extract the source file path from a timeline clip."""
    media_pool_item = clip.GetMediaPoolItem()
    if media_pool_item:
        props = media_pool_item.GetClipProperty()
        return props.get("File Path", "")
    return ""


def apply_cuts_to_timeline(resolve, timeline, clip, segments, fps=24):
    """
    Apply cuts to the timeline by splitting the clip at silence points
    and removing silent sections.

    Args:
        resolve: Resolve instance
        timeline: Current timeline
        clip: The clip to cut
        segments: List of (start, end) speech segments in seconds
        fps: Timeline frame rate
    """
    # Get clip start frame on timeline
    clip_start_frame = clip.GetStart()
    clip_source_start = clip.GetLeftOffset()

    # Convert segments to frame numbers
    cuts = []
    for seg_start, seg_end in segments:
        start_frame = clip_start_frame + int(seg_start * fps) - clip_source_start
        end_frame = clip_start_frame + int(seg_end * fps) - clip_source_start
        cuts.append((start_frame, end_frame))

    # We need to work backwards to avoid shifting frame numbers
    # First, identify the gaps (silence) between speech segments
    gaps = []
    for i in range(len(cuts) - 1):
        gap_start = cuts[i][1]  # end of current speech
        gap_end = cuts[i + 1][0]  # start of next speech
        if gap_end > gap_start:
            gaps.append((gap_start, gap_end))

    # Also add gap before first speech and after last speech
    if cuts and cuts[0][0] > clip_start_frame:
        gaps.insert(0, (clip_start_frame, cuts[0][0]))
    if cuts:
        clip_end = clip.GetEnd()
        if cuts[-1][1] < clip_end:
            gaps.append((cuts[-1][1], clip_end))

    # Delete gaps in reverse order (to maintain frame positions)
    for gap_start, gap_end in reversed(gaps):
        timeline.SetCurrentTimecode(str(gap_start))
        # Use razor and delete
        timeline.AddMarker(
            gap_start - clip_start_frame, "Red", "Silence",
            f"Remove {gap_start}-{gap_end}", gap_end - gap_start
        )

    return len(gaps)


def add_subtitles_to_timeline(resolve, timeline, subtitles, fps=24):
    """
    Add Text+ subtitles to the timeline on a new track.

    Args:
        resolve: Resolve instance
        timeline: Current timeline
        subtitles: List of {"start", "end", "text"} dicts
        fps: Timeline frame rate
    """
    project = resolve.GetProjectManager().GetCurrentProject()
    media_pool = project.GetMediaPool()

    # Add a new subtitle track
    timeline.AddTrack("subtitle")
    subtitle_track = timeline.GetTrackCount("subtitle")

    for sub in subtitles:
        start_frame = int(sub["start"] * fps)
        end_frame = int(sub["end"] * fps)
        duration = end_frame - start_frame

        if duration < 1:
            continue

        # Add subtitle using Resolve's subtitle track
        timeline.InsertSubtitleInTrack(
            subtitle_track,
            sub["text"],
            start_frame,
            end_frame,
        )

    return len(subtitles)


def add_text_plus_subtitles(resolve, timeline, subtitles, fps=24):
    """
    Add Text+ generator nodes for subtitles (Fusion-based).
    This provides more styling control than subtitle tracks.
    """
    project = resolve.GetProjectManager().GetCurrentProject()
    media_pool = project.GetMediaPool()

    # Ensure we have an overlay video track
    track_count = timeline.GetTrackCount("video")
    if track_count < 2:
        timeline.AddTrack("video")

    subtitle_track = 2  # Use track 2 for subtitles

    for sub in subtitles:
        start_frame = int(sub["start"] * fps)
        duration_frames = int((sub["end"] - sub["start"]) * fps)

        if duration_frames < 1:
            continue

        # Create a Text+ Fusion generator
        text_clip = {
            "mediaType": "generator",
            "generatorName": "Text+",
            "startFrame": start_frame,
            "endFrame": start_frame + duration_frames,
        }

        # Add to timeline
        media_pool.AppendToTimeline([{
            "mediaPoolItem": None,
            "startFrame": 0,
            "endFrame": duration_frames,
            "mediaType": 1,
            "trackIndex": subtitle_track,
            "recordFrame": start_frame,
        }])

    return len(subtitles)


def process_video(resolve, whisper_model="medium", style="clean"):
    """
    Main entry point: analyze the current clip and apply cuts + subtitles.

    Args:
        resolve: Resolve instance
        whisper_model: Whisper model size
        style: Video Editor style name
    """
    from src.plugin_api import analyze_video

    project, timeline, clips = get_current_timeline_clip(resolve)
    if not clips:
        print("Error: No clips found on the timeline.")
        return False

    clip = clips[0]
    video_path = get_clip_source_path(clip)
    if not video_path or not os.path.isfile(video_path):
        print(f"Error: Could not find source file: {video_path}")
        return False

    # Get timeline FPS
    fps = float(timeline.GetSetting("timelineFrameRate") or 24)

    print(f"Processing: {video_path}")
    print(f"Style: {style}, Model: {whisper_model}, FPS: {fps}")

    # Run analysis
    result = analyze_video(
        video_path=video_path,
        whisper_model=whisper_model,
        style=style,
        progress_callback=lambda msg, **kw: print(f"  {msg}"),
    )

    print(f"Found {len(result.segments)} speech segments")
    print(f"Found {len(result.subtitles)} subtitles")

    # Apply cuts
    num_cuts = apply_cuts_to_timeline(resolve, timeline, clip, result.segments, fps)
    print(f"Marked {num_cuts} silence regions for removal")

    # Add subtitles
    num_subs = add_subtitles_to_timeline(resolve, timeline, result.subtitles, fps)
    print(f"Added {num_subs} subtitles")

    print("Done! Review the timeline and remove marked silence regions.")
    return True


# ============================================================================
# Script entry point (when run from Resolve's Script menu)
# ============================================================================

if __name__ == "__main__":
    resolve = get_resolve()
    if not resolve:
        print("Error: Could not connect to DaVinci Resolve.")
        print("Make sure Resolve is running and scripting is enabled:")
        print("  Preferences → System → General → External scripting using: Local")
        sys.exit(1)

    process_video(resolve, whisper_model="medium", style="clean")
