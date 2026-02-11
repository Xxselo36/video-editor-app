#!/bin/bash
# ============================================================
#  Video Editor - Launcher
#  Doppelklick zum Starten der GUI
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Virtuelle Umgebung aktivieren
if [ ! -d "$SCRIPT_DIR/venv" ]; then
    echo "Fehler: Bitte zuerst Install.command ausfuehren!"
    read -p "Druecke Enter zum Schliessen..."
    exit 1
fi

source "$SCRIPT_DIR/venv/bin/activate"

# GUI starten
python3 "$SCRIPT_DIR/gui.py"
