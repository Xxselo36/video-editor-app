"""
Fast Video Editor - FFmpeg-basiert für maximale Geschwindigkeit

Nutzt FFmpeg direkt statt MoviePy für:
- Korrekte Rotation/Seitenverhältnis
- Schnitte ohne Re-Encoding
- Hardware-Encoding (VideoToolbox)
- Untertitel mit ASS-Filter
"""

import os
import sys
import subprocess
import json
import tempfile
from pathlib import Path
from dataclasses import dataclass
from typing import List, Tuple, Optional

from .audio import AudioAnalyzer, Subtitle
from .ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path
from .platform_utils import get_video_codec, get_codec_params, get_subprocess_kwargs


def _rgb_to_ass_bgr(r: int, g: int, b: int, alpha: int = 0) -> str:
    """Convert RGB tuple to ASS color format &HAABBGGRR.
    alpha: 0=opaque, 255=transparent (ASS convention)."""
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def _hex_to_ass_bgr(hex_color: str, alpha: int = 0) -> str:
    """Convert hex color (#RRGGBB) to ASS color format &HAABBGGRR.
    alpha: 0=opaque, 255=transparent (ASS convention)."""
    hex_color = hex_color.lstrip('#')
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    return _rgb_to_ass_bgr(r, g, b, alpha)


def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """Convert hex color (#RRGGBB) to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    return (int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16))


def _position_to_ass_alignment(position: str) -> int:
    """Map position string to ASS alignment value.
    ASS: 1-3=bottom, 4-6=middle, 7-9=top (numpad layout).
    Center column: 2=bottom-center, 5=middle-center, 8=top-center."""
    mapping = {"bottom": 2, "center": 5, "top": 8}
    return mapping.get(position, 2)


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    duration: float
    rotation: int
    display_width: int  # Nach Rotation
    display_height: int  # Nach Rotation


class FastVideoEditor:
    """Schneller Video Editor mit direktem FFmpeg-Zugriff."""

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

        # Video-Info holen
        self.info = self._get_video_info()
        self._report(f"Lade Video: {self.input_path}")
        self._report(f"  Original: {self.info.width}x{self.info.height}, {self.info.fps:.0f}fps, {self.info.duration:.1f}s")
        self._report(f"  Rotation: {self.info.rotation}")
        self._report(f"  Display: {self.info.display_width}x{self.info.display_height}")

        # Lazy-loaded
        self._audio_analyzer = None
        self._subtitles = None

    def _report(self, message, step=None, total_steps=None, progress=None):
        """Gibt Status aus und ruft optional den Callback auf."""
        print(message)
        if self.progress_callback:
            self.progress_callback(message, step, total_steps, progress)

    def _check_cancel(self):
        """Prueft ob abgebrochen werden soll."""
        if self.cancel_check and self.cancel_check():
            raise InterruptedError("Verarbeitung abgebrochen")

    def _get_video_info(self) -> VideoInfo:
        """Holt Video-Informationen mit ffprobe."""
        cmd = [
            get_ffprobe_path(), '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate,duration',
            '-show_entries', 'stream_side_data=rotation',
            '-show_entries', 'format=duration',
            '-of', 'json',
            str(self.input_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, **get_subprocess_kwargs())
        data = json.loads(result.stdout)

        stream = data['streams'][0]
        width = int(stream['width'])
        height = int(stream['height'])

        # FPS parsen (kann "60/1" oder "59.94" sein)
        fps_str = stream['r_frame_rate']
        if '/' in fps_str:
            num, den = fps_str.split('/')
            fps = float(num) / float(den)
        else:
            fps = float(fps_str)

        # Duration
        duration = float(stream.get('duration', 0))
        if duration == 0:
            duration = float(data.get('format', {}).get('duration', 0))

        # Rotation
        rotation = 0
        if 'side_data_list' in stream:
            for side_data in stream['side_data_list']:
                if 'rotation' in side_data:
                    rotation = int(side_data['rotation'])

        # Display-Größe nach Rotation
        if abs(rotation) in [90, 270, -90, -270]:
            display_width, display_height = height, width
        else:
            display_width, display_height = width, height

        return VideoInfo(
            width=width,
            height=height,
            fps=fps,
            duration=duration,
            rotation=rotation,
            display_width=display_width,
            display_height=display_height
        )

    @property
    def audio_analyzer(self):
        if self._audio_analyzer is None:
            self._audio_analyzer = AudioAnalyzer(str(self.input_path), self.whisper_model, self.progress_callback)
        return self._audio_analyzer

    def _get_subtitles(self) -> List[Subtitle]:
        """Transkribiert Audio und gibt Untertitel zurück."""
        if self._subtitles is None:
            self._check_cancel()
            self._report("Transkribiere Audio...", step=1, total_steps=4)
            self._subtitles = self.audio_analyzer.transcribe()
            if self._subtitles:
                self._report(f"  {len(self._subtitles)} Untertitel-Segmente erkannt")
            else:
                self._report("  WARNUNG: Keine Sprache erkannt!")
        return self._subtitles or []

    def _detect_silence(self, threshold: float = 0.025,
                        min_silence: float = 0.6,
                        smart_cut: bool = False,
                        remove_fillers: bool = False,
                        filler_sensitivity: str = "medium") -> List[Tuple[float, float]]:
        """Erkennt Sprach-Segmente (nicht-Stille)."""
        self._check_cancel()
        self._report("Analysiere Stille...", step=2, total_steps=4)
        segments = self.audio_analyzer.detect_silence(
            silence_threshold=threshold,
            min_silence_duration=min_silence
        )

        # Mehr Padding für natürlichere Schnitte
        padding_before = 0.35  # Vor Sprache
        padding_after = 0.25   # Nach Sprache
        min_segment_length = 0.8  # Mindestlänge
        merge_gap = 0.4  # Segmente zusammenführen wenn Lücke kleiner

        speech = []
        for seg in segments:
            if seg.has_speech:
                start = max(0, seg.start - padding_before)
                end = min(self.info.duration, seg.end + padding_after)
                speech.append((start, end))

        if not speech:
            return [(0, self.info.duration)]

        # Intelligentes Merging
        merged = [speech[0]]
        for start, end in speech[1:]:
            gap = start - merged[-1][1]
            if gap <= merge_gap or (start - merged[-1][0]) < min_segment_length:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))

        # Entferne zu kurze Segmente
        final = []
        for i, (start, end) in enumerate(merged):
            duration = end - start
            if duration < min_segment_length and final:
                final[-1] = (final[-1][0], end)
            else:
                final.append((start, end))

        # Letztes Segment prüfen
        if len(final) > 1 and (final[-1][1] - final[-1][0]) < min_segment_length:
            last = final.pop()
            final[-1] = (final[-1][0], last[1])

        # Smart cut: enhance with word-level intelligence
        if smart_cut:
            transcription = self.audio_analyzer._transcription
            if transcription is None:
                self.audio_analyzer.transcribe()
                transcription = self.audio_analyzer._transcription

            if transcription and transcription.get("segments"):
                from .smart_cut import SmartCutter
                cutter = SmartCutter(transcription, self.info.duration)

                # Get word-based speech regions
                word_segments = cutter.compute_speech_regions()

                # Hybrid: combine RMS and word-based detection
                final = cutter.hybrid_detect(final, word_segments)

                # Optimize cut points to sentence/clause boundaries
                final = cutter.optimize_cuts(final)

                # Final merge
                final = cutter.merge_segments(final)

                print(f"[FastEditor] Smart cut: optimized to {len(final)} segments")

        # Filler word removal
        if remove_fillers:
            transcription = self.audio_analyzer._transcription
            if transcription is None:
                self.audio_analyzer.transcribe()
                transcription = self.audio_analyzer._transcription

            if transcription:
                from .filler_detection import FillerDetector
                detector = FillerDetector(
                    language=transcription.get("language", "en"),
                    sensitivity=filler_sensitivity
                )
                filler_segments = detector.get_filler_segments(transcription)
                if filler_segments:
                    n = len(filler_segments)
                    total_filler = sum(e - s for s, e in filler_segments)
                    final = detector.filter_segments(final, filler_segments)
                    self._report(f"[FastEditor] Removed {n} filler words ({total_filler:.1f}s of filler content)")

        removed = self.info.duration - sum(e - s for s, e in final)
        self._report(f"  {len(final)} Segmente, {removed:.1f}s Stille entfernt")
        return final

    def _create_drawtext_filters(self, subtitles: List[Subtitle],
                                   segments: List[Tuple[float, float]],
                                   config: dict = None) -> List[str]:
        """Erstellt FFmpeg drawtext Filter für Untertitel."""
        if config is None:
            config = {}

        # Zeit-Mapping berechnen
        offset_map = []
        new_time = 0
        for orig_start, orig_end in segments:
            offset_map.append((orig_start, orig_end, new_time))
            new_time += (orig_end - orig_start)

        def map_time(t: float):
            for orig_start, orig_end, new_start in offset_map:
                if orig_start <= t <= orig_end:
                    return new_start + (t - orig_start)
            return None

        # Fontgröße und Position from config
        fontsize_multiplier = config.get("subtitle_fontsize_multiplier", 1.0)
        fontsize = int(self.info.display_width * 0.07 * fontsize_multiplier)
        position_y = config.get("subtitle_position_y", 0.80)
        y_pos = int(self.info.display_height * position_y)

        # Colors from config
        sub_color = config.get("subtitle_color", (255, 255, 255))
        fontcolor = f"#{sub_color[0]:02X}{sub_color[1]:02X}{sub_color[2]:02X}"
        outline_hex = config.get("subtitle_outline_color", "#000000")
        bordercolor = outline_hex
        borderw = config.get("subtitle_stroke_width", 4)

        # Background box
        bg_enabled = config.get("subtitle_bg_enabled", False)
        box_params = ""
        if bg_enabled:
            bg_hex = config.get("subtitle_bg_color", "#000000")
            bg_opacity = config.get("subtitle_bg_opacity", 0.6)
            # drawtext box uses 0x format with @opacity
            box_params = f":box=1:boxcolor={bg_hex}@{bg_opacity:.2f}:boxborderw=8"

        filters = []
        words_per_phrase = 5
        valid_subs = [s for s in subtitles if (s.end - s.start) >= 0.1 and s.text.strip()]

        # Gruppiere in Phrasen und erstelle einen Filter pro Phrase
        for i in range(0, len(valid_subs), words_per_phrase):
            phrase_subs = valid_subs[i:i + words_per_phrase]
            if not phrase_subs:
                continue

            words = [s.text.strip() for s in phrase_subs]
            phrase_text = " ".join(words)

            # Sicheres Escaping für FFmpeg drawtext
            # Entferne problematische Zeichen
            phrase_text = phrase_text.replace("'", "")
            phrase_text = phrase_text.replace('"', "")
            phrase_text = phrase_text.replace(":", " ")
            phrase_text = phrase_text.replace("\\", "")
            phrase_text = phrase_text.replace("%", "")

            # Start und Ende der Phrase
            new_start = map_time(phrase_subs[0].start)
            new_end = map_time(phrase_subs[-1].end)

            if new_start is None or new_end is None:
                continue

            # Font from config or platform-specific fallback
            configured_font = config.get("subtitle_font", "")
            if configured_font:
                # Use font by name (FFmpeg supports font name lookup via fontconfig)
                font_param = f"font='{configured_font}'"
            else:
                # Plattform-spezifischer Font file fallback
                if sys.platform == "darwin":
                    fontfile = "/System/Library/Fonts/Helvetica.ttc"
                elif sys.platform == "win32":
                    fontfile = "C\\:/Windows/Fonts/arial.ttf"
                else:
                    fontfile = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
                font_param = f"fontfile={fontfile}"

            # Drawtext Filter
            dt = (f"drawtext=text='{phrase_text}':"
                  f"{font_param}:"
                  f"fontsize={fontsize}:fontcolor={fontcolor}:"
                  f"borderw={borderw}:bordercolor={bordercolor}"
                  f"{box_params}:"
                  f"x=(w-text_w)/2:y={y_pos}:"
                  f"enable='between(t\\,{new_start:.2f}\\,{new_end:.2f})'")
            filters.append(dt)

        # Limitiere Filter (FFmpeg hat Limits)
        if len(filters) > 30:
            filters = filters[:30]

        return filters

    def _add_subtitles_moviepy(self, input_video: str, output_path: str,
                                subtitles: List[Subtitle],
                                segments: List[Tuple[float, float]]) -> None:
        """Fügt Untertitel mit MoviePy hinzu (Clean-Style)."""
        from moviepy.editor import VideoFileClip, CompositeVideoClip
        from .effects import create_clean_phrase_subtitle

        # Berechne Zeit-Mapping (original -> nach cuts)
        offset_map = []
        new_time = 0
        for orig_start, orig_end in segments:
            offset_map.append((orig_start, orig_end, new_time))
            new_time += (orig_end - orig_start)

        def map_time(t: float):
            for orig_start, orig_end, new_start in offset_map:
                if orig_start <= t <= orig_end:
                    mapped = new_start + (t - orig_start)
                    return max(0, mapped)
            return None

        # Video laden
        clip = VideoFileClip(input_video)

        # Untertitel-Config
        subtitle_config = {
            "subtitle_color": (255, 255, 255),
            "subtitle_fontsize_multiplier": 1.0,
            "subtitle_stroke_width": 4,
        }

        # Clean-Style: Gruppiere Wörter in Phrasen
        words_per_phrase = 4
        valid_subs = [s for s in subtitles if (s.end - s.start) >= 0.1 and s.text.strip()]

        all_clips = []
        for i in range(0, len(valid_subs), words_per_phrase):
            phrase_subs = valid_subs[i:i + words_per_phrase]
            words = [s.text.strip() for s in phrase_subs]

            for word_idx, sub in enumerate(phrase_subs):
                new_start = map_time(sub.start)
                new_end = map_time(sub.end)

                if new_start is None or new_end is None:
                    continue

                dur = new_end - new_start
                if dur < 0.1:
                    dur = 0.1

                # Untertitel anzeigen (kleiner Delay für Re-Encoding-Sync)
                display_start = new_start + 0.05

                try:
                    phrase_clip = create_clean_phrase_subtitle(
                        words=words,
                        active_index=word_idx,
                        duration=dur,
                        video_size=clip.size,
                        subtitle_config=subtitle_config
                    )

                    if phrase_clip is not None:
                        phrase_clip = phrase_clip.set_start(display_start)
                        all_clips.append(phrase_clip)
                except Exception as e:
                    pass  # Skip problematic subtitles

        if all_clips:
            final = CompositeVideoClip([clip] + all_clips)
        else:
            final = clip

        # Export mit Hardware-Encoding (hohe Qualität)
        # temp_audiofile explizit setzen — sonst landet die moviepy-Temp-Datei
        # im CWD (= Program Files beim gepackten Build, nicht beschreibbar).
        out_dir = os.path.dirname(os.path.abspath(output_path))
        out_stem = os.path.splitext(os.path.basename(output_path))[0]
        final.write_videofile(
            output_path,
            codec=get_video_codec(),
            audio_codec="aac",
            audio_bitrate="192k",
            bitrate="12M",
            temp_audiofile=os.path.join(out_dir, f"temp-{out_stem}.m4a"),
            remove_temp=True,
            verbose=False,
            logger=None,
            ffmpeg_params=get_codec_params()
        )

        final.close()
        clip.close()

    def _create_ass_subtitles_to_file(self, subtitles: List[Subtitle],
                                       segments: List[Tuple[float, float]],
                                       ass_path: str,
                                       config: dict = None) -> None:
        """Erstellt ASS-Untertiteldatei mit konfigurierbarem Style."""
        if config is None:
            config = {}

        # Berechne Offset-Mapping für Segmente
        # (original_time -> new_time nach Silence-Removal)
        offset_map = []
        new_time = 0
        for orig_start, orig_end in segments:
            offset_map.append((orig_start, orig_end, new_time))
            new_time += (orig_end - orig_start)

        def map_time(t: float) -> Optional[float]:
            """Mappt Original-Zeit auf neue Zeit nach Cuts."""
            for orig_start, orig_end, new_start in offset_map:
                if orig_start <= t <= orig_end:
                    return new_start + (t - orig_start)
            return None

        # ASS Header
        video_width = self.info.display_width
        video_height = self.info.display_height

        # --- Config-driven style parameters ---
        # Font
        font_name = config.get("subtitle_font", "Arial Black")

        # Font size
        fontsize_multiplier = config.get("subtitle_fontsize_multiplier", 1.0)
        fontsize = int(video_height * 0.045 * fontsize_multiplier)

        # Primary color (subtitle_color is RGB tuple)
        sub_color = config.get("subtitle_color", (255, 255, 255))
        primary_colour = _rgb_to_ass_bgr(sub_color[0], sub_color[1], sub_color[2])

        # Outline color
        outline_hex = config.get("subtitle_outline_color", "#000000")
        outline_colour = _hex_to_ass_bgr(outline_hex)

        # Outline width
        outline_width = config.get("subtitle_stroke_width", 3)

        # Position / Alignment
        position = config.get("subtitle_position", "bottom")
        alignment = _position_to_ass_alignment(position)

        # MarginV from subtitle_position_y (fraction of video height)
        position_y = config.get("subtitle_position_y", 0.85)
        # For bottom alignment, MarginV is distance from bottom edge
        # For top alignment, MarginV is distance from top edge
        if position == "top":
            margin_v = int(video_height * position_y)
        elif position == "center":
            # For center, MarginV has less effect; use a small value
            margin_v = 0
        else:
            # bottom: margin from bottom = (1 - position_y) * height
            margin_v = int(video_height * (1.0 - position_y))

        # Background / border style
        bg_enabled = config.get("subtitle_bg_enabled", False)
        if bg_enabled:
            border_style = 3  # Opaque box
            bg_hex = config.get("subtitle_bg_color", "#000000")
            bg_opacity = config.get("subtitle_bg_opacity", 0.6)
            # ASS alpha: 00=opaque, FF=transparent; invert from opacity
            bg_alpha = int((1.0 - bg_opacity) * 255)
            back_colour = _hex_to_ass_bgr(bg_hex, alpha=bg_alpha)
        else:
            border_style = 1  # Outline + shadow
            back_colour = "&H80000000"

        # Highlight color for active word
        highlight_hex = config.get("subtitle_highlight_color_hex", None)

        # Secondary colour (used for karaoke in some renderers)
        secondary_colour = "&H000000FF"

        ass_content = f"""[Script Info]
Title: Video Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font_name},{fontsize},{primary_colour},{secondary_colour},{outline_colour},{back_colour},1,0,0,0,100,100,0,0,{border_style},{outline_width},0,{alignment},10,10,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

        # Prepare active/inactive word colors for inline overrides
        # Active word: primary color (or highlight color if set)
        if highlight_hex:
            active_color_ass = _hex_to_ass_bgr(highlight_hex)
        else:
            active_color_ass = primary_colour

        # Inactive words: grey
        inactive_color_ass = "&H00808080"

        # Clean-Style: Gruppiere Wörter in Phrasen
        words_per_phrase = 4
        valid_subs = [s for s in subtitles if (s.end - s.start) >= 0.1 and s.text.strip()]

        for i in range(0, len(valid_subs), words_per_phrase):
            phrase_subs = valid_subs[i:i + words_per_phrase]
            words = [s.text.strip() for s in phrase_subs]

            for word_idx, sub in enumerate(phrase_subs):
                new_start = map_time(sub.start)
                new_end = map_time(sub.end)

                if new_start is None or new_end is None:
                    continue

                # Whisper-Korrektur: Wörter werden etwas früher erkannt
                subtitle_delay = 0.08  # 80ms später anzeigen
                new_start = max(0, new_start + subtitle_delay)
                new_end = new_end + subtitle_delay

                # Format time as H:MM:SS.CC
                def format_ass_time(t):
                    h = int(t // 3600)
                    m = int((t % 3600) // 60)
                    s = t % 60
                    return f"{h}:{m:02d}:{s:05.2f}"

                start_str = format_ass_time(new_start)
                end_str = format_ass_time(new_end)

                # Baue Text mit aktivem Wort hervorgehoben
                text_parts = []
                for j, word in enumerate(words):
                    if j == word_idx:
                        # Aktives Wort - highlight color (or primary)
                        text_parts.append(f"{{\\c{active_color_ass}}}{word}")
                    else:
                        # Inaktives Wort - grau
                        text_parts.append(f"{{\\c{inactive_color_ass}}}{word}")

                text = " ".join(text_parts)
                ass_content += f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{text}\n"

        # Schreibe ASS-Datei
        with open(ass_path, 'w', encoding='utf-8') as f:
            f.write(ass_content)

    def edit_fast(self, style: str = "clean",
                  remove_silence: bool = True,
                  add_subtitles: bool = True,
                  smart_cut: bool = False,
                  remove_fillers: bool = False,
                  filler_sensitivity: str = "medium",
                  **kwargs) -> str:
        """
        Schnelle Video-Bearbeitung mit FFmpeg.

        Args:
            style: Stil (aktuell nur "clean" unterstützt)
            remove_silence: Stille entfernen
            add_subtitles: Untertitel hinzufügen
            smart_cut: Intelligente Schnitte an Satz-/Klauselgrenzen
            remove_fillers: Filler-Wörter (um, uh, like...) entfernen
            filler_sensitivity: Empfindlichkeit für Filler-Erkennung (low, medium, high)

        Returns:
            Pfad zum Output-Video
        """
        # Allow kwargs/config overrides for remove_fillers and filler_sensitivity
        remove_fillers = kwargs.get('remove_fillers', remove_fillers)
        filler_sensitivity = kwargs.get('filler_sensitivity', filler_sensitivity)

        # Load style config for subtitle customization
        try:
            from .styles import get_style
            style_config = get_style(style)
        except (ImportError, ValueError):
            style_config = {}
        # Allow kwargs to override style config
        style_config.update({k: v for k, v in kwargs.items() if k.startswith("subtitle_")})

        self._check_cancel()
        self._report(f"FAST EDITOR - FFmpeg Direct")
        self._report(f"  {self.info.display_width}x{self.info.display_height} @ {self.info.fps:.0f}fps")

        # Subtitles holen
        subtitles = []
        if add_subtitles:
            subtitles = self._get_subtitles()

        # Silence Detection
        if remove_silence:
            segments = self._detect_silence(smart_cut=smart_cut,
                                            remove_fillers=remove_fillers,
                                            filler_sensitivity=filler_sensitivity)
        else:
            segments = [(0, self.info.duration)]

        # Temporäres Verzeichnis
        temp_dir = tempfile.mkdtemp(prefix="fast_edit_")

        self._check_cancel()
        self._report("Schneide und fuege zusammen...", step=3, total_steps=4)

        # Erstelle Segment-Clips mit FFmpeg (präzises Cutting mit Re-Encoding)
        segment_files = []
        for i, (start, end) in enumerate(segments):
            segment_path = os.path.join(temp_dir, f"seg_{i:04d}.mp4")
            duration = end - start

            # FFmpeg Segment extrahieren - PRÄZISE:
            # -ss NACH -i = frame-genaues Seeking (langsamer aber exakt)
            # Re-encode für präzise Cuts (nicht nur an Keyframes)
            cmd = [
                get_ffmpeg_path(), '-y',
                '-i', str(self.input_path),
                '-ss', str(start),
                '-t', str(duration),
                '-c:v', get_video_codec(),
                '-b:v', '12M',
                ] + get_codec_params() + [
                '-c:a', 'aac', '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                segment_path
            ]
            subprocess.run(cmd, capture_output=True, **get_subprocess_kwargs())
            segment_files.append(segment_path)
            self._check_cancel()
            seg_progress = (i + 1) / len(segments) * 0.5 + 0.5  # 50-100%
            self._report(f"  Segment {i+1}/{len(segments)}: {start:.1f}s - {end:.1f}s", step=3, total_steps=4, progress=seg_progress)

        # Concat-Liste erstellen
        concat_list = os.path.join(temp_dir, "concat.txt")
        with open(concat_list, 'w') as f:
            for seg_file in segment_files:
                f.write(f"file '{seg_file}'\n")

        # Zusammenfügen ohne Re-Encoding
        concat_output = os.path.join(temp_dir, "concat.mp4")
        cmd = [
            get_ffmpeg_path(), '-y',
            '-f', 'concat', '-safe', '0',
            '-i', concat_list,
            '-c', 'copy',
            concat_output
        ]
        subprocess.run(cmd, capture_output=True, **get_subprocess_kwargs())

        self._check_cancel()
        self._report("Finalisiere...", step=4, total_steps=4)

        # Output-Pfad
        out_path = self.output_dir / f"{self.input_path.stem}_{style}_fast.mp4"

        # Drawtext-Filter für Untertitel erstellen
        drawtext_filters = []
        if subtitles:
            drawtext_filters = self._create_drawtext_filters(subtitles, segments, config=style_config)
            self._report(f"  {len(drawtext_filters)} Untertitel")

        # Rotation-Filter - KEINE manuelle Rotation, FFmpeg macht das automatisch
        # Wir entfernen -noautorotate und lassen FFmpeg die Metadaten verwenden
        rotation_filter = ""
        # Keine manuelle Rotation mehr - FFmpeg autorotate macht das

        # Kombiniere Filter: Rotation + Untertitel in EINEM Pass
        all_filters = []
        if rotation_filter:
            all_filters.append(rotation_filter)
        all_filters.extend(drawtext_filters)

        # Frame-genaues Rendering mit FFmpeg + ASS-Untertitel
        if subtitles:
            # ASS-Datei erstellen
            ass_path = os.path.join(temp_dir, "subtitles.ass")
            self._create_ass_subtitles_to_file(subtitles, segments, ass_path, config=style_config)
            self._report(f"  {len(subtitles)} Untertitel")

            # FFmpeg: Rotation + Untertitel in EINEM Pass (frame-genau)
            # ass Filter escaped den Pfad für Windows/Mac Kompatibilität
            ass_path_escaped = ass_path.replace(':', '\\:').replace("'", "\\'")

            cmd = [
                get_ffmpeg_path(), '-y',
                '-i', concat_output,
                '-vf', f"ass='{ass_path_escaped}'",
                '-c:v', get_video_codec(),
                '-b:v', '12M',
                ] + get_codec_params() + [
                '-c:a', 'aac', '-b:a', '192k',
                str(out_path)
            ]
            self._report("  Untertitel brennen...")
            result = subprocess.run(cmd, capture_output=True, text=True, **get_subprocess_kwargs())
            if result.returncode != 0:
                self._report(f"  FFmpeg Fehler: {result.stderr}")
        else:
            # Ohne Untertitel: nur Rotation
            cmd = [
                get_ffmpeg_path(), '-y',
                '-i', concat_output,
                '-c:v', get_video_codec(),
                '-b:v', '12M',
                ] + get_codec_params() + [
                '-c:a', 'aac', '-b:a', '192k',
                str(out_path)
            ]
            self._report("  Finalisiere...")
            subprocess.run(cmd, capture_output=True, **get_subprocess_kwargs())

        # Cleanup
        import shutil
        try:
            shutil.rmtree(temp_dir)
        except:
            pass

        # Statistik
        if out_path.exists():
            final_size = out_path.stat().st_size / (1024 * 1024)
            final_duration = sum(e - s for s, e in segments)
            reduction = (1 - final_duration / self.info.duration) * 100

            self._report(f"Fertig! {self.info.duration:.1f}s -> {final_duration:.1f}s ({reduction:.0f}% kuerzer)", step=4, total_steps=4, progress=1.0)
            self._report(f"  Dateigroesse: {final_size:.1f} MB")
            self._report(f"  Output: {out_path}")

        return str(out_path)


def main():
    """CLI für schnelle Video-Bearbeitung."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python -m src.fast_editor <video_path>")
        sys.exit(1)

    video_path = sys.argv[1]
    editor = FastVideoEditor(video_path)
    editor.edit_fast()


if __name__ == "__main__":
    main()
