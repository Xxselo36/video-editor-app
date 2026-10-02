"""
Plugin API - Shared backend for NLE plugin integrations.

Provides video analysis (transcription, silence detection) as structured data
that can be consumed by DaVinci Resolve, Premiere Pro, Final Cut Pro, etc.
"""

import json
import os
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
    scene_events: list = None  # [{"type", "start", "end", "source"}, ...]
    all_words: list = None  # Whisper words for user "add missing command"
    # Every transcribed word before the caption-unit gluing, fillers
    # included ({text, start, end, probability}); only with
    # analyze_video(include_words=True) — the web edit document.
    words: list = None

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
        if self.scene_events is not None:
            d["scene_events"] = self.scene_events
        return d

    def to_json(self, indent=2):
        return json.dumps(self.to_dict(), indent=indent)


def _log_cuts(log: list | None, kind: str, ranges) -> None:
    """Append (kind, start, end) per range to `log` (analyze_video's
    cut_kinds); nothing without a log."""
    if log is None:
        return
    for r in ranges or ():
        try:
            log.append((kind, float(r[0]), float(r[1])))
        except (IndexError, TypeError, ValueError):
            continue


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
    include_words: bool = False,
    cut_kinds: list | None = None,
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
        include_words: Also return every transcribed word (AnalysisResult.words)
            before short words are glued into caption units (web backend only).
        cut_kinds: A list to log every detector's cut ranges into, as
            (kind, start, end) with kind "filler" or "voice_cmd" (web
            backend only: the editor names each cut). None: no log; the
            analysis itself is the same either way.

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

    # Hallucination cleanup: Whisper's decoder sometimes loops on a
    # single token (dozens of 'um um um' in a row) when audio is
    # ambiguous. Detect the run in the word list, cut the audio range,
    # and drop the fake tokens from the transcript BEFORE anything
    # else looks at it (voice-command LLM, filler, stutter, mumble).
    _hallucination_cuts_to_apply: list[tuple[float, float]] = []
    # Every range a detector deliberately cuts (loops, fillers, gaps,
    # stutters, …). Smart cut runs later and snaps segment edges to
    # word/sentence boundaries — which used to pull a cut 'äh' next to a
    # comma or full stop straight back in. These ranges are re-applied
    # after smart cut so it can adjust edges but never undo a cut.
    _intentional_cuts: list[tuple[float, float]] = []
    if analyzer._transcription:
        try:
            from src.hallucination_detection import find_hallucination_cuts
            hallucinations = find_hallucination_cuts(analyzer._transcription)
            if hallucinations:
                for (s, e, tok, n) in hallucinations:
                    print(f"[hallucination] cut {s:.2f}-{e:.2f}s "
                          f"({n}× {tok!r}) — Whisper loop", flush=True)
                    _hallucination_cuts_to_apply.append((s, e))
                # Strip the looped tokens from the transcription so
                # downstream text-based detectors don't see them.
                for seg in analyzer._transcription.get("segments") or []:
                    words = seg.get("words") or []
                    seg["words"] = [
                        w for w in words
                        if not any(
                            s <= float(w.get("start") or 0) < e
                            for (s, e) in _hallucination_cuts_to_apply
                        )
                    ]
        except Exception as _e:
            print(f"[hallucination] skipped: {_e}", flush=True)
        # Prompt leak: Whisper occasionally copies a prompt example
        # sentence ('Ähm, also, äh, ich hab da, …') into near-silent
        # audio. Cut and strip it the same way as a loop.
        try:
            from src.hallucination_detection import find_prompt_leak_cuts
            from src.audio import (
                DISFLUENT_DE, DISFLUENT_EN, _disfluent_prompt_enabled,
            )
            _leaks = find_prompt_leak_cuts(
                analyzer._transcription, [DISFLUENT_DE, DISFLUENT_EN],
            ) if _disfluent_prompt_enabled() else []
            if _leaks:
                for (s, e, t) in _leaks:
                    print(f"[prompt-leak] cut {s:.2f}-{e:.2f}s: {t!r}", flush=True)
                    _hallucination_cuts_to_apply.append((s, e))
                for seg in analyzer._transcription.get("segments") or []:
                    seg["words"] = [
                        w for w in (seg.get("words") or [])
                        if not any(
                            s <= float(w.get("start") or 0) < e
                            for (s, e, _t) in _leaks
                        )
                    ]
        except Exception as _e:
            print(f"[prompt-leak] skipped: {_e}", flush=True)

    # Voice-command correction: LLM scans the raw transcript for spots
    # where Whisper mangled a Cleo command in mixed-language audio and
    # rewrites those tokens in-place. Runs BEFORE any detector so scene/
    # voice triggers see clean command phrases. Soft-fails: on no key or
    # error the transcript is unchanged, downstream still works.
    if analyzer._transcription:
        try:
            from backend.llm import correct_voice_commands
            _detected_lang_early = analyzer._transcription.get("language")
            correct_voice_commands(
                analyzer._transcription, language=_detected_lang_early,
            )
        except Exception as _e:
            print(f"[cmd-fix] skipped: {_e}", flush=True)

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

    # Drop Whisper hallucinations: subtitles that fall entirely in
    # silence-detected regions. Common pattern is 'Ja' at t=0.0-0.3s
    # when the audio actually starts with silence — Whisper's decoder
    # guesses common German intros when it's not sure.
    if speech_only:
        speech_ranges = [(s.start, s.end) for s in speech_only]
        def _has_speech_overlap(sub_start: float, sub_end: float) -> bool:
            for ss, se in speech_ranges:
                if sub_start < se and sub_end > ss:
                    return True
            return False
        before = len(subtitles)
        subtitles = [
            sub for sub in subtitles
            if _has_speech_overlap(sub.start, sub.end)
        ]
        dropped = before - len(subtitles)
        if dropped > 0:
            print(f"[hallucination-filter] dropped {dropped} subtitle(s) "
                  f"outside any speech region", flush=True)

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

    # Apply hallucination-loop cuts (detected earlier from the raw
    # transcription) to the speech segments. Silence detection can't
    # find these — the audio has real energy, just no meaningful speech.
    if _hallucination_cuts_to_apply:
        from src.filler_detection import FillerDetector
        _det = FillerDetector()
        _sb = len(segments)
        _tb = sum(e - s for s, e in segments)
        segments = _det.filter_segments(segments, _hallucination_cuts_to_apply)
        _intentional_cuts.extend(_hallucination_cuts_to_apply)
        _ta = sum(e - s for s, e in segments)
        print(f"[hallucination] segments {_sb}→{len(segments)}, "
              f"time {_tb:.1f}s→{_ta:.1f}s "
              f"(removed {_tb - _ta:.1f}s of Whisper loop)",
              flush=True)

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
            _intentional_cuts.extend(filler_segments)
            _log_cuts(cut_kinds, "filler", filler_segments)
            total_after = sum(e - s for s, e in segments)
            print(f"[filler] segments {segments_before}→{len(segments)}, "
                  f"time {total_before:.1f}s→{total_after:.1f}s "
                  f"(removed {total_before - total_after:.1f}s of filler)",
                  flush=True)

    # Hesitation-marker cleanup — Whisper's convention for audible
    # but unrecognized speech (typically 'äääh', throat clears, or
    # mumbled syllables) is to output a punctuation-only "word" like
    # '...' or '…'. Silence detection sees energy → keeps them in a
    # speech segment. Filler detector strips them to empty → skips.
    # Cut them here.
    if remove_fillers and analyzer._transcription:
        import re as _re
        _punct_only = _re.compile(r"^[^\w]+$")
        _hes_cuts: list[tuple[float, float]] = []
        for _seg in (analyzer._transcription.get("segments") or []):
            for _w in (_seg.get("words") or []):
                _t = (_w.get("word", "") or "").strip()
                if _t and _punct_only.match(_t):
                    _s = float(_w.get("start") or 0)
                    _e = float(_w.get("end") or 0)
                    if _e - _s > 0.15:  # ignore instant punctuation blips
                        _hes_cuts.append((_s, _e))
        if _hes_cuts:
            from src.filler_detection import FillerDetector
            _det = FillerDetector()
            _sb = len(segments)
            _tb = sum(e - s for s, e in segments)
            segments = _det.filter_segments(segments, _hes_cuts)
            _intentional_cuts.extend(_hes_cuts)
            _log_cuts(cut_kinds, "filler", _hes_cuts)
            _ta = sum(e - s for s, e in segments)
            print(f"[hesitation] {len(_hes_cuts)} punctuation-only "
                  f"marker(s) cut: {_hes_cuts}", flush=True)
            print(f"[hesitation] segments {_sb}→{len(segments)}, "
                  f"time {_tb:.1f}s→{_ta:.1f}s (removed {_tb - _ta:.1f}s)",
                  flush=True)

    # Word-gap cleanup: catch drawn-out fillers Whisper cleaned out of
    # its transcription entirely (a common Whisper 'polish' behavior
    # for 'ääääh' / 'öhm' / long throat clears). Looks for gaps > 400ms
    # between consecutive Whisper words within a speech-detected region.
    if remove_fillers and analyzer._transcription:
        from src.word_gap_detection import find_word_gap_cuts
        _speech_only = [(s.start, s.end) for s in speech_segments
                        if s.has_speech]
        _gap_cuts_raw = find_word_gap_cuts(
            analyzer._transcription, speech_ranges=_speech_only,
        )
        if _gap_cuts_raw:
            from src.filler_detection import FillerDetector
            _det = FillerDetector()
            _gap_ranges = [(s, e) for (s, e, _g) in _gap_cuts_raw]
            _sb = len(segments)
            _tb = sum(e - s for s, e in segments)
            segments = _det.filter_segments(segments, _gap_ranges)
            _intentional_cuts.extend(_gap_ranges)
            _log_cuts(cut_kinds, "filler", _gap_ranges)
            _ta = sum(e - s for s, e in segments)
            for (s, e, g) in _gap_cuts_raw:
                print(f"[word-gap] cut {s:.2f}-{e:.2f}s "
                      f"(gap={g:.2f}s — likely untranscribed filler)",
                      flush=True)
            print(f"[word-gap] segments {_sb}→{len(segments)}, "
                  f"time {_tb:.1f}s→{_ta:.1f}s (removed {_tb - _ta:.1f}s)",
                  flush=True)

    # Audio-based filler detection — catches drawn-out 'ähhh' that
    # Whisper cleans out entirely (no transcript token, no gap in
    # timeline because Whisper stretches the surrounding words to
    # cover the audio the filler occupied).
    # Guards:
    #   1. min duration 200ms, max 900ms
    #   2. Whisper-word overlap: uses EFFECTIVE (silence-aware) bounds
    #      so we don't reject candidates that fall inside a drifted
    #      Whisper word range but are actually in real silence-audio.
    #      Overlap must be >30% of candidate duration to disqualify.
    #   3. Energy + spectral flatness thresholds internal to
    #      detect_fillers_audio pick low-energy monotone regions.
    if remove_fillers:
        try:
            from src.filler_detection import detect_fillers_audio
            _sr, _adata = analyzer.get_audio_data()
            _current_speech = [(s, e) for (s, e) in segments]
            _audio_fillers = detect_fillers_audio(
                _sr, _adata, _current_speech,
                min_duration=0.20, max_duration=0.90,
            )
            # Build EFFECTIVE whisper-word bounds (silence-trimmed)
            _silence_regions = [(s.start, s.end)
                                for s in speech_segments
                                if not s.has_speech]
            _tx_words: list[tuple[float, float]] = []
            for _seg in (analyzer._transcription or {}).get("segments", []):
                for _w in _seg.get("words") or []:
                    if _w.get("start") is None or _w.get("end") is None:
                        continue
                    ws, we = float(_w["start"]), float(_w["end"])
                    # Trim by silence
                    for (sil_s, sil_e) in _silence_regions:
                        if ws < sil_s < we:
                            we = min(we, sil_s)
                        if ws < sil_e < we:
                            ws = max(ws, sil_e)
                    if we - ws > 0.03:
                        _tx_words.append((ws, we))

            def _covered_by_word(s: float, e: float) -> bool:
                # Candidate is disqualified only if MORE than 30% is
                # covered by an effective Whisper word range.
                dur = max(0.001, e - s)
                for ws, we in _tx_words:
                    ov = max(0.0, min(e, we) - max(s, ws))
                    if ov / dur > 0.30:
                        return True
                return False

            _safe = [(s, e) for (s, e) in _audio_fillers
                     if not _covered_by_word(s, e)]
            _dropped = len(_audio_fillers) - len(_safe)
            if _dropped:
                print(f"[audio-filler] skipped {_dropped} candidate(s) "
                      f"— covered by Whisper words", flush=True)
            if _safe:
                from src.filler_detection import FillerDetector
                _det = FillerDetector()
                _sb = len(segments)
                _tb = sum(e - s for s, e in segments)
                segments = _det.filter_segments(segments, _safe)
                _log_cuts(cut_kinds, "filler", _safe)
                # Not added to _intentional_cuts: these are acoustic
                # guesses that may clip a word edge, and smart cut's
                # word-integrity expansion should be allowed to win.
                _ta = sum(e - s for s, e in segments)
                for (s, e) in _safe:
                    print(f"[audio-filler] cut {s:.2f}-{e:.2f}s "
                          f"(no Whisper word, low-energy monotone)",
                          flush=True)
                print(f"[audio-filler] segments {_sb}→{len(segments)}, "
                      f"time {_tb:.1f}s→{_ta:.1f}s (removed {_tb - _ta:.1f}s)",
                      flush=True)
        except Exception as _e:
            print(f"[audio-filler] skipped: {_e}", flush=True)

    # Sustained-vowel detection — the 'äääh' Whisper neither transcribed
    # nor left a gap for: it stretched a neighbouring word over it, so
    # every text/gap detector above is blind to it and the audio-filler
    # pass rejects it as 'covered by a Whisper word'. Looks inside
    # over-long words for a held vowel with level pitch and a steady
    # spectrum. CLEO_SUSTAINED_VOWEL_CUTS: 1 (default) cut, log = only
    # log what would be cut, 0 = off.
    _svd_mode = os.environ.get("CLEO_SUSTAINED_VOWEL_CUTS", "1").strip().lower()
    if remove_fillers and analyzer._transcription and _svd_mode not in ("0", "off", "false", "no"):
        try:
            from src.sustained_vowel_detection import detect_sustained_vowels
            _sr, _adata = analyzer.get_audio_data()
            _svd_silence = [(s.start, s.end) for s in speech_segments if not s.has_speech]
            _svd_cuts = detect_sustained_vowels(
                _sr, _adata, analyzer._transcription, silence_ranges=_svd_silence,
            )
            for (s, e) in _svd_cuts:
                print(f"[sustained-vowel] {'cut' if _svd_mode != 'log' else 'would cut'} "
                      f"{s:.2f}-{e:.2f}s (held vowel inside a stretched word)",
                      flush=True)
            if _svd_cuts and _svd_mode != "log":
                from src.filler_detection import FillerDetector
                _tb = sum(e - s for s, e in segments)
                segments = FillerDetector().filter_segments(segments, _svd_cuts)
                _intentional_cuts.extend(_svd_cuts)
                _log_cuts(cut_kinds, "filler", _svd_cuts)
                _ta = sum(e - s for s, e in segments)
                print(f"[sustained-vowel] removed {_tb - _ta:.2f}s", flush=True)
        except Exception as _e:
            print(f"[sustained-vowel] skipped: {_e}", flush=True)

    # Stutter cleanup — repeated N-gram sequences ("es ist ein, es ist
    # ein sehr schönes Thema") that filler removal doesn't catch
    # because the repeated words aren't classical fillers. Runs on the
    # Whisper transcription (unchanged by upstream cuts), returns cut
    # ranges that we apply to the current speech segments.
    if remove_fillers and analyzer._transcription:
        from src.stutter_detection import find_stutter_cuts
        stutter_ranges = find_stutter_cuts(analyzer._transcription)
        if stutter_ranges:
            from src.filler_detection import FillerDetector
            detector = FillerDetector()
            segments_before = len(segments)
            total_before = sum(e - s for s, e in segments)
            segments = detector.filter_segments(segments, stutter_ranges)
            _intentional_cuts.extend(stutter_ranges)
            _log_cuts(cut_kinds, "filler", stutter_ranges)
            total_after = sum(e - s for s, e in segments)
            print(f"[stutter] {len(stutter_ranges)} n-gram repeat(s) "
                  f"cut: {stutter_ranges}", flush=True)
            print(f"[stutter] segments {segments_before}→{len(segments)}, "
                  f"time {total_before:.1f}s→{total_after:.1f}s "
                  f"(removed {total_before - total_after:.1f}s)",
                  flush=True)

    # Mumble cleanup — phrases where Whisper's word-level confidence is
    # so low it's essentially guessing at the audio. Deterministic
    # threshold, no LLM. Won't catch confident mis-transcriptions of
    # gibberish (no signal for that in text), but reliably drops
    # blurry / unintelligible passages.
    if remove_fillers and analyzer._transcription:
        from src.mumble_detection import find_mumble_cuts
        mumble_data = find_mumble_cuts(analyzer._transcription)
        if mumble_data:
            from src.filler_detection import FillerDetector
            detector = FillerDetector()
            mumble_ranges = [(s, e) for (s, e, _c, _t) in mumble_data]
            segments_before = len(segments)
            total_before = sum(e - s for s, e in segments)
            segments = detector.filter_segments(segments, mumble_ranges)
            _intentional_cuts.extend(mumble_ranges)
            _log_cuts(cut_kinds, "filler", mumble_ranges)
            total_after = sum(e - s for s, e in segments)
            for (s, e, c, t) in mumble_data:
                print(f"[mumble] cut {s:.2f}-{e:.2f}s "
                      f"(avg conf {c:.2f}): {t!r}", flush=True)
            print(f"[mumble] segments {segments_before}→{len(segments)}, "
                  f"time {total_before:.1f}s→{total_after:.1f}s "
                  f"(removed {total_before - total_after:.1f}s)",
                  flush=True)

    # Get video duration
    from moviepy.editor import VideoFileClip
    clip = VideoFileClip(video_path)
    duration = clip.duration
    clip.close()

    # Smart cut optimization — snap silence-based cuts to natural break
    # points. MUST run BEFORE voice-triggers because it re-snaps every
    # segment boundary to the nearest word/sentence within ±0.5s. Running
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
        # Pass audio silence ranges so word-expansion can distinguish
        # real audio content from Whisper's word.end drift into silence.
        _silence_ranges_for_snap = [
            (round(s.start, 3), round(s.end, 3))
            for s in speech_segments if not s.has_speech
        ]
        segments = cutter.optimize_cuts(
            segments, silence_ranges=_silence_ranges_for_snap,
        )
        if _intentional_cuts:
            from src.filler_detection import FillerDetector
            _tb = sum(e - s for s, e in segments)
            segments = FillerDetector().filter_segments(segments, _intentional_cuts)
            _ta = sum(e - s for s, e in segments)
            if _tb - _ta > 0.005:
                print(f"[smart-cut] re-applied {len(_intentional_cuts)} "
                      f"detector cut(s) — {_tb - _ta:.2f}s smart cut had "
                      f"snapped back in", flush=True)

    # Scene triggers — Cleo start / restart / keep / finish workflow
    # for record-once-and-refine. Opt-in: only activates if the user
    # actually said "Cleo start". Runs before voice_triggers so scene
    # boundaries are cut before per-take Cleo cut/go handling.
    scene_events_out: list[dict] = []
    if voice_triggers and analyzer._transcription:
        try:
            from src.scene_triggers import find_scene_cut_ranges
            from src.voice_triggers import collect_whisper_words as _scw
            ww_scene = _scw(analyzer._transcription)
            scene_cuts, scene_events = find_scene_cut_ranges(
                ww_scene, clip_duration=duration,
            )
            # Extract raw text around each event for the review UI so
            # the user can see WHAT Whisper heard when the event was
            # detected. Look up ±0.5s window of words.
            for (t, s, e) in scene_events:
                raw_words = [
                    (w.get("word", "") or "").strip()
                    for w in ww_scene
                    if float(w.get("start", 0)) >= s - 0.5
                    and float(w.get("end", 0)) <= e + 0.5
                ]
                scene_events_out.append({
                    "type": t,
                    "start": round(s, 3),
                    "end": round(e, 3),
                    "raw_text": " ".join(raw_words)[:80],
                })
            if scene_events:
                print(f"[scene-triggers] events: "
                      f"{[(t, round(s,2), round(e,2)) for t,s,e in scene_events]}",
                      flush=True)
            if scene_cuts:
                from src.filler_detection import FillerDetector
                _det = FillerDetector()
                segments_before = len(segments)
                total_before = sum(e - s for s, e in segments)
                segments = _det.filter_segments(segments, scene_cuts)
                _log_cuts(cut_kinds, "voice_cmd", scene_cuts)
                total_after = sum(e - s for s, e in segments)
                print(f"[scene-triggers] {len(scene_cuts)} cut range(s) "
                      f"applied: {scene_cuts}", flush=True)
                print(f"[scene-triggers] segments {segments_before}→"
                      f"{len(segments)}, time {total_before:.1f}s→"
                      f"{total_after:.1f}s "
                      f"(removed {total_before - total_after:.1f}s)",
                      flush=True)
        except Exception as e:
            print(f"[scene-triggers] error: {e}", flush=True)

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
            # Pass raw silence ranges so trigger boundaries snap to
            # actual audio silence instead of Whisper's stretched word
            # timestamps (kills perceptible pauses in the kept audio).
            silence_ranges = [
                (round(s.start, 3), round(s.end, 3))
                for s in (analyzer._speech_segments or [])
                if not s.has_speech
            ]
            print(f"[voice-triggers] {len(silence_ranges)} silence "
                  f"range(s) available for snapping", flush=True)
            detected_trigger_pairs = detect_voice_triggers(
                ww,
                cut_keywords=cut_keywords,
                continue_keywords=continue_keywords,
                clip_duration=duration,
                silence_ranges=silence_ranges,
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
                _log_cuts(cut_kinds, "voice_cmd",
                          [(p.cut_start, p.continue_end)
                           for p in detected_trigger_pairs])
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

    # Final consolidation — after ALL cut passes (silence, filler,
    # stutter, smart_cut, voice_triggers), any segment shorter than
    # MIN_FINAL_SEGMENT is a fragment: an orphan word/syllable left
    # between two aggressive cuts. Keeping them makes the flow feel
    # choppy (user report). Drop them.
    # A fragment that holds a complete real word is kept, though: with
    # fillers now transcribed and cut, 'und äh dann ähm haben' leaves
    # 'dann' on its own, and dropping it changes what was said.
    MIN_FINAL_SEGMENT = 0.4
    if segments:
        before_n = len(segments)
        before_t = sum(e - s for s, e in segments)
        from src.filler_detection import _is_vocalisation as _isvoc
        _real_words: list[tuple[float, float]] = []
        for _seg in (analyzer._transcription or {}).get("segments", []):
            for _w in _seg.get("words") or []:
                _t = (_w.get("word") or "").strip().lower().strip(".,!?;:\"'()[]…–—-")
                if not _t or _isvoc(_t):
                    continue
                try:
                    _ws, _we = float(_w["start"]), float(_w["end"])
                except (KeyError, TypeError, ValueError):
                    continue
                if _we - _ws >= 0.08:
                    _real_words.append((_ws, _we))

        def _holds_word(s: float, e: float) -> bool:
            for ws, we in _real_words:
                if we <= s or ws >= e:
                    continue
                if min(e, we) - max(s, ws) >= 0.8 * (we - ws):
                    return True
            return False

        segments = [(s, e) for (s, e) in segments
                    if (e - s) >= MIN_FINAL_SEGMENT or _holds_word(s, e)]
        dropped = before_n - len(segments)
        if dropped:
            after_t = sum(e - s for s, e in segments)
            print(f"[consolidate] dropped {dropped} fragment(s) "
                  f"<{MIN_FINAL_SEGMENT}s (removed {before_t - after_t:.2f}s)",
                  flush=True)

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
        scene_events=scene_events_out,
        words=(_transcript_words(analyzer._transcription, speech_segments)
               if include_words else None),
    )


def _transcript_words(transcription, speech_segments) -> list[dict]:
    """Every word of the (cleaned-up) transcription with its own timing —
    before src/audio.py glues words of <= 3 characters into caption units
    — fillers included. Only analyze_video(include_words=True) (the web
    doc) calls this. A word entirely outside the speech regions (its
    subtitle above is dropped: maybe a Whisper hallucination in silence)
    is kept with nospeech: True — the web editor shows it only once the
    user brings its footage back (UX10); the doc hides known silence
    hallucinations."""
    speech = [(s.start, s.end) for s in (speech_segments or [])
              if s.has_speech]
    out: list[dict] = []
    for seg in (transcription or {}).get("segments") or []:
        for w in seg.get("words") or []:
            try:
                start, end = float(w["start"]), float(w["end"])
            except (KeyError, TypeError, ValueError):
                continue
            word = {"text": (w.get("word") or "").strip(),
                    "start": start, "end": end,
                    "probability": w.get("probability")}
            if speech and not any(start < se and end > ss for ss, se in speech):
                word["nospeech"] = True
            out.append(word)
    return out


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
