"""
Fast Video Editor - FFmpeg-basiert für maximale Geschwindigkeit

Nutzt FFmpeg direkt statt MoviePy für:
- Korrekte Rotation/Seitenverhältnis
- Schnitte ohne Re-Encoding
- Hardware-Encoding (VideoToolbox)
- Untertitel mit ASS-Filter
"""

import os
import subprocess
import json
import tempfile
from pathlib import Path
from dataclasses import dataclass
from typing import List, Tuple, Optional

from .audio import AudioAnalyzer, Subtitle
from .ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path
from .platform_utils import get_video_codec, get_codec_params


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
        result = subprocess.run(cmd, capture_output=True, text=True)
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
                        min_silence: float = 0.6) -> List[Tuple[float, float]]:
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

        removed = self.info.duration - sum(e - s for s, e in final)
        self._report(f"  {len(final)} Segmente, {removed:.1f}s Stille entfernt")
        return final

    def _create_drawtext_filters(self, subtitles: List[Subtitle],
                                   segments: List[Tuple[float, float]]) -> List[str]:
        """Erstellt FFmpeg drawtext Filter für Untertitel."""

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

        # Fontgröße und Position (für 9:16 Video)
        fontsize = int(self.info.display_width * 0.07)  # Basierend auf Breite für 9:16
        y_pos = int(self.info.display_height * 0.80)

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

            # Drawtext Filter - einfach gehalten
            dt = (f"drawtext=text='{phrase_text}':"
                  f"fontfile=/System/Library/Fonts/Helvetica.ttc:"
                  f"fontsize={fontsize}:fontcolor=white:"
                  f"borderw=4:bordercolor=black:"
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
        final.write_videofile(
            output_path,
            codec=get_video_codec(),
            audio_codec="aac",
            audio_bitrate="192k",
            bitrate="12M",
            verbose=False,
            logger=None,
            ffmpeg_params=get_codec_params()
        )

        final.close()
        clip.close()

    def _create_ass_subtitles_to_file(self, subtitles: List[Subtitle],
                                       segments: List[Tuple[float, float]],
                                       ass_path: str) -> None:
        """Erstellt ASS-Untertiteldatei mit Clean-Style."""

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

        # Fontgröße basierend auf Video-Höhe
        fontsize = int(video_height * 0.045)

        ass_content = f"""[Script Info]
Title: Video Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,{fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,10,10,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

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
                        # Aktives Wort - weiß
                        text_parts.append(f"{{\\c&HFFFFFF&}}{word}")
                    else:
                        # Inaktives Wort - grau
                        text_parts.append(f"{{\\c&H808080&}}{word}")

                text = " ".join(text_parts)
                ass_content += f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{text}\n"

        # Schreibe ASS-Datei
        with open(ass_path, 'w', encoding='utf-8') as f:
            f.write(ass_content)

    def edit_fast(self, style: str = "clean",
                  remove_silence: bool = True,
                  add_subtitles: bool = True) -> str:
        """
        Schnelle Video-Bearbeitung mit FFmpeg.

        Args:
            style: Stil (aktuell nur "clean" unterstützt)
            remove_silence: Stille entfernen
            add_subtitles: Untertitel hinzufügen

        Returns:
            Pfad zum Output-Video
        """
        self._check_cancel()
        self._report(f"FAST EDITOR - FFmpeg Direct")
        self._report(f"  {self.info.display_width}x{self.info.display_height} @ {self.info.fps:.0f}fps")

        # Subtitles holen
        subtitles = []
        if add_subtitles:
            subtitles = self._get_subtitles()

        # Silence Detection
        if remove_silence:
            segments = self._detect_silence()
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
            subprocess.run(cmd, capture_output=True)
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
        subprocess.run(cmd, capture_output=True)

        self._check_cancel()
        self._report("Finalisiere...", step=4, total_steps=4)

        # Output-Pfad
        out_path = self.output_dir / f"{self.input_path.stem}_{style}_fast.mp4"

        # Drawtext-Filter für Untertitel erstellen
        drawtext_filters = []
        if subtitles:
            drawtext_filters = self._create_drawtext_filters(subtitles, segments)
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
            self._create_ass_subtitles_to_file(subtitles, segments, ass_path)
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
            result = subprocess.run(cmd, capture_output=True, text=True)
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
            subprocess.run(cmd, capture_output=True)

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
