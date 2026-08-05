"""
Audio-Analyse v2.0: Speech-to-Text, Stille-Erkennung und Beat Detection.

Features:
- Whisper Transkription für Untertitel
- Stille-Erkennung für automatische Cuts
- Beat Detection für Musik-Sync
- Audio-Waveform Extraktion
"""

import os
import tempfile
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

import numpy as np
from faster_whisper import WhisperModel
from moviepy.editor import VideoFileClip, AudioFileClip
from scipy.io import wavfile
from scipy import signal


@dataclass
class Subtitle:
    """Ein Untertitel-Segment."""
    start: float
    end: float
    text: str


@dataclass
class SpeechSegment:
    """Ein Sprach-Segment (wo jemand spricht)."""
    start: float
    end: float
    has_speech: bool


@dataclass
class Beat:
    """Ein erkannter Beat."""
    time: float
    strength: float  # 0-1, wie stark der Beat ist


class AudioAnalyzer:
    """Analysiert Audio für Schnitte, Untertitel und Beat-Sync."""

    def __init__(self, video_path: str, whisper_model: str = "medium",
                 progress_callback=None):
        """
        Args:
            video_path: Pfad zum Video
            whisper_model: Whisper Modell (tiny, base, small, medium, large) - Standard: medium
            progress_callback: Optional callback(message, step, total_steps, progress)
        """
        self.video_path = Path(video_path)
        self.whisper_model_name = whisper_model
        self.progress_callback = progress_callback
        self._whisper_model = None
        self._transcription = None
        self._subtitles = []
        self._speech_segments = []
        self._beats = []
        self._audio_data = None
        self._sample_rate = None
        self._filler_words = None

    def _report(self, message, step=None, total_steps=None, progress=None):
        """Gibt Status aus und ruft optional den Callback auf."""
        print(message)
        if self.progress_callback:
            self.progress_callback(message, step, total_steps, progress)

    @property
    def whisper_model(self):
        """Lazy-Loading des Whisper Modells (faster-whisper)."""
        if self._whisper_model is None:
            self._report(f"Lade Whisper Modell '{self.whisper_model_name}'...")
            self._whisper_model = WhisperModel(
                self.whisper_model_name,
                device="auto",
                compute_type="int8",
            )
        return self._whisper_model

    def extract_audio(self, target_sr: int = 16000) -> str:
        """Extrahiert Audio aus dem Video als temporäre WAV-Datei."""
        temp_audio = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        temp_path = temp_audio.name
        temp_audio.close()

        self._report("Extrahiere Audio aus Video...")
        video = VideoFileClip(str(self.video_path))
        video.audio.write_audiofile(temp_path, fps=target_sr, verbose=False, logger=None)
        video.close()

        return temp_path

    def get_audio_data(self) -> tuple:
        """
        Lädt Audio-Daten für Analyse.

        Returns:
            (sample_rate, audio_data als numpy array)
        """
        if self._audio_data is not None:
            return self._sample_rate, self._audio_data

        audio_path = self.extract_audio(target_sr=44100)

        try:
            self._sample_rate, audio_data = wavfile.read(audio_path)

            # Stereo zu Mono
            if len(audio_data.shape) > 1:
                audio_data = audio_data.mean(axis=1)

            # Normalisieren auf -1 bis 1
            self._audio_data = audio_data.astype(float) / np.max(np.abs(audio_data))

        finally:
            if os.path.exists(audio_path):
                os.unlink(audio_path)

        return self._sample_rate, self._audio_data

    def transcribe(self) -> list[Subtitle]:
        """
        Transkribiert das Audio und erstellt Untertitel.

        Returns:
            Liste von Subtitle-Objekten
        """
        if self._subtitles:
            return self._subtitles

        audio_path = self.extract_audio()

        try:
            self._report("Transkribiere Audio mit Whisper...")
            segments_iter, info = self.whisper_model.transcribe(
                audio_path,
                language=None,  # Automatische Spracherkennung
                task="transcribe",
                word_timestamps=True,  # Wort-genaue Timestamps
                # condition_on_previous_text OFF: with it ON, Whisper
                # biases short standalone segments (wake commands after
                # a pause) toward the surrounding sentence context and
                # drops the command. Voice triggers were dying here.
                condition_on_previous_text=False,
                # no_speech_threshold near-max: at 0.6 Whisper would
                # DISCARD entire 30s segments if the majority looked
                # like silence — which nuked isolated 'Cleo cut'
                # commands surrounded by pauses. 0.98 means only
                # truly-silent-full-segment gets skipped.
                no_speech_threshold=0.98,
                initial_prompt=(
                    # Force-recognise the wake word so 'Cleo cut' / 'Cleo go'
                    # get transcribed reliably instead of Whisper guessing
                    # 'Clio', 'Kleo', 'clear cut', etc. Filler words also
                    # included so faster-whisper doesn't skip them.
                    "Cleo cut. Cleo go. Cleo cut. Cleo go. "
                    "ähm, äh, hmm, um, uh, like, you know, also, halt"
                ),
            )

            # Build openai-whisper-compatible dict so downstream code
            # (filler_detection, subtitle generation) keeps working unchanged.
            # Emit throttled live progress as faster-whisper yields segments.
            segments_list = []
            text_parts = []
            total_duration = info.duration if info.duration else 0.0
            last_report_t = 0.0
            for seg in segments_iter:
                seg_dict = {
                    "id": seg.id,
                    "seek": seg.seek,
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": seg.text,
                    "tokens": list(seg.tokens) if seg.tokens else [],
                    "avg_logprob": float(seg.avg_logprob),
                    "compression_ratio": float(seg.compression_ratio),
                    "no_speech_prob": float(seg.no_speech_prob),
                    "words": [
                        {
                            "word": w.word,
                            "start": float(w.start),
                            "end": float(w.end),
                            "probability": float(w.probability),
                        }
                        for w in (seg.words or [])
                    ],
                }
                segments_list.append(seg_dict)
                text_parts.append(seg.text)

                # Throttle at ~300 ms so the GUI's batched word ticker
                # gets enough new text to keep animating without flooding.
                if total_duration > 0:
                    import time as _t
                    now = _t.monotonic()
                    if now - last_report_t > 0.3:
                        last_report_t = now
                        prog = min(0.99, seg.end / total_duration)
                        latest = (seg.text or "").strip()
                        if latest:
                            self._report(
                                f"Transcribing speech: {latest}",
                                step=1, total_steps=6, progress=prog,
                            )

            result = {
                "text": "".join(text_parts),
                "segments": segments_list,
                "language": info.language,
            }
            self._transcription = result

            # Wort-für-Wort Untertitel (TikTok-Style)
            # Max 1-2 Wörter pro Untertitel
            for segment in result.get("segments", []):
                words = segment.get("words", [])

                if words:
                    i = 0
                    while i < len(words):
                        word1 = words[i]
                        text1 = word1.get("word", "").strip()

                        # Kurze Wörter (<=3 Zeichen) mit nächstem kombinieren
                        if len(text1) <= 3 and i + 1 < len(words):
                            word2 = words[i + 1]
                            text2 = word2.get("word", "").strip()
                            combined = f"{text1} {text2}".strip()

                            subtitle = Subtitle(
                                start=word1.get("start", segment["start"]),
                                end=word2.get("end", segment["end"]),
                                text=combined
                            )
                            self._subtitles.append(subtitle)
                            i += 2
                        else:
                            # Einzelnes Wort
                            if text1:
                                subtitle = Subtitle(
                                    start=word1.get("start", segment["start"]),
                                    end=word1.get("end", segment["end"]),
                                    text=text1
                                )
                                self._subtitles.append(subtitle)
                            i += 1
                else:
                    # Fallback: Wörter manuell splitten
                    words_list = segment["text"].strip().split()
                    dur = segment["end"] - segment["start"]
                    word_dur = dur / max(len(words_list), 1)

                    for j, word in enumerate(words_list):
                        subtitle = Subtitle(
                            start=segment["start"] + j * word_dur,
                            end=segment["start"] + (j + 1) * word_dur,
                            text=word.strip()
                        )
                        self._subtitles.append(subtitle)

            self._report(f"  {len(self._subtitles)} Untertitel-Segmente erstellt")

        finally:
            if os.path.exists(audio_path):
                os.unlink(audio_path)

        return self._subtitles

    def get_filler_words(self, sensitivity="medium"):
        """Returns detected filler words from transcription."""
        if not hasattr(self, '_filler_words') or self._filler_words is None:
            self.transcribe()  # ensure transcription exists
            from .filler_detection import FillerDetector
            detector = FillerDetector(
                language=self._transcription.get("language", "en"),
                sensitivity=sensitivity
            )
            self._filler_words = detector.detect_fillers(self._transcription)
        return self._filler_words

    def detect_silence(self, silence_threshold: float = 0.02,
                       min_silence_duration: float = 0.5) -> list[SpeechSegment]:
        """
        Erkennt Stille-Abschnitte im Audio.

        Args:
            silence_threshold: Amplitude-Schwellwert für Stille (0-1)
            min_silence_duration: Minimale Dauer für Stille in Sekunden

        Returns:
            Liste von SpeechSegment-Objekten
        """
        if self._speech_segments:
            return self._speech_segments

        sample_rate, audio_data = self.get_audio_data()

        self._report("Analysiere Audio fuer Stille-Erkennung...")

        # Fenster-Größe für Analyse (100ms)
        window_size = int(sample_rate * 0.1)
        hop_size = window_size // 2

        segments = []
        current_is_speech = None
        segment_start = 0

        for i in range(0, len(audio_data) - window_size, hop_size):
            window = audio_data[i:i + window_size]
            rms = np.sqrt(np.mean(window ** 2))
            is_speech = rms > silence_threshold

            time = i / sample_rate

            if current_is_speech is None:
                current_is_speech = is_speech
                segment_start = time
            elif is_speech != current_is_speech:
                if time - segment_start >= min_silence_duration or current_is_speech:
                    segments.append(SpeechSegment(
                        start=segment_start,
                        end=time,
                        has_speech=current_is_speech
                    ))
                segment_start = time
                current_is_speech = is_speech

        # Letztes Segment
        total_duration = len(audio_data) / sample_rate
        if segment_start < total_duration:
            segments.append(SpeechSegment(
                start=segment_start,
                end=total_duration,
                has_speech=current_is_speech
            ))

        self._speech_segments = segments
        speech_count = sum(1 for s in segments if s.has_speech)
        silence_count = len(segments) - speech_count
        self._report(f"  {speech_count} Sprach-Segmente, {silence_count} Stille-Segmente gefunden")

        return self._speech_segments

    # =========================================================================
    # BEAT DETECTION
    # =========================================================================

    def detect_beats(self, sensitivity: float = 1.0) -> list[Beat]:
        """
        Erkennt Beats/Rhythmus im Audio.

        Args:
            sensitivity: Empfindlichkeit (0.5 = weniger Beats, 2.0 = mehr Beats)

        Returns:
            Liste von Beat-Objekten mit Zeitpunkten
        """
        if self._beats:
            return self._beats

        self._report("Analysiere Beats...")
        sample_rate, audio_data = self.get_audio_data()

        # Onset Detection mit Energie-Differenz
        # Fenster-Größe für Energie-Berechnung
        hop_length = int(sample_rate * 0.01)  # 10ms
        frame_length = int(sample_rate * 0.025)  # 25ms

        # Berechne Energie pro Frame
        energies = []
        for i in range(0, len(audio_data) - frame_length, hop_length):
            frame = audio_data[i:i + frame_length]
            energy = np.sum(frame ** 2)
            energies.append(energy)

        energies = np.array(energies)

        # Normalisieren
        if np.max(energies) > 0:
            energies = energies / np.max(energies)

        # Spektrale Flux für bessere Beat-Erkennung
        # Berechne Differenz zwischen aufeinanderfolgenden Frames
        flux = np.zeros(len(energies))
        flux[1:] = np.maximum(0, energies[1:] - energies[:-1])

        # Finde Peaks (Beats)
        # Dynamischer Threshold basierend auf lokalem Mittelwert
        window_size = int(0.5 * sample_rate / hop_length)  # 500ms Fenster
        threshold_mult = 1.5 / sensitivity

        beats = []
        for i in range(window_size, len(flux) - window_size):
            local_mean = np.mean(flux[i - window_size:i + window_size])
            threshold = local_mean * threshold_mult

            # Ist es ein lokales Maximum und über dem Threshold?
            if flux[i] > threshold and flux[i] == np.max(flux[max(0, i-3):i+4]):
                time = i * hop_length / sample_rate
                strength = min(1.0, flux[i] / (local_mean + 0.001))
                beats.append(Beat(time=time, strength=strength))

        # Filtere zu nahe beieinander liegende Beats (min 0.1s Abstand)
        filtered_beats = []
        last_beat_time = -1
        for beat in beats:
            if beat.time - last_beat_time >= 0.1:
                filtered_beats.append(beat)
                last_beat_time = beat.time

        self._beats = filtered_beats
        self._report(f"  {len(self._beats)} Beats erkannt")

        return self._beats

    def detect_beats_librosa(self) -> list[Beat]:
        """
        Beat Detection mit librosa (falls installiert).
        Genauere Ergebnisse für Musik.
        """
        try:
            import librosa

            self._report("Analysiere Beats mit librosa...")
            audio_path = self.extract_audio(target_sr=22050)

            try:
                y, sr = librosa.load(audio_path, sr=22050)

                # Beat tracking
                tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
                beat_times = librosa.frames_to_time(beat_frames, sr=sr)

                # Onset strength für Beat-Stärke
                onset_env = librosa.onset.onset_strength(y=y, sr=sr)

                beats = []
                for i, t in enumerate(beat_times):
                    frame = beat_frames[i] if i < len(beat_frames) else 0
                    strength = onset_env[frame] / np.max(onset_env) if frame < len(onset_env) else 0.5
                    beats.append(Beat(time=float(t), strength=float(strength)))

                self._beats = beats
                self._report(f"  {len(beats)} Beats erkannt (Tempo: {tempo:.0f} BPM)")

                return beats

            finally:
                if os.path.exists(audio_path):
                    os.unlink(audio_path)

        except ImportError:
            self._report("  librosa nicht installiert, nutze einfache Beat-Erkennung")
            return self.detect_beats()

    def get_beat_times(self, min_strength: float = 0.3) -> list[float]:
        """
        Gibt nur die Zeitpunkte der Beats zurück.

        Args:
            min_strength: Minimale Stärke für Beats (0-1)

        Returns:
            Liste von Zeitpunkten in Sekunden
        """
        beats = self.detect_beats()
        return [b.time for b in beats if b.strength >= min_strength]

    def get_strong_beats(self, top_percent: float = 0.3) -> list[float]:
        """
        Gibt die stärksten Beats zurück.

        Args:
            top_percent: Oberstes X Prozent der Beats (0.3 = Top 30%)

        Returns:
            Liste von Zeitpunkten
        """
        beats = self.detect_beats()
        if not beats:
            return []

        # Sortiere nach Stärke
        sorted_beats = sorted(beats, key=lambda b: b.strength, reverse=True)
        count = max(1, int(len(sorted_beats) * top_percent))

        # Nehme die stärksten und sortiere nach Zeit
        strong = sorted_beats[:count]
        strong.sort(key=lambda b: b.time)

        return [b.time for b in strong]

    # =========================================================================
    # WAVEFORM
    # =========================================================================

    def get_waveform(self, num_points: int = 1000) -> np.ndarray:
        """
        Gibt eine vereinfachte Waveform zurück.

        Args:
            num_points: Anzahl der Datenpunkte

        Returns:
            Numpy array mit Amplituden-Werten (0-1)
        """
        sample_rate, audio_data = self.get_audio_data()

        # Downsampling
        samples_per_point = len(audio_data) // num_points
        waveform = np.zeros(num_points)

        for i in range(num_points):
            start = i * samples_per_point
            end = min(start + samples_per_point, len(audio_data))
            chunk = audio_data[start:end]
            waveform[i] = np.sqrt(np.mean(chunk ** 2))  # RMS

        # Normalisieren
        if np.max(waveform) > 0:
            waveform = waveform / np.max(waveform)

        return waveform

    def get_energy_envelope(self, window_ms: float = 50) -> tuple:
        """
        Berechnet die Energie-Hüllkurve des Audios.

        Args:
            window_ms: Fenster-Größe in Millisekunden

        Returns:
            (times, energies) - Arrays mit Zeitpunkten und Energie-Werten
        """
        sample_rate, audio_data = self.get_audio_data()

        window_size = int(sample_rate * window_ms / 1000)
        hop_size = window_size // 2

        times = []
        energies = []

        for i in range(0, len(audio_data) - window_size, hop_size):
            window = audio_data[i:i + window_size]
            energy = np.sqrt(np.mean(window ** 2))
            time = i / sample_rate
            times.append(time)
            energies.append(energy)

        return np.array(times), np.array(energies)

    # =========================================================================
    # HIGHLIGHT DETECTION
    # =========================================================================

    def detect_highlights(self, min_duration: float = 2.0,
                          energy_threshold: float = 0.7) -> list[tuple[float, float]]:
        """
        Findet Highlight-Momente (laute/energiereiche Stellen).

        Args:
            min_duration: Minimale Dauer eines Highlights in Sekunden
            energy_threshold: Energie-Schwellwert (0-1)

        Returns:
            Liste von (start, end) Tuples
        """
        times, energies = self.get_energy_envelope()

        # Normalisieren
        if np.max(energies) > 0:
            energies = energies / np.max(energies)

        highlights = []
        in_highlight = False
        highlight_start = 0

        for i, (t, e) in enumerate(zip(times, energies)):
            if e >= energy_threshold and not in_highlight:
                in_highlight = True
                highlight_start = t
            elif e < energy_threshold * 0.8 and in_highlight:  # Hysterese
                if t - highlight_start >= min_duration:
                    highlights.append((highlight_start, t))
                in_highlight = False

        # Falls am Ende noch in Highlight
        if in_highlight and times[-1] - highlight_start >= min_duration:
            highlights.append((highlight_start, times[-1]))

        return highlights

    # =========================================================================
    # HELPER FUNKTIONEN
    # =========================================================================

    def get_interesting_segments(self, min_duration: float = 1.0) -> list[tuple[float, float]]:
        """
        Gibt die interessanten (nicht-stillen) Segmente zurück.

        Args:
            min_duration: Minimale Segment-Dauer

        Returns:
            Liste von (start, end) Tuples
        """
        segments = self.detect_silence()

        interesting = []
        for seg in segments:
            if seg.has_speech and (seg.end - seg.start) >= min_duration:
                interesting.append((seg.start, seg.end))

        # Segmente zusammenführen die nah beieinander liegen
        if not interesting:
            return interesting

        merged = [interesting[0]]
        for start, end in interesting[1:]:
            last_start, last_end = merged[-1]
            if start - last_end < 0.5:
                merged[-1] = (last_start, end)
            else:
                merged.append((start, end))

        return merged

    def get_subtitles_for_timerange(self, start: float, end: float) -> list[Subtitle]:
        """Gibt Untertitel für einen bestimmten Zeitbereich zurück."""
        if not self._subtitles:
            self.transcribe()

        return [
            sub for sub in self._subtitles
            if sub.start >= start and sub.end <= end
        ]

    def get_duration(self) -> float:
        """Gibt die Audio-Dauer in Sekunden zurück."""
        sample_rate, audio_data = self.get_audio_data()
        return len(audio_data) / sample_rate


# =============================================================================
# BEAT-SYNC HELPER
# =============================================================================

def sync_cuts_to_beats(segments: list[tuple[float, float]],
                       beat_times: list[float],
                       tolerance: float = 0.2) -> list[tuple[float, float]]:
    """
    Passt Segment-Grenzen an die nächsten Beats an.

    Args:
        segments: Liste von (start, end) Tuples
        beat_times: Liste von Beat-Zeitpunkten
        tolerance: Maximale Anpassung in Sekunden

    Returns:
        Angepasste Segmente
    """
    if not beat_times:
        return segments

    def nearest_beat(t):
        """Findet den nächsten Beat zu einem Zeitpunkt."""
        nearest = min(beat_times, key=lambda b: abs(b - t))
        if abs(nearest - t) <= tolerance:
            return nearest
        return t

    adjusted = []
    for start, end in segments:
        new_start = nearest_beat(start)
        new_end = nearest_beat(end)

        # Sicherstellen dass start < end
        if new_start >= new_end:
            new_start = start
            new_end = end

        adjusted.append((new_start, new_end))

    return adjusted


def get_beat_synced_cuts(duration: float, beat_times: list[float],
                         min_segment: float = 2.0, max_segment: float = 8.0) -> list[float]:
    """
    Generiert Cut-Zeitpunkte basierend auf Beats.

    Args:
        duration: Video-Dauer
        beat_times: Beat-Zeitpunkte
        min_segment: Minimale Segment-Länge
        max_segment: Maximale Segment-Länge

    Returns:
        Liste von Cut-Zeitpunkten
    """
    if not beat_times:
        return []

    cuts = []
    last_cut = 0

    for beat in beat_times:
        time_since_cut = beat - last_cut

        if time_since_cut >= min_segment:
            if time_since_cut >= max_segment:
                # Zu lang, schneide beim nächsten Beat
                cuts.append(beat)
                last_cut = beat
            elif time_since_cut >= min_segment * 1.5:
                # Gute Länge, probabilistisch schneiden
                if np.random.random() > 0.5:
                    cuts.append(beat)
                    last_cut = beat

    return cuts


@dataclass
class BassDropEvent:
    """Ein Bass-Drop Event."""
    time: float
    intensity: float  # 0-1


@dataclass
class LoudnessEvent:
    """Ein Lautstärke-Event (plötzlich laut/leise)."""
    time: float
    type: str  # "loud", "quiet", "spike"
    intensity: float


class AdvancedAudioAnalyzer(AudioAnalyzer):
    """Erweiterte Audio-Analyse mit Bass-Drop und Lautstärke-Erkennung."""

    def __init__(self, video_path: str, whisper_model: str = "medium",
                 progress_callback=None):
        super().__init__(video_path, whisper_model, progress_callback)
        self._bass_drops = []
        self._loudness_events = []
        self._low_freq_energy = None
        self._high_freq_energy = None

    def _compute_frequency_bands(self):
        """Berechnet Energie in verschiedenen Frequenzbändern."""
        if self._low_freq_energy is not None:
            return

        sample_rate, audio_data = self.get_audio_data()

        # Fenster-Parameter
        window_size = int(sample_rate * 0.05)  # 50ms
        hop_size = window_size // 2

        low_energies = []
        high_energies = []
        times = []

        for i in range(0, len(audio_data) - window_size, hop_size):
            window = audio_data[i:i + window_size]
            time = i / sample_rate

            # FFT
            fft = np.fft.rfft(window)
            freqs = np.fft.rfftfreq(len(window), 1/sample_rate)

            # Frequenzbänder
            # Bass: 20-150 Hz
            bass_mask = (freqs >= 20) & (freqs <= 150)
            bass_energy = np.sum(np.abs(fft[bass_mask]) ** 2)

            # Mid-High: 1000-8000 Hz
            high_mask = (freqs >= 1000) & (freqs <= 8000)
            high_energy = np.sum(np.abs(fft[high_mask]) ** 2)

            low_energies.append(bass_energy)
            high_energies.append(high_energy)
            times.append(time)

        self._low_freq_energy = np.array(low_energies)
        self._high_freq_energy = np.array(high_energies)
        self._freq_times = np.array(times)

        # Normalisieren
        if np.max(self._low_freq_energy) > 0:
            self._low_freq_energy = self._low_freq_energy / np.max(self._low_freq_energy)
        if np.max(self._high_freq_energy) > 0:
            self._high_freq_energy = self._high_freq_energy / np.max(self._high_freq_energy)

    def detect_bass_drops(self, sensitivity: float = 1.0) -> list[BassDropEvent]:
        """
        Erkennt Bass-Drops im Audio.

        Ein Bass-Drop ist charakterisiert durch:
        - Plötzlicher Anstieg der Bass-Energie
        - Oft nach einer ruhigeren Phase (Buildup)

        Args:
            sensitivity: Empfindlichkeit (höher = mehr Drops erkannt)

        Returns:
            Liste von BassDropEvent Objekten
        """
        if self._bass_drops:
            return self._bass_drops

        self._report("Analysiere Bass-Drops...")
        self._compute_frequency_bands()

        bass = self._low_freq_energy
        times = self._freq_times

        # Berechne Bass-Differenz (Anstieg)
        bass_diff = np.zeros(len(bass))
        bass_diff[1:] = bass[1:] - bass[:-1]
        bass_diff = np.maximum(0, bass_diff)  # Nur positive Anstiege

        # Gleitender Durchschnitt für Baseline
        window = int(len(bass) * 0.05)  # 5% der Länge
        baseline = np.convolve(bass, np.ones(window)/window, mode='same')

        # Finde Peaks wo Bass deutlich über Baseline steigt
        threshold = 0.3 / sensitivity

        drops = []
        min_gap = 1.0  # Mindestens 1 Sekunde zwischen Drops
        last_drop = -min_gap

        for i in range(1, len(bass) - 1):
            # Ist es ein lokaler Peak im Bass-Anstieg?
            if bass_diff[i] > bass_diff[i-1] and bass_diff[i] > bass_diff[i+1]:
                # Ist der Anstieg signifikant?
                if bass_diff[i] > threshold and bass[i] > baseline[i] * 1.5:
                    time = times[i]
                    if time - last_drop >= min_gap:
                        intensity = min(1.0, bass_diff[i] / 0.5)
                        drops.append(BassDropEvent(time=time, intensity=intensity))
                        last_drop = time

        self._bass_drops = drops
        self._report(f"  {len(drops)} Bass-Drops erkannt")

        return self._bass_drops

    def get_bass_drop_times(self, min_intensity: float = 0.3) -> list[float]:
        """Gibt Zeitpunkte der Bass-Drops zurück."""
        drops = self.detect_bass_drops()
        return [d.time for d in drops if d.intensity >= min_intensity]

    def detect_loudness_events(self, threshold: float = 0.7) -> list[LoudnessEvent]:
        """
        Erkennt plötzliche Lautstärke-Änderungen.

        Args:
            threshold: Schwellwert für "laut" (0-1)

        Returns:
            Liste von LoudnessEvent Objekten
        """
        if self._loudness_events:
            return self._loudness_events

        self._report("Analysiere Lautstaerke-Events...")
        times, energies = self.get_energy_envelope(window_ms=100)

        # Normalisieren
        if np.max(energies) > 0:
            energies = energies / np.max(energies)

        events = []
        min_gap = 0.5  # Mindestens 0.5 Sekunden zwischen Events

        # Erkenne "laut" Momente
        is_loud = energies > threshold
        last_event_time = -min_gap

        for i in range(1, len(is_loud)):
            time = times[i]

            # Übergang zu laut
            if is_loud[i] and not is_loud[i-1]:
                if time - last_event_time >= min_gap:
                    events.append(LoudnessEvent(
                        time=time,
                        type="loud",
                        intensity=energies[i]
                    ))
                    last_event_time = time

            # Übergang zu leise
            elif not is_loud[i] and is_loud[i-1]:
                if time - last_event_time >= min_gap:
                    events.append(LoudnessEvent(
                        time=time,
                        type="quiet",
                        intensity=1 - energies[i]
                    ))
                    last_event_time = time

        # Erkenne plötzliche Spikes
        energy_diff = np.zeros(len(energies))
        energy_diff[1:] = energies[1:] - energies[:-1]

        spike_threshold = 0.3
        for i in range(1, len(energy_diff) - 1):
            if energy_diff[i] > spike_threshold:
                time = times[i]
                # Nicht zu nah an anderen Events
                if all(abs(time - e.time) >= min_gap for e in events):
                    events.append(LoudnessEvent(
                        time=time,
                        type="spike",
                        intensity=min(1.0, energy_diff[i] / 0.5)
                    ))

        # Sortiere nach Zeit
        events.sort(key=lambda e: e.time)
        self._loudness_events = events
        self._report(f"  {len(events)} Lautstaerke-Events erkannt")

        return self._loudness_events

    def get_loud_moments(self, threshold: float = 0.7) -> list[float]:
        """Gibt Zeitpunkte zurück wo es laut wird."""
        events = self.detect_loudness_events(threshold)
        return [e.time for e in events if e.type in ("loud", "spike")]

    def get_quiet_moments(self, threshold: float = 0.3) -> list[float]:
        """Gibt Zeitpunkte zurück wo es leise wird."""
        events = self.detect_loudness_events(threshold)
        return [e.time for e in events if e.type == "quiet"]

    def get_volume_at_time(self, time: float) -> float:
        """Gibt die normalisierte Lautstärke zu einem Zeitpunkt zurück (0-1)."""
        times, energies = self.get_energy_envelope(window_ms=100)

        if np.max(energies) > 0:
            energies = energies / np.max(energies)

        # Finde nächsten Zeitpunkt
        idx = np.argmin(np.abs(times - time))
        return float(energies[idx])
