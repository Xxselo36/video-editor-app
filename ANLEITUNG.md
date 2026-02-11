# Video Editor v5.0 - Anleitung

Vollautomatische Video-Bearbeitung fuer TikTok, Reels & YouTube Shorts.

**Ein Befehl. Fertiges Video.**

Video rein, Style waehlen, fertig. Stille wird automatisch entfernt, Untertitel generiert, Effekte angewendet, Format angepasst. Keine monatlichen Kosten - laeuft komplett lokal auf deinem Rechner.

**Features:**
- 10 fertige Styles (Clean, Viral, Cinematic, Retro, Dynamisch, ...)
- 50+ visuelle Effekte (Glitch, RGB Split, VHS, Film Grain, Light Leaks, ...)
- KI-Untertitel mit Whisper (Wort-fuer-Wort, 6 verschiedene Stile)
- Smart Zoom (folgt automatisch Gesichtern)
- Auto-Reframe (16:9 → 9:16 fuer TikTok/Reels)
- Beat-Detection fuer Musik-Videos
- Automatische Stille-Entfernung
- Prompt-Modus: Beschreibe in eigenen Worten, was du willst
- Laeuft komplett offline & lokal

---

## Installation

### Mac

1. **Python installieren** (falls nicht vorhanden)
   ```bash
   # Pruefen ob Python installiert ist:
   python3 --version

   # Falls nicht, installiere ueber Homebrew:
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   brew install python
   ```

2. **FFmpeg installieren**
   ```bash
   brew install ffmpeg
   ```

3. **Video Editor einrichten**
   ```bash
   cd video-editor
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Fertig!** Weiter zu [Schnellstart](#schnellstart)

---

### Windows

1. **Python installieren**
   - Gehe zu [python.org/downloads](https://python.org/downloads)
   - Lade Python 3.9+ herunter
   - **Wichtig:** Hake "Add Python to PATH" an bei der Installation!

2. **FFmpeg installieren**
   - Gehe zu [ffmpeg.org/download.html](https://ffmpeg.org/download.html)
   - Lade "Windows builds" herunter
   - Entpacke den Ordner nach `C:\ffmpeg`
   - Fuege `C:\ffmpeg\bin` zur PATH Umgebungsvariable hinzu:
     - Windows-Suche → "Umgebungsvariablen"
     - "Path" bearbeiten → Neu → `C:\ffmpeg\bin`

3. **Video Editor einrichten**
   ```cmd
   cd video-editor
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```

4. **Fertig!** Weiter zu [Schnellstart](#schnellstart)

---

### Linux (Ubuntu/Debian)

1. **Python & FFmpeg installieren**
   ```bash
   sudo apt update
   sudo apt install python3 python3-venv python3-pip ffmpeg
   ```

2. **Video Editor einrichten**
   ```bash
   cd video-editor
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Fertig!** Weiter zu [Schnellstart](#schnellstart)

---

## Schnellstart

1. **Terminal oeffnen** und zum Ordner navigieren:
   ```bash
   cd video-editor
   ```

2. **Virtuelle Umgebung aktivieren:**
   ```bash
   # Mac/Linux:
   source venv/bin/activate

   # Windows:
   venv\Scripts\activate
   ```

3. **Video in den `input` Ordner legen**

4. **Video bearbeiten:**
   ```bash
   python3 main.py input/dein_video.mp4
   ```

5. **Fertiges Video** findest du im `output` Ordner!

---

## Stile

Es gibt 10 fertige Stile. Jeder Stil hat eigene Effekte, Uebergaenge und Untertitel-Einstellungen.

| Stil | Beschreibung | Ideal fuer |
|------|-------------|------------|
| **clean** (Standard) | Harte Cuts, saubere weisse Untertitel, 9:16 | TikTok, Reels |
| **viral** | Wort-fuer-Wort Untertitel, Lila-Tint, Smart Zoom | Virale Clips |
| **tiktok** | Schnelle Schnitte, RGB Split, Glitch, 9:16, Beat-Sync | TikTok mit Effekten |
| **ruhig** | Blur-Uebergaenge, Karaoke-Untertitel, sanfter Zoom | Storytelling, Vlogs |
| **balanced** | Swipe-Uebergaenge, Light Leaks, moderne Untertitel | Vielseitig einsetzbar |
| **dynamisch** | Glitch, RGB Split, Shake, Beat Zoom | Energetischer Content |
| **cinematic** | Letterbox, Film Grain, Fade-Uebergaenge | Professioneller Look |
| **retro** | VHS-Effekt, Film Grain, Vintage-Farben | Nostalgischer Vibe |
| **music** | Beat-Sync, Zoom Pulse, Echo, keine Untertitel | Musik-Videos |
| **minimal** | Nur Stille entfernen, sonst nichts | Rohmaterial bereinigen |

### Stil verwenden

```bash
# Standard (clean):
python3 main.py input/video.mp4

# Bestimmter Stil:
python3 main.py input/video.mp4 --style cinematic

# Mehrere Stile auf einmal (erstellt mehrere Videos):
python3 main.py input/video.mp4 --styles clean,viral,cinematic
```

---

## Prompt-Modus

Beschreibe in eigenen Worten, wie dein Video aussehen soll. Der Editor erkennt automatisch die passenden Effekte.

```bash
python3 main.py input/video.mp4 --prompt "mach es dynamisch mit glitch effekten"
python3 main.py input/video.mp4 --prompt "ruhiges video mit karaoke untertiteln"
python3 main.py input/video.mp4 --prompt "fuer tiktok optimieren, hochformat mit beat sync"
python3 main.py input/video.mp4 --prompt "cinematic look mit letterbox und film grain"
python3 main.py input/video.mp4 --prompt "retro vhs style mit rgb split"
python3 main.py input/video.mp4 --prompt "minimalistisch, nur stille entfernen"
```

### Prompt testen (ohne Video zu rendern)

```bash
python3 main.py input/video.mp4 --prompt "dynamisch mit glitch" --explain
```

Zeigt dir, welche Effekte aus deinem Prompt erkannt werden, ohne das Video zu bearbeiten.

---

## Fast-Modus

Fuer schnellere Verarbeitung gibt es den FFmpeg-Direktmodus. Empfohlen fuer den Clean Style.

```bash
python3 main.py input/video.mp4 --fast
```

---

## Whisper Modelle (Spracherkennung)

Die Untertitel werden per KI generiert. Du kannst zwischen Geschwindigkeit und Qualitaet waehlen.

| Modell | Qualitaet | Geschwindigkeit | Befehl |
|--------|----------|-----------------|--------|
| tiny | Grundlegend | Sehr schnell | `--model tiny` |
| base | OK | Schnell | `--model base` |
| small | Gut | Mittel | `--model small` |
| **medium** (Standard) | Sehr gut | Langsamer | `--model medium` |
| large | Beste | Langsam | `--model large` |

```bash
# Schneller (weniger genau):
python3 main.py input/video.mp4 --model small

# Beste Qualitaet:
python3 main.py input/video.mp4 --model large
```

Fuer deutsche Videos ist `medium` empfohlen.

---

## Alle Optionen

| Option | Beschreibung |
|--------|-------------|
| `--style <name>` / `-s` | Einen Stil waehlen (Standard: clean) |
| `--styles <a,b,c>` | Mehrere Stile gleichzeitig |
| `--prompt <text>` / `-p` | Freie Beschreibung statt Stil |
| `--explain` | Prompt analysieren ohne Video zu rendern |
| `--model <name>` / `-m` | Whisper Modell (tiny/base/small/medium/large) |
| `--no-subtitles` | Keine Untertitel generieren |
| `--output <pfad>` / `-o` | Anderes Output-Verzeichnis |
| `--fast` | Schneller FFmpeg-Modus |
| `--info` | Alle Stile anzeigen |
| `--effects` | Alle Effekte anzeigen |
| `--prompts` | Beispiel-Prompts anzeigen |

---

## Effekte

### Visuelle Effekte
- **Color Grading** - Farbkorrekturen (Viral, Cinematic, Vintage, TikTok, ...)
- **RGB Split** - Farbkanal-Verschiebung
- **VHS** - Retro mit Scanlines
- **Film Grain** - Koerniger Vintage-Look
- **Light Leaks** - Lichtflecken
- **Vignette** - Abgedunkelte Raender
- **Shake** - Kamera-Wackeln
- **Echo** - Nachlaufende Frames
- **Mirror** - Spiegel-Effekt
- **Cinematic Bars** - Letterbox (Kino-Balken)

### Uebergaenge
Fade, Blur, Swipe, Glitch, Zoom, Pixelate, Rotate, Scale Pop, Slide, Elastic Bounce

### Zoom-Effekte
- **Smart Zoom** - Folgt Gesichtern automatisch
- **Beat Zoom** - Zoom auf Musik-Beats
- **Zoom Pulse** - Pulsierender Zoom
- **Pan/Zoom** - Ken Burns Effekt

### Untertitel-Stile
- **Clean** - Saubere Phrasen-Untertitel (TikTok Style)
- **Modern** - Wort-fuer-Wort, weiss
- **Karaoke** - Aktives Wort wird hervorgehoben
- **Typewriter** - Schreibmaschinen-Effekt
- **Bounce** - Huepfender Text
- **Glitch** - Glitch-Text
- **Neon** - Leuchtender Neon-Text

### Sound-Effekte
- Whoosh (Intro/Outro)
- Pop (Akzente)
- Click (Schnitte)

---

## Beispiele

```bash
# Clean TikTok Video (Standard)
python3 main.py input/video.mp4

# Cinematic mit bestem Whisper Modell
python3 main.py input/video.mp4 --style cinematic --model large

# Schnelle Bearbeitung
python3 main.py input/video.mp4 --fast --model small

# Ohne Untertitel
python3 main.py input/video.mp4 --no-subtitles

# 3 Varianten auf einmal
python3 main.py input/video.mp4 --styles clean,viral,cinematic

# Eigene Beschreibung
python3 main.py input/video.mp4 --prompt "energetisch mit glitch und beat sync"

# Nur Stille entfernen
python3 main.py input/video.mp4 --style minimal
```

---

## Performance

| Video | Verarbeitungszeit |
|-------|------------------|
| 25 Sek. (1080p) | ~1-2 Minuten |
| 140 Sek. (4K iPhone) | ~13 Minuten |

4K Videos werden automatisch auf 1080p skaliert fuer optimale Performance.

---

## Troubleshooting

### "command not found: python3"
- Python ist nicht installiert oder nicht im PATH
- Siehe Installationsanleitung oben

### "No module named 'xyz'"
- Virtuelle Umgebung nicht aktiviert
- `source venv/bin/activate` (Mac/Linux) oder `venv\Scripts\activate` (Windows)
- Dann: `pip install -r requirements.txt`

### "ffmpeg not found"
- Mac: `brew install ffmpeg`
- Windows: Siehe Installationsanleitung
- Linux: `sudo apt install ffmpeg`

### Video ist gedreht/gestreckt
- iPhone Videos werden automatisch korrigiert (3-stufige Rotation-Erkennung)
- Falls nicht: `ffmpeg -i input.mp4 -c:v libx264 output.mp4`

### Untertitel sind falsch
- Besseres Whisper Modell nutzen: `--model medium` oder `--model large`
- Fuer deutsche Videos ist `medium` empfohlen

### Verarbeitung ist langsam
- `--fast` Modus nutzen
- Kleineres Whisper Modell: `--model small` oder `--model tiny`
- 4K Videos werden automatisch runterskaliert

---

## Ordnerstruktur

```
video-editor/
├── input/          ← Deine Videos hier rein
├── output/         ← Bearbeitete Videos landen hier
├── src/            ← Programm-Code (nicht aendern)
├── main.py         ← Hauptprogramm
├── requirements.txt
└── ANLEITUNG.md    ← Diese Datei
```
