#!/bin/bash
set -e

# ============================================================================
# Video Editor - macOS App Bundle Build Script
# Nuitka + Code Signing + DMG + Notarization
# ============================================================================

# --- Konfiguration ---
APP_NAME="VideoEditor"
BUNDLE_ID="com.videoeditor.app"
ICON_FILE="icon.icns"                          # Optional: App Icon
ENTITLEMENTS="entitlements.plist"
DIST_DIR="dist"
DMG_NAME="${APP_NAME}.dmg"

# Code Signing Identity (aendern!)
# Finde deine Identity mit: security find-identity -v -p codesigning
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Developer ID Application: Selim Alcibuga (2DW47P33R8)}"

# Notarization Credentials (gespeichert mit: xcrun notarytool store-credentials "VideoEditor")
NOTARY_PROFILE="${NOTARY_PROFILE:-VideoEditor}"

# --- Farben ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Voraussetzungen pruefen ---
check_prerequisites() {
    info "Pruefe Voraussetzungen..."

    command -v python3 >/dev/null 2>&1 || error "python3 nicht gefunden"
    python3 -c "import nuitka" 2>/dev/null || error "Nuitka nicht installiert. Installiere mit: pip install -r build-requirements.txt"

    if [ ! -f "gui.py" ]; then
        error "gui.py nicht gefunden. Bitte im Projektverzeichnis ausfuehren."
    fi

    if [ ! -f "$ENTITLEMENTS" ]; then
        error "entitlements.plist nicht gefunden."
    fi

    ok "Voraussetzungen erfuellt"
}

# --- ffprobe Binary besorgen ---
ensure_ffprobe() {
    if [ -f "bin/ffprobe" ]; then
        ok "ffprobe Binary vorhanden"
        return
    fi

    info "Lade ffprobe Binary herunter..."

    # Versuche ffprobe aus imageio_ffmpeg zu extrahieren
    FFPROBE_PATH=$(python3 -c "
import shutil, os
# Versuche System-ffprobe
p = shutil.which('ffprobe')
if p:
    print(p)
else:
    print('')
" 2>/dev/null)

    if [ -n "$FFPROBE_PATH" ] && [ -f "$FFPROBE_PATH" ]; then
        cp "$FFPROBE_PATH" bin/ffprobe
        chmod +x bin/ffprobe
        ok "ffprobe kopiert von: $FFPROBE_PATH"
    else
        warn "ffprobe nicht gefunden!"
        warn "Bitte manuell in bin/ffprobe platzieren."
        warn "Download: https://evermeet.cx/ffmpeg/ (statische macOS Builds)"
        warn "Oder: brew install ffmpeg && cp \$(which ffprobe) bin/ffprobe"
        return 1
    fi
}

# ============================================================================
# [1/5] Clean
# ============================================================================
step_clean() {
    info "[1/5] Bereinige vorherige Builds..."
    rm -rf gui.build gui.dist gui.onefile-build "${DIST_DIR}"
    mkdir -p "${DIST_DIR}"
    ok "Bereinigt"
}

# ============================================================================
# [2/5] Nuitka Build
# ============================================================================
step_build() {
    info "[2/5] Starte Nuitka Build (das dauert 20-30 Minuten)..."

    # Nuitka Icon-Flag nur setzen wenn Icon vorhanden
    ICON_FLAG=""
    if [ -f "$ICON_FILE" ]; then
        ICON_FLAG="--macos-app-icon=$ICON_FILE"
    else
        warn "Kein Icon gefunden ($ICON_FILE) - verwende Standard-Icon"
    fi

    python3 -m nuitka \
        --standalone \
        --macos-create-app-bundle \
        --macos-app-name="${APP_NAME}" \
        ${ICON_FLAG} \
        --macos-signed-app-name="${BUNDLE_ID}" \
        --enable-plugin=tk-inter \
        --include-package=customtkinter \
        --include-package=whisper \
        --include-package=torch \
        --include-package=moviepy \
        --include-package=cv2 \
        --include-package=scipy \
        --include-package=imageio_ffmpeg \
        --include-package=src \
        --include-data-files=yolov8n.pt=yolov8n.pt \
        --include-data-files=bin/ffprobe=ffprobe \
        --include-data-dir=src=src \
        --nofollow-import-to=diffusers \
        --nofollow-import-to=accelerate \
        --nofollow-import-to=transformers \
        --nofollow-import-to=matplotlib \
        --nofollow-import-to=pytest \
        --nofollow-import-to=IPython \
        --nofollow-import-to=notebook \
        --nofollow-import-to=jupyter \
        --nofollow-import-to=torch._dynamo \
        --nofollow-import-to=torch._inductor \
        --nofollow-import-to=torch._functorch \
        --nofollow-import-to=torch.distributed \
        --nofollow-import-to=torch.testing \
        --nofollow-import-to=torch.utils.benchmark \
        --output-dir="${DIST_DIR}" \
        gui.py

    APP_PATH="${DIST_DIR}/gui.app"

    # Umbenennen von gui.app -> VideoEditor.app
    if [ -d "$APP_PATH" ]; then
        mv "$APP_PATH" "${DIST_DIR}/${APP_NAME}.app"
        APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    fi

    if [ ! -d "$APP_PATH" ]; then
        error "Build fehlgeschlagen - .app nicht gefunden"
    fi

    ok "Build erfolgreich: $APP_PATH"
}

# ============================================================================
# [3/5] Code Signing
# ============================================================================
step_sign() {
    APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    info "[3/5] Code Signing..."

    if [[ "$SIGNING_IDENTITY" == *"DEIN NAME"* ]]; then
        warn "Keine Signing Identity konfiguriert - ueberspringe Signing"
        warn "Setze SIGNING_IDENTITY Umgebungsvariable oder editiere build.sh"
        return 0
    fi

    # Alle .so und .dylib Dateien einzeln signieren
    info "  Signiere eingebettete Bibliotheken..."
    find "$APP_PATH" -type f \( -name "*.so" -o -name "*.dylib" \) | while read lib; do
        codesign --force --timestamp --options runtime \
            --entitlements "$ENTITLEMENTS" \
            --sign "$SIGNING_IDENTITY" \
            "$lib" 2>/dev/null || true
    done

    # Alle ausfuehrbaren Binaries signieren
    info "  Signiere ausfuehrbare Dateien..."
    find "$APP_PATH/Contents/MacOS" -type f -perm +111 | while read bin; do
        codesign --force --timestamp --options runtime \
            --entitlements "$ENTITLEMENTS" \
            --sign "$SIGNING_IDENTITY" \
            "$bin" 2>/dev/null || true
    done

    # ffprobe signieren
    if [ -f "$APP_PATH/Contents/MacOS/ffprobe" ]; then
        codesign --force --timestamp --options runtime \
            --entitlements "$ENTITLEMENTS" \
            --sign "$SIGNING_IDENTITY" \
            "$APP_PATH/Contents/MacOS/ffprobe"
    fi

    # Gesamte .app signieren
    info "  Signiere .app Bundle..."
    codesign --force --deep --timestamp --options runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$SIGNING_IDENTITY" \
        "$APP_PATH"

    # Verifizieren
    codesign --verify --verbose "$APP_PATH"
    ok "Code Signing erfolgreich"
}

# ============================================================================
# [4/5] DMG erstellen
# ============================================================================
step_dmg() {
    APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    DMG_PATH="${DIST_DIR}/${DMG_NAME}"
    info "[4/5] Erstelle DMG..."

    # Temporaeres Verzeichnis fuer DMG-Inhalt
    DMG_TEMP="${DIST_DIR}/dmg_temp"
    rm -rf "$DMG_TEMP"
    mkdir -p "$DMG_TEMP"

    # App kopieren
    cp -R "$APP_PATH" "$DMG_TEMP/"

    # Applications Symlink
    ln -s /Applications "$DMG_TEMP/Applications"

    # DMG erstellen
    hdiutil create -volname "$APP_NAME" \
        -srcfolder "$DMG_TEMP" \
        -ov -format UDZO \
        "$DMG_PATH"

    rm -rf "$DMG_TEMP"

    # DMG signieren
    if [[ "$SIGNING_IDENTITY" != *"DEIN NAME"* ]]; then
        codesign --force --timestamp \
            --sign "$SIGNING_IDENTITY" \
            "$DMG_PATH"
        ok "DMG signiert"
    fi

    DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
    ok "DMG erstellt: $DMG_PATH ($DMG_SIZE)"
}

# ============================================================================
# [5/5] Notarisierung
# ============================================================================
step_notarize() {
    DMG_PATH="${DIST_DIR}/${DMG_NAME}"
    info "[5/5] Notarisierung..."

    if [[ "$SIGNING_IDENTITY" == *"DEIN NAME"* ]]; then
        warn "Keine Signing Identity - ueberspringe Notarisierung"
        return 0
    fi

    # Notarisierung einreichen
    info "  Reiche bei Apple ein (kann einige Minuten dauern)..."
    xcrun notarytool submit "$DMG_PATH" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait

    # Staple
    info "  Staple Notarisierung..."
    xcrun stapler staple "$DMG_PATH"

    ok "Notarisierung erfolgreich!"
}

# ============================================================================
# Hauptprogramm
# ============================================================================
main() {
    echo ""
    echo "============================================"
    echo "  Video Editor - macOS App Bundle Build"
    echo "============================================"
    echo ""

    check_prerequisites
    ensure_ffprobe

    SECONDS=0

    step_clean
    step_build
    step_sign
    step_dmg
    step_notarize

    ELAPSED=$SECONDS
    MINUTES=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))

    echo ""
    echo "============================================"
    ok "Build komplett in ${MINUTES}m ${SECS}s"
    echo ""
    echo "  App:  ${DIST_DIR}/${APP_NAME}.app"
    echo "  DMG:  ${DIST_DIR}/${DMG_NAME}"
    echo "============================================"
}

# Erlaube einzelne Schritte: ./build.sh [clean|build|sign|dmg|notarize]
case "${1:-}" in
    clean)     step_clean ;;
    build)     check_prerequisites && ensure_ffprobe && step_build ;;
    sign)      step_sign ;;
    dmg)       step_dmg ;;
    notarize)  step_notarize ;;
    *)         main ;;
esac
