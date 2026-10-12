/**
 * The landing's one synthetic recording: a creator talking to the camera
 * in a dim room, backlit, faceless (no real footage exists; every frame
 * that shows it carries the "Example" tag). Every video frame on the page
 * is a crop of this same wide shot, so the frames read as one video at
 * different stages of the edit.
 *
 * Built as one inline SVG sprite (SceneSprite, rendered once per page)
 * and thin layers that <use> it:
 * - the room, static (painted once, never animated);
 * - the creator's body and head, each in its own HTML wrapper, so a nod
 *   or a move is a composited transform on a div, never an SVG repaint.
 * The canvas is the full 16:9 shot; a 9:16 frame shows it at its own
 * height and moves it sideways (translate in % of the canvas), so the
 * crop can be animated cheaply too.
 *
 * Colours come from the tokens (stop-color through style); light in the
 * scene is video content, so it stays neutral, with the page's ambient
 * violet and magenta as the room's glow.
 */
import { cx } from "@/components/ui/cx";
import styles from "./Scene.module.css";

/** The shot's size in SVG units (16:9). */
export const SHOT_W = 1600;
export const SHOT_H = 900;
/** Where the creator stands in the shot (fraction of its width). */
export const CREATOR_X = 0.36;
/** The neck (the head's pivot), in shot units from the top. */
const NECK_Y = 352;
/** A 9:16 crop's width as a fraction of the 16:9 shot's width. */
export const CROP_W = (9 / 16) * (SHOT_H / SHOT_W);

/** The creator's contours, around x = 0. */
const HEAD =
  "M58 214 C72 236 76 262 70 288 C66 306 58 322 46 334 C36 346 22 356 4 360 C-10 362 -22 360 -30 354 C-36 350 -38 342 -36 336 C-40 330 -42 324 -40 318 C-44 314 -46 308 -44 302 C-52 298 -58 292 -56 284 C-54 276 -50 270 -48 262 C-50 254 -50 246 -46 240 C-48 226 -46 212 -38 204 C-44 198 -40 188 -28 184 C-10 176 18 176 36 186 C50 192 58 202 58 214 Z";
const FACE_RIM =
  "M-28 184 C-40 188 -44 198 -38 204 C-46 212 -48 226 -46 240 C-50 246 -50 254 -48 262 C-50 270 -54 276 -56 284 C-58 292 -52 298 -44 302 C-46 308 -44 314 -40 318 C-42 324 -40 330 -36 336 C-38 342 -36 350 -30 354";
const BODY =
  "M-30 318 C-30 344 -32 368 -38 390 C-60 398 -96 404 -134 414 C-170 424 -196 440 -206 470 C-214 494 -216 530 -218 570 C-222 680 -226 790 -228 900 L228 900 C226 790 222 680 218 570 C216 530 214 494 206 470 C196 440 170 424 134 414 C96 404 60 398 38 390 C32 368 30 344 30 318 Z";
const SHOULDER_RIM =
  "M-38 390 C-60 398 -96 404 -134 414 C-170 424 -196 440 -206 470 C-214 494 -216 530 -218 570 C-222 680 -226 790 -228 900";

const stop = (offset: number, color: string, opacity = 1) => (
  <stop offset={offset} style={{ stopColor: `var(${color})`, stopOpacity: opacity }} />
);

/** The defs every Scene uses. Render once per page; it takes no space
 *  (0×0, not display:none, which would void its gradients). */
export function SceneSprite() {
  return (
    <svg className={styles.sprite} width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="cc-wall" x1="0" y1="0" x2="0" y2="1">
          {stop(0, "--surface-tint")}
          {stop(0.55, "--surface-1")}
          {stop(1, "--surface-0")}
        </linearGradient>
        <radialGradient id="cc-window" cx="0.1" cy="0.32" r="0.62">
          {stop(0, "--text-strong", 0.16)}
          {stop(0.45, "--text-strong", 0.05)}
          {stop(1, "--text-strong", 0)}
        </radialGradient>
        <radialGradient id="cc-violet" cx="0.32" cy="0.2" r="0.55">
          {stop(0, "--brand", 0.32)}
          {stop(1, "--brand", 0)}
        </radialGradient>
        <radialGradient id="cc-magenta" cx="0.9" cy="0.12" r="0.45">
          {stop(0, "--accent", 0.16)}
          {stop(1, "--accent", 0)}
        </radialGradient>
        <radialGradient id="cc-lamp" cx="0.5" cy="0.5" r="0.5">
          {stop(0, "--text-strong", 0.3)}
          {stop(0.35, "--text-strong", 0.08)}
          {stop(1, "--text-strong", 0)}
        </radialGradient>
        <radialGradient id="cc-bokeh" cx="0.5" cy="0.5" r="0.5">
          {stop(0, "--text-strong", 0.5)}
          {stop(0.7, "--text-strong", 0.22)}
          {stop(1, "--text-strong", 0)}
        </radialGradient>
        <radialGradient id="cc-bokeh-lilac" cx="0.5" cy="0.5" r="0.5">
          {stop(0, "--brand-strong", 0.5)}
          {stop(0.7, "--brand-strong", 0.2)}
          {stop(1, "--brand-strong", 0)}
        </radialGradient>
        <radialGradient id="cc-halo" cx="0.5" cy="0.5" r="0.5">
          {stop(0, "--text-strong", 0.13)}
          {stop(0.5, "--text-strong", 0.05)}
          {stop(1, "--text-strong", 0)}
        </radialGradient>
        <linearGradient id="cc-tone" gradientUnits="userSpaceOnUse" x1="0" y1="170" x2="0" y2="760">
          {stop(0, "--surface-1")}
          {stop(1, "--surface-0")}
        </linearGradient>
        {/* Rim light: the window is on the left, so the contour's left
            side catches it and the light dies towards the right. */}
        <linearGradient id="cc-rim" x1="0" y1="0" x2="1" y2="0">
          {stop(0, "--text-strong", 0.85)}
          {stop(0.3, "--text-strong", 0.45)}
          {stop(0.55, "--text-strong", 0)}
        </linearGradient>
        <linearGradient id="cc-rim-face" x1="0" y1="0" x2="0" y2="1">
          {stop(0, "--text-strong", 0.55)}
          {stop(0.45, "--text-strong", 0.72)}
          {stop(1, "--text-strong", 0.35)}
        </linearGradient>
        <linearGradient id="cc-rim-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.35" stopColor="#fff" />
          <stop offset="0.6" stopColor="#000" />
        </linearGradient>
        <mask id="cc-rim-mask" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" fill="url(#cc-rim-fade)" />
        </mask>
        <filter id="cc-soft" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="cc-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="cc-softer" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="14" />
        </filter>

        {/* The room: wall, window light, a lamp, a shelf, out-of-focus lights. */}
        <symbol id="cc-room" overflow="visible">
          <rect width={SHOT_W} height={SHOT_H} fill="url(#cc-wall)" />
          <rect width={SHOT_W} height={SHOT_H} fill="url(#cc-violet)" />
          <rect width={SHOT_W} height={SHOT_H} fill="url(#cc-magenta)" />
          <rect width={SHOT_W} height={SHOT_H} fill="url(#cc-window)" />
          <g filter="url(#cc-soft)">
            {/* Window on the left, light falling in. */}
            <rect x="40" y="70" width="300" height="560" rx="6" style={{ fill: "var(--text-strong)" }} opacity="0.07" />
            <rect x="186" y="70" width="8" height="560" style={{ fill: "var(--surface-0)" }} opacity="0.5" />
            <rect x="40" y="340" width="300" height="8" style={{ fill: "var(--surface-0)" }} opacity="0.5" />
            {/* Shelf with books and a plant on the right. */}
            <rect x="960" y="372" width="420" height="12" rx="3" style={{ fill: "var(--surface-0)" }} opacity="0.9" />
            <g style={{ fill: "var(--surface-2)" }}>
              <rect x="990" y="292" width="22" height="80" rx="2" />
              <rect x="1016" y="304" width="18" height="68" rx="2" />
              <rect x="1038" y="286" width="26" height="86" rx="2" />
              <rect x="1068" y="318" width="20" height="54" rx="2" transform="rotate(-12 1078 372)" />
            </g>
            <g style={{ fill: "var(--surface-0)" }} opacity="0.85">
              <path d="M1290 372 l8 -40 h44 l8 40 z" />
              {[-58, -32, -8, 14, 38, 62].map((a, i) => (
                <ellipse key={a} cx="1320" cy={286 - (i % 2) * 10} rx="16" ry="46" transform={`rotate(${a} 1320 332)`} />
              ))}
            </g>
            {/* Floor lamp behind the right shoulder. */}
            <rect x="786" y="330" width="6" height="570" style={{ fill: "var(--surface-0)" }} opacity="0.8" />
            <path d="M730 336 l28 -76 h64 l28 76 z" style={{ fill: "var(--surface-tint)" }} />
          </g>
          <circle cx="790" cy="322" r="230" fill="url(#cc-lamp)" />
          <g filter="url(#cc-softer)">
            <circle cx="430" cy="150" r="30" fill="url(#cc-bokeh)" />
            <circle cx="688" cy="120" r="22" fill="url(#cc-bokeh-lilac)" />
            <circle cx="1010" cy="196" r="36" fill="url(#cc-bokeh)" />
            <circle cx="1240" cy="110" r="26" fill="url(#cc-bokeh-lilac)" />
            <circle cx="1470" cy="260" r="40" fill="url(#cc-bokeh)" />
            <circle cx="600" cy="560" r="20" fill="url(#cc-bokeh-lilac)" />
            <circle cx="1130" cy="560" r="28" fill="url(#cc-bokeh)" />
          </g>
          {/* A desk edge at the bottom of the shot. */}
          <rect y="842" width={SHOT_W} height="58" style={{ fill: "var(--surface-0)" }} opacity="0.7" />
        </symbol>

        {/* The creator, drawn around x = 0 (the scene places them). The
            rim light sits inside the contour (clipped), like light
            catching an edge, not an outline. */}
        <clipPath id="cc-body-clip">
          <path d={BODY} />
        </clipPath>
        <clipPath id="cc-head-clip">
          <path d={HEAD} />
        </clipPath>
        <symbol id="cc-body" overflow="visible">
          <ellipse cx="0" cy="250" rx="210" ry="230" fill="url(#cc-halo)" />
          <path d={BODY} fill="url(#cc-tone)" />
          {/* Hood bunched behind the neck, drawstrings, a lav mic. */}
          <path
            d="M-88 410 C-72 384 -36 376 0 376 C36 376 72 384 88 410 C62 428 -62 428 -88 410 Z"
            style={{ fill: "var(--surface-1)" }}
          />
          <path
            d="M-15 422 C-17 452 -20 486 -22 520 M16 422 C18 450 21 482 24 512"
            fill="none"
            style={{ stroke: "var(--surface-2)" }}
            strokeWidth="4"
            strokeLinecap="round"
          />
          <rect x="-58" y="478" width="10" height="14" rx="3" style={{ fill: "var(--surface-2)" }} />
          <g clipPath="url(#cc-body-clip)" mask="url(#cc-rim-mask)">
            <path d={SHOULDER_RIM} fill="none" stroke="url(#cc-rim)" strokeWidth="9" strokeLinecap="round" />
          </g>
        </symbol>
        <symbol id="cc-head" overflow="visible">
          {/* Three-quarter view, turned towards the window: brow, nose,
              lips and chin catch the light on the left. */}
          <path d={FACE_RIM} fill="none" stroke="url(#cc-rim-face)" strokeWidth="12" opacity="0.3" filter="url(#cc-glow)" />
          <path d={HEAD} fill="url(#cc-tone)" />
          <g clipPath="url(#cc-head-clip)">
            <path d={FACE_RIM} fill="none" stroke="url(#cc-rim-face)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M-28 184 C-10 176 18 176 36 186" fill="none" stroke="url(#cc-rim)" strokeWidth="6" strokeLinecap="round" />
          </g>
        </symbol>
      </defs>
    </svg>
  );
}

export type ScenePose = "left" | "center" | "right";
const POSE_DEG: Record<ScenePose, number> = { left: -3, center: 0, right: 4 };

/**
 * One frame's view of the shot. `crop="vertical"` shows a 9:16 crop
 * centred on the creator (the frame must be 9:16); `crop="wide"` the
 * whole 16:9 shot. `creatorShift` moves the creator sideways (fraction
 * of the shot's width); `cameraShift` moves a vertical crop the same way.
 */
export function Scene({
  crop = "vertical",
  pose = "center",
  talking = false,
  className,
  creatorRef,
  cameraRef,
  headRef,
}: {
  crop?: "vertical" | "wide";
  pose?: ScenePose;
  /** The creator nods slightly, as when speaking. */
  talking?: boolean;
  className?: string;
  creatorRef?: React.Ref<HTMLDivElement>;
  cameraRef?: React.Ref<HTMLDivElement>;
  headRef?: React.Ref<HTMLDivElement>;
}) {
  const style = {
    "--cx": CREATOR_X,
    "--neck": NECK_Y / SHOT_H,
    "--pose": `${POSE_DEG[pose]}deg`,
  } as React.CSSProperties;
  return (
    <div
      className={cx(styles.scene, className)}
      data-crop={crop}
      data-talking={talking || undefined}
      style={style}
      aria-hidden="true"
    >
      <div ref={cameraRef} className={styles.camera}>
        <svg className={styles.layer} viewBox={`0 0 ${SHOT_W} ${SHOT_H}`} preserveAspectRatio="xMidYMid slice">
          <use href="#cc-room" />
        </svg>
        <div ref={creatorRef} className={styles.creator}>
          <svg className={styles.layer} viewBox={`0 0 ${SHOT_W} ${SHOT_H}`} preserveAspectRatio="xMidYMid slice">
            <use href="#cc-body" x={CREATOR_X * SHOT_W} />
          </svg>
          <div ref={headRef} className={styles.head}>
            <svg className={styles.layer} viewBox={`0 0 ${SHOT_W} ${SHOT_H}`} preserveAspectRatio="xMidYMid slice">
              <use href="#cc-head" x={CREATOR_X * SHOT_W} />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
