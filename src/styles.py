"""
Stil-Definitionen v5.0 - Alle Effekte

Stile:
- ruhig: Blur-Übergänge, Karaoke-Untertitel, sanft
- balanced: Swipe-Übergänge, moderne Untertitel, ausgewogen
- dynamisch: Glitch-Übergänge, VHS, RGB Split, intensiv
- cinematic: Filmischer Look mit Letterbox
- retro: VHS/Vintage Effekte
- music: Beat-Sync Effekte
- clean: Schlichte weiße Untertitel mit Phrase-Kontext (TikTok Style)
"""

STYLES = {
    "ruhig": {
        "name": "Ruhig",
        "description": "Blur-Übergänge, sanfte Zooms, Karaoke-Untertitel",

        # Schnitte
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 1.0,
        "keep_padding": 0.3,

        # Übergänge
        "transition_in": "blur",
        "transition_out": "blur",
        "transition_duration": 0.5,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.08,

        # Visuelle Effekte
        "vignette_intensity": 0.2,
        "color_grade": "ruhig",
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "karaoke",
        "subtitle_color": (255, 255, 255),  # Weiß
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": True,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": True,
        "sound_cuts": False,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "balanced": {
        "name": "Balanced",
        "description": "Swipe-Übergänge, moderne Untertitel, ausgewogen",

        # Schnitte
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.7,
        "keep_padding": 0.2,

        # Übergänge
        "transition_in": "swipe",
        "transition_out": "swipe",
        "transition_duration": 0.4,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.12,

        # Visuelle Effekte
        "vignette_intensity": 0.25,
        "color_grade": "balanced",
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": True,
        "light_leak_intensity": 0.15,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": True,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": True,
        "sound_cuts": False,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "dynamisch": {
        "name": "Dynamisch",
        "description": "Glitch-Übergänge, RGB Split, intensive Effekte",

        # Schnitte - energisch aber sauber
        "remove_silence": True,
        "silence_threshold": 0.03,
        "min_silence_to_cut": 0.55,
        "keep_padding": 0.25,

        # Übergänge
        "transition_in": "glitch",
        "transition_out": "zoom",
        "transition_duration": 0.25,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.18,

        # Visuelle Effekte
        "vignette_intensity": 0.3,
        "color_grade": "dynamisch",
        "cinematic_bars": False,
        "rgb_split": True,
        "rgb_split_intensity": 8,
        "vhs_effect": False,
        "film_grain": False,
        "film_grain_intensity": 0.15,
        "light_leak": True,
        "light_leak_intensity": 0.2,
        "shake": True,
        "shake_intensity": 3,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": True,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": True,
        "sound_cuts": True,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": True,
        "beat_zoom_intensity": 0.06,
    },

    "cinematic": {
        "name": "Cinematic",
        "description": "Filmischer Look mit Letterbox und Farbkorrektur",

        # Schnitte
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.8,
        "keep_padding": 0.25,

        # Übergänge
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.6,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.1,

        # Visuelle Effekte
        "vignette_intensity": 0.35,
        "color_grade": "cinematic",
        "cinematic_bars": True,
        "cinematic_bars_height": 0.1,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": True,
        "film_grain_intensity": 0.15,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "box",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": False,
        "sound_cuts": False,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "retro": {
        "name": "Retro",
        "description": "VHS-Effekt, Film Grain, Vintage-Look",

        # Schnitte
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.6,
        "keep_padding": 0.2,

        # Übergänge
        "transition_in": "pixelate",
        "transition_out": "blur",
        "transition_duration": 0.4,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": False,
        "zoom_intensity": 1.1,

        # Visuelle Effekte
        "vignette_intensity": 0.4,
        "color_grade": "vintage",
        "cinematic_bars": False,
        "rgb_split": True,
        "rgb_split_intensity": 5,
        "vhs_effect": True,
        "vhs_intensity": 0.4,
        "film_grain": True,
        "film_grain_intensity": 0.25,
        "light_leak": True,
        "light_leak_intensity": 0.25,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": True,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": True,
        "sound_cuts": False,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "music": {
        "name": "Music",
        "description": "Beat-Sync Effekte, Zoom Pulse, Schnitte auf Beat",

        # Schnitte
        "remove_silence": False,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.1,

        # Übergänge
        "transition_in": "zoom",
        "transition_out": "zoom",
        "transition_duration": 0.2,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.15,

        # Visuelle Effekte
        "vignette_intensity": 0.3,
        "color_grade": "dynamisch",
        "cinematic_bars": False,
        "rgb_split": True,
        "rgb_split_intensity": 10,
        "rgb_split_animated": True,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": True,
        "light_leak_intensity": 0.3,
        "shake": True,
        "shake_intensity": 4,
        "echo": True,
        "echo_count": 3,
        "mirror": False,

        # Untertitel
        "enable_subtitles": False,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": False,
        "sound_cuts": True,

        # Beat-Sync (Hauptfeature!)
        "beat_sync": True,
        "beat_sync_cuts": True,
        "beat_zoom": True,
        "beat_zoom_intensity": 0.08,
        "zoom_pulse": True,
        "zoom_pulse_frequency": 2.0,
    },

    "tiktok": {
        "name": "TikTok",
        "description": "Schnelle Schnitte, RGB Split, Glitch, 9:16 Format",

        # Schnitte - dynamisch aber natürlich
        "remove_silence": True,
        "silence_threshold": 0.03,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.2,

        # Übergänge
        "transition_in": "glitch",
        "transition_out": "swipe",
        "transition_duration": 0.15,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.2,

        # Visuelle Effekte
        "vignette_intensity": 0.2,
        "color_grade": "dynamisch",
        "cinematic_bars": False,
        "rgb_split": True,
        "rgb_split_intensity": 12,
        "rgb_split_animated": True,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": True,
        "light_leak_intensity": 0.2,
        "shake": True,
        "shake_intensity": 5,
        "echo": False,
        "mirror": False,

        # Auto-Reframe für Hochformat
        "auto_reframe": True,
        "target_ratio": "9:16",

        # Untertitel
        "enable_subtitles": True,
        "subtitle_style": "karaoke",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": True,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": True,
        "sound_cuts": True,

        # Beat-Sync
        "beat_sync": True,
        "beat_zoom": True,
        "beat_zoom_intensity": 0.1,
    },

    "viral": {
        "name": "Viral",
        "description": "TikTok/Reels Style - Wort-für-Wort Untertitel, Lila-Tint, Wort-Highlights",

        # Schnitte - viral aber natürlich
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.55,
        "keep_padding": 0.3,

        # Übergänge
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.2,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.15,

        # Visuelle Effekte
        "vignette_intensity": 0.2,
        "color_grade": "viral",  # Lila/Blau Tint
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel - Wort für Wort, zentriert
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),  # Weiß als Standard
        "subtitle_fontsize": None,  # Auto (basierend auf Video-Höhe)
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None  # Kein Glow für normale Untertitel
        "subtitle_stroke_width": 4,  # Outline-Dicke

        # Wort-Highlights (Farbe + Sound für bestimmte Wörter)
        "enable_highlights": True,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,   # Swoosh am Anfang
        "sound_outro": False,
        "sound_emojis": False,
        "sound_cuts": False,

        # Audio
        "audio_fade_in": 0.1,  # Kurzes Fade-In gegen Stimmenbruch

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "clean": {
        "name": "Clean",
        "description": "TikTok Style - Harte Schnitte, Clean Untertitel, 9:16",

        # Schnitte - TikTok Style (ausgewogen)
        "remove_silence": True,
        "silence_threshold": 0.035,
        "min_silence_to_cut": 0.35,
        "keep_padding": 0.12,
        "keep_padding_after": 0.1,
        "min_segment_length": 0.5,
        "merge_gap": 0.25,

        # Übergänge - KEINE (harte Cuts)
        "transition_in": "none",
        "transition_out": "none",
        "transition_duration": 0,

        # Auto-Reframe für TikTok/Reels (9:16)
        "auto_reframe": True,
        "target_ratio": "9:16",

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.05,

        # Visuelle Effekte - TikTok Premium Look
        "vignette_intensity": 0.12,
        "color_grade": "tiktok",  # Subtiler Lila/Blau-Stich
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel - Clean Style
        "enable_subtitles": True,
        "subtitle_style": "clean",  # NEU: Clean phrase-style
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_fontsize_multiplier": 1.0,
        "subtitle_effect": None,
        "subtitle_stroke_width": 2,
        "clean_words_per_phrase": 4,  # Wörter pro Phrase

        # Highlights deaktivieren für sauberen Look
        "enable_highlights": False,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": False,
        "sound_emojis": False,
        "sound_cuts": False,

        # Audio
        "audio_fade_in": 0.1,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },

    "minimal": {
        "name": "Minimal",
        "description": "Nur Stille entfernen, keine Effekte",

        # Schnitte
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.2,

        # Übergänge
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.3,

        # Zoom
        "enable_zoom": False,
        "smart_zoom": False,
        "zoom_intensity": 1.0,

        # Visuelle Effekte - alles aus
        "vignette_intensity": 0,
        "color_grade": "none",
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Untertitel
        "enable_subtitles": False,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,  # "highlight", "box", "pop" oder None
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": False,
        "sound_intro": False,
        "sound_outro": False,
        "sound_emojis": False,
        "sound_cuts": False,

        # Beat-Sync
        "beat_sync": False,
        "beat_zoom": False,
    },
}


def get_style(style_name: str) -> dict:
    """Gibt die Stil-Konfiguration zurück."""
    if style_name not in STYLES:
        available = ", ".join(STYLES.keys())
        raise ValueError(f"Unbekannter Stil: {style_name}. Verfügbar: {available}")
    return STYLES[style_name].copy()


def list_styles() -> list:
    """Gibt alle verfügbaren Stile zurück."""
    return list(STYLES.keys())


def get_style_info() -> dict:
    """Gibt Info über alle Stile zurück."""
    return {
        name: {
            "name": style["name"],
            "description": style["description"]
        }
        for name, style in STYLES.items()
    }


def create_custom_style(base_style: str = "balanced", **overrides) -> dict:
    """
    Erstellt einen benutzerdefinierten Stil basierend auf einem bestehenden.

    Args:
        base_style: Basis-Stil
        **overrides: Zu überschreibende Einstellungen

    Returns:
        Neuer Stil als dict
    """
    style = get_style(base_style)
    style.update(overrides)
    return style
