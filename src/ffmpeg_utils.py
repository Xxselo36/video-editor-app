"""
FFmpeg/FFprobe Pfad-Aufloesung fuer Nuitka Bundle und Entwicklung.

Prueft in dieser Reihenfolge:
1. Nuitka Bundle (neben der kompilierten Binary)
2. imageio_ffmpeg (pip-installierte ffmpeg Binary)
3. System PATH
"""

import os
import sys
import shutil
import platform
from pathlib import Path
from functools import lru_cache

_IS_WINDOWS = platform.system() == "Windows"


def _is_bundled() -> bool:
    """Prueft ob wir in einem Nuitka-kompilierten Bundle laufen."""
    return getattr(sys, 'frozen', False) or '__compiled__' in dir()


def _get_bundle_dir() -> Path:
    """Gibt das Verzeichnis der ausfuehrbaren Datei zurueck."""
    if _is_bundled():
        # Nuitka: sys.executable zeigt auf die kompilierte Binary
        # In .app Bundle: VideoEditor.app/Contents/MacOS/gui
        return Path(sys.executable).parent
    # Entwicklung: Verzeichnis des Skripts
    return Path(__file__).parent.parent.resolve()


@lru_cache(maxsize=1)
def get_ffmpeg_path() -> str:
    """Gibt den Pfad zu ffmpeg zurueck."""
    bundle_dir = _get_bundle_dir()

    # 1. Nuitka Bundle: imageio_ffmpeg Binary liegt im Bundle
    if _is_bundled():
        try:
            import imageio_ffmpeg
            path = imageio_ffmpeg.get_ffmpeg_exe()
            if path and os.path.isfile(path):
                return path
        except (ImportError, Exception):
            pass

    # 2. imageio_ffmpeg (Entwicklung)
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except (ImportError, Exception):
        pass

    # 3. System PATH
    system_ffmpeg = shutil.which('ffmpeg')
    if system_ffmpeg:
        return system_ffmpeg

    # Fallback: hoffen dass es im PATH ist
    return 'ffmpeg'


@lru_cache(maxsize=1)
def get_ffprobe_path() -> str:
    """Gibt den Pfad zu ffprobe zurueck."""
    bundle_dir = _get_bundle_dir()

    ffprobe_name = 'ffprobe.exe' if _IS_WINDOWS else 'ffprobe'

    # 1. Nuitka Bundle: ffprobe neben der Binary
    if _is_bundled():
        bundled_ffprobe = bundle_dir / ffprobe_name
        if bundled_ffprobe.is_file():
            return str(bundled_ffprobe)

    # 2. ffprobe neben dem Projektverzeichnis (Entwicklung)
    dev_ffprobe = bundle_dir / 'bin' / ffprobe_name
    if dev_ffprobe.is_file():
        return str(dev_ffprobe)

    # 3. System PATH
    system_ffprobe = shutil.which('ffprobe')
    if system_ffprobe:
        return system_ffprobe

    # Fallback: hoffen dass es im PATH ist
    return ffprobe_name
