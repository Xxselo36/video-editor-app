"""
Sound-Effekte Generator v2.0
- Whoosh für Start/Ende
- Pop für Emojis
- Click für Akzente
- Bessere Platzierung (nicht bei jedem Cut!)
"""

import numpy as np
from scipy.io import wavfile
from scipy import signal
import tempfile
import os
from moviepy.editor import AudioFileClip


SAMPLE_RATE = 44100


def _save_to_temp(audio_data: np.ndarray) -> str:
    """Speichert Audio-Daten in temporäre WAV-Datei."""
    temp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    temp_path = temp.name
    temp.close()

    audio_normalized = audio_data / (np.max(np.abs(audio_data)) + 0.001) * 0.7
    audio_int = (audio_normalized * 32767).astype(np.int16)

    wavfile.write(temp_path, SAMPLE_RATE, audio_int)
    return temp_path


# =============================================================================
# SOUND GENERATOREN
# =============================================================================

def generate_whoosh_in(duration: float = 0.4) -> str:
    """
    Whoosh/Swoosh für Video-Start.
    Wird lauter, endet mit kurzem Impact.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Rauschen
    noise = np.random.randn(samples)

    # Bandpass für Luft-Sound
    nyquist = SAMPLE_RATE / 2
    b, a = signal.butter(4, [150 / nyquist, 2500 / nyquist], btype='band')
    filtered = signal.filtfilt(b, a, noise)

    # Envelope: Leise -> Laut mit kurzem Peak am Ende
    envelope = np.concatenate([
        np.linspace(0, 0.3, int(samples * 0.3)),
        np.linspace(0.3, 1.0, int(samples * 0.5)),
        np.linspace(1.0, 0.3, int(samples * 0.2))
    ])
    envelope = np.resize(envelope, samples)

    # Frequenz-Sweep aufwärts
    freq = np.linspace(200, 600, samples)
    sweep = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE) * 0.3

    audio = (filtered * 0.7 + sweep) * envelope

    return _save_to_temp(audio)


def generate_whoosh_out(duration: float = 0.5) -> str:
    """
    Whoosh für Video-Ende.
    Startet stark, wird leiser.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    noise = np.random.randn(samples)

    nyquist = SAMPLE_RATE / 2
    b, a = signal.butter(4, [100 / nyquist, 2000 / nyquist], btype='band')
    filtered = signal.filtfilt(b, a, noise)

    # Envelope: Laut -> Leise
    envelope = np.exp(-t * 4) * (1 - t / duration)

    # Frequenz-Sweep abwärts
    freq = np.linspace(500, 150, samples)
    sweep = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE) * 0.25

    audio = (filtered * 0.7 + sweep) * envelope

    return _save_to_temp(audio)


def generate_pop(duration: float = 0.1) -> str:
    """
    Pop-Sound für Emojis und Akzente.
    Kurz, knackig, freundlich.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Fallende Frequenz für "Pop"
    freq = 900 * np.exp(-t * 25) + 200
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE)

    # Sehr schnelle Envelope
    envelope = np.exp(-t * 40)

    # Kleiner Noise-Burst am Anfang
    noise_burst = np.random.randn(samples) * np.exp(-t * 80) * 0.3

    audio = (tone + noise_burst) * envelope

    return _save_to_temp(audio)


def generate_click(duration: float = 0.05) -> str:
    """
    Subtiler Click für Cuts.
    Kaum hörbar, aber gibt Rhythmus.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Kurzer Sinus-Burst
    tone = np.sin(2 * np.pi * 1200 * t)

    # Extrem schnelle Envelope
    envelope = np.exp(-t * 100)

    audio = tone * envelope * 0.5

    return _save_to_temp(audio)


def generate_rise(duration: float = 0.25) -> str:
    """
    Rising Sound für Spannung/Erwartung.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Steigende Frequenz (exponentiell)
    freq = 200 * np.exp(t * 4)
    freq = np.clip(freq, 200, 1500)
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE)

    # Envelope mit Sustain
    envelope = np.minimum(t * 10, 1.0) * (1 - (t / duration) ** 2)

    audio = tone * envelope

    return _save_to_temp(audio)


def generate_impact(duration: float = 0.15) -> str:
    """
    Impact-Sound für starke Cuts.
    Tiefer Punch.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Tiefer Ton mit schnellem Decay
    freq = 80 * np.exp(-t * 10) + 40
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE)

    # Noise-Schicht
    noise = np.random.randn(samples) * np.exp(-t * 30) * 0.4

    # Envelope
    envelope = np.exp(-t * 15)

    audio = (tone + noise) * envelope

    return _save_to_temp(audio)


def generate_boom(duration: float = 0.25) -> str:
    """
    Boom-Sound für Highlight-Wörter (2024, krass, wow).
    Tiefer, kraftvoller Impact.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Sehr tiefer Ton
    freq = 60 * np.exp(-t * 8) + 30
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SAMPLE_RATE)

    # Subharmonic für mehr Punch
    sub = np.sin(2 * np.pi * 40 * t) * np.exp(-t * 12)

    # Noise-Burst
    noise = np.random.randn(samples) * np.exp(-t * 20) * 0.5

    # Envelope
    envelope = np.exp(-t * 10)

    audio = (tone * 0.6 + sub * 0.3 + noise) * envelope

    return _save_to_temp(audio)


def generate_cash(duration: float = 0.3) -> str:
    """
    Cash/Kasse-Sound für Geld-Wörter (geld, euro, reich).
    Kling-Kling wie Münzen.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Hohe Töne für Münz-Klang
    tone1 = np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 15)
    tone2 = np.sin(2 * np.pi * 3200 * t) * np.exp(-t * 18)
    tone3 = np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 12)

    # Zweiter Kling leicht verzögert
    delay_samples = int(SAMPLE_RATE * 0.08)
    tone2_delayed = np.zeros(samples)
    if delay_samples < samples:
        tone2_delayed[delay_samples:] = tone2[:-delay_samples] * 0.6

    # Noise für metallischen Klang
    noise = np.random.randn(samples) * np.exp(-t * 25) * 0.15

    audio = (tone1 * 0.4 + tone2 * 0.3 + tone3 * 0.2 + tone2_delayed + noise)

    return _save_to_temp(audio)


def generate_ding(duration: float = 0.2) -> str:
    """
    Ding-Sound für wichtige Wörter (wichtig, achtung).
    Klarer, heller Glockenton.
    """
    samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, samples)

    # Harmonische für Glocken-Sound
    freq_base = 1200
    tone1 = np.sin(2 * np.pi * freq_base * t)
    tone2 = np.sin(2 * np.pi * freq_base * 2 * t) * 0.5
    tone3 = np.sin(2 * np.pi * freq_base * 3 * t) * 0.25

    # Envelope mit langsamem Decay
    envelope = np.exp(-t * 8)

    audio = (tone1 + tone2 + tone3) * envelope

    return _save_to_temp(audio)


# =============================================================================
# SOUND MANAGER
# =============================================================================

class SoundEffects:
    """Verwaltet Sound-Effekte für Video-Editing."""

    def __init__(self):
        self._cache = {}
        self._temp_files = []

    def _get_cached(self, key: str, generator_func, *args, **kwargs) -> AudioFileClip:
        """Cached Sound-Effekt abrufen oder generieren."""
        if key not in self._cache:
            path = generator_func(*args, **kwargs)
            self._temp_files.append(path)
            self._cache[key] = AudioFileClip(path)
        return self._cache[key]

    # === Haupt-Sounds ===

    def get_intro_sound(self) -> AudioFileClip:
        """Sound für Video-Start (Whoosh-In)."""
        return self._get_cached("intro", generate_whoosh_in, 0.4)

    def get_outro_sound(self) -> AudioFileClip:
        """Sound für Video-Ende (Whoosh-Out)."""
        return self._get_cached("outro", generate_whoosh_out, 0.5)

    def get_emoji_sound(self) -> AudioFileClip:
        """Sound für Emoji-Einblendung (Pop)."""
        return self._get_cached("emoji", generate_pop, 0.1)

    def get_cut_sound(self, intensity: str = "soft") -> AudioFileClip:
        """Sound für Cuts (optional, sehr subtil)."""
        if intensity == "soft":
            return self._get_cached("cut_soft", generate_click, 0.03)
        elif intensity == "medium":
            return self._get_cached("cut_medium", generate_pop, 0.08)
        else:  # strong
            return self._get_cached("cut_strong", generate_impact, 0.12)

    def get_transition_sound(self, style: str) -> AudioFileClip:
        """Sound für Übergänge basierend auf Stil."""
        if style == "ruhig":
            return self._get_cached("trans_soft", generate_whoosh_in, 0.3)
        elif style == "balanced":
            return self._get_cached("trans_medium", generate_rise, 0.2)
        else:  # dynamisch
            return self._get_cached("trans_strong", generate_impact, 0.15)

    # === Highlight-Sounds ===

    def get_highlight_sound(self, sound_type: str) -> AudioFileClip:
        """
        Sound für hervorgehobene Wörter.

        Args:
            sound_type: "boom", "cash", "ding", "swoosh"

        Returns:
            AudioFileClip mit dem entsprechenden Sound
        """
        if sound_type == "boom":
            return self._get_cached("highlight_boom", generate_boom, 0.25)
        elif sound_type == "cash":
            return self._get_cached("highlight_cash", generate_cash, 0.3)
        elif sound_type == "ding":
            return self._get_cached("highlight_ding", generate_ding, 0.2)
        elif sound_type == "swoosh":
            return self._get_cached("highlight_swoosh", generate_whoosh_in, 0.3)
        else:
            # Fallback zu Pop-Sound
            return self._get_cached("highlight_default", generate_pop, 0.1)

    # === Cleanup ===

    def cleanup(self):
        """Löscht temporäre Dateien."""
        for clip in self._cache.values():
            try:
                clip.close()
            except:
                pass

        for path in self._temp_files:
            try:
                if os.path.exists(path):
                    os.unlink(path)
            except:
                pass

        self._temp_files = []
        self._cache = {}

    def __del__(self):
        self.cleanup()


# =============================================================================
# SOUND PLACEMENT HELPER
# =============================================================================

def get_sound_events_for_video(duration: float, style: str,
                                emoji_timestamps: list = None) -> list:
    """
    Berechnet wo Sounds platziert werden sollen.

    Returns:
        Liste von (timestamp, sound_type, volume) Tuples
    """
    events = []

    # Intro-Sound (am Anfang)
    events.append((0.0, "intro", 0.4))

    # Outro-Sound (am Ende)
    events.append((max(0, duration - 0.5), "outro", 0.4))

    # Emoji-Sounds
    if emoji_timestamps:
        for ts in emoji_timestamps:
            if 0.5 < ts < duration - 0.5:  # Nicht zu nah an Start/Ende
                events.append((ts, "emoji", 0.3))

    return events
