#!/usr/bin/env python3
"""Render SRT subtitles as a single transparent ProRes 4444 overlay video for DaVinci Resolve."""
import sys, os, json, subprocess

def find_ffmpeg():
    """Find ffmpeg binary."""
    # Try imageio_ffmpeg first (bundled with Video Editor app)
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except Exception:
        pass
    # Try common paths
    for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]:
        try:
            subprocess.run([p, "-version"], capture_output=True, timeout=5)
            return p
        except Exception:
            pass
    return None

def main():
    srt_path = sys.argv[1]
    output_path = sys.argv[2]
    width = int(sys.argv[3])
    height = int(sys.argv[4])
    duration = float(sys.argv[5])
    fps = int(sys.argv[6]) if len(sys.argv) > 6 else 30

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print(json.dumps({"error": "ffmpeg not found"}))
        sys.exit(1)

    # Font size in actual pixels (PlayResX/Y match video resolution)
    fontsize = max(16, int(height * 0.028))
    margin_v = max(20, int(height * 0.05))
    outline = max(1, int(fontsize * 0.08))

    # ASS style: Alignment=2 = bottom-center, PlayRes matches video size
    style = (
        f"PlayResX={width},"
        f"PlayResY={height},"
        f"FontName=Helvetica,"
        f"FontSize={fontsize},"
        f"PrimaryColour=&H00FFFFFF,"
        f"OutlineColour=&H80000000,"
        f"Outline={outline},"
        f"Alignment=2,"
        f"MarginV={margin_v},"
        f"Bold=1"
    )

    # Escape SRT path for ffmpeg filter (colons and backslashes)
    escaped_srt = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    # Render on black background, then use luminance as alpha channel.
    # The subtitles filter only affects RGB, not alpha, so we need this workaround.
    filter_complex = (
        f"[0]subtitles='{escaped_srt}':force_style='{style}'[subs];"
        f"[subs]split[rgb][alpha];"
        f"[alpha]format=gray[alphamask];"
        f"[rgb][alphamask]alphamerge,format=yuva444p10le[out]"
    )

    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi",
        "-i", f"color=black:s={width}x{height}:d={duration}:r={fps}",
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode == 0 and os.path.isfile(output_path):
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(json.dumps({"path": output_path, "size_mb": round(size_mb, 1)}))
    else:
        print(json.dumps({"error": result.stderr[-500:] if result.stderr else "ffmpeg failed"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
