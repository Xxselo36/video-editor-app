WICHTIG: Ändere AUSSCHLIESSLICH Dateien die mit torch-Imports zu tun haben. Fasse KEINE anderen Dateien an — nicht gui.py (außer torch-Stub), nicht src/, nicht plugins/, nicht build.sh, nicht .github/. Bei Unsicherheit IMMER zuerst fragen.

Ich debugge die Windows-Version meiner Video Editor App.

## Was zu tun ist:

1. Klone das Repo: `git clone https://github.com/Xxselo36/video-editor-app.git`
2. Erstelle venv: `python -m venv venv && venv\Scripts\activate`
3. Installiere Dependencies: `pip install -r requirements.txt`
4. Starte die App: `python gui.py`
5. Teste: Wähle ein Video und klicke "Start"

## Bekanntes Problem:
Beim Verarbeiten kommt: `ModuleNotFoundError: No module named 'torch.distributed'`
In gui.py gibt es bereits einen Stub vor `import torch` der das fixen soll — prüfe ob er funktioniert, und falls nicht, finde und fixe das Problem.

## Import-Kette des Fehlers:
gui.py → src.editor → src.audio → whisper → torch.nn.functional → torch.nn.modules → torch.utils.data.dataloader → import torch.distributed → FEHLER

## Regeln:
- NICHT gui.py umbauen oder Features ändern — nur torch-Import-Fehler fixen
- NICHT die Standalone-App-Logik ändern
- NICHT src/, plugins/, build.sh, .github/ ändern
- Wenn der Fix funktioniert: `git add . && git commit -m "Fix torch.distributed import on Windows" && git push`
- Teste mit einem echten Video (jedes kurze MP4 reicht)

## Kontext:
- Die App nutzt Whisper (Speech-to-Text), moviepy, opencv, torch
- torch.distributed wird nicht gebraucht (CPU-only, kein verteiltes Training)
- Auf macOS funktioniert alles — nur Windows hat dieses Problem
- Der Nuitka-Build entfernt torch.distributed komplett, aber auch im Source-Run kann der Fehler auftreten wenn torch es intern importiert
