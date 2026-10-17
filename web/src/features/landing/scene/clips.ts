/**
 * The landing's footage: muted, looping clips of one creator talking to
 * the camera (stock video by MART PRODUCTION on Pexels, free to use).
 * Cut, graded and encoded from the originals: H.264, 25 fps, no audio,
 * 6-7 s; the last 0.4 s of each fades into the moments before its first
 * frame, so the loop has no seam. Each has a first-frame poster (webp)
 * and an inline 12 px preview (Scene.module.css, .lqip<Clip>: style, not
 * script, so the hero's first load carries none of them).
 *
 * Files: public/landing/video/<file>.mp4 and <file>.webp.
 * - hero: the hero's 9:16 video (cafe set); also the closing frame. Its
 *   first load opens on it half way (HERO_HALF): hero-half.webp is that
 *   frame (frame 108, decoded from hero.mp4, webp quality 75 as the
 *   other posters).
 * - heroRaw: the take hero.mp4 is cut from, ungraded (flat, cooler, less
 *   saturated), 16.8 s: the hero's monitor plays it once per loop while
 *   the tape is recorded and cut (hero/Monitor.tsx). hero.mp4 shows its
 *   frames up to 5.6 s (then hero.mp4 fades into its own start); its
 *   last frame is hero.mp4's first pose, and its first 0.4 s fade in
 *   from it. A keyframe every second, so its jump cuts seek cheaply.
 * - ringCafe / ringOffice / ringRoom: the caption carousel's three videos.
 * - tileCafe / tileOffice / tileRoom: the three bonus clips.
 * - smartcam: the 16:9 take the SmartCam section reframes (he sits left
 *   of centre, a whiteboard to his right).
 */
export type ClipId = "hero" | "heroRaw" | "ringCafe" | "ringOffice" | "ringRoom" | "tileCafe" | "tileOffice" | "tileRoom" | "smartcam";

export const CLIPS: Record<ClipId, { file: string; w: number; h: number }> = {
  hero: { file: "hero", w: 540, h: 960 },
  heroRaw: { file: "hero-raw", w: 540, h: 960 },
  ringCafe: { file: "ring-cafe", w: 540, h: 960 },
  ringOffice: { file: "ring-office", w: 540, h: 960 },
  ringRoom: { file: "ring-room", w: 540, h: 960 },
  tileCafe: { file: "tile-cafe", w: 360, h: 640 },
  tileOffice: { file: "tile-office", w: 360, h: 640 },
  tileRoom: { file: "tile-room", w: 360, h: 640 },
  smartcam: { file: "smartcam", w: 1280, h: 720 },
};

export const CLIP_DIR = "/landing/video";

/** A clip opened later than its first frame: where (s) and the poster
 *  of that frame (<poster>.webp). */
export type ClipStart = { at: number; poster: string };

/** The hero's first load opens on its finished video half way through
 *  the play (hero/score.ts halfway): the frame the loop's result shows
 *  as its English caption reaches its middle (from the first kept take,
 *  hero/monitor.ts firstKept, plus halfway's `at`). The other languages
 *  pick up within 0.7 s of it; the footage is not their speech, so
 *  the offset never shows. Mid-frame, so the seek lands on the
 *  poster's frame (108, 4.32 to 4.36 s). */
export const HERO_HALF: ClipStart = { at: 4.34, poster: "hero-half" };
