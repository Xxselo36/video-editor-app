/**
 * The landing's footage: muted, looping clips of one creator talking to
 * the camera (stock video by MART PRODUCTION on Pexels, free to use;
 * every frame that shows him carries the "Example" tag, so he is never
 * presented as a customer). Cut, graded and encoded from the originals:
 * H.264, 25 fps, no audio, 6-7 s; the last 0.4 s of each fades into the
 * moments before its first frame, so the loop has no seam. Each has a
 * first-frame poster (webp) and an inline 12 px preview.
 *
 * Files: public/landing/video/<file>.mp4 and <file>.webp.
 * - hero: the hero's 9:16 video (cafe set); also the closing frame.
 * - ringCafe / ringOffice / ringRoom: the caption carousel's three videos.
 * - tileCafe / tileOffice / tileRoom: the three bonus clips.
 * - smartcam: the 16:9 take the SmartCam section reframes (he sits left
 *   of centre, a whiteboard to his right).
 */
export type ClipId = "hero" | "ringCafe" | "ringOffice" | "ringRoom" | "tileCafe" | "tileOffice" | "tileRoom" | "smartcam";

export const CLIPS: Record<ClipId, { file: string; w: number; h: number; lqip: string }> = {
  hero: { file: "hero", w: 540, h: 960, lqip: "data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAAAwBACdASoMABUAPu1kq04ppaQiMAgBMB2JQBdmUABflPMXT+owoX90LmgA/s2DF74P8CnrCkfyIPhF6iMzGs9Z0shFXKva8G+za+TWITkGbU1IWalorQBrEfkm7a2yknjin1g5U6/AAA==" },
  ringCafe: { file: "ring-cafe", w: 540, h: 960, lqip: "data:image/webp;base64,UklGRoQAAABXRUJQVlA4IHgAAABQBACdASoMABUAPu1iqU2ppaOiMAgBMB2JYgC7MoACtVqzY4LT27DAzggAAP7Ngxk8zVxO8c7qRJRFOw591eb+15GnZUogfuAytzzs+bXh3zXONzM96J7beRu54SvRQMxgeKmjyizwHlEZJkj+64kQTgzbIjzAAAA=" },
  ringOffice: { file: "ring-office", w: 540, h: 960, lqip: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAACwAwCdASoMABUAPu1iqk2ppaQiMAgBMB2JZQAAUoGlb5H0O2iOAAD8Wk8R8tHsOnjmQ5HOawIqf7FvTBCHhZDeZDdoKCsPDmvZLXARUrtrNF9bpaTR/fRQclMqQAAA" },
  ringRoom: { file: "ring-room", w: 540, h: 960, lqip: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAACwAwCdASoMABUAPu1iqk2ppaQiMAgBMB2JZQC7ABrh8W8xziz3CADvK37+ZB2nwBMNRxDiJTGF4d3ob8Mvz3noe2mBKjlKy5P6RH2D5rfB/K2OLqwV+x/bgAA=" },
  tileCafe: { file: "tile-cafe", w: 360, h: 640, lqip: "data:image/webp;base64,UklGRnAAAABXRUJQVlA4IGQAAABwBACdASoMABUAPu1kqU2ppaOiMAgBMB2JZQC06CKKixr2FsjLapIAtefDwAD+fWhlot1YNwouCSUxF6FVyUmdozylW5bawz/mDyuyu64RuExFVCrqJVX4ZGxcoJ0xeotB/LwA" },
  tileOffice: { file: "tile-office", w: 360, h: 640, lqip: "data:image/webp;base64,UklGRnoAAABXRUJQVlA4IG4AAACQAwCdASoMABUAPu1iqU2ppaQiMAgBMB2JQBAAAPfae6k8N/GgAPxaS+6MepN44Kbo9597g/Rm5O6TwXXrNziacckTI3q/jul3s37ONywbnCSvk1CbgGR8CX56/iD8Dlz87xUjX20ami0dkMfAAA==" },
  tileRoom: { file: "tile-room", w: 360, h: 640, lqip: "data:image/webp;base64,UklGRmwAAABXRUJQVlA4IGAAAABwAwCdASoMABUAPu1iqk2ppaQiMAgBMB2JZQAASG0RgJPUZ/gA7onRhJ/72uJ7YuUU0p981wkILibrVPccFcZBxP7hwSAl1SB7YxLUXIe/mbUJho7YXxv4NNyW/CuAAAA=" },
  smartcam: { file: "smartcam", w: 1280, h: 720, lqip: "data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAADQAQCdASoMAAcAA4BaJYgCsADcMHCwAADieyOdtWSCG6IApOQaWXZRwVHLgIKmPhEF+tsQ3AAAAA==" },
};

export const CLIP_DIR = "/landing/video";

/**
 * SmartCam's face track on the smartcam clip: his face centre (fractions
 * of the frame) every `step` seconds of the clip, from the product's own
 * face model (YuNet, assets/models) and smoothed the way the reframe
 * smooths it (±0.6 s, triangular). `w` is the face box's mean width.
 */
export const SMARTCAM_TRACK = {
  step: 0.08,
  w: 0.1679,
  x: [0.3366, 0.343, 0.3496, 0.3561, 0.3623, 0.3678, 0.3723, 0.3757, 0.3777, 0.3788, 0.3788, 0.3778, 0.3755, 0.3724, 0.3688, 0.3647, 0.3604, 0.3564, 0.3527, 0.3499, 0.3477, 0.3461, 0.3448, 0.3439, 0.3434, 0.3434, 0.3439, 0.3449, 0.3466, 0.3488, 0.3515, 0.3546, 0.3576, 0.3604, 0.363, 0.3652, 0.3672, 0.3687, 0.3698, 0.3706, 0.3708, 0.3702, 0.3688, 0.3665, 0.3633, 0.3591, 0.3539, 0.3483, 0.3427, 0.3373, 0.3324, 0.3285, 0.3257, 0.3242, 0.3236, 0.3239, 0.3246, 0.3258, 0.327, 0.3281, 0.329, 0.3295, 0.3299, 0.3302, 0.3304, 0.3306, 0.3306, 0.3307, 0.3308, 0.3308, 0.3305, 0.3302, 0.3296, 0.329, 0.3282, 0.3273, 0.3265, 0.3259, 0.3254, 0.325, 0.3246, 0.3242, 0.3238, 0.3232, 0.3223, 0.3213, 0.3201, 0.3194],
  y: [0.4402, 0.4374, 0.4359, 0.4362, 0.4378, 0.4406, 0.4449, 0.45, 0.4553, 0.4601, 0.4644, 0.4692, 0.475, 0.4811, 0.4868, 0.4921, 0.4964, 0.4992, 0.4987, 0.4935, 0.4846, 0.4741, 0.4626, 0.4514, 0.441, 0.4322, 0.4263, 0.4232, 0.4217, 0.4216, 0.4221, 0.4234, 0.4256, 0.4282, 0.4309, 0.4337, 0.4364, 0.439, 0.441, 0.4422, 0.443, 0.4436, 0.4442, 0.4451, 0.4467, 0.4491, 0.4523, 0.456, 0.4592, 0.4615, 0.4624, 0.4615, 0.4588, 0.4542, 0.4474, 0.4395, 0.4314, 0.4237, 0.4172, 0.4121, 0.4089, 0.4085, 0.4106, 0.4146, 0.42, 0.4258, 0.4317, 0.4375, 0.4424, 0.4459, 0.4483, 0.4496, 0.4501, 0.4498, 0.4487, 0.447, 0.4447, 0.4419, 0.4387, 0.4354, 0.4338, 0.4333, 0.4343, 0.4371, 0.4417, 0.4479, 0.4554, 0.4608],
} as const;

/** The track's face centre at clip time `t` (seconds), interpolated. */
export function faceAt(t: number): { x: number; y: number } {
  const { step, x, y } = SMARTCAM_TRACK;
  const f = Math.max(0, Math.min(x.length - 1, t / step));
  const i = Math.floor(f);
  const j = Math.min(x.length - 1, i + 1);
  const k = f - i;
  return { x: x[i] + (x[j] - x[i]) * k, y: y[i] + (y[j] - y[i]) * k };
}
