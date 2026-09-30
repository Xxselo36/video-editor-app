/**
 * The link-preview image (Open Graph + Twitter), 1200×630, rendered at
 * build time by app/opengraph-image.tsx and app/twitter-image.tsx
 * (next/og). Headline and caption in Bangers — the font of the Clipper
 * caption style — the rest in Geist (next/og's own font). Only what the
 * product does today.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/site";

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };

async function font(...candidates: string[]): Promise<ArrayBuffer | null> {
  for (const path of candidates) {
    try {
      const buf = await readFile(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const MARK = (
  <svg width="64" height="64" viewBox="0 0 32 32" fill="none">
    <defs>
      <linearGradient id="b" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#e9d5ff" />
        <stop offset="50%" stopColor="#a78bfa" />
        <stop offset="100%" stopColor="#6d28d9" />
      </linearGradient>
      <radialGradient id="s" cx="0.35" cy="0.35" r="0.75">
        <stop offset="0%" stopColor="#faf5ff" />
        <stop offset="40%" stopColor="#d8b4fe" />
        <stop offset="100%" stopColor="#7c3aed" />
      </radialGradient>
    </defs>
    <path
      d="M24.5 9.5C22.4 6.8 19.4 5 16 5C9.9 5 5 9.9 5 16C5 22.1 9.9 27 16 27C19.4 27 22.4 25.2 24.5 22.5"
      stroke="url(#b)"
      strokeWidth="3.75"
      strokeLinecap="round"
      fill="none"
    />
    <circle cx="20" cy="15.5" r="2.6" fill="url(#s)" />
  </svg>
);

export async function renderShareImage(): Promise<ImageResponse> {
  const cwd = process.cwd();
  const [geist, bangers] = await Promise.all([
    font(join(cwd, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf")),
    // The repo's caption font (assets/fonts), next to web/.
    font(join(cwd, "../assets/fonts/Bangers-Regular.ttf"), join(cwd, "assets/fonts/Bangers-Regular.ttf")),
  ]);
  const fonts = [
    geist && { name: "Geist", data: geist, weight: 400 as const, style: "normal" as const },
    bangers && { name: "Bangers", data: bangers, weight: 400 as const, style: "normal" as const },
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));
  const display = bangers ? "Bangers" : "Geist";
  const outline = "0 3px 0 #000, 3px 0 0 #000, -3px 0 0 #000, 0 -3px 0 #000";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "64px 80px",
          background: "#0b0a10",
          backgroundImage:
            "radial-gradient(ellipse 70% 60% at 25% 0%, rgba(139,92,246,0.38), transparent 70%), radial-gradient(ellipse 45% 45% at 92% 18%, rgba(236,72,153,0.20), transparent 70%)",
          color: "#f5f3fa",
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {MARK}
            <div style={{ marginLeft: 16, fontSize: 44, letterSpacing: -1 }}>{SITE_NAME}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontFamily: display, fontSize: 92, lineHeight: 1.02 }}>
            <div>CUT PAUSES.</div>
            <div>ADD CAPTIONS.</div>
            <div style={{ color: "#a78bfa" }}>POST IN MINUTES.</div>
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#c4c0d0", maxWidth: 660, lineHeight: 1.35 }}>
            Upload a talking video. Get a clean, captioned 9:16 cut you can fine-tune in your browser.
          </div>
        </div>
        {/* A 9:16 phone frame with a caption, the way the videos come out. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-end",
            width: 282,
            height: 500,
            marginLeft: 40,
            marginTop: 1,
            padding: "0 16px 120px",
            borderRadius: 40,
            border: "3px solid #3a3849",
            backgroundImage: "linear-gradient(165deg, #2a2248 0%, #16132a 55%, #0f0d1a 100%)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 10px rgba(139,92,246,0.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              fontFamily: display,
              fontSize: 50,
              letterSpacing: 1,
              textShadow: outline,
            }}
          >
            POST IN
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 6,
              padding: "2px 16px",
              borderRadius: 12,
              background: "#7c3aed",
              fontFamily: display,
              fontSize: 50,
              letterSpacing: 1,
            }}
          >
            MINUTES
          </div>
        </div>
      </div>
    ),
    { ...SHARE_IMAGE_SIZE, fonts: fonts.length ? fonts : undefined },
  );
}
