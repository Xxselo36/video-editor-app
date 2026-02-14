"""
Plugin API - Shared backend for NLE plugin integrations.

Provides video analysis (transcription, silence detection) as structured data
that can be consumed by DaVinci Resolve, Premiere Pro, Final Cut Pro, etc.
"""

import json
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional

from src.audio import AudioAnalyzer, Subtitle


@dataclass
class AnalysisResult:
    """Complete analysis result for a video."""
    video_path: str
    duration: float
    segments: list  # [(start, end), ...] speech segments
    subtitles: list  # [{"start", "end", "text"}, ...]
    style: str

    def to_dict(self):
        return {
            "video_path": self.video_path,
            "duration": self.duration,
            "segments": self.segments,
            "subtitles": [{"start": s["start"], "end": s["end"], "text": s["text"]}
                          for s in self.subtitles],
            "style": self.style,
        }

    def to_json(self, indent=2):
        return json.dumps(self.to_dict(), indent=indent)


def analyze_video(
    video_path: str,
    whisper_model: str = "medium",
    style: str = "clean",
    silence_threshold: float = 0.025,
    min_silence_duration: float = 0.6,
    padding_before: float = 0.35,
    padding_after: float = 0.25,
    progress_callback=None,
    cancel_check=None,
) -> AnalysisResult:
    """
    Analyze a video and return structured data for NLE plugins.

    Returns segments (cut points) and subtitles (word-level timestamps)
    without rendering anything. This data can be used by any NLE plugin.

    Args:
        video_path: Path to the video file.
        whisper_model: Whisper model size (tiny, base, small, medium, large).
        style: Style name for configuration defaults.
        silence_threshold: RMS threshold for silence detection.
        min_silence_duration: Minimum silence duration to cut (seconds).
        padding_before: Padding before speech segments (seconds).
        padding_after: Padding after speech segments (seconds).
        progress_callback: Optional callback(message, step, total_steps, progress).
        cancel_check: Optional callable that returns True to cancel.

    Returns:
        AnalysisResult with segments and subtitles.
    """
    from src.styles import get_style

    config = get_style(style)
    if silence_threshold is None:
        silence_threshold = config.get("silence_threshold", 0.025)
    if min_silence_duration is None:
        min_silence_duration = config.get("min_silence_to_cut", 0.6)

    analyzer = AudioAnalyzer(
        video_path,
        whisper_model=whisper_model,
        progress_callback=progress_callback,
    )

    # Step 1: Transcribe
    if progress_callback:
        progress_callback("Transcribing audio...", step=1, total_steps=3)

    if cancel_check and cancel_check():
        raise InterruptedError("Cancelled")

    subtitles = analyzer.transcribe()

    # Step 2: Detect silence / speech segments
    if progress_callback:
        progress_callback("Detecting speech segments...", step=2, total_steps=3)

    if cancel_check and cancel_check():
        raise InterruptedError("Cancelled")

    speech_segments = analyzer.detect_silence(
        silence_threshold=silence_threshold,
        min_silence_duration=min_silence_duration,
    )

    # Convert speech segments to (start, end) tuples with padding
    segments = []
    for seg in speech_segments:
        if seg.has_speech:
            start = max(0, seg.start - padding_before)
            end = seg.end + padding_after
            segments.append((round(start, 3), round(end, 3)))

    # Merge segments that are very close together
    merged = []
    for start, end in segments:
        if merged and start - merged[-1][1] < 0.4:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    segments = merged

    # Get video duration
    from moviepy.editor import VideoFileClip
    clip = VideoFileClip(video_path)
    duration = clip.duration
    clip.close()

    # Step 3: Map subtitles to new timeline (after cuts)
    if progress_callback:
        progress_callback("Mapping subtitles...", step=3, total_steps=3)

    mapped_subtitles = _map_subtitles_to_segments(subtitles, segments)

    return AnalysisResult(
        video_path=str(video_path),
        duration=duration,
        segments=segments,
        subtitles=mapped_subtitles,
        style=style,
    )


def _map_subtitles_to_segments(
    subtitles: list[Subtitle],
    segments: list[tuple],
) -> list[dict]:
    """
    Map original subtitle timestamps to the new timeline after cuts.

    Each subtitle is assigned to the segment it falls in, and its
    timestamps are adjusted to account for removed silence.
    """
    mapped = []
    timeline_offset = 0.0

    for seg_start, seg_end in segments:
        for sub in subtitles:
            # Subtitle falls within this segment
            if sub.start >= seg_start and sub.end <= seg_end:
                new_start = timeline_offset + (sub.start - seg_start)
                new_end = timeline_offset + (sub.end - seg_start)
                mapped.append({
                    "start": round(new_start, 3),
                    "end": round(new_end, 3),
                    "text": sub.text,
                    "original_start": round(sub.start, 3),
                    "original_end": round(sub.end, 3),
                })
            # Subtitle partially overlaps
            elif sub.start < seg_end and sub.end > seg_start:
                clipped_start = max(sub.start, seg_start)
                clipped_end = min(sub.end, seg_end)
                new_start = timeline_offset + (clipped_start - seg_start)
                new_end = timeline_offset + (clipped_end - seg_start)
                if new_end - new_start > 0.05:
                    mapped.append({
                        "start": round(new_start, 3),
                        "end": round(new_end, 3),
                        "text": sub.text,
                        "original_start": round(sub.start, 3),
                        "original_end": round(sub.end, 3),
                    })

        timeline_offset += (seg_end - seg_start)

    return mapped
