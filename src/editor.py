"""
Video Editor v5.0 - Alle Effekte integriert

Features:
- Alle visuellen Effekte (RGB Split, VHS, Film Grain, Light Leaks, etc.)
- Moderne Übergänge (Blur, Swipe, Glitch, Zoom, Pixelate, Rotate)
- Smart Zoom mit Gesichtserkennung
- Beat-Sync für Musik-Videos
- Karaoke-Style Untertitel
- Emoji-Overlays mit Sentiment
- Auto-Reframe für verschiedene Formate
"""

import os
import cv2
import subprocess
import json
import numpy as np
import tempfile
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from dataclasses import dataclass

from moviepy.editor import (
    VideoFileClip, concatenate_videoclips, CompositeVideoClip,
    TextClip, CompositeAudioClip
)

from .styles import get_style, list_styles
from .audio import AudioAnalyzer, Subtitle
from .sounds import SoundEffects
from .intelligence import FaceDetector, SentimentAnalyzer, ActionDetector, ObjectDetector
from .image_gen import ImageGenerator, DIFFUSERS_AVAILABLE
from .effects import (
    # Farbe
    apply_vignette, apply_color_grade,
    # Übergänge
    apply_fade_in, apply_fade_out,
    apply_swipe_in, apply_swipe_out,
    apply_glitch_transition, apply_blur_transition,
    apply_zoom_transition, apply_scale_pop,
    apply_pixelate_transition, apply_rotate_transition,
    # Zoom
    apply_smart_zoom, apply_zoom_in, apply_zoom_out, apply_pan_zoom,
    apply_zoom_pulse, apply_beat_zoom,
    # Visuelle Effekte
    apply_cinematic_bars, apply_rgb_split, apply_rgb_split_animated,
    apply_vhs_effect, apply_film_grain, apply_light_leak,
    apply_shake, apply_echo, apply_mirror, apply_split_mirror,
    # Text (PIL-basiert, kein ImageMagick nötig)
    create_karaoke_subtitle, create_modern_subtitle,
    create_typewriter_text, create_bounce_text, create_glitch_text, create_neon_text,
    create_pil_text_clip, create_clean_phrase_subtitle,
    # Highlights (Wort-basierte Effekte)
    is_highlight_word, create_highlighted_text_clip, HIGHLIGHT_KEYWORDS,
    # Emoji
    add_emoji_overlays,
    # Reframe
    apply_auto_reframe,
    # NEU: Intro/Outro Animationen
    apply_slide_in, apply_slide_out,
    apply_scale_in, apply_scale_out,
    apply_flip_in, apply_bounce_in, apply_spin_in,
    apply_elastic_in, apply_blur_slide_in,
    # NEU: Segment-Effekte
    apply_desaturate_segment, apply_slow_motion_segment, apply_speed_up_segment,
    apply_reverse_segment, apply_flash, apply_impact_zoom,
    apply_shake_segment, apply_zoom_segment, apply_blur_segment,
    apply_freeze_frame,
    # NEU: Erweiterte visuelle Effekte
    apply_scanlines, apply_chromatic_aberration, apply_glitch_blocks,
    apply_crt_effect, apply_color_grade_preset,
    # NEU: Layout-Effekte
    apply_split_screen, apply_ken_burns, apply_picture_in_picture,
    # NEU: Audio-reaktive Effekte
    apply_beat_flash, apply_beat_shake, apply_bass_drop_effect,
    apply_volume_reactive_zoom,
    # NEU: Gesichts-Effekte
    apply_face_zoom, apply_face_blur, apply_spotlight_face,
    # NEU: Animierte Titel
    create_animated_title,
    # NEU: Generierte Bilder
    add_generated_image_overlays,
)
from .audio import AudioAnalyzer, Subtitle, AdvancedAudioAnalyzer
from .ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path
from .platform_utils import get_video_codec, get_codec_params


def _process_segment_worker(args):
    """
    Worker-Funktion für parallele Segment-Verarbeitung.
    Wird in separatem Prozess ausgeführt.
    """
    (segment_idx, start, end, input_path, temp_dir, config,
     total_segments, subtitles_data, video_size, fps) = args

    try:
        from moviepy.editor import VideoFileClip, CompositeVideoClip
        from .effects import (
            apply_vignette, apply_color_grade, apply_fade_in, apply_fade_out,
            apply_zoom_in, apply_zoom_out, apply_pan_zoom,
            apply_cinematic_bars, apply_rgb_split, apply_rgb_split_animated,
            apply_vhs_effect, apply_film_grain, apply_light_leak,
            apply_shake, apply_echo, apply_split_mirror,
            create_modern_subtitle, create_clean_phrase_subtitle,
            create_karaoke_subtitle, create_typewriter_text, create_bounce_text,
            create_glitch_text, create_neon_text, is_highlight_word,
            create_highlighted_text_clip
        )
        from .audio import Subtitle

        # Video laden
        clip = VideoFileClip(str(input_path))
        segment = clip.subclip(start, min(end, clip.duration - 0.01))

        # Zoom-Effekte (vereinfacht, ohne Gesichtserkennung im Worker)
        if config.get("enable_zoom", True):
            zoom = config.get("zoom_intensity", 1.12)
            directions = ["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top"]
            effects = [apply_zoom_in, apply_zoom_out, apply_pan_zoom]
            effect = effects[segment_idx % 3]
            if effect == apply_pan_zoom:
                segment = effect(segment, directions[segment_idx % 4], zoom)
            else:
                segment = effect(segment, zoom)

        # Visuelle Effekte
        color_grade = config.get("color_grade", "balanced")
        if color_grade and color_grade != "none":
            segment = apply_color_grade(segment, color_grade)

        if config.get("vignette_intensity", 0) > 0:
            segment = apply_vignette(segment, config["vignette_intensity"])

        if config.get("cinematic_bars", False):
            segment = apply_cinematic_bars(segment, config.get("cinematic_bars_height", 0.1))

        if config.get("rgb_split", False):
            intensity = config.get("rgb_split_intensity", 10)
            if config.get("rgb_split_animated", False):
                segment = apply_rgb_split_animated(segment, intensity)
            else:
                segment = apply_rgb_split(segment, intensity)

        if config.get("vhs_effect", False):
            segment = apply_vhs_effect(segment, config.get("vhs_intensity", 0.5))

        if config.get("film_grain", False):
            segment = apply_film_grain(segment, config.get("film_grain_intensity", 0.3))

        if config.get("light_leak", False):
            segment = apply_light_leak(segment, intensity=config.get("light_leak_intensity", 0.3))

        if config.get("shake", False):
            segment = apply_shake(segment, intensity=config.get("shake_intensity", 5))

        if config.get("echo", False):
            segment = apply_echo(segment, num_echoes=config.get("echo_count", 3))

        if config.get("mirror", False):
            segment = apply_split_mirror(segment)

        # Übergänge
        trans_dur = config.get("transition_duration", 0.3)
        if segment_idx == 0:
            segment = apply_fade_in(segment, trans_dur)
        if segment_idx == total_segments - 1:
            segment = apply_fade_out(segment, trans_dur)

        # Untertitel für dieses Segment
        if subtitles_data and config.get("enable_subtitles"):
            style = config.get("subtitle_style", "modern")
            subtitle_config = {
                "subtitle_color": config.get("subtitle_color", (255, 255, 255)),
                "subtitle_fontsize": config.get("subtitle_fontsize"),
                "subtitle_fontsize_multiplier": config.get("subtitle_fontsize_multiplier", 1.0),
                "subtitle_effect": config.get("subtitle_effect"),
                "subtitle_stroke_width": config.get("subtitle_stroke_width", 4),
            }

            all_clips = []
            segment_subs = [Subtitle(s['start'], s['end'], s['text']) for s in subtitles_data]

            if style == "clean":
                words_per_phrase = config.get("clean_words_per_phrase", 4)
                valid_subs = [s for s in segment_subs if (s.end - s.start) >= 0.15 and s.text.strip()]

                phrases = []
                for i in range(0, len(valid_subs), words_per_phrase):
                    phrases.append(valid_subs[i:i + words_per_phrase])

                for phrase_subs in phrases:
                    words = [s.text.strip() for s in phrase_subs]
                    for word_idx, sub in enumerate(phrase_subs):
                        dur = max(sub.end - sub.start, 0.1)
                        try:
                            phrase_clip = create_clean_phrase_subtitle(
                                words=words, active_index=word_idx, duration=dur,
                                video_size=segment.size, subtitle_config=subtitle_config
                            )
                            if phrase_clip:
                                phrase_clip = phrase_clip.set_start(sub.start)
                                all_clips.append(phrase_clip)
                        except:
                            pass
            else:
                for sub in segment_subs:
                    dur = sub.end - sub.start
                    if dur < 0.2 or not sub.text.strip():
                        continue
                    try:
                        sub_clips = create_modern_subtitle(sub.text, dur, segment.size, style, subtitle_config)
                        for sc in sub_clips:
                            if sc:
                                sc = sc.set_start(sub.start)
                                all_clips.append(sc)
                    except:
                        pass

            if all_clips:
                segment = CompositeVideoClip([segment] + all_clips)

        # Export als temp-Datei (Software-Encoding für Worker-Kompatibilität)
        temp_path = os.path.join(temp_dir, f"segment_{segment_idx:04d}.mp4")
        segment.write_videofile(
            temp_path,
            codec="libx264",  # Software-Encoding (funktioniert in Subprocess)
            audio_codec="aac",
            bitrate="12M",
            verbose=False,
            logger=None,
            ffmpeg_params=["-preset", "fast", "-profile:v", "high"]
        )

        segment.close()
        clip.close()

        return (segment_idx, temp_path, None)

    except Exception as e:
        return (segment_idx, None, str(e))


class VideoEditor:
    """Video Editor v5.0 - Alle Effekte"""

    def __init__(self, input_path: str, output_dir: str = "output",
                 whisper_model: str = "medium",
                 progress_callback=None, cancel_check=None):
        self.input_path = Path(input_path)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.whisper_model = whisper_model
        self.progress_callback = progress_callback
        self.cancel_check = cancel_check

        if not self.input_path.exists():
            raise FileNotFoundError(f"Video nicht gefunden: {input_path}")

        self._report(f"Loading video: {self.input_path}")

        # Video-Info holen (Rotation und Dimensionen)
        rotation = self._get_video_rotation(str(self.input_path))
        orig_width, orig_height = self._get_video_dimensions(str(self.input_path))

        # Nach Rotation die tatsächlichen Display-Dimensionen berechnen
        if abs(rotation) in [90, 270, -90, -270]:
            display_width, display_height = orig_height, orig_width
        else:
            display_width, display_height = orig_width, orig_height

        self._report(f"  Original: {display_width}x{display_height}, Rotation: {rotation}°")

        # Prüfe ob Skalierung auf 1080p nötig ist (längere Seite > 1920)
        max_dimension = 1920
        needs_scale = max(display_width, display_height) > max_dimension
        needs_normalize = rotation != 0 or needs_scale

        if needs_normalize:
            import tempfile
            normalized_path = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False).name

            # Ziel-Dimensionen berechnen (proportional, durch 2 teilbar)
            if needs_scale:
                scale_factor = max_dimension / max(display_width, display_height)
                target_width = int(display_width * scale_factor)
                target_height = int(display_height * scale_factor)
                # Auf gerade Zahlen runden (wichtig für Encoder)
                target_width = target_width - (target_width % 2)
                target_height = target_height - (target_height % 2)
                self._report(f"  Scaling: {display_width}x{display_height} -> {target_width}x{target_height}")
            else:
                target_width = display_width - (display_width % 2)
                target_height = display_height - (display_height % 2)

            if rotation != 0:
                self._report(f"  Normalizing rotation ({rotation}°)...")

            # FFmpeg-Befehl mit expliziten Dimensionen
            cmd = [
                get_ffmpeg_path(), '-y', '-i', str(self.input_path),
                '-vf', f'scale={target_width}:{target_height}',
                '-c:v', get_video_codec(),
                '-b:v', '12M',
                ] + get_codec_params() + [
                '-c:a', 'aac', '-b:a', '192k',
                normalized_path
            ]

            subprocess.run(cmd, capture_output=True)
            self.original_clip = VideoFileClip(normalized_path)
            self._temp_normalized = normalized_path
        else:
            self.original_clip = VideoFileClip(str(self.input_path))

        self.duration = self.original_clip.duration
        self.size = self.original_clip.size
        self.fps = self.original_clip.fps
        self._report(f"  Working video: {self.size[0]}x{self.size[1]}, {self.fps:.0f}fps, {self.duration:.1f}s")

        # Lazy-loaded
        self._audio_analyzer = None
        self._sound_effects = None
        self._sentiment_analyzer = None
        self._subtitles = None
        self._face_cache = {}
        self._beat_times = None
        self._highlight_sounds = []  # Sounds für hervorgehobene Wörter

    def _report(self, message, step=None, total_steps=None, progress=None):
        """Gibt Status aus und ruft optional den Callback auf."""
        print(message)
        if self.progress_callback:
            self.progress_callback(message, step, total_steps, progress)

    def _check_cancel(self):
        """Prueft ob abgebrochen werden soll."""
        if self.cancel_check and self.cancel_check():
            raise InterruptedError("Verarbeitung abgebrochen")

    def _get_video_rotation(self, video_path: str) -> int:
        """Liest die Rotation aus Video-Metadaten (für iPhone Videos etc.)."""
        # Methode 1: stream_side_data
        try:
            cmd = [
                get_ffprobe_path(), '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream_side_data=rotation',
                '-of', 'csv=p=0',
                video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.stdout.strip():
                rotation = int(float(result.stdout.strip()))
                if rotation != 0:
                    return rotation
        except Exception:
            pass

        # Methode 2: stream_tags:rotate
        try:
            cmd = [
                get_ffprobe_path(), '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream_tags=rotate',
                '-of', 'csv=p=0',
                video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.stdout.strip():
                rotation = int(float(result.stdout.strip()))
                if rotation != 0:
                    return rotation
        except Exception:
            pass

        # Methode 3: Volle Stream-Info mit grep
        try:
            cmd = [get_ffprobe_path(), '-v', 'error', '-show_streams', '-select_streams', 'v:0', video_path]
            result = subprocess.run(cmd, capture_output=True, text=True)
            for line in result.stdout.split('\n'):
                if 'rotation=' in line:
                    rotation = int(float(line.split('=')[1]))
                    if rotation != 0:
                        return rotation
        except Exception:
            pass

        return 0

    def _get_video_dimensions(self, video_path: str) -> tuple:
        """Liest die Video-Dimensionen (Breite, Höhe) aus den Metadaten."""
        try:
            cmd = [
                get_ffprobe_path(), '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height',
                '-of', 'csv=p=0',
                video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.stdout.strip():
                parts = result.stdout.strip().split(',')
                if len(parts) >= 2:
                    return int(parts[0]), int(parts[1])
        except Exception:
            pass
        return 1920, 1080  # Fallback

    @property
    def audio_analyzer(self):
        if self._audio_analyzer is None:
            self._audio_analyzer = AudioAnalyzer(str(self.input_path), self.whisper_model, self.progress_callback)
        return self._audio_analyzer

    @property
    def sound_effects(self):
        if self._sound_effects is None:
            self._sound_effects = SoundEffects()
        return self._sound_effects

    @property
    def sentiment_analyzer(self):
        if self._sentiment_analyzer is None:
            self._sentiment_analyzer = SentimentAnalyzer()
        return self._sentiment_analyzer

    # =========================================================================
    # ANALYSE
    # =========================================================================

    def _get_subtitles(self):
        self._check_cancel()
        if self._subtitles is None:
            self._report("\n[1/6] Transcribing audio...", step=1, total_steps=6)
            self._subtitles = self.audio_analyzer.transcribe()
            if self._subtitles:
                self._report(f"  {len(self._subtitles)} subtitle segments detected")
                for i, sub in enumerate(self._subtitles[:3]):
                    self._report(f"    {i+1}. [{sub.start:.1f}s - {sub.end:.1f}s]: {sub.text[:50]}...")
                if len(self._subtitles) > 3:
                    self._report(f"    ... and {len(self._subtitles) - 3} more")
            else:
                self._report("  WARNING: No speech detected in video!")
        return self._subtitles

    def _get_speech_segments(self, config):
        self._check_cancel()
        if not config.get("remove_silence", False):
            return [(0, self.duration)]

        self._report("\n[2/6] Analyzing silence...", step=2, total_steps=6)
        segments = self.audio_analyzer.detect_silence(
            silence_threshold=config.get("silence_threshold", 0.025),  # Etwas toleranter
            min_silence_duration=config.get("min_silence_to_cut", 0.6)  # Längere Stille nötig
        )

        # Mehr Padding für natürlichere Schnitte
        padding_before = config.get("keep_padding", 0.35)  # Vor Sprache
        padding_after = config.get("keep_padding_after", 0.25)  # Nach Sprache (kürzer)
        min_segment_length = config.get("min_segment_length", 0.8)  # Mindestlänge
        merge_gap = config.get("merge_gap", 0.4)  # Segmente zusammenführen wenn Lücke kleiner

        speech = []
        for seg in segments:
            if seg.has_speech:
                start = max(0, seg.start - padding_before)
                end = min(self.duration, seg.end + padding_after)
                speech.append((start, end))

        if not speech:
            return [(0, self.duration)]

        # Intelligentes Merging: Kurze Lücken überbrücken
        merged = [speech[0]]
        for start, end in speech[1:]:
            gap = start - merged[-1][1]
            # Merge wenn Lücke klein oder resultierendes Segment zu kurz wäre
            if gap <= merge_gap or (start - merged[-1][0]) < min_segment_length:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))

        # Entferne zu kurze Segmente (merge mit Nachbar)
        final = []
        for i, (start, end) in enumerate(merged):
            duration = end - start
            if duration < min_segment_length and final:
                # Merge mit vorherigem Segment
                final[-1] = (final[-1][0], end)
            else:
                final.append((start, end))

        # Sicherstellen dass letztes Segment nicht zu kurz ist
        if len(final) > 1 and (final[-1][1] - final[-1][0]) < min_segment_length:
            last = final.pop()
            final[-1] = (final[-1][0], last[1])

        removed = self.duration - sum(e - s for s, e in final)
        self._report(f"  {len(final)} segments, {removed:.1f}s removed")
        return final

    def _get_beat_times(self, config):
        self._check_cancel()
        if not config.get("beat_sync", False) and not config.get("beat_zoom", False):
            return []

        if self._beat_times is None:
            self._report("\n[3/6] Analyzing beats...", step=3, total_steps=6)
            self._beat_times = self.audio_analyzer.get_beat_times(min_strength=0.3)
            self._report(f"  {len(self._beat_times)} beats detected")

        return self._beat_times

    def _analyze_faces(self, start, end):
        key = f"{start:.1f}-{end:.1f}"
        if key in self._face_cache:
            return self._face_cache[key]

        positions = []
        detector = FaceDetector()

        try:
            cap = cv2.VideoCapture(str(self.input_path))
            fps = cap.get(cv2.CAP_PROP_FPS)
            t = start

            while t < end:
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
                ret, frame = cap.read()
                if not ret:
                    break

                face = detector.get_primary_face(frame)
                if face:
                    positions.append((int((t - start) * fps), face.center[0], face.center[1]))
                t += 0.5

            cap.release()
        except Exception as e:
            self._report(f"    Face detection: {e}")
        finally:
            detector.close()

        self._face_cache[key] = positions
        return positions

    def _get_segment_subtitles(self, start, end, offset):
        subs = []
        for sub in self._get_subtitles():
            if sub.end < start or sub.start > end:
                continue
            s = max(sub.start, start)
            e = min(sub.end, end)
            if e - s >= 0.1:
                subs.append(Subtitle(start=s - start + offset, end=e - start + offset, text=sub.text))
        return subs

    def _get_emoji_events(self, subtitles):
        events = []
        for sub in subtitles:
            sentiment = self.sentiment_analyzer.analyze(sub.text)
            if sentiment.emotion != "neutral":
                ts = (sub.start + sub.end) / 2
                events.append((ts, sentiment.emoji, 1.5))
                self._report(f"    Emoji detected: {sentiment.emoji} ({sentiment.emotion}) at {ts:.1f}s")
        return events

    # =========================================================================
    # ÜBERGÄNGE
    # =========================================================================

    def _apply_transition(self, clip, transition_type, duration, direction="in"):
        """Wendet den passenden Übergang an."""
        if duration <= 0:
            return clip

        try:
            if transition_type == "blur":
                return apply_blur_transition(clip, duration, direction)
            elif transition_type == "swipe":
                if direction == "in":
                    return apply_swipe_in(clip, duration, "left")
                else:
                    return apply_swipe_out(clip, duration, "right")
            elif transition_type == "glitch":
                if direction == "in":
                    return apply_glitch_transition(clip, duration)
                else:
                    return apply_zoom_transition(clip, duration, "out")
            elif transition_type == "zoom":
                return apply_zoom_transition(clip, duration, direction)
            elif transition_type == "pixelate":
                return apply_pixelate_transition(clip, duration, direction)
            elif transition_type == "rotate":
                return apply_rotate_transition(clip, duration, direction)
            elif transition_type == "fade":
                if direction == "in":
                    return apply_fade_in(clip, duration)
                else:
                    return apply_fade_out(clip, duration)
            else:
                return clip
        except Exception:
            # Fallback zu Fade
            if direction == "in":
                return apply_fade_in(clip, duration)
            else:
                return apply_fade_out(clip, duration)

    # =========================================================================
    # VISUELLE EFFEKTE
    # =========================================================================

    def _apply_visual_effects(self, clip, config):
        """Wendet alle visuellen Effekte an."""

        # Farbkorrektur
        color_grade = config.get("color_grade", "balanced")
        if color_grade and color_grade != "none":
            clip = apply_color_grade(clip, color_grade)

        # Vignette
        if config.get("vignette_intensity", 0) > 0:
            clip = apply_vignette(clip, config["vignette_intensity"])

        # Cinematic Bars (Letterbox)
        if config.get("cinematic_bars", False):
            bar_height = config.get("cinematic_bars_height", 0.1)
            clip = apply_cinematic_bars(clip, bar_height)

        # RGB Split
        if config.get("rgb_split", False):
            intensity = config.get("rgb_split_intensity", 10)
            if config.get("rgb_split_animated", False):
                clip = apply_rgb_split_animated(clip, intensity)
            else:
                clip = apply_rgb_split(clip, intensity)

        # VHS Effekt
        if config.get("vhs_effect", False):
            intensity = config.get("vhs_intensity", 0.5)
            clip = apply_vhs_effect(clip, intensity)

        # Film Grain
        if config.get("film_grain", False):
            intensity = config.get("film_grain_intensity", 0.3)
            clip = apply_film_grain(clip, intensity)

        # Light Leak
        if config.get("light_leak", False):
            intensity = config.get("light_leak_intensity", 0.3)
            clip = apply_light_leak(clip, intensity=intensity)

        # Camera Shake
        if config.get("shake", False):
            intensity = config.get("shake_intensity", 5)
            clip = apply_shake(clip, intensity=intensity)

        # Echo/Ghost
        if config.get("echo", False):
            count = config.get("echo_count", 3)
            clip = apply_echo(clip, num_echoes=count)

        # Mirror
        if config.get("mirror", False):
            clip = apply_split_mirror(clip)

        return clip

    # =========================================================================
    # ZOOM EFFEKTE
    # =========================================================================

    def _apply_zoom_effects(self, clip, config, segment_index, faces, beat_times):
        """Wendet Zoom-Effekte an."""

        if not config.get("enable_zoom", True):
            return clip

        zoom = config.get("zoom_intensity", 1.12)

        # Beat Zoom hat Priorität
        if config.get("beat_zoom", False) and beat_times:
            intensity = config.get("beat_zoom_intensity", 0.08)
            clip = apply_beat_zoom(clip, beat_times, intensity)
            return clip

        # Zoom Pulse für Musik
        if config.get("zoom_pulse", False):
            frequency = config.get("zoom_pulse_frequency", 2.0)
            clip = apply_zoom_pulse(clip, frequency, 0.05)
            return clip

        # Smart Zoom mit Gesichtserkennung
        if faces and len(faces) > 0 and config.get("smart_zoom", True):
            clip = apply_smart_zoom(clip, faces, zoom)
        else:
            # Abwechselnde Zoom-Effekte
            directions = ["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top"]
            effects = [apply_zoom_in, apply_zoom_out, apply_pan_zoom]
            effect = effects[segment_index % 3]

            if effect == apply_pan_zoom:
                clip = effect(clip, directions[segment_index % 4], zoom)
            else:
                clip = effect(clip, zoom)

        return clip

    # =========================================================================
    # UNTERTITEL
    # =========================================================================

    def _add_subtitles(self, clip, subtitles, config):
        """Fügt Untertitel zum Video hinzu - mit Wort-genauem Timing und Highlights."""
        self._check_cancel()
        if not subtitles:
            return clip

        style = config.get("subtitle_style", "modern")
        enable_highlights = config.get("enable_highlights", True)
        custom_highlights = config.get("custom_highlights", {})  # User-definierte Wort-Trigger

        # Subtitle-Config für Farbe, Größe, Effekt etc.
        subtitle_config = {
            "subtitle_color": config.get("subtitle_color", (255, 255, 255)),
            "subtitle_fontsize": config.get("subtitle_fontsize"),
            "subtitle_fontsize_multiplier": config.get("subtitle_fontsize_multiplier", 1.0),
            "subtitle_effect": config.get("subtitle_effect"),  # "highlight", "box", "pop" oder None
            "subtitle_stroke_width": config.get("subtitle_stroke_width", 4),
        }

        # Log subtitle config
        color = subtitle_config["subtitle_color"]
        effect = subtitle_config["subtitle_effect"]
        self._report(f"    Subtitles: {len(subtitles)} segments, style: {style}")
        self._report(f"    Color: RGB{color}, Effect: {effect}, Highlights: {enable_highlights}")

        all_clips = []
        highlight_sounds = []  # Sammelt (timestamp, sound_type) für Highlight-Sounds

        # =====================================================================
        # CLEAN STYLE: Phrase-basiert mit aktivem Wort hervorgehoben
        # =====================================================================
        if style == "clean":
            # Konfiguration für Phrase-Gruppierung
            words_per_phrase = config.get("clean_words_per_phrase", 4)

            # Filtere gültige Untertitel
            valid_subs = [s for s in subtitles if (s.end - s.start) >= 0.15 and s.text.strip()]

            if not valid_subs:
                self._report("    No valid subtitles for clean style")
                return clip

            # Gruppiere in Phrasen
            phrases = []
            for i in range(0, len(valid_subs), words_per_phrase):
                phrase_subs = valid_subs[i:i + words_per_phrase]
                phrases.append(phrase_subs)

            self._report(f"    Clean style: {len(phrases)} phrases with up to {words_per_phrase} words")

            # Erstelle Clips für jede Phrase
            for phrase_idx, phrase_subs in enumerate(phrases):
                words = [s.text.strip() for s in phrase_subs]

                # Für jedes Wort in der Phrase einen Clip erstellen
                for word_idx, sub in enumerate(phrase_subs):
                    dur = sub.end - sub.start
                    if dur < 0.1:
                        dur = 0.1

                    try:
                        phrase_clip = create_clean_phrase_subtitle(
                            words=words,
                            active_index=word_idx,
                            duration=dur,
                            video_size=clip.size,
                            subtitle_config=subtitle_config
                        )

                        if phrase_clip is not None:
                            phrase_clip = phrase_clip.set_start(sub.start)
                            all_clips.append(phrase_clip)

                    except Exception as e:
                        self._report(f"    Clean style error at phrase {phrase_idx}, word {word_idx}: {e}")

        # =====================================================================
        # ANDERE STYLES: Wort-für-Wort
        # =====================================================================
        else:
            for sub in subtitles:
                dur = sub.end - sub.start
                # Mindestdauer und nicht-leerer Text
                if dur < 0.2 or not sub.text.strip():
                    continue

                try:
                    # Prüfe ob das Wort ein Highlight ist
                    highlight_config = None
                    if enable_highlights:
                        # Erst Custom-Highlights prüfen (aus Prompt), dann Standard-Keywords
                        word_lower = sub.text.lower().strip()
                        if word_lower in custom_highlights:
                            highlight_config = custom_highlights[word_lower]
                        else:
                            highlight_config = is_highlight_word(sub.text)

                    if highlight_config:
                        # Highlight-Wort mit Glow-Effekt
                        sub_clip = create_highlighted_text_clip(
                            sub.text, dur, clip.size, highlight_config
                        )
                        if sub_clip is not None:
                            sub_clip = sub_clip.set_start(sub.start)
                            all_clips.append(sub_clip)
                            # Sound für dieses Highlight merken
                            if highlight_config.get("sound"):
                                highlight_sounds.append((sub.start, highlight_config["sound"]))
                            self._report(f"      Highlight: '{sub.text}' with color {highlight_config.get('color')}")
                    else:
                        # Normaler Untertitel mit Config
                        if style == "karaoke":
                            sub_clips = create_karaoke_subtitle(sub.text, dur, clip.size, subtitle_config)
                        elif style == "typewriter":
                            sub_clips = create_typewriter_text(sub.text, dur, clip.size)
                        elif style == "bounce":
                            sub_clips = create_bounce_text(sub.text, dur, clip.size)
                        elif style == "glitch":
                            sub_clips = create_glitch_text(sub.text, dur, clip.size)
                        elif style == "neon":
                            sub_clips = create_neon_text(sub.text, dur, clip.size)
                        else:
                            sub_clips = create_modern_subtitle(sub.text, dur, clip.size, style, subtitle_config)

                        # Clips mit korrektem Timing hinzufügen
                        for sc in sub_clips:
                            if sc is not None:
                                sc = sc.set_start(sub.start)
                                all_clips.append(sc)

                except Exception as e:
                    self._report(f"    Error at '{sub.text[:20]}...': {e}")

        if not all_clips:
            self._report("    No subtitles created")
            return clip

        # Speichere Highlight-Sounds für spätere Verwendung
        self._highlight_sounds = highlight_sounds

        self._report(f"    {len(all_clips)} subtitles added ({len(highlight_sounds)} highlights)")
        return CompositeVideoClip([clip] + all_clips)

    # =========================================================================
    # SOUNDS
    # =========================================================================

    def _add_sounds(self, clip, config, emoji_timestamps):
        if clip.audio is None:
            return clip

        try:
            original = clip.audio

            # Audio Fade-In gegen Stimmenbruch am Anfang
            fade_in = config.get("audio_fade_in", 0.1)
            if fade_in > 0:
                original = original.audio_fadein(fade_in)

            if not config.get("enable_sounds", True):
                return clip.set_audio(original)

            sounds = []

            # Intro Sound (Swoosh)
            if config.get("sound_intro", True):
                intro = self.sound_effects.get_intro_sound()
                intro = intro.set_start(0).volumex(0.4)
                sounds.append(intro)

            # Outro Sound
            if config.get("sound_outro", True):
                outro = self.sound_effects.get_outro_sound()
                outro = outro.set_start(max(0, clip.duration - 0.5)).volumex(0.35)
                sounds.append(outro)

            # Emoji Sounds
            if config.get("sound_emojis", True) and emoji_timestamps:
                for ts in emoji_timestamps:
                    if 0.5 < ts < clip.duration - 0.5:
                        pop = self.sound_effects.get_emoji_sound()
                        pop = pop.set_start(ts).volumex(0.25)
                        sounds.append(pop)

            # Highlight-Sounds (boom, cash, ding, swoosh für bestimmte Wörter)
            if config.get("enable_highlights", True) and hasattr(self, '_highlight_sounds'):
                for ts, sound_type in self._highlight_sounds:
                    if 0.1 < ts < clip.duration - 0.3:
                        try:
                            highlight_sound = self.sound_effects.get_highlight_sound(sound_type)
                            # Lautstärke je nach Sound-Typ
                            volumes = {"boom": 0.35, "cash": 0.3, "ding": 0.25, "swoosh": 0.3}
                            vol = volumes.get(sound_type, 0.25)
                            highlight_sound = highlight_sound.set_start(ts).volumex(vol)
                            sounds.append(highlight_sound)
                            self._report(f"      Highlight sound: {sound_type} at {ts:.1f}s")
                        except Exception as e:
                            self._report(f"      Highlight sound error ({sound_type}): {e}")

            if sounds:
                combined = CompositeAudioClip([original] + sounds)
                return clip.set_audio(combined)

        except Exception as e:
            self._report(f"    Sound error: {e}")

        return clip

    # =========================================================================
    # INTRO / OUTRO ANIMATIONEN
    # =========================================================================

    def _apply_intro_animation(self, clip, config):
        """
        Wendet Intro-Animation basierend auf Config an.

        Config-Keys:
            intro_type: "slide", "scale", "flip", "bounce", "spin", "elastic", "blur_slide"
            intro_direction: "left", "right", "top", "bottom" (für slide, bounce)
            intro_origin: "center", "tl", "tr", "bl", "br" (für scale)
            intro_axis: "horizontal", "vertical" (für flip)
            intro_duration: Dauer in Sekunden
        """
        intro_type = config.get("intro_type")
        if not intro_type:
            return clip

        duration = config.get("intro_duration", 0.5)
        self._report(f"    Intro animation: {intro_type} ({duration}s)")

        try:
            if intro_type == "slide":
                direction = config.get("intro_direction", "right")
                return apply_slide_in(clip, duration, direction)

            elif intro_type == "scale":
                origin = config.get("intro_origin", "center")
                return apply_scale_in(clip, duration, origin)

            elif intro_type == "flip":
                axis = config.get("intro_axis", "horizontal")
                return apply_flip_in(clip, duration, axis)

            elif intro_type == "bounce":
                direction = config.get("intro_direction", "bottom")
                return apply_bounce_in(clip, duration, direction)

            elif intro_type == "spin":
                direction = config.get("intro_direction", "clockwise")
                return apply_spin_in(clip, duration, direction)

            elif intro_type == "elastic":
                return apply_elastic_in(clip, duration)

            elif intro_type == "blur_slide":
                direction = config.get("intro_direction", "right")
                return apply_blur_slide_in(clip, duration, direction)

        except Exception as e:
            self._report(f"    Intro animation error: {e}")

        return clip

    def _apply_outro_animation(self, clip, config):
        """
        Wendet Outro-Animation basierend auf Config an.

        Config-Keys:
            outro_type: "slide", "scale", "spin"
            outro_direction: "left", "right", "top", "bottom"
            outro_origin: "center", "tl", "tr", "bl", "br"
            outro_duration: Dauer in Sekunden
        """
        outro_type = config.get("outro_type")
        if not outro_type:
            return clip

        duration = config.get("outro_duration", 0.5)
        self._report(f"    Outro animation: {outro_type} ({duration}s)")

        try:
            if outro_type == "slide":
                direction = config.get("outro_direction", "left")
                return apply_slide_out(clip, duration, direction)

            elif outro_type == "scale":
                origin = config.get("outro_origin", "center")
                return apply_scale_out(clip, duration, origin)

            elif outro_type == "spin":
                # Für spin_out nutzen wir scale_out als Fallback
                origin = config.get("outro_origin", "center")
                return apply_scale_out(clip, duration, origin)

        except Exception as e:
            self._report(f"    Outro animation error: {e}")

        return clip

    # =========================================================================
    # ZEITBASIERTE EFFEKTE
    # =========================================================================

    def _find_word_time(self, subtitles, word: str) -> float:
        """
        Findet den Zeitpunkt eines Wortes in den Untertiteln.

        Args:
            subtitles: Liste von Subtitle-Objekten
            word: Das zu suchende Wort

        Returns:
            Zeitpunkt in Sekunden, oder -1 wenn nicht gefunden
        """
        word_lower = word.lower()

        for sub in subtitles:
            text_lower = sub.text.lower()
            if word_lower in text_lower:
                # Schätze Position des Wortes im Segment
                words = text_lower.split()
                if word_lower in words:
                    word_idx = words.index(word_lower)
                    word_ratio = word_idx / max(len(words), 1)
                    # Interpoliere Zeit
                    return sub.start + (sub.end - sub.start) * word_ratio
                else:
                    # Wort ist Teil eines längeren Wortes, nutze Mitte
                    return (sub.start + sub.end) / 2

        return -1

    def _apply_timed_effects(self, clip, timed_effects, subtitles):
        """
        Wendet zeitbasierte Effekte auf spezifische Segmente an.

        Args:
            clip: Video-Clip
            timed_effects: Liste von timed_effect Dicts
            subtitles: Liste von Subtitle-Objekten

        Returns:
            Modifizierter Clip
        """
        if not timed_effects:
            return clip

        for effect_data in timed_effects:
            position = effect_data.get("position", "start")
            time_value = effect_data.get("time_value")
            word_trigger = effect_data.get("word_trigger")
            effect = effect_data.get("effect", "")
            duration = effect_data.get("duration", 2.0)

            # Bestimme Startzeit
            if position == "start":
                start_time = 0
            elif position == "end":
                start_time = max(0, clip.duration - duration)
            elif position == "word" and word_trigger:
                start_time = self._find_word_time(subtitles, word_trigger)
                if start_time < 0:
                    self._report(f"    Word '{word_trigger}' not found, skipping effect")
                    continue
            elif position == "absolute" and time_value is not None:
                start_time = time_value
            else:
                continue

            # Validiere Zeitbereich
            if start_time >= clip.duration:
                continue
            duration = min(duration, clip.duration - start_time)

            self._report(f"    Timed effect: {effect} at {start_time:.1f}s for {duration:.1f}s")

            try:
                # Wende Effekt an
                if effect == "desaturate":
                    intensity = effect_data.get("params", {}).get("intensity", 1.0)
                    clip = apply_desaturate_segment(clip, start_time, duration, intensity)

                elif effect == "freeze_frame":
                    clip = apply_freeze_frame(clip, start_time, duration)

                elif effect == "slow_motion":
                    factor = effect_data.get("params", {}).get("factor", 0.5)
                    clip = apply_slow_motion_segment(clip, start_time, duration, factor)

                elif effect == "speed_up":
                    factor = effect_data.get("params", {}).get("factor", 2.0)
                    clip = apply_speed_up_segment(clip, start_time, duration, factor)

                elif effect == "reverse":
                    clip = apply_reverse_segment(clip, start_time, duration)

                elif effect == "flash":
                    intensity = effect_data.get("params", {}).get("intensity", 1.0)
                    clip = apply_flash(clip, start_time, min(duration, 0.3), intensity)

                elif effect == "impact_zoom":
                    intensity = effect_data.get("params", {}).get("intensity", 1.3)
                    clip = apply_impact_zoom(clip, start_time, min(duration, 0.5), intensity)

                elif effect == "shake":
                    intensity = effect_data.get("params", {}).get("intensity", 10)
                    clip = apply_shake_segment(clip, start_time, duration, intensity)

                elif effect == "zoom_in":
                    factor = effect_data.get("params", {}).get("factor", 1.3)
                    clip = apply_zoom_segment(clip, start_time, duration, factor)

                elif effect == "blur":
                    max_blur = effect_data.get("params", {}).get("max_blur", 20)
                    clip = apply_blur_segment(clip, start_time, duration, max_blur)

            except Exception as e:
                self._report(f"    Timed effect error ({effect}): {e}")

        return clip

    # =========================================================================
    # ACTION-BASIERTE EFFEKTE
    # =========================================================================

    def _apply_action_effects(self, clip, action_effects, video_path):
        """
        Wendet action-basierte Effekte an.

        Args:
            clip: Video-Clip
            action_effects: Liste von action_effect Dicts
            video_path: Pfad zum Original-Video für Action-Erkennung

        Returns:
            Modifizierter Clip
        """
        if not action_effects:
            return clip

        self._report("    Analyzing video for actions...")

        try:
            detector = ActionDetector(use_pose=False)
            all_events = detector.detect_events(str(video_path))
            detector.close()

            self._report(f"    {len(all_events)} action events detected")

            for ae_data in action_effects:
                action = ae_data.get("action", "")
                effect = ae_data.get("effect", "")
                duration = ae_data.get("duration", 3.0)
                offset = ae_data.get("offset", 0.0)

                # Finde passende Events
                matching_events = [e for e in all_events if e.action == action]

                if not matching_events:
                    self._report(f"    No '{action}' events found")
                    continue

                self._report(f"    {len(matching_events)} '{action}' events found")

                # Wende Effekt auf jeden passenden Event an
                for event in matching_events:
                    start_time = max(0, event.timestamp + offset)

                    if start_time >= clip.duration:
                        continue

                    actual_duration = min(duration, clip.duration - start_time)

                    self._report(f"      -> {effect} at {start_time:.1f}s for {actual_duration:.1f}s")

                    try:
                        if effect == "desaturate":
                            clip = apply_desaturate_segment(clip, start_time, actual_duration)

                        elif effect == "slow_motion":
                            clip = apply_slow_motion_segment(clip, start_time, actual_duration, 0.5)

                        elif effect == "freeze_frame":
                            clip = apply_freeze_frame(clip, start_time, actual_duration)

                        elif effect == "flash":
                            clip = apply_flash(clip, start_time, 0.2)

                        elif effect == "impact_zoom":
                            clip = apply_impact_zoom(clip, start_time, 0.3, 1.3)

                        elif effect == "shake":
                            clip = apply_shake_segment(clip, start_time, actual_duration, 10)

                        elif effect == "zoom_in":
                            clip = apply_zoom_segment(clip, start_time, actual_duration, 1.3)

                        elif effect == "blur":
                            clip = apply_blur_segment(clip, start_time, actual_duration, 20)

                    except Exception as e:
                        self._report(f"      Effect error: {e}")

        except Exception as e:
            self._report(f"    Action detection error: {e}")

        return clip

    # =========================================================================
    # OBJEKT-BASIERTE EFFEKTE
    # =========================================================================

    def _apply_object_effects(self, clip, object_effects, video_path):
        """
        Wendet objekt-basierte Effekte an.

        Args:
            clip: Video-Clip
            object_effects: Liste von object_effect Dicts
            video_path: Pfad zum Original-Video für Objekterkennung

        Returns:
            Modifizierter Clip
        """
        if not object_effects:
            return clip

        self._report("    Initializing object detection...")

        try:
            detector = ObjectDetector(confidence_threshold=0.4)

            if not detector.is_available():
                self._report("    WARNING: Object detection not available!")
                self._report("    Install: pip install ultralytics")
                return clip

            for oe_data in object_effects:
                object_name = oe_data.get("object_name", "")
                effect = oe_data.get("effect", "")
                duration = oe_data.get("duration", 2.0)
                trigger = oe_data.get("trigger", "visible")

                self._report(f"    Searching for '{object_name}'...")

                # Finde Objekt-Erscheinungen
                events = detector.detect_object_appearances(str(video_path), object_name)

                if not events:
                    self._report(f"    No '{object_name}' found in video")
                    continue

                self._report(f"    {len(events)} '{object_name}' appearances found")

                # Wende Effekt auf jede Erscheinung an
                for event in events:
                    start_time = event.timestamp

                    if start_time >= clip.duration:
                        continue

                    # Nutze entweder die angegebene Dauer oder die Sichtbarkeitsdauer
                    actual_duration = min(duration, event.duration, clip.duration - start_time)

                    self._report(f"      -> {effect} at {start_time:.1f}s for {actual_duration:.1f}s")

                    try:
                        if effect == "freeze_frame":
                            clip = apply_freeze_frame(clip, start_time, actual_duration)

                        elif effect == "slow_motion":
                            clip = apply_slow_motion_segment(clip, start_time, actual_duration, 0.5)

                        elif effect == "desaturate":
                            clip = apply_desaturate_segment(clip, start_time, actual_duration)

                        elif effect == "flash":
                            clip = apply_flash(clip, start_time, 0.2)

                        elif effect == "impact_zoom":
                            clip = apply_impact_zoom(clip, start_time, 0.3, 1.3)

                        elif effect == "zoom_in":
                            clip = apply_zoom_segment(clip, start_time, actual_duration, 1.3)

                        elif effect == "shake":
                            clip = apply_shake_segment(clip, start_time, actual_duration, 10)

                        elif effect == "blur":
                            clip = apply_blur_segment(clip, start_time, actual_duration, 20)

                    except Exception as e:
                        self._report(f"      Effect error: {e}")

            detector.close()

        except Exception as e:
            self._report(f"    Object detection error: {e}")
            import traceback
            traceback.print_exc()

        return clip

    # =========================================================================
    # AUDIO-REAKTIVE EFFEKTE
    # =========================================================================

    def _apply_audio_effects(self, clip, audio_effects, video_path, cut_times=None):
        """Wendet audio-reaktive Effekte an."""
        if not audio_effects:
            return clip

        self._report("    Applying audio-reactive effects...")

        try:
            # Erweiterte Audio-Analyse
            analyzer = AdvancedAudioAnalyzer(video_path, self.whisper_model)

            for ae_data in audio_effects:
                trigger = ae_data.get("trigger", "beat")
                effect = ae_data.get("effect", "zoom")
                intensity = ae_data.get("intensity", 1.0)

                self._report(f"      {effect} at {trigger}")

                if trigger == "beat":
                    beat_times = analyzer.get_beat_times(min_strength=0.3)
                    if beat_times:
                        if effect == "flash":
                            clip = apply_beat_flash(clip, beat_times, intensity * 0.3)
                        elif effect == "shake":
                            clip = apply_beat_shake(clip, beat_times, intensity * 10)
                        elif effect == "zoom":
                            clip = apply_beat_zoom(clip, beat_times, intensity * 0.08)
                        elif effect == "glitch":
                            clip = apply_bass_drop_effect(clip, beat_times, "glitch", intensity)
                        self._report(f"        -> {len(beat_times)} Beats")

                elif trigger == "bass_drop":
                    drop_times = analyzer.get_bass_drop_times()
                    if drop_times:
                        clip = apply_bass_drop_effect(clip, drop_times, effect, intensity)
                        self._report(f"        -> {len(drop_times)} Bass-Drops")

                elif trigger in ("loud", "volume"):
                    loud_times = analyzer.get_loud_moments()
                    if loud_times:
                        if effect == "flash":
                            clip = apply_beat_flash(clip, loud_times, intensity * 0.4)
                        elif effect == "shake":
                            clip = apply_beat_shake(clip, loud_times, intensity * 12)
                        elif effect == "zoom":
                            clip = apply_beat_zoom(clip, loud_times, intensity * 0.1)
                        self._report(f"        -> {len(loud_times)} loud moments")

                elif trigger == "cut":
                    # Flash/Effekt bei jedem Schnitt
                    if cut_times:
                        if effect == "flash":
                            clip = apply_beat_flash(clip, cut_times, intensity * 0.4)
                        elif effect == "shake":
                            clip = apply_beat_shake(clip, cut_times, intensity * 8)
                        elif effect == "zoom":
                            clip = apply_beat_zoom(clip, cut_times, intensity * 0.1)
                        elif effect == "glitch":
                            clip = apply_bass_drop_effect(clip, cut_times, "glitch", intensity)
                        self._report(f"        -> {len(cut_times)} Cuts")

        except Exception as e:
            self._report(f"    Audio effects error: {e}")

        return clip

    # =========================================================================
    # GESICHTS-EFFEKTE
    # =========================================================================

    def _apply_face_effects(self, clip, face_effects, video_path):
        """Wendet gesichts-basierte Effekte an."""
        if not face_effects:
            return clip

        self._report("    Applying face-based effects...")

        try:
            detector = FaceDetector()
            face_positions = detector.get_face_positions_for_effects(video_path)

            if not face_positions:
                self._report("      No faces found")
                return clip

            self._report(f"      {len(face_positions)} face positions detected")

            for fe_data in face_effects:
                effect = fe_data.get("effect", "zoom")
                intensity = fe_data.get("intensity", 1.0)

                self._report(f"      Effect: {effect}")

                if effect == "zoom":
                    clip = apply_face_zoom(clip, face_positions, zoom_factor=intensity)
                elif effect == "blur":
                    clip = apply_face_blur(clip, face_positions, blur_amount=int(intensity))
                elif effect == "spotlight":
                    clip = apply_spotlight_face(clip, face_positions)

            detector.close()

        except Exception as e:
            self._report(f"    Face effects error: {e}")

        return clip

    # =========================================================================
    # ERWEITERTE VISUELLE EFFEKTE
    # =========================================================================

    def _apply_advanced_visual_effects(self, clip, config):
        """Wendet erweiterte visuelle Effekte an."""
        # Color Grading Presets
        color_preset = config.get("color_preset")
        if color_preset:
            self._report(f"    Color Preset: {color_preset}")
            clip = apply_color_grade_preset(clip, color_preset)

        # Scanlines
        if config.get("scanlines"):
            intensity = config.get("scanlines_intensity", 0.3)
            clip = apply_scanlines(clip, intensity)

        # Chromatic Aberration
        if config.get("chromatic_aberration"):
            intensity = config.get("chromatic_intensity", 5)
            clip = apply_chromatic_aberration(clip, intensity)

        # CRT Effekt
        if config.get("crt_effect"):
            clip = apply_crt_effect(clip)

        # Glitch Blocks
        if config.get("glitch_blocks"):
            intensity = config.get("glitch_intensity", 0.5)
            clip = apply_glitch_blocks(clip, intensity)

        # Split Screen
        if config.get("split_screen"):
            layout = config.get("split_layout", "horizontal")
            clip = apply_split_screen(clip, layout)

        # Ken Burns
        if config.get("ken_burns"):
            start_pos = config.get("ken_burns_start", "center")
            end_pos = config.get("ken_burns_end", "top_right")
            start_zoom = config.get("ken_burns_start_zoom", 1.0)
            end_zoom = config.get("ken_burns_end_zoom", 1.3)
            clip = apply_ken_burns(clip, start_pos, end_pos, start_zoom, end_zoom)

        return clip

    # =========================================================================
    # BILDGENERIERUNG
    # =========================================================================

    def _apply_generated_images(self, clip, config, subtitles):
        """Generiert und fügt KI-Bilder basierend auf Keywords oder manuell ein."""
        image_gen_config = config.get("image_gen")
        if not image_gen_config or not image_gen_config.get("enabled"):
            return clip

        if not DIFFUSERS_AVAILABLE:
            self._report("    WARNING: Image generation not available!")
            self._report("    Install: pip install diffusers torch accelerate transformers")
            return clip

        self._report("    Initializing image generation...")

        try:
            generator = ImageGenerator()

            if not generator.is_available():
                self._report("    Image generation not available")
                return clip

            position = image_gen_config.get("position", "center")
            size = image_gen_config.get("size", 1.0)
            style = image_gen_config.get("style", "fullscreen")

            # Prüfe ob manuelle Bilder angegeben wurden
            manual_images = image_gen_config.get("manual_images", [])

            if manual_images:
                # MANUELLER MODUS: Generiere spezifische Bilder zu bestimmten Zeiten
                self._report(f"    Generating {len(manual_images)} manual images...")

                # Bildgröße für 9:16
                vid_w, vid_h = clip.size
                if vid_h > vid_w:
                    img_w, img_h = 576, 1024
                else:
                    img_w, img_h = 1024, 576

                generated = []
                for img_config in manual_images:
                    timestamp = img_config.get("timestamp", 0)
                    keyword = img_config.get("keyword", "")
                    duration = img_config.get("duration", 0.8)

                    # Prüfe ob Timestamp im Video-Bereich
                    if timestamp >= clip.duration:
                        self._report(f"      Skipping {keyword}@{timestamp}s (video only {clip.duration:.1f}s)")
                        continue

                    self._report(f"      Generating '{keyword}' for second {timestamp}...")
                    image = generator.generate_for_keyword(keyword, img_w, img_h)

                    if image is not None:
                        generated.append({
                            'image': image,
                            'timestamp': timestamp,
                            'duration': duration,
                            'keyword': keyword
                        })
                    else:
                        self._report(f"      '{keyword}' failed")

            else:
                # AUTOMATISCHER MODUS: Keywords in Untertiteln suchen
                keywords = image_gen_config.get("keywords", [])
                max_images = image_gen_config.get("max_images", 3)

                self._report(f"    Searching keywords in {len(subtitles)} subtitles...")
                generated = generator.generate_images_for_subtitles(
                    subtitles,
                    keywords=keywords if keywords else None,
                    video_size=clip.size,
                    max_images=max_images
                )

            if generated:
                self._report(f"    {len(generated)} images generated!")

                # Als Overlays hinzufügen
                clip = add_generated_image_overlays(
                    clip,
                    generated,
                    position=position,
                    size=size,
                    style=style
                )
            else:
                self._report("    No images generated")

            generator.close()

        except Exception as e:
            self._report(f"    Image generation error: {e}")
            import traceback
            traceback.print_exc()

        return clip

    # =========================================================================
    # MAIN EDIT
    # =========================================================================

    def edit_video(self, style_name: str, parallel: bool = True) -> str:
        """
        Bearbeitet das Video mit dem angegebenen Stil.

        Args:
            style_name: Name des Stils
            parallel: Wenn True, parallele Verarbeitung (viel schneller)
        """
        self._check_cancel()
        config = get_style(style_name)

        if parallel:
            return self._edit_video_parallel(config, style_name)
        else:
            return self._edit_video_sequential(config, style_name)

    def _edit_video_parallel(self, config: dict, style_name: str) -> str:
        """Parallele Video-Verarbeitung - nutzt alle CPU-Kerne."""
        self._check_cancel()

        self._report(f"\n{'='*60}")
        self._report(f"  {config['name']}: {config['description']}")
        self._report(f"  [PARALLEL MODE - {mp.cpu_count()} cores]")
        self._report(f"{'='*60}")

        # Analyse
        if config.get("enable_subtitles"):
            self._get_subtitles()

        segments = self._get_speech_segments(config)

        self._report("\n[4/6] Preparing...", step=4, total_steps=6)

        # Untertitel pro Segment vorbereiten
        # Subtitle-Offset korrigiert Whisper-Latenz (negativ = früher anzeigen)
        subtitle_offset = config.get("subtitle_offset", -0.05)  # 50ms früher

        segment_subtitles = []
        offset = 0
        for i, (start, end) in enumerate(segments):
            seg_duration = min(end, self.duration - 0.01) - start
            if config.get("enable_subtitles") and self._subtitles:
                subs = []
                for sub in self._subtitles:
                    if sub.end < start or sub.start > end:
                        continue
                    s = max(sub.start, start)
                    e = min(sub.end, end)
                    if e - s >= 0.1:
                        # Relative Zeit zum Segment-Start + Offset-Korrektur
                        sub_start = max(0, (s - start) + subtitle_offset)
                        sub_end = max(sub_start + 0.1, (e - start) + subtitle_offset)
                        subs.append({
                            'start': sub_start,
                            'end': sub_end,
                            'text': sub.text
                        })
                segment_subtitles.append(subs)
            else:
                segment_subtitles.append([])
            offset += seg_duration

        # Temp-Verzeichnis erstellen
        temp_dir = tempfile.mkdtemp(prefix="video_edit_")
        self._report(f"  Temp directory: {temp_dir}")

        # Worker-Argumente vorbereiten
        # Nutze das normalisierte Video (skaliert) falls vorhanden
        worker_video_path = getattr(self, '_temp_normalized', str(self.input_path))

        worker_args = []
        for i, (start, end) in enumerate(segments):
            args = (
                i, start, end,
                worker_video_path,  # Skaliertes Video statt Original!
                temp_dir,
                config,
                len(segments),
                segment_subtitles[i],
                self.size,
                self.fps
            )
            worker_args.append(args)

        # Parallele Verarbeitung
        self._report(f"\n[5/6] Processing {len(segments)} segments in parallel...", step=5, total_steps=6)

        num_workers = 1  # Nur 1 Worker um RAM-Überlastung zu vermeiden
        temp_files = [None] * len(segments)
        errors = []

        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = {executor.submit(_process_segment_worker, args): args[0]
                      for args in worker_args}

            completed = 0
            for future in as_completed(futures):
                # Check cancel — if cancelled, kill remaining futures
                if self.cancel_check and self.cancel_check():
                    for f in futures:
                        f.cancel()
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise InterruptedError("Processing cancelled")
                segment_idx = futures[future]
                try:
                    idx, temp_path, error = future.result(timeout=300)
                    if error:
                        errors.append(f"Segment {idx}: {error}")
                        self._report(f"  Segment {idx+1}/{len(segments)} failed: {error}")
                    else:
                        temp_files[idx] = temp_path
                        completed += 1
                        self._report(f"  Segment {idx+1}/{len(segments)} done ({completed}/{len(segments)})", step=5, total_steps=6, progress=completed/len(segments))
                except Exception as e:
                    errors.append(f"Segment {segment_idx}: {str(e)}")
                    self._report(f"  Segment {segment_idx+1} Exception: {e}")

        if errors:
            self._report(f"\n  WARNING: {len(errors)} errors occurred")
            for err in errors[:5]:
                self._report(f"    - {err}")

        # Nur erfolgreiche Segmente
        valid_temp_files = [f for f in temp_files if f is not None]

        if not valid_temp_files:
            raise RuntimeError("No segments processed successfully!")

        # Mit FFmpeg zusammenfügen (kein Re-Encoding = sehr schnell)
        self._report(f"\n[6/6] Merging {len(valid_temp_files)} segments...", step=6, total_steps=6)

        out_path = self.output_dir / f"{self.input_path.stem}_{style_name}.mp4"

        # Concat-Liste erstellen
        concat_list = os.path.join(temp_dir, "concat_list.txt")
        with open(concat_list, 'w') as f:
            for temp_file in valid_temp_files:
                f.write(f"file '{temp_file}'\n")

        # FFmpeg concat (stream copy = kein Re-Encoding)
        concat_cmd = [
            get_ffmpeg_path(), '-y', '-f', 'concat', '-safe', '0',
            '-i', concat_list,
            '-c', 'copy',  # Stream copy = keine Neukodierung
            str(out_path)
        ]

        result = subprocess.run(concat_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            self._report(f"  FFmpeg concat error: {result.stderr}")
            # Fallback: mit Re-Encoding (hohe Qualität)
            concat_cmd = [
                get_ffmpeg_path(), '-y', '-f', 'concat', '-safe', '0',
                '-i', concat_list,
                '-c:v', get_video_codec(),
                '-b:v', '12M',
                ] + get_codec_params() + [
                '-c:a', 'aac', '-b:a', '192k',
                str(out_path)
            ]
            subprocess.run(concat_cmd, capture_output=True)

        # Auto-Reframe für 9:16 (TikTok/Reels) - NUR wenn Video im Querformat ist
        # und das Cropping sinnvoll wäre (nicht zu viel Bildverlust)
        if config.get("auto_reframe", False):
            video_width, video_height = self.size
            is_landscape = video_width > video_height

            if is_landscape:
                # Querformat -> KEIN automatisches Cropping (zu viel Bildverlust)
                self._report(f"  Video is landscape ({video_width}x{video_height}) - no crop to 9:16")
                self._report(f"  (Cropping would cut too much of the image)")
            else:
                # Hochformat -> prüfen ob bereits 9:16
                current_ratio = video_width / video_height
                target_ratio_val = 9 / 16  # 0.5625

                if abs(current_ratio - target_ratio_val) < 0.05:
                    self._report(f"  Video is already ~9:16 - no reframe needed")
                else:
                    # Leichtes Cropping für exaktes 9:16
                    target_ratio = config.get("target_ratio", "9:16")
                    self._report(f"  Reframe to {target_ratio}...")

                    reframe_temp = os.path.join(temp_dir, "reframed.mp4")
                    reframe_cmd = [
                        get_ffmpeg_path(), '-y', '-i', str(out_path),
                        '-vf', 'crop=ih*9/16:ih',
                        '-c:v', get_video_codec(),
                        '-b:v', '10M',
                        '-c:a', 'copy',
                        reframe_temp
                    ]
                    result = subprocess.run(reframe_cmd, capture_output=True)

                    if result.returncode == 0:
                        import shutil
                        shutil.move(reframe_temp, str(out_path))
                        self._report(f"  Reframe successful!")
                    else:
                        self._report(f"  Reframe failed")

        # Cleanup temp files
        import shutil
        try:
            shutil.rmtree(temp_dir)
        except:
            pass

        # Finale Statistik
        if out_path.exists():
            final_size = out_path.stat().st_size / (1024 * 1024)
            self._report(f"\n  Done! Output: {out_path}")
            self._report(f"  File size: {final_size:.1f} MB")

        return str(out_path)

    def _edit_video_sequential(self, config: dict, style_name: str) -> str:
        """Sequentielle Video-Verarbeitung (Original-Methode)."""
        self._check_cancel()

        self._report(f"\n{'='*60}")
        self._report(f"  {config['name']}: {config['description']}")
        self._report(f"{'='*60}")

        # Analyse
        if config.get("enable_subtitles"):
            self._get_subtitles()

        segments = self._get_speech_segments(config)
        beat_times = self._get_beat_times(config)

        self._report("\n[4/6] Analyzing faces...", step=4, total_steps=6)
        self._report("\n[5/6] Creating segments...", step=5, total_steps=6)

        clips = []
        all_subs = []
        all_emojis = []
        offset = 0

        for i, (start, end) in enumerate(segments):
            self._check_cancel()
            self._report(f"  Segment {i+1}/{len(segments)}: {start:.1f}s - {end:.1f}s", step=5, total_steps=6, progress=(i+1)/len(segments))

            clip = self.original_clip.subclip(start, min(end, self.duration - 0.01))
            faces = self._analyze_faces(start, end) if config.get("smart_zoom") else None

            clip = self._apply_zoom_effects(clip, config, i, faces, beat_times)
            clip = self._apply_visual_effects(clip, config)

            trans_dur = config.get("transition_duration", 0.3)
            if i == 0:
                if config.get("intro_type"):
                    clip = self._apply_intro_animation(clip, config)
                else:
                    clip = self._apply_transition(clip, config.get("transition_in", "fade"), trans_dur, "in")

            if i == len(segments) - 1:
                if config.get("outro_type"):
                    clip = self._apply_outro_animation(clip, config)
                else:
                    clip = self._apply_transition(clip, config.get("transition_out", "fade"), trans_dur, "out")

            clips.append(clip)

            if config.get("enable_subtitles"):
                subs = self._get_segment_subtitles(start, end, offset)
                all_subs.extend(subs)
                if config.get("enable_emojis"):
                    all_emojis.extend(self._get_emoji_events(subs))

            offset += clip.duration

        cut_times = []
        current_time = 0
        for c in clips[:-1]:
            current_time += c.duration
            cut_times.append(current_time)

        self._report("\n[6/6] Finalizing...", step=6, total_steps=6)
        final = concatenate_videoclips(clips, method="compose") if len(clips) > 1 else clips[0]

        if config.get("auto_reframe", False):
            target_ratio = config.get("target_ratio", "9:16")
            self._report(f"  Reframe to {target_ratio}...")
            final = apply_auto_reframe(final, target_ratio)

        timed_effects = config.get("timed_effects", [])
        if timed_effects:
            self._report(f"  {len(timed_effects)} timed effects...")
            final = self._apply_timed_effects(final, timed_effects, all_subs)

        action_effects = config.get("action_effects", [])
        if action_effects:
            self._report(f"  {len(action_effects)} action-based effects...")
            final = self._apply_action_effects(final, action_effects, self.input_path)

        object_effects = config.get("object_effects", [])
        if object_effects:
            self._report(f"  {len(object_effects)} object-based effects...")
            final = self._apply_object_effects(final, object_effects, self.input_path)

        audio_effects = config.get("audio_effects", [])
        if audio_effects:
            self._report(f"  {len(audio_effects)} audio-reactive effects...")
            final = self._apply_audio_effects(final, audio_effects, self.input_path, cut_times)

        face_effects = config.get("face_effects", [])
        if face_effects:
            self._report(f"  {len(face_effects)} face-based effects...")
            final = self._apply_face_effects(final, face_effects, self.input_path)

        final = self._apply_advanced_visual_effects(final, config)

        if config.get("image_gen", {}).get("enabled"):
            self._report("  Generating AI images...")
            final = self._apply_generated_images(final, config, all_subs)

        if all_subs and config.get("enable_subtitles"):
            self._report(f"  {len(all_subs)} subtitles...")
            final = self._add_subtitles(final, all_subs, config)

        if all_emojis and config.get("enable_emojis"):
            self._report(f"  {len(all_emojis)} Emojis...")
            final = add_emoji_overlays(final, all_emojis)

        emoji_ts = [e[0] for e in all_emojis] if all_emojis else []
        final = self._add_sounds(final, config, emoji_ts)

        out_path = self.output_dir / f"{self.input_path.stem}_{style_name}.mp4"
        self._report(f"  Exporting: {out_path}")

        final.write_videofile(
            str(out_path),
            codec=get_video_codec(),
            audio_codec="aac",
            audio_bitrate="192k",
            bitrate="12M",
            temp_audiofile=f"temp-{style_name}.m4a",
            remove_temp=True,
            verbose=False,
            logger=None,
            ffmpeg_params=get_codec_params()
        )

        reduction = (1 - final.duration / self.duration) * 100
        self._report(f"\n  Done! {self.duration:.1f}s -> {final.duration:.1f}s ({reduction:.0f}% shorter)")

        final.close()
        for c in clips:
            try:
                c.close()
            except Exception:
                pass

        return str(out_path)

    def create_all_variants(self) -> dict:
        """Erstellt alle Stil-Varianten."""
        results = {}
        for style in list_styles():
            try:
                results[style] = self.edit_video(style)
            except Exception as e:
                print(f"\nFehler bei '{style}': {e}")
                import traceback
                traceback.print_exc()
                results[style] = None
        return results

    def create_selected_variants(self, styles: list) -> dict:
        """Erstellt ausgewählte Stil-Varianten."""
        results = {}
        for style in styles:
            try:
                results[style] = self.edit_video(style)
            except Exception as e:
                print(f"\nFehler bei '{style}': {e}")
                results[style] = None
        return results

    def edit_with_prompt(self, prompt: str) -> str:
        """
        Bearbeitet das Video basierend auf einem natürlichsprachlichen Prompt.

        Args:
            prompt: Natürlichsprachlicher Prompt wie "mach es dynamisch mit glitch"

        Returns:
            Pfad zum Output-Video
        """
        from .prompt_engine import PromptEngine

        engine = PromptEngine()
        analysis = engine.analyze(prompt)

        self._report(f"\n{'='*60}")
        self._report(f"  PROMPT-BASED EDITING")
        self._report(f"{'='*60}")
        self._report(f"  Prompt: \"{prompt}\"")
        self._report(f"  Detected style: {analysis.base_style}")
        if analysis.detected_keywords:
            self._report(f"  Detected effects: {', '.join(analysis.detected_keywords)}")
        self._report(f"  Confidence: {analysis.confidence * 100:.0f}%")
        self._report(f"{'='*60}")

        # Verwende die generierte Konfiguration
        config = analysis.effects
        config["name"] = "Prompt"
        config["description"] = f"Generiert aus: {prompt[:50]}..."

        # Custom Highlights aus Prompt-Analyse übernehmen
        if analysis.custom_highlights:
            config["custom_highlights"] = analysis.custom_highlights
            self._report(f"  Word highlights: {list(analysis.custom_highlights.keys())}")

        return self._edit_with_config(config, "prompt")

    def _edit_with_config(self, config: dict, output_suffix: str = "custom", parallel: bool = True) -> str:
        """
        Bearbeitet das Video mit einer benutzerdefinierten Konfiguration.

        Args:
            config: Konfiguration als dict
            output_suffix: Suffix für den Output-Dateinamen
            parallel: Wenn True, parallele Verarbeitung

        Returns:
            Pfad zum Output-Video
        """
        self._check_cancel()
        if parallel:
            # Nutze parallele Version
            config["name"] = config.get("name", "Custom")
            config["description"] = config.get("description", "")
            return self._edit_video_parallel(config, output_suffix)

        # Sequentielle Version (Fallback)
        self._report(f"\n{'='*60}")
        self._report(f"  {config.get('name', 'Custom')}: {config.get('description', '')}")
        self._report(f"{'='*60}")

        if config.get("enable_subtitles"):
            self._get_subtitles()

        segments = self._get_speech_segments(config)
        beat_times = self._get_beat_times(config)

        self._report("\n[4/6] Analyzing faces...", step=4, total_steps=6)
        self._report("\n[5/6] Creating segments...", step=5, total_steps=6)

        clips = []
        all_subs = []
        all_emojis = []
        offset = 0

        for i, (start, end) in enumerate(segments):
            self._check_cancel()
            self._report(f"  Segment {i+1}/{len(segments)}: {start:.1f}s - {end:.1f}s", step=5, total_steps=6, progress=(i+1)/len(segments))

            clip = self.original_clip.subclip(start, min(end, self.duration - 0.01))
            faces = self._analyze_faces(start, end) if config.get("smart_zoom") else None

            clip = self._apply_zoom_effects(clip, config, i, faces, beat_times)
            clip = self._apply_visual_effects(clip, config)

            trans_dur = config.get("transition_duration", 0.3)
            if i == 0:
                if config.get("intro_type"):
                    clip = self._apply_intro_animation(clip, config)
                else:
                    clip = self._apply_transition(clip, config.get("transition_in", "fade"), trans_dur, "in")

            if i == len(segments) - 1:
                if config.get("outro_type"):
                    clip = self._apply_outro_animation(clip, config)
                else:
                    clip = self._apply_transition(clip, config.get("transition_out", "fade"), trans_dur, "out")

            clips.append(clip)

            if config.get("enable_subtitles"):
                subs = self._get_segment_subtitles(start, end, offset)
                all_subs.extend(subs)
                if config.get("enable_emojis"):
                    all_emojis.extend(self._get_emoji_events(subs))

            offset += clip.duration

        cut_times = []
        current_time = 0
        for c in clips[:-1]:
            current_time += c.duration
            cut_times.append(current_time)

        self._report("\n[6/6] Finalizing...", step=6, total_steps=6)
        final = concatenate_videoclips(clips, method="compose") if len(clips) > 1 else clips[0]

        if config.get("auto_reframe", False):
            final = apply_auto_reframe(final, config.get("target_ratio", "9:16"))

        timed_effects = config.get("timed_effects", [])
        if timed_effects:
            final = self._apply_timed_effects(final, timed_effects, all_subs)

        action_effects = config.get("action_effects", [])
        if action_effects:
            final = self._apply_action_effects(final, action_effects, self.input_path)

        object_effects = config.get("object_effects", [])
        if object_effects:
            final = self._apply_object_effects(final, object_effects, self.input_path)

        audio_effects = config.get("audio_effects", [])
        if audio_effects:
            final = self._apply_audio_effects(final, audio_effects, self.input_path, cut_times)

        face_effects = config.get("face_effects", [])
        if face_effects:
            final = self._apply_face_effects(final, face_effects, self.input_path)

        final = self._apply_advanced_visual_effects(final, config)

        if config.get("image_gen", {}).get("enabled"):
            final = self._apply_generated_images(final, config, all_subs)

        if all_subs and config.get("enable_subtitles"):
            final = self._add_subtitles(final, all_subs, config)

        if all_emojis and config.get("enable_emojis"):
            final = add_emoji_overlays(final, all_emojis)

        emoji_ts = [e[0] for e in all_emojis] if all_emojis else []
        final = self._add_sounds(final, config, emoji_ts)

        out_path = self.output_dir / f"{self.input_path.stem}_{output_suffix}.mp4"
        self._report(f"  Exporting: {out_path}")

        final.write_videofile(
            str(out_path),
            codec=get_video_codec(),
            audio_codec="aac",
            audio_bitrate="192k",
            bitrate="12M",
            temp_audiofile=f"temp-{output_suffix}.m4a",
            remove_temp=True,
            verbose=False,
            logger=None,
            ffmpeg_params=get_codec_params()
        )

        reduction = (1 - final.duration / self.duration) * 100
        self._report(f"\n  Done! {self.duration:.1f}s -> {final.duration:.1f}s ({reduction:.0f}% shorter)")

        final.close()
        for c in clips:
            try:
                c.close()
            except Exception:
                pass

        return str(out_path)

    def close(self):
        if hasattr(self, 'original_clip') and self.original_clip:
            try:
                self.original_clip.close()
            except:
                pass
        if self._sound_effects:
            self._sound_effects.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
