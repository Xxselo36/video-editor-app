#!/usr/bin/env python3
"""
Video Editor CLI v5.0 - Alle Effekte

Features:
- Wort-für-Wort Untertitel (TikTok/Reels Style)
- Visuelle Effekte: RGB Split, VHS, Film Grain, Light Leaks, etc.
- Moderne Übergänge: Blur, Swipe, Glitch, Zoom, Pixelate
- Beat-Sync für Musik-Videos
- Auto-Reframe (16:9 -> 9:16)

Stile:
- viral (Standard) - TikTok/Reels Style mit Wort-Untertiteln
- ruhig, balanced, dynamisch, cinematic, retro, music, minimal

Usage:
    python main.py <video_pfad>                    # Viral Style (Standard)
    python main.py <video_pfad> --style cinematic  # Anderer Stil
    python main.py --info                          # Alle Stile anzeigen
"""

import argparse
import sys
from pathlib import Path

from src.editor import VideoEditor
from src.fast_editor import FastVideoEditor
from src.styles import list_styles, STYLES, get_style_info


def print_banner():
    print("""
╔════════════════════════════════════════════════════════════════╗
║                     SMARTCUT v5.0                               ║
║  RGB Split · VHS · Glitch · Beat-Sync · Karaoke-Untertitel     ║
╚════════════════════════════════════════════════════════════════╝
    """)


def print_styles_info():
    print("\nVerfuegbare Stile:")
    print("=" * 60)

    style_info = get_style_info()
    for name, info in style_info.items():
        config = STYLES[name]
        print(f"\n  {name.upper()}")
        print(f"    {info['description']}")

        # Features sammeln
        features = []
        if config.get("remove_silence"):
            features.append("Stille entfernen")
        if config.get("smart_zoom"):
            features.append("Smart Zoom")
        if config.get("enable_subtitles"):
            style = config.get("subtitle_style", "modern")
            features.append(f"Untertitel ({style})")
        if config.get("enable_emojis"):
            features.append("Emojis")
        if config.get("beat_sync") or config.get("beat_zoom"):
            features.append("Beat-Sync")
        if config.get("rgb_split"):
            features.append("RGB Split")
        if config.get("vhs_effect"):
            features.append("VHS")
        if config.get("film_grain"):
            features.append("Film Grain")
        if config.get("cinematic_bars"):
            features.append("Letterbox")
        if config.get("auto_reframe"):
            features.append(f"Reframe -> {config.get('target_ratio', '9:16')}")

        print(f"    Features: {', '.join(features)}")

    print("\n" + "=" * 60)


def print_effects_info():
    print("\nVerfuegbare Effekte:")
    print("=" * 60)

    print("\n  VISUELLE EFFEKTE:")
    print("    - cinematic_bars : Schwarze Balken (Kino-Look)")
    print("    - rgb_split      : RGB-Kanal Verschiebung")
    print("    - vhs_effect     : VHS/Retro mit Scanlines")
    print("    - film_grain     : Koerniger Vintage-Look")
    print("    - light_leak     : Lichtflecken")
    print("    - shake          : Kamera-Wackeln")
    print("    - echo           : Nachlaufende Frames")
    print("    - mirror         : Spiegel-Effekt")

    print("\n  UEBERGAENGE:")
    print("    - fade           : Sanftes Ein/Ausblenden")
    print("    - blur           : Unscharf -> Scharf")
    print("    - swipe          : Wisch-Uebergang")
    print("    - glitch         : Digitaler Glitch")
    print("    - zoom           : Zoom-Uebergang")
    print("    - pixelate       : Pixel-Uebergang")

    print("\n  ZOOM:")
    print("    - smart_zoom     : Folgt Gesichtern")
    print("    - zoom_in/out    : Langsamer Zoom")
    print("    - pan_zoom       : Ken Burns Effekt")
    print("    - beat_zoom      : Zoom auf Beats")
    print("    - zoom_pulse     : Pulsierender Zoom")

    print("\n  UNTERTITEL:")
    print("    - karaoke        : Wort-fuer-Wort Highlight")
    print("    - modern         : Saubere Untertitel")
    print("    - typewriter     : Schreibmaschinen-Effekt")
    print("    - bounce         : Huepfender Text")
    print("    - glitch         : Glitch-Text")
    print("    - neon           : Neon-Leuchteffekt")

    print("\n" + "=" * 60)


def print_prompt_examples():
    print("\nBeispiel-Prompts:")
    print("=" * 60)
    examples = [
        "mach es dynamisch mit glitch effekten",
        "ruhiges video mit karaoke untertiteln",
        "fuer tiktok optimieren, hochformat mit beat sync",
        "cinematic look mit letterbox und film grain",
        "retro vhs style mit rgb split",
        "musik video mit beat zoom und pulsierenden effekten",
        "minimalistisch, nur stille entfernen",
        "sehr intensiver glitch mit starkem shake",
        "professionell mit untertiteln aber ohne emojis",
    ]
    for ex in examples:
        print(f'  --prompt "{ex}"')
    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Video Editor v5.0 - Alle Effekte + Prompt-Steuerung",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Beispiele:
  python main.py input/video.mp4                              # Standard (3 Stile)
  python main.py input/video.mp4 --style dynamisch            # Ein Stil
  python main.py input/video.mp4 --styles balanced,tiktok     # Mehrere Stile

  PROMPT-BASIERT (NEU!):
  python main.py input/video.mp4 --prompt "mach es dynamisch mit glitch"
  python main.py input/video.mp4 --prompt "fuer tiktok mit beat sync"
  python main.py input/video.mp4 --prompt "cinematic mit film grain"

  python main.py --info                                       # Stil-Info
  python main.py --effects                                    # Effekt-Info
  python main.py --prompts                                    # Prompt-Beispiele
        """
    )

    parser.add_argument(
        "video",
        type=str,
        nargs="?",
        help="Pfad zum Input-Video"
    )

    parser.add_argument(
        "--style", "-s",
        type=str,
        choices=list_styles(),
        default="clean",
        help="Einen Stil erstellen (Standard: clean)"
    )

    parser.add_argument(
        "--styles",
        type=str,
        default=None,
        help="Mehrere Stile, komma-getrennt (z.B. balanced,dynamisch,tiktok)"
    )

    parser.add_argument(
        "--output", "-o",
        type=str,
        default="output",
        help="Output-Verzeichnis (Standard: output)"
    )

    parser.add_argument(
        "--model", "-m",
        type=str,
        choices=["tiny", "base", "small", "medium", "large"],
        default="medium",
        help="Whisper Modell (Standard: medium)"
    )

    parser.add_argument(
        "--no-subtitles",
        action="store_true",
        help="Keine Untertitel generieren"
    )

    parser.add_argument(
        "--info",
        action="store_true",
        help="Zeigt Stil-Informationen"
    )

    parser.add_argument(
        "--effects",
        action="store_true",
        help="Zeigt alle verfuegbaren Effekte"
    )

    parser.add_argument(
        "--prompt", "-p",
        type=str,
        default=None,
        help="Prompt zur Steuerung der Bearbeitung (z.B. 'dynamisch mit glitch')"
    )

    parser.add_argument(
        "--prompts",
        action="store_true",
        help="Zeigt Beispiel-Prompts"
    )

    parser.add_argument(
        "--explain",
        action="store_true",
        help="Erklaert was aus dem Prompt erkannt wurde (ohne Video zu erstellen)"
    )

    parser.add_argument(
        "--fast",
        action="store_true",
        help="Schneller FFmpeg-Modus (empfohlen für clean Style)"
    )

    args = parser.parse_args()

    print_banner()

    if args.info:
        print_styles_info()
        print("\nWhisper Modelle:")
        print("  tiny   - Schnellste, geringste Qualitaet")
        print("  base   - Gute Balance (Standard)")
        print("  small  - Bessere Qualitaet")
        print("  medium - Hohe Qualitaet")
        print("  large  - Beste Qualitaet, langsam")
        return 0

    if args.effects:
        print_effects_info()
        return 0

    if args.prompts:
        print_prompt_examples()
        return 0

    if args.explain and args.prompt:
        from src.prompt_engine import PromptEngine
        engine = PromptEngine()
        print(engine.explain_prompt(args.prompt))
        return 0

    if not args.video:
        parser.print_help()
        print("\nFehler: Bitte gib ein Video an.")
        print("Beispiel: python main.py input/dein_video.mp4")
        return 1

    # Prüfe ob Video existiert
    video_path = Path(args.video)
    if not video_path.exists():
        print(f"Fehler: Video nicht gefunden: {args.video}")
        print("\nTipp: Lege dein Video in den 'input' Ordner:")
        print(f"  cp /pfad/zu/video.mp4 ~/video-editor/input/")
        return 1

    # Konfiguration anzeigen
    print(f"Input:          {video_path}")
    print(f"Output:         {args.output}/")
    print(f"Whisper Model:  {args.model}")

    # PROMPT-BASIERTE BEARBEITUNG
    if args.prompt:
        print(f"Modus:          PROMPT-BASIERT")
        print(f"Prompt:         \"{args.prompt}\"")

        try:
            with VideoEditor(str(video_path), args.output, whisper_model=args.model) as editor:
                result_path = editor.edit_with_prompt(args.prompt)

            print("\n" + "=" * 60)
            print("  FERTIG!")
            print("=" * 60)
            print(f"  Output: {result_path}")
            print(f"\n  Video oeffnen: open \"{result_path}\"")
            return 0

        except Exception as e:
            print(f"\nFehler: {e}")
            import traceback
            traceback.print_exc()
            return 1

    # STIL-BASIERTE BEARBEITUNG
    if args.style:
        styles_to_create = [args.style]
    elif args.styles:
        styles_to_create = [s.strip() for s in args.styles.split(",")]
        valid_styles = list_styles()
        for s in styles_to_create:
            if s not in valid_styles:
                print(f"Fehler: Unbekannter Stil '{s}'")
                print(f"Verfuegbar: {', '.join(valid_styles)}")
                return 1
    else:
        styles_to_create = ["viral"]

    print(f"Modus:          {'FAST (FFmpeg)' if args.fast else 'STIL-BASIERT'}")
    print(f"Stil(e):        {', '.join(styles_to_create)}")
    print(f"Untertitel:     {'Nein' if args.no_subtitles else 'Ja'}")

    # FAST MODE - FFmpeg direkt
    if args.fast:
        try:
            editor = FastVideoEditor(str(video_path), args.output, whisper_model=args.model)
            result_path = editor.edit_fast(
                style=styles_to_create[0],
                remove_silence=True,
                add_subtitles=not args.no_subtitles
            )

            print("\n" + "=" * 60)
            print("  FERTIG!")
            print("=" * 60)
            print(f"  Output: {result_path}")
            print(f"\n  Video oeffnen: open \"{result_path}\"")
            return 0

        except Exception as e:
            print(f"\nFehler: {e}")
            import traceback
            traceback.print_exc()
            return 1

    if args.no_subtitles:
        for style in STYLES.values():
            style["enable_subtitles"] = False

    try:
        with VideoEditor(str(video_path), args.output, whisper_model=args.model) as editor:
            results = editor.create_selected_variants(styles_to_create)

        print("\n" + "=" * 60)
        print("  ZUSAMMENFASSUNG")
        print("=" * 60)

        success_count = 0
        for style, path in results.items():
            if path:
                print(f"  {style:12} -> {path}")
                success_count += 1
            else:
                print(f"  {style:12} -> FEHLER")

        print(f"\n  {success_count}/{len(results)} Videos erfolgreich erstellt")
        print(f"\n  Output-Verzeichnis: {Path(args.output).absolute()}")
        print("\n  Videos oeffnen mit:")
        print(f"    open {args.output}/")

        return 0 if success_count == len(results) else 1

    except FileNotFoundError as e:
        print(f"\nFehler: {e}")
        return 1
    except KeyboardInterrupt:
        print("\n\nAbgebrochen.")
        return 1
    except Exception as e:
        print(f"\nUnerwarteter Fehler: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
