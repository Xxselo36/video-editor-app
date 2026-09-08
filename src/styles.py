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
        "description": "Smooth and relaxed with soft transitions",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "A good mix of style and subtlety",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#0984e3",

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "High energy with bold visual effects",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "Movie-like feel with cinematic bars",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "Old-school vintage vibes",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "Effects synced to the beat of your audio",

        # Cuts
        "remove_silence": False,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.5,
        "keep_padding": 0.15,

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": False,
        "filler_sensitivity": "medium",
        "smart_cut": False,

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
        "description": "Vertical format, fast cuts, eye-catching",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "Optimized for going viral on social media",

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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Word highlights (color + sound for certain words)
        "enable_highlights": True,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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
        "description": "Clean white subtitles, 9:16 format",

        # Cuts - TikTok style (balanced)
        "remove_silence": True,
        "silence_threshold": 0.035,
        "min_silence_to_cut": 0.35,
        "keep_padding": 0.18,
        "keep_padding_after": 0.18,
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
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": True,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#6c5ce7",

        # Disable highlights for clean look
        "enable_highlights": False,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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

    "fast": {
        "name": "Fast",
        "description": "Fast cuts with word-by-word subtitles",

        # Cuts - aggressive
        "remove_silence": True,
        "silence_threshold": 0.03,
        "min_silence_to_cut": 0.3,
        "keep_padding": 0.15,
        "keep_padding_after": 0.15,
        "min_segment_length": 0.4,
        "merge_gap": 0.2,

        # Transitions
        "transition_in": "none",
        "transition_out": "none",
        "transition_duration": 0,

        # Zoom
        "enable_zoom": False,
        "smart_zoom": False,
        "zoom_intensity": 1.0,

        # Visual effects - off
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

        # Subtitles - word by word
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
        "subtitle_stroke_width": 4,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.90,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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

    "smooth": {
        "name": "Smooth",
        "description": "Smooth cuts with word-by-word subtitles",

        # Cuts - gentle
        "remove_silence": True,
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.9,
        "keep_padding": 0.3,
        "keep_padding_after": 0.25,
        "min_segment_length": 0.6,
        "merge_gap": 0.4,

        # Transitions
        "transition_in": "none",
        "transition_out": "none",
        "transition_duration": 0,

        # Zoom
        "enable_zoom": False,
        "smart_zoom": False,
        "zoom_intensity": 1.0,

        # Visual effects - off
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

        # Subtitles - word by word
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
        "subtitle_stroke_width": 4,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#00b894",

        # Filler & Smart Cut
        "remove_fillers": True,
        "filler_sensitivity": "medium",
        "smart_cut": True,

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

    "minimal": {
        "name": "Minimal",
        "description": "Tight cuts, no subtitles",

        # Cuts - same as clean (tight)
        "remove_silence": True,
        "silence_threshold": 0.035,
        "min_silence_to_cut": 0.35,
        "keep_padding": 0.18,
        "keep_padding_after": 0.18,
        "min_segment_length": 0.5,
        "merge_gap": 0.25,

        # Transitions
        "transition_in": "none",
        "transition_out": "none",
        "transition_duration": 0,

        # Zoom
        "enable_zoom": False,
        "smart_zoom": False,
        "zoom_intensity": 1.0,

        # Visual effects - off
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

        # Subtitles - off
        "enable_subtitles": False,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize": None,
        "subtitle_effect": None,
        "subtitle_stroke_width": 4,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,

        # Filler & Smart Cut
        "remove_fillers": False,
        "filler_sensitivity": "medium",
        "smart_cut": False,

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


# ========================================================================
# Standalone GUI: separate Cut Styles + Caption Styles
# ========================================================================

CUT_STYLES = {
    "tight": {
        "name": "Tight",
        "description": "Maximum silence removal",
        "silence_threshold": 0.035,
        "min_silence_to_cut": 0.35,
        "keep_padding": 0.18,
        "keep_padding_after": 0.18,
        "min_segment_length": 0.5,
        "merge_gap": 0.25,
    },
    "balanced": {
        "name": "Balanced",
        "description": "Good compromise",
        "silence_threshold": 0.025,
        "min_silence_to_cut": 0.6,
        "keep_padding": 0.2,
        "keep_padding_after": 0.15,
        "min_segment_length": 0.5,
        "merge_gap": 0.3,
    },
    "smooth": {
        "name": "Smooth",
        "description": "Natural flow preserved",
        "silence_threshold": 0.02,
        "min_silence_to_cut": 0.9,
        "keep_padding": 0.3,
        "keep_padding_after": 0.25,
        "min_segment_length": 0.6,
        "merge_gap": 0.4,
    },
}

CAPTION_STYLES = {
    "clean": {
        "name": "Clean",
        "description": "Phrase subtitles, highlight, background",
        "enable_subtitles": True,
        "subtitle_style": "clean",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 0.85,
        "subtitle_stroke_width": 2,
        # 5 Wörter pro Phrase → typisch 2 Zeilen (2+3 wrap), stabile
        # Größe durch den auf "shrink ab 3 Zeilen" gestellten Loop.
        "clean_words_per_phrase": 5,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.50,
        "subtitle_bg_enabled": True,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#6c5ce7",
    },
    "classic": {
        "name": "Classic",
        "description": "White text, black outline",
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_stroke_width": 4,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.85,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,
        # Up to 3 consecutive words shown together (width-permitting).
        # Editor will pack words greedily and fall back to fewer per row
        # when the combined text would overflow the video frame.
        "modern_words_per_phrase": 3,
    },
    "highlight": {
        "name": "Highlight",
        "description": "Red box behind active word",
        "enable_subtitles": True,
        "subtitle_style": "highlight",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 0.65,
        "subtitle_stroke_width": 3,
        "clean_words_per_phrase": 3,
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.75,
        "subtitle_bg_enabled": False,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#B11020",
        "_highlight_mode": "box",
        "_highlight_box_radius": 14,
        "_highlight_font": "impact",
        "subtitle_uppercase": True,
    },
    "subtle": {
        "name": "Subtle",
        "description": "Small, unobtrusive",
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 0.75,
        "subtitle_stroke_width": 2,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.90,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": None,
    },
    "elegant": {
        "name": "Elegant",
        "description": "Script font for nouns & verbs, golden accent",
        "enable_subtitles": True,
        "subtitle_style": "elegant",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 1.0,
        "subtitle_stroke_width": 3,
        # Match Clean: 6 words/phrase → typically wraps to 2 lines (3+3).
        "clean_words_per_phrase": 6,
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.75,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#E8A838",
    },
    "clipper": {
        "name": "Clipper",
        "description": "Bold comic font, bounce-in, word highlight",
        "enable_subtitles": True,
        "subtitle_style": "highlight",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 0.99,
        "subtitle_stroke_width": 5,
        "clean_words_per_phrase": 3,
        "subtitle_font": "Bangers",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.75,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#39FF14",
        "_highlight_font": "bangers",
    },
    "flash": {
        "name": "Flash",
        "description": "Heavy italic, bounce-in, word highlight",
        "enable_subtitles": True,
        "subtitle_style": "highlight",
        "subtitle_color": (255, 255, 255),
        "subtitle_fontsize_multiplier": 0.7,
        "subtitle_stroke_width": 5,
        "clean_words_per_phrase": 3,
        "subtitle_font": "Avenir Next Heavy Italic",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.75,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.6,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#0088CC",
        "_highlight_font": "avenir_italic",
    },
    "punch": {
        "name": "Punch",
        "description": "Bold yellow, one word at a time",
        "enable_subtitles": True,
        "subtitle_style": "modern",
        "subtitle_color": (255, 220, 0),
        "subtitle_fontsize_multiplier": 0.85,
        "subtitle_stroke_width": 0,
        "clean_words_per_phrase": 1,
        "subtitle_uppercase": True,
        "subtitle_glow": {"radius": 16, "alpha": 160, "color": (0, 0, 0)},
        "_font_candidates": [
            ("/System/Library/Fonts/Supplemental/GillSans.ttc", 1),
            ("/System/Library/Fonts/Supplemental/Arial Black.ttf", 0),
            ("C:/Windows/Fonts/arialbd.ttf", 0),
            ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
        ],
        "subtitle_font": "Arial Black",
        "subtitle_position": "bottom",
        "subtitle_position_y": 0.72,
        "subtitle_bg_enabled": False,
        "subtitle_bg_color": "#000000",
        "subtitle_bg_opacity": 0.0,
        "subtitle_outline_color": "#000000",
        "subtitle_highlight_color_hex": "#FFDC00",
    },
    "none": {
        "name": "None",
        "description": "No subtitles",
        "enable_subtitles": False,
    },
}


def build_combined_style(cut_key: str, caption_key: str) -> dict:
    """Build a full style config by combining a cut style + caption style on top of a base."""
    # Start from 'minimal' as base (no effects, no subtitles, tight cuts)
    config = get_style("minimal")

    # Apply cut overrides
    if cut_key in CUT_STYLES:
        for k, v in CUT_STYLES[cut_key].items():
            if k not in ("name", "description"):
                config[k] = v

    # Apply caption overrides
    if caption_key in CAPTION_STYLES:
        for k, v in CAPTION_STYLES[caption_key].items():
            if k not in ("name", "description"):
                config[k] = v

    # Remember which caption style was selected — useful downstream to
    # route between the legacy MoviePy compositor and the fast ASS renderer.
    config["_caption_key"] = caption_key

    # Always enable silence removal and smart cut for standalone
    config["remove_silence"] = True
    config["smart_cut"] = True
    config["remove_fillers"] = True

    return config
