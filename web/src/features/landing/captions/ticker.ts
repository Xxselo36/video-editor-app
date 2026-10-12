/**
 * One requestAnimationFrame loop for every live caption on the page. It
 * runs only while something subscribes; each subscriber gets the frame's
 * time step in seconds (capped, so a background tab doesn't jump).
 */
type Tick = (dt: number) => void;

const subs = new Set<Tick>();
let raf = 0;
let last = 0;

function frame(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  for (const fn of subs) fn(dt);
  raf = subs.size ? requestAnimationFrame(frame) : 0;
  if (!raf) last = 0;
}

export function subscribe(fn: Tick): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(frame);
  return () => {
    subs.delete(fn);
  };
}
