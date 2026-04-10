"""
Video Editor - DaVinci Resolve UI (external tkinter process)

Launched by video_editor_resolve.lua from Resolve's Scripts menu.
Pure HTTP client — no DaVinciResolveScript import (avoids fusionscript.so crash).
After analysis, writes a Lua import script that Resolve executes natively.
"""

import sys
import os
import json
import threading
import urllib.request
import urllib.error
import urllib.parse
import tkinter as tk
from tkinter import ttk

API_URL = "http://127.0.0.1:8456"

# Where to write the import script for Resolve
SCRIPTS_DIR = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit"

# ============================================================================
# HTTP helpers
# ============================================================================

def call_backend(path, timeout=10):
    url = "{}{}".format(API_URL, path)
    try:
        response = urllib.request.urlopen(url, timeout=timeout)
        return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

def check_backend():
    data = call_backend("/health", timeout=3)
    return data is not None and data.get("status") == "ok"


# ============================================================================
# Generate Lua import script for Resolve
# ============================================================================

def write_import_script(xml_path, srt_path, clip_name, style_name):
    """Write a Lua script that Resolve can run to import the timeline."""
    lua_path = os.path.join(SCRIPTS_DIR, "video_editor_import.lua")

    # SRT parsing + subtitle insertion in Lua
    srt_lua = ""
    if srt_path:
        srt_lua = '''
-- Add subtitles from SRT
local srt_path = "{srt_path}"
local sf = io.open(srt_path, "r")
if sf and new_tl then
    local content = sf:read("*a")
    sf:close()
    local fps_str = new_tl:GetSetting("timelineFrameRate")
    local fps = tonumber(fps_str) or 24
    pcall(function()
        new_tl:AddTrack("subtitle")
        local st = new_tl:GetTrackCount("subtitle")
        local sub_count = 0
        for sh,sm,ss,sms, eh,em,es,ems, text in content:gmatch(
            "(%d+):(%d+):(%d+)[,.](%d+)%s*%-%->%s*(%d+):(%d+):(%d+)[,.](%d+)%s*\n(.-)\n") do
            local s = tonumber(sh)*3600+tonumber(sm)*60+tonumber(ss)+tonumber(sms)/1000
            local e = tonumber(eh)*3600+tonumber(em)*60+tonumber(es)+tonumber(ems)/1000
            local sfr = math.floor(s * fps)
            local efr = math.floor(e * fps)
            if efr > sfr then
                pcall(function() new_tl:InsertSubtitleInTrack(st, text, sfr, efr) end)
                sub_count = sub_count + 1
            end
        end
        if sub_count > 0 then
            print("[SmartCut] Added " .. sub_count .. " subtitles")
        end
    end)
end
'''.format(srt_path=srt_path.replace("\\", "\\\\").replace('"', '\\"'))

    lua_content = '''--[[
SmartCut - Import Result
Auto-generated. Run this to import the edited timeline.
]]

local project = resolve:GetProjectManager():GetCurrentProject()
if not project then
    print("[SmartCut] Error: No project open")
    return
end

local media_pool = project:GetMediaPool()
local root = media_pool:GetRootFolder()

-- Create subfolder
local folder = media_pool:AddSubFolder(root, "{folder_name}")
if folder then
    media_pool:SetCurrentFolder(folder)
else
    media_pool:SetCurrentFolder(root)
end

-- Import XML timeline
local xml_path = "{xml_path}"
local tl_name = "SmartCut - {clip_name}"
print("[SmartCut] Importing: " .. xml_path)

local new_tl = media_pool:ImportTimelineFromFile(xml_path, {{
    timelineName = tl_name,
    importSourceClips = true,
}})

if new_tl then
    project:SetCurrentTimeline(new_tl)
    print("[SmartCut] Created timeline: " .. tl_name)
    {srt_lua}
    print("[SmartCut] Done!")
else
    print("[SmartCut] Error: ImportTimelineFromFile failed")
end
'''.format(
        xml_path=xml_path.replace("\\", "\\\\").replace('"', '\\"'),
        clip_name=clip_name.replace('"', '\\"'),
        folder_name="{} - {}".format(clip_name, style_name).replace('"', '\\"'),
        srt_lua=srt_lua,
    )

    with open(lua_path, "w") as f:
        f.write(lua_content)
    return lua_path


# ============================================================================
# tkinter UI
# ============================================================================

BG = "#0d0d0f"
BG_CARD = "#1a1a1f"
BG_INPUT = "#222228"
BORDER = "#2a2a32"
TEXT = "#f0f0f2"
TEXT_DIM = "#8e8e96"
TEXT_MUTED = "#5a5a64"
ACCENT = "#6c5ce7"
ACCENT_HOVER = "#7c6cf7"
ACCENT_DIM = "#2d2640"
SUCCESS = "#00c853"
ERROR = "#ef5350"
INFO_BG = "#1a1a3c"
INFO_FG = "#7a8eff"
SUCCESS_BG = "#0a2a0a"
ERROR_BG = "#2a0a0a"

STYLES = [
    ("Clean", "clean", "Tight cuts, phrase subtitles (4 words accumulating)"),
    ("Fast", "fast", "Fast cuts, word-by-word subtitles"),
    ("Balanced", "balanced", "Balanced cuts, word-by-word subtitles"),
    ("Smooth", "smooth", "Smooth cuts, word-by-word subtitles"),
    ("Minimal", "minimal", "Tight cuts, no subtitles"),
]

MODELS = ["tiny", "base", "small", "medium", "large"]


class VideoEditorResolveUI:
    def __init__(self):
        self._processing = False
        self._clip_path = ""

        self.root = tk.Tk()
        self.root.title("SmartCut — DaVinci Resolve")
        self.root.geometry("350x520")
        self.root.resizable(False, False)
        self.root.configure(bg=BG)

        self._build_ui()
        self._check_connection()
        self.root.after(10000, self._periodic_connection_check)

    def _build_ui(self):
        root = self.root
        pad = {"padx": 16}

        tk.Label(root, text="SMARTCUT", font=("Helvetica", 16, "bold"),
                 bg=BG, fg=TEXT, anchor="w").pack(fill="x", pady=(16, 0), **pad)
        tk.Label(root, text="AI-powered video editing — DaVinci Resolve",
                 font=("Helvetica", 10), bg=BG, fg=TEXT_MUTED, anchor="w").pack(fill="x", pady=(0, 12), **pad)

        # Clip path input
        tk.Label(root, text="VIDEO FILE", font=("Helvetica", 10, "bold"),
                 bg=BG, fg=TEXT_DIM, anchor="w").pack(fill="x", pady=(0, 2), **pad)

        clip_frame = tk.Frame(root, bg=BG)
        clip_frame.pack(fill="x", pady=(0, 4), **pad)
        self.clip_entry = tk.Entry(clip_frame, font=("Helvetica", 11),
                                    bg=BG_INPUT, fg=TEXT, insertbackground=TEXT,
                                    relief="flat", bd=0, highlightthickness=1,
                                    highlightbackground=BORDER, highlightcolor=ACCENT)
        self.clip_entry.pack(side="left", fill="x", expand=True, ipady=6, padx=(0, 6))

        browse_btn = tk.Button(clip_frame, text="Browse", font=("Helvetica", 10),
                                bg=BG_INPUT, fg=TEXT_DIM, activebackground=BORDER,
                                activeforeground=TEXT, relief="flat", bd=0,
                                command=self._browse_file)
        browse_btn.pack(side="right", ipady=4, ipadx=8)

        tk.Label(root, text="Drag & drop a file or paste the path from Resolve's Media Pool",
                 font=("Helvetica", 9), bg=BG, fg=TEXT_MUTED, anchor="w",
                 wraplength=310).pack(fill="x", pady=(0, 8), **pad)

        # Style
        tk.Label(root, text="STYLE", font=("Helvetica", 10, "bold"),
                 bg=BG, fg=TEXT_DIM, anchor="w").pack(fill="x", pady=(4, 2), **pad)
        self.style_var = tk.StringVar(value="Clean")
        sf = tk.Frame(root, bg=BG)
        sf.pack(fill="x", **pad)
        self.style_combo = ttk.Combobox(sf, textvariable=self.style_var,
                                         values=[s[0] for s in STYLES],
                                         state="readonly", width=38)
        self.style_combo.set("Clean")
        self.style_combo.pack(fill="x")
        self.style_combo.bind("<<ComboboxSelected>>", self._on_style_change)
        self.style_desc = tk.Label(root, text=STYLES[0][2], font=("Helvetica", 9),
                                   bg=BG, fg=TEXT_MUTED, anchor="w")
        self.style_desc.pack(fill="x", pady=(2, 8), **pad)

        # Model
        tk.Label(root, text="WHISPER MODEL", font=("Helvetica", 10, "bold"),
                 bg=BG, fg=TEXT_DIM, anchor="w").pack(fill="x", pady=(0, 2), **pad)
        self.model_var = tk.StringVar(value="medium")
        mf = tk.Frame(root, bg=BG)
        mf.pack(fill="x", **pad)
        self.model_combo = ttk.Combobox(mf, textvariable=self.model_var,
                                         values=MODELS, state="readonly", width=38)
        self.model_combo.set("medium")
        self.model_combo.pack(fill="x")

        # Process button
        self.process_btn = tk.Button(root, text="Process Video",
                                      font=("Helvetica", 13, "bold"),
                                      bg=ACCENT, fg="white", activebackground=ACCENT_HOVER,
                                      activeforeground="white", relief="flat",
                                      bd=0, padx=14, pady=12,
                                      command=self._on_process)
        self.process_btn.pack(fill="x", pady=(12, 0), **pad)

        # Progress bar
        self.progress_frame = tk.Frame(root, bg=ACCENT_DIM, height=4)
        self.progress_frame.pack(fill="x", pady=(8, 0), **pad)
        self.progress_frame.pack_propagate(False)
        self.progress_fill = tk.Frame(self.progress_frame, bg=ACCENT, height=4)
        self.progress_fill.place(x=0, y=0, relheight=1.0, relwidth=0.0)
        self.progress_frame.pack_forget()

        # Status
        self.status_frame = tk.Frame(root, bg=BG, padx=10, pady=8)
        self.status_label = tk.Label(self.status_frame, text="", font=("Helvetica", 11),
                                     bg=BG, fg=TEXT_DIM, anchor="w", wraplength=300, justify="left")
        self.status_label.pack(fill="x")

        # Import button (hidden initially)
        self.import_btn = tk.Button(root, text="Import into Resolve  →",
                                     font=("Helvetica", 12, "bold"),
                                     bg="#1a6b1a", fg="white", activebackground="#228b22",
                                     activeforeground="white", relief="flat",
                                     bd=0, padx=14, pady=10,
                                     command=self._show_import_instructions)
        # Not packed yet — shown after analysis

        # Connection
        conn_frame = tk.Frame(root, bg=BG)
        conn_frame.pack(side="bottom", fill="x", pady=(0, 12))
        self.conn_dot = tk.Label(conn_frame, text="\u25cf", font=("Helvetica", 8), bg=BG, fg=ERROR)
        self.conn_dot.pack(side="left", padx=(16, 4))
        self.conn_label = tk.Label(conn_frame, text="Checking backend...",
                                   font=("Helvetica", 9), bg=BG, fg=TEXT_MUTED)
        self.conn_label.pack(side="left")

        # ttk theme
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TCombobox",
                        fieldbackground=BG_INPUT, background=BG_INPUT,
                        foreground=TEXT, bordercolor=BORDER,
                        arrowcolor=TEXT_DIM, selectbackground=ACCENT,
                        selectforeground="white")
        style.map("TCombobox",
                  fieldbackground=[("readonly", BG_INPUT)],
                  selectbackground=[("readonly", BG_INPUT)],
                  selectforeground=[("readonly", TEXT)])

    def _browse_file(self):
        from tkinter import filedialog
        path = filedialog.askopenfilename(
            title="Select Video File",
            filetypes=[("Video files", "*.mp4 *.mov *.avi *.mkv *.mxf *.m4v"), ("All files", "*.*")]
        )
        if path:
            self.clip_entry.delete(0, tk.END)
            self.clip_entry.insert(0, path)

    def _get_style_value(self):
        display = self.style_combo.get()
        for label, value, _ in STYLES:
            if label == display:
                return value
        return "clean"

    def _get_style_label(self):
        return self.style_combo.get() or "Clean"

    def _on_style_change(self, event=None):
        display = self.style_combo.get()
        for label, _, desc in STYLES:
            if label == display:
                self.style_desc.config(text=desc)
                break

    def _set_status(self, level, message):
        colors = {
            "info": (INFO_BG, INFO_FG),
            "success": (SUCCESS_BG, SUCCESS),
            "error": (ERROR_BG, ERROR),
        }
        bg, fg = colors.get(level, (BG, TEXT_DIM))
        self.status_frame.config(bg=bg)
        self.status_label.config(text=message, bg=bg, fg=fg)
        self.status_frame.pack(fill="x", pady=(8, 0), padx=16)

    def _set_progress(self, pct):
        self.progress_frame.pack(fill="x", pady=(8, 0), padx=16)
        frac = max(0.0, min(1.0, pct / 100.0))
        self.progress_fill.place(x=0, y=0, relheight=1.0, relwidth=frac)

    def _hide_progress(self):
        self.progress_frame.pack_forget()

    def _check_connection(self):
        def check():
            ok = check_backend()
            self.root.after(0, lambda: self._update_connection(ok))
        threading.Thread(target=check, daemon=True).start()

    def _update_connection(self, connected):
        if connected:
            self.conn_dot.config(fg=SUCCESS)
            self.conn_label.config(text="Connected to SmartCut backend")
        else:
            self.conn_dot.config(fg=ERROR)
            self.conn_label.config(text="Open SmartCut app to connect")

    def _periodic_connection_check(self):
        self._check_connection()
        self.root.after(10000, self._periodic_connection_check)

    def _on_process(self):
        if self._processing:
            return

        clip_path = self.clip_entry.get().strip()
        if not clip_path:
            self._set_status("error", "Enter a video file path or click Browse.")
            return
        if not os.path.isfile(clip_path):
            self._set_status("error", "File not found: {}".format(os.path.basename(clip_path)))
            return

        if not check_backend():
            self._set_status("error", "Backend offline — start the SmartCut app first.")
            return

        self._processing = True
        self._clip_path = clip_path
        self.process_btn.config(state="disabled", text="Processing...", bg=ACCENT_DIM)
        self.import_btn.pack_forget()
        self._set_progress(5)
        self._set_status("info", "Starting analysis...")

        style_value = self._get_style_value()
        model = self.model_var.get()

        def start():
            url = "/analyze?video_path={}&style={}&whisper_model={}".format(
                urllib.parse.quote(clip_path, safe=''), style_value, model)
            data = call_backend(url, timeout=15)
            if data and data.get("error"):
                self.root.after(0, lambda: self._on_error(data["error"]))
            elif data is None:
                self.root.after(0, lambda: self._on_error("Could not reach backend"))
            else:
                self.root.after(0, self._poll_status)

        threading.Thread(target=start, daemon=True).start()

    def _poll_status(self):
        def poll():
            data = call_backend("/job-status", timeout=5)
            self.root.after(0, lambda: self._handle_status(data))
        threading.Thread(target=poll, daemon=True).start()

    def _handle_status(self, data):
        if not data:
            self._set_status("info", "Reconnecting...")
            self.root.after(3000, self._poll_status)
            return

        pct = data.get("progress", 0)
        msg = data.get("message", "")
        status = data.get("status", "")

        self._set_progress(pct)
        if msg:
            self._set_status("info", msg)

        if status == "done":
            self._on_done(data)
        elif status == "error":
            self._on_error(data.get("error", "Analysis failed"))
        else:
            self.root.after(2000, self._poll_status)

    def _on_done(self, job_data):
        self._set_progress(90)
        self._set_status("info", "Exporting timeline...")
        cuts = job_data.get("segments_count", 0)
        style_label = self._get_style_label()

        def do_export():
            xml_data = call_backend("/export-xml", timeout=30)
            if not xml_data or xml_data.get("error"):
                err = (xml_data or {}).get("error", "Export failed")
                self.root.after(0, lambda: self._on_error(err))
                return

            xml_path = xml_data.get("xml_path", "")
            srt_path = xml_data.get("srt_path", "")
            clip_name = os.path.splitext(os.path.basename(self._clip_path))[0]

            # Write Lua import script
            write_import_script(xml_path, srt_path, clip_name, style_label)

            def finish():
                self._set_progress(100)
                final = "Done! {} cuts".format(cuts)
                if srt_path:
                    final += " + subtitles"
                final += ". ({})".format(style_label)
                self._set_status("success", final)
                self._reset()

                # Show import button
                self.import_btn.pack(fill="x", pady=(8, 0), padx=16)

            self.root.after(0, finish)

        threading.Thread(target=do_export, daemon=True).start()

    def _show_import_instructions(self):
        """Show instructions for importing into Resolve."""
        from tkinter import messagebox
        messagebox.showinfo(
            "Import into Resolve",
            "In DaVinci Resolve:\n\n"
            "Workspace → Scripts → Edit → video_editor_import\n\n"
            "This will create the edited timeline with cuts"
            " and subtitles in your Media Pool."
        )

    def _on_error(self, msg):
        self._set_status("error", str(msg))
        self._reset()

    def _reset(self):
        self._processing = False
        self.process_btn.config(state="normal", text="Process Video", bg=ACCENT)
        self.root.after(5000, self._hide_progress)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    app = VideoEditorResolveUI()
    app.run()
