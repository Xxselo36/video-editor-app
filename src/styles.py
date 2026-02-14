"""
Style Definitions v5.0 - All Effects

Styles:
- ruhig: Blur transitions, karaoke subtitles, calm
- balanced: Swipe transitions, modern subtitles, balanced
- dynamisch: Glitch transitions, VHS, RGB Split, intense
- cinematic: Film look with letterbox
- retro: VHS/Vintage effects
- music: Beat-sync effects
- clean: Clean white subtitles with phrase context (TikTok Style)
"""

STYLES = {
    "ruhig": {
        "name": "Calm",
        "description": "Blur transitions, smooth zooms, karaoke subtitles",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 1.0,
        "keep_padding": 0.3,

        # Transitions
        "transition_in": "blur",
        "transition_out": "blur",
        "transition_duration": 0.5,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.08,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "karaoke",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "description": "Swipe transitions, modern subtitles, balanced",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.7,
        "keep_padding": 0.2,

        # Transitions
        "transition_in": "swipe",
        "transition_out": "swipe",
        "transition_duration": 0.4,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.12,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "name": "Dynamic",
        "description": "Glitch transitions, RGB Split, intense effects",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.03,
        "min_silence_to_cut": 0.55,
        "keep_padding": 0.25,

        # Transitions
        "transition_in": "glitch",
        "transition_out": "zoom",
        "transition_duration": 0.25,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.18,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "description": "Film look with letterbox and color grading",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.8,
        "keep_padding": 0.25,

        # Transitions
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.6,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.1,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "box",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "description": "VHS effect, film grain, vintage look",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.6,
        "keep_padding": 0.2,

        # Transitions
        "transition_in": "pixelate",
        "transition_out": "blur",
        "transition_duration": 0.4,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": False,
        "zoom_intensity": 1.1,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "description": "Beat-sync effects, zoom pulse, beat-matched cuts",

        # Cuts
        "remove_silence": False,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.1,

        # Transitions
        "transition_in": "zoom",
        "transition_out": "zoom",
        "transition_duration": 0.2,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.15,

        # Visual effects
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

        # Subtitles
        "enable_subtitles": False,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
        "subtitle_stroke_width": 4,

        # Emojis
        "enable_emojis": False,

        # Sounds
        "enable_sounds": True,
        "sound_intro": True,
        "sound_outro": True,
        "sound_emojis": False,
        "sound_cuts": True,

        # Beat-Sync (main feature!)
        "beat_sync": True,
        "beat_sync_cuts": True,
        "beat_zoom": True,
        "beat_zoom_intensity": 0.08,
        "zoom_pulse": True,
        "zoom_pulse_frequency": 2.0,
    },

    "tiktok": {
        "name": "TikTok",
        "description": "Fast cuts, RGB Split, glitch, 9:16 format",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.03,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.2,

        # Transitions
        "transition_in": "glitch",
        "transition_out": "swipe",
        "transition_duration": 0.15,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.2,

        # Visual effects
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

        # Auto-reframe for vertical format
        "auto_reframe": True,
        "target_ratio": "9:16",

        # Subtitles
        "enable_subtitles": True,
        "subtitle_style": "karaoke",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
        "description": "TikTok/Reels style - word-by-word subtitles, purple tint, highlights",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.55,
        "keep_padding": 0.3,

        # Transitions
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.2,

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.15,

        # Visual effects
        "vignette_intensity": 0.2,
        "color_grade": "viral",
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Subtitles - word by word, centered
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
        "subtitle_stroke_width": 4,

        # Word highlights (color + sound for certain words)
        "enable_highlights": True,

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

    "clean": {
        "name": "Clean",
        "description": "TikTok Style - Hard cuts, clean subtitles, 9:16",

        # Cuts - TikTok style (balanced)
        "remove_silence": True,
        "silence_threshold": 0.035,
        "min_silence_to_cut": 0.35,
        "keep_padding": 0.12,
        "keep_padding_after": 0.1,
        "min_segment_length": 0.5,
        "merge_gap": 0.25,

        # Transitions - NONE (hard cuts)
        "transition_in": "none",
        "transition_out": "none",
        "transition_duration": 0,

        # Auto-reframe for TikTok/Reels (9:16)
        "auto_reframe": True,
        "target_ratio": "9:16",

        # Zoom
        "enable_zoom": True,
        "smart_zoom": True,
        "zoom_intensity": 1.05,

        # Visual effects - TikTok premium look
        "vignette_intensity": 0.12,
        "color_grade": "tiktok",
        "cinematic_bars": False,
        "rgb_split": False,
        "vhs_effect": False,
        "film_grain": False,
        "light_leak": False,
        "shake": False,
        "echo": False,
        "mirror": False,

        # Subtitles - Clean style
        "enable_subtitles": True,
        "subtitle_style": "clean",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_fontsize_multiplier": 1.0,
        "subtitle_effect": None,
        "subtitle_stroke_width": 2,
        "clean_words_per_phrase": 4,

        # Disable highlights for clean look
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
        "description": "Silence removal only, no effects",

        # Cuts
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.2,

        # Transitions
        "transition_in": "fade",
        "transition_out": "fade",
        "transition_duration": 0.3,

        # Zoom
        "enable_zoom": False,
        "smart_zoom": False,
        "zoom_intensity": 1.0,

        # Visual effects - all off
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

        # Subtitles
        "enable_subtitles": False,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
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
    """Returns the style configuration."""
    if style_name not in STYLES:
        available = ", ".join(STYLES.keys())
        raise ValueError(f"Unknown style: {style_name}. Available: {available}")
    return STYLES[style_name].copy()


def list_styles() -> list:
    """Returns all available style names."""
    return list(STYLES.keys())


def get_style_info() -> dict:
    """Returns info about all styles."""
    return {
        name: {
            "name": style["name"],
            "description": style["description"]
        }
        for name, style in STYLES.items()
    }


def create_custom_style(base_style: str = "balanced", **overrides) -> dict:
    """
    Creates a custom style based on an existing one.

    Args:
        base_style: Base style name
        **overrides: Settings to override

    Returns:
        New style as dict
    """
    style = get_style(base_style)
    style.update(overrides)
    return style
