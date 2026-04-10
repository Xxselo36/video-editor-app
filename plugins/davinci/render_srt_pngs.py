#!/usr/bin/env python3
"""Render SRT subtitles as transparent PNG images for DaVinci Resolve XML import."""
import sys, os, json, re

def parse_srt(path):
    with open(path, encoding="utf-8") as f:
        content = f.read() + "\n\n"
    entries = []
    for m in re.finditer(
        r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\s*\n(.*?)(?:\n\s*\n)',
        content, re.DOTALL
    ):
        start = int(m[1])*3600 + int(m[2])*60 + int(m[3]) + int(m[4])/1000
        end = int(m[5])*3600 + int(m[6])*60 + int(m[7]) + int(m[8])/1000
        text = m[9].strip().replace('\n', ' ')
        if text:
            entries.append({"start": start, "end": end, "text": text})
    return entries

def main():
    srt_path = sys.argv[1]
    output_dir = sys.argv[2]
    width = int(sys.argv[3])
    height = int(sys.argv[4])

    from PIL import Image, ImageDraw, ImageFont

    subs = parse_srt(srt_path)
    os.makedirs(output_dir, exist_ok=True)

    # Font
    fontsize = max(48, height // 20)
    font = None
    for fp in [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFCompact.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/Library/Fonts/Arial.ttf",
    ]:
        if os.path.isfile(fp):
            try:
                font = ImageFont.truetype(fp, size=fontsize)
                break
            except Exception:
                pass
    if not font:
        font = ImageFont.load_default()

    results = []
    for i, sub in enumerate(subs):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        text = sub["text"].upper()

        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = (width - tw) // 2
        y = height - th - int(height * 0.15)

        # Black outline
        for dx in range(-3, 4):
            for dy in range(-3, 4):
                if abs(dx) + abs(dy) > 0:
                    draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0, 180))
        # White text
        draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

        png_path = os.path.join(output_dir, f"sub_{i:04d}.png")
        img.save(png_path, "PNG")
        results.append({"path": png_path, "start": sub["start"], "end": sub["end"]})

    # Output JSON to stdout
    print(json.dumps(results))

if __name__ == "__main__":
    main()
