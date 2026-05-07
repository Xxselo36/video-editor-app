#!/usr/bin/env python3
"""
Video Editor GUI - CustomTkinter Interface
"""

import multiprocessing
import os
import re
import sys
import time
import types
import threading
import subprocess
import traceback
from pathlib import Path

# App version
APP_VERSION = "1.0.1"

# Determine project root
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

# Nuitka standalone replaces Python's import system (no PathFinder, no sys.path_hooks).
# torch was excluded from Nuitka compilation (--nofollow-import-to=torch) and copied
# as raw Python files. This finder resolves torch/torchgen imports directly from disk
# using importlib.util.spec_from_file_location (no PathFinder dependency).
class _TorchFinder:
    """Meta-path finder that resolves torch/torchgen from filesystem directly."""
    _PACKAGES = ('torch', 'torchgen')
    _BASE = str(SCRIPT_DIR)

    @classmethod
    def find_spec(cls, name, path=None, target=None):
        if name.split('.')[0] not in cls._PACKAGES:
            return None
        try:
            import importlib.util
            import importlib.machinery
            rel = name.replace('.', os.sep)
            base = cls._BASE
            # Package: dir/__init__.py
            init = os.path.join(base, rel, '__init__.py')
            if os.path.isfile(init):
                return importlib.util.spec_from_file_location(
                    name, init,
                    submodule_search_locations=[os.path.join(base, rel)])
            # Python module: .py
            py = os.path.join(base, rel + '.py')
            if os.path.isfile(py):
                return importlib.util.spec_from_file_location(name, py)
            # Extension module: .cpython-*.so
            for sfx in importlib.machinery.EXTENSION_SUFFIXES:
                so = os.path.join(base, rel + sfx)
                if os.path.isfile(so):
                    loader = importlib.machinery.ExtensionFileLoader(name, so)
                    return importlib.util.spec_from_file_location(
                        name, so, loader=loader)
            # Bytecode: .pyc
            pyc = os.path.join(base, rel + '.pyc')
            if os.path.isfile(pyc):
                return importlib.util.spec_from_file_location(name, pyc)
        except Exception:
            pass
        return None

try:
    sys.meta_path.insert(0, _TorchFinder)
except Exception:
    pass

# Stub torch.distributed and all submodules (removed in build to save space).
# torch internally imports many torch.distributed.* submodules even for CPU-only
# inference. A meta-path finder auto-creates stubs for ANY torch.distributed.* import.
# Stubs use __getattr__ so `from torch.distributed.X import Y` returns a safe dummy.
try:
    import types as _t
    import importlib.machinery
    import builtins as _builtins

    class _Dummy:
        """Catch-all dummy: works as base class, callable, decorator, etc."""
        def __init_subclass__(cls, **kw): pass
        def __init__(self, *a, **kw): pass
        def __call__(self, *a, **kw): return _Dummy()
        def __getattr__(self, name): return _Dummy()
        def __mro_entries__(self, bases): return (object,)
        def __bool__(self): return False
        def __iter__(self): return iter([])

    _dist_stubs = {}

    def _make_dist_stub(name):
        if name in _dist_stubs:
            return _dist_stubs[name]
        m = _t.ModuleType(name)
        m.is_available = lambda: False
        m.is_initialized = lambda: False
        m.__file__ = __file__
        m.__path__ = []
        m.__all__ = []
        def _mod_getattr(attr):
            if attr.startswith('__') and attr.endswith('__'):
                raise AttributeError(attr)
            return _Dummy()
        m.__getattr__ = _mod_getattr
        _dist_stubs[name] = m
        sys.modules[name] = m
        parts = name.split('.')
        parent = '.'.join(parts[:-1])
        if parent in sys.modules:
            setattr(sys.modules[parent], parts[-1], m)
        return m

    class _DistLoader:
        @staticmethod
        def create_module(spec):
            return _dist_stubs.get(spec.name) or _make_dist_stub(spec.name)
        @staticmethod
        def exec_module(module):
            pass

    class _DistFinder:
        """Meta-path finder: auto-stubs any torch.distributed.* import."""
        @classmethod
        def find_spec(cls, name, path=None, target=None):
            if name == 'torch.distributed' or name.startswith('torch.distributed.'):
                return importlib.machinery.ModuleSpec(
                    name, _DistLoader, is_package=True)
            return None

    sys.meta_path.insert(0, _DistFinder)

    _dist = _make_dist_stub('torch.distributed')
    _dist.is_mpi_available = lambda: False
    _dist.is_nccl_available = lambda: False
    _dist.is_gloo_available = lambda: False

    # Hook __import__ to wire torch.distributed onto the torch module object
    # (torch accesses it as an attribute, not just via import)
    _orig_import = _builtins.__import__

    def _patching_import(name, *args, **kwargs):
        result = _orig_import(name, *args, **kwargs)
        if name == 'torch' or name.startswith('torch.'):
            _torch = sys.modules.get('torch')
            if _torch is not None and not hasattr(_torch, 'distributed'):
                _d = sys.modules.get('torch.distributed')
                if _d is not None:
                    _torch.distributed = _d
        return result

    _builtins.__import__ = _patching_import
except Exception:
    pass

try:
    import torch  # noqa: F401
except Exception:
    pass

# Restore original __import__ after torch is loaded
try:
    _builtins.__import__ = _orig_import
except Exception:
    pass

# Make FFmpeg available for moviepy in bundle
def _setup_ffmpeg_env():
    """Sets IMAGEIO_FFMPEG_EXE when running in Nuitka bundle."""
    try:
        from src.ffmpeg_utils import get_ffmpeg_path, ensure_ffmpeg_in_path
        ffmpeg_path = get_ffmpeg_path()
        if ffmpeg_path and ffmpeg_path != 'ffmpeg':
            os.environ['IMAGEIO_FFMPEG_EXE'] = ffmpeg_path
        ensure_ffmpeg_in_path()
    except Exception:
        pass

_setup_ffmpeg_env()

import customtkinter as ctk
from tkinter import filedialog, messagebox

from src.styles import STYLES, get_style_info
from src.platform_utils import open_file_manager
from src.license import activate_license, check_license, deactivate_license, get_saved_key

# Output directory: SCRIPT_DIR is read-only in .app bundle
OUTPUT_DIR = Path.home() / "Movies" / "Videos"


# ============================================================================
# THEME
# ============================================================================

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

THEME = {
    "bg":           "#0d0d0f",
    "surface":      "#1a1a1f",
    "surface_2":    "#222228",
    "border":       "#2a2a32",
    "text":         "#f0f0f2",
    "text_sec":     "#8e8e96",
    "text_muted":   "#5a5a64",
    "accent":       "#6c5ce7",
    "accent_hover": "#7c6cf7",
    "accent_dim":   "#2d2640",
    "success":      "#00c853",
    "warning":      "#ffab40",
    "danger":       "#ef5350",
}


# ============================================================================
# MAIN APP
# ============================================================================

class VideoEditorApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("SmartCut")
        self.geometry("620x580")
        self.minsize(560, 540)
        self.resizable(True, True)
        self.configure(fg_color=THEME["bg"])

        # Set window icon
        try:
            from PIL import Image
            icon_path = SCRIPT_DIR / "logo.png"
            if icon_path.is_file():
                icon_img = Image.open(str(icon_path))
                self._icon_photo = ctk.CTkImage(light_image=icon_img, dark_image=icon_img, size=(32, 32))
                self.iconphoto(False, self._icon_photo._get_image("dark", (32, 32), 1.0))
        except Exception:
            pass

        # State
        self._worker_thread = None
        self._cancel_flag = False
        self._output_path = None
        self._start_time = None

        # Check license before building UI
        ok, msg = check_license()
        if ok:
            # Detect if running in trial mode (no license, trial edits remaining)
            if "Trial" in msg or "trial" in msg:
                self._trial_mode = True
                import re as _re
                _m = _re.search(r'(\d+)', msg)
                self._trial_remaining = int(_m.group(1)) if _m else 0
            self._init_app()
        else:
            self._build_license_screen()

    def _build_license_screen(self):
        """Show license key input directly in main window."""
        self.geometry("420x420")
        self.minsize(380, 400)
        self.grid_columnconfigure(0, weight=1)

        self._lic_frame = ctk.CTkFrame(self, fg_color="transparent")
        self._lic_frame.grid(row=0, column=0, sticky="nsew")
        self._lic_frame.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # Logo on license screen
        try:
            from PIL import Image
            icon_path = SCRIPT_DIR / "logo.png"
            if icon_path.is_file():
                self._lic_logo_img = ctk.CTkImage(
                    light_image=Image.open(str(icon_path)),
                    dark_image=Image.open(str(icon_path)),
                    size=(220, 138))
                ctk.CTkLabel(
                    self._lic_frame, image=self._lic_logo_img, text="",
                ).grid(row=0, column=0, padx=24, pady=(20, 4))
        except Exception:
            ctk.CTkLabel(
                self._lic_frame, text="SMARTCUT",
                font=ctk.CTkFont(size=22, weight="bold"),
                text_color=THEME["text"],
            ).grid(row=0, column=0, padx=24, pady=(40, 4))

        ctk.CTkLabel(
            self._lic_frame, text="Enter your license key to get started",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        ).grid(row=1, column=0, padx=24, pady=(0, 20))

        self._lic_entry = ctk.CTkEntry(
            self._lic_frame, placeholder_text="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
            font=ctk.CTkFont(size=13),
            fg_color=THEME["surface_2"],
            border_color=THEME["border"],
            text_color=THEME["text"],
            corner_radius=8,
            height=40,
        )
        self._lic_entry.grid(row=2, column=0, padx=32, sticky="ew")
        self._lic_entry.bind("<Return>", lambda e: self._activate_key())

        self._lic_btn = ctk.CTkButton(
            self._lic_frame, text="Activate",
            font=ctk.CTkFont(size=14, weight="bold"),
            height=42,
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            text_color="#ffffff",
            corner_radius=8,
            command=self._activate_key,
        )
        self._lic_btn.grid(row=3, column=0, padx=32, pady=(12, 4), sticky="ew")

        self._lic_status = ctk.CTkLabel(
            self._lic_frame, text="",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        )
        self._lic_status.grid(row=4, column=0, padx=24, pady=(4, 10))

        # Trial button
        self._trial_btn = ctk.CTkButton(
            self._lic_frame,
            text="Try 3 Free Edits — No License Needed",
            command=self._start_trial,
            fg_color="transparent",
            border_color=(THEME["accent"], THEME["accent"]),
            border_width=2,
            text_color=(THEME["accent"], "#a29bfe"),
            hover_color=(THEME["surface_2"], THEME["surface_2"]),
            height=42,
            corner_radius=8,
            font=ctk.CTkFont(size=14, weight="bold"),
        )
        self._trial_btn.grid(row=5, column=0, padx=32, pady=(0, 20), sticky="ew")

        self.after(200, self._lic_entry.focus)

    def _activate_key(self):
        key = self._lic_entry.get().strip()
        if not key:
            self._lic_status.configure(text="Please enter a license key.", text_color=THEME["warning"])
            return

        self._lic_btn.configure(state="disabled", text="Activating...")
        self._lic_status.configure(text="Checking license...", text_color=THEME["text_muted"])
        self.update()

        def _do():
            ok, msg = activate_license(key)
            self.after(0, lambda: self._on_activate_result(ok, msg))

        threading.Thread(target=_do, daemon=True).start()

    def _on_activate_result(self, ok, msg):
        self._lic_btn.configure(state="normal", text="Activate")
        if ok:
            self._lic_status.configure(text=msg, text_color=THEME["success"])
            self.after(600, self._switch_to_app)
        else:
            self._lic_status.configure(text=msg, text_color=THEME["danger"])

    def _start_trial(self):
        """Start trial mode — 3 free edits without a license."""
        from src.license import check_trial
        ok, remaining, msg = check_trial()
        if ok:
            self._trial_mode = True
            self._trial_remaining = remaining
            self._lic_frame.destroy()
            self.geometry("620x600")
            self.minsize(560, 560)
            self._init_app()
        else:
            if hasattr(self, '_trial_btn'):
                self._trial_btn.configure(
                    text="Trial Ended — Enter License Key",
                    state="disabled",
                )

    def _switch_to_app(self):
        """Remove license screen, show full app."""
        self._lic_frame.destroy()
        self.geometry("620x580")
        self.minsize(560, 540)
        self._init_app()

    def _init_app(self):
        """Build UI and start services (only after license check passes)."""
        self._build_ui()
        self._auto_install_plugins()
        self._start_plugin_server()
        self.after(3000, self._check_for_updates)

    def _check_for_updates(self):
        """Check GitHub for a newer release in background."""
        def _check():
            try:
                import urllib.request, json
                url = "https://api.github.com/repos/Xxselo36/video-editor-app/releases/latest"
                req = urllib.request.Request(url, headers={"User-Agent": "SmartCut"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode())
                tag = data.get("tag_name", "").lstrip("v")
                if tag and tag != APP_VERSION and tag > APP_VERSION:
                    self.after(0, lambda: self._show_update_banner(tag))
            except Exception:
                pass
        threading.Thread(target=_check, daemon=True).start()

    def _show_update_banner(self, new_version):
        """Show update available banner at top of window."""
        banner = ctk.CTkFrame(self, fg_color=THEME["accent"], corner_radius=0, height=36)
        banner.grid(row=0, column=0, sticky="ew", padx=0, pady=0)
        banner.grid_columnconfigure(1, weight=1)
        banner.lift()

        ctk.CTkLabel(
            banner, text=f"Update available: v{new_version}",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#ffffff",
        ).grid(row=0, column=0, padx=(12, 4), pady=6)

        def _open_download():
            import webbrowser
            webbrowser.open("https://getsmartcut.app")

        ctk.CTkButton(
            banner, text="Download", width=80, height=24,
            fg_color="#ffffff", hover_color="#e0e0e0",
            text_color=THEME["accent"], corner_radius=6,
            font=ctk.CTkFont(size=11, weight="bold"),
            command=_open_download,
        ).grid(row=0, column=1, padx=4, pady=6, sticky="e")

        ctk.CTkButton(
            banner, text="✕", width=24, height=24,
            fg_color="transparent", hover_color=THEME["accent_hover"],
            text_color="#ffffff", corner_radius=6,
            command=banner.destroy,
        ).grid(row=0, column=2, padx=(0, 8), pady=6)

    # ========================================================================
    # HELPERS
    # ========================================================================

    def _make_card(self, parent, **kwargs):
        return ctk.CTkFrame(
            parent,
            fg_color=THEME["surface"],
            corner_radius=12,
            border_width=1,
            border_color=THEME["border"],
            **kwargs,
        )

    def _card_header(self, parent, text, row=0):
        lbl = ctk.CTkLabel(
            parent, text=text,
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color=THEME["text_sec"],
        )
        lbl.grid(row=row, column=0, columnspan=3, padx=16, pady=(8, 4), sticky="w")
        return lbl

    # ========================================================================
    # UI SETUP
    # ========================================================================

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=1)
        row = 0

        # --- Logo centered ---
        try:
            from PIL import Image
            icon_path = SCRIPT_DIR / "logo.png"
            if icon_path.is_file():
                self._title_logo = ctk.CTkImage(
                    light_image=Image.open(str(icon_path)),
                    dark_image=Image.open(str(icon_path)),
                    size=(180, 112))
                ctk.CTkLabel(
                    self, image=self._title_logo, text="",
                ).grid(row=row, column=0, pady=(2, 0))
                row += 1
        except Exception:
            ctk.CTkLabel(
                self, text="SMARTCUT",
                font=ctk.CTkFont(size=24, weight="bold"),
                text_color=THEME["text"],
            ).grid(row=row, column=0, padx=24, pady=(4, 0), sticky="w")
            row += 1

        ctk.CTkLabel(
            self, text="AI-powered video editing",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        ).grid(row=row, column=0, pady=(0, 0))
        row += 1

        # ── Settings Card ──────────────────────────────────────────────────
        settings = self._make_card(self)
        settings.grid(row=row, column=0, padx=20, pady=(0, 2), sticky="ew")
        settings.grid_columnconfigure(1, weight=1)
        self._card_header(settings, "SETTINGS")
        row += 1

        # Video row
        ctk.CTkLabel(
            settings, text="Video",
            font=ctk.CTkFont(size=13),
            text_color=THEME["text_sec"],
        ).grid(row=1, column=0, padx=(16, 8), pady=4, sticky="w")

        self._video_path = ""
        self._drop_frame = ctk.CTkFrame(
            settings,
            fg_color=THEME["surface_2"],
            corner_radius=8,
            height=40,
        )
        self._drop_frame.grid(row=1, column=1, columnspan=2, padx=(0, 16), pady=4, sticky="ew")
        self._drop_frame.grid_columnconfigure(0, weight=1)
        self._drop_frame.grid_propagate(False)

        self.video_label = ctk.CTkLabel(
            self._drop_frame,
            text="Click to select video",
            text_color=THEME["text_muted"],
            font=ctk.CTkFont(size=12),
            fg_color="transparent",
        )
        self.video_label.grid(row=0, column=0, padx=12, sticky="ew")
        self.video_label.bind("<Button-1>", lambda e: self._pick_video())
        self._drop_frame.bind("<Button-1>", lambda e: self._pick_video())

        # Drag & Drop via TkDND (tkinterdnd2) or fallback
        try:
            self._drop_frame.drop_target_register("DND_Files")
            self._drop_frame.dnd_bind("<<Drop>>", self._on_drop)
        except Exception:
            pass

        # Style row
        ctk.CTkLabel(
            settings, text="Style",
            font=ctk.CTkFont(size=13),
            text_color=THEME["text_sec"],
        ).grid(row=2, column=0, padx=(16, 8), pady=4, sticky="w")

        style_info = get_style_info()
        visible_styles = ("clean", "fast", "balanced", "smooth", "minimal")
        # Map English display name -> internal key
        self._style_display_to_key = {}
        style_display_names = []
        for key, info in style_info.items():
            if key not in visible_styles:
                continue
            display = info["name"]
            self._style_display_to_key[display] = key
            style_display_names.append(display)

        default_key = "clean"
        default_display = style_info.get(default_key, {}).get("name", style_display_names[0])
        self.style_var = ctk.StringVar(value=default_display)
        self.style_menu = ctk.CTkOptionMenu(
            settings, variable=self.style_var,
            values=style_display_names,
            fg_color=THEME["surface_2"],
            button_color=THEME["surface_2"],
            button_hover_color=THEME["border"],
            dropdown_fg_color=THEME["surface"],
            dropdown_hover_color=THEME["border"],
            text_color=THEME["text"],
            corner_radius=8,
            height=36,
            command=self._on_style_changed,
        )
        self.style_menu.grid(row=2, column=1, columnspan=2, padx=(0, 16), pady=4, sticky="ew")

        # Style description
        self.style_desc = ctk.CTkLabel(
            settings, text="",
            font=ctk.CTkFont(size=11),
            text_color=THEME["text_muted"],
        )
        self.style_desc.grid(row=3, column=1, columnspan=2, padx=(4, 16), pady=(0, 4), sticky="w")
        self._on_style_changed(None)

        # Bottom padding for settings card (style desc already has some)
        self.style_desc.grid(row=3, column=1, columnspan=2, padx=(4, 16), pady=(0, 2), sticky="w")

        # Filler word removal checkbox
        self.filler_var = ctk.BooleanVar(value=True)
        self.filler_check = ctk.CTkCheckBox(
            settings,
            text="Remove filler words (um, uh, like...)",
            variable=self.filler_var,
            font=ctk.CTkFont(size=13),
            checkbox_width=20,
            checkbox_height=20,
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            border_color=THEME["border"],
            text_color=THEME["text_sec"],
        )
        self.filler_check.grid(row=4, column=0, columnspan=3, padx=16, pady=(0, 4), sticky="w")

        # ── Caption Settings (collapsible) ─────────────────────────────────
        self._caption_expanded = False
        self._caption_header = ctk.CTkButton(
            settings,
            text="\u25B6 Caption Settings",
            command=self._toggle_caption_settings,
            fg_color="transparent",
            text_color=THEME["text_muted"],
            hover_color=THEME["surface_2"],
            anchor="w",
            font=ctk.CTkFont(size=13),
            height=28,
        )
        self._caption_header.grid(row=5, column=0, columnspan=3, padx=12, pady=(0, 2), sticky="ew")

        self._caption_frame = ctk.CTkFrame(settings, fg_color="transparent")
        # _caption_frame is NOT gridded initially (collapsed)
        self._caption_frame.grid_columnconfigure(1, weight=1)

        # -- Font selector --
        ctk.CTkLabel(
            self._caption_frame, text="Font",
            font=ctk.CTkFont(size=12), text_color=THEME["text_sec"],
        ).grid(row=0, column=0, padx=(16, 8), pady=3, sticky="w")
        fonts = ["Arial Black", "Arial", "Helvetica", "Impact", "Futura", "Montserrat", "Roboto"]
        self.font_var = ctk.StringVar(value="Arial Black")
        ctk.CTkOptionMenu(
            self._caption_frame, variable=self.font_var, values=fonts,
            fg_color=THEME["surface_2"], button_color=THEME["surface_2"],
            button_hover_color=THEME["border"],
            dropdown_fg_color=THEME["surface"], dropdown_hover_color=THEME["border"],
            text_color=THEME["text"], corner_radius=8, height=30,
        ).grid(row=0, column=1, padx=(0, 16), pady=3, sticky="ew")

        # -- Color buttons row --
        color_row = ctk.CTkFrame(self._caption_frame, fg_color="transparent")
        color_row.grid(row=1, column=0, columnspan=2, padx=16, pady=3, sticky="ew")
        color_row.grid_columnconfigure(0, weight=1)
        color_row.grid_columnconfigure(1, weight=1)

        self.text_color_var = "#FFFFFF"
        self.text_color_btn = ctk.CTkButton(
            color_row, text="Text Color", width=100, height=28,
            fg_color=self.text_color_var, text_color="#000000",
            hover_color="#E0E0E0", corner_radius=6,
            font=ctk.CTkFont(size=11),
            command=self._pick_text_color,
        )
        self.text_color_btn.grid(row=0, column=0, padx=(0, 4), sticky="ew")

        self.highlight_color_var = "#6c5ce7"
        self.highlight_color_btn = ctk.CTkButton(
            color_row, text="Highlight", width=100, height=28,
            fg_color=self.highlight_color_var, text_color="#FFFFFF",
            hover_color="#7c6cf7", corner_radius=6,
            font=ctk.CTkFont(size=11),
            command=self._pick_highlight_color,
        )
        self.highlight_color_btn.grid(row=0, column=1, padx=(4, 0), sticky="ew")

        # -- Position selector --
        ctk.CTkLabel(
            self._caption_frame, text="Position",
            font=ctk.CTkFont(size=12), text_color=THEME["text_sec"],
        ).grid(row=2, column=0, padx=(16, 8), pady=3, sticky="w")
        self.position_var = ctk.StringVar(value="Bottom")
        ctk.CTkOptionMenu(
            self._caption_frame, variable=self.position_var,
            values=["Bottom", "Center", "Top"],
            fg_color=THEME["surface_2"], button_color=THEME["surface_2"],
            button_hover_color=THEME["border"],
            dropdown_fg_color=THEME["surface"], dropdown_hover_color=THEME["border"],
            text_color=THEME["text"], corner_radius=8, height=30,
        ).grid(row=2, column=1, padx=(0, 16), pady=3, sticky="ew")

        # -- Background toggle --
        self.bg_var = ctk.BooleanVar(value=False)
        ctk.CTkCheckBox(
            self._caption_frame, text="Text background",
            variable=self.bg_var,
            font=ctk.CTkFont(size=12),
            checkbox_width=18, checkbox_height=18,
            fg_color=THEME["accent"], hover_color=THEME["accent_hover"],
            border_color=THEME["border"], text_color=THEME["text_sec"],
        ).grid(row=3, column=0, columnspan=2, padx=16, pady=(3, 6), sticky="w")

        # Sync caption controls to default style
        self._sync_caption_to_style()

        # ── Progress Card ──────────────────────────────────────────────────
        progress = self._make_card(self)
        progress.grid(row=row, column=0, padx=20, pady=(0, 2), sticky="ew")
        progress.grid_columnconfigure(0, weight=1)
        progress.grid_columnconfigure(1, weight=0)
        self._card_header(progress, "PROGRESS")
        row += 1

        # Step + Percent row
        step_row = ctk.CTkFrame(progress, fg_color="transparent")
        step_row.grid(row=1, column=0, columnspan=2, padx=16, pady=(0, 4), sticky="ew")
        step_row.grid_columnconfigure(0, weight=1)

        self.step_label = ctk.CTkLabel(
            step_row, text="Ready",
            font=ctk.CTkFont(size=13),
            text_color=THEME["text_sec"],
        )
        self.step_label.grid(row=0, column=0, sticky="w")

        self.progress_pct = ctk.CTkLabel(
            step_row, text="0%",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=THEME["text"],
        )
        self.progress_pct.grid(row=0, column=1, sticky="e")

        # Progress bar
        self.progress_bar = ctk.CTkProgressBar(
            progress, height=6, corner_radius=3,
            fg_color=THEME["accent_dim"],
            progress_color=THEME["accent"],
        )
        self.progress_bar.grid(row=2, column=0, columnspan=2, padx=16, pady=(0, 4), sticky="ew")
        self.progress_bar.set(0)

        # Status + ETA row
        eta_row = ctk.CTkFrame(progress, fg_color="transparent")
        eta_row.grid(row=3, column=0, columnspan=2, padx=16, pady=(0, 6), sticky="ew")
        eta_row.grid_columnconfigure(0, weight=1)

        self.progress_label = ctk.CTkLabel(
            eta_row, text="",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        )
        self.progress_label.grid(row=0, column=0, sticky="w")

        self.eta_label = ctk.CTkLabel(
            eta_row, text="",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        )
        self.eta_label.grid(row=0, column=1, sticky="e")

        # ── Buttons ────────────────────────────────────────────────────────
        self.start_btn = ctk.CTkButton(
            self, text="\u25B6  Start",
            font=ctk.CTkFont(size=15, weight="bold"),
            height=40,
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            text_color="#ffffff",
            corner_radius=10,
            command=self._start,
        )
        self.start_btn.grid(row=row, column=0, padx=20, pady=(0, 2), sticky="ew")
        row += 1

        self.cancel_btn = ctk.CTkButton(
            self, text="Cancel",
            font=ctk.CTkFont(size=13),
            height=32,
            fg_color="transparent",
            hover_color=THEME["surface"],
            text_color=THEME["danger"],
            border_width=1,
            border_color=THEME["danger"],
            corner_radius=8,
            state="disabled",
            command=self._cancel,
        )
        self.cancel_btn.grid(row=row, column=0, padx=20, pady=(0, 2), sticky="ew")
        row += 1

        # ── Videos Button ──────────────────────────────────────────────────
        self.open_btn = ctk.CTkButton(
            self, text="Videos",
            font=ctk.CTkFont(size=13),
            height=32,
            fg_color=THEME["surface"],
            hover_color=THEME["surface_2"],
            text_color=THEME["text_sec"],
            border_width=1,
            border_color=THEME["border"],
            corner_radius=8,
            command=self._open_output,
        )
        self.open_btn.grid(row=row, column=0, padx=20, pady=(0, 2), sticky="ew")
        row += 1

        # ── Info + Plugins (top right) ────────────────────────────────────
        self.info_btn = ctk.CTkButton(
            self, text="ⓘ",
            font=ctk.CTkFont(size=14),
            width=28,
            height=24,
            fg_color="transparent",
            hover_color=THEME["surface"],
            text_color=THEME["text_muted"],
            corner_radius=6,
            command=self._show_info,
        )
        self.info_btn.place(relx=1.0, y=8, x=-76, anchor="ne")

        self.plugins_btn = ctk.CTkButton(
            self, text="Plugins",
            font=ctk.CTkFont(size=11),
            width=60,
            height=24,
            fg_color="transparent",
            hover_color=THEME["surface"],
            text_color=THEME["text_muted"],
            corner_radius=6,
            command=self._open_plugins,
        )
        self.plugins_btn.place(relx=1.0, y=8, x=-12, anchor="ne")

        self.license_btn = ctk.CTkButton(
            self, text="License",
            font=ctk.CTkFont(size=11),
            width=60,
            height=24,
            fg_color="transparent",
            hover_color=THEME["surface"],
            text_color=THEME["text_muted"],
            corner_radius=6,
            command=self._show_license,
        )
        self.license_btn.place(relx=1.0, y=8, x=-140, anchor="ne")

        # Trial mode banner
        if getattr(self, '_trial_mode', False):
            self._trial_banner = ctk.CTkLabel(
                self,
                text=f"\u26a1 Trial Mode: {self._trial_remaining} free edits remaining",
                font=ctk.CTkFont(size=12),
                text_color=THEME["warning"],
            )
            self._trial_banner.grid(row=row, column=0, padx=20, pady=(2, 4))
            row += 1

    # ========================================================================
    # EVENTS
    # ========================================================================

    def _pick_video(self):
        path = filedialog.askopenfilename(
            title="Select Video",
            filetypes=[
                ("Video Files", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"),
                ("All Files", "*.*"),
            ],
        )
        if path:
            self._video_path = path
            name = os.path.basename(path)
            self.video_label.configure(text=name, text_color=THEME["text"])
            self._reset_start_btn()

    def _on_style_changed(self, _event):
        display_name = self.style_var.get()
        key = self._style_display_to_key.get(display_name, "clean")
        desc = STYLES[key]["description"]
        self.style_desc.configure(text=desc)
        if hasattr(self, "start_btn"):
            self._reset_start_btn()
        if hasattr(self, "font_var"):
            self._sync_caption_to_style()

    def _sync_caption_to_style(self):
        """Update caption controls to match the current style defaults."""
        from src.styles import get_style
        key = self._get_selected_style()
        cfg = get_style(key)
        self.font_var.set(cfg.get("subtitle_font", "Arial Black"))
        # Text color: convert RGB tuple to hex
        rgb = cfg.get("subtitle_color", (255, 255, 255))
        self.text_color_var = "#{:02X}{:02X}{:02X}".format(*rgb)
        self.text_color_btn.configure(
            fg_color=self.text_color_var,
            text_color="#000000" if sum(rgb) > 384 else "#FFFFFF",
        )
        # Highlight color
        hl = cfg.get("subtitle_highlight_color_hex")
        self.highlight_color_var = hl if hl else "#6c5ce7"
        self.highlight_color_btn.configure(fg_color=self.highlight_color_var)
        # Position
        pos = cfg.get("subtitle_position", "bottom").capitalize()
        if pos not in ("Bottom", "Center", "Top"):
            pos = "Bottom"
        self.position_var.set(pos)
        # Background
        self.bg_var.set(cfg.get("subtitle_bg_enabled", False))

    def _toggle_caption_settings(self):
        self._caption_expanded = not self._caption_expanded
        if self._caption_expanded:
            self._caption_header.configure(text="\u25BC Caption Settings")
            self._caption_frame.grid(row=6, column=0, columnspan=3, sticky="ew")
        else:
            self._caption_header.configure(text="\u25B6 Caption Settings")
            self._caption_frame.grid_forget()

    def _pick_text_color(self):
        from tkinter import colorchooser
        color = colorchooser.askcolor(title="Text Color", initialcolor=self.text_color_var)
        if color[1]:
            self.text_color_var = color[1]
            rgb = color[0]
            self.text_color_btn.configure(
                fg_color=color[1],
                text_color="#000000" if sum(rgb) > 384 else "#FFFFFF",
            )

    def _pick_highlight_color(self):
        from tkinter import colorchooser
        color = colorchooser.askcolor(title="Highlight Color", initialcolor=self.highlight_color_var)
        if color[1]:
            self.highlight_color_var = color[1]
            rgb = color[0]
            self.highlight_color_btn.configure(
                fg_color=color[1],
                text_color="#000000" if sum(rgb) > 384 else "#FFFFFF",
            )

    def _get_caption_overrides(self) -> dict:
        """Gather caption settings as style overrides."""
        pos_map = {"Bottom": 0.85, "Center": 0.50, "Top": 0.15}
        pos_name = self.position_var.get()
        # Convert hex text color to RGB tuple
        hex_c = self.text_color_var.lstrip("#")
        rgb = tuple(int(hex_c[i:i+2], 16) for i in (0, 2, 4))
        return {
            "subtitle_font": self.font_var.get(),
            "subtitle_color": rgb,
            "subtitle_highlight_color_hex": self.highlight_color_var,
            "subtitle_position": pos_name.lower(),
            "subtitle_position_y": pos_map.get(pos_name, 0.85),
            "subtitle_bg_enabled": self.bg_var.get(),
        }

    def _get_selected_style(self) -> str:
        display_name = self.style_var.get()
        return self._style_display_to_key.get(display_name, "clean")

    def _on_drop(self, event):
        path = event.data.strip().strip("{}")
        video_exts = (".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v")
        if path.lower().endswith(video_exts):
            self._video_path = path
            name = os.path.basename(path)
            self.video_label.configure(text=name, text_color=THEME["text"])
            self._reset_start_btn()

    # ========================================================================
    # ETA
    # ========================================================================

    @staticmethod
    def _format_time(seconds):
        seconds = int(seconds)
        if seconds < 60:
            return f"{seconds}s"
        elif seconds < 3600:
            m, s = divmod(seconds, 60)
            return f"{m}m {s:02d}s"
        else:
            h, rem = divmod(seconds, 3600)
            m, _ = divmod(rem, 60)
            return f"{h}h {m:02d}m"

    # ========================================================================
    # START / CANCEL
    # ========================================================================

    def _start(self):
        video_path = self._video_path.strip()
        if not video_path:
            messagebox.showwarning("No Video", "Please select a video file first.")
            return
        if not os.path.isfile(video_path):
            messagebox.showerror("Not Found", f"File not found:\n{video_path}")
            return

        self._cancel_flag = False
        self._output_path = None
        self._start_time = time.time()
        # Reset start button to default state
        self.start_btn.configure(
            state="disabled",
            text="\u25B6  Start",
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            command=self._start,
        )
        self.cancel_btn.configure(state="normal")
        self.progress_bar.configure(progress_color=THEME["accent"])
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.step_label.configure(text="Starting...", text_color=THEME["text"])
        self.progress_label.configure(text="", text_color=THEME["text_muted"])
        self.eta_label.configure(text="")

        style = self._get_selected_style()
        model = "medium"
        output_dir = str(OUTPUT_DIR)
        remove_fillers = self.filler_var.get()
        caption_overrides = self._get_caption_overrides()

        self._worker_thread = threading.Thread(
            target=self._worker,
            args=(video_path, style, model, output_dir, remove_fillers, caption_overrides),
            daemon=True,
        )
        self._worker_thread.start()

    def _cancel(self):
        self._cancel_flag = True
        self.cancel_btn.configure(state="disabled")
        self.progress_label.configure(text="Cancelling...", text_color=THEME["warning"])

    def _open_output(self):
        out_dir = str(OUTPUT_DIR)
        os.makedirs(out_dir, exist_ok=True)
        open_file_manager(out_dir)

    # ========================================================================
    # PROGRESS CALLBACK (from worker thread)
    # ========================================================================

    def _progress_callback(self, message, step=None, total_steps=None, progress=None):
        """Called by the editor (in worker thread)."""
        def _update():
            if step is not None and total_steps is not None:
                self.step_label.configure(
                    text=f"Step {step} of {total_steps}",
                    text_color=THEME["text"],
                )
                pct = progress if progress is not None else step / total_steps
                self.progress_bar.set(pct)
                self.progress_pct.configure(text=f"{int(pct * 100)}%")

                # Clean message: strip step prefix like "[3/6] "
                clean_msg = re.sub(r'^\s*\[?\d+/\d+\]?\s*', '', message).strip()
                if clean_msg:
                    self.progress_label.configure(
                        text=clean_msg, text_color=THEME["text_muted"])

                # ETA calculation
                if self._start_time and pct > 0.01:
                    elapsed = time.time() - self._start_time
                    remaining = (elapsed / pct) - elapsed
                    if remaining > 0:
                        self.eta_label.configure(
                            text=f"ETA ~{self._format_time(remaining)}")
                    else:
                        self.eta_label.configure(text="")
            else:
                short = message.strip().lstrip("\n")
                if short:
                    self.progress_label.configure(
                        text=short, text_color=THEME["text_muted"])

        self.after(0, _update)

    def _cancel_check(self) -> bool:
        return self._cancel_flag

    # ========================================================================
    # WORKER THREAD
    # ========================================================================

    def _worker(self, video_path, style, model, output_dir, remove_fillers=True, caption_overrides=None):
        """Runs in background thread."""
        result = None
        self._last_output_path = None

        self._cut_count = 0
        self._has_subtitles = False

        def _tracking_callback(message, step=None, total_steps=None, progress=None):
            if isinstance(message, str):
                # Track output path
                if "Done! Output:" in message:
                    path = message.split("Done! Output:")[-1].strip()
                    if os.path.isfile(path):
                        self._last_output_path = path
                # Track segment count (e.g. "37 segments, 21.8s removed") → 36 cuts
                if "segments" in message and "removed" in message and "silence" not in message:
                    import re
                    m = re.search(r"(\d+)\s*segments", message)
                    if m:
                        self._cut_count = max(0, int(m.group(1)) - 1)
                # Track subtitles (e.g. "24 subtitles added")
                if "subtitles added" in message.lower():
                    self._has_subtitles = True
            self._progress_callback(message, step, total_steps, progress)

        try:
            self._ensure_whisper_model(model)

            from src.editor import VideoEditor
            editor = VideoEditor(
                video_path, output_dir,
                whisper_model=model,
                progress_callback=_tracking_callback,
                cancel_check=self._cancel_check,
            )
            try:
                editor.__enter__()
                result = editor.edit_video(style, remove_fillers=remove_fillers, style_overrides=caption_overrides)
            finally:
                try:
                    editor.__exit__(None, None, None)
                except Exception:
                    pass

            self._output_path = result

            # Increment trial counter after successful edit
            if getattr(self, '_trial_mode', False):
                from src.license import increment_trial
                remaining, total = increment_trial()
                self._trial_remaining = remaining
                if hasattr(self, '_trial_banner'):
                    self.after(0, lambda r=remaining: self._trial_banner.configure(
                        text=f"\u26a1 Trial Mode: {r} free edits remaining"
                    ))
                if remaining <= 0:
                    self.after(0, self._show_trial_ended)

            self.after(0, self._on_done, result)

        except InterruptedError:
            self.after(0, self._on_cancelled)
        except Exception as e:
            # Log full traceback for debugging
            tb_str = traceback.format_exc()
            try:
                log_path = os.path.join(str(Path.home()), "VideoEditor_error.log")
                with open(log_path, "w") as f:
                    f.write(tb_str)
            except Exception:
                pass
            fallback = result or self._last_output_path
            # Last resort: check for expected output file by name
            if not (fallback and os.path.isfile(str(fallback))):
                try:
                    base = os.path.splitext(os.path.basename(video_path))[0]
                    expected = os.path.join(output_dir, f"{base}_clean.mp4")
                    if os.path.isfile(expected):
                        fallback = expected
                except Exception:
                    pass
            if fallback and os.path.isfile(str(fallback)):
                self._output_path = str(fallback)
                self.after(0, self._on_done, str(fallback))
            else:
                self.after(0, self._on_error, f"{e}\n\nSee ~/VideoEditor_error.log")

    def _open_video(self):
        if self._output_path and os.path.isfile(str(self._output_path)):
            open_file_manager(str(self._output_path))
        self._reset_start_btn()

    def _on_done(self, output_path):
        elapsed = time.time() - self._start_time if self._start_time else 0
        self.progress_bar.configure(progress_color=THEME["success"])
        self.progress_bar.set(1.0)
        self.progress_pct.configure(text="100%")
        self.step_label.configure(text="Complete", text_color=THEME["success"])
        # Build summary text
        summary = f"Completed in {self._format_time(elapsed)}"
        parts = []
        if self._cut_count > 0:
            parts.append(f"{self._cut_count} cuts")
        if self._has_subtitles:
            parts.append("subtitles added")
        if parts:
            summary += "\n" + ", ".join(parts)
        self.progress_label.configure(
            text=summary,
            text_color=THEME["success"])
        self.eta_label.configure(text="")
        # Replace start button with "Open Video"
        self.start_btn.configure(
            state="normal",
            text="\u25B6  Open Video",
            fg_color=THEME["success"],
            hover_color="#00a844",
            command=self._open_video,
        )
        self.cancel_btn.configure(state="disabled")

    def _reset_start_btn(self):
        self.start_btn.configure(
            state="normal",
            text="\u25B6  Start",
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            command=self._start,
        )

    def _on_cancelled(self):
        self.progress_bar.configure(progress_color=THEME["warning"])
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.step_label.configure(text="Cancelled", text_color=THEME["warning"])
        self.progress_label.configure(text="", text_color=THEME["text_muted"])
        self.eta_label.configure(text="")
        self._reset_start_btn()
        self.cancel_btn.configure(state="disabled")

    def _ensure_whisper_model(self, model_name: str):
        """Checks if the Whisper model is available, downloads it if needed."""
        model_sizes = {"tiny": "75 MB", "base": "140 MB", "small": "460 MB", "medium": "1.5 GB", "large": "2.9 GB"}
        try:
            import whisper
            model_dir = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
            model_file = os.path.join(model_dir, f"{model_name}.pt")
            if not os.path.isfile(model_file):
                size = model_sizes.get(model_name, "")
                self._progress_callback(
                    f"Downloading speech model '{model_name}' ({size}) — first time only, please wait...",
                    step=0, total_steps=6
                )
                whisper.load_model(model_name)
                self._progress_callback(
                    f"Speech model ready.",
                    step=0, total_steps=6
                )
        except Exception:
            pass

    def _on_error(self, msg):
        self.progress_bar.configure(progress_color=THEME["danger"])
        self.step_label.configure(text="Error", text_color=THEME["danger"])
        self.progress_label.configure(
            text=str(msg)[:80], text_color=THEME["danger"])
        self.eta_label.configure(text="")
        self._reset_start_btn()
        self.cancel_btn.configure(state="disabled")
        messagebox.showerror("Error", f"Video processing failed:\n\n{msg}")

    def _show_trial_ended(self):
        """Show trial ended message and redirect to license screen."""
        messagebox.showinfo(
            "Trial Ended",
            "You've used all 3 free edits.\n\n"
            "Enter a license key to continue using SmartCut."
        )
        # Destroy all main UI and show license screen
        for widget in self.winfo_children():
            widget.destroy()
        self._trial_mode = False
        self._build_license_screen()

    # ========================================================================
    # INFO
    # ========================================================================

    def _show_info(self):
        info_window = ctk.CTkToplevel(self)
        info_window.title("How it works")
        info_window.geometry("440x520")
        info_window.resizable(True, True)
        info_window.configure(fg_color=THEME["bg"])
        info_window.transient(self)
        info_window.grab_set()

        scroll = ctk.CTkScrollableFrame(
            info_window, fg_color=THEME["bg"],
        )
        scroll.pack(padx=12, pady=(12, 0), fill="both", expand=True)

        sections = [
            ("HOW IT WORKS", (
                "SmartCut analyzes your video in 5 steps:\n\n"
                "1. Transcribe — Speech recognition using AI\n"
                "2. Silence detection — Finds pauses to cut\n"
                "3. Preparation — Sets up the edit\n"
                "4. Processing — Renders each segment\n"
                "5. Merging — Combines everything"
            )),
            ("WHAT TO EXPECT", (
                "• Portrait videos: ~30 sec per minute\n"
                "• Landscape videos: ~1 min per minute\n"
                "• First run downloads the speech model\n"
                "  (~1.5 GB) — this only happens once.\n"
                "• Step 1-2 take the longest.\n"
                "• If it seems stuck, wait — it's likely\n"
                "  still processing in the background."
            )),
            ("STYLES", (
                "• Clean — Tight cuts, phrase subtitles\n"
                "• Fast — Fast cuts, word-by-word subtitles\n"
                "• Balanced — Balanced cuts + subtitles\n"
                "• Smooth — Smooth cuts + subtitles\n"
                "• Minimal — Tight cuts, no subtitles"
            )),
            ("PLUGINS", (
                "Use the Plugins button (top right) to install\n"
                "editor plugins for your video editing software.\n"
                "SmartCut must be running in the background.\n\n"
                "Premiere Pro:\n"
                "  Install via Plugins, then open in Premiere:\n"
                "  Window > Extensions > SmartCut\n\n"
                "DaVinci Resolve:\n"
                "  Install via Plugins, then open in Resolve:\n"
                "  Workspace > Scripts > Edit > video_editor_resolve"
            )),
            ("TIPS", (
                "• Use Cancel to stop processing.\n"
                "• Output files are saved to:\n"
                "  ~/Movies/Videos/\n"
                "• License can be managed via the\n"
                "  License button (top right)."
            )),
        ]

        for title, body in sections:
            ctk.CTkLabel(
                scroll, text=title,
                font=ctk.CTkFont(size=14, weight="bold"),
                text_color=THEME["accent"],
                anchor="w",
            ).pack(padx=8, pady=(12, 2), anchor="w")
            ctk.CTkLabel(
                scroll, text=body,
                font=ctk.CTkFont(size=13),
                text_color=THEME["text"],
                justify="left",
                anchor="nw",
            ).pack(padx=8, pady=(0, 8), anchor="w")

        close_btn = ctk.CTkButton(
            info_window, text="Got it",
            font=ctk.CTkFont(size=13, weight="bold"),
            height=34,
            fg_color=THEME["accent"],
            hover_color=THEME["accent_hover"],
            corner_radius=8,
            command=info_window.destroy,
        )
        close_btn.pack(padx=20, pady=12)

    # ========================================================================
    # PLUGIN MANAGER
    # ========================================================================

    def _auto_install_plugins(self):
        """Auto-install plugins for detected NLEs on first launch."""
        for nle_name in ["DaVinci Resolve", "Premiere Pro"]:
            platform = sys.platform
            detect_paths = PluginManagerWindow.NLE_DETECT.get(nle_name, {})
            base_path = detect_paths.get(platform, "")
            if not base_path:
                continue

            # Check if NLE is installed
            nle_found = False
            parent = os.path.dirname(base_path)
            basename = os.path.basename(base_path)
            if os.path.isdir(parent):
                for entry in os.listdir(parent):
                    if entry.startswith(basename):
                        nle_found = True
                        break
            if not nle_found:
                nle_found = os.path.isdir(base_path)

            if not nle_found:
                continue

            # Check if already installed
            install_paths = PluginManagerWindow.PLUGIN_PATHS.get(nle_name, {})
            install_path = install_paths.get(platform, "")
            already_installed = False
            if nle_name == "DaVinci Resolve":
                already_installed = os.path.isfile(
                    os.path.join(install_path, "smartcut.lua"))
            elif nle_name == "Premiere Pro":
                already_installed = os.path.isdir(install_path)

            if already_installed:
                continue

            # Auto-install silently
            try:
                import shutil
                os.makedirs(install_path, exist_ok=True)
                plugin_src = SCRIPT_DIR / "plugins"

                if nle_name == "DaVinci Resolve":
                    src = plugin_src / "davinci" / "smartcut.lua"
                    shutil.copy2(str(src), os.path.join(install_path, "smartcut.lua"))

                elif nle_name == "Premiere Pro":
                    src = plugin_src / "premiere" / "panel"
                    shutil.copytree(str(src), install_path)
                    shutil.copy2(
                        str(plugin_src / "premiere" / "video_editor_premiere.py"),
                        os.path.join(install_path, "video_editor_premiere.py"))

                print(f"Auto-installed {nle_name} plugin")
            except Exception as e:
                print(f"Could not auto-install {nle_name} plugin: {e}")

    def _start_plugin_server(self):
        """Start the plugin backend server in a background thread."""
        def _run_server():
            try:
                sys.path.insert(0, str(SCRIPT_DIR / "plugins" / "premiere"))
                from video_editor_premiere import ThreadedHTTPServer, VideoEditorHandler
                server = ThreadedHTTPServer(("127.0.0.1", 8456), VideoEditorHandler)
                server.serve_forever()
            except OSError:
                pass  # Port already in use (another instance running)
            except Exception:
                pass

        server_thread = threading.Thread(target=_run_server, daemon=True)
        server_thread.start()

    def _open_plugins(self):
        if hasattr(self, '_plugin_window') and self._plugin_window and self._plugin_window.winfo_exists():
            self._plugin_window.lift()
            self._plugin_window.focus_force()
            return
        self._plugin_window = PluginManagerWindow(self)

    def _show_license(self):
        """Show license info dialog with option to deactivate."""
        win = ctk.CTkToplevel(self)
        win.title("License")
        win.geometry("380x200")
        win.resizable(False, False)
        win.configure(fg_color=THEME["bg"])
        win.transient(self)
        win.grab_set()
        win.grid_columnconfigure(0, weight=1)

        key = get_saved_key()
        masked = key[:5] + "..." + key[-5:] if key and len(key) > 10 else (key or "None")

        ctk.CTkLabel(
            win, text="LICENSE",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=THEME["text"],
        ).grid(row=0, column=0, padx=20, pady=(16, 4), sticky="w")

        ok, msg = check_license()
        status_color = THEME["success"] if ok else THEME["danger"]
        ctk.CTkLabel(
            win, text=f"Status: {msg}",
            font=ctk.CTkFont(size=12),
            text_color=status_color,
        ).grid(row=1, column=0, padx=20, pady=(0, 2), sticky="w")

        ctk.CTkLabel(
            win, text=f"Key: {masked}",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        ).grid(row=2, column=0, padx=20, pady=(0, 12), sticky="w")

        def _deactivate():
            deactivate_license()
            win.grab_release()
            win.destroy()
            messagebox.showinfo("License", "License deactivated. The app will close.")
            self.destroy()

        ctk.CTkButton(
            win, text="Deactivate License",
            font=ctk.CTkFont(size=13),
            height=34,
            fg_color=THEME["surface"],
            hover_color=THEME["surface_2"],
            text_color=THEME["danger"],
            border_width=1,
            border_color=THEME["danger"],
            corner_radius=8,
            command=_deactivate,
        ).grid(row=3, column=0, padx=20, pady=(0, 8), sticky="ew")

        ctk.CTkButton(
            win, text="Close",
            font=ctk.CTkFont(size=13),
            height=30,
            fg_color="transparent",
            hover_color=THEME["surface"],
            text_color=THEME["text_sec"],
            corner_radius=8,
            command=win.destroy,
        ).grid(row=4, column=0, padx=20, pady=(0, 12), sticky="ew")


class PluginManagerWindow(ctk.CTkToplevel):
    """Plugin installation window with auto-detection of installed NLEs."""

    # Plugin install paths per platform
    PLUGIN_PATHS = {
        "DaVinci Resolve": {
            "darwin": "/Library/Application Support/Blackmagic Design"
                "/DaVinci Resolve/Fusion/Scripts/Edit",
            "win32": os.path.join(
                os.environ.get("PROGRAMDATA", "C:\\ProgramData"),
                "Blackmagic Design", "DaVinci Resolve",
                "Fusion", "Scripts", "Edit"
            ),
            "linux": "/opt/resolve/Fusion/Scripts/Edit",
        },
        "Premiere Pro": {
            "darwin": os.path.expanduser(
                "~/Library/Application Support/Adobe/CEP/extensions"
                "/com.videoeditor.panel"
            ),
            "win32": os.path.join(
                os.environ.get("APPDATA", ""),
                "Adobe", "CEP", "extensions", "com.videoeditor.panel"
            ),
            "linux": "",
        },
    }

    # Paths to check if the NLE is installed
    NLE_DETECT = {
        "DaVinci Resolve": {
            "darwin": "/Applications/DaVinci Resolve",
            "win32": "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve",
            "linux": "/opt/resolve",
        },
        "Premiere Pro": {
            "darwin": "/Applications/Adobe Premiere Pro",
            "win32": "C:\\Program Files\\Adobe\\Adobe Premiere Pro",
            "linux": "",
        },
    }

    def __init__(self, parent):
        super().__init__(parent)
        self.title("Plugins")
        self.geometry("450x360")
        self.resizable(False, False)
        self.configure(fg_color=THEME["bg"])

        # Focus this window
        self.after(100, self.lift)
        self.after(100, self.focus_force)

        self._build_ui()

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            self, text="PLUGINS",
            font=ctk.CTkFont(size=18, weight="bold"),
            text_color=THEME["text"],
        ).grid(row=0, column=0, padx=20, pady=(16, 4), sticky="w")

        ctk.CTkLabel(
            self, text="Install plugins for your video editing software",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        ).grid(row=1, column=0, padx=20, pady=(0, 12), sticky="w")

        row = 2
        for nle_name in ["DaVinci Resolve", "Premiere Pro"]:
            self._add_plugin_row(nle_name, row)
            row += 1

        # Status label
        self.status_label = ctk.CTkLabel(
            self, text="",
            font=ctk.CTkFont(size=12),
            text_color=THEME["text_muted"],
        )
        self.status_label.grid(row=row, column=0, padx=20, pady=(12, 8), sticky="w")

    def _add_plugin_row(self, nle_name, row):
        frame = ctk.CTkFrame(
            self,
            fg_color=THEME["surface"],
            corner_radius=10,
            border_width=1,
            border_color=THEME["border"],
        )
        frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        frame.grid_columnconfigure(1, weight=1)

        detected = self._is_nle_installed(nle_name)
        installed = self._is_plugin_installed(nle_name)

        # NLE name
        ctk.CTkLabel(
            frame, text=nle_name,
            font=ctk.CTkFont(size=14, weight="bold"),
            text_color=THEME["text"],
        ).grid(row=0, column=0, padx=(12, 8), pady=(10, 2), sticky="w", columnspan=2)

        if installed:
            status_text = "Installed"
            status_color = THEME["success"]
        elif detected:
            status_text = "Detected - Ready to install"
            status_color = THEME["accent"]
        else:
            status_text = "Not detected"
            status_color = THEME["text_muted"]

        ctk.CTkLabel(
            frame, text=status_text,
            font=ctk.CTkFont(size=11),
            text_color=status_color,
        ).grid(row=1, column=0, padx=12, pady=(0, 10), sticky="w")

        # Install/Uninstall button
        if installed:
            btn = ctk.CTkButton(
                frame, text="Uninstall", width=90, height=28,
                fg_color=THEME["surface_2"],
                hover_color=THEME["border"],
                text_color=THEME["text"],
                corner_radius=8,
                command=lambda n=nle_name: self._uninstall_plugin(n),
            )
        else:
            btn = ctk.CTkButton(
                frame, text="Install", width=90, height=28,
                fg_color=THEME["accent"],
                hover_color=THEME["accent_hover"],
                text_color="#ffffff",
                corner_radius=8,
                state="normal" if detected else "disabled",
                command=lambda n=nle_name: self._install_plugin(n),
            )

        btn.grid(row=0, column=2, rowspan=2, padx=12, pady=8)

    def _is_nle_installed(self, nle_name):
        """Check if the NLE application is installed."""
        platform = sys.platform
        detect_paths = self.NLE_DETECT.get(nle_name, {})
        base_path = detect_paths.get(platform, "")
        if not base_path:
            return False

        # Check for partial matches (versioned folders)
        parent = os.path.dirname(base_path)
        basename = os.path.basename(base_path)
        if os.path.isdir(parent):
            for entry in os.listdir(parent):
                if entry.startswith(basename):
                    return True
        return os.path.isdir(base_path) or os.path.exists(base_path)

    def _is_plugin_installed(self, nle_name):
        """Check if our plugin is already installed."""
        platform = sys.platform
        install_paths = self.PLUGIN_PATHS.get(nle_name, {})
        install_path = install_paths.get(platform, "")
        if not install_path:
            return False

        if nle_name == "DaVinci Resolve":
            return os.path.isfile(
                os.path.join(install_path, "smartcut.lua"))
        elif nle_name == "Premiere Pro":
            return os.path.isdir(install_path)
        return False

    def _install_plugin(self, nle_name):
        """Install the plugin for the given NLE."""
        import shutil
        platform = sys.platform
        install_paths = self.PLUGIN_PATHS.get(nle_name, {})
        install_path = install_paths.get(platform, "")

        if not install_path:
            self._set_status(f"Platform not supported for {nle_name}", THEME["warning"])
            return

        try:
            plugin_src = SCRIPT_DIR / "plugins"

            if nle_name == "DaVinci Resolve":
                os.makedirs(install_path, exist_ok=True)
                src = plugin_src / "davinci" / "smartcut.lua"
                dst = os.path.join(install_path, "smartcut.lua")
                shutil.copy2(str(src), dst)

            elif nle_name == "Premiere Pro":
                src = plugin_src / "premiere" / "panel"
                # Remove old installation if exists
                if os.path.isdir(install_path):
                    shutil.rmtree(install_path)
                # Ensure parent directory exists
                os.makedirs(os.path.dirname(install_path), exist_ok=True)
                shutil.copytree(str(src), install_path)

                # Also copy the backend server script
                shutil.copy2(
                    str(plugin_src / "premiere" / "video_editor_premiere.py"),
                    os.path.join(install_path, "video_editor_premiere.py"))

            self._set_status(f"{nle_name} plugin installed!", THEME["success"])
            self._refresh()

        except Exception as e:
            self._set_status(f"Install failed: {e}", THEME["danger"])

    def _uninstall_plugin(self, nle_name):
        """Uninstall the plugin."""
        import shutil
        platform = sys.platform
        install_paths = self.PLUGIN_PATHS.get(nle_name, {})
        install_path = install_paths.get(platform, "")

        try:
            if nle_name == "DaVinci Resolve":
                script_path = os.path.join(install_path, "smartcut.lua")
                if os.path.isfile(script_path):
                    os.remove(script_path)
            elif nle_name == "Premiere Pro":
                if os.path.isdir(install_path):
                    shutil.rmtree(install_path)

            self._set_status(f"{nle_name} plugin uninstalled.", THEME["warning"])
            self._refresh()

        except Exception as e:
            self._set_status(f"Uninstall failed: {e}", THEME["danger"])

    def _set_status(self, text, color=None):
        self.status_label.configure(text=text, text_color=color or THEME["text"])

    def _refresh(self):
        """Rebuild UI to reflect current state."""
        for widget in self.winfo_children():
            widget.destroy()
        self._build_ui()


# ============================================================================
# MAIN
# ============================================================================

def _acquire_lock():
    """Ensure only one instance of the app runs at a time."""
    lock_dir = os.path.join(os.path.expanduser("~"), ".videoeditor")
    os.makedirs(lock_dir, exist_ok=True)
    lock_path = os.path.join(lock_dir, ".lock")

    # Try to bind a socket to a fixed port — fails if already in use
    import socket
    _lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        _lock_socket.bind(("127.0.0.1", 48721))
        return _lock_socket
    except OSError:
        messagebox.showwarning("SmartCut", "SmartCut is already running.")
        return None


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _lock = _acquire_lock()
    if _lock is None:
        sys.exit(0)
    app = VideoEditorApp()
    app.mainloop()
