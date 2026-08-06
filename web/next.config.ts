import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN IPs so we can open the dev server on phone/tablet
  // (Next 16 blocks cross-origin dev resources by default).
  allowedDevOrigins: [
    "192.168.178.155",
    "localhost",
  ],
};

export default nextConfig;
