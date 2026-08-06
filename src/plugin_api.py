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
    fillers: list = None  # [{"start", "end", "word"}, ...] detected filler words
    language: str = None  # Whisper-detected ISO-Code (e.g. "de", "en")

    def to_dict(self):
        d = {
            "video_path": self.video_path,
            "duration": self.duration,
            "segments": self.segments,
            "subtitles": [{"start": s["start"], "end": s["end"], "text": s["text"]}
                          for s in self.subtitles],
            "style": self.style,
        }
        if self.fillers is not None:
            d["fillers"] = self.fillers
        if self.language is not None:
            d["language"] = self.language
        return d

    def to_json(self, indent=2):
        return json.dumps(self.to_dict(), indent=indent)


def analyze_video(
    video_path: str,
    whisper_model: str = "medium",
    style: str = "clean",
    silence_threshold: float = None,
    min_silence_duration: float = None,
    padding_before: float = None,
    padding_after: float = None,
    progress_callback=None,
    cancel_check=None,
    remove_fillers: bool = None,
    smart_cut: bool = None,
    filler_sensitivity: str = None,
    voice_triggers: bool = False,
    cut_keywords: list[str] | None = None,
    continue_keywords: list[str] | None = None,
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
        remove_fillers: Whether to detect and remove filler words (default from style).
        smart_cut: Whether to use smart cut optimization (default from style).
        filler_sensitivity: Filler detection sensitivity: "low", "medium", "high" (default from style).

    Returns:
        AnalysisResult with segments, subtitles, and optional filler data.
    """
    from src.styles import get_style

    config = get_style(style)
    if silence_threshold is None:
        silence_threshold = config.get("silence_threshold", 0.025)
    if min_silence_duration is None:
        min_silence_duration = config.get("min_silence_to_cut", 0.6)
    if padding_before is None:
        padding_before = config.get("keep_padding", 0.35)
    if padding_after is None:
        padding_after = config.get("keep_padding_after", config.get("keep_padding", 0.25))

    # Filler and smart cut settings — fall back to style config
    if remove_fillers is None:
        remove_fillers = config.get("remove_fillers", True)
    if smart_cut is None:
        smart_cut = config.get("smart_cut", True)
    if filler_sensitivity is None:
        filler_sensitivity = config.get("filler_sensitivity", "medium")

    analyzer = AudioAnalyzer(
        video_path,
        whisper_model=whisper_model,
        progress_callback=progress_callback,
    )

    total_steps = 3
    if remove_fillers:
        total_steps += 1
    if smart_cut:
        total_steps += 1
    current_step = 0

    # Step 1: Transcribe
    current_step += 1
    if progress_callback:
        progress_callback("Transcribing audio...", step=current_step, total_steps=total_steps)

    if cancel_check and cancel_check():
        raise InterruptedError("Cancelled")

    subtitles = analyzer.transcribe()

    # Step 2: Detect silence / speech segments
    current_step += 1
    if progress_callback:
        progress_callback("Detecting speech segments...", step=current_step, total_steps=total_steps)

    if cancel_check and cancel_check():
        raise InterruptedError("Cancelled")

    speech_segments = analyzer.detect_silence(
        silence_threshold=silence_threshold,
        min_silence_duration=min_silence_duration,
    )
    speech_only = [s for s in speech_segments if s.has_speech]
    total_speech = sum(s.end - s.start for s in speech_only)
    print(f"[silence] threshold={silence_threshold} "
          f"min_gap={min_silence_duration}s → "
          f"{len(speech_only)} speech regions, "
          f"total speech={total_speech:.1f}s", flush=True)

    # Convert speech segments to (start, end) tuples with padding
    segments = []
    for seg in speech_segments:
        if seg.has_speech:
            start = max(0, seg.start - padding_before)
            end = seg.end + padding_after
            segments.append((round(start, 3), round(end, 3)))

    # Merge segments that are very close together
    merge_gap = config.get("merge_gap", 0.4)
    merged = []
    for start, end in segments:
        if merged and start - merged[-1][1] < merge_gap:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    segments = merged
    print(f"[silence] after padding+merge: {len(segments)} segments, "
          f"total kept={sum(e - s for s, e in segments):.1f}s", flush=True)

    # Filler word detection and removal
    filler_data = None
    if remove_fillers:
        current_step += 1
        if progress_callback:
            progress_callback("Detecting filler words...", step=current_step, total_steps=total_steps)

        if cancel_check and cancel_check():
            raise InterruptedError("Cancelled")

        fillers = analyzer.get_filler_words(sensitivity=filler_sensitivity)
        print(f"[filler] {len(fillers)} filler word(s) detected: "
              f"{[f.word for f in fillers[:20]]}", flush=True)
        filler_data = [
            {"start": round(f.start, 3), "end": round(f.end, 3), "word": f.word}
            for f in fillers
        ]

        # Remove filler time ranges from speech segments
        if fillers:
            from src.filler_detection import FillerDetector
            detector = FillerDetector(sensitivity=filler_sensitivity)
            filler_segments = [(f.start, f.end) for f in fillers]
            segments_before = len(segments)
            total_before = sum(e - s for s, e in segments)
            segments = detector.filter_segments(segments, filler_segments)
            total_after = sum(e - s for s, e in segments)
            print(f"[filler] segments {segments_before}→{len(segments)}, "
                  f"time {total_before:.1f}s→{total_after:.1f}s "
                  f"(removed {total_before - total_after:.1f}s of filler)",
                  flush=True)

    # Get video duration
    from moviepy.editor import VideoFileClip
    clip = VideoFileClip(video_path)
    duration = clip.duration
    clip.close()

    # Smart cut optimization — snap silence-based cuts to natural break
    # points. MUST run BEFORE voice-triggers because it re-snaps every
    # segment boundary to the nearest word/sentence within ±1s. Running
    # it after voice-triggers would drag the trigger cuts back to a
    # nearby word boundary, effectively undoing the trigger removal
    # and leaving the failed take in the final video.
    if smart_cut and analyzer._transcription:
        current_step += 1
        if progress_callback:
            progress_callback("Optimizing cut points...", step=current_step, total_steps=total_steps)

        if cancel_check and cancel_check():
            raise InterruptedError("Cancelled")

        from src.smart_cut import SmartCutter
        cutter = SmartCutter(analyzer._transcription, duration)
        segments = cutter.optimize_cuts(segments)

    # Voice triggers — user said "cut" / "weiter" during the take,
    # remove those ranges from the speech segments. Runs LAST so the
    # trigger cuts are authoritative (nothing snaps them back).
    detected_trigger_pairs = []
    if voice_triggers and analyzer._transcription:
        if progress_callback:
            progress_callback("Detecting voice triggers (cut/weiter)…",
                              step=current_step, total_steps=total_steps)
        try:
            from src.voice_triggers import (
                collect_whisper_words,
                detect_voice_triggers,
                apply_voice_triggers_to_segments,
                apply_voice_triggers_to_subtitles,
            )
            ww = collect_whisper_words(analyzer._transcription)
            detected_trigger_pairs = detect_voice_triggers(
                ww,
                cut_keywords=cut_keywords,
                continue_keywords=continue_keywords,
                clip_duration=duration,
            )
            # Dump whisper words so we can see exactly what was heard
            print(f"[voice-triggers] whisper heard "
                  f"({len(ww)} words):", flush=True)
            print("[voice-triggers] " + " ".join(
                w.get("word", "").strip() for w in ww
            ), flush=True)
            print(f"[voice-triggers] {len(detected_trigger_pairs)} "
                  f"pair(s) detected:", flush=True)
            for p in detected_trigger_pairs:
                print(f"  '{p.cut_word}' @ {p.cut_start:.2f}s → "
                      f"'{p.continue_word}' @ {p.continue_end:.2f}s "
                      f"(range={p.continue_end - p.cut_start:.2f}s)",
                      flush=True)
            if detected_trigger_pairs:
                print(f"[voice-triggers] segments BEFORE apply: "
                      f"{len(segments)} kept, "
                      f"total={sum(e - s for s, e in segments):.2f}s",
                      flush=True)
                for i, (s, e) in enumerate(segments[:20]):
                    print(f"  seg{i}: {s:.2f}→{e:.2f}s "
                          f"({e - s:.2f}s)", flush=True)
                segments = apply_voice_triggers_to_segments(
                    segments, detected_trigger_pairs,
                )
                print(f"[voice-triggers] segments AFTER apply: "
                      f"{len(segments)} kept, "
                      f"total={sum(e - s for s, e in segments):.2f}s",
                      flush=True)
                for i, (s, e) in enumerate(segments[:20]):
                    print(f"  seg{i}: {s:.2f}→{e:.2f}s "
                          f"({e - s:.2f}s)", flush=True)
                # Also drop subtitles inside cut ranges so they don't
                # come back via the editor.
                subtitles = apply_voice_triggers_to_subtitles(
                    subtitles, detected_trigger_pairs,
                )
        except Exception as e:
            print(f"[voice-triggers] error: {e}", flush=True)

    # Map subtitles to new timeline (after cuts)
    current_step += 1
    if progress_callback:
        progress_callback("Mapping subtitles...", step=current_step, total_steps=total_steps)

    # Collect raw word-level confidence (Whisper probability per word)
    # so the editor can flag low-confidence phrases for manual review.
    raw_words: list[dict] = []
    try:
        for seg in (analyzer._transcription or {}).get("segments", []):
            for w in seg.get("words") or []:
                if w.get("start") is None or w.get("end") is None:
                    continue
                raw_words.append({
                    "start": float(w["start"]),
                    "end": float(w["end"]),
                    "probability": float(w.get("probability", 1.0)),
                })
    except Exception:
        raw_words = []

    mapped_subtitles = _map_subtitles_to_segments(subtitles, segments)
    # Attach avg Whisper probability per subtitle based on word overlap.
    for sub in mapped_subtitles:
        os_ = sub.get("original_start", sub["start"])
        oe_ = sub.get("original_end", sub["end"])
        overlapping = [
            w["probability"] for w in raw_words
            if w["start"] < oe_ and w["end"] > os_
        ]
        sub["confidence"] = (
            sum(overlapping) / len(overlapping) if overlapping else 1.0
        )

    # Whisper-detected language (ISO code: "de", "en", "fr", ...)
    _detected_lang = None
    try:
        _detected_lang = (analyzer._transcription or {}).get("language")
    except Exception:
        pass

    return AnalysisResult(
        video_path=str(video_path),
        duration=duration,
        segments=segments,
        subtitles=mapped_subtitles,
        style=style,
        fillers=filler_data,
        language=_detected_lang,
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
