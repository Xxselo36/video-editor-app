/**
 * The landing's one recording: a creator on his sofa, packing for a trip
 * and talking to the camera (stock photos by Gustavo Fring on Pexels,
 * free to use; every frame that shows him carries the "Example" tag, so
 * he is never presented as a customer). Each frame on the page is a
 * moment of that one shoot, so the frames read as one video at different
 * stages of the edit.
 *
 * The photos are stills: what moves is the edit around them (captions,
 * the crop window, the tape). While a caption plays the camera pushes in
 * slowly on his face, as edited talking-head videos do; that is video
 * content (brand SKILL.md, Motion).
 *
 * Files: public/landing/creator/<shot>-{360,720}.webp (9:16 crops, cropped
 * and graded from the originals) and wide-{800,1400}.webp (the 16:9 take
 * the format section reframes). Each shot inlines a 12 px preview as its
 * background, so a frame is never empty while the photo loads.
 */
import { cx } from "@/components/ui/cx";
import styles from "./Scene.module.css";

export type ShotId = "talk" | "globe" | "map" | "shirt" | "passport";

/** A 9:16 crop: its preview and where his face is (fractions of the crop),
 *  the point the push-in closes on. */
const SHOTS: Record<ShotId, { lqip: string; face: readonly [number, number] }> = {
  talk: {
    lqip: "data:image/webp;base64,UklGRoYAAABXRUJQVlA4IHoAAACwBACdASoMABUAPu1kqk2ppaQiMAgBMB2JZQBTBfgP/+AwNfXFMpcj8M2s1jlQAP7qaF9CiORjB53I/TJfPIdswo+x6+7GU5fxfKlL8muwwe9O2Wzr9IdpV5Oavon2aaZmL+mqpdbM1kHmGgWKTZCEsdNgXfnVZFQAAA==",
    face: [0.53, 0.33],
  },
  globe: {
    lqip: "data:image/webp;base64,UklGRo4AAABXRUJQVlA4IIIAAABwBACdASoMABUAPu1kqk2ppaQiMAgBMB2JZQAD5AoSPhU9TiYT33LfwUSXAAD+6o6d44GXbhAe0krVFIMZ8EqTB4aZxUsHYGbWPoJYBvleJyBwdKXN+vrdWXLkZ1y1WJMJfgXuCvhk1audq/P6X9dhiunQtISQDK26du3HfCP9wAAA",
    face: [0.48, 0.28],
  },
  map: {
    lqip: "data:image/webp;base64,UklGRoAAAABXRUJQVlA4IHQAAABwAwCdASoMABUALrV2u12jqampiYC0SgDKAEO/32osfQbA47wA/vOBdDHg1OM13dfhKmUgahX+W5u7WBzOeQD/F0DhlaSVPRV2Fzsu8gKZqVGtnCzSjU2TLj4wWLHTHMKlzrb4Avb17iWxYP0JTNtEvJFgAA==",
    face: [0.76, 0.29],
  },
  shirt: {
    lqip: "data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAACwAwCdASoMABUAPu1kqU2ppaOiMAgBMB2JZwAAXKdJnz8IX+u6EAD+6o/VJKLN6tfjWeJbx4zp7s+y+GbsjmfTvHJymmcOnPIHHlMarC1vwKbMhpjiSMJPXldfej0xv3NC+tnxk14oAA==",
    face: [0.74, 0.33],
  },
  passport: {
    lqip: "data:image/webp;base64,UklGRpYAAABXRUJQVlA4IIoAAABQBACdASoMABUAPu1iqU2ppaOiMAgBMB2JZQAjwACqiDxuiua0IhaesT7gAP7qltvrmuR1kkJ4cTJrPTqVzFgK873jDxvSQWOqhq8t6U2KW5hR+gRVDf1+xNaaPM0Lz5iFc4m3Pz4oO0YWb7Ruvv8k0r+Iuv14Hgc1jeP/AxR+fDJaFwc+aosAAAA=",
    face: [0.55, 0.26],
  },
};

/** The 16:9 take and the face in it (fractions of the take): centre and
 *  size, where the format section's face box goes. */
export const WIDE = {
  lqip: "data:image/webp;base64,UklGRlAAAABXRUJQVlA4IEQAAADQAQCdASoMAAcAA4BaJZQAAudCan5dgAD+84F0Z/iLvuSF60xggClSt7Ym5eJmTzNI26GNpMO2Gf6ctNH759FT3WAAAA==",
  face: { x: 0.69, y: 0.39, w: 0.2, h: 0.44 },
} as const;

/** A 9:16 crop's width as a fraction of a 16:9 shot's width. */
export const CROP_W = (9 / 16) * (9 / 16);

const SRC = "/landing/creator";

/**
 * One frame of the recording.
 * - `crop="vertical"` (default): a 9:16 frame showing `shot`.
 * - `crop="wide"`: a 16:9 frame showing the whole take.
 * - `crop="track"`: a 9:16 frame cut from the 16:9 take, centred on his
 *   face; the take is the `cameraRef` element, so the format section can
 *   slide it under the frame.
 * `sizes` is the frame's rendered width (for srcset); `priority` loads it
 * eagerly (the hero).
 */
export function Scene({
  shot = "talk",
  crop = "vertical",
  talking = false,
  sizes = "16rem",
  priority = false,
  className,
  cameraRef,
}: {
  shot?: ShotId;
  crop?: "vertical" | "wide" | "track";
  /** He is speaking: the camera pushes in on his face. */
  talking?: boolean;
  sizes?: string;
  priority?: boolean;
  className?: string;
  cameraRef?: React.Ref<HTMLDivElement>;
}) {
  const wide = crop !== "vertical";
  const lqip = wide ? WIDE.lqip : SHOTS[shot].lqip;
  const [fx, fy] = wide ? [WIDE.face.x, WIDE.face.y] : SHOTS[shot].face;
  const name = wide ? "wide" : shot;
  const widths = wide ? [800, 1400] : [360, 720];
  const style = {
    "--cx": WIDE.face.x,
    "--fx": `${fx * 100}%`,
    "--fy": `${fy * 100}%`,
    backgroundImage: lqip ? `url("${lqip}")` : undefined,
  } as React.CSSProperties;
  return (
    <div
      className={cx(styles.scene, className)}
      data-crop={crop}
      data-talking={talking || undefined}
      style={style}
      aria-hidden="true"
    >
      <div ref={cameraRef} className={styles.camera} data-part="camera">
        {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized webp crops, no optimizer needed */}
        <img
          className={styles.photo}
          src={`${SRC}/${name}-${widths[1]}.webp`}
          srcSet={widths.map((w) => `${SRC}/${name}-${w}.webp ${w}w`).join(", ")}
          sizes={crop === "track" ? `calc(${sizes} * 16 / 9 * 16 / 9)` : sizes}
          alt=""
          draggable={false}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
        />
      </div>
    </div>
  );
}
