#!/usr/bin/env python3
"""
Video Editor GUI - CustomTkinter Interface
"""

import multiprocessing
import os
import sys
import threading
import subprocess
from pathlib import Path

# Determine project root
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

# Make FFmpeg available for moviepy in bundle
def _setup_ffmpeg_env():
    """Sets IMAGEIO_FFMPEG_EXE when running in Nuitka bundle."""
    try:
        from src.ffmpeg_utils import get_ffmpeg_path, _is_bundled
        ffmpeg_path = get_ffmpeg_path()
        if ffmpeg_path and ffmpeg_path != 'ffmpeg':
            os.environ['IMAGEIO_FFMPEG_EXE'] = ffmpeg_path
    except Exception:
        pass

_setup_ffmpeg_env()

import customtkinter as ctk
from tkinter import filedialog, messagebox

from src.styles import STYLES, get_style_info
from src.platform_utils import open_file_manager

# Output directory: SCRIPT_DIR is read-only in .app bundle
OUTPUT_DIR = Path.home() / "Movies" / "VideoEditor"


# ============================================================================
# THEME
# ============================================================================

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


# ============================================================================
# MAIN APP
# ============================================================================

class VideoEditorApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("Video Editor")
        self.geometry("620x600")
        self.minsize(560, 580)
        self.resizable(True, True)

        # State
        self._worker_thread = None
        self._cancel_flag = False
        self._output_path = None

        self._build_ui()
        self._auto_install_plugins()

    # ========================================================================
    # UI SETUP
    # ========================================================================

    def _build_ui(self):
        # Container
        self.grid_columnconfigure(0, weight=1)
        row = 0

        # --- Title ---
        title = ctk.CTkLabel(self, text="VIDEO EDITOR",
                             font=ctk.CTkFont(size=22, weight="bold"))
        title.grid(row=row, column=0, padx=20, pady=(18, 10), sticky="w")
        row += 1

        # --- Video Selection ---
        vid_frame = ctk.CTkFrame(self, fg_color="transparent")
        vid_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        vid_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(vid_frame, text="Video:").grid(row=0, column=0, padx=(0, 8))
        self.video_entry = ctk.CTkEntry(vid_frame, placeholder_text="Select video file...")
        self.video_entry.grid(row=0, column=1, sticky="ew")
        ctk.CTkButton(vid_frame, text="Browse", width=100,
                      command=self._pick_video).grid(row=0, column=2, padx=(8, 0))
        row += 1

        # --- Style ---
        style_frame = ctk.CTkFrame(self, fg_color="transparent")
        style_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        style_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(style_frame, text="Style:").grid(row=0, column=0, padx=(0, 8))

        style_info = get_style_info()
        self._style_names = list(style_info.keys())
        style_labels = [f"{name}  -  {info['description'][:50]}"
                        for name, info in style_info.items()]
        default_idx = self._style_names.index("clean") if "clean" in self._style_names else 0
        self.style_var = ctk.StringVar(value=style_labels[default_idx])
        self.style_menu = ctk.CTkOptionMenu(style_frame, variable=self.style_var,
                                            values=style_labels,
                                            command=self._on_style_changed)
        self.style_menu.grid(row=0, column=1, sticky="ew")
        row += 1

        # Style description
        self.style_desc = ctk.CTkLabel(self, text="", font=ctk.CTkFont(size=12),
                                       text_color="gray")
        self.style_desc.grid(row=row, column=0, padx=28, pady=(0, 4), sticky="w")
        self._on_style_changed(None)
        row += 1

        # --- Model ---
        model_frame = ctk.CTkFrame(self, fg_color="transparent")
        model_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        model_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(model_frame, text="Model:").grid(row=0, column=0, padx=(0, 8))
        self.model_var = ctk.StringVar(value="medium (recommended)")
        model_options = ["tiny (fast)", "base", "small", "medium (recommended)", "large (slow)"]
        self.model_menu = ctk.CTkOptionMenu(model_frame, variable=self.model_var,
                                            values=model_options)
        self.model_menu.grid(row=0, column=1, sticky="ew")
        row += 1

        # --- Fast Mode ---
        self.fast_var = ctk.BooleanVar(value=False)
        self.fast_check = ctk.CTkCheckBox(self, text="Fast Mode (clean style only, faster)",
                                          variable=self.fast_var)
        self.fast_check.grid(row=row, column=0, padx=24, pady=4, sticky="w")
        row += 1

        # --- Progress ---
        prog_frame = ctk.CTkFrame(self)
        prog_frame.grid(row=row, column=0, padx=20, pady=(10, 4), sticky="ew")
        prog_frame.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(prog_frame, text="Progress",
                     font=ctk.CTkFont(size=13, weight="bold")).grid(
            row=0, column=0, padx=10, pady=(8, 2), sticky="w")

        bar_frame = ctk.CTkFrame(prog_frame, fg_color="transparent")
        bar_frame.grid(row=1, column=0, padx=10, pady=2, sticky="ew")
        bar_frame.grid_columnconfigure(0, weight=1)

        self.progress_bar = ctk.CTkProgressBar(bar_frame)
        self.progress_bar.grid(row=0, column=0, sticky="ew")
        self.progress_bar.set(0)

        self.progress_pct = ctk.CTkLabel(bar_frame, text="0%", width=45)
        self.progress_pct.grid(row=0, column=1, padx=(6, 0))

        self.progress_label = ctk.CTkLabel(prog_frame, text="Ready.",
                                           font=ctk.CTkFont(size=12),
                                           text_color="gray")
        self.progress_label.grid(row=2, column=0, padx=10, pady=(2, 8), sticky="w")
        row += 1

        # --- Buttons ---
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.grid(row=row, column=0, padx=20, pady=(8, 4), sticky="ew")
        btn_frame.grid_columnconfigure(0, weight=1)
        btn_frame.grid_columnconfigure(1, weight=1)

        self.start_btn = ctk.CTkButton(btn_frame, text="Start",
                                       font=ctk.CTkFont(size=14, weight="bold"),
                                       height=38, command=self._start)
        self.start_btn.grid(row=0, column=0, padx=(0, 6), sticky="ew")

        self.cancel_btn = ctk.CTkButton(btn_frame, text="Cancel",
                                        height=38, state="disabled",
                                        fg_color="#b22222",
                                        hover_color="#8b0000",
                                        command=self._cancel)
        self.cancel_btn.grid(row=0, column=1, padx=(6, 0), sticky="ew")
        row += 1

        self.open_btn = ctk.CTkButton(self, text="Open Output Folder",
                                      height=32, fg_color="transparent",
                                      border_width=1,
                                      command=self._open_output)
        self.open_btn.grid(row=row, column=0, padx=20, pady=(4, 4), sticky="ew")
        row += 1

        # --- Plugins ---
        self.plugins_btn = ctk.CTkButton(self, text="Plugins",
                                         height=32, fg_color="transparent",
                                         border_width=1,
                                         command=self._open_plugins)
        self.plugins_btn.grid(row=row, column=0, padx=20, pady=(0, 14), sticky="ew")

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
            self.video_entry.delete(0, "end")
            self.video_entry.insert(0, path)

    def _on_style_changed(self, _event):
        idx = 0
        current = self.style_var.get()
        for i, name in enumerate(self._style_names):
            if current.startswith(name):
                idx = i
                break
        name = self._style_names[idx]
        desc = STYLES[name]["description"]
        self.style_desc.configure(text=desc)

    def _get_selected_style(self) -> str:
        current = self.style_var.get()
        for name in self._style_names:
            if current.startswith(name):
                return name
        return "clean"

    def _get_selected_model(self) -> str:
        raw = self.model_var.get()
        return raw.split(" ")[0]  # "small (recommended)" -> "small"

    # ========================================================================
    # START / CANCEL
    # ========================================================================

    def _start(self):
        video_path = self.video_entry.get().strip()
        if not video_path:
            messagebox.showwarning("No Video", "Please select a video file first.")
            return
        if not os.path.isfile(video_path):
            messagebox.showerror("Not Found", f"File not found:\n{video_path}")
            return

        self._cancel_flag = False
        self._output_path = None
        self.start_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.progress_label.configure(text="Starting...", text_color="white")

        style = self._get_selected_style()
        model = self._get_selected_model()
        fast = self.fast_var.get()
        output_dir = str(OUTPUT_DIR)

        self._worker_thread = threading.Thread(
            target=self._worker,
            args=(video_path, style, model, fast, output_dir),
            daemon=True,
        )
        self._worker_thread.start()

    def _cancel(self):
        self._cancel_flag = True
        self.cancel_btn.configure(state="disabled")
        self.progress_label.configure(text="Cancelling...", text_color="orange")

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
                self.progress_label.configure(
                    text=f"Step {step}/{total_steps}: {message}",
                    text_color="white")
                if progress is None:
                    pct = step / total_steps
                else:
                    pct = progress
                self.progress_bar.set(pct)
                self.progress_pct.configure(text=f"{int(pct * 100)}%")
            else:
                # Text-only update
                short = message.strip().lstrip("\n")
                if short:
                    self.progress_label.configure(text=short, text_color="white")

        self.after(0, _update)

    def _cancel_check(self) -> bool:
        return self._cancel_flag

    # ========================================================================
    # WORKER THREAD
    # ========================================================================

    def _worker(self, video_path, style, model, fast, output_dir):
        """Runs in background thread."""
        result = None
        self._last_output_path = None

        def _tracking_callback(message, step=None, total_steps=None, progress=None):
            # Track output path from "Fertig! Output: ..." messages
            if isinstance(message, str) and "Fertig! Output:" in message:
                path = message.split("Fertig! Output:")[-1].strip()
                if os.path.isfile(path):
                    self._last_output_path = path
            self._progress_callback(message, step, total_steps, progress)

        try:
            self._ensure_whisper_model(model)

            if fast:
                from src.fast_editor import FastVideoEditor
                editor = FastVideoEditor(
                    video_path, output_dir,
                    whisper_model=model,
                    progress_callback=_tracking_callback,
                    cancel_check=self._cancel_check,
                )
                result = editor.edit_fast(style=style)
            else:
                from src.editor import VideoEditor
                editor = VideoEditor(
                    video_path, output_dir,
                    whisper_model=model,
                    progress_callback=_tracking_callback,
                    cancel_check=self._cancel_check,
                )
                try:
                    editor.__enter__()
                    result = editor.edit_video(style)
                finally:
                    try:
                        editor.__exit__(None, None, None)
                    except Exception:
                        pass

            self._output_path = result
            self.after(0, self._on_done, result)

        except InterruptedError:
            self.after(0, self._on_cancelled)
        except Exception as e:
            fallback = result or self._last_output_path
            if fallback and os.path.isfile(fallback):
                self._output_path = fallback
                self.after(0, self._on_done, fallback)
            else:
                self.after(0, self._on_error, str(e))

    def _on_done(self, output_path):
        self.progress_bar.set(1.0)
        self.progress_pct.configure(text="100%")
        self.progress_label.configure(
            text=f"Done!  {output_path}",
            text_color="#32cd32")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")

    def _on_cancelled(self):
        self.progress_label.configure(text="Cancelled.", text_color="orange")
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")

    def _ensure_whisper_model(self, model_name: str):
        """Checks if the Whisper model is available, downloads it if needed."""
        try:
            import whisper
            model_dir = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
            # Whisper names models e.g. "medium.pt"
            model_file = os.path.join(model_dir, f"{model_name}.pt")
            if not os.path.isfile(model_file):
                self._progress_callback(
                    f"Downloading Whisper model '{model_name}' (one-time)...",
                    step=0, total_steps=6
                )
                # whisper.load_model downloads automatically
                whisper.load_model(model_name)
                self._progress_callback(
                    f"Whisper model '{model_name}' ready.",
                    step=0, total_steps=6
                )
        except Exception:
            pass  # Whisper will be loaded later by the editor

    def _on_error(self, msg):
        self.progress_label.configure(text=f"Error: {msg[:80]}", text_color="#ff4444")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        messagebox.showerror("Error", f"Video processing failed:\n\n{msg}")

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
                    os.path.join(install_path, "video_editor_resolve.py"))
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
                    src = plugin_src / "davinci" / "video_editor_resolve.py"
                    shutil.copy2(str(src), os.path.join(install_path, "video_editor_resolve.py"))
                    import json
                    with open(os.path.join(install_path, "video_editor_config.json"), "w") as f:
                        json.dump({"video_editor_path": str(SCRIPT_DIR)}, f)

                elif nle_name == "Premiere Pro":
                    src = plugin_src / "premiere" / "panel"
                    shutil.copytree(str(src), install_path)
                    shutil.copy2(
                        str(plugin_src / "premiere" / "video_editor_premiere.py"),
                        os.path.join(install_path, "video_editor_premiere.py"))

                print(f"Auto-installed {nle_name} plugin")
            except Exception as e:
                print(f"Could not auto-install {nle_name} plugin: {e}")

    def _open_plugins(self):
        PluginManagerWindow(self)


class PluginManagerWindow(ctk.CTkToplevel):
    """Plugin installation window with auto-detection of installed NLEs."""

    # Plugin install paths per platform
    PLUGIN_PATHS = {
        "DaVinci Resolve": {
            "darwin": os.path.expanduser(
                "~/Library/Application Support/Blackmagic Design"
                "/DaVinci Resolve/Fusion/Scripts/Utility"
            ),
            "win32": os.path.join(
                os.environ.get("APPDATA", ""),
                "Blackmagic Design", "DaVinci Resolve",
                "Fusion", "Scripts", "Utility"
            ),
            "linux": os.path.expanduser(
                "~/.local/share/DaVinciResolve/Fusion/Scripts/Utility"
            ),
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
        self.geometry("420x340")
        self.resizable(False, False)

        # Focus this window
        self.after(100, self.lift)
        self.after(100, self.focus_force)

        self._build_ui()

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(self, text="PLUGINS",
                     font=ctk.CTkFont(size=18, weight="bold")).grid(
            row=0, column=0, padx=20, pady=(16, 4), sticky="w")
        ctk.CTkLabel(self, text="Install plugins for your video editing software",
                     font=ctk.CTkFont(size=12), text_color="gray").grid(
            row=1, column=0, padx=20, pady=(0, 12), sticky="w")

        row = 2
        for nle_name in ["DaVinci Resolve", "Premiere Pro"]:
            self._add_plugin_row(nle_name, row)
            row += 1

        # Status label
        self.status_label = ctk.CTkLabel(self, text="",
                                         font=ctk.CTkFont(size=12))
        self.status_label.grid(row=row, column=0, padx=20, pady=(12, 8), sticky="w")

    def _add_plugin_row(self, nle_name, row):
        frame = ctk.CTkFrame(self)
        frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        frame.grid_columnconfigure(1, weight=1)

        detected = self._is_nle_installed(nle_name)
        installed = self._is_plugin_installed(nle_name)

        # NLE name + status
        name_text = nle_name
        ctk.CTkLabel(frame, text=name_text,
                     font=ctk.CTkFont(size=14, weight="bold")).grid(
            row=0, column=0, padx=(12, 8), pady=(10, 2), sticky="w", columnspan=2)

        if installed:
            status_text = "Installed"
            status_color = "#32cd32"
        elif detected:
            status_text = "Detected - Ready to install"
            status_color = "#4a9eff"
        else:
            status_text = "Not detected"
            status_color = "gray"

        ctk.CTkLabel(frame, text=status_text,
                     font=ctk.CTkFont(size=11),
                     text_color=status_color).grid(
            row=1, column=0, padx=12, pady=(0, 10), sticky="w")

        # Install/Uninstall button
        if installed:
            btn = ctk.CTkButton(frame, text="Uninstall", width=90,
                                height=28, fg_color="#555",
                                command=lambda n=nle_name: self._uninstall_plugin(n))
        else:
            btn = ctk.CTkButton(frame, text="Install", width=90,
                                height=28,
                                state="normal" if detected else "disabled",
                                command=lambda n=nle_name: self._install_plugin(n))

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
                os.path.join(install_path, "video_editor_resolve.py"))
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
            self._set_status(f"Platform not supported for {nle_name}", "orange")
            return

        try:
            os.makedirs(install_path, exist_ok=True)
            plugin_src = SCRIPT_DIR / "plugins"

            if nle_name == "DaVinci Resolve":
                src = plugin_src / "davinci" / "video_editor_resolve.py"
                dst = os.path.join(install_path, "video_editor_resolve.py")
                shutil.copy2(str(src), dst)

                # Write the Video Editor path so the plugin can find it
                config_path = os.path.join(install_path, "video_editor_config.json")
                import json
                with open(config_path, "w") as f:
                    json.dump({"video_editor_path": str(SCRIPT_DIR)}, f)

            elif nle_name == "Premiere Pro":
                src = plugin_src / "premiere" / "panel"
                if os.path.isdir(install_path):
                    shutil.rmtree(install_path)
                shutil.copytree(str(src), install_path)

                # Also copy the backend server script
                shutil.copy2(
                    str(plugin_src / "premiere" / "video_editor_premiere.py"),
                    os.path.join(install_path, "video_editor_premiere.py"))

            self._set_status(f"{nle_name} plugin installed!", "#32cd32")
            self._refresh()

        except Exception as e:
            self._set_status(f"Install failed: {e}", "#ff4444")

    def _uninstall_plugin(self, nle_name):
        """Uninstall the plugin."""
        import shutil
        platform = sys.platform
        install_paths = self.PLUGIN_PATHS.get(nle_name, {})
        install_path = install_paths.get(platform, "")

        try:
            if nle_name == "DaVinci Resolve":
                script_path = os.path.join(install_path, "video_editor_resolve.py")
                config_path = os.path.join(install_path, "video_editor_config.json")
                if os.path.isfile(script_path):
                    os.remove(script_path)
                if os.path.isfile(config_path):
                    os.remove(config_path)
            elif nle_name == "Premiere Pro":
                if os.path.isdir(install_path):
                    shutil.rmtree(install_path)

            self._set_status(f"{nle_name} plugin uninstalled.", "orange")
            self._refresh()

        except Exception as e:
            self._set_status(f"Uninstall failed: {e}", "#ff4444")

    def _set_status(self, text, color="white"):
        self.status_label.configure(text=text, text_color=color)

    def _refresh(self):
        """Rebuild UI to reflect current state."""
        for widget in self.winfo_children():
            widget.destroy()
        self._build_ui()


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    multiprocessing.freeze_support()
    app = VideoEditorApp()
    app.mainloop()
