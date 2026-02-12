; Video Editor - Windows NSIS Installer Script
; Erstellt einen Setup-Installer fuer VideoEditor

!include "MUI2.nsh"

; --- Allgemein ---
Name "Video Editor"
OutFile "VideoEditor-Setup.exe"
InstallDir "$PROGRAMFILES\VideoEditor"
InstallDirRegKey HKLM "Software\VideoEditor" "InstallDir"
RequestExecutionLevel admin

; --- Interface ---
!define MUI_ABORTWARNING

; --- Seiten ---
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; --- Sprache ---
!insertmacro MUI_LANGUAGE "German"

; --- Installation ---
Section "VideoEditor" SecMain
    SectionIn RO

    SetOutPath "$INSTDIR"

    ; Alle Dateien aus dem Nuitka Build kopieren
    File /r "dist\gui.dist\*.*"

    ; yolov8n.pt Model
    File "yolov8n.pt"

    ; Startmenue-Verknuepfung
    CreateDirectory "$SMPROGRAMS\VideoEditor"
    CreateShortCut "$SMPROGRAMS\VideoEditor\Video Editor.lnk" "$INSTDIR\gui.exe"
    CreateShortCut "$SMPROGRAMS\VideoEditor\Deinstallieren.lnk" "$INSTDIR\uninstall.exe"

    ; Desktop-Verknuepfung
    CreateShortCut "$DESKTOP\Video Editor.lnk" "$INSTDIR\gui.exe"

    ; Uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Registry
    WriteRegStr HKLM "Software\VideoEditor" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoEditor" \
        "DisplayName" "Video Editor"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoEditor" \
        "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoEditor" \
        "Publisher" "Selim Alcibuga"
SectionEnd

; --- Deinstallation ---
Section "Uninstall"
    ; Dateien loeschen
    RMDir /r "$INSTDIR"

    ; Verknuepfungen loeschen
    Delete "$SMPROGRAMS\VideoEditor\Video Editor.lnk"
    Delete "$SMPROGRAMS\VideoEditor\Deinstallieren.lnk"
    RMDir "$SMPROGRAMS\VideoEditor"
    Delete "$DESKTOP\Video Editor.lnk"

    ; Registry loeschen
    DeleteRegKey HKLM "Software\VideoEditor"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoEditor"
SectionEnd
