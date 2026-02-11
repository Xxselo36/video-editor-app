"""
Effekt-Funktionen für Video-Bearbeitung v5.0 - ALLE EFFEKTE

Visuelle Effekte:
- Cinematic Bars, RGB Split, VHS/Retro, Film Grain
- Light Leaks, Shake, Speed Ramp, Freeze Frame
- Mirror/Split, Echo/Ghost

Text-Effekte:
- Typewriter, Bounce, Glitch Text, Neon Glow

Übergänge:
- Fade, Blur, Swipe, Glitch, Zoom

Zoom-Effekte:
- Smart Zoom, Zoom In/Out, Pan Zoom
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import cv2
from moviepy.editor import (
    VideoFileClip, concatenate_videoclips, TextClip,
    CompositeVideoClip, ImageClip, ColorClip
)
import random
import math


# =============================================================================
# FARB-KORREKTUREN
# =============================================================================

def adjust_brightness(clip, factor: float):
    """Helligkeit anpassen."""
    if factor == 0:
        return clip
    def f(frame):
        return np.clip(frame.astype(float) + (factor * 255), 0, 255).astype(np.uint8)
    return clip.fl_image(f)


def adjust_contrast(clip, factor: float):
    """Kontrast anpassen."""
    if factor == 1.0:
        return clip
    def f(frame):
        return np.clip((frame.astype(float) - 128) * factor + 128, 0, 255).astype(np.uint8)
    return clip.fl_image(f)


def adjust_saturation(clip, factor: float):
    """Sättigung anpassen."""
    if factor == 1.0:
        return clip
    def f(frame):
        gray = np.dot(frame[..., :3], [0.299, 0.587, 0.114])
        gray = np.stack([gray] * 3, axis=-1)
        return np.clip(gray + factor * (frame.astype(float) - gray), 0, 255).astype(np.uint8)
    return clip.fl_image(f)


def apply_color_grade(clip, style: str = "balanced"):
    """Wendet Farbgrading basierend auf dem Stil an."""
    if style == "ruhig":
        clip = adjust_brightness(clip, 0.02)
        clip = adjust_contrast(clip, 1.05)
        clip = adjust_saturation(clip, 0.95)
    elif style == "balanced":
        clip = adjust_brightness(clip, 0.03)
        clip = adjust_contrast(clip, 1.1)
        clip = adjust_saturation(clip, 1.05)
    elif style == "dynamisch":
        clip = adjust_brightness(clip, 0.05)
        clip = adjust_contrast(clip, 1.15)
        clip = adjust_saturation(clip, 1.15)
    elif style == "cinematic":
        clip = adjust_brightness(clip, -0.02)
        clip = adjust_contrast(clip, 1.2)
        clip = adjust_saturation(clip, 0.9)
    elif style == "vintage":
        clip = adjust_brightness(clip, 0.05)
        clip = adjust_contrast(clip, 0.95)
        clip = adjust_saturation(clip, 0.7)
    elif style == "viral":
        # Lila/Blau Tint wie in TikTok/Reels
        clip = adjust_brightness(clip, 0.02)
        clip = adjust_contrast(clip, 1.1)
        clip = adjust_saturation(clip, 1.05)
        clip = apply_purple_tint(clip, intensity=0.15)
    return clip


def apply_purple_tint(clip, intensity: float = 0.15):
    """Fügt einen Lila/Blau-Farbton hinzu (TikTok/Reels Style)."""
    def tint(frame):
        result = frame.astype(float)
        # Blau verstärken, Rot leicht verstärken, Grün reduzieren
        result[:, :, 0] = np.clip(result[:, :, 0] * (1 + intensity * 0.3), 0, 255)  # Rot
        result[:, :, 1] = np.clip(result[:, :, 1] * (1 - intensity * 0.1), 0, 255)  # Grün
        result[:, :, 2] = np.clip(result[:, :, 2] * (1 + intensity * 0.5), 0, 255)  # Blau
        return result.astype(np.uint8)
    return clip.fl_image(tint)


# =============================================================================
# VIGNETTE
# =============================================================================

def apply_vignette(clip, intensity: float = 0.3):
    """Vignette-Effekt (dunkle Ecken)."""
    if intensity <= 0:
        return clip
    w, h = clip.size
    x = np.linspace(-1, 1, w)
    y = np.linspace(-1, 1, h)
    X, Y = np.meshgrid(x, y)
    mask = 1 - np.clip(np.sqrt(X**2 + Y**2) * intensity, 0, 1)
    mask = mask[:, :, np.newaxis]
    def f(frame):
        return np.clip(frame.astype(float) * mask, 0, 255).astype(np.uint8)
    return clip.fl_image(f)


# =============================================================================
# CINEMATIC BARS (Letterbox)
# =============================================================================

def apply_cinematic_bars(clip, bar_height: float = 0.1):
    """
    Fügt schwarze Balken oben und unten hinzu (Kino-Look).

    Args:
        clip: Video-Clip
        bar_height: Höhe der Balken als Anteil der Videohöhe (0.1 = 10%)
    """
    w, h = clip.size
    bar_pixels = int(h * bar_height)

    def add_bars(frame):
        result = frame.copy()
        result[:bar_pixels, :] = 0  # Oberer Balken
        result[-bar_pixels:, :] = 0  # Unterer Balken
        return result

    return clip.fl_image(add_bars)


# =============================================================================
# RGB SPLIT (Chromatic Aberration)
# =============================================================================

def apply_rgb_split(clip, intensity: float = 10, direction: str = "horizontal"):
    """
    RGB-Kanal Verschiebung (TikTok/Instagram-Style).

    Args:
        clip: Video-Clip
        intensity: Pixel-Verschiebung
        direction: "horizontal", "vertical", oder "diagonal"
    """
    shift = int(intensity)

    def rgb_split(frame):
        h, w = frame.shape[:2]
        result = frame.copy()

        if shift <= 0 or w <= shift * 2 or h <= shift * 2:
            return frame

        if direction == "horizontal":
            # Rot nach rechts, Blau nach links
            result[:, shift:, 0] = frame[:, :-shift, 0]  # Rot
            result[:, :-shift, 2] = frame[:, shift:, 2]  # Blau
        elif direction == "vertical":
            # Rot nach unten, Blau nach oben
            result[shift:, :, 0] = frame[:-shift, :, 0]
            result[:-shift, :, 2] = frame[shift:, :, 2]
        else:  # diagonal
            result[shift:, shift:, 0] = frame[:-shift, :-shift, 0]
            result[:-shift, :-shift, 2] = frame[shift:, shift:, 2]

        return result

    return clip.fl_image(rgb_split)


def apply_rgb_split_animated(clip, max_intensity: float = 15):
    """Animierte RGB-Split die pulsiert."""
    def rgb_split_anim(get_frame, t):
        frame = get_frame(t)
        # Pulsieren mit Sinus
        intensity = int(abs(math.sin(t * 3)) * max_intensity)

        if intensity <= 0:
            return frame

        h, w = frame.shape[:2]
        result = frame.copy()

        if w > intensity * 2:
            result[:, intensity:, 0] = frame[:, :-intensity, 0]
            result[:, :-intensity, 2] = frame[:, intensity:, 2]

        return result

    return clip.fl(rgb_split_anim)


# =============================================================================
# VHS / RETRO EFFEKT
# =============================================================================

def apply_vhs_effect(clip, intensity: float = 0.5):
    """
    VHS/Retro-Effekt mit Scanlines, Rauschen und Farbfehlern.

    Args:
        clip: Video-Clip
        intensity: Stärke des Effekts (0-1)
    """
    def vhs_filter(get_frame, t):
        frame = get_frame(t)
        h, w = frame.shape[:2]
        result = frame.astype(float)

        # 1. Scanlines
        scanlines = np.ones((h, w, 1))
        for i in range(0, h, 2):
            scanlines[i, :] = 1 - (0.3 * intensity)
        result = result * scanlines

        # 2. Rauschen
        noise = np.random.randn(h, w, 3) * (20 * intensity)
        result = result + noise

        # 3. Farbverschiebung (zeitbasiert für Flackern)
        shift = int(2 + random.random() * 3 * intensity)
        if shift > 0 and w > shift:
            # Zufällige horizontale Verschiebung für einige Zeilen
            for _ in range(int(5 * intensity)):
                y = random.randint(0, h - 1)
                line_shift = random.randint(-shift, shift)
                if line_shift > 0:
                    result[y, line_shift:] = result[y, :-line_shift]
                elif line_shift < 0:
                    result[y, :line_shift] = result[y, -line_shift:]

        # 4. Leichte Farbentsättigung
        gray = np.dot(result[..., :3], [0.299, 0.587, 0.114])
        gray = np.stack([gray] * 3, axis=-1)
        result = gray + (1 - 0.3 * intensity) * (result - gray)

        # 5. Leichter Grünstich (typisch für VHS)
        result[:, :, 1] = result[:, :, 1] + (10 * intensity)

        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(vhs_filter)


# =============================================================================
# FILM GRAIN
# =============================================================================

def apply_film_grain(clip, intensity: float = 0.3):
    """
    Film-Korn Effekt für Vintage-Look.

    Args:
        clip: Video-Clip
        intensity: Stärke des Korns (0-1)
    """
    def grain_filter(get_frame, t):
        frame = get_frame(t)
        h, w = frame.shape[:2]

        # Zeitbasiertes Rauschen für Animation
        np.random.seed(int(t * 1000) % 10000)

        # Gaussian noise
        grain = np.random.randn(h, w, 1) * (40 * intensity)
        grain = np.repeat(grain, 3, axis=2)

        result = frame.astype(float) + grain
        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(grain_filter)


# =============================================================================
# LIGHT LEAKS
# =============================================================================

def apply_light_leak(clip, color: tuple = (255, 180, 100), intensity: float = 0.3,
                     position: str = "random"):
    """
    Light Leak Effekt (Lichtflecken wie bei alter Kamera).

    Args:
        clip: Video-Clip
        color: RGB Farbe des Lichts
        intensity: Stärke (0-1)
        position: "top_left", "top_right", "bottom_left", "bottom_right", "random"
    """
    w, h = clip.size

    def light_leak_filter(get_frame, t):
        frame = get_frame(t)

        # Animierte Position und Intensität
        anim_intensity = intensity * (0.5 + 0.5 * math.sin(t * 2))

        # Gradient erstellen
        if position == "random":
            np.random.seed(42)  # Konsistent pro Video
            cx = np.random.randint(0, w)
            cy = np.random.randint(0, h)
        elif position == "top_left":
            cx, cy = 0, 0
        elif position == "top_right":
            cx, cy = w, 0
        elif position == "bottom_left":
            cx, cy = 0, h
        else:  # bottom_right
            cx, cy = w, h

        # Animiere Position leicht
        cx = int(cx + math.sin(t * 0.5) * w * 0.1)
        cy = int(cy + math.cos(t * 0.3) * h * 0.1)

        # Radial gradient
        y, x = np.ogrid[:h, :w]
        dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
        max_dist = np.sqrt(w ** 2 + h ** 2)
        gradient = 1 - (dist / max_dist)
        gradient = np.clip(gradient * 2, 0, 1) ** 2

        # Overlay
        overlay = np.zeros((h, w, 3), dtype=float)
        for i, c in enumerate(color):
            overlay[:, :, i] = c * gradient * anim_intensity

        result = frame.astype(float) + overlay
        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(light_leak_filter)


# =============================================================================
# CAMERA SHAKE
# =============================================================================

def apply_shake(clip, intensity: float = 5, frequency: float = 15):
    """
    Kamera-Wackeln für dynamischen Look.

    Args:
        clip: Video-Clip
        intensity: Pixel-Verschiebung
        frequency: Wackel-Frequenz
    """
    w, h = clip.size

    def shake_filter(get_frame, t):
        frame = get_frame(t)

        # Perlin-artige Bewegung mit Sinus
        offset_x = int(math.sin(t * frequency) * intensity)
        offset_y = int(math.cos(t * frequency * 1.3) * intensity)

        # Frame verschieben
        M = np.float32([[1, 0, offset_x], [0, 1, offset_y]])
        result = cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_REFLECT)

        return result

    return clip.fl(shake_filter)


def apply_impact_shake(clip, start_time: float, duration: float = 0.3, intensity: float = 15):
    """
    Einmaliger Impact-Shake (z.B. bei Explosion oder Betonung).
    """
    w, h = clip.size

    def impact_filter(get_frame, t):
        frame = get_frame(t)

        if t < start_time or t > start_time + duration:
            return frame

        progress = (t - start_time) / duration
        current_intensity = intensity * (1 - progress) ** 2  # Schneller Abfall

        offset_x = int(math.sin(t * 50) * current_intensity)
        offset_y = int(math.cos(t * 60) * current_intensity)

        M = np.float32([[1, 0, offset_x], [0, 1, offset_y]])
        return cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_REFLECT)

    return clip.fl(impact_filter)


# =============================================================================
# SPEED RAMP
# =============================================================================

def apply_speed_ramp(clip, ramp_points: list = None):
    """
    Speed Ramp: Variable Geschwindigkeit.

    Args:
        clip: Video-Clip
        ramp_points: Liste von (zeit, geschwindigkeit) Tuples
                     z.B. [(0, 1.0), (2, 0.3), (3, 2.0), (5, 1.0)]

    Returns:
        Clip mit variabler Geschwindigkeit
    """
    if ramp_points is None or len(ramp_points) < 2:
        return clip

    # Sortieren nach Zeit
    ramp_points = sorted(ramp_points, key=lambda x: x[0])

    def get_speed_at_time(t):
        """Interpoliert Geschwindigkeit zwischen Punkten."""
        for i in range(len(ramp_points) - 1):
            t1, s1 = ramp_points[i]
            t2, s2 = ramp_points[i + 1]
            if t1 <= t <= t2:
                # Lineare Interpolation
                progress = (t - t1) / (t2 - t1)
                return s1 + (s2 - s1) * progress
        return ramp_points[-1][1]

    def time_warp(t):
        """Berechnet die neue Zeit basierend auf Speed Ramp."""
        # Numerische Integration
        steps = 100
        dt = t / steps
        new_t = 0
        current_t = 0
        for _ in range(steps):
            speed = get_speed_at_time(current_t)
            new_t += dt * speed
            current_t += dt
        return min(new_t, clip.duration - 0.01)

    return clip.fl_time(time_warp, apply_to=['video', 'audio'])


def apply_slowmo_highlight(clip, start: float, end: float, slowmo_factor: float = 0.3):
    """
    Slowmo für einen bestimmten Zeitbereich.
    """
    # Einfachere Implementierung: Nur den Bereich verlangsamen
    if start >= end or start >= clip.duration:
        return clip

    before = clip.subclip(0, start) if start > 0 else None
    highlight = clip.subclip(start, min(end, clip.duration))
    after = clip.subclip(min(end, clip.duration)) if end < clip.duration else None

    # Slowmo ohne Audio-Änderung
    highlight_slow = highlight.fx(lambda c: c.speedx(slowmo_factor))

    clips = []
    if before:
        clips.append(before)
    clips.append(highlight_slow)
    if after:
        clips.append(after)

    return concatenate_videoclips(clips, method="compose")


# =============================================================================
# FREEZE FRAME
# =============================================================================

def apply_freeze_frame(clip, freeze_time: float, freeze_duration: float = 1.0):
    """
    Friert einen Frame ein.

    Args:
        clip: Video-Clip
        freeze_time: Zeitpunkt zum Einfrieren
        freeze_duration: Wie lange einfrieren
    """
    if freeze_time >= clip.duration:
        return clip

    # Frame extrahieren
    frozen_frame = clip.get_frame(freeze_time)

    # Clips zusammenbauen
    before = clip.subclip(0, freeze_time) if freeze_time > 0 else None
    freeze = ImageClip(frozen_frame, duration=freeze_duration)
    after = clip.subclip(freeze_time) if freeze_time < clip.duration else None

    clips = []
    if before:
        clips.append(before)
    clips.append(freeze)
    if after:
        clips.append(after)

    if not clips:
        return clip

    result = concatenate_videoclips(clips, method="compose")

    # Audio beibehalten
    if clip.audio:
        result = result.set_audio(clip.audio)

    return result


def apply_freeze_with_effect(clip, freeze_time: float, freeze_duration: float = 1.0,
                             effect: str = "zoom"):
    """
    Freeze Frame mit zusätzlichem Effekt.

    Args:
        effect: "zoom", "bw" (schwarz-weiß), "vhs", "grain"
    """
    if freeze_time >= clip.duration:
        return clip

    frozen_frame = clip.get_frame(freeze_time)

    # Effekt anwenden
    if effect == "bw":
        gray = np.dot(frozen_frame[..., :3], [0.299, 0.587, 0.114])
        frozen_frame = np.stack([gray] * 3, axis=-1).astype(np.uint8)
    elif effect == "zoom":
        h, w = frozen_frame.shape[:2]
        img = Image.fromarray(frozen_frame)
        # Leicht reinzoomen
        img = img.resize((int(w * 1.1), int(h * 1.1)), Image.LANCZOS)
        left = (img.width - w) // 2
        top = (img.height - h) // 2
        img = img.crop((left, top, left + w, top + h))
        frozen_frame = np.array(img)

    before = clip.subclip(0, freeze_time) if freeze_time > 0 else None
    freeze = ImageClip(frozen_frame, duration=freeze_duration)
    after = clip.subclip(freeze_time) if freeze_time < clip.duration else None

    clips = [c for c in [before, freeze, after] if c is not None]
    return concatenate_videoclips(clips, method="compose") if clips else clip


# =============================================================================
# MIRROR / SPLIT SCREEN
# =============================================================================

def apply_mirror(clip, direction: str = "horizontal"):
    """
    Spiegel-Effekt.

    Args:
        direction: "horizontal", "vertical"
    """
    def mirror_filter(frame):
        if direction == "horizontal":
            return np.fliplr(frame)
        else:
            return np.flipud(frame)

    return clip.fl_image(mirror_filter)


def apply_split_mirror(clip, direction: str = "horizontal"):
    """
    Halbes Bild gespiegelt (Symmetrie-Effekt).
    """
    def split_mirror(frame):
        h, w = frame.shape[:2]
        result = frame.copy()

        if direction == "horizontal":
            half = w // 2
            result[:, half:] = np.fliplr(frame[:, :half + (w % 2)])
        else:
            half = h // 2
            result[half:, :] = np.flipud(frame[:half + (h % 2), :])

        return result

    return clip.fl_image(split_mirror)


def apply_kaleidoscope(clip, segments: int = 4):
    """
    Kaleidoskop-Effekt.
    """
    def kaleidoscope_filter(frame):
        h, w = frame.shape[:2]
        center = (w // 2, h // 2)

        result = frame.copy()

        # Einfaches Kaleidoskop: Quadranten spiegeln
        q1 = frame[:h//2, :w//2]  # Oben links

        result[:h//2, w//2:w//2 + q1.shape[1]] = np.fliplr(q1)  # Oben rechts
        result[h//2:h//2 + q1.shape[0], :w//2] = np.flipud(q1)  # Unten links
        result[h//2:h//2 + q1.shape[0], w//2:w//2 + q1.shape[1]] = np.flipud(np.fliplr(q1))  # Unten rechts

        return result

    return clip.fl_image(kaleidoscope_filter)


# =============================================================================
# ECHO / GHOST EFFEKT
# =============================================================================

def apply_echo(clip, num_echoes: int = 3, echo_delay: float = 0.1, decay: float = 0.5):
    """
    Echo/Ghost-Effekt: Nachlaufende transparente Frames.

    Args:
        clip: Video-Clip
        num_echoes: Anzahl der Echos
        echo_delay: Zeitverzögerung pro Echo
        decay: Transparenz-Abfall pro Echo
    """
    def echo_filter(get_frame, t):
        current_frame = get_frame(t).astype(float)
        result = current_frame.copy()

        for i in range(1, num_echoes + 1):
            echo_t = t - (i * echo_delay)
            if echo_t >= 0:
                echo_frame = get_frame(echo_t).astype(float)
                alpha = decay ** i
                result = result * (1 - alpha * 0.5) + echo_frame * (alpha * 0.5)

        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(echo_filter)


def apply_motion_blur(clip, amount: int = 5):
    """
    Bewegungsunschärfe basierend auf vorherigen Frames.
    """
    frame_buffer = []

    def motion_blur_filter(get_frame, t):
        frame = get_frame(t)
        frame_buffer.append(frame.astype(float))

        if len(frame_buffer) > amount:
            frame_buffer.pop(0)

        # Durchschnitt der Frames
        result = np.mean(frame_buffer, axis=0)
        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(motion_blur_filter)


# =============================================================================
# MODERNE ÜBERGÄNGE
# =============================================================================

def apply_fade_in(clip, duration: float):
    """Sanftes Einblenden von Schwarz."""
    if duration <= 0:
        return clip
    return clip.fadein(min(duration, clip.duration / 2))


def apply_fade_out(clip, duration: float):
    """Sanftes Ausblenden zu Schwarz."""
    if duration <= 0:
        return clip
    return clip.fadeout(min(duration, clip.duration / 2))


def apply_swipe_in(clip, duration: float = 0.3, direction: str = "left"):
    """Swipe/Wisch-Übergang am Anfang des Clips."""
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def swipe_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        progress = t / duration
        progress = 1 - (1 - progress) ** 3  # Ease-out

        if direction == "left":
            offset = int(w * (1 - progress))
            new_frame = np.zeros_like(frame)
            new_frame[:, :w-offset] = frame[:, offset:]
        elif direction == "right":
            offset = int(w * (1 - progress))
            new_frame = np.zeros_like(frame)
            new_frame[:, offset:] = frame[:, :w-offset]
        elif direction == "up":
            offset = int(h * (1 - progress))
            new_frame = np.zeros_like(frame)
            new_frame[:h-offset, :] = frame[offset:, :]
        else:  # down
            offset = int(h * (1 - progress))
            new_frame = np.zeros_like(frame)
            new_frame[offset:, :] = frame[:h-offset, :]

        return new_frame

    return clip.fl(swipe_filter)


def apply_swipe_out(clip, duration: float = 0.3, direction: str = "right"):
    """Swipe/Wisch-Übergang am Ende des Clips."""
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size
    start_time = clip.duration - duration

    def swipe_filter(get_frame, t):
        frame = get_frame(t)
        if t < start_time:
            return frame

        progress = (t - start_time) / duration
        progress = progress ** 2  # Ease-in

        if direction == "right":
            offset = int(w * progress)
            new_frame = np.zeros_like(frame)
            if offset < w:
                new_frame[:, :w-offset] = frame[:, offset:]
        elif direction == "left":
            offset = int(w * progress)
            new_frame = np.zeros_like(frame)
            if offset < w:
                new_frame[:, offset:] = frame[:, :w-offset]
        else:
            new_frame = frame

        return new_frame

    return clip.fl(swipe_filter)


def apply_glitch_transition(clip, duration: float = 0.15):
    """Digitaler Glitch-Effekt am Anfang des Clips."""
    if duration <= 0:
        return clip

    def glitch_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        intensity = 1 - (t / duration)
        shift = int(15 * intensity)
        h, w = frame.shape[:2]

        result = frame.copy()
        if shift > 0 and w > shift * 2:
            result[:, shift:, 0] = frame[:, :-shift, 0]
            result[:, :-shift, 2] = frame[:, shift:, 2]

        if intensity > 0.3:
            num_glitches = int(5 * intensity)
            for _ in range(num_glitches):
                y = random.randint(0, h - 10)
                height = random.randint(2, 8)
                shift_x = random.randint(-20, 20)

                if 0 < y + height < h:
                    stripe = result[y:y+height, :].copy()
                    if shift_x > 0 and w > shift_x:
                        result[y:y+height, shift_x:] = stripe[:, :-shift_x]
                    elif shift_x < 0 and w > -shift_x:
                        result[y:y+height, :shift_x] = stripe[:, -shift_x:]

        return result

    return clip.fl(glitch_filter)


def apply_blur_transition(clip, duration: float = 0.3, direction: str = "in"):
    """Blur-Übergang: Unscharf -> Scharf (in) oder Scharf -> Unscharf (out)."""
    if duration <= 0:
        return clip

    if direction == "out":
        start_time = clip.duration - duration
    else:
        start_time = 0

    def blur_filter(get_frame, t):
        frame = get_frame(t)

        if direction == "in":
            if t >= duration:
                return frame
            progress = t / duration
            blur_amount = int(20 * (1 - progress))
        else:
            if t < start_time:
                return frame
            progress = (t - start_time) / duration
            blur_amount = int(20 * progress)

        if blur_amount <= 0:
            return frame

        img = Image.fromarray(frame)
        img = img.filter(ImageFilter.GaussianBlur(radius=blur_amount))
        return np.array(img)

    return clip.fl(blur_filter)


def apply_zoom_transition(clip, duration: float = 0.3, direction: str = "in"):
    """Zoom-Übergang: Reinzoomen (in) oder Rauszoomen (out)."""
    if duration <= 0:
        return clip

    w, h = clip.size

    if direction == "out":
        start_time = clip.duration - duration
    else:
        start_time = 0

    def zoom_filter(get_frame, t):
        frame = get_frame(t)

        if direction == "in":
            if t >= duration:
                return frame
            progress = t / duration
            progress = 1 - (1 - progress) ** 2
            scale = 1.3 - (0.3 * progress)
        else:
            if t < start_time:
                return frame
            progress = (t - start_time) / duration
            scale = 1.0 + (0.3 * progress)

        if abs(scale - 1.0) < 0.01:
            return frame

        img = Image.fromarray(frame)
        new_w, new_h = int(w * scale), int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(zoom_filter)


def apply_scale_pop(clip, duration: float = 0.2):
    """Scale Pop: Kurz größer, dann zurück zu normal."""
    if duration <= 0:
        return clip

    w, h = clip.size

    def pop_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        progress = t / duration
        if progress < 0.3:
            scale = 1.0 + (0.1 * (progress / 0.3))
        else:
            scale = 1.1 - (0.1 * ((progress - 0.3) / 0.7))

        if abs(scale - 1.0) < 0.01:
            return frame

        img = Image.fromarray(frame)
        new_w, new_h = int(w * scale), int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(pop_filter)


# Neue Übergänge

def apply_pixelate_transition(clip, duration: float = 0.3, direction: str = "in"):
    """Pixelierungs-Übergang."""
    if duration <= 0:
        return clip

    w, h = clip.size

    if direction == "out":
        start_time = clip.duration - duration
    else:
        start_time = 0

    def pixelate_filter(get_frame, t):
        frame = get_frame(t)

        if direction == "in":
            if t >= duration:
                return frame
            progress = t / duration
            pixel_size = int(30 * (1 - progress)) + 1
        else:
            if t < start_time:
                return frame
            progress = (t - start_time) / duration
            pixel_size = int(30 * progress) + 1

        if pixel_size <= 1:
            return frame

        # Pixelate
        small = cv2.resize(frame, (w // pixel_size, h // pixel_size), interpolation=cv2.INTER_LINEAR)
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)

    return clip.fl(pixelate_filter)


def apply_rotate_transition(clip, duration: float = 0.3, direction: str = "in"):
    """Rotations-Übergang."""
    if duration <= 0:
        return clip

    w, h = clip.size

    if direction == "out":
        start_time = clip.duration - duration
    else:
        start_time = 0

    def rotate_filter(get_frame, t):
        frame = get_frame(t)

        if direction == "in":
            if t >= duration:
                return frame
            progress = t / duration
            angle = 90 * (1 - progress)
            scale = progress
        else:
            if t < start_time:
                return frame
            progress = (t - start_time) / duration
            angle = 90 * progress
            scale = 1 - progress

        scale = max(0.1, scale)

        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, scale)
        return cv2.warpAffine(frame, M, (w, h), borderValue=(0, 0, 0))

    return clip.fl(rotate_filter)


# =============================================================================
# ZOOM EFFEKTE
# =============================================================================

def apply_smart_zoom(clip, face_positions: list = None, zoom_factor: float = 1.15):
    """Smart Zoom der Gesichtern folgt."""
    if face_positions is None or len(face_positions) == 0:
        return apply_zoom_in(clip, zoom_factor)

    w, h = clip.size

    def get_target_at_time(t):
        frame_idx = int(t * 30)
        if not face_positions:
            return (0.5, 0.5)
        closest = min(face_positions, key=lambda p: abs(p[0] - frame_idx))
        return (closest[1] / w, closest[2] / h)

    def smart_zoom_filter(get_frame, t):
        frame = get_frame(t)
        current_zoom = 1.0 + (zoom_factor - 1.0) * 0.7
        target_x, target_y = get_target_at_time(t)
        smooth_x = 0.5 + (target_x - 0.5) * 0.6
        smooth_y = 0.5 + (target_y - 0.5) * 0.6

        new_w = int(w * current_zoom)
        new_h = int(h * current_zoom)

        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        max_offset_x = new_w - w
        max_offset_y = new_h - h
        left = max(0, min(int(max_offset_x * smooth_x), new_w - w))
        top = max(0, min(int(max_offset_y * smooth_y), new_h - h))

        img = img.crop((left, top, left + w, top + h))
        return np.array(img)

    return clip.fl(smart_zoom_filter)


def apply_zoom_in(clip, zoom_factor: float = 1.2):
    """Langsamer Zoom-In über die Clip-Dauer."""
    if zoom_factor <= 1.0:
        return clip
    w, h = clip.size

    def zoom_filter(get_frame, t):
        progress = t / clip.duration
        current_zoom = 1.0 + (zoom_factor - 1.0) * progress
        frame = get_frame(t)

        new_w, new_h = int(w * current_zoom), int(h * current_zoom)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))
        return np.array(img)

    return clip.fl(zoom_filter)


def apply_zoom_out(clip, zoom_factor: float = 1.2):
    """Langsamer Zoom-Out über die Clip-Dauer."""
    if zoom_factor <= 1.0:
        return clip
    w, h = clip.size

    def zoom_filter(get_frame, t):
        progress = t / clip.duration
        current_zoom = zoom_factor - (zoom_factor - 1.0) * progress
        frame = get_frame(t)

        new_w, new_h = int(w * current_zoom), int(h * current_zoom)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))
        return np.array(img)

    return clip.fl(zoom_filter)


def apply_pan_zoom(clip, direction: str = "left_to_right", zoom_factor: float = 1.15):
    """Ken Burns Effekt mit Bewegung."""
    w, h = clip.size

    def pan_zoom_filter(get_frame, t):
        progress = t / clip.duration
        frame = get_frame(t)

        current_zoom = 1.0 + (zoom_factor - 1.0) * 0.5
        new_w, new_h = int(w * current_zoom), int(h * current_zoom)

        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        max_offset_x = new_w - w
        max_offset_y = new_h - h

        if direction == "left_to_right":
            left, top = int(max_offset_x * progress), max_offset_y // 2
        elif direction == "right_to_left":
            left, top = int(max_offset_x * (1 - progress)), max_offset_y // 2
        elif direction == "top_to_bottom":
            left, top = max_offset_x // 2, int(max_offset_y * progress)
        else:
            left, top = max_offset_x // 2, int(max_offset_y * (1 - progress))

        img = img.crop((left, top, left + w, top + h))
        return np.array(img)

    return clip.fl(pan_zoom_filter)


def apply_zoom_pulse(clip, frequency: float = 2.0, intensity: float = 0.05):
    """Pulsierender Zoom (gut für Musik-Sync)."""
    w, h = clip.size

    def pulse_filter(get_frame, t):
        frame = get_frame(t)

        # Sinus-Puls
        pulse = 1.0 + intensity * math.sin(t * frequency * 2 * math.pi)

        new_w, new_h = int(w * pulse), int(h * pulse)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(pulse_filter)


def apply_beat_zoom(clip, beat_times: list, intensity: float = 0.08, decay: float = 0.15):
    """Zoom-Pulse auf Beat-Zeitpunkte."""
    w, h = clip.size

    def beat_filter(get_frame, t):
        frame = get_frame(t)

        # Finde nächsten Beat
        zoom = 1.0
        for beat_t in beat_times:
            if beat_t <= t < beat_t + decay:
                progress = (t - beat_t) / decay
                zoom = max(zoom, 1.0 + intensity * (1 - progress))

        if abs(zoom - 1.0) < 0.001:
            return frame

        new_w, new_h = int(w * zoom), int(h * zoom)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(beat_filter)


# =============================================================================
# TEXT EFFEKTE
# =============================================================================

def create_typewriter_text(text: str, duration: float, video_size: tuple,
                           fontsize: int = None, color: str = "white") -> list:
    """Typewriter-Style: Klarer weißer Text mit Box."""
    clips = []

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            fontsize=fontsize,
            color=(255, 255, 255),
            stroke_color=(0, 0, 0),
            stroke_width=4,
            position="center",
            bg_box=True  # Immer Box für bessere Lesbarkeit
        )

        if clip:
            clip = clip.crossfadein(0.08)
            clips.append(clip)

    except Exception as e:
        print(f"    Typewriter Fehler: {e}")

    return clips


def create_bounce_text(text: str, duration: float, video_size: tuple,
                       fontsize: int = None, color: str = "white") -> list:
    """Bounce-Style: Weicher Ein- und Ausblend-Effekt mit Box."""
    clips = []

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            fontsize=fontsize,
            color=(255, 255, 255),
            stroke_color=(0, 0, 0),
            stroke_width=4,
            position="center",
            bg_box=True  # Immer Box für bessere Lesbarkeit
        )

        if clip:
            clip = clip.crossfadein(0.15).crossfadeout(0.12)
            clips.append(clip)

    except Exception as e:
        print(f"    Bounce Fehler: {e}")

    return clips


def create_glitch_text(text: str, duration: float, video_size: tuple,
                       fontsize: int = None, color: str = "white") -> list:
    """Glitch-Style: Neon-Cyan mit Magenta-Glow und Box."""
    clips = []

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            fontsize=fontsize,
            color=(0, 255, 255),  # Cyan
            stroke_color=(255, 0, 255),  # Magenta (heller für mehr Kontrast)
            stroke_width=5,
            position="center",
            bg_box=True  # Box für bessere Lesbarkeit
        )

        if clip:
            clips.append(clip)

    except Exception as e:
        print(f"    Glitch Fehler: {e}")

    return clips


def create_neon_text(text: str, duration: float, video_size: tuple,
                     fontsize: int = None, color: str = "cyan") -> list:
    """Neon-Style: Leuchtend farbiger Text mit Glow und Box."""
    clips = []

    neon_colors = {
        "cyan": ((0, 255, 255), (0, 50, 50)),       # Cyan + dunkler für Outline
        "pink": ((255, 100, 255), (80, 0, 80)),     # Pink + dunkles Pink
        "green": ((100, 255, 100), (0, 60, 0)),     # Grün + dunkles Grün
        "orange": ((255, 180, 50), (80, 50, 0)),    # Orange + dunkles Orange
    }

    main_color, glow_color = neon_colors.get(color, neon_colors["cyan"])

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            fontsize=fontsize,
            color=main_color,
            stroke_color=glow_color,
            stroke_width=5,
            position="center",
            bg_box=True  # Box für bessere Lesbarkeit
        )

        if clip:
            clips.append(clip)

    except Exception as e:
        print(f"    Neon Fehler: {e}")

    return clips


# =============================================================================
# KARAOKE-STYLE UNTERTITEL
# =============================================================================

def create_karaoke_subtitle(text: str, duration: float, video_size: tuple,
                            subtitle_config: dict = None) -> list:
    """Karaoke-Style: Text mit konfigurierbarer Farbe und Effekt."""
    clips = []

    # Standardwerte
    color = (255, 255, 0)  # Gelb als Standard für Karaoke
    stroke_width = 5
    effect = None

    if subtitle_config:
        if "subtitle_color" in subtitle_config:
            color = subtitle_config["subtitle_color"]
        if "subtitle_stroke_width" in subtitle_config:
            stroke_width = subtitle_config["subtitle_stroke_width"]
        if "subtitle_effect" in subtitle_config:
            effect = subtitle_config["subtitle_effect"]

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            color=color,
            stroke_color=(0, 0, 0),
            stroke_width=stroke_width,
            position="center",
            effect=effect,
            subtitle_config=subtitle_config
        )

        if clip:
            clips.append(clip)

    except Exception as e:
        print(f"    Karaoke Fehler: {e}")

    return clips


def create_pil_text_clip(text: str, duration: float, video_size: tuple,
                         fontsize: int = None, color: tuple = (255, 255, 255),
                         stroke_color: tuple = (0, 0, 0), stroke_width: int = 3,
                         position: str = "center", bg_box: bool = False,
                         effect: str = None, subtitle_config: dict = None) -> ImageClip:
    """
    TikTok/Reels Style Untertitel mit verschiedenen Effekten.

    Args:
        text: Anzuzeigender Text
        duration: Dauer in Sekunden
        video_size: (width, height)
        fontsize: Schriftgröße (None = auto)
        color: RGB-Tuple für Textfarbe
        stroke_color: RGB-Tuple für Outline
        stroke_width: Dicke der Outline
        position: "center", "bottom", "top"
        bg_box: Hintergrund-Box anzeigen (deprecated, use effect="box")
        effect: Effekt-Typ: "highlight", "box", "pop", None
        subtitle_config: Config-Dict aus Stil-Definition
    """
    w, h = video_size
    text = text.strip()
    if not text:
        return None

    # Config-Werte übernehmen wenn vorhanden
    if subtitle_config:
        if "subtitle_color" in subtitle_config and color == (255, 255, 255):
            color = subtitle_config["subtitle_color"]
        if "subtitle_stroke_width" in subtitle_config:
            stroke_width = subtitle_config["subtitle_stroke_width"]
        if "subtitle_effect" in subtitle_config:
            effect = subtitle_config["subtitle_effect"]
        if "subtitle_fontsize" in subtitle_config and subtitle_config["subtitle_fontsize"]:
            fontsize = subtitle_config["subtitle_fontsize"]

    # GROSSE Schrift für TikTok-Style
    if fontsize is None:
        fontsize = max(50, int(h / 25))

    # Fontsize-Multiplier anwenden
    if subtitle_config and "subtitle_fontsize_multiplier" in subtitle_config:
        fontsize = int(fontsize * subtitle_config["subtitle_fontsize_multiplier"])

    # Font laden - fette Fonts bevorzugen
    font = None
    for fp in [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/impact.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ]:
        try:
            font = ImageFont.truetype(fp, fontsize)
            break
        except:
            continue

    if font is None:
        try:
            font = ImageFont.load_default()
        except:
            return None

    # Text-Breite messen
    def get_width(txt):
        try:
            return font.getlength(txt)
        except:
            try:
                bbox = font.getbbox(txt)
                return bbox[2] - bbox[0]
            except:
                return len(txt) * fontsize * 0.6

    text_w = int(get_width(text))
    text_h = fontsize

    # Padding berechnen
    shadow_offset = max(4, int(fontsize / 12))
    effect_pad = 15 if effect in ["highlight", "box"] else 0
    pad = shadow_offset + 6 + effect_pad

    # Bild erstellen
    img_w = text_w + pad * 2
    img_h = text_h + pad * 2

    img = Image.new('RGBA', (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Text Position
    x = pad
    y = pad - 2

    # === EFFEKT: HIGHLIGHT (Textmarker) ===
    if effect == "highlight":
        # Farbiger Balken hinter dem Text (wie Textmarker)
        highlight_color = color  # Highlight in Textfarbe
        bar_pad_x = 8
        bar_pad_y = 4
        bar_x1 = x - bar_pad_x
        bar_y1 = y - bar_pad_y
        bar_x2 = x + text_w + bar_pad_x
        bar_y2 = y + text_h + bar_pad_y
        # Halbtransparenter Balken
        draw.rectangle([bar_x1, bar_y1, bar_x2, bar_y2],
                       fill=highlight_color + (180,))
        # Text wird weiß auf farbigem Hintergrund
        color = (255, 255, 255)

    # === EFFEKT: BOX (Abgerundete Box) ===
    elif effect == "box":
        box_color = color  # Box in Textfarbe
        box_pad_x = 12
        box_pad_y = 8
        box_x1 = x - box_pad_x
        box_y1 = y - box_pad_y
        box_x2 = x + text_w + box_pad_x
        box_y2 = y + text_h + box_pad_y
        radius = min(15, int(fontsize / 4))
        # Abgerundetes Rechteck zeichnen
        draw.rounded_rectangle([box_x1, box_y1, box_x2, box_y2],
                               radius=radius, fill=box_color + (200,))
        # Text wird weiß auf farbigem Hintergrund
        color = (255, 255, 255)

    # Schatten (weich, versetzt) - nicht bei highlight/box
    if effect not in ["highlight", "box"]:
        for i in range(shadow_offset, 0, -1):
            alpha = int(100 * (i / shadow_offset))
            draw.text((x + i, y + i), text, font=font, fill=(0, 0, 0, alpha))

    # Outline
    outline_size = max(2, stroke_width)
    for ox in range(-outline_size, outline_size + 1):
        for oy in range(-outline_size, outline_size + 1):
            if ox != 0 or oy != 0:
                draw.text((x + ox, y + oy), text, font=font, fill=stroke_color + (255,))

    # Haupttext
    draw.text((x, y), text, font=font, fill=color + (255,))

    # Position: Mitte der unteren Hälfte (75% von oben)
    pos_x = (w - img_w) // 2
    pos_y = int(h * 0.75) - img_h // 2

    if position == "bottom":
        pos_y = h - img_h - int(h * 0.08)
    elif position == "top":
        pos_y = int(h * 0.08)

    clip = ImageClip(np.array(img), duration=duration)
    clip = clip.set_position((pos_x, pos_y))

    # === EFFEKT: POP (Scale Animation) ===
    if effect == "pop":
        # Text startet 20% größer und schrumpft auf normal
        def scale_effect(t):
            # Schnelle Ease-Out Animation in den ersten 0.15 Sekunden
            if t < 0.15:
                progress = t / 0.15
                scale = 1.2 - 0.2 * (progress ** 0.5)  # Ease-out
            else:
                scale = 1.0
            return scale

        clip = clip.resize(scale_effect)

    return clip


# =============================================================================
# HIGHLIGHT WÖRTER - Spezielle Effekte für bestimmte Wörter
# =============================================================================

# Standard Highlight-Wörter und ihre Effekte
# effect: "highlight" (Textmarker), "box" (abgerundete Box), "pop" (Scale-Animation)
HIGHLIGHT_KEYWORDS = {
    # Zahlen/Jahre - Gold mit Highlight
    "2024": {"color": (255, 215, 0), "effect": "highlight", "sound": "boom"},
    "2025": {"color": (255, 215, 0), "effect": "highlight", "sound": "boom"},
    "2026": {"color": (255, 215, 0), "effect": "highlight", "sound": "boom"},

    # Geld-Wörter - Grün mit Box
    "geld": {"color": (0, 255, 100), "effect": "box", "sound": "cash"},
    "euro": {"color": (0, 255, 100), "effect": "box", "sound": "cash"},
    "dollar": {"color": (0, 255, 100), "effect": "box", "sound": "cash"},
    "reich": {"color": (0, 255, 100), "effect": "box", "sound": "cash"},
    "millionen": {"color": (0, 255, 100), "effect": "box", "sound": "cash"},

    # Emotion/Intensität - Rot mit Pop
    "krass": {"color": (255, 50, 50), "effect": "pop", "sound": "boom"},
    "wow": {"color": (255, 50, 50), "effect": "pop", "sound": "boom"},
    "heftig": {"color": (255, 50, 50), "effect": "pop", "sound": "boom"},
    "crazy": {"color": (255, 50, 50), "effect": "pop", "sound": "boom"},
    "unglaublich": {"color": (255, 100, 0), "effect": "pop", "sound": "boom"},

    # Wichtig - Gelb mit Highlight
    "wichtig": {"color": (255, 255, 0), "effect": "highlight", "sound": "ding"},
    "achtung": {"color": (255, 255, 0), "effect": "highlight", "sound": "ding"},
    "aber": {"color": (255, 200, 0), "effect": None, "sound": None},

    # Positiv - Cyan mit Box
    "geil": {"color": (0, 200, 255), "effect": "box", "sound": "swoosh"},
    "nice": {"color": (0, 200, 255), "effect": "box", "sound": "swoosh"},
    "perfekt": {"color": (0, 200, 255), "effect": "box", "sound": "swoosh"},
    "super": {"color": (0, 200, 255), "effect": "box", "sound": "swoosh"},
}


def is_highlight_word(word: str) -> dict:
    """Prüft ob ein Wort hervorgehoben werden soll."""
    word_lower = word.lower().strip(".,!?;:")
    if word_lower in HIGHLIGHT_KEYWORDS:
        return HIGHLIGHT_KEYWORDS[word_lower]
    return None


def create_highlighted_text_clip(text: str, duration: float, video_size: tuple,
                                  highlight_config: dict = None) -> ImageClip:
    """
    Erstellt hervorgehobenen Text mit Effekt (highlight, box, pop).

    Args:
        text: Der anzuzeigende Text
        duration: Dauer in Sekunden
        video_size: (width, height)
        highlight_config: {"color": (r,g,b), "effect": "highlight"/"box"/"pop"}
    """
    if not text or not text.strip():
        return None

    # Config auslesen
    color = (255, 255, 0)  # Standard: Gelb
    effect = "highlight"   # Standard: Textmarker

    if highlight_config:
        color = highlight_config.get("color", (255, 255, 0))
        effect = highlight_config.get("effect", "highlight")
        # Rückwärtskompatibilität: glow -> highlight
        if highlight_config.get("glow") and not highlight_config.get("effect"):
            effect = "highlight"

    # Größere Schrift für Highlights (1.2x)
    h = video_size[1]
    fontsize = max(60, int(h / 18))

    # Nutze create_pil_text_clip mit dem Effekt
    return create_pil_text_clip(
        text=text,
        duration=duration,
        video_size=video_size,
        fontsize=fontsize,
        color=color,
        stroke_color=(0, 0, 0),
        stroke_width=4,
        position="center",
        effect=effect
    )


def create_modern_subtitle(text: str, duration: float, video_size: tuple,
                           style: str = "default", subtitle_config: dict = None) -> list:
    """Moderne Untertitel - sauber und lesbar, mit konfigurierbarer Farbe und Effekt."""
    clips = []

    # Standardwerte
    color = (255, 255, 255)
    stroke_width = 4
    effect = None  # Kein Effekt für normale Untertitel

    if subtitle_config:
        if "subtitle_color" in subtitle_config:
            color = subtitle_config["subtitle_color"]
        if "subtitle_stroke_width" in subtitle_config:
            stroke_width = subtitle_config["subtitle_stroke_width"]
        if "subtitle_effect" in subtitle_config:
            effect = subtitle_config["subtitle_effect"]

    try:
        clip = create_pil_text_clip(
            text, duration, video_size,
            color=color,
            stroke_color=(0, 0, 0),
            stroke_width=stroke_width,
            position="center",
            effect=effect,
            subtitle_config=subtitle_config
        )

        if clip:
            clips.append(clip)

    except Exception as e:
        print(f"    Untertitel Fehler: {e}")

    return clips


# =============================================================================
# DYNAMIC SUBTITLES (TikTok Style - Akkumulierend mit Variation)
# =============================================================================

def create_dynamic_word_clip(word: str, duration: float, video_size: tuple,
                              position: tuple, fontsize: int, glow_intensity: float,
                              font_path: str, fade_in: float = 0.15,
                              has_glow: bool = True) -> ImageClip:
    """
    Erstellt einen einzelnen Wort-Clip mit Fade-In Animation und Glow.

    Args:
        word: Das Wort
        duration: Dauer des Clips
        video_size: (width, height)
        position: (x, y) Position
        fontsize: Schriftgröße
        glow_intensity: Glow-Stärke
        font_path: Pfad zur Schriftart
        fade_in: Fade-In Dauer in Sekunden
        has_glow: Ob das Wort Glow haben soll
    """
    w, h = video_size
    x_pos, y_pos = position

    # Font laden
    font = ImageFont.truetype(font_path, fontsize)
    bbox = font.getbbox(word)
    word_w = bbox[2] - bbox[0]
    word_h = bbox[3] - bbox[1]

    # Padding für Glow (kleiner)
    padding = 40 if has_glow else 12
    img_w = word_w + padding * 2
    img_h = word_h + padding * 2

    # Position im Bild
    tx, ty = padding, padding

    # Ergebnis-Layer
    result = Image.new('RGBA', (img_w, img_h), (0, 0, 0, 0))

    if has_glow:
        # 6 Glow-Layer
        glow_layers = []
        for _ in range(6):
            layer = Image.new('RGBA', (img_w, img_h), (0, 0, 0, 0))
            glow_layers.append(layer)

        # LAYER 1-2: Weit außen
        for layer_idx in range(2):
            draw = ImageDraw.Draw(glow_layers[layer_idx])
            for offset in range(30, 0, -5):
                alpha = int(90 * (1 - offset / 30))
                draw.text((tx, ty), word, font=font, fill=(255, 255, 255, alpha))

        # LAYER 3-4: Mittlerer Bereich
        for layer_idx in range(2, 4):
            draw = ImageDraw.Draw(glow_layers[layer_idx])
            for offset in range(18, 0, -3):
                alpha = int(130 * (1 - offset / 18))
                draw.text((tx, ty), word, font=font, fill=(255, 255, 255, alpha))

        # LAYER 5-6: Nah am Text
        for layer_idx in range(4, 6):
            draw = ImageDraw.Draw(glow_layers[layer_idx])
            for offset in range(8, 0, -1):
                alpha = int(180 * (1 - offset / 8))
                draw.text((tx, ty), word, font=font, fill=(255, 255, 255, alpha))

        # Glow-Layer weichzeichnen
        for i in range(2):
            glow_layers[i] = glow_layers[i].filter(ImageFilter.GaussianBlur(radius=25))
        for i in range(2, 4):
            glow_layers[i] = glow_layers[i].filter(ImageFilter.GaussianBlur(radius=15))
        for i in range(4, 6):
            glow_layers[i] = glow_layers[i].filter(ImageFilter.GaussianBlur(radius=6))

        # Zusammenfügen
        for layer in glow_layers:
            result = Image.alpha_composite(result, layer)

    # Text-Layer (KEIN Schatten mehr)
    text_layer = Image.new('RGBA', (img_w, img_h), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)

    # Nur Haupttext (weiß)
    text_draw.text((tx, ty), word, font=font, fill=(255, 255, 255, 255))

    result = Image.alpha_composite(result, text_layer)

    # Als Clip mit Fade-In
    clip = ImageClip(np.array(result), duration=duration)
    clip = clip.set_position((x_pos - padding, y_pos - padding))

    # Smooth Fade-In Animation
    if fade_in > 0 and duration > fade_in:
        clip = clip.crossfadein(fade_in)

    return clip


def create_dynamic_subtitle(words: list, duration: float, video_size: tuple,
                            subtitle_config: dict = None, seed: int = None,
                            new_word_index: int = None) -> list:
    """
    Erstellt dynamische Untertitel mit Fade-In Animation.
    Gibt eine Liste von Clips zurück (einen pro Wort).

    Args:
        words: Liste von Wörtern die angezeigt werden
        duration: Dauer des Clips
        video_size: (width, height)
        subtitle_config: Optionale Konfiguration
        seed: Seed für konsistente Zufallswerte
        new_word_index: Index des neuen Wortes (bekommt Fade-In)
    """
    if not words:
        return []

    w, h = video_size

    # Seed für konsistente Variation
    if seed is not None:
        random.seed(seed)

    # Konfiguration
    base_fontsize = subtitle_config.get("subtitle_fontsize") if subtitle_config else None
    if base_fontsize is None:
        base_fontsize = max(48, int(h / 22))

    if subtitle_config and "subtitle_fontsize_multiplier" in subtitle_config:
        base_fontsize = int(base_fontsize * subtitle_config["subtitle_fontsize_multiplier"])

    # Font laden
    font_path = None
    font_paths = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]

    for fp in font_paths:
        try:
            ImageFont.truetype(fp, base_fontsize)
            font_path = fp
            break
        except:
            continue

    if font_path is None:
        return []

    # Wörter in Zeilen aufteilen und Größe PRO ZEILE bestimmen
    spacing = int(base_fontsize * 0.3)
    max_line_width = w * 0.85

    # Erst mal Wörter mit Basis-Font messen
    word_widths = []
    for word in words:
        font = ImageFont.truetype(font_path, base_fontsize)
        bbox = font.getbbox(word)
        word_widths.append(bbox[2] - bbox[0])

    # In Zeilen aufteilen
    lines = []  # [(start_idx, end_idx), ...]
    current_start = 0
    current_width = 0

    for i, ww in enumerate(word_widths):
        test_width = current_width + ww + (spacing if current_width > 0 else 0)
        if test_width > max_line_width and current_width > 0:
            lines.append((current_start, i))
            current_start = i
            current_width = ww
        else:
            current_width = test_width

    lines.append((current_start, len(words)))

    # GRÖSSE PRO ZEILE (nicht pro Wort)
    line_sizes = []
    for _ in lines:
        size_mult = random.uniform(0.88, 1.15)
        line_sizes.append(int(base_fontsize * size_mult))

    # GLOW PRO ZEILE
    line_glows = []
    for _ in lines:
        line_glows.append(random.uniform(0.8, 1.4))

    # Berechne finale Wort-Eigenschaften
    word_props = []
    for line_idx, (start, end) in enumerate(lines):
        fontsize = line_sizes[line_idx]
        glow = line_glows[line_idx]
        font = ImageFont.truetype(font_path, fontsize)

        for word_idx in range(start, end):
            word = words[word_idx]
            bbox = font.getbbox(word)
            word_w = bbox[2] - bbox[0]

            word_props.append({
                'word': word,
                'fontsize': fontsize,
                'width': word_w,
                'glow': glow,
                'line_idx': line_idx,
            })

    # Berechne Positionen
    line_height = int(base_fontsize * 1.3)
    total_height = line_height * len(lines)
    base_y = int(h * 0.70) - total_height // 2

    # Positionen für jedes Wort berechnen
    positions = []
    for line_idx, (start, end) in enumerate(lines):
        # Zeilenbreite berechnen
        line_word_props = word_props[start:end]
        line_width = sum(wp['width'] for wp in line_word_props) + spacing * (len(line_word_props) - 1)
        x_pos = (w - line_width) // 2
        y_pos = base_y + line_idx * line_height

        for wp in line_word_props:
            positions.append((x_pos, y_pos))
            x_pos += wp['width'] + spacing

    # Erstelle Clips
    clips = []
    for i, (wp, pos) in enumerate(zip(word_props, positions)):
        # Nur das neue Wort bekommt Fade-In
        is_new = (new_word_index is not None and i == new_word_index)
        fade_in = 0.12 if is_new else 0

        # Jedes 3. Wort (Index 2, 5, 8...) hat KEINEN Glow
        has_glow = (i % 3 != 2)

        clip = create_dynamic_word_clip(
            word=wp['word'],
            duration=duration,
            video_size=video_size,
            position=pos,
            fontsize=wp['fontsize'],
            glow_intensity=wp['glow'],
            font_path=font_path,
            fade_in=fade_in,
            has_glow=has_glow
        )

        if clip:
            clips.append(clip)

    return clips


def create_clean_phrase_subtitle(words: list, active_index: int, duration: float,
                                  video_size: tuple, subtitle_config: dict = None) -> ImageClip:
    """
    Erstellt akkumulierende Untertitel mit Fade-In für neue Wörter.
    Gibt einen kombinierten Clip zurück.
    """
    # Zeige nur Wörter bis zum aktiven Index
    shown_words = words[:active_index + 1]
    seed = hash(tuple(words)) % 10000

    # Erstelle Clips für alle Wörter, nur das letzte mit Fade-In
    clips = create_dynamic_subtitle(
        shown_words, duration, video_size, subtitle_config,
        seed=seed, new_word_index=active_index
    )

    if not clips:
        return None

    # Kombiniere alle Wort-Clips
    if len(clips) == 1:
        return clips[0]

    return CompositeVideoClip(clips, size=video_size)


# =============================================================================
# EMOJI OVERLAYS
# =============================================================================

def create_emoji_clip(emoji: str, duration: float, video_size: tuple,
                      position: str = "top_right") -> ImageClip:
    """Erstellt einen Emoji-Clip."""
    w, h = video_size
    emoji_size = min(80, int(w / 12))

    img = Image.new('RGBA', (emoji_size * 2, emoji_size * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font = None
    # Versuche verschiedene Emoji-Fonts
    font_paths = [
        "/System/Library/Fonts/Apple Color Emoji.ttc",
        "/Library/Fonts/Apple Color Emoji.ttc",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    ]

    for font_path in font_paths:
        try:
            font = ImageFont.truetype(font_path, emoji_size)
            break
        except Exception:
            continue

    if font is None:
        print(f"    Emoji-Font nicht gefunden, verwende Default")
        font = ImageFont.load_default()

    try:
        draw.text((emoji_size // 2, emoji_size // 2), emoji, font=font, embedded_color=True)
    except Exception as e:
        print(f"    Emoji-Zeichnen fehlgeschlagen ({emoji}): {e}")
        # Fallback: Zeichne nur den Text ohne embedded_color
        try:
            draw.text((emoji_size // 2, emoji_size // 2), emoji, font=font, fill=(255, 255, 255, 255))
        except Exception:
            pass

    clip = ImageClip(np.array(img), duration=duration)

    positions = {
        "top_right": (w - emoji_size * 2 - 30, 30),
        "top_left": (30, 30),
        "bottom_right": (w - emoji_size * 2 - 30, h - emoji_size * 2 - 30),
        "center": ((w - emoji_size * 2) // 2, (h - emoji_size * 2) // 2)
    }

    clip = clip.set_position(positions.get(position, positions["top_right"]))
    clip = clip.crossfadein(0.1).crossfadeout(0.1)

    return clip


def add_emoji_overlays(clip, emoji_events: list) -> CompositeVideoClip:
    """Fügt Emoji-Overlays hinzu."""
    if not emoji_events:
        print("    Keine Emoji-Events vorhanden")
        return clip

    emoji_clips = []
    positions = ["top_right", "top_left", "bottom_right"]

    for i, event in enumerate(emoji_events):
        timestamp, emoji = event[0], event[1]
        duration = event[2] if len(event) > 2 else 1.5

        try:
            emoji_clip = create_emoji_clip(emoji, duration, clip.size, positions[i % 3])
            emoji_clip = emoji_clip.set_start(timestamp)
            emoji_clips.append(emoji_clip)
            print(f"    Emoji '{emoji}' bei {timestamp:.1f}s erstellt")
        except Exception as e:
            print(f"    Emoji '{emoji}' fehlgeschlagen: {e}")

    if not emoji_clips:
        print("    WARNUNG: Keine Emoji-Clips konnten erstellt werden!")
        return clip

    print(f"    {len(emoji_clips)} Emoji-Clips erstellt")
    return CompositeVideoClip([clip] + emoji_clips)


def create_animated_emoji(emoji: str, duration: float, video_size: tuple,
                          animation: str = "bounce") -> ImageClip:
    """Emoji mit Animation."""
    w, h = video_size
    emoji_size = min(100, int(w / 10))

    img = Image.new('RGBA', (emoji_size * 2, emoji_size * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font = None
    # Versuche verschiedene Emoji-Fonts
    font_paths = [
        "/System/Library/Fonts/Apple Color Emoji.ttc",
        "/Library/Fonts/Apple Color Emoji.ttc",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    ]

    for font_path in font_paths:
        try:
            font = ImageFont.truetype(font_path, emoji_size)
            break
        except Exception:
            continue

    if font is None:
        print(f"    Animierter Emoji-Font nicht gefunden, verwende Default")
        font = ImageFont.load_default()

    try:
        draw.text((emoji_size // 2, emoji_size // 2), emoji, font=font, embedded_color=True)
    except Exception as e:
        print(f"    Animiertes Emoji-Zeichnen fehlgeschlagen ({emoji}): {e}")
        try:
            draw.text((emoji_size // 2, emoji_size // 2), emoji, font=font, fill=(255, 255, 255, 255))
        except Exception:
            pass

    clip = ImageClip(np.array(img), duration=duration)

    if animation == "bounce":
        def bounce_pos(t):
            progress = t / duration
            bounce = abs(math.sin(progress * math.pi * 3)) * 30 * (1 - progress)
            return (w - emoji_size * 2 - 30, 30 + int(bounce))
        clip = clip.set_position(bounce_pos)
    elif animation == "spin":
        def spin(get_frame, t):
            frame = get_frame(t)
            angle = t * 360  # Eine Rotation pro Sekunde
            pil_img = Image.fromarray(frame)
            pil_img = pil_img.rotate(angle, expand=False, fillcolor=(0, 0, 0, 0))
            return np.array(pil_img)
        clip = clip.fl(spin).set_position((w - emoji_size * 2 - 30, 30))
    elif animation == "pulse":
        # Pulse durch Scaling
        clip = clip.set_position((w - emoji_size * 2 - 30, 30))

    clip = clip.crossfadein(0.1).crossfadeout(0.1)
    return clip


# =============================================================================
# WAVEFORM OVERLAY
# =============================================================================

def create_waveform_overlay(audio_data: np.ndarray, duration: float, video_size: tuple,
                            color: tuple = (0, 255, 255), height: int = 100) -> ImageClip:
    """
    Erstellt ein Waveform-Overlay.

    Args:
        audio_data: Audio-Samples
        duration: Video-Dauer
        video_size: (width, height)
        color: RGB Farbe
        height: Höhe der Waveform
    """
    w, h = video_size

    def make_waveform_frame(t):
        # Schwarzer Hintergrund mit Transparenz
        frame = np.zeros((height, w, 4), dtype=np.uint8)

        # Berechne welchen Audio-Bereich wir zeigen
        samples_per_pixel = len(audio_data) // w

        for x in range(w):
            start_sample = x * samples_per_pixel
            end_sample = min(start_sample + samples_per_pixel, len(audio_data))

            if start_sample < len(audio_data):
                chunk = audio_data[start_sample:end_sample]
                amplitude = np.abs(chunk).mean() if len(chunk) > 0 else 0
                bar_height = int(amplitude * height * 2)
                bar_height = min(bar_height, height // 2)

                # Zeichne Balken von der Mitte aus
                center_y = height // 2
                for y in range(center_y - bar_height, center_y + bar_height):
                    if 0 <= y < height:
                        frame[y, x] = (*color, 200)

        return frame

    # Statisches Bild (für animierte Waveform wäre mehr nötig)
    waveform_frame = make_waveform_frame(0)
    clip = ImageClip(waveform_frame, duration=duration)
    clip = clip.set_position(("center", h - height - 20))

    return clip


# =============================================================================
# BACKGROUND BLUR (Portrait-Modus)
# =============================================================================

def apply_background_blur(clip, blur_amount: int = 25, face_detector=None):
    """
    Unscharfer Hintergrund mit scharfem Vordergrund (Portrait-Modus).
    Benötigt Gesichtserkennung für Maske.
    """
    w, h = clip.size

    def blur_bg(get_frame, t):
        frame = get_frame(t)

        # Gesamtes Bild weichzeichnen
        blurred = cv2.GaussianBlur(frame, (blur_amount * 2 + 1, blur_amount * 2 + 1), 0)

        # Gesicht erkennen für Maske
        if face_detector:
            faces = face_detector.detect_faces(frame)
            if faces:
                # Erstelle Maske für Gesichtsbereich (mit Puffer)
                mask = np.zeros((h, w), dtype=np.float32)
                for face in faces:
                    # Erweitere den Bereich um Kopf/Schultern
                    x = max(0, face.x - face.width // 2)
                    y = max(0, face.y - face.height // 2)
                    fw = min(w, face.width * 2)
                    fh = min(h, face.height * 3)

                    # Elliptische Maske
                    cv2.ellipse(mask,
                               (face.x + face.width // 2, face.y + face.height),
                               (fw // 2, fh // 2),
                               0, 0, 360, 1, -1)

                # Weiche Kanten
                mask = cv2.GaussianBlur(mask, (51, 51), 0)
                mask = mask[:, :, np.newaxis]

                # Kombiniere scharf und unscharf
                result = frame.astype(float) * mask + blurred.astype(float) * (1 - mask)
                return result.astype(np.uint8)

        return blurred

    return clip.fl(blur_bg)


# =============================================================================
# AUTO-REFRAME (Aspect Ratio Änderung)
# =============================================================================

def apply_auto_reframe(clip, target_ratio: str = "9:16", focus: str = "center"):
    """
    Reframe für anderes Seitenverhältnis (z.B. 16:9 -> 9:16 für TikTok).

    Args:
        clip: Video-Clip
        target_ratio: Ziel-Verhältnis ("9:16", "1:1", "4:5")
        focus: Fokuspunkt ("center", "face", "left", "right")
    """
    w, h = clip.size

    ratios = {
        "9:16": (9, 16),
        "16:9": (16, 9),
        "1:1": (1, 1),
        "4:5": (4, 5),
        "4:3": (4, 3)
    }

    if target_ratio not in ratios:
        return clip

    target_w_ratio, target_h_ratio = ratios[target_ratio]

    # Berechne neue Größe
    current_ratio = w / h
    target_ratio_float = target_w_ratio / target_h_ratio

    if current_ratio > target_ratio_float:
        # Breiter als Ziel -> horizontal croppen
        new_w = int(h * target_ratio_float)
        new_h = h
    else:
        # Höher als Ziel -> vertikal croppen
        new_w = w
        new_h = int(w / target_ratio_float)

    def reframe(get_frame, t):
        frame = get_frame(t)

        # Crop-Position basierend auf Fokus
        if focus == "center":
            x = (w - new_w) // 2
            y = (h - new_h) // 2
        elif focus == "left":
            x = 0
            y = (h - new_h) // 2
        elif focus == "right":
            x = w - new_w
            y = (h - new_h) // 2
        else:  # face - würde Gesichtserkennung brauchen
            x = (w - new_w) // 2
            y = (h - new_h) // 2

        return frame[y:y+new_h, x:x+new_w]

    return clip.fl(reframe).resize((new_w, new_h))


# =============================================================================
# INTRO / OUTRO ANIMATIONEN
# =============================================================================

def apply_slide_in(clip, duration: float = 0.5, direction: str = "right"):
    """
    Video gleitet ein von einer Richtung.

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        direction: "left", "right", "top", "bottom"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def slide_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        # Ease-out curve for smooth animation
        progress = t / duration
        progress = 1 - (1 - progress) ** 3  # Cubic ease-out

        result = np.zeros_like(frame)

        if direction == "right":
            # Slide from right: video enters from right side, moves left
            offset = int(w * (1 - progress))
            if offset < w:
                result[:, offset:] = frame[:, :w-offset]
        elif direction == "left":
            # Slide from left: video enters from left side, moves right
            offset = int(w * (1 - progress))
            if offset < w:
                result[:, :w-offset] = frame[:, offset:]
        elif direction == "top":
            # Slide from top: video enters from above, moves down
            offset = int(h * (1 - progress))
            if offset < h:
                result[:h-offset, :] = frame[offset:, :]
        elif direction == "bottom":
            # Slide from bottom: video enters from below, moves up
            offset = int(h * (1 - progress))
            if offset < h:
                result[offset:, :] = frame[:h-offset, :]

        return result

    return clip.fl(slide_filter)


def apply_slide_out(clip, duration: float = 0.5, direction: str = "left"):
    """
    Video gleitet aus in eine Richtung.

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        direction: "left", "right", "top", "bottom"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size
    start_time = clip.duration - duration

    def slide_filter(get_frame, t):
        frame = get_frame(t)
        if t < start_time:
            return frame

        # Ease-in curve
        progress = (t - start_time) / duration
        progress = progress ** 2  # Quadratic ease-in

        result = np.zeros_like(frame)

        if direction == "left":
            # Slide out to left: video exits to the left
            offset = int(w * progress)
            if offset < w:
                result[:, offset:] = frame[:, :w-offset]
        elif direction == "right":
            # Slide out to right: video exits to the right
            offset = int(w * progress)
            if offset < w:
                result[:, :w-offset] = frame[:, offset:]
        elif direction == "top":
            # Slide out to top: video exits upward
            offset = int(h * progress)
            if offset < h:
                result[offset:, :] = frame[:h-offset, :]
        elif direction == "bottom":
            # Slide out to bottom: video exits downward
            offset = int(h * progress)
            if offset < h:
                result[:h-offset, :] = frame[offset:, :]

        return result

    return clip.fl(slide_filter)


def apply_scale_in(clip, duration: float = 0.5, origin: str = "center"):
    """
    Video skaliert von einem Punkt ein (Zoom-In Effekt).

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        origin: "center", "tl" (top-left), "tr", "bl", "br"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    # Origin-Punkte definieren
    origins = {
        "center": (0.5, 0.5),
        "tl": (0.0, 0.0),
        "tr": (1.0, 0.0),
        "bl": (0.0, 1.0),
        "br": (1.0, 1.0),
    }
    ox, oy = origins.get(origin, (0.5, 0.5))

    def scale_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        # Ease-out curve
        progress = t / duration
        progress = 1 - (1 - progress) ** 3  # Cubic ease-out

        # Scale from 0 to 1
        scale = max(0.01, progress)

        # Neue Größe berechnen
        new_w, new_h = int(w * scale), int(h * scale)
        if new_w <= 0 or new_h <= 0:
            return np.zeros_like(frame)

        # Frame resizen
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        # Position basierend auf Origin
        result = np.zeros_like(frame)
        pos_x = int((w - new_w) * ox)
        pos_y = int((h - new_h) * oy)

        # Clip-Grenzen beachten
        src_x1, src_y1 = max(0, -pos_x), max(0, -pos_y)
        dst_x1, dst_y1 = max(0, pos_x), max(0, pos_y)
        src_x2 = min(new_w, w - pos_x)
        src_y2 = min(new_h, h - pos_y)
        dst_x2, dst_y2 = dst_x1 + (src_x2 - src_x1), dst_y1 + (src_y2 - src_y1)

        small_frame = np.array(img)
        if src_x2 > src_x1 and src_y2 > src_y1:
            result[dst_y1:dst_y2, dst_x1:dst_x2] = small_frame[src_y1:src_y2, src_x1:src_x2]

        return result

    return clip.fl(scale_filter)


def apply_scale_out(clip, duration: float = 0.5, origin: str = "center"):
    """
    Video skaliert zu einem Punkt aus (Zoom-Out Effekt).

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        origin: "center", "tl", "tr", "bl", "br"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size
    start_time = clip.duration - duration

    origins = {
        "center": (0.5, 0.5),
        "tl": (0.0, 0.0),
        "tr": (1.0, 0.0),
        "bl": (0.0, 1.0),
        "br": (1.0, 1.0),
    }
    ox, oy = origins.get(origin, (0.5, 0.5))

    def scale_filter(get_frame, t):
        frame = get_frame(t)
        if t < start_time:
            return frame

        progress = (t - start_time) / duration
        progress = progress ** 2  # Ease-in

        scale = max(0.01, 1 - progress)

        new_w, new_h = int(w * scale), int(h * scale)
        if new_w <= 0 or new_h <= 0:
            return np.zeros_like(frame)

        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        result = np.zeros_like(frame)
        pos_x = int((w - new_w) * ox)
        pos_y = int((h - new_h) * oy)

        src_x1, src_y1 = max(0, -pos_x), max(0, -pos_y)
        dst_x1, dst_y1 = max(0, pos_x), max(0, pos_y)
        src_x2 = min(new_w, w - pos_x)
        src_y2 = min(new_h, h - pos_y)
        dst_x2, dst_y2 = dst_x1 + (src_x2 - src_x1), dst_y1 + (src_y2 - src_y1)

        small_frame = np.array(img)
        if src_x2 > src_x1 and src_y2 > src_y1:
            result[dst_y1:dst_y2, dst_x1:dst_x2] = small_frame[src_y1:src_y2, src_x1:src_x2]

        return result

    return clip.fl(scale_filter)


def apply_flip_in(clip, duration: float = 0.5, axis: str = "horizontal"):
    """
    Video dreht sich ein (3D-Flip Effekt).

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        axis: "horizontal" oder "vertical"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def flip_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        # Ease-out curve
        progress = t / duration
        progress = 1 - (1 - progress) ** 2

        # Simulate 3D rotation with scaling
        if axis == "horizontal":
            # Flip um horizontale Achse (von oben einklappen)
            scale_y = progress
            if scale_y < 0.01:
                return np.zeros_like(frame)

            new_h = int(h * scale_y)
            if new_h <= 0:
                return np.zeros_like(frame)

            img = Image.fromarray(frame)
            img = img.resize((w, new_h), Image.LANCZOS)

            result = np.zeros_like(frame)
            offset_y = (h - new_h) // 2
            small_frame = np.array(img)
            result[offset_y:offset_y+new_h, :] = small_frame

            return result
        else:
            # Flip um vertikale Achse (von links einklappen)
            scale_x = progress
            if scale_x < 0.01:
                return np.zeros_like(frame)

            new_w = int(w * scale_x)
            if new_w <= 0:
                return np.zeros_like(frame)

            img = Image.fromarray(frame)
            img = img.resize((new_w, h), Image.LANCZOS)

            result = np.zeros_like(frame)
            offset_x = (w - new_w) // 2
            small_frame = np.array(img)
            result[:, offset_x:offset_x+new_w] = small_frame

            return result

    return clip.fl(flip_filter)


def apply_bounce_in(clip, duration: float = 0.6, direction: str = "bottom"):
    """
    Video federt ein (Bounce-Effekt).

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        direction: "left", "right", "top", "bottom"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def bounce_easing(t):
        """Bounce easing function."""
        if t < 1/2.75:
            return 7.5625 * t * t
        elif t < 2/2.75:
            t -= 1.5/2.75
            return 7.5625 * t * t + 0.75
        elif t < 2.5/2.75:
            t -= 2.25/2.75
            return 7.5625 * t * t + 0.9375
        else:
            t -= 2.625/2.75
            return 7.5625 * t * t + 0.984375

    def bounce_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        progress = t / duration
        eased = bounce_easing(progress)

        result = np.zeros_like(frame)

        if direction == "bottom":
            # Bounce from bottom: video enters from below, moves up
            offset = int(h * (1 - eased))
            if offset < h:
                result[offset:, :] = frame[:h-offset, :]
        elif direction == "top":
            # Bounce from top: video enters from above, moves down
            offset = int(h * (1 - eased))
            if offset < h:
                result[:h-offset, :] = frame[offset:, :]
        elif direction == "right":
            # Bounce from right: video enters from right side, moves left
            offset = int(w * (1 - eased))
            if offset < w:
                result[:, offset:] = frame[:, :w-offset]
        elif direction == "left":
            # Bounce from left: video enters from left side, moves right
            offset = int(w * (1 - eased))
            if offset < w:
                result[:, :w-offset] = frame[:, offset:]

        return result

    return clip.fl(bounce_filter)


def apply_spin_in(clip, duration: float = 0.5, direction: str = "clockwise"):
    """
    Video rotiert ein (Spin-Effekt).

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        direction: "clockwise" oder "counter-clockwise"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def spin_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        # Ease-out curve
        progress = t / duration
        progress = 1 - (1 - progress) ** 3

        # Rotation und Scale
        if direction == "clockwise":
            angle = 360 * (1 - progress)
        else:
            angle = -360 * (1 - progress)

        scale = progress

        if scale < 0.01:
            return np.zeros_like(frame)

        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, scale)
        result = cv2.warpAffine(frame, M, (w, h), borderValue=(0, 0, 0))

        return result

    return clip.fl(spin_filter)


def apply_elastic_in(clip, duration: float = 0.7, intensity: float = 0.3):
    """
    Elastischer Bounce-Effekt beim Einblenden.

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        intensity: Stärke des elastischen Effekts
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def elastic_easing(t):
        """Elastic easing function."""
        if t == 0 or t == 1:
            return t
        p = 0.3
        s = p / 4
        return pow(2, -10 * t) * math.sin((t - s) * (2 * math.pi) / p) + 1

    def elastic_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        progress = t / duration
        eased = elastic_easing(progress)

        # Scale basierend auf elastischem Easing
        scale = min(1.0 + intensity * (eased - 1), 1.5)  # Cap at 1.5x
        scale = max(0.01, scale)

        new_w, new_h = int(w * scale), int(h * scale)
        if new_w <= 0 or new_h <= 0:
            return np.zeros_like(frame)

        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        # Zentrieren
        result = np.zeros_like(frame)
        left = (new_w - w) // 2
        top = (new_h - h) // 2

        # Crop auf Originalgröße
        if new_w >= w and new_h >= h:
            cropped = img.crop((left, top, left + w, top + h))
            result = np.array(cropped)
        else:
            # Frame in Mitte des Ergebnisses
            offset_x = (w - new_w) // 2
            offset_y = (h - new_h) // 2
            small_frame = np.array(img)
            result[offset_y:offset_y+new_h, offset_x:offset_x+new_w] = small_frame

        return result

    return clip.fl(elastic_filter)


def apply_blur_slide_in(clip, duration: float = 0.5, direction: str = "right"):
    """
    Kombination aus Blur und Slide Effekt.

    Args:
        clip: Video-Clip
        duration: Dauer der Animation
        direction: "left", "right", "top", "bottom"
    """
    if duration <= 0 or duration >= clip.duration:
        return clip

    w, h = clip.size

    def blur_slide_filter(get_frame, t):
        frame = get_frame(t)
        if t >= duration:
            return frame

        progress = t / duration
        progress_eased = 1 - (1 - progress) ** 3

        # Blur-Intensität nimmt ab
        blur_amount = int(30 * (1 - progress))

        # Frame blurren
        if blur_amount > 0:
            img = Image.fromarray(frame)
            img = img.filter(ImageFilter.GaussianBlur(radius=blur_amount))
            frame = np.array(img)

        # Slide-Effekt
        result = np.zeros_like(frame)

        if direction == "right":
            # Blur-slide from right, moves left
            offset = int(w * (1 - progress_eased))
            if offset < w:
                result[:, offset:] = frame[:, :w-offset]
        elif direction == "left":
            # Blur-slide from left, moves right
            offset = int(w * (1 - progress_eased))
            if offset < w:
                result[:, :w-offset] = frame[:, offset:]
        elif direction == "top":
            # Blur-slide from top, moves down
            offset = int(h * (1 - progress_eased))
            if offset < h:
                result[:h-offset, :] = frame[offset:, :]
        elif direction == "bottom":
            # Blur-slide from bottom, moves up
            offset = int(h * (1 - progress_eased))
            if offset < h:
                result[offset:, :] = frame[:h-offset, :]

        return result

    return clip.fl(blur_slide_filter)


# =============================================================================
# INTRO / OUTRO CLIPS
# =============================================================================

def create_intro_clip(title: str, duration: float, video_size: tuple,
                      style: str = "fade") -> CompositeVideoClip:
    """Erstellt einen Intro-Clip mit Titel."""
    w, h = video_size

    bg = ColorClip(size=(w, h), color=(0, 0, 0), duration=duration)

    try:
        title_clip = TextClip(
            title,
            fontsize=max(30, min(60, int(w / 12))),
            color="white",
            stroke_color="black",
            stroke_width=2,
            size=(w - 60, None),
            method='caption'
        )
        title_clip = title_clip.set_duration(duration)
        title_clip = title_clip.set_position("center")

        if style == "fade":
            title_clip = title_clip.crossfadein(0.5).crossfadeout(0.3)
        elif style == "zoom":
            title_clip = title_clip.crossfadein(0.3)

        return CompositeVideoClip([bg, title_clip])

    except Exception as e:
        print(f"    Intro-Clip Fehler: {e}")
        return bg


# =============================================================================
# HELPER FUNKTIONEN
# =============================================================================

# =============================================================================
# SEGMENT-EFFEKTE (für zeitbasierte Anwendung)
# =============================================================================

def apply_desaturate_segment(clip, start: float, duration: float, intensity: float = 1.0):
    """
    Schwarz-weiß Effekt für ein bestimmtes Segment.

    Args:
        clip: Video-Clip
        start: Startzeit in Sekunden
        duration: Dauer des Effekts
        intensity: 0.0 = Farbe, 1.0 = Schwarz-Weiß
    """
    end = start + duration

    def desaturate_filter(get_frame, t):
        frame = get_frame(t)
        if t < start or t > end:
            return frame

        # Fade in/out für sanften Übergang
        if t < start + 0.1:
            local_intensity = intensity * ((t - start) / 0.1)
        elif t > end - 0.1:
            local_intensity = intensity * ((end - t) / 0.1)
        else:
            local_intensity = intensity

        gray = np.dot(frame[..., :3], [0.299, 0.587, 0.114])
        gray = np.stack([gray] * 3, axis=-1)

        result = frame.astype(float) * (1 - local_intensity) + gray * local_intensity
        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(desaturate_filter)


def apply_slow_motion_segment(clip, start: float, duration: float, factor: float = 0.5):
    """
    Slow-Motion für ein bestimmtes Segment.
    HINWEIS: Ändert die Clip-Dauer!

    Args:
        clip: Video-Clip
        start: Startzeit in Sekunden
        duration: Originaldauer des Segments
        factor: Geschwindigkeitsfaktor (0.5 = halbe Geschwindigkeit)
    """
    end = min(start + duration, clip.duration)

    if start >= clip.duration or end <= start:
        return clip

    clips = []

    # Teil vor Slowmo
    if start > 0:
        before = clip.subclip(0, start)
        clips.append(before)

    # Slowmo-Segment
    slowmo_segment = clip.subclip(start, end)
    slowmo_segment = slowmo_segment.fx(lambda c: c.speedx(factor))
    clips.append(slowmo_segment)

    # Teil nach Slowmo
    if end < clip.duration - 0.01:
        after = clip.subclip(end)
        clips.append(after)

    if len(clips) == 1:
        return clips[0]

    return concatenate_videoclips(clips, method="compose")


def apply_speed_up_segment(clip, start: float, duration: float, factor: float = 2.0):
    """
    Beschleunigung für ein bestimmtes Segment.
    HINWEIS: Ändert die Clip-Dauer!

    Args:
        clip: Video-Clip
        start: Startzeit in Sekunden
        duration: Originaldauer des Segments
        factor: Geschwindigkeitsfaktor (2.0 = doppelte Geschwindigkeit)
    """
    return apply_slow_motion_segment(clip, start, duration, 1.0 / factor)


def apply_reverse_segment(clip, start: float, duration: float):
    """
    Spielt ein Segment rückwärts ab.

    Args:
        clip: Video-Clip
        start: Startzeit in Sekunden
        duration: Dauer des Segments
    """
    end = min(start + duration, clip.duration)

    if start >= clip.duration or end <= start:
        return clip

    clips = []

    # Teil vor Reverse
    if start > 0:
        before = clip.subclip(0, start)
        clips.append(before)

    # Reverse-Segment
    reverse_segment = clip.subclip(start, end)
    reverse_segment = reverse_segment.fx(lambda c: c.time_mirror())
    clips.append(reverse_segment)

    # Teil nach Reverse
    if end < clip.duration - 0.01:
        after = clip.subclip(end)
        clips.append(after)

    if len(clips) == 1:
        return clips[0]

    return concatenate_videoclips(clips, method="compose")


def apply_flash(clip, time: float, duration: float = 0.1, intensity: float = 1.0):
    """
    Weißer Blitz an bestimmtem Zeitpunkt.

    Args:
        clip: Video-Clip
        time: Zeitpunkt des Blitzes
        duration: Dauer des Blitzes
        intensity: Helligkeit (0-1)
    """
    def flash_filter(get_frame, t):
        frame = get_frame(t)
        if t < time or t > time + duration:
            return frame

        # Flash-Intensität (fade in/out)
        progress = (t - time) / duration
        if progress < 0.3:
            flash_amount = intensity * (progress / 0.3)
        else:
            flash_amount = intensity * (1 - (progress - 0.3) / 0.7)

        white = np.ones_like(frame) * 255
        result = frame.astype(float) * (1 - flash_amount) + white * flash_amount
        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl(flash_filter)


def apply_impact_zoom(clip, time: float, duration: float = 0.3, intensity: float = 1.2):
    """
    Schneller Zoom-Impakt bei Zeitpunkt.

    Args:
        clip: Video-Clip
        time: Zeitpunkt des Impacts
        duration: Dauer des Effekts
        intensity: Zoom-Faktor (1.2 = 20% vergrößern)
    """
    w, h = clip.size

    def impact_filter(get_frame, t):
        frame = get_frame(t)
        if t < time or t > time + duration:
            return frame

        progress = (t - time) / duration

        # Schneller Zoom-In, langsamer Zoom-Out
        if progress < 0.2:
            zoom = 1.0 + (intensity - 1.0) * (progress / 0.2)
        else:
            zoom = 1.0 + (intensity - 1.0) * (1 - (progress - 0.2) / 0.8)

        if abs(zoom - 1.0) < 0.001:
            return frame

        new_w, new_h = int(w * zoom), int(h * zoom)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(impact_filter)


def apply_shake_segment(clip, start: float, duration: float, intensity: float = 10):
    """
    Kamera-Shake für ein bestimmtes Segment.

    Args:
        clip: Video-Clip
        start: Startzeit
        duration: Dauer
        intensity: Pixel-Verschiebung
    """
    w, h = clip.size
    end = start + duration

    def shake_filter(get_frame, t):
        frame = get_frame(t)
        if t < start or t > end:
            return frame

        # Intensität fade in/out
        local_progress = (t - start) / duration
        if local_progress < 0.1:
            local_intensity = intensity * (local_progress / 0.1)
        elif local_progress > 0.9:
            local_intensity = intensity * ((1 - local_progress) / 0.1)
        else:
            local_intensity = intensity

        offset_x = int(math.sin(t * 50) * local_intensity)
        offset_y = int(math.cos(t * 60) * local_intensity)

        M = np.float32([[1, 0, offset_x], [0, 1, offset_y]])
        return cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_REFLECT)

    return clip.fl(shake_filter)


def apply_zoom_segment(clip, start: float, duration: float, zoom_factor: float = 1.3):
    """
    Zoom-Effekt für ein bestimmtes Segment.

    Args:
        clip: Video-Clip
        start: Startzeit
        duration: Dauer
        zoom_factor: Zoom-Faktor
    """
    w, h = clip.size
    end = start + duration

    def zoom_filter(get_frame, t):
        frame = get_frame(t)
        if t < start or t > end:
            return frame

        # Zoom in und out
        local_progress = (t - start) / duration
        if local_progress < 0.5:
            zoom = 1.0 + (zoom_factor - 1.0) * (local_progress / 0.5)
        else:
            zoom = 1.0 + (zoom_factor - 1.0) * ((1 - local_progress) / 0.5)

        if abs(zoom - 1.0) < 0.001:
            return frame

        new_w, new_h = int(w * zoom), int(h * zoom)
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        left = (new_w - w) // 2
        top = (new_h - h) // 2
        img = img.crop((left, top, left + w, top + h))

        return np.array(img)

    return clip.fl(zoom_filter)


def apply_blur_segment(clip, start: float, duration: float, max_blur: int = 20):
    """
    Blur-Effekt für ein bestimmtes Segment.

    Args:
        clip: Video-Clip
        start: Startzeit
        duration: Dauer
        max_blur: Maximale Unschärfe
    """
    end = start + duration

    def blur_filter(get_frame, t):
        frame = get_frame(t)
        if t < start or t > end:
            return frame

        # Blur fade in/out
        local_progress = (t - start) / duration
        if local_progress < 0.2:
            blur_amount = int(max_blur * (local_progress / 0.2))
        elif local_progress > 0.8:
            blur_amount = int(max_blur * ((1 - local_progress) / 0.2))
        else:
            blur_amount = max_blur

        if blur_amount <= 0:
            return frame

        img = Image.fromarray(frame)
        img = img.filter(ImageFilter.GaussianBlur(radius=blur_amount))
        return np.array(img)

    return clip.fl(blur_filter)


# =============================================================================
# HELPER FUNKTIONEN
# =============================================================================

# =============================================================================
# NEUE VISUELLE EFFEKTE
# =============================================================================

def apply_scanlines(clip, intensity: float = 0.3, line_height: int = 2):
    """
    Fügt Scanlines hinzu (Retro-Monitor-Look).

    Args:
        clip: Video-Clip
        intensity: Stärke des Effekts (0-1)
        line_height: Höhe der Scanlines in Pixeln
    """
    def add_scanlines(frame):
        h, w = frame.shape[:2]
        result = frame.astype(float)

        # Erstelle Scanline-Maske
        for y in range(0, h, line_height * 2):
            if y + line_height <= h:
                result[y:y+line_height, :] *= (1 - intensity)

        return np.clip(result, 0, 255).astype(np.uint8)

    return clip.fl_image(add_scanlines)


def apply_chromatic_aberration(clip, intensity: float = 5):
    """
    Chromatische Aberration (Farbverschiebung an den Rändern).

    Args:
        clip: Video-Clip
        intensity: Verschiebungsstärke in Pixeln
    """
    def aberration(frame):
        h, w = frame.shape[:2]
        result = np.zeros_like(frame)

        offset = int(intensity)

        # Rot-Kanal nach links
        result[:, :w-offset, 0] = frame[:, offset:, 0]
        # Grün-Kanal bleibt
        result[:, :, 1] = frame[:, :, 1]
        # Blau-Kanal nach rechts
        result[:, offset:, 2] = frame[:, :w-offset, 2]

        return result

    return clip.fl_image(aberration)


def apply_glitch_blocks(clip, intensity: float = 0.5, block_size: int = 20):
    """
    Zufällige Glitch-Blöcke (Datamosh-Style).

    Args:
        clip: Video-Clip
        intensity: Häufigkeit der Glitches (0-1)
        block_size: Größe der Blöcke
    """
    random.seed(42)  # Reproduzierbar

    def glitch(frame):
        if random.random() > intensity:
            return frame

        result = frame.copy()
        h, w = frame.shape[:2]

        # Zufällige Blöcke verschieben
        num_blocks = random.randint(1, 5)
        for _ in range(num_blocks):
            y = random.randint(0, h - block_size)
            x = random.randint(0, w - block_size)
            shift = random.randint(-50, 50)

            block = frame[y:y+block_size, max(0, x+shift):min(w, x+block_size+shift)]
            if block.shape[1] > 0:
                target_w = min(block.shape[1], w - x)
                result[y:y+block_size, x:x+target_w] = block[:, :target_w]

        return result

    return clip.fl_image(glitch)


def apply_crt_effect(clip, curvature: float = 0.1, scanline_intensity: float = 0.2):
    """
    CRT-Monitor-Effekt mit Krümmung und Scanlines.

    Args:
        clip: Video-Clip
        curvature: Bildschirmkrümmung
        scanline_intensity: Scanline-Stärke
    """
    def crt(frame):
        h, w = frame.shape[:2]

        # Barrel-Distortion für CRT-Krümmung
        cx, cy = w // 2, h // 2
        result = np.zeros_like(frame)

        for y in range(h):
            for x in range(w):
                # Normalisierte Koordinaten
                nx = (x - cx) / cx
                ny = (y - cy) / cy

                # Barrel-Distortion
                r = np.sqrt(nx*nx + ny*ny)
                factor = 1 + curvature * r * r

                src_x = int(cx + nx * factor * cx)
                src_y = int(cy + ny * factor * cy)

                if 0 <= src_x < w and 0 <= src_y < h:
                    result[y, x] = frame[src_y, src_x]

        # Scanlines hinzufügen
        for y in range(0, h, 3):
            result[y, :] = (result[y, :].astype(float) * (1 - scanline_intensity)).astype(np.uint8)

        return result

    # Da CRT-Effekt teuer ist, nur für kurze Clips oder reduzierte Version
    if clip.duration > 10:
        return apply_scanlines(clip, scanline_intensity)

    return clip.fl_image(crt)


def apply_color_grade_preset(clip, preset: str = "cinematic"):
    """
    Wendet vordefinierte Color-Grading-Presets an.

    Presets:
        - cinematic: Filmischer Look mit Teal/Orange
        - cyberpunk: Neon-Pink/Blau
        - vintage: Verblasst, warm
        - noir: Schwarz-Weiß mit hohem Kontrast
        - sunset: Warme Orange/Gold-Töne
        - arctic: Kalte Blau-Töne
        - matrix: Grün-getönt
        - sepia: Klassischer Sepia-Look
    """
    def grade(frame):
        result = frame.astype(float)

        if preset == "cinematic":
            # Teal in Schatten, Orange in Highlights
            shadows_teal = np.array([20, 40, 50])
            highlights_orange = np.array([30, 15, -10])
            luminance = np.dot(result[..., :3], [0.299, 0.587, 0.114])
            shadow_mask = (luminance < 128)[:, :, np.newaxis]
            result = result + shadow_mask * shadows_teal + (1 - shadow_mask) * highlights_orange
            result = np.clip(result * 1.1, 0, 255)  # Leichter Kontrast

        elif preset == "cyberpunk":
            # Neon Pink und Blau
            result[:, :, 0] = np.clip(result[:, :, 0] * 1.2, 0, 255)  # Mehr Rot
            result[:, :, 2] = np.clip(result[:, :, 2] * 1.3, 0, 255)  # Mehr Blau
            result[:, :, 1] = result[:, :, 1] * 0.8  # Weniger Grün
            result = np.clip((result - 128) * 1.3 + 128, 0, 255)  # Hoher Kontrast

        elif preset == "vintage":
            # Verblasst, leicht entsättigt
            gray = np.dot(result[..., :3], [0.299, 0.587, 0.114])[:, :, np.newaxis]
            result = result * 0.7 + gray * 0.3  # Entsättigen
            result = result + np.array([15, 10, 0])  # Warmer Ton
            result = np.clip(result * 0.9 + 25, 0, 255)  # Verblasst

        elif preset == "noir":
            # Schwarz-Weiß mit hohem Kontrast
            gray = np.dot(result[..., :3], [0.299, 0.587, 0.114])
            gray = np.clip((gray - 128) * 1.5 + 128, 0, 255)
            result = np.stack([gray, gray, gray], axis=-1)

        elif preset == "sunset":
            # Warme Orange/Gold-Töne
            result[:, :, 0] = np.clip(result[:, :, 0] * 1.15, 0, 255)  # Rot+
            result[:, :, 1] = np.clip(result[:, :, 1] * 1.05, 0, 255)  # Grün+
            result[:, :, 2] = result[:, :, 2] * 0.85  # Blau-
            result = np.clip(result + 10, 0, 255)  # Aufhellen

        elif preset == "arctic":
            # Kalte Blau-Töne
            result[:, :, 0] = result[:, :, 0] * 0.85  # Rot-
            result[:, :, 1] = result[:, :, 1] * 0.95  # Grün-
            result[:, :, 2] = np.clip(result[:, :, 2] * 1.2, 0, 255)  # Blau+

        elif preset == "matrix":
            # Grün-getönt
            result[:, :, 0] = result[:, :, 0] * 0.5  # Rot-
            result[:, :, 1] = np.clip(result[:, :, 1] * 1.3, 0, 255)  # Grün+
            result[:, :, 2] = result[:, :, 2] * 0.6  # Blau-

        elif preset == "sepia":
            gray = np.dot(result[..., :3], [0.299, 0.587, 0.114])
            result[:, :, 0] = np.clip(gray * 1.2 + 30, 0, 255)  # Rot
            result[:, :, 1] = np.clip(gray * 1.0 + 15, 0, 255)  # Grün
            result[:, :, 2] = np.clip(gray * 0.8, 0, 255)  # Blau

        elif preset == "tiktok":
            # Subtiler Lila/Blau-Stich für Premium-Look
            result[:, :, 0] = np.clip(result[:, :, 0] * 1.02 + 5, 0, 255)  # Leicht mehr Rot (für Lila)
            result[:, :, 1] = result[:, :, 1] * 0.97  # Etwas weniger Grün
            result[:, :, 2] = np.clip(result[:, :, 2] * 1.08 + 8, 0, 255)  # Mehr Blau
            result = np.clip((result - 128) * 1.05 + 128, 0, 255)  # Leichter Kontrast

        return result.astype(np.uint8)

    return clip.fl_image(grade)


def apply_split_screen(clip, layout: str = "horizontal", clips: list = None):
    """
    Split-Screen-Effekt.

    Args:
        clip: Haupt-Clip
        layout: "horizontal" (links/rechts), "vertical" (oben/unten), "quad" (4-Teile)
        clips: Optionale zusätzliche Clips für die anderen Bereiche
    """
    w, h = clip.size

    if layout == "horizontal":
        # Links: Original, Rechts: gespiegelt oder zweiter Clip
        def split_h(frame):
            result = np.zeros_like(frame)
            half_w = w // 2
            result[:, :half_w] = frame[:, :half_w]
            result[:, half_w:] = frame[:, :half_w][:, ::-1]  # Gespiegelt
            return result
        return clip.fl_image(split_h)

    elif layout == "vertical":
        # Oben: Original, Unten: gespiegelt
        def split_v(frame):
            result = np.zeros_like(frame)
            half_h = h // 2
            result[:half_h, :] = frame[:half_h, :]
            result[half_h:, :] = frame[:half_h, :][::-1, :]  # Vertikal gespiegelt
            return result
        return clip.fl_image(split_v)

    elif layout == "quad":
        # 4 Quadranten
        def split_quad(frame):
            result = np.zeros_like(frame)
            half_w, half_h = w // 2, h // 2

            # Original verkleinern auf 1/4
            small = cv2.resize(frame, (half_w, half_h))

            # In alle 4 Ecken
            result[:half_h, :half_w] = small
            result[:half_h, half_w:half_w*2] = small[:, ::-1]
            result[half_h:half_h*2, :half_w] = small[::-1, :]
            result[half_h:half_h*2, half_w:half_w*2] = small[::-1, ::-1]
            return result
        return clip.fl_image(split_quad)

    return clip


def apply_ken_burns(clip, start_pos: str = "center", end_pos: str = "center",
                    start_zoom: float = 1.0, end_zoom: float = 1.3):
    """
    Ken Burns Effekt - langsamer Zoom und Pan.

    Args:
        clip: Video-Clip
        start_pos: Startposition ("center", "top_left", "top_right", "bottom_left", "bottom_right")
        end_pos: Endposition
        start_zoom: Zoom am Anfang
        end_zoom: Zoom am Ende
    """
    w, h = clip.size

    # Position zu Koordinaten
    positions = {
        "center": (0.5, 0.5),
        "top_left": (0.25, 0.25),
        "top_right": (0.75, 0.25),
        "bottom_left": (0.25, 0.75),
        "bottom_right": (0.75, 0.75),
        "left": (0.25, 0.5),
        "right": (0.75, 0.5),
        "top": (0.5, 0.25),
        "bottom": (0.5, 0.75)
    }

    start_x, start_y = positions.get(start_pos, (0.5, 0.5))
    end_x, end_y = positions.get(end_pos, (0.5, 0.5))

    def ken_burns(get_frame, t):
        frame = get_frame(t)
        progress = t / clip.duration

        # Interpoliere Zoom und Position
        current_zoom = start_zoom + (end_zoom - start_zoom) * progress
        current_x = start_x + (end_x - start_x) * progress
        current_y = start_y + (end_y - start_y) * progress

        # Berechne Crop-Bereich
        crop_w = int(w / current_zoom)
        crop_h = int(h / current_zoom)

        # Zentriere auf aktuelle Position
        x1 = int(current_x * w - crop_w / 2)
        y1 = int(current_y * h - crop_h / 2)

        # Grenzen prüfen
        x1 = max(0, min(x1, w - crop_w))
        y1 = max(0, min(y1, h - crop_h))

        # Crop und Resize
        cropped = frame[y1:y1+crop_h, x1:x1+crop_w]
        result = cv2.resize(cropped, (w, h))

        return result

    return clip.fl(ken_burns)


def apply_picture_in_picture(main_clip, pip_clip, position: str = "bottom_right",
                              size: float = 0.25, border: int = 3):
    """
    Bild-im-Bild Effekt.

    Args:
        main_clip: Hauptvideo
        pip_clip: Kleines Einblendevideo
        position: Position ("top_left", "top_right", "bottom_left", "bottom_right")
        size: Größe des PiP relativ zum Hauptvideo (0-1)
        border: Randbreite in Pixeln
    """
    w, h = main_clip.size
    pip_w = int(w * size)
    pip_h = int(h * size)

    # Position berechnen
    margin = 20
    if position == "top_left":
        x, y = margin, margin
    elif position == "top_right":
        x, y = w - pip_w - margin, margin
    elif position == "bottom_left":
        x, y = margin, h - pip_h - margin
    else:  # bottom_right
        x, y = w - pip_w - margin, h - pip_h - margin

    # PiP-Clip skalieren
    pip_resized = pip_clip.resize((pip_w, pip_h))

    # Dauer anpassen
    if pip_resized.duration > main_clip.duration:
        pip_resized = pip_resized.subclip(0, main_clip.duration)

    # Mit Rand versehen (schwarzer Rahmen)
    def add_border(frame):
        result = frame.copy()
        result[:border, :] = 0  # Oben
        result[-border:, :] = 0  # Unten
        result[:, :border] = 0  # Links
        result[:, -border:] = 0  # Rechts
        return result

    pip_bordered = pip_resized.fl_image(add_border)

    return CompositeVideoClip([
        main_clip,
        pip_bordered.set_position((x, y))
    ])


def apply_beat_flash(clip, beat_times: list, intensity: float = 0.3, duration: float = 0.05):
    """
    Flash-Effekt bei jedem Beat.

    Args:
        clip: Video-Clip
        beat_times: Liste von Beat-Zeitpunkten
        intensity: Helligkeit des Flashes (0-1)
        duration: Dauer jedes Flashes
    """
    def flash_at_beats(get_frame, t):
        frame = get_frame(t)

        # Prüfe ob wir nahe einem Beat sind
        for beat in beat_times:
            if beat <= t < beat + duration:
                # Flash: Frame aufhellen
                progress = (t - beat) / duration
                flash_intensity = intensity * (1 - progress)  # Fade out
                result = frame.astype(float) + flash_intensity * 255
                return np.clip(result, 0, 255).astype(np.uint8)

        return frame

    return clip.fl(flash_at_beats)


def apply_beat_shake(clip, beat_times: list, intensity: float = 10, duration: float = 0.1):
    """
    Shake-Effekt bei jedem Beat.

    Args:
        clip: Video-Clip
        beat_times: Liste von Beat-Zeitpunkten
        intensity: Shake-Stärke in Pixeln
        duration: Dauer jedes Shakes
    """
    w, h = clip.size

    def shake_at_beats(get_frame, t):
        frame = get_frame(t)

        for beat in beat_times:
            if beat <= t < beat + duration:
                progress = (t - beat) / duration
                shake_amount = intensity * (1 - progress)  # Decay

                dx = int(random.uniform(-shake_amount, shake_amount))
                dy = int(random.uniform(-shake_amount, shake_amount))

                # Verschieben mit Wrap
                result = np.roll(frame, dx, axis=1)
                result = np.roll(result, dy, axis=0)
                return result

        return frame

    return clip.fl(shake_at_beats)


def apply_beat_zoom(clip, beat_times: list, intensity: float = 0.08, duration: float = 0.15):
    """
    Zoom-Pulse bei jedem Beat.

    Args:
        clip: Video-Clip
        beat_times: Liste von Beat-Zeitpunkten
        intensity: Zoom-Stärke (0.1 = 10% Zoom)
        duration: Dauer jedes Zooms
    """
    w, h = clip.size

    def zoom_at_beats(get_frame, t):
        frame = get_frame(t)

        for beat in beat_times:
            if beat <= t < beat + duration:
                progress = (t - beat) / duration
                # Schneller Zoom-in, langsamer Zoom-out
                ease = 1 - (progress ** 0.5)  # Ease-out
                zoom = 1 + intensity * ease

                # Crop und Resize
                new_w = int(w / zoom)
                new_h = int(h / zoom)
                x1 = (w - new_w) // 2
                y1 = (h - new_h) // 2

                cropped = frame[y1:y1+new_h, x1:x1+new_w]
                return cv2.resize(cropped, (w, h))

        return frame

    return clip.fl(zoom_at_beats)


def apply_bass_drop_effect(clip, drop_times: list, effect: str = "zoom",
                            intensity: float = 1.0, duration: float = 0.3):
    """
    Effekt bei Bass-Drops.

    Args:
        clip: Video-Clip
        drop_times: Liste von Bass-Drop-Zeitpunkten
        effect: "zoom", "shake", "flash", "glitch", "slowmo"
        intensity: Effekt-Stärke
        duration: Effekt-Dauer
    """
    if effect == "zoom":
        return apply_beat_zoom(clip, drop_times, intensity * 0.15, duration)
    elif effect == "shake":
        return apply_beat_shake(clip, drop_times, intensity * 15, duration)
    elif effect == "flash":
        return apply_beat_flash(clip, drop_times, intensity * 0.5, duration)
    elif effect == "glitch":
        # Glitch bei jedem Drop
        def glitch_at_drops(get_frame, t):
            frame = get_frame(t)
            for drop in drop_times:
                if drop <= t < drop + duration:
                    # RGB-Split
                    offset = int(10 * intensity)
                    result = np.zeros_like(frame)
                    result[:, offset:, 0] = frame[:, :-offset, 0]
                    result[:, :, 1] = frame[:, :, 1]
                    result[:, :-offset, 2] = frame[:, offset:, 2]
                    return result
            return frame
        return clip.fl(glitch_at_drops)

    return clip


def apply_volume_reactive_zoom(clip, volume_data: list, max_zoom: float = 1.15):
    """
    Zoom reagiert auf Lautstärke.

    Args:
        clip: Video-Clip
        volume_data: Liste von (time, volume) Tuples (volume 0-1)
        max_zoom: Maximaler Zoom bei voller Lautstärke
    """
    w, h = clip.size

    # Erstelle Volume-Lookup
    times = [v[0] for v in volume_data]
    volumes = [v[1] for v in volume_data]

    def get_volume_at_time(t):
        if not times:
            return 0.5
        idx = np.searchsorted(times, t)
        if idx >= len(volumes):
            return volumes[-1]
        if idx == 0:
            return volumes[0]
        return volumes[idx]

    def volume_zoom(get_frame, t):
        frame = get_frame(t)
        vol = get_volume_at_time(t)

        zoom = 1 + (max_zoom - 1) * vol

        new_w = int(w / zoom)
        new_h = int(h / zoom)
        x1 = (w - new_w) // 2
        y1 = (h - new_h) // 2

        cropped = frame[y1:y1+new_h, x1:x1+new_w]
        return cv2.resize(cropped, (w, h))

    return clip.fl(volume_zoom)


def apply_face_zoom(clip, face_positions: list, zoom_factor: float = 1.5, smooth: bool = True):
    """
    Automatischer Zoom auf erkannte Gesichter.

    Args:
        clip: Video-Clip
        face_positions: Liste von (time, x, y, w, h) Tuples
        zoom_factor: Zoom-Stärke
        smooth: Sanfte Übergänge zwischen Positionen
    """
    clip_w, clip_h = clip.size

    def get_face_at_time(t):
        """Findet das nächste Gesicht zum Zeitpunkt t."""
        if not face_positions:
            return None

        closest = min(face_positions, key=lambda f: abs(f[0] - t))
        if abs(closest[0] - t) < 1.0:  # Innerhalb 1 Sekunde
            return closest
        return None

    def zoom_to_face(get_frame, t):
        frame = get_frame(t)
        face = get_face_at_time(t)

        if face is None:
            return frame

        _, fx, fy, fw, fh = face

        # Zentriere auf Gesicht
        center_x = fx + fw // 2
        center_y = fy + fh // 2

        # Berechne Crop
        crop_w = int(clip_w / zoom_factor)
        crop_h = int(clip_h / zoom_factor)

        x1 = max(0, min(center_x - crop_w // 2, clip_w - crop_w))
        y1 = max(0, min(center_y - crop_h // 2, clip_h - crop_h))

        cropped = frame[y1:y1+crop_h, x1:x1+crop_w]
        return cv2.resize(cropped, (clip_w, clip_h))

    return clip.fl(zoom_to_face)


def apply_face_blur(clip, face_positions: list, blur_amount: int = 30):
    """
    Verpixelt/blurt erkannte Gesichter.

    Args:
        clip: Video-Clip
        face_positions: Liste von (time, x, y, w, h) Tuples
        blur_amount: Blur-Stärke
    """
    def blur_faces(get_frame, t):
        frame = get_frame(t)

        for face in face_positions:
            face_time, fx, fy, fw, fh = face
            if abs(face_time - t) < 0.1:  # Innerhalb 100ms
                # Region extrahieren
                x1, y1 = max(0, fx), max(0, fy)
                x2, y2 = min(frame.shape[1], fx + fw), min(frame.shape[0], fy + fh)

                if x2 > x1 and y2 > y1:
                    roi = frame[y1:y2, x1:x2]
                    # Gaussian Blur
                    blurred = cv2.GaussianBlur(roi, (blur_amount|1, blur_amount|1), 0)
                    frame[y1:y2, x1:x2] = blurred

        return frame

    return clip.fl(blur_faces)


def apply_spotlight_face(clip, face_positions: list, darkness: float = 0.7, radius_factor: float = 1.5):
    """
    Spotlight-Effekt auf Gesichter (Rest verdunkelt).

    Args:
        clip: Video-Clip
        face_positions: Liste von (time, x, y, w, h) Tuples
        darkness: Wie dunkel der Rest wird (0-1)
        radius_factor: Radius des Spotlights relativ zur Gesichtsgröße
    """
    def spotlight(get_frame, t):
        frame = get_frame(t).astype(float)
        h, w = frame.shape[:2]

        # Verdunkle gesamtes Bild
        darkened = frame * (1 - darkness)

        for face in face_positions:
            face_time, fx, fy, fw, fh = face
            if abs(face_time - t) < 0.1:
                # Erstelle radiale Maske
                center_x = fx + fw // 2
                center_y = fy + fh // 2
                radius = max(fw, fh) * radius_factor / 2

                Y, X = np.ogrid[:h, :w]
                dist = np.sqrt((X - center_x)**2 + (Y - center_y)**2)
                mask = np.clip(1 - dist / radius, 0, 1)[:, :, np.newaxis]

                # Kombiniere dunkles und helles Bild
                darkened = darkened * (1 - mask) + frame * mask

        return np.clip(darkened, 0, 255).astype(np.uint8)

    return clip.fl(spotlight)


# =============================================================================
# ANIMIERTE TITEL
# =============================================================================

def create_animated_title(text: str, duration: float, video_size: tuple,
                          animation: str = "fade", font_size: int = 70,
                          color: tuple = (255, 255, 255),
                          position: str = "center"):
    """
    Erstellt animierte Titel.

    Args:
        text: Titel-Text
        duration: Dauer in Sekunden
        video_size: (width, height)
        animation: "fade", "slide_up", "slide_down", "zoom", "typewriter"
        font_size: Schriftgröße
        color: Textfarbe (R, G, B)
        position: "center", "top", "bottom"
    """
    w, h = video_size

    try:
        txt_clip = TextClip(
            text,
            fontsize=font_size,
            color=f'rgb({color[0]},{color[1]},{color[2]})',
            font='Arial-Bold'
        ).set_duration(duration)
    except Exception:
        # Fallback ohne spezifischen Font
        txt_clip = TextClip(
            text,
            fontsize=font_size,
            color=f'rgb({color[0]},{color[1]},{color[2]})'
        ).set_duration(duration)

    # Position
    if position == "top":
        pos = ("center", h * 0.15)
    elif position == "bottom":
        pos = ("center", h * 0.85)
    else:
        pos = "center"

    txt_clip = txt_clip.set_position(pos)

    # Animation
    if animation == "fade":
        txt_clip = txt_clip.crossfadein(0.5).crossfadeout(0.5)
    elif animation == "slide_up":
        txt_clip = txt_clip.set_position(lambda t: ("center", h + 100 - t * 200))
    elif animation == "slide_down":
        txt_clip = txt_clip.set_position(lambda t: ("center", -100 + t * 200))
    elif animation == "zoom":
        def zoom_text(get_frame, t):
            progress = min(t / 0.5, 1.0)
            scale = 0.5 + 0.5 * progress
            frame = get_frame(t)
            new_size = (int(frame.shape[1] * scale), int(frame.shape[0] * scale))
            if new_size[0] > 0 and new_size[1] > 0:
                return cv2.resize(frame, new_size)
            return frame
        txt_clip = txt_clip.fl(zoom_text)

    return txt_clip


# =============================================================================
# GENERIERTE BILDER OVERLAY
# =============================================================================

def add_generated_image_overlays(clip, generated_images: list, position: str = "top_right",
                                  size: float = 0.25, style: str = "overlay"):
    """
    Fügt generierte Bilder als Overlays zum Video hinzu.

    Args:
        clip: Video-Clip
        generated_images: Liste von GeneratedImage Objekten (oder Dicts mit image, timestamp, duration)
        position: "top_left", "top_right", "bottom_left", "bottom_right", "center"
        size: Relative Größe zum Video (0-1)
        style: "overlay" (Ecke), "fullscreen" (Vollbild mit Fade), "pip" (Picture-in-Picture)

    Returns:
        CompositeVideoClip mit Bild-Overlays
    """
    if not generated_images:
        return clip

    w, h = clip.size
    overlay_clips = [clip]

    for img_data in generated_images:
        # Unterstütze sowohl Objekte als auch Dicts
        if hasattr(img_data, 'image'):
            image = img_data.image
            timestamp = img_data.timestamp
            duration = img_data.duration
        else:
            image = img_data.get('image')
            timestamp = img_data.get('timestamp', 0)
            duration = img_data.get('duration', 3.0)

        if image is None:
            continue

        # Bild-Größe berechnen
        if style == "fullscreen":
            img_w, img_h = w, h
        else:
            img_w = int(w * size)
            img_h = int(w * size)  # Quadratisch

        # Bild skalieren
        from PIL import Image as PILImage
        pil_img = PILImage.fromarray(image)
        pil_img = pil_img.resize((img_w, img_h), PILImage.Resampling.LANCZOS)

        # Rahmen hinzufügen (für Overlay-Stil)
        if style == "overlay":
            # Weißer Rahmen
            bordered = PILImage.new('RGB', (img_w + 6, img_h + 6), (255, 255, 255))
            bordered.paste(pil_img, (3, 3))
            pil_img = bordered
            img_w, img_h = pil_img.size

        img_array = np.array(pil_img)

        # Position berechnen
        margin = 20
        if position == "top_left":
            pos = (margin, margin)
        elif position == "top_right":
            pos = (w - img_w - margin, margin)
        elif position == "bottom_left":
            pos = (margin, h - img_h - margin)
        elif position == "bottom_right":
            pos = (w - img_w - margin, h - img_h - margin)
        else:  # center
            pos = ((w - img_w) // 2, (h - img_h) // 2)

        # ImageClip erstellen
        # Für Fullscreen: kürzere Dauer (0.5-1s), sonst normale Dauer
        if style == "fullscreen":
            show_duration = min(duration, 0.8)  # Max 0.8 Sekunden Vollbild
            fade_time = 0.15
        else:
            show_duration = duration
            fade_time = 0.3

        img_clip = ImageClip(img_array).set_duration(show_duration)
        img_clip = img_clip.set_start(timestamp)
        img_clip = img_clip.set_position(pos)

        # Fade In/Out für smoothen Übergang
        img_clip = img_clip.crossfadein(fade_time).crossfadeout(fade_time)

        overlay_clips.append(img_clip)

    return CompositeVideoClip(overlay_clips)


def get_all_effects():
    """Gibt eine Liste aller verfügbaren Effekte zurück."""
    return {
        "visual": [
            "cinematic_bars", "rgb_split", "vhs", "film_grain",
            "light_leak", "shake", "mirror", "kaleidoscope", "echo",
            "scanlines", "chromatic_aberration", "glitch_blocks", "crt"
        ],
        "transitions": [
            "fade", "blur", "swipe", "glitch", "zoom", "scale_pop",
            "pixelate", "rotate"
        ],
        "intro_outro": [
            "slide_in", "slide_out", "scale_in", "scale_out",
            "flip_in", "bounce_in", "spin_in", "elastic_in", "blur_slide_in"
        ],
        "zoom": [
            "zoom_in", "zoom_out", "pan_zoom", "smart_zoom",
            "zoom_pulse", "beat_zoom", "ken_burns", "face_zoom"
        ],
        "text": [
            "typewriter", "bounce", "glitch_text", "neon", "karaoke",
            "animated_title"
        ],
        "color": [
            "brightness", "contrast", "saturation", "vignette",
            "color_grade", "cinematic", "cyberpunk", "vintage", "noir",
            "sunset", "arctic", "matrix", "sepia"
        ],
        "time": [
            "speed_ramp", "freeze_frame", "slowmo", "reverse"
        ],
        "segment": [
            "desaturate_segment", "slow_motion_segment", "speed_up_segment",
            "reverse_segment", "flash", "impact_zoom", "shake_segment",
            "zoom_segment", "blur_segment"
        ],
        "audio_reactive": [
            "beat_flash", "beat_shake", "beat_zoom", "bass_drop",
            "volume_reactive_zoom"
        ],
        "face": [
            "face_zoom", "face_blur", "spotlight_face"
        ],
        "layout": [
            "split_screen", "picture_in_picture"
        ],
        "ai": [
            "background_blur", "auto_reframe"
        ]
    }
