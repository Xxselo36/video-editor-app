"""
Plattform-spezifische Helfer fuer Cross-Platform Kompatibilitaet.

Erkennt macOS, Windows und Linux und liefert passende:
- Video-Codec (Hardware-Encoding auf macOS, Software auf Windows/Linux)
- Codec-Parameter
- Dateimanager-Oeffnung
"""

import os
import sys
import subprocess
import platform


def get_video_codec() -> str:
    """Gibt den optimalen H.264 Video-Codec fuer die aktuelle Plattform zurueck."""
    if platform.system() == "Darwin":
        return "h264_videotoolbox"
    return "libx264"


def get_codec_params() -> list:
    """Gibt plattform-spezifische Codec-Parameter zurueck.

    macOS: VideoToolbox braucht Profile/Level
    Windows/Linux: libx264 braucht Preset/CRF
    """
    if get_video_codec() == "h264_videotoolbox":
        return ["-profile:v", "high", "-level", "4.2"]
    return ["-preset", "medium", "-crf", "18"]


def open_file_manager(path: str):
    """Oeffnet den plattform-spezifischen Dateimanager."""
    system = platform.system()
    if system == "Darwin":
        subprocess.Popen(["open", path])
    elif system == "Windows":
        os.startfile(path)
    else:
        subprocess.Popen(["xdg-open", path])
