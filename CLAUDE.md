# SmartCut — Project Context

## What is this?
SmartCut is an AI-powered video editing app. It automatically detects silences, transcribes speech (via Whisper), and cuts videos into clean edits with optional subtitles. It runs as:
1. **Standalone desktop app** (`gui.py`) — CustomTkinter GUI
2. **Premiere Pro plugin** — CEP panel + HTTP backend (port 8456)
3. **DaVinci Resolve plugin** — Lua script + HTTP backend

## Architecture

### Core files
- `gui.py` — Main GUI app (CustomTkinter). Entry point for standalone mode.
- `src/fast_editor.py` — Video processing engine (silence detection, cutting, subtitle rendering)
- `src/styles.py` — Style presets (Clean, Fast, Balanced, Smooth, Minimal)
- `src/editor.py` — VideoEditor class, orchestrates the pipeline
- `src/plugin_api.py` — Shared plugin API for video analysis
- `APP_VERSION` in `gui.py` — Current app version string

### Plugins
- `plugins/premiere/video_editor_premiere.py` — HTTP server for Premiere Pro (port 8456)
- `plugins/premiere/panel/` — CEP panel (HTML/JS/ExtendScript)
- `plugins/davinci/smartcut.lua` — DaVinci Resolve script (Lua, uses curl to talk to backend)
- `plugins/davinci/render_srt_overlay.py` — Renders SRT subtitles as video overlay for Resolve

### Build system
- `build.sh` — macOS build: Nuitka + code signing + PKG + notarization
- `.github/workflows/build.yml` — Windows (NSIS .exe) + Linux (AppImage) builds via GitHub Actions
- **Hybrid torch approach**: torch is excluded from Nuitka (`--nofollow-import-to=torch`) and copied as raw Python into the app bundle post-build
- Nuitka excludes: torch, sympy, diffusers, accelerate, transformers, matplotlib, pytest, IPython, notebook, jupyter

### Licensing
- Lemon Squeezy license validation
- License check runs before app UI loads
- App-specific password for Apple notarization stored in Keychain as profile "VideoEditor"

## Key technical details

### Progress callback signature
`self.progress_callback(message, step, total_steps, progress)`

### Output directory
`~/Movies/Videos/` (all platforms)

### Plugin install paths
- **Premiere Pro (macOS):** `~/Library/Application Support/Adobe/CEP/extensions/com.videoeditor.panel/`
- **Premiere Pro (Windows):** `%APPDATA%/Adobe/CEP/extensions/com.videoeditor.panel/`
- **DaVinci Resolve (macOS):** `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/`
- **DaVinci Resolve (Windows):** `%PROGRAMDATA%/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/`

### DaVinci Resolve subtitles
- Subtitle overlay rendered as white-on-black video
- Placed on V2 track with **Screen** composite mode (makes black transparent)
- Overlay files saved to `~/Movies/Videos/` (not /tmp — Resolve needs persistent files)
- Composite mode set via `SetProperty("CompositeMode", 5)` (5 = Screen)

### Windows build
- Built via GitHub Actions (Windows runner)
- Uses NSIS installer (`installer.nsi`)
- Python 3.12 (not 3.13 like macOS)
- Torch copied as hybrid (same approach as macOS)
- CUDA libraries stripped (CPU-only)

### Linux build
- Built via GitHub Actions (Ubuntu 22.04)
- Packaged as AppImage + tar.xz
- CPU-only torch

## Running from source
```bash
# macOS
./venv313/bin/python gui.py

# Windows
python gui.py  # (after pip install -r requirements.txt)
```

## Recent changes (April 2026)
- Fixed plugin window opening multiple times (singleton pattern)
- Fixed Premiere plugin install failing after uninstall
- Fixed DaVinci Resolve subtitles (Screen composite mode, persistent overlay files)
- Renamed output folder from "VideoEditor" to "Videos"
- Fixed PKG bundle relocation (always installs to /Applications/)
- Added `video_editor_premiere.py` to all platform builds
- Added auto-update check (compares APP_VERSION against GitHub latest release tag)

## GitHub
- Repo: `Xxselo36/video-editor-app`
- Release: `v1.0.0` (assets: SmartCut.pkg, SmartCut-Setup.exe, SmartCut-Linux.AppImage)
- Landing page: getsmartcut.app

## Important rules
- Do NOT delete or modify files without understanding their purpose
- The `plugins/` directory structure must stay intact — it gets bundled into the app
- When editing gui.py, keep the THEME dict and style consistent
- Test changes by running from source before committing
- All three platforms (macOS, Windows, Linux) share the same gui.py — platform-specific code uses `sys.platform` checks
