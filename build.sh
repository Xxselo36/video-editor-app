#!/bin/bash
set -e

# ============================================================================
# SmartCut - macOS App Bundle Build Script
# Nuitka + Code Signing + DMG + Notarization
# ============================================================================

# --- Konfiguration ---
APP_NAME="SmartCut"
BUNDLE_ID="com.videoeditor.app"
ICON_FILE="icon.icns"                          # Optional: App Icon
ENTITLEMENTS="entitlements.plist"
DIST_DIR="dist"
PKG_NAME="${APP_NAME}.pkg"
INSTALLER_IDENTITY="${INSTALLER_IDENTITY:-Developer ID Installer: Selim Alcibuga (2DW47P33R8)}"
VENV_PYTHON="$(cd "$(dirname "$0")" && pwd)/venv313/bin/python"

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

    [ -x "$VENV_PYTHON" ] || error "venv313 nicht gefunden. Erstelle mit: python3.13 -m venv venv313"
    "$VENV_PYTHON" -c "import nuitka" 2>/dev/null || error "Nuitka nicht installiert. Installiere mit: venv313/bin/pip install -r build-requirements.txt"

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
    FFPROBE_PATH=$("$VENV_PYTHON" -c "
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
# [1/6] Clean
# ============================================================================
step_clean() {
    info "[1/6] Bereinige vorherige Builds..."
    # Code-signed files are read-only, fix permissions before removing
    chmod -R u+rwx "${DIST_DIR}" 2>/dev/null || true
    rm -rf gui.build gui.dist gui.onefile-build "${DIST_DIR}"
    mkdir -p "${DIST_DIR}"
    ok "Bereinigt"
}

# ============================================================================
# [2/6] Nuitka Build
# ============================================================================
step_build() {
    info "[2/6] Starte Nuitka Build..."

    # Nuitka Icon-Flag nur setzen wenn Icon vorhanden
    ICON_FLAG=""
    if [ -f "$ICON_FILE" ]; then
        ICON_FLAG="--macos-app-icon=$ICON_FILE"
    else
        warn "Kein Icon gefunden ($ICON_FILE) - verwende Standard-Icon"
    fi

    "$VENV_PYTHON" -m nuitka \
        --assume-yes-for-downloads \
        --standalone \
        --macos-create-app-bundle \
        --macos-app-name="${APP_NAME}" \
        ${ICON_FLAG} \
        --macos-signed-app-name="${BUNDLE_ID}" \
        --enable-plugin=tk-inter \
        --include-package=customtkinter \
        --include-package=whisper \
        --include-package=moviepy \
        --include-package=cv2 \
        --include-package=scipy \
        --include-package=imageio_ffmpeg \
        --include-package=src \
        --include-package-data=whisper \
        --include-data-files=yolov8n.pt=yolov8n.pt \
        --include-data-files=logo.png=logo.png \
        --include-data-files=bin/ffprobe=ffprobe \
        --include-data-dir=src=src \
        --include-data-dir=plugins=plugins \
        --include-data-files=plugins/premiere/video_editor_premiere.py=plugins/premiere/video_editor_premiere.py \
        --nofollow-import-to=diffusers \
        --nofollow-import-to=accelerate \
        --nofollow-import-to=transformers \
        --nofollow-import-to=matplotlib \
        --nofollow-import-to=pytest \
        --nofollow-import-to=IPython \
        --nofollow-import-to=notebook \
        --nofollow-import-to=jupyter \
        --nofollow-import-to=torch \
        --nofollow-import-to=sympy \
        --output-dir="${DIST_DIR}" \
        gui.py

    APP_PATH="${DIST_DIR}/gui.app"

    # Umbenennen von gui.app -> SmartCut.app
    if [ -d "$APP_PATH" ]; then
        rm -rf "${DIST_DIR}/${APP_NAME}.app" 2>/dev/null || true
        mv "$APP_PATH" "${DIST_DIR}/${APP_NAME}.app"
        APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    fi

    # Verschachtelte gui.app entfernen (Nuitka-Artefakt)
    rm -rf "$APP_PATH/gui.app" 2>/dev/null || true

    if [ ! -d "$APP_PATH" ]; then
        error "Build fehlgeschlagen - .app nicht gefunden"
    fi

    ok "Build erfolgreich: $APP_PATH"
}

# ============================================================================
# [3/6] Torch als Raw-Python in App Bundle kopieren
# ============================================================================
step_copy_torch() {
    APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    MACOS_DIR="$APP_PATH/Contents/MacOS"
    TORCH_SRC="$(cd "$(dirname "$0")" && pwd)/venv313/lib/python3.13/site-packages/torch"
    TORCH_DST="$MACOS_DIR/torch"

    info "[3/6] Kopiere torch in App Bundle (Hybrid-Ansatz)..."

    if [ ! -d "$TORCH_SRC" ]; then
        error "torch nicht gefunden in: $TORCH_SRC"
    fi

    # 1. Torch + torchgen komplett kopieren (inkl. aller venv-Patches)
    info "  Kopiere torch + torchgen aus venv313..."
    cp -R "$TORCH_SRC" "$TORCH_DST"

    # torchgen ist ein separates Package, das torch braucht
    TORCHGEN_SRC="$(dirname "$TORCH_SRC")/torchgen"
    if [ -d "$TORCHGEN_SRC" ]; then
        cp -R "$TORCHGEN_SRC" "$MACOS_DIR/torchgen"
        info "  torchgen mitkopiert"
    fi

    # 2. Unnoetige Dateien entfernen
    info "  Bereinige unnoetige Dateien..."
    rm -rf "$TORCH_DST/include"              2>/dev/null || true  # 61 MB C++ Headers
    rm -rf "$TORCH_DST/distributed"          2>/dev/null || true  # 11 MB (Patches fangen ImportError ab)
    rm -rf "$TORCH_DST/share"                2>/dev/null || true  # Build-Artefakte
    rm -rf "$TORCH_DST/csrc"                 2>/dev/null || true  # Build-Artefakte
    rm -f  "$TORCH_DST/bin/protoc"*          2>/dev/null || true  # 8 MB protobuf compiler
    find "$TORCH_DST" -name "*.pyi" -delete  2>/dev/null || true  # 3 MB Type Stubs
    find "$TORCH_DST" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

    TORCH_SIZE=$(du -sh "$TORCH_DST" | cut -f1)
    info "  torch Groesse nach Bereinigung: $TORCH_SIZE"

    # 3. Patch torch/__init__.py fuer Nuitka standalone
    info "  Patching torch/__init__.py fuer Nuitka standalone..."
    "$VENV_PYTHON" - "$TORCH_DST/__init__.py" << 'PYEOF'
import sys, re

torch_init = sys.argv[1]
with open(torch_init, 'r') as f:
    content = f.read()

patches = []

# --- Patch 1: Insert _TorchParentFixer meta-path hook ---
# Insert after the "from typing_extensions import ..." line
META_HOOK = '''

# --- Nuitka standalone fix: prevent "partially initialized module" errors ---
# Wraps torch submodule loaders to: (1) set parent attributes before exec_module,
# (2) inject __getattr__ into packages for lazy submodule resolution.
class _EarlyAttrLoader:
    __slots__ = ('_inner', '_name')
    def __init__(self, inner, name):
        self._inner = inner
        self._name = name
    def create_module(self, spec):
        return self._inner.create_module(spec) if hasattr(self._inner, 'create_module') else None
    def exec_module(self, module):
        parts = self._name.rsplit('.', 1)
        if len(parts) == 2:
            _p = sys.modules.get(parts[0])
            if _p is not None:
                setattr(_p, parts[1], module)
        if hasattr(module, '__path__') and '__getattr__' not in module.__dict__:
            def _lazy_getattr(name, _pkg=module.__name__):
                try:
                    return importlib.import_module(f".{name}", _pkg)
                except ImportError:
                    raise AttributeError(f"module '{_pkg}' has no attribute {name!r}")
            module.__dict__['__getattr__'] = _lazy_getattr
        self._inner.exec_module(module)
    def __getattr__(self, name):
        return getattr(self._inner, name)

class _TorchParentFixer:
    _active = set()
    @classmethod
    def find_spec(cls, name, path=None, target=None):
        if not name.startswith('torch.') or name in cls._active:
            return None
        cls._active.add(name)
        try:
            for finder in sys.meta_path:
                if finder is cls:
                    continue
                _fs = getattr(finder, 'find_spec', None)
                if _fs is None:
                    continue
                try:
                    spec = _fs(name, path, target)
                except Exception:
                    continue
                if spec is not None and spec.loader is not None:
                    spec.loader = _EarlyAttrLoader(spec.loader, name)
                    return spec
        finally:
            cls._active.discard(name)
        return None

sys.meta_path.insert(0, _TorchParentFixer)
# --- End Nuitka fix ---
'''

marker = 'from typing_extensions import'
idx = content.find(marker)
if idx >= 0:
    eol = content.index('\n', idx)
    content = content[:eol+1] + META_HOOK + content[eol+1:]
    patches.append('meta-hook')

# --- Patch 2: Early __getattr__ with distributed stub ---
# Insert before the "import torch.nn  # Nuitka:" line
EARLY_GETATTR = '''
# Early __getattr__: lazy submodule loading + distributed stub for Nuitka standalone
def __getattr__(name):
    if name == 'distributed':
        import types, sys as _s
        _stub = types.ModuleType('torch.distributed')
        _stub.is_available = lambda: False
        _stub.is_initialized = lambda: False
        _rpc = types.ModuleType('torch.distributed.rpc')
        _rpc.is_available = lambda: False
        _stub.rpc = _rpc
        _nn = types.ModuleType('torch.distributed.nn')
        _stub.nn = _nn
        _s.modules['torch.distributed'] = _stub
        _s.modules['torch.distributed.rpc'] = _rpc
        _s.modules['torch.distributed.nn'] = _nn
        globals()['distributed'] = _stub
        return _stub
    try:
        return importlib.import_module(f".{name}", __name__)
    except ImportError:
        raise AttributeError(f"module \\'{__name__}\\' has no attribute {name!r}")

'''

m = re.search(r'^import torch\.nn\b.*# Nuitka:', content, re.MULTILINE)
if m:
    content = content[:m.start()] + EARLY_GETATTR + content[m.start():]
    patches.append('early-getattr')

# --- Patch 3: Replace late __getattr__ _lazy_modules with try/except ---
old_lazy = '        # Lazy modules\n        if name in _lazy_modules:\n            return importlib.import_module(f".{name}", __name__)'
new_lazy = '        # Try to import as submodule (Nuitka standalone)\n        try:\n            return importlib.import_module(f".{name}", __name__)\n        except ImportError:\n            pass'
if old_lazy in content:
    content = content.replace(old_lazy, new_lazy)
    patches.append('late-getattr')

with open(torch_init, 'w') as f:
    f.write(content)

print(f"Patches applied: {', '.join(patches) if patches else 'NONE (WARNING!)'}")
if not patches:
    sys.exit(1)
PYEOF

    # 4. Pre-compile .py -> .pyc (schnellerer Start)
    info "  Pre-compile .py -> .pyc..."
    "$VENV_PYTHON" -m compileall -b -q "$TORCH_DST" 2>/dev/null || true

    # 5. Kritische Dateien verifizieren
    info "  Verifiziere kritische Dateien..."
    local MISSING=0
    for f in \
        "$TORCH_DST/__init__.py" \
        "$TORCH_DST/_C.cpython-313-darwin.so" \
        "$TORCH_DST/lib/libtorch_cpu.dylib" \
        "$TORCH_DST/nn/__init__.py" \
    ; do
        if [ ! -f "$f" ]; then
            error "Kritische Datei fehlt: $f"
            MISSING=1
        fi
    done

    # Verifiziere dylibs vorhanden
    local DYLIB_COUNT
    DYLIB_COUNT=$(find "$TORCH_DST/lib" -name "*.dylib" | wc -l | tr -d ' ')
    if [ "$DYLIB_COUNT" -lt 5 ]; then
        error "Nur $DYLIB_COUNT dylibs in torch/lib/ gefunden (erwartet >= 5)"
    fi

    if [ "$MISSING" -eq 1 ]; then
        error "Kritische torch-Dateien fehlen - Abbruch"
    fi

    ok "torch kopiert und verifiziert ($TORCH_SIZE, $DYLIB_COUNT dylibs)"
}

# ============================================================================
# [4/6] Code Signing
# ============================================================================
step_sign() {
    APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    info "[4/6] Code Signing (bottom-up)..."

    if [[ "$SIGNING_IDENTITY" == *"DEIN NAME"* ]]; then
        warn "Keine Signing Identity konfiguriert - ueberspringe Signing"
        warn "Setze SIGNING_IDENTITY Umgebungsvariable oder editiere build.sh"
        return 0
    fi

    # 1. Permissions fixen und Extended Attributes entfernen (macOS 26 Requirement)
    info "  Setze Permissions und entferne extended attributes..."
    chmod -R u+rw "$APP_PATH"
    xattr -cr "$APP_PATH"

    # 2. Ad-hoc sign: ALLE Dateien in Contents/ (macOS 26 verlangt das)
    info "  Ad-hoc Signierung fuer alle Dateien..."
    find "$APP_PATH/Contents" -type f | while read f; do
        codesign --force --sign - "$f" 2>/dev/null || true
    done

    # 3. Developer ID sign: ALLE Mach-O Dateien (.so, .dylib, Binaries ohne Extension)
    info "  Signiere alle Mach-O Dateien mit Developer ID..."
    find "$APP_PATH/Contents" -type f | while read f; do
        if file "$f" | grep -q "Mach-O"; then
            codesign --force --timestamp --options runtime \
                --entitlements "$ENTITLEMENTS" \
                --sign "$SIGNING_IDENTITY" \
                "$f" 2>/dev/null || true
        fi
    done

    # 5. Developer ID sign: Gesamtes Bundle
    info "  Signiere .app Bundle..."
    codesign --force --timestamp --options runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$SIGNING_IDENTITY" \
        "$APP_PATH"

    # 6. Verifizieren
    codesign --verify --verbose "$APP_PATH"
    ok "Code Signing erfolgreich"
}

# ============================================================================
# [5/6] PKG erstellen
# ============================================================================
step_pkg() {
    APP_PATH="${DIST_DIR}/${APP_NAME}.app"
    PKG_PATH="${DIST_DIR}/${PKG_NAME}"
    info "[5/6] Erstelle PKG Installer..."

    # Temporaeres Root-Verzeichnis fuer pkgbuild
    PKG_ROOT="${DIST_DIR}/pkg_root"
    rm -rf "$PKG_ROOT"
    mkdir -p "$PKG_ROOT/Applications"
    cp -R "$APP_PATH" "$PKG_ROOT/Applications/"

    # Component PKG erstellen
    pkgbuild \
        --root "$PKG_ROOT" \
        --identifier "$BUNDLE_ID" \
        --version "1.0" \
        --install-location "/" \
        "${DIST_DIR}/${APP_NAME}-component.pkg"

    # Distribution XML erstellen (deaktiviert Bundle Relocation)
    DIST_XML="${DIST_DIR}/distribution.xml"
    cat > "$DIST_XML" << 'DISTEOF'
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <pkg-ref id="com.videoeditor.app">
        <bundle-version>
            <bundle CFBundleShortVersionString="1.0" id="com.videoeditor.app" path="Applications/SmartCut.app"/>
        </bundle-version>
    </pkg-ref>
    <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <choices-outline>
        <line choice="default">
            <line choice="com.videoeditor.app"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="com.videoeditor.app" visible="false">
        <pkg-ref id="com.videoeditor.app"/>
    </choice>
    <pkg-ref id="com.videoeditor.app" version="1.0" onConclusion="none">#SmartCut-component.pkg</pkg-ref>
</installer-gui-script>
DISTEOF

    # Installer PKG mit Distribution XML und Signing erstellen
    if [[ "$INSTALLER_IDENTITY" != *"DEIN NAME"* ]]; then
        productbuild \
            --distribution "$DIST_XML" \
            --package-path "${DIST_DIR}" \
            --sign "$INSTALLER_IDENTITY" \
            "$PKG_PATH"
    else
        productbuild \
            --distribution "$DIST_XML" \
            --package-path "${DIST_DIR}" \
            "$PKG_PATH"
        warn "PKG nicht signiert (keine Installer Identity)"
    fi

    rm -f "$DIST_XML"

    # Aufraeumen
    rm -f "${DIST_DIR}/${APP_NAME}-component.pkg"
    rm -rf "$PKG_ROOT"

    PKG_SIZE=$(du -h "$PKG_PATH" | cut -f1)
    ok "PKG erstellt: $PKG_PATH ($PKG_SIZE)"
}

# ============================================================================
# [6/6] Notarisierung
# ============================================================================
step_notarize() {
    PKG_PATH="${DIST_DIR}/${PKG_NAME}"
    info "[6/6] Notarisierung..."

    if [[ "$SIGNING_IDENTITY" == *"DEIN NAME"* ]]; then
        warn "Keine Signing Identity - ueberspringe Notarisierung"
        return 0
    fi

    # Notarisierung einreichen
    info "  Reiche bei Apple ein (kann einige Minuten dauern)..."
    xcrun notarytool submit "$PKG_PATH" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait

    # Staple
    info "  Staple Notarisierung..."
    xcrun stapler staple "$PKG_PATH"

    ok "Notarisierung erfolgreich!"
}

# ============================================================================
# Hauptprogramm
# ============================================================================
main() {
    echo ""
    echo "============================================"
    echo "  SmartCut - macOS App Bundle Build"
    echo "============================================"
    echo ""

    check_prerequisites
    ensure_ffprobe

    SECONDS=0

    step_clean
    step_build
    step_copy_torch

    # Create ffmpeg symlink so whisper and other libs can find it via PATH
    info "Creating ffmpeg symlink in bundle..."
    FFMPEG_BIN=$(find "${DIST_DIR}/${APP_NAME}.app/Contents/MacOS/imageio_ffmpeg/binaries" -name "ffmpeg-*" -type f 2>/dev/null | head -1)
    if [ -n "$FFMPEG_BIN" ]; then
        ln -sf "$(basename "$FFMPEG_BIN")" "$(dirname "$FFMPEG_BIN")/ffmpeg"
        info "  Symlink: ffmpeg -> $(basename "$FFMPEG_BIN")"
    fi

    step_sign
    step_pkg
    step_notarize

    ELAPSED=$SECONDS
    MINUTES=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))

    echo ""
    echo "============================================"
    ok "Build komplett in ${MINUTES}m ${SECS}s"
    echo ""
    echo "  App:  ${DIST_DIR}/${APP_NAME}.app"
    echo "  PKG:  ${DIST_DIR}/${PKG_NAME}"
    echo "============================================"
}

# Erlaube einzelne Schritte: ./build.sh [clean|build|sign|dmg|notarize]
case "${1:-}" in
    clean)       step_clean ;;
    build)       check_prerequisites && ensure_ffprobe && step_build ;;
    copy_torch)  step_copy_torch ;;
    sign)        step_sign ;;
    pkg)         step_pkg ;;
    notarize)    step_notarize ;;
    *)           main ;;
esac
