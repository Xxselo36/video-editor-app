import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN IPs so we can open the dev server on phone/tablet
  // (Next 16 blocks cross-origin dev resources by default).
  allowedDevOrigins: [
    "192.168.178.155",
    "localhost",
  ],
  // Enable SharedArrayBuffer for ffmpeg.wasm (client-side video downscale
  // before upload). Requires Cross-Origin-Isolation via COOP/COEP headers.
  // Only applied to /app/* routes so the landing page + external embeds
  // (fonts, share buttons, etc.) aren't affected.
  async headers() {
    return [
      {
        source: "/app/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        source: "/app",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
