import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Set Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy on
 * /app routes so SharedArrayBuffer is available for ffmpeg.wasm's
 * multi-threaded core. Without these headers we fall back to
 * single-thread (2-3x slower transcode).
 *
 * Applied via middleware (not next.config or vercel.json) because
 * those two mechanisms both failed to actually set the headers on the
 * live Vercel deployment for reasons unclear.
 */
export function middleware(req: NextRequest) {
  const response = NextResponse.next();
  const path = req.nextUrl.pathname;
  if (path === "/app" || path.startsWith("/app/")) {
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  return response;
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};
