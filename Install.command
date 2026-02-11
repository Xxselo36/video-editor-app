#!/bin/bash
# ============================================================
#  Video Editor - Installer
#  Doppelklick zum Installieren aller Abhaengigkeiten
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "============================================"
echo "  VIDEO EDITOR - Installation"
echo "============================================"
echo ""

# -----------------------------------------------------------
# 1. Homebrew
# -----------------------------------------------------------
if ! command -v brew &>/dev/null; then
    echo "[1/5] Installiere Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Shell-Path fuer Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    echo "[1/5] Homebrew bereits installiert."
fi

# -----------------------------------------------------------
# 2. Python 3 (Homebrew) + Tkinter
# -----------------------------------------------------------
if brew list python@3.14 &>/dev/null; then
    echo "[2/5] Python 3 (Homebrew) bereits installiert."
else
    echo "[2/5] Installiere Python 3 (Homebrew)..."
    brew install python@3.14
fi

if brew list python-tk@3.14 &>/dev/null; then
    echo "       Tkinter bereits installiert."
else
    echo "       Installiere Tkinter..."
    brew install python-tk@3.14
fi

# Homebrew Python bevorzugen
BREW_PYTHON="$(brew --prefix python@3.14)/bin/python3.14"
if [ ! -f "$BREW_PYTHON" ]; then
    BREW_PYTHON="$(brew --prefix)/bin/python3"
fi
echo "       Verwende: $BREW_PYTHON ($($BREW_PYTHON --version))"

# -----------------------------------------------------------
# 3. FFmpeg
# -----------------------------------------------------------
if ! command -v ffmpeg &>/dev/null; then
    echo "[3/5] Installiere FFmpeg..."
    brew install ffmpeg
else
    echo "[3/5] FFmpeg bereits installiert."
fi

# -----------------------------------------------------------
# 4. Python Virtual Environment + Pakete
# -----------------------------------------------------------
echo "[4/5] Erstelle virtuelle Umgebung und installiere Pakete..."

if [ ! -d "$SCRIPT_DIR/venv" ]; then
    "$BREW_PYTHON" -m venv "$SCRIPT_DIR/venv"
fi

source "$SCRIPT_DIR/venv/bin/activate"

pip install --upgrade pip --quiet
pip install -r "$SCRIPT_DIR/requirements.txt" --quiet

echo "  Pakete installiert."

# -----------------------------------------------------------
# 5. Whisper-Modell vorladen (small)
# -----------------------------------------------------------
echo "[5/5] Lade Whisper-Modell (small) vor..."
python3 -c "import whisper; whisper.load_model('small')" 2>/dev/null || true
echo "  Modell geladen."

# -----------------------------------------------------------
# Fertig
# -----------------------------------------------------------
echo ""
echo "============================================"
echo "  Installation abgeschlossen!"
echo ""
echo "  Starte den Editor mit:"
echo "  Doppelklick auf VideoEditor.command"
echo "============================================"
echo ""
read -p "Druecke Enter zum Schliessen..."
