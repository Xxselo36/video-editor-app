/**
 * The Captions Ring's geometry and timing (CaptionPlayer.tsx), kept pure
 * so ring.test.ts can sample it.
 *
 * Three 9:16 frames stand on a ring seen from slightly above: one in
 * front, one right and one left, 120° apart. A frame's pose is two
 * angles: `a`, where it stands on the ring (+ is right), and `f`, its own
 * turn back toward the viewer. Its transform is always the same three
 * functions, rotateY(a) translateZ(R) rotateY(f), so every keyframe
 * between two poses interpolates angle by angle and the frame travels
 * along the circle (a different function list would cut straight through
 * the ring). At rest f = -0.75a: a side frame faces a/4 = 30° outward,
 * readable and about 70 % visible.
 *
 * A turn moves every frame the shortest way to its new slot. The frame
 * that wraps round goes behind the ring; its facing changes linearly
 * from one side's 30° to the other's, so it never shows its back, and it
 * fades out while it is behind (faceOpacity), so it never shows through
 * the gap between the two frames that pass in front of it.
 */

/** The slots: front, right, left. */
export type Slot = 0 | 1 | 2;
export const SLOT_NAME = ["front", "right", "left"] as const;
/** Each slot's place on the ring (degrees). */
export const SLOT_ANGLE = [0, 120, -120] as const;

export type Pose = { a: number; f: number };

/** An angle in (-180, 180]. */
export function norm(a: number): number {
  const x = ((((a + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}

export function restPose(slot: Slot): Pose {
  const a = SLOT_ANGLE[slot];
  return { a, f: -0.75 * a };
}

/** Which way the frame faces (0: straight at the viewer). */
export function facing(p: Pose): number {
  return p.a + p.f;
}

/** Where a frame at `now` goes to stand in `slot`: the shortest way round,
 *  ending in the slot's rest pose (equal to it modulo 360°). */
export function target(now: Pose, slot: Slot): Pose {
  const s = SLOT_ANGLE[slot];
  const a = now.a + norm(s - now.a);
  return { a, f: s / 4 - a };
}

/** The pose a share `p` (0..1, eased) of the way from `from` to `to`. */
export function lerpPose(from: Pose, to: Pose, p: number): Pose {
  return { a: from.a + (to.a - from.a) * p, f: from.f + (to.f - from.f) * p };
}

/** Behind the ring, past this angle from the front, a frame is gone. */
export const FADE_TO = 150;

/** The frame's opacity at `a`: whole at the sides, gone behind the ring. */
export function faceOpacity(a: number): number {
  const d = Math.abs(norm(a));
  if (d <= 120) return 1;
  if (d >= FADE_TO) return 0;
  return (FADE_TO - d) / (FADE_TO - 120);
}

/** The veil over a side frame (a --surface-0 wash): none in front, half
 *  at the sides, so the front frame reads first. */
export const SIDE_VEIL = 0.5;

export function veilOpacity(a: number): number {
  return (SIDE_VEIL * Math.min(120, Math.abs(norm(a)))) / 120;
}

/** The transform of a pose, R in px. */
export function poseTransform(p: Pose, r: number): string {
  return `rotateY(${round(p.a)}deg) translateZ(${round(r)}px) rotateY(${round(p.f)}deg)`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The angles on the way from a0 to a1 where faceOpacity or veilOpacity
 *  bends, as shares of the way (0 and 1 included): keyframes there make
 *  the linear interpolation between them exact. */
export function bends(a0: number, a1: number): number[] {
  const out = new Set<number>([0, 1]);
  if (a0 !== a1) {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    for (const b of [0, 120, -120, FADE_TO, -FADE_TO, 180]) {
      for (let x = b + 360 * Math.ceil((lo - b) / 360); x < hi; x += 360) {
        if (x > lo) out.add((x - a0) / (a1 - a0));
      }
    }
  }
  return [...out].sort((x, y) => x - y);
}

export type MoveKeyframes = { transform: Keyframe[]; face: Keyframe[]; veil: Keyframe[] };

/**
 * One frame's keyframes from `from` to `to`, linear: the easing goes on
 * the effect, so an offset is a share of the way, and the opacities stay
 * functions of where the frame is. `face0` / `veil0` are the frame's
 * opacities on screen now (an interrupted move starts from them).
 */
export function moveKeyframes(from: Pose, to: Pose, r: number, face0: number, veil0: number): MoveKeyframes {
  const offsets = bends(from.a, to.a);
  const at = (o: number) => from.a + (to.a - from.a) * o;
  return {
    transform: [{ transform: poseTransform(from, r) }, { transform: poseTransform(to, r) }],
    face: offsets.map((o) => ({ offset: o, opacity: o === 0 ? face0 : faceOpacity(at(o)) })),
    veil: offsets.map((o) => ({ offset: o, opacity: o === 0 ? veil0 : veilOpacity(at(o)) })),
  };
}

/* ── Timing ── */

/** A turn of the ring between two styles (ms), and one the visitor asked
 *  for (a pick: quicker, it answers a click). */
export const TURN_MS = 1200;
export const PICK_MS = 800;
/** The first reveal: the side frames swing out from behind the front one,
 *  left first, then right. */
export const FAN_FROM = 12;
export const FAN_MS = 900;
export const FAN_STAGGER_MS = 200;

/** The settled page after the last word of each pass (s). */
export const HOLD = 0.6;
/** How long a style stays in front: whole passes, at least this long. */
export const MIN_DWELL = 4.5;
export const MAX_DWELL = 8;

/** Passes of the caption (each `pass` seconds long) before the next turn. */
export function passesFor(pass: number): number {
  if (pass <= 0) return 1;
  let n = Math.max(1, Math.ceil(MIN_DWELL / pass));
  while (n > 1 && n * pass > MAX_DWELL) n -= 1;
  return n;
}
