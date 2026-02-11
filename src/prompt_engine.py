"""
Prompt Engine v1.0 - Intelligente Prompt-zu-Effekt Übersetzung

Analysiert natürliche Sprache und generiert Video-Konfigurationen.

Beispiele:
- "mach es dynamisch mit glitch effekten"
- "ruhiges video mit karaoke untertiteln"
- "für tiktok optimieren, schnelle schnitte"
- "cinematic look mit film grain"
- "musik video mit beat sync"
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any
from .styles import STYLES, get_style


@dataclass
class TimedEffect:
    """Ein zeitbasierter Effekt."""
    position: str           # "start", "end", "absolute", "word"
    time_value: Optional[float] = None  # Sekunde (für absolute)
    word_trigger: Optional[str] = None  # Wort das den Effekt auslöst (für "word")
    effect: str = ""        # "desaturate", "freeze_frame", "slow_motion", etc.
    duration: float = 2.0   # Dauer des Effekts
    params: Dict[str, Any] = field(default_factory=dict)  # Zusätzliche Parameter


@dataclass
class ActionEffect:
    """Ein action-basierter Effekt."""
    action: str             # "falling", "jumping", "movement_start", etc.
    effect: str             # "desaturate", "slow_motion", "freeze_frame", etc.
    duration: float = 3.0   # Dauer des Effekts
    offset: float = 0.0     # Verzögerung nach Erkennung
    params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ObjectEffect:
    """Ein objekt-basierter Effekt."""
    object_name: str        # "laptop", "phone", "person", etc.
    effect: str             # "freeze_frame", "slow_motion", "desaturate", etc.
    duration: float = 2.0   # Dauer des Effekts
    trigger: str = "visible"  # "visible", "appears", "disappears"
    params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AudioEffect:
    """Ein audio-reaktiver Effekt."""
    trigger: str              # "beat", "bass_drop", "loud", "quiet"
    effect: str               # "flash", "shake", "zoom", "glitch"
    intensity: float = 1.0
    params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class FaceEffect:
    """Ein gesichts-basierter Effekt."""
    effect: str               # "zoom", "blur", "spotlight", "track"
    intensity: float = 1.0
    params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ManualImage:
    """Ein manuell spezifiziertes Bild mit Zeitangabe."""
    timestamp: float        # Bei welcher Sekunde
    keyword: str            # Was für ein Bild (z.B. "strand", "auto")
    duration: float = 0.8   # Wie lange einblenden
    style: str = "fullscreen"  # "fullscreen", "overlay"


@dataclass
class ImageGenConfig:
    """Konfiguration für Bildgenerierung."""
    enabled: bool = False
    keywords: List[str] = field(default_factory=list)  # Spezifische Keywords (leer = alle)
    max_images: int = 5
    position: str = "top_right"  # "top_left", "top_right", "bottom_left", "bottom_right", "center"
    size: float = 0.25  # Relative Größe zum Video
    style: str = "overlay"  # "overlay", "fullscreen", "split"
    manual_images: List[ManualImage] = field(default_factory=list)  # Manuell spezifizierte Bilder


@dataclass
class PromptAnalysis:
    """Ergebnis der Prompt-Analyse."""
    base_style: str = "viral"
    effects: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.0
    detected_keywords: List[str] = field(default_factory=list)
    description: str = ""
    custom_highlights: Dict[str, dict] = field(default_factory=dict)  # Wort-Trigger
    # NEU: Zeitbasierte Effekte
    timed_effects: List[TimedEffect] = field(default_factory=list)
    # NEU: Action-basierte Effekte
    action_effects: List[ActionEffect] = field(default_factory=list)
    # NEU: Objekt-basierte Effekte
    object_effects: List[ObjectEffect] = field(default_factory=list)
    # NEU: Intro/Outro Animation
    intro_animation: Optional[Dict[str, str]] = None
    outro_animation: Optional[Dict[str, str]] = None
    # NEU: Audio-reaktive Effekte
    audio_effects: List[AudioEffect] = field(default_factory=list)
    # NEU: Gesichts-Effekte
    face_effects: List[FaceEffect] = field(default_factory=list)
    # NEU: Bildgenerierung
    image_gen: Optional[ImageGenConfig] = None


class PromptEngine:
    """
    Analysiert Prompts und generiert Video-Konfigurationen.

    Unterstützt Deutsch und Englisch.
    """

    # Stil-Keywords (Deutsch + Englisch)
    STYLE_KEYWORDS = {
        "ruhig": {
            "keywords": ["ruhig", "calm", "sanft", "soft", "gentle", "relaxed",
                        "entspannt", "friedlich", "peaceful", "leise", "quiet"],
            "style": "ruhig"
        },
        "balanced": {
            "keywords": ["balanced", "ausgewogen", "normal", "standard", "default",
                        "mittel", "medium", "moderat"],
            "style": "balanced"
        },
        "dynamisch": {
            "keywords": ["dynamisch", "dynamic", "schnell", "fast", "quick", "energisch",
                        "energetic", "aktiv", "active", "intensiv", "intense", "action",
                        "power", "stark", "strong", "wild"],
            "style": "dynamisch"
        },
        "cinematic": {
            "keywords": ["cinematic", "kino", "film", "movie", "filmisch", "hollywood",
                        "professional", "professionell", "epic", "episch", "dramatic",
                        "dramatisch"],
            "style": "cinematic"
        },
        "retro": {
            "keywords": ["retro", "vintage", "old", "alt", "oldschool", "80s", "90s",
                        "nostalgie", "nostalgic", "throwback", "classic", "klassisch"],
            "style": "retro"
        },
        "music": {
            "keywords": ["musik", "music", "beat", "rhythm", "rhythmus", "song", "audio",
                        "sound", "dance", "tanz", "party", "club", "dj", "edm", "hip-hop",
                        "rap", "rock", "pop"],
            "style": "music"
        },
        "viral": {
            "keywords": ["viral", "tiktok", "reels", "shorts", "trending", "social",
                        "instagram", "youtube shorts", "vertical", "vertikal", "hochformat",
                        "9:16", "portrait", "für tiktok", "for tiktok", "cutte", "cut",
                        "schneide", "bearbeite", "edit"],
            "style": "viral"
        },
        "minimal": {
            "keywords": ["minimal", "minimalistisch", "einfach", "simple", "clean", "sauber",
                        "basic", "nur schnitte", "only cuts", "keine effekte", "no effects"],
            "style": "minimal"
        }
    }

    # Effekt-Keywords mit Konfiguration
    EFFECT_KEYWORDS = {
        # Übergänge
        "fade": {
            "keywords": ["fade", "blend", "überblenden", "sanft", "smooth"],
            "config": {"transition_in": "fade", "transition_out": "fade"}
        },
        "blur": {
            "keywords": ["blur", "unscharf", "weich", "soft transition"],
            "config": {"transition_in": "blur", "transition_out": "blur"}
        },
        "swipe": {
            "keywords": ["swipe", "wischen", "slide", "schieben"],
            "config": {"transition_in": "swipe", "transition_out": "swipe"}
        },
        "glitch": {
            "keywords": ["glitch", "störung", "digital", "kaputt", "broken", "error",
                        "bug", "pixel", "corrupt"],
            "config": {"transition_in": "glitch", "rgb_split": True, "rgb_split_intensity": 10}
        },
        "zoom_transition": {
            "keywords": ["zoom übergang", "zoom transition", "reinzoomen"],
            "config": {"transition_in": "zoom", "transition_out": "zoom"}
        },

        # Visuelle Effekte
        "rgb_split": {
            "keywords": ["rgb", "chromatic", "farbverschiebung", "color split", "trippy"],
            "config": {"rgb_split": True, "rgb_split_intensity": 10}
        },
        "rgb_animated": {
            "keywords": ["rgb animiert", "animated rgb", "pulsing rgb"],
            "config": {"rgb_split": True, "rgb_split_animated": True, "rgb_split_intensity": 12}
        },
        "vhs": {
            "keywords": ["vhs", "tape", "kassette", "analog", "tracking", "scanlines"],
            "config": {"vhs_effect": True, "vhs_intensity": 0.5}
        },
        "film_grain": {
            "keywords": ["grain", "körnung", "korn", "film look", "35mm", "16mm", "analog film"],
            "config": {"film_grain": True, "film_grain_intensity": 0.25}
        },
        "light_leak": {
            "keywords": ["light leak", "lichtleck", "lens flare", "sonnenlicht", "warm"],
            "config": {"light_leak": True, "light_leak_intensity": 0.25}
        },
        "cinematic_bars": {
            "keywords": ["letterbox", "balken", "bars", "widescreen", "2.35", "cinemascope",
                        "kino balken", "black bars"],
            "config": {"cinematic_bars": True, "cinematic_bars_height": 0.1}
        },
        "vignette": {
            "keywords": ["vignette", "vignettierung", "dunkle ecken", "dark corners"],
            "config": {"vignette_intensity": 0.35}
        },
        "shake": {
            "keywords": ["shake", "wackeln", "handheld", "shaky", "bewegung", "vibration",
                        "erschütterung", "erdbeben", "earthquake"],
            "config": {"shake": True, "shake_intensity": 5}
        },
        "echo": {
            "keywords": ["echo", "ghost", "geist", "nachlauf", "trail", "motion blur",
                        "bewegungsunschärfe", "spur"],
            "config": {"echo": True, "echo_count": 3}
        },
        "mirror": {
            "keywords": ["mirror", "spiegel", "symmetrie", "symmetry", "kaleidoskop"],
            "config": {"mirror": True}
        },

        # Zoom
        "smart_zoom": {
            "keywords": ["smart zoom", "gesicht folgen", "face tracking", "follow face",
                        "intelligenter zoom", "auto zoom"],
            "config": {"enable_zoom": True, "smart_zoom": True}
        },
        "zoom_in": {
            "keywords": ["zoom in", "reinzoomen", "näher", "closer", "vergrößern"],
            "config": {"enable_zoom": True, "zoom_intensity": 1.15}
        },
        "zoom_out": {
            "keywords": ["zoom out", "rauszoomen", "weiter", "further", "verkleinern"],
            "config": {"enable_zoom": True, "zoom_intensity": 1.15}
        },
        "ken_burns": {
            "keywords": ["ken burns", "pan", "schwenk", "bewegung", "pan zoom"],
            "config": {"enable_zoom": True, "zoom_intensity": 1.12}
        },
        "beat_zoom": {
            "keywords": ["beat zoom", "puls", "pulse", "rhythmus zoom", "beat sync zoom"],
            "config": {"beat_zoom": True, "beat_zoom_intensity": 0.08}
        },
        "zoom_pulse": {
            "keywords": ["zoom pulse", "pulsieren", "atmen", "breathing"],
            "config": {"zoom_pulse": True, "zoom_pulse_frequency": 2.0}
        },

        # Untertitel
        "subtitles": {
            "keywords": ["untertitel", "subtitles", "text", "captions", "beschriftung"],
            "config": {"enable_subtitles": True}
        },
        "karaoke": {
            "keywords": ["karaoke", "wort für wort", "word by word", "highlight",
                        "hervorheben", "animated text"],
            "config": {"enable_subtitles": True, "subtitle_style": "karaoke"}
        },
        "typewriter": {
            "keywords": ["typewriter", "schreibmaschine", "tippen", "typing"],
            "config": {"enable_subtitles": True, "subtitle_style": "typewriter"}
        },
        "bounce_text": {
            "keywords": ["bounce", "hüpfen", "spring", "bouncy text"],
            "config": {"enable_subtitles": True, "subtitle_style": "bounce"}
        },
        "neon_text": {
            "keywords": ["neon"],
            "config": {"enable_subtitles": True, "subtitle_style": "neon"}
        },
        "no_subtitles": {
            "keywords": ["keine untertitel", "no subtitles", "ohne text", "no captions"],
            "config": {"enable_subtitles": False}
        },
        # Untertitel-Glow
        # Text-Effekte
        "text_highlight": {
            "keywords": ["highlight", "textmarker", "markiert", "hervorheben", "marker"],
            "config": {"subtitle_effect": "highlight"}
        },
        "text_box": {
            "keywords": ["box", "kasten", "rahmen", "umrahmt", "boxed"],
            "config": {"subtitle_effect": "box"}
        },
        "text_pop": {
            "keywords": ["pop", "bounce", "spring", "animiert", "animated text"],
            "config": {"subtitle_effect": "pop"}
        },
        # Große/Kleine Schrift
        "big_text": {
            "keywords": ["große schrift", "großer text", "big text", "large text", "bigger font",
                        "riesig", "huge"],
            "config": {"subtitle_fontsize_multiplier": 1.5}
        },
        "small_text": {
            "keywords": ["kleine schrift", "kleiner text", "small text", "smaller font", "tiny"],
            "config": {"subtitle_fontsize_multiplier": 0.7}
        },
        # Dicke/Dünne Outline
        "thick_outline": {
            "keywords": ["dicke outline", "thick outline", "fette kontur", "bold outline",
                        "starke outline"],
            "config": {"subtitle_stroke_width": 6}
        },
        "thin_outline": {
            "keywords": ["dünne outline", "thin outline", "feine kontur", "light outline",
                        "keine outline", "no outline"],
            "config": {"subtitle_stroke_width": 1}
        },

        # Emojis
        "emojis": {
            "keywords": ["emoji", "emojis", "emoticons", "reaktionen", "reactions"],
            "config": {"enable_emojis": True}
        },
        "no_emojis": {
            "keywords": ["keine emojis", "no emojis", "ohne emojis"],
            "config": {"enable_emojis": False}
        },

        # Sounds
        "sounds": {
            "keywords": ["sounds", "soundeffekte", "sound effects", "audio effects",
                        "whoosh", "pop"],
            "config": {"enable_sounds": True, "sound_intro": True, "sound_outro": True}
        },
        "no_sounds": {
            "keywords": ["keine sounds", "no sounds", "ohne sounds", "stumm", "mute effects"],
            "config": {"enable_sounds": False}
        },

        # Schnitte
        "remove_silence": {
            "keywords": ["stille entfernen", "remove silence", "cut silence", "pausen raus",
                        "keine pausen", "no pauses", "schneller", "kürzer", "shorter"],
            "config": {"remove_silence": True}
        },
        "keep_silence": {
            "keywords": ["stille behalten", "keep silence", "mit pausen", "original länge",
                        "full length"],
            "config": {"remove_silence": False}
        },
        "fast_cuts": {
            "keywords": ["schnelle schnitte", "fast cuts", "quick cuts", "rapid",
                        "hektisch", "hectic"],
            "config": {"remove_silence": True, "min_silence_to_cut": 0.3, "keep_padding": 0.1}
        },
        "slow_cuts": {
            "keywords": ["langsame schnitte", "slow cuts", "gemächlich", "entspannt"],
            "config": {"min_silence_to_cut": 1.0, "keep_padding": 0.3}
        },

        # Beat Sync
        "beat_sync": {
            "keywords": ["beat sync", "auf den beat", "rhythmus", "tempo", "bpm",
                        "musik sync", "music sync", "takt"],
            "config": {"beat_sync": True, "beat_zoom": True}
        },

        # Format
        "portrait": {
            "keywords": ["hochformat", "portrait", "vertikal", "9:16", "vertical",
                        "tiktok format", "reels format", "shorts format"],
            "config": {"auto_reframe": True, "target_ratio": "9:16"}
        },
        "square": {
            "keywords": ["quadrat", "square", "1:1", "instagram post"],
            "config": {"auto_reframe": True, "target_ratio": "1:1"}
        },
        "landscape": {
            "keywords": ["querformat", "landscape", "16:9", "horizontal", "youtube"],
            "config": {"auto_reframe": False}
        },

        # Farbkorrektur
        "warm": {
            "keywords": ["warm", "wärmer", "warmer", "orange", "sonnig", "sunny", "golden"],
            "config": {"color_grade": "balanced", "light_leak": True}
        },
        "cold": {
            "keywords": ["kalt", "cold", "kühl", "cool", "blau", "blue", "winter"],
            "config": {"color_grade": "cinematic"}
        },
        "vibrant": {
            "keywords": ["vibrant", "bunt", "colorful", "farbenfroh", "saturated", "gesättigt"],
            "config": {"color_grade": "dynamisch"}
        },
        "desaturated": {
            "keywords": ["entsättigt", "desaturated", "faded", "verblasst", "muted"],
            "config": {"color_grade": "vintage"}
        },

        # =====================================================================
        # NEUE EFFEKTE
        # =====================================================================

        # Audio-reaktive Effekte
        "beat_flash": {
            "keywords": ["beat flash", "flash bei beat", "blitz bei beat", "flash on beat"],
            "config": {"beat_flash": True, "beat_flash_intensity": 0.3}
        },
        "beat_shake": {
            "keywords": ["beat shake", "shake bei beat", "wackeln bei beat", "shake on beat"],
            "config": {"beat_shake": True, "beat_shake_intensity": 10}
        },
        "bass_drop": {
            "keywords": ["bass drop", "bassdrop", "drop", "beim drop", "on drop"],
            "config": {"bass_drop_effect": True, "bass_drop_type": "zoom"}
        },
        "volume_zoom": {
            "keywords": ["lautstärke zoom", "volume zoom", "loud zoom", "lauter zoom"],
            "config": {"volume_reactive_zoom": True}
        },

        # Color Grading Presets
        "cyberpunk": {
            "keywords": ["cyberpunk", "neon", "synthwave", "retrowave", "80s", "futuristisch"],
            "config": {"color_preset": "cyberpunk"}
        },
        "noir": {
            "keywords": ["noir", "schwarz weiß film", "black and white movie", "detective",
                        "klassisch schwarz weiß"],
            "config": {"color_preset": "noir"}
        },
        "sunset": {
            "keywords": ["sunset", "sonnenuntergang", "golden hour", "goldene stunde", "abendrot"],
            "config": {"color_preset": "sunset"}
        },
        "arctic": {
            "keywords": ["arctic", "arktisch", "eiskalt", "frozen", "ice", "eis"],
            "config": {"color_preset": "arctic"}
        },
        "matrix": {
            "keywords": ["matrix", "grün", "hacker", "code", "terminal"],
            "config": {"color_preset": "matrix"}
        },
        "sepia": {
            "keywords": ["sepia", "alt", "old photo", "antik", "vintage foto"],
            "config": {"color_preset": "sepia"}
        },

        # Gesichts-Effekte
        "face_zoom": {
            "keywords": ["gesicht zoom", "face zoom", "zoom auf gesicht", "zoom to face",
                        "gesicht folgen", "follow face"],
            "config": {"face_zoom": True, "face_zoom_factor": 1.5}
        },
        "face_blur": {
            "keywords": ["gesicht blur", "face blur", "gesicht unscharf", "blur face",
                        "gesicht verpixeln", "pixelate face", "anonymisieren"],
            "config": {"face_blur": True, "face_blur_amount": 30}
        },
        "spotlight": {
            "keywords": ["spotlight", "scheinwerfer", "fokus gesicht", "face spotlight",
                        "gesicht hervorheben"],
            "config": {"spotlight_face": True}
        },

        # Neue visuelle Effekte
        "scanlines": {
            "keywords": ["scanlines", "scan lines", "monitor", "bildschirm linien"],
            "config": {"scanlines": True, "scanlines_intensity": 0.3}
        },
        "chromatic": {
            "keywords": ["chromatic aberration", "chromatisch", "farbfehler", "lens error"],
            "config": {"chromatic_aberration": True, "chromatic_intensity": 5}
        },
        "crt": {
            "keywords": ["crt", "röhrenmonitor", "old monitor", "alter monitor", "retro monitor"],
            "config": {"crt_effect": True}
        },
        "glitch_blocks": {
            "keywords": ["glitch blocks", "datamosh", "corruption", "daten fehler", "block glitch"],
            "config": {"glitch_blocks": True, "glitch_intensity": 0.5}
        },

        # Layout-Effekte
        "split_screen": {
            "keywords": ["split screen", "splitscreen", "geteilter bildschirm", "zwei bilder",
                        "nebeneinander"],
            "config": {"split_screen": True, "split_layout": "horizontal"}
        },
        "split_vertical": {
            "keywords": ["split vertikal", "vertical split", "oben unten", "übereinander"],
            "config": {"split_screen": True, "split_layout": "vertical"}
        },
        "quad_split": {
            "keywords": ["quad", "vier teile", "4 teile", "four way", "vierfach"],
            "config": {"split_screen": True, "split_layout": "quad"}
        },
        "ken_burns_effect": {
            "keywords": ["ken burns", "langsamer zoom", "slow zoom", "dokumentar", "documentary",
                        "sanfter zoom", "gentle zoom"],
            "config": {"ken_burns": True, "ken_burns_start": "center", "ken_burns_end": "top_right"}
        },

        # Platform-spezifisch
        "tiktok": {
            "keywords": ["tiktok", "für tiktok", "for tiktok", "tiktok style"],
            "config": {"auto_reframe": True, "target_ratio": "9:16", "enable_subtitles": True,
                      "subtitle_style": "karaoke", "beat_sync": True}
        },
        "instagram": {
            "keywords": ["instagram", "insta", "reels", "für instagram", "for instagram"],
            "config": {"auto_reframe": True, "target_ratio": "9:16", "enable_subtitles": True}
        },
        "youtube_shorts": {
            "keywords": ["youtube shorts", "shorts", "für shorts", "for shorts"],
            "config": {"auto_reframe": True, "target_ratio": "9:16", "enable_subtitles": True}
        },
        "youtube": {
            "keywords": ["youtube", "für youtube", "for youtube", "yt"],
            "config": {"target_ratio": "16:9", "cinematic_bars": True}
        },

        # Bildgenerierung
        "generate_images": {
            "keywords": ["generiere bilder", "generate images", "bilder generieren",
                        "bilder einfügen", "passende bilder", "ai bilder", "ki bilder",
                        "stable diffusion", "bilder zu keywords"],
            "config": {"image_gen_enabled": True}
        },
    }

    # Intensitäts-Modifikatoren
    INTENSITY_KEYWORDS = {
        "sehr": 1.5,
        "sehr viel": 2.0,
        "extrem": 2.0,
        "wenig": 0.5,
        "leicht": 0.5,
        "subtil": 0.3,
        "stark": 1.5,
        "voll": 2.0,
        "maximal": 2.0,
        "minimal": 0.3,
        "more": 1.5,
        "less": 0.5,
        "extreme": 2.0,
        "subtle": 0.3,
        "strong": 1.5,
        "full": 2.0,
        "maximum": 2.0,
        "minimum": 0.3,
    }

    # Farben für Wort-Trigger
    HIGHLIGHT_COLORS = {
        "rot": (255, 50, 50),
        "red": (255, 50, 50),
        "grün": (0, 255, 100),
        "green": (0, 255, 100),
        "blau": (50, 100, 255),
        "blue": (50, 100, 255),
        "gelb": (255, 255, 0),
        "yellow": (255, 255, 0),
        "gold": (255, 215, 0),
        "golden": (255, 215, 0),
        "orange": (255, 150, 0),
        "pink": (255, 100, 255),
        "lila": (200, 100, 255),
        "purple": (200, 100, 255),
        "cyan": (0, 255, 255),
        "weiß": (255, 255, 255),
        "white": (255, 255, 255),
    }

    # Sound-Typen für Wort-Trigger
    HIGHLIGHT_SOUNDS = {
        "boom": "boom",
        "cash": "cash",
        "kasse": "cash",
        "geld": "cash",
        "ding": "ding",
        "klingel": "ding",
        "swoosh": "swoosh",
        "whoosh": "swoosh",
        "pop": "swoosh",
    }

    # Intro-Animations Keywords
    INTRO_KEYWORDS = {
        # Slide-Animationen mit Richtung
        "von rechts": {"intro_type": "slide", "intro_direction": "right"},
        "from right": {"intro_type": "slide", "intro_direction": "right"},
        "von links": {"intro_type": "slide", "intro_direction": "left"},
        "from left": {"intro_type": "slide", "intro_direction": "left"},
        "von oben": {"intro_type": "slide", "intro_direction": "top"},
        "from top": {"intro_type": "slide", "intro_direction": "top"},
        "von unten": {"intro_type": "slide", "intro_direction": "bottom"},
        "from bottom": {"intro_type": "slide", "intro_direction": "bottom"},
        # Scale-Animationen
        "reinzoomen": {"intro_type": "scale", "intro_origin": "center"},
        "zoom in": {"intro_type": "scale", "intro_origin": "center"},
        "aus der ecke": {"intro_type": "scale", "intro_origin": "corner"},
        "from corner": {"intro_type": "scale", "intro_origin": "corner"},
        # Spin-Animationen
        "reindrehen": {"intro_type": "spin", "intro_direction": "clockwise"},
        "spin in": {"intro_type": "spin", "intro_direction": "clockwise"},
        "drehen": {"intro_type": "spin", "intro_direction": "clockwise"},
        # Flip-Animationen
        "flip": {"intro_type": "flip", "intro_axis": "horizontal"},
        "umdrehen": {"intro_type": "flip", "intro_axis": "horizontal"},
        "flip horizontal": {"intro_type": "flip", "intro_axis": "horizontal"},
        "flip vertikal": {"intro_type": "flip", "intro_axis": "vertical"},
        # Bounce-Animationen
        "bounce": {"intro_type": "bounce", "intro_direction": "bottom"},
        "federn": {"intro_type": "bounce", "intro_direction": "bottom"},
        "hüpfen": {"intro_type": "bounce", "intro_direction": "bottom"},
        # Elastic
        "elastisch": {"intro_type": "elastic"},
        "elastic": {"intro_type": "elastic"},
        # Blur-Slide
        "blur slide": {"intro_type": "blur_slide", "intro_direction": "right"},
        "unscharf reingleiten": {"intro_type": "blur_slide", "intro_direction": "right"},
    }

    # Outro-Animations Keywords
    OUTRO_KEYWORDS = {
        "raussliden": {"outro_type": "slide", "outro_direction": "left"},
        "slide out": {"outro_type": "slide", "outro_direction": "left"},
        "rauszoomen": {"outro_type": "scale", "outro_origin": "center"},
        "zoom out": {"outro_type": "scale", "outro_origin": "center"},
        "wegdrehen": {"outro_type": "spin", "outro_direction": "clockwise"},
        "spin out": {"outro_type": "spin", "outro_direction": "clockwise"},
    }

    # Zeitbasierte Effekt-Keywords
    TIMED_EFFECT_KEYWORDS = {
        # Schwarz-Weiß
        "schwarz weiß": "desaturate",
        "schwarz-weiß": "desaturate",
        "schwarzweiß": "desaturate",
        "black white": "desaturate",
        "black and white": "desaturate",
        "grayscale": "desaturate",
        "graustufen": "desaturate",
        # Freeze
        "freeze": "freeze_frame",
        "einfrieren": "freeze_frame",
        "standbild": "freeze_frame",
        "still": "freeze_frame",
        # Slowmo
        "slowmo": "slow_motion",
        "zeitlupe": "slow_motion",
        "slow motion": "slow_motion",
        "langsam": "slow_motion",
        # Speed Up
        "schnell": "speed_up",
        "fast": "speed_up",
        "speed up": "speed_up",
        "beschleunigen": "speed_up",
        # Zoom
        "zoom": "zoom_in",
        "reinzoomen": "zoom_in",
        "näher": "zoom_in",
        # Shake
        "shake": "shake",
        "wackeln": "shake",
        "erschütterung": "shake",
        # Blur
        "blur": "blur",
        "unscharf": "blur",
        "verschwommen": "blur",
        # Reverse
        "reverse": "reverse",
        "rückwärts": "reverse",
        "zurück": "reverse",
        # Flash
        "flash": "flash",
        "blitz": "flash",
        "aufblitzen": "flash",
        # Impact
        "impact": "impact_zoom",
        "einschlag": "impact_zoom",
        "boom": "impact_zoom",
    }

    # Action-Keywords für Content-basierte Erkennung
    ACTION_KEYWORDS = {
        # Deutsch
        "hinfalle": "falling",
        "falle": "falling",
        "stürze": "falling",
        "fallen": "falling",
        "springe": "jumping",
        "hüpfe": "jumping",
        "springen": "jumping",
        "stehe auf": "standing_up",
        "aufstehe": "standing_up",
        "aufstehen": "standing_up",
        "hinsetze": "sitting_down",
        "setze mich": "sitting_down",
        "hinsetzen": "sitting_down",
        "bewege": "movement_start",
        "bewegung": "movement_start",
        "bewegen": "movement_start",
        "stillstehe": "stillstand",
        "stehe still": "stillstand",
        "stillstand": "stillstand",
        "liege": "lying",
        "am boden": "lying",
        "auf dem boden": "lying",
        # Englisch
        "fall": "falling",
        "falling": "falling",
        "jump": "jumping",
        "jumping": "jumping",
        "stand up": "standing_up",
        "standing up": "standing_up",
        "sit down": "sitting_down",
        "sitting down": "sitting_down",
        "move": "movement_start",
        "movement": "movement_start",
        "still": "stillstand",
        "stop": "stillstand",
        "stopped": "stillstand",
        "lying": "lying",
        "on the ground": "lying",
    }

    # Objekt-Keywords für Objekterkennung (alle 80 COCO Klassen)
    OBJECT_KEYWORDS = {
        # === PERSONEN ===
        "person": "person",
        "mensch": "person",
        "leute": "person",
        "ich": "person",
        "gesicht": "person",
        "körper": "person",

        # === FAHRZEUGE ===
        "fahrrad": "bicycle",
        "bicycle": "bicycle",
        "rad": "bicycle",
        "bike": "bicycle",
        "auto": "car",
        "car": "car",
        "wagen": "car",
        "pkw": "car",
        "motorrad": "motorcycle",
        "motorcycle": "motorcycle",
        "moped": "motorcycle",
        "roller": "motorcycle",
        "flugzeug": "airplane",
        "airplane": "airplane",
        "flieger": "airplane",
        "bus": "bus",
        "reisebus": "bus",
        "zug": "train",
        "train": "train",
        "bahn": "train",
        "lkw": "truck",
        "truck": "truck",
        "lastwagen": "truck",
        "boot": "boat",
        "boat": "boat",
        "schiff": "boat",

        # === STRASSENOBJEKTE ===
        "ampel": "traffic light",
        "traffic light": "traffic light",
        "hydrant": "fire hydrant",
        "fire hydrant": "fire hydrant",
        "stoppschild": "stop sign",
        "stop sign": "stop sign",
        "parkuhr": "parking meter",
        "parking meter": "parking meter",
        "bank": "bench",
        "bench": "bench",
        "parkbank": "bench",
        "sitzbank": "bench",

        # === TIERE ===
        "vogel": "bird",
        "bird": "bird",
        "katze": "cat",
        "cat": "cat",
        "mieze": "cat",
        "hund": "dog",
        "dog": "dog",
        "pferd": "horse",
        "horse": "horse",
        "schaf": "sheep",
        "sheep": "sheep",
        "kuh": "cow",
        "cow": "cow",
        "rind": "cow",
        "elefant": "elephant",
        "elephant": "elephant",
        "bär": "bear",
        "bear": "bear",
        "zebra": "zebra",
        "giraffe": "giraffe",

        # === ACCESSOIRES ===
        "rucksack": "backpack",
        "backpack": "backpack",
        "tasche": "backpack",
        "regenschirm": "umbrella",
        "umbrella": "umbrella",
        "schirm": "umbrella",
        "handtasche": "handbag",
        "handbag": "handbag",
        "krawatte": "tie",
        "tie": "tie",
        "schlips": "tie",
        "koffer": "suitcase",
        "suitcase": "suitcase",
        "trolley": "suitcase",

        # === SPORT ===
        "frisbee": "frisbee",
        "ski": "skis",
        "skis": "skis",
        "snowboard": "snowboard",
        "ball": "sports ball",
        "sports ball": "sports ball",
        "fußball": "sports ball",
        "basketball": "sports ball",
        "tennis": "sports ball",
        "drachen": "kite",
        "kite": "kite",
        "baseballschläger": "baseball bat",
        "baseball bat": "baseball bat",
        "baseballhandschuh": "baseball glove",
        "baseball glove": "baseball glove",
        "skateboard": "skateboard",
        "surfbrett": "surfboard",
        "surfboard": "surfboard",
        "tennisschläger": "tennis racket",
        "tennis racket": "tennis racket",

        # === KÜCHE / ESSEN ===
        "flasche": "bottle",
        "bottle": "bottle",
        "weinglas": "wine glass",
        "wine glass": "wine glass",
        "glas": "wine glass",
        "tasse": "cup",
        "cup": "cup",
        "becher": "cup",
        "kaffee": "cup",
        "gabel": "fork",
        "fork": "fork",
        "messer": "knife",
        "knife": "knife",
        "löffel": "spoon",
        "spoon": "spoon",
        "schüssel": "bowl",
        "bowl": "bowl",
        "schale": "bowl",
        "banane": "banana",
        "banana": "banana",
        "apfel": "apple",
        "apple": "apple",
        "sandwich": "sandwich",
        "brot": "sandwich",
        "orange": "orange",
        "brokkoli": "broccoli",
        "broccoli": "broccoli",
        "karotte": "carrot",
        "carrot": "carrot",
        "möhre": "carrot",
        "hotdog": "hot dog",
        "hot dog": "hot dog",
        "pizza": "pizza",
        "donut": "donut",
        "kuchen": "cake",
        "cake": "cake",
        "torte": "cake",

        # === MÖBEL ===
        "stuhl": "chair",
        "chair": "chair",
        "sofa": "couch",
        "couch": "couch",
        "sessel": "couch",
        "pflanze": "potted plant",
        "potted plant": "potted plant",
        "blume": "potted plant",
        "zimmerpflanze": "potted plant",
        "bett": "bed",
        "bed": "bed",
        "tisch": "dining table",
        "dining table": "dining table",
        "esstisch": "dining table",
        "schreibtisch": "dining table",
        "toilette": "toilet",
        "toilet": "toilet",
        "klo": "toilet",
        "wc": "toilet",

        # === ELEKTRONIK ===
        "fernseher": "tv",
        "tv": "tv",
        "monitor": "tv",
        "bildschirm": "tv",
        "television": "tv",
        "laptop": "laptop",
        "notebook": "laptop",
        "computer": "laptop",
        "macbook": "laptop",
        "maus": "mouse",
        "mouse": "mouse",
        "computermaus": "mouse",
        "fernbedienung": "remote",
        "remote": "remote",
        "tastatur": "keyboard",
        "keyboard": "keyboard",
        "handy": "cell phone",
        "telefon": "cell phone",
        "smartphone": "cell phone",
        "phone": "cell phone",
        "cell phone": "cell phone",
        "iphone": "cell phone",
        "android": "cell phone",

        # === HAUSHALTSGERÄTE ===
        "mikrowelle": "microwave",
        "microwave": "microwave",
        "ofen": "oven",
        "oven": "oven",
        "backofen": "oven",
        "herd": "oven",
        "toaster": "toaster",
        "spüle": "sink",
        "sink": "sink",
        "waschbecken": "sink",
        "kühlschrank": "refrigerator",
        "refrigerator": "refrigerator",

        # === SONSTIGES ===
        "buch": "book",
        "book": "book",
        "bücher": "book",
        "uhr": "clock",
        "clock": "clock",
        "wanduhr": "clock",
        "wecker": "clock",
        "vase": "vase",
        "blumenvase": "vase",
        "schere": "scissors",
        "scissors": "scissors",
        "teddybär": "teddy bear",
        "teddy bear": "teddy bear",
        "teddy": "teddy bear",
        "kuscheltier": "teddy bear",
        "plüschtier": "teddy bear",
        "fön": "hair drier",
        "hair drier": "hair drier",
        "haartrockner": "hair drier",
        "zahnbürste": "toothbrush",
        "toothbrush": "toothbrush",
    }

    def __init__(self):
        pass

    def analyze(self, prompt: str) -> PromptAnalysis:
        """
        Analysiert einen Prompt und gibt die Konfiguration zurück.

        Args:
            prompt: Natürlichsprachlicher Prompt

        Returns:
            PromptAnalysis mit Konfiguration
        """
        prompt_lower = prompt.lower()

        analysis = PromptAnalysis()

        # 1. Basis-Stil erkennen
        analysis.base_style = self._detect_base_style(prompt_lower)

        # 2. Starte mit dem Basis-Stil
        analysis.effects = get_style(analysis.base_style)

        # 3. Effekte erkennen und anwenden
        detected_effects = self._detect_effects(prompt_lower)
        for effect_name, config in detected_effects:
            analysis.detected_keywords.append(effect_name)
            analysis.effects.update(config)

        # 4. Intensitäts-Modifikatoren anwenden
        self._apply_intensity_modifiers(prompt_lower, analysis.effects)

        # 5. Wort-Trigger erkennen (z.B. "bei '2026' gold mit boom")
        analysis.custom_highlights = self._detect_word_triggers(prompt)

        # 6. Globale Untertitel-Farbe erkennen (z.B. "text in rot", "blaue untertitel")
        subtitle_color = self._detect_subtitle_color(prompt_lower)
        if subtitle_color:
            analysis.effects["subtitle_color"] = subtitle_color
            analysis.detected_keywords.append(f"textfarbe")
            print(f"    Untertitel-Farbe erkannt: {subtitle_color}")

        # 7. NEU: Intro/Outro-Animation erkennen
        intro_anim = self._parse_intro_animation(prompt_lower)
        if intro_anim:
            analysis.intro_animation = intro_anim
            analysis.effects.update(intro_anim)
            analysis.detected_keywords.append(f"intro_{intro_anim.get('intro_type', 'anim')}")
            print(f"    Intro-Animation erkannt: {intro_anim}")

        outro_anim = self._parse_outro_animation(prompt_lower)
        if outro_anim:
            analysis.outro_animation = outro_anim
            analysis.effects.update(outro_anim)
            analysis.detected_keywords.append(f"outro_{outro_anim.get('outro_type', 'anim')}")
            print(f"    Outro-Animation erkannt: {outro_anim}")

        # 8. NEU: Zeitbasierte Effekte erkennen
        analysis.timed_effects = self._parse_temporal_effects(prompt_lower)
        if analysis.timed_effects:
            analysis.effects["timed_effects"] = [
                {
                    "position": te.position,
                    "time_value": te.time_value,
                    "word_trigger": te.word_trigger,
                    "effect": te.effect,
                    "duration": te.duration,
                    "params": te.params
                }
                for te in analysis.timed_effects
            ]
            for te in analysis.timed_effects:
                analysis.detected_keywords.append(f"timed_{te.effect}")
            print(f"    Zeitbasierte Effekte erkannt: {len(analysis.timed_effects)}")

        # 9. NEU: Action-basierte Effekte erkennen
        analysis.action_effects = self._parse_action_triggers(prompt_lower)
        if analysis.action_effects:
            analysis.effects["action_effects"] = [
                {
                    "action": ae.action,
                    "effect": ae.effect,
                    "duration": ae.duration,
                    "offset": ae.offset,
                    "params": ae.params
                }
                for ae in analysis.action_effects
            ]
            for ae in analysis.action_effects:
                analysis.detected_keywords.append(f"action_{ae.action}")
            print(f"    Action-Effekte erkannt: {len(analysis.action_effects)}")

        # 10. NEU: Objekt-basierte Effekte erkennen
        analysis.object_effects = self._parse_object_triggers(prompt_lower)
        if analysis.object_effects:
            analysis.effects["object_effects"] = [
                {
                    "object_name": oe.object_name,
                    "effect": oe.effect,
                    "duration": oe.duration,
                    "trigger": oe.trigger,
                    "params": oe.params
                }
                for oe in analysis.object_effects
            ]
            for oe in analysis.object_effects:
                analysis.detected_keywords.append(f"object_{oe.object_name}")
            print(f"    Objekt-Effekte erkannt: {len(analysis.object_effects)}")

        # 11. NEU: Audio-reaktive Effekte erkennen
        analysis.audio_effects = self._parse_audio_triggers(prompt_lower)
        if analysis.audio_effects:
            analysis.effects["audio_effects"] = [
                {
                    "trigger": ae.trigger,
                    "effect": ae.effect,
                    "intensity": ae.intensity,
                    "params": ae.params
                }
                for ae in analysis.audio_effects
            ]
            for ae in analysis.audio_effects:
                analysis.detected_keywords.append(f"audio_{ae.trigger}")
            print(f"    Audio-Effekte erkannt: {len(analysis.audio_effects)}")

        # 12. NEU: Gesichts-Effekte erkennen
        analysis.face_effects = self._parse_face_triggers(prompt_lower)
        if analysis.face_effects:
            analysis.effects["face_effects"] = [
                {
                    "effect": fe.effect,
                    "intensity": fe.intensity,
                    "params": fe.params
                }
                for fe in analysis.face_effects
            ]
            for fe in analysis.face_effects:
                analysis.detected_keywords.append(f"face_{fe.effect}")
            print(f"    Gesichts-Effekte erkannt: {len(analysis.face_effects)}")

        # 13. NEU: Bildgenerierung erkennen
        analysis.image_gen = self._parse_image_generation(prompt_lower)
        if analysis.image_gen and analysis.image_gen.enabled:
            analysis.effects["image_gen"] = {
                "enabled": True,
                "keywords": analysis.image_gen.keywords,
                "max_images": analysis.image_gen.max_images,
                "position": analysis.image_gen.position,
                "size": analysis.image_gen.size,
                "style": analysis.image_gen.style,
                "manual_images": [
                    {"timestamp": img.timestamp, "keyword": img.keyword,
                     "duration": img.duration, "style": img.style}
                    for img in analysis.image_gen.manual_images
                ]
            }
            analysis.detected_keywords.append("image_generation")
            if analysis.image_gen.manual_images:
                print(f"    Bildgenerierung: {len(analysis.image_gen.manual_images)} manuelle Bilder")
            else:
                print(f"    Bildgenerierung aktiviert (Keywords)")

        # 14. Confidence berechnen
        total_keywords = len(analysis.detected_keywords) + len(analysis.custom_highlights)
        total_keywords += len(analysis.timed_effects) + len(analysis.action_effects)
        total_keywords += len(analysis.object_effects) + len(analysis.audio_effects)
        total_keywords += len(analysis.face_effects)
        if analysis.intro_animation:
            total_keywords += 1
        if analysis.image_gen and analysis.image_gen.enabled:
            total_keywords += 1
        if analysis.base_style != "viral":
            total_keywords += 1
        analysis.confidence = min(1.0, total_keywords / 5)  # 5 Keywords = 100%

        # 15. Beschreibung generieren
        analysis.description = self._generate_description(analysis)

        return analysis

    def _detect_word_triggers(self, prompt: str) -> Dict[str, dict]:
        """
        Erkennt Wort-Trigger aus dem Prompt.

        Unterstützte Formate:
        - "bei 'wort' farbe rot und boom sound"
        - "'wort' in gold mit boom"
        - "highlight 'wort' mit box effekt"
        - "bei dem wort 'krass' soll ein boom kommen"

        Returns:
            Dict mit Wort -> {color, effect, sound}
        """
        triggers = {}

        # Pattern 1: 'wort' oder "wort" finden
        # Suche nach Wörtern in Anführungszeichen und ihrem Kontext
        patterns = [
            r"bei\s+['\"]([^'\"]+)['\"]\s+(.+?)(?:und|$|\.|,)",
            r"['\"]([^'\"]+)['\"]\s+(?:in|mit|soll)\s+(.+?)(?:und|$|\.|,)",
            r"highlight\s+['\"]([^'\"]+)['\"]\s+(.+?)(?:und|$|\.|,)",
            r"bei\s+(?:dem\s+)?wort\s+['\"]([^'\"]+)['\"]\s+(.+?)(?:und|$|\.|,)",
            r"wenn\s+['\"]([^'\"]+)['\"]\s+(?:kommt|gesagt|erscheint)\s+(.+?)(?:und|$|\.|,)",
        ]

        prompt_lower = prompt.lower()

        for pattern in patterns:
            matches = re.finditer(pattern, prompt_lower, re.IGNORECASE)
            for match in matches:
                word = match.group(1).strip()
                context = match.group(2).strip() if len(match.groups()) > 1 else ""

                if not word:
                    continue

                # Parse Kontext für Farbe, Glow und Sound
                config = self._parse_trigger_context(context + " " + prompt_lower)

                if config:
                    triggers[word] = config
                    print(f"    Wort-Trigger erkannt: '{word}' -> {config}")

        return triggers

    def _parse_trigger_context(self, context: str) -> Optional[dict]:
        """Parst den Kontext eines Wort-Triggers für Farbe, Effekt und Sound."""
        result = {}

        # Farbe erkennen
        for color_name, color_rgb in self.HIGHLIGHT_COLORS.items():
            if color_name in context:
                result["color"] = color_rgb
                break

        # Effekt erkennen (highlight, box, pop)
        effect_keywords = {
            "highlight": ["highlight", "textmarker", "marker", "markier"],
            "box": ["box", "kasten", "rahmen"],
            "pop": ["pop", "bounce", "spring", "groß", "größer", "big", "large"],
        }
        for effect_name, keywords in effect_keywords.items():
            for kw in keywords:
                if kw in context:
                    result["effect"] = effect_name
                    break
            if "effect" in result:
                break

        # Sound erkennen
        for sound_name, sound_type in self.HIGHLIGHT_SOUNDS.items():
            if sound_name in context:
                result["sound"] = sound_type
                break

        # Default Effekt wenn Farbe aber kein expliziter Effekt
        if "color" in result and "effect" not in result:
            result["effect"] = "highlight"

        # Nur zurückgeben wenn mindestens eine Eigenschaft gesetzt wurde
        return result if result else None

    def _detect_subtitle_color(self, prompt: str) -> Optional[tuple]:
        """
        Erkennt die globale Untertitel-Farbe aus dem Prompt.

        Unterstützte Formate:
        - "text in rot" / "text in blau"
        - "rote untertitel" / "blaue untertitel"
        - "untertitel in weiß"
        - "schrift in gold"
        - "farbe weiß" (im Kontext von Untertiteln)

        Returns:
            RGB-Tuple oder None
        """
        # Muster für direkte Farbangabe
        patterns = [
            # "text in rot", "untertitel in blau"
            r"(?:text|untertitel|schrift|subtitles|captions)\s+in\s+(\w+)",
            # "rote untertitel", "blaue schrift", "weißer text"
            r"(\w+)(?:e|er|es|en)?\s+(?:text|untertitel|schrift|subtitles)",
            # "farbe rot", "farbe: blau"
            r"(?:farbe|color)[:\s]+(\w+)",
            # "mit rotem text", "mit blauer schrift"
            r"mit\s+(\w+)(?:e|em|er|en)?\s+(?:text|untertitel|schrift)",
        ]

        for pattern in patterns:
            match = re.search(pattern, prompt, re.IGNORECASE)
            if match:
                color_word = match.group(1).lower()
                # Entferne Adjektiv-Endungen
                color_word = re.sub(r'(e|er|es|en|em)$', '', color_word)

                # Suche passende Farbe
                for color_name, color_rgb in self.HIGHLIGHT_COLORS.items():
                    if color_word == color_name or color_word.startswith(color_name[:3]):
                        return color_rgb

        return None

    def _parse_intro_animation(self, prompt: str) -> Optional[Dict[str, str]]:
        """
        Erkennt Intro-Animation aus dem Prompt.

        Returns:
            Dict mit intro_type, intro_direction/origin/axis, intro_duration
        """
        result = None

        # Prüfe alle Intro-Keywords
        for keyword, config in self.INTRO_KEYWORDS.items():
            if keyword in prompt:
                result = config.copy()
                # Dauer erkennen
                duration_match = re.search(
                    r'intro\s+(?:für|for)?\s*(\d+(?:\.\d+)?)\s*(?:sekunden?|seconds?|s)',
                    prompt
                )
                if duration_match:
                    result["intro_duration"] = float(duration_match.group(1))
                else:
                    result["intro_duration"] = 0.5  # Default
                break

        # Prüfe auf generische "kommt" Formulierung
        if not result:
            kommt_match = re.search(
                r'(?:video\s+)?kommt\s+(?:von\s+)?(\w+)',
                prompt
            )
            if kommt_match:
                direction = kommt_match.group(1)
                direction_map = {
                    "rechts": "right", "links": "left",
                    "oben": "top", "unten": "bottom"
                }
                if direction in direction_map:
                    result = {
                        "intro_type": "slide",
                        "intro_direction": direction_map[direction],
                        "intro_duration": 0.5
                    }

        return result

    def _parse_outro_animation(self, prompt: str) -> Optional[Dict[str, str]]:
        """
        Erkennt Outro-Animation aus dem Prompt.

        Returns:
            Dict mit outro_type, outro_direction/origin, outro_duration
        """
        result = None

        # Prüfe alle Outro-Keywords
        for keyword, config in self.OUTRO_KEYWORDS.items():
            if keyword in prompt:
                result = config.copy()
                # Dauer erkennen
                duration_match = re.search(
                    r'outro\s+(?:für|for)?\s*(\d+(?:\.\d+)?)\s*(?:sekunden?|seconds?|s)',
                    prompt
                )
                if duration_match:
                    result["outro_duration"] = float(duration_match.group(1))
                else:
                    result["outro_duration"] = 0.5  # Default
                break

        return result

    def _parse_temporal_effects(self, prompt: str) -> List[TimedEffect]:
        """
        Extrahiert zeitbasierte Effekte aus dem Prompt.

        Unterstützte Patterns:
        - "am anfang schwarz weiß für 2 sekunden"
        - "am ende fade out"
        - "für 3 sekunden schwarz weiß"
        - "bei sekunde 5 freeze"
        - "wenn ich 'wort' sage, dann freeze für 2 sekunden"

        Returns:
            Liste von TimedEffect Objekten
        """
        effects = []

        # Pattern 1: "am anfang <effekt> für <n> sekunden"
        pattern1 = re.compile(
            r'am\s+anfang\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern1.finditer(prompt):
            effect_text = match.group(1).strip()
            duration = float(match.group(2)) if match.group(2) else 2.0
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="start",
                    effect=effect_type,
                    duration=duration
                ))

        # Pattern 2: "am ende <effekt> für <n> sekunden"
        pattern2 = re.compile(
            r'am\s+ende\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern2.finditer(prompt):
            effect_text = match.group(1).strip()
            duration = float(match.group(2)) if match.group(2) else 2.0
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="end",
                    effect=effect_type,
                    duration=duration
                ))

        # Pattern 3: "für <n> sekunden <effekt>" (am Anfang) - Effekt maximal 3 Worte
        # Nur matchen wenn Prompt MIT "für X sekunden" BEGINNT oder nach Komma/Punkt
        pattern3 = re.compile(
            r'(?:^|[.,]\s*)für\s+(\d+(?:\.\d+)?)\s*sekunden?\s+(\w+(?:\s+\w+){0,2})(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern3.finditer(prompt):
            duration = float(match.group(1))
            effect_text = match.group(2).strip()
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="start",
                    effect=effect_type,
                    duration=duration
                ))

        # Pattern 4: "bei sekunde <n> <effekt> für <n> sekunden"
        pattern4 = re.compile(
            r'bei\s+sekunde\s+(\d+(?:\.\d+)?)\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern4.finditer(prompt):
            time_value = float(match.group(1))
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 2.0
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="absolute",
                    time_value=time_value,
                    effect=effect_type,
                    duration=duration
                ))

        # Pattern 5: "wenn ich '<wort>' sage, dann <effekt> für <n> sekunden"
        pattern5 = re.compile(
            r"wenn\s+(?:ich\s+)?['\"]([^'\"]+)['\"]\s+(?:sage|sag)\s*,?\s*(?:dann\s+)?(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)",
            re.IGNORECASE
        )
        for match in pattern5.finditer(prompt):
            word_trigger = match.group(1).strip().lower()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 1.0
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="word",
                    word_trigger=word_trigger,
                    effect=effect_type,
                    duration=duration
                ))

        # Pattern 6: "bei '<wort>' <effekt> für <n> sekunden"
        pattern6 = re.compile(
            r"bei\s+['\"]([^'\"]+)['\"]\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)",
            re.IGNORECASE
        )
        for match in pattern6.finditer(prompt):
            word_trigger = match.group(1).strip().lower()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 1.0
            effect_type = self._match_timed_effect(effect_text)
            if effect_type:
                effects.append(TimedEffect(
                    position="word",
                    word_trigger=word_trigger,
                    effect=effect_type,
                    duration=duration
                ))

        return effects

    def _match_timed_effect(self, text: str) -> Optional[str]:
        """Matched einen Effekt-Text gegen bekannte Effekte."""
        text_lower = text.lower()
        for keyword, effect_type in self.TIMED_EFFECT_KEYWORDS.items():
            if keyword in text_lower:
                return effect_type
        return None

    def _parse_action_triggers(self, prompt: str) -> List[ActionEffect]:
        """
        Extrahiert action-basierte Effekte aus dem Prompt.

        Unterstützte Patterns:
        - "da wo ich hinfalle schwarz weiß für 3 sekunden"
        - "wenn ich falle, dann freeze"
        - "beim fallen slowmo"

        Returns:
            Liste von ActionEffect Objekten
        """
        effects = []

        # Pattern 1: "da wo ich <action> <effekt> für <n> sekunden"
        pattern1 = re.compile(
            r'(?:da\s+)?wo\s+(?:ich\s+)?(.+?)\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern1.finditer(prompt):
            action_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 3.0

            action = self._match_action(action_text)
            effect = self._match_timed_effect(effect_text)

            if action and effect:
                effects.append(ActionEffect(
                    action=action,
                    effect=effect,
                    duration=duration
                ))

        # Pattern 2: "wenn ich <action>, dann <effekt> für <n> sekunden"
        pattern2 = re.compile(
            r'wenn\s+(?:ich\s+)?(.+?)\s*,?\s*(?:dann\s+)?(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern2.finditer(prompt):
            action_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 3.0

            action = self._match_action(action_text)
            effect = self._match_timed_effect(effect_text)

            # Nur wenn beides erkannt wurde und nicht bereits ein word trigger
            if action and effect and "'" not in match.group(0) and '"' not in match.group(0):
                effects.append(ActionEffect(
                    action=action,
                    effect=effect,
                    duration=duration
                ))

        # Pattern 3: "beim <action> <effekt> für <n> sekunden"
        pattern3 = re.compile(
            r'beim?\s+(.+?)\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern3.finditer(prompt):
            action_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 3.0

            action = self._match_action(action_text)
            effect = self._match_timed_effect(effect_text)

            if action and effect:
                effects.append(ActionEffect(
                    action=action,
                    effect=effect,
                    duration=duration
                ))

        return effects

    def _match_action(self, text: str) -> Optional[str]:
        """Matched einen Action-Text gegen bekannte Actions."""
        text_lower = text.lower()
        for keyword, action_type in self.ACTION_KEYWORDS.items():
            if keyword in text_lower:
                return action_type
        return None

    def _parse_object_triggers(self, prompt: str) -> List[ObjectEffect]:
        """
        Extrahiert objekt-basierte Effekte aus dem Prompt.

        Unterstützte Patterns:
        - "wenn laptop sichtbar freeze für 2 sekunden"
        - "bei laptop slowmo"
        - "wenn handy erscheint zoom"
        - "stoppe das video wenn ich auf laptop zeige"

        Returns:
            Liste von ObjectEffect Objekten
        """
        effects = []

        # Pattern 1: "wenn <objekt> sichtbar/erscheint <effekt> für <n> sekunden"
        pattern1 = re.compile(
            r'wenn\s+(\w+)\s+(?:sichtbar|erscheint|auftaucht|zeig[est]*)\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern1.finditer(prompt):
            obj_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 2.0

            obj_name = self._match_object(obj_text)
            effect = self._match_timed_effect(effect_text)

            if obj_name and effect:
                effects.append(ObjectEffect(
                    object_name=obj_name,
                    effect=effect,
                    duration=duration,
                    trigger="visible"
                ))

        # Pattern 2: "bei <objekt> <effekt> für <n> sekunden"
        pattern2 = re.compile(
            r'bei\s+(\w+)\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern2.finditer(prompt):
            obj_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 2.0

            obj_name = self._match_object(obj_text)
            effect = self._match_timed_effect(effect_text)

            # Nur wenn es ein bekanntes Objekt ist (nicht bei "bei sekunde 5")
            if obj_name and effect and not obj_text.isdigit():
                effects.append(ObjectEffect(
                    object_name=obj_name,
                    effect=effect,
                    duration=duration,
                    trigger="visible"
                ))

        # Pattern 3: "stoppe/freeze wenn <objekt>" oder "stoppe wenn ich auf <objekt> zeige"
        pattern3 = re.compile(
            r'(?:stoppe?|freeze|anhalten)\s+(?:das\s+video\s+)?(?:wenn|bei)\s+(?:ich\s+)?(?:auf\s+)?(?:mein(?:en?|e)?\s+)?(\w+)(?:\s+zeig[est]*)?(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?',
            re.IGNORECASE
        )
        for match in pattern3.finditer(prompt):
            obj_text = match.group(1).strip()
            duration = float(match.group(2)) if match.group(2) else 2.0

            obj_name = self._match_object(obj_text)

            if obj_name:
                effects.append(ObjectEffect(
                    object_name=obj_name,
                    effect="freeze_frame",
                    duration=duration,
                    trigger="visible"
                ))

        # Pattern 4: "<objekt> sichtbar -> <effekt>"
        pattern4 = re.compile(
            r'(\w+)\s+(?:ist\s+)?(?:sichtbar|da|erkannt)\s*[-:>]+\s*(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern4.finditer(prompt):
            obj_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 2.0

            obj_name = self._match_object(obj_text)
            effect = self._match_timed_effect(effect_text)

            if obj_name and effect:
                effects.append(ObjectEffect(
                    object_name=obj_name,
                    effect=effect,
                    duration=duration,
                    trigger="visible"
                ))

        # Pattern 5: "wenn ich auf <objekt> zeige <effekt> für <n> sekunden"
        pattern5 = re.compile(
            r'wenn\s+(?:ich\s+)?(?:auf\s+)?(?:mein(?:en?|e)?\s+)?(\w+)\s+zeig[est]*\s+(.+?)(?:\s+für\s+(\d+(?:\.\d+)?)\s*sekunden?)?(?:\s+und|\s*$|\s*,|\.)',
            re.IGNORECASE
        )
        for match in pattern5.finditer(prompt):
            obj_text = match.group(1).strip()
            effect_text = match.group(2).strip()
            duration = float(match.group(3)) if match.group(3) else 2.0

            obj_name = self._match_object(obj_text)
            effect = self._match_timed_effect(effect_text)

            if obj_name and effect:
                effects.append(ObjectEffect(
                    object_name=obj_name,
                    effect=effect,
                    duration=duration,
                    trigger="visible"
                ))

        return effects

    def _match_object(self, text: str) -> Optional[str]:
        """Matched einen Objekt-Text gegen bekannte Objekte."""
        text_lower = text.lower()
        if text_lower in self.OBJECT_KEYWORDS:
            return self.OBJECT_KEYWORDS[text_lower]
        return None

    # =========================================================================
    # AUDIO-REAKTIVE EFFEKTE PARSING
    # =========================================================================

    AUDIO_TRIGGER_KEYWORDS = {
        # Beat
        "beat|takt|rhythmus|schlag": "beat",
        "jedem beat|every beat|auf den beat|on beat": "beat",
        # Bass Drop
        "bass drop|bassdrop|drop|beim drop": "bass_drop",
        "bass|tiefe frequenz": "bass_drop",
        # Lautstärke
        "laut|loud|wenn laut|when loud": "loud",
        "leise|quiet|wenn leise|when quiet": "quiet",
        "lautstärke|volume": "volume",
        # Cuts/Schnitte
        "cut|schnitt|übergang|transition": "cut",
        "jedem cut|every cut|jedem schnitt": "cut",
    }

    AUDIO_EFFECT_KEYWORDS = {
        "flash|blitz|aufblitzen": "flash",
        "shake|wackeln|schütteln": "shake",
        "zoom|reinzoomen": "zoom",
        "glitch|störung": "glitch",
        "slowmo|zeitlupe": "slowmo",
    }

    def _parse_audio_triggers(self, prompt: str) -> List[AudioEffect]:
        """
        Extrahiert audio-reaktive Effekte aus dem Prompt.

        Unterstützte Patterns:
        - "flash bei jedem beat"
        - "beim bass drop zoom"
        - "shake wenn laut"
        """
        effects = []

        # Pattern 1: "<effekt> bei/auf <trigger>"
        pattern1 = re.compile(
            r'(flash|blitz|shake|wackeln|zoom|glitch)\s+(?:bei|auf|on)\s+(?:jedem\s+)?(\w+)',
            re.IGNORECASE
        )
        for match in pattern1.finditer(prompt):
            effect_text = match.group(1).lower()
            trigger_text = match.group(2).lower()

            effect = self._match_audio_effect(effect_text)
            trigger = self._match_audio_trigger(trigger_text)

            if effect and trigger:
                effects.append(AudioEffect(trigger=trigger, effect=effect))

        # Pattern 2: "bei/beim <trigger> <effekt>"
        pattern2 = re.compile(
            r'(?:bei|beim|on|at)\s+(?:jedem\s+)?(\w+(?:\s+\w+)?)\s+(flash|blitz|shake|wackeln|zoom|glitch|slowmo)',
            re.IGNORECASE
        )
        for match in pattern2.finditer(prompt):
            trigger_text = match.group(1).lower()
            effect_text = match.group(2).lower()

            trigger = self._match_audio_trigger(trigger_text)
            effect = self._match_audio_effect(effect_text)

            if effect and trigger:
                # Vermeid Duplikate
                if not any(e.trigger == trigger and e.effect == effect for e in effects):
                    effects.append(AudioEffect(trigger=trigger, effect=effect))

        # Pattern 3: "beat sync" allgemein
        if re.search(r'beat\s*sync|musik\s*sync|music\s*sync', prompt, re.IGNORECASE):
            if not any(e.trigger == "beat" for e in effects):
                effects.append(AudioEffect(trigger="beat", effect="zoom", intensity=0.8))

        return effects

    def _match_audio_trigger(self, text: str) -> Optional[str]:
        """Matched Audio-Trigger."""
        text = text.lower()
        for pattern, trigger in self.AUDIO_TRIGGER_KEYWORDS.items():
            if re.search(pattern, text):
                return trigger
        return None

    def _match_audio_effect(self, text: str) -> Optional[str]:
        """Matched Audio-Effekt."""
        text = text.lower()
        for pattern, effect in self.AUDIO_EFFECT_KEYWORDS.items():
            if re.search(pattern, text):
                return effect
        return None

    # =========================================================================
    # GESICHTS-EFFEKTE PARSING
    # =========================================================================

    FACE_EFFECT_KEYWORDS = {
        "zoom|zoom auf gesicht|face zoom|gesicht zoom": "zoom",
        "blur|unscharf|verpixel|anonymisier": "blur",
        "spotlight|scheinwerfer|fokus": "spotlight",
        "track|folgen|verfolg": "track",
    }

    def _parse_face_triggers(self, prompt: str) -> List[FaceEffect]:
        """
        Extrahiert gesichts-basierte Effekte aus dem Prompt.

        Unterstützte Patterns:
        - "zoom auf gesicht"
        - "gesicht verpixeln"
        - "spotlight auf gesicht"
        """
        effects = []

        # Pattern 1: "<effekt> auf gesicht"
        pattern1 = re.compile(
            r'(zoom|blur|unscharf|verpixel|spotlight|fokus)\s+(?:auf\s+)?(?:das\s+)?gesicht',
            re.IGNORECASE
        )
        for match in pattern1.finditer(prompt):
            effect_text = match.group(1).lower()
            effect = self._match_face_effect(effect_text)
            if effect:
                effects.append(FaceEffect(effect=effect))

        # Pattern 2: "gesicht <effekt>"
        pattern2 = re.compile(
            r'gesicht(?:er)?\s+(zoom|blur|unscharf|verpixel|spotlight|anonymisier)',
            re.IGNORECASE
        )
        for match in pattern2.finditer(prompt):
            effect_text = match.group(1).lower()
            effect = self._match_face_effect(effect_text)
            if effect and not any(e.effect == effect for e in effects):
                effects.append(FaceEffect(effect=effect))

        # Pattern 3: Keywords direkt
        if re.search(r'face\s*zoom|gesicht\s*zoom', prompt, re.IGNORECASE):
            if not any(e.effect == "zoom" for e in effects):
                effects.append(FaceEffect(effect="zoom", intensity=1.5))

        if re.search(r'face\s*blur|gesicht\s*blur|anonymisier', prompt, re.IGNORECASE):
            if not any(e.effect == "blur" for e in effects):
                effects.append(FaceEffect(effect="blur", intensity=30))

        if re.search(r'spotlight|scheinwerfer', prompt, re.IGNORECASE):
            if not any(e.effect == "spotlight" for e in effects):
                effects.append(FaceEffect(effect="spotlight"))

        return effects

    def _match_face_effect(self, text: str) -> Optional[str]:
        """Matched Gesichts-Effekt."""
        text = text.lower()
        for pattern, effect in self.FACE_EFFECT_KEYWORDS.items():
            if re.search(pattern, text):
                return effect
        return None

    # =========================================================================
    # BILDGENERIERUNG PARSING
    # =========================================================================

    def _parse_image_generation(self, prompt: str) -> Optional[ImageGenConfig]:
        """
        Erkennt Bildgenerierungs-Konfiguration aus dem Prompt.

        Unterstützte Patterns:
        - "generiere bilder"
        - "bilder zu keywords einfügen"
        - "passende bilder generieren"
        - "generiere bilder für 'auto' und 'strand'"
        """
        # Prüfe ob Bildgenerierung gewünscht
        image_gen_patterns = [
            r'generiere?\s+bilder',
            r'bilder?\s+generieren',
            r'bilder?\s+einfügen',
            r'passende\s+bilder',
            r'ai\s+bilder|ki\s+bilder',
            r'stable\s+diffusion',
            r'generate\s+images',
        ]

        enabled = any(re.search(p, prompt, re.IGNORECASE) for p in image_gen_patterns)

        # Prüfe auch ob manuelle Bilder angegeben sind (bei sekunde X ...)
        has_manual = bool(re.search(r'(?:bei\s+)?sekunde\s+\d|bei\s+\d+\s*s|\d+s[:\s]+\w', prompt, re.IGNORECASE))

        if not enabled and not has_manual:
            return None

        config = ImageGenConfig(enabled=enabled or has_manual)

        # Spezifische Keywords extrahieren
        # Pattern: "bilder für 'auto' und 'strand'" oder "bilder zu auto, strand"
        keyword_pattern = re.compile(
            r"(?:bilder?\s+(?:für|zu|bei|von)\s+)['\"]?(\w+)['\"]?(?:\s+(?:und|,)\s+['\"]?(\w+)['\"]?)*",
            re.IGNORECASE
        )
        match = keyword_pattern.search(prompt)
        if match:
            keywords = [g for g in match.groups() if g]
            config.keywords = keywords

        # Position extrahieren
        if re.search(r'oben\s+links|top\s*left', prompt, re.IGNORECASE):
            config.position = "top_left"
        elif re.search(r'oben\s+rechts|top\s*right', prompt, re.IGNORECASE):
            config.position = "top_right"
        elif re.search(r'unten\s+links|bottom\s*left', prompt, re.IGNORECASE):
            config.position = "bottom_left"
        elif re.search(r'unten\s+rechts|bottom\s*right', prompt, re.IGNORECASE):
            config.position = "bottom_right"
        elif re.search(r'mitte|center|zentriert', prompt, re.IGNORECASE):
            config.position = "center"

        # Größe extrahieren
        if re.search(r'klein|small', prompt, re.IGNORECASE):
            config.size = 0.15
        elif re.search(r'groß|large|big', prompt, re.IGNORECASE):
            config.size = 0.35
        elif re.search(r'fullscreen|vollbild', prompt, re.IGNORECASE):
            config.style = "fullscreen"
            config.size = 1.0

        # Max Bilder
        max_match = re.search(r'(\d+)\s*bilder', prompt, re.IGNORECASE)
        if max_match:
            config.max_images = min(int(max_match.group(1)), 10)

        # Manuelle Bilder mit Zeitangabe parsen
        # Patterns: "bei sekunde 5 zeige strand", "bei 12s auto", "sekunde 3 pizza"
        manual_patterns = [
            # "bei sekunde 5 zeige strand bild"
            r'bei\s+sekunde\s+(\d+(?:\.\d+)?)\s+(?:zeige?\s+)?(\w+)',
            # "bei 5s strand" oder "bei 5 sek auto"
            r'bei\s+(\d+(?:\.\d+)?)\s*(?:s|sek|sekunden?)?\s+(?:zeige?\s+)?(\w+)',
            # "sekunde 5: strand" oder "sekunde 5 strand"
            r'sekunde\s+(\d+(?:\.\d+)?)[:\s]+(\w+)',
            # "at second 5 show beach"
            r'at\s+(?:second\s+)?(\d+(?:\.\d+)?)\s*s?\s+(?:show\s+)?(\w+)',
            # "5s: strand" oder "12s auto"
            r'(\d+(?:\.\d+)?)\s*s[:\s]+(\w+)',
        ]

        manual_images = []
        for pattern in manual_patterns:
            matches = re.finditer(pattern, prompt, re.IGNORECASE)
            for match in matches:
                try:
                    timestamp = float(match.group(1))
                    keyword = match.group(2).lower()
                    # Ignoriere generische Wörter
                    if keyword not in ['bild', 'image', 'zeige', 'show', 'ein', 'eine', 'das', 'the']:
                        manual_images.append(ManualImage(
                            timestamp=timestamp,
                            keyword=keyword,
                            duration=0.8,
                            style="fullscreen"
                        ))
                except (ValueError, IndexError):
                    continue

        # Duplikate entfernen (gleiche Sekunde)
        seen_times = set()
        unique_images = []
        for img in manual_images:
            if img.timestamp not in seen_times:
                seen_times.add(img.timestamp)
                unique_images.append(img)
        config.manual_images = unique_images

        # Wenn manuelle Bilder angegeben, aktiviere Bildgenerierung
        if config.manual_images:
            config.enabled = True
            config.style = "fullscreen"
            print(f"    {len(config.manual_images)} manuelle Bilder: {[(img.timestamp, img.keyword) for img in config.manual_images]}")

        return config

    def _detect_base_style(self, prompt: str) -> str:
        """Erkennt den Basis-Stil aus dem Prompt."""
        best_style = "viral"  # Standard-Stil
        best_count = 0

        for style_name, style_data in self.STYLE_KEYWORDS.items():
            count = sum(1 for kw in style_data["keywords"] if kw in prompt)
            if count > best_count:
                best_count = count
                best_style = style_data["style"]

        return best_style

    # Negations-Wörter die Effekte deaktivieren
    NEGATION_WORDS = [
        "kein", "keine", "keinen", "keiner", "nicht", "ohne", "nie", "niemals",
        "no", "not", "without", "never", "don't", "dont", "disable", "deaktivieren"
    ]

    def _is_negated(self, prompt: str, keyword: str) -> bool:
        """Prüft ob ein Keyword negiert wird (z.B. 'kein glitch')."""
        # Finde Position des Keywords
        pos = prompt.find(keyword)
        if pos == -1:
            return False

        # Prüfe die 30 Zeichen vor dem Keyword auf Negation
        before = prompt[max(0, pos - 30):pos].lower()

        for neg in self.NEGATION_WORDS:
            if neg in before:
                return True

        return False

    def _detect_effects(self, prompt: str) -> List[Tuple[str, dict]]:
        """Erkennt Effekte aus dem Prompt (mit Negations-Erkennung)."""
        detected = []
        disabled = []

        for effect_name, effect_data in self.EFFECT_KEYWORDS.items():
            for keyword in effect_data["keywords"]:
                if keyword in prompt:
                    # Prüfe ob negiert
                    if self._is_negated(prompt, keyword):
                        # Effekt soll DEAKTIVIERT werden
                        disabled.append(effect_name)
                        config = effect_data["config"].copy()
                        # Setze alle boolean-Werte auf False
                        for key, value in config.items():
                            if isinstance(value, bool):
                                config[key] = False
                        detected.append((f"OHNE_{effect_name}", config))
                    else:
                        # Effekt soll AKTIVIERT werden
                        detected.append((effect_name, effect_data["config"].copy()))
                    break

        return detected

    def _apply_intensity_modifiers(self, prompt: str, config: dict):
        """Wendet Intensitäts-Modifikatoren auf numerische Werte an."""
        # Finde Modifikatoren im Prompt
        modifier = 1.0
        for keyword, value in self.INTENSITY_KEYWORDS.items():
            if keyword in prompt:
                modifier = value
                break

        if modifier == 1.0:
            return

        # Wende auf numerische Werte an
        intensity_keys = [
            "rgb_split_intensity", "vhs_intensity", "film_grain_intensity",
            "light_leak_intensity", "shake_intensity", "vignette_intensity",
            "zoom_intensity", "beat_zoom_intensity"
        ]

        for key in intensity_keys:
            if key in config and isinstance(config[key], (int, float)):
                config[key] = config[key] * modifier

    def _generate_description(self, analysis: PromptAnalysis) -> str:
        """Generiert eine Beschreibung der erkannten Konfiguration."""
        parts = [f"Basis: {analysis.base_style}"]

        if analysis.detected_keywords:
            parts.append(f"Effekte: {', '.join(analysis.detected_keywords)}")

        if analysis.custom_highlights:
            highlight_words = list(analysis.custom_highlights.keys())
            parts.append(f"Wort-Highlights: {', '.join(highlight_words)}")

        # Untertitel-Farbe anzeigen
        sub_color = analysis.effects.get("subtitle_color")
        if sub_color and sub_color != (255, 255, 255):
            color_name = "custom"
            for name, rgb in self.HIGHLIGHT_COLORS.items():
                if rgb == sub_color:
                    color_name = name
                    break
            parts.append(f"Textfarbe: {color_name}")

        # Intro/Outro Animation
        if analysis.intro_animation:
            intro_type = analysis.intro_animation.get("intro_type", "")
            parts.append(f"Intro: {intro_type}")

        if analysis.outro_animation:
            outro_type = analysis.outro_animation.get("outro_type", "")
            parts.append(f"Outro: {outro_type}")

        # Zeitbasierte Effekte
        if analysis.timed_effects:
            timed_strs = [f"{te.effect}@{te.position}" for te in analysis.timed_effects]
            parts.append(f"Timed: {', '.join(timed_strs)}")

        # Action-basierte Effekte
        if analysis.action_effects:
            action_strs = [f"{ae.effect}@{ae.action}" for ae in analysis.action_effects]
            parts.append(f"Actions: {', '.join(action_strs)}")

        # Objekt-basierte Effekte
        if analysis.object_effects:
            object_strs = [f"{oe.effect}@{oe.object_name}" for oe in analysis.object_effects]
            parts.append(f"Objects: {', '.join(object_strs)}")

        return " | ".join(parts)

    def get_config_from_prompt(self, prompt: str) -> dict:
        """
        Convenience-Methode: Gibt direkt die Konfiguration zurück.

        Args:
            prompt: Natürlichsprachlicher Prompt

        Returns:
            Konfiguration als dict
        """
        analysis = self.analyze(prompt)
        return analysis.effects

    def explain_prompt(self, prompt: str) -> str:
        """
        Erklärt was aus dem Prompt erkannt wurde.

        Args:
            prompt: Natürlichsprachlicher Prompt

        Returns:
            Erklärungstext
        """
        analysis = self.analyze(prompt)

        lines = [
            f"Prompt: \"{prompt}\"",
            f"",
            f"Erkannter Basis-Stil: {analysis.base_style}",
            f"Erkannte Effekte: {', '.join(analysis.detected_keywords) if analysis.detected_keywords else 'keine zusätzlichen'}",
            f"Konfidenz: {analysis.confidence * 100:.0f}%",
            f"",
            f"Resultierende Konfiguration:"
        ]

        # Wichtigste Einstellungen zeigen
        config = analysis.effects
        important_settings = [
            ("Stille entfernen", config.get("remove_silence", False)),
            ("Smart Zoom", config.get("smart_zoom", False)),
            ("Untertitel", config.get("enable_subtitles", False)),
            ("Untertitel-Stil", config.get("subtitle_style", "-")),
            ("Wort-Highlights", config.get("enable_highlights", False)),
            ("Emojis", config.get("enable_emojis", False)),
            ("RGB Split", config.get("rgb_split", False)),
            ("VHS Effekt", config.get("vhs_effect", False)),
            ("Film Grain", config.get("film_grain", False)),
            ("Beat Sync", config.get("beat_sync", False)),
            ("Auto-Reframe", config.get("auto_reframe", False)),
        ]

        for name, value in important_settings:
            if value:
                lines.append(f"  - {name}: {value}")

        # Untertitel-Einstellungen
        sub_color = config.get("subtitle_color")
        if sub_color:
            color_name = "weiß"
            for name, rgb in self.HIGHLIGHT_COLORS.items():
                if rgb == sub_color:
                    color_name = name
                    break
            lines.append(f"  - Textfarbe: {color_name} {sub_color}")

        sub_effect = config.get("subtitle_effect")
        if sub_effect:
            lines.append(f"  - Text-Effekt: {sub_effect}")

        fontsize_mult = config.get("subtitle_fontsize_multiplier")
        if fontsize_mult and fontsize_mult != 1.0:
            lines.append(f"  - Schriftgröße: {fontsize_mult:.1f}x")

        # Wort-Trigger anzeigen
        if analysis.custom_highlights:
            lines.append(f"")
            lines.append(f"Wort-Trigger:")
            for word, config in analysis.custom_highlights.items():
                color = config.get("color", "Standard")
                effect = config.get("effect", "keiner")
                sound = config.get("sound", "keiner")
                lines.append(f"  - '{word}': Farbe={color}, Effekt={effect}, Sound={sound}")

        return "\n".join(lines)


# Beispiele für Prompts
EXAMPLE_PROMPTS = [
    "mach es dynamisch mit glitch effekten und schnellen schnitten",
    "ruhiges video mit karaoke untertiteln und sanften übergängen",
    "für tiktok optimieren, hochformat mit beat sync",
    "cinematic look mit letterbox und film grain",
    "retro vhs style mit rgb split",
    "musik video mit beat zoom und pulsierenden effekten",
    "minimalistisch, nur stille entfernen",
    "professionell mit untertiteln aber ohne emojis",
    "sehr intensiver glitch mit starkem rgb split",
    "subtile effekte, leichte vignette und soft übergänge",
    # NEU: Intro/Outro-Animationen
    "video kommt von rechts mit bounce effekt",
    "von oben reinsliden",
    "intro mit spin effekt",
    # NEU: Temporale Referenzen
    "am anfang schwarz weiß für 2 sekunden",
    "am ende fade out",
    "bei sekunde 5 freeze für 1 sekunde",
    "wenn ich 'krass' sage freeze für 1 sekunde",
    "bei 'wow' flash",
    # NEU: Action-basierte Effekte
    "da wo ich hinfalle slowmo für 3 sekunden",
    "beim fallen schwarz weiß",
    "wenn ich springe zoom für 2 sekunden",
    # NEU: Kombiniert
    "video von oben, wenn ich 'wow' sage zoom und beim hinfallen freeze",
    # NEU: Objekterkennung
    "wenn laptop sichtbar freeze für 2 sekunden",
    "bei handy slowmo",
    "stoppe das video wenn ich auf laptop zeige",
    "wenn tv erscheint zoom für 3 sekunden",
]


def get_example_prompts() -> List[str]:
    """Gibt Beispiel-Prompts zurück."""
    return EXAMPLE_PROMPTS.copy()
