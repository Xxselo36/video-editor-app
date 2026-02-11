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

# Projekt-Root ermitteln
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

# FFmpeg fuer moviepy im Bundle verfuegbar machen
def _setup_ffmpeg_env():
    """Setzt IMAGEIO_FFMPEG_EXE wenn im Nuitka Bundle."""
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

# Output-Verzeichnis: im .app Bundle ist SCRIPT_DIR read-only
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
        self.geometry("620x520")
        self.minsize(560, 480)
        self.resizable(True, True)

        # State
        self._worker_thread = None
        self._cancel_flag = False
        self._output_path = None

        self._build_ui()

    # ========================================================================
    # UI AUFBAU
    # ========================================================================

    def _build_ui(self):
        # Container
        self.grid_columnconfigure(0, weight=1)
        row = 0

        # --- Titel ---
        title = ctk.CTkLabel(self, text="VIDEO EDITOR",
                             font=ctk.CTkFont(size=22, weight="bold"))
        title.grid(row=row, column=0, padx=20, pady=(18, 10), sticky="w")
        row += 1

        # --- Video-Auswahl ---
        vid_frame = ctk.CTkFrame(self, fg_color="transparent")
        vid_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        vid_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(vid_frame, text="Video:").grid(row=0, column=0, padx=(0, 8))
        self.video_entry = ctk.CTkEntry(vid_frame, placeholder_text="Video-Datei auswaehlen...")
        self.video_entry.grid(row=0, column=1, sticky="ew")
        ctk.CTkButton(vid_frame, text="Auswaehlen", width=100,
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

        # Style-Beschreibung
        self.style_desc = ctk.CTkLabel(self, text="", font=ctk.CTkFont(size=12),
                                       text_color="gray")
        self.style_desc.grid(row=row, column=0, padx=28, pady=(0, 4), sticky="w")
        self._on_style_changed(None)
        row += 1

        # --- Modell ---
        model_frame = ctk.CTkFrame(self, fg_color="transparent")
        model_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        model_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(model_frame, text="Modell:").grid(row=0, column=0, padx=(0, 8))
        self.model_var = ctk.StringVar(value="medium (empfohlen)")
        model_options = ["tiny (schnell)", "base", "small", "medium (empfohlen)", "large (langsam)"]
        self.model_menu = ctk.CTkOptionMenu(model_frame, variable=self.model_var,
                                            values=model_options)
        self.model_menu.grid(row=0, column=1, sticky="ew")
        row += 1

        # --- Fast Mode ---
        self.fast_var = ctk.BooleanVar(value=False)
        self.fast_check = ctk.CTkCheckBox(self, text="Fast Mode (nur clean Style, schneller)",
                                          variable=self.fast_var)
        self.fast_check.grid(row=row, column=0, padx=24, pady=4, sticky="w")
        row += 1

        # --- Fortschritt ---
        prog_frame = ctk.CTkFrame(self)
        prog_frame.grid(row=row, column=0, padx=20, pady=(10, 4), sticky="ew")
        prog_frame.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(prog_frame, text="Fortschritt",
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

        self.progress_label = ctk.CTkLabel(prog_frame, text="Bereit.",
                                           font=ctk.CTkFont(size=12),
                                           text_color="gray")
        self.progress_label.grid(row=2, column=0, padx=10, pady=(2, 8), sticky="w")
        row += 1

        # --- Buttons ---
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.grid(row=row, column=0, padx=20, pady=(8, 4), sticky="ew")
        btn_frame.grid_columnconfigure(0, weight=1)
        btn_frame.grid_columnconfigure(1, weight=1)

        self.start_btn = ctk.CTkButton(btn_frame, text="Starten",
                                       font=ctk.CTkFont(size=14, weight="bold"),
                                       height=38, command=self._start)
        self.start_btn.grid(row=0, column=0, padx=(0, 6), sticky="ew")

        self.cancel_btn = ctk.CTkButton(btn_frame, text="Abbrechen",
                                        height=38, state="disabled",
                                        fg_color="#b22222",
                                        hover_color="#8b0000",
                                        command=self._cancel)
        self.cancel_btn.grid(row=0, column=1, padx=(6, 0), sticky="ew")
        row += 1

        self.open_btn = ctk.CTkButton(self, text="Ausgabe-Ordner oeffnen",
                                      height=32, fg_color="transparent",
                                      border_width=1,
                                      command=self._open_output)
        self.open_btn.grid(row=row, column=0, padx=20, pady=(4, 14), sticky="ew")

    # ========================================================================
    # EVENTS
    # ========================================================================

    def _pick_video(self):
        path = filedialog.askopenfilename(
            title="Video auswaehlen",
            filetypes=[
                ("Video-Dateien", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"),
                ("Alle Dateien", "*.*"),
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
        return raw.split(" ")[0]  # "small (empfohlen)" -> "small"

    # ========================================================================
    # START / CANCEL
    # ========================================================================

    def _start(self):
        video_path = self.video_entry.get().strip()
        if not video_path:
            messagebox.showwarning("Kein Video", "Bitte waehle zuerst ein Video aus.")
            return
        if not os.path.isfile(video_path):
            messagebox.showerror("Nicht gefunden", f"Datei nicht gefunden:\n{video_path}")
            return

        self._cancel_flag = False
        self._output_path = None
        self.start_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.progress_label.configure(text="Starte...", text_color="white")

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
        self.progress_label.configure(text="Abbrechen...", text_color="orange")

    def _open_output(self):
        out_dir = str(OUTPUT_DIR)
        os.makedirs(out_dir, exist_ok=True)
        open_file_manager(out_dir)

    # ========================================================================
    # PROGRESS CALLBACK (vom Worker-Thread)
    # ========================================================================

    def _progress_callback(self, message, step=None, total_steps=None, progress=None):
        """Wird vom Editor aufgerufen (im Worker-Thread)."""
        def _update():
            if step is not None and total_steps is not None:
                self.progress_label.configure(
                    text=f"Schritt {step}/{total_steps}: {message}",
                    text_color="white")
                if progress is None:
                    pct = step / total_steps
                else:
                    pct = progress
                self.progress_bar.set(pct)
                self.progress_pct.configure(text=f"{int(pct * 100)}%")
            else:
                # Nur Text-Update
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
        """Laeuft im Hintergrund-Thread."""
        try:
            # Whisper-Modell pruefen und ggf. herunterladen
            self._ensure_whisper_model(model)

            if fast:
                from src.fast_editor import FastVideoEditor
                editor = FastVideoEditor(
                    video_path, output_dir,
                    whisper_model=model,
                    progress_callback=self._progress_callback,
                    cancel_check=self._cancel_check,
                )
                result = editor.edit_fast(style=style)
            else:
                from src.editor import VideoEditor
                with VideoEditor(
                    video_path, output_dir,
                    whisper_model=model,
                    progress_callback=self._progress_callback,
                    cancel_check=self._cancel_check,
                ) as editor:
                    result = editor.edit_video(style)

            self._output_path = result
            self.after(0, self._on_done, result)

        except InterruptedError:
            self.after(0, self._on_cancelled)
        except Exception as e:
            self.after(0, self._on_error, str(e))

    def _on_done(self, output_path):
        self.progress_bar.set(1.0)
        self.progress_pct.configure(text="100%")
        self.progress_label.configure(
            text=f"Fertig!  {output_path}",
            text_color="#32cd32")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")

    def _on_cancelled(self):
        self.progress_label.configure(text="Abgebrochen.", text_color="orange")
        self.progress_bar.set(0)
        self.progress_pct.configure(text="0%")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")

    def _ensure_whisper_model(self, model_name: str):
        """Prueft ob das Whisper-Modell vorhanden ist, laedt es ggf. herunter."""
        try:
            import whisper
            model_dir = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
            # Whisper benennt Modelle z.B. "medium.pt"
            model_file = os.path.join(model_dir, f"{model_name}.pt")
            if not os.path.isfile(model_file):
                self._progress_callback(
                    f"Lade Whisper-Modell '{model_name}' herunter (einmalig)...",
                    step=0, total_steps=6
                )
                # whisper.load_model laedt automatisch herunter
                whisper.load_model(model_name)
                self._progress_callback(
                    f"Whisper-Modell '{model_name}' bereit.",
                    step=0, total_steps=6
                )
        except Exception:
            pass  # Whisper wird spaeter vom Editor geladen

    def _on_error(self, msg):
        self.progress_label.configure(text=f"Fehler: {msg[:80]}", text_color="#ff4444")
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        messagebox.showerror("Fehler", f"Video-Verarbeitung fehlgeschlagen:\n\n{msg}")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    multiprocessing.freeze_support()
    app = VideoEditorApp()
    app.mainloop()
