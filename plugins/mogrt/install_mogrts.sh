#!/bin/bash
# install_mogrts.sh
# Copies all .mogrt files from a source directory to
# Adobe's Essential Graphics template folder for Premiere Pro.
#
# Usage:
#   ./install_mogrts.sh /path/to/mogrt/files
#   ./install_mogrts.sh   (defaults to same directory as this script)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="${1:-$SCRIPT_DIR}"

# Premiere Pro Essential Graphics template locations
if [[ "$OSTYPE" == "darwin"* ]]; then
    DEST_DIR="$HOME/Library/Application Support/Adobe/Common/Essential Graphics"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    DEST_DIR="$APPDATA/Adobe/Common/Essential Graphics"
else
    DEST_DIR="$HOME/.adobe/Common/Essential Graphics"
fi

echo "Source: $SOURCE_DIR"
echo "Destination: $DEST_DIR"

# Create destination if it doesn't exist
mkdir -p "$DEST_DIR"

# Copy all .mogrt files
count=0
for mogrt in "$SOURCE_DIR"/*.mogrt; do
    if [ -f "$mogrt" ]; then
        filename=$(basename "$mogrt")
        cp "$mogrt" "$DEST_DIR/$filename"
        echo "  Installed: $filename"
        count=$((count + 1))
    fi
done

if [ $count -eq 0 ]; then
    echo "No .mogrt files found in $SOURCE_DIR"
    exit 1
fi

echo ""
echo "Done! Installed $count MOGRT template(s)."
echo "Restart Premiere Pro, then find them in Essential Graphics > Browse."
