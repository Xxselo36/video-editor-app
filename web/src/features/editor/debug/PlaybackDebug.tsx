"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { useEffect, useRef, useState } from "react";

// Temporary playback diagnostics, shown only with ?debug=1 in the URL.
// Distinguishes network stalls (waiting events), decoder drops and
// main-thread jank so we know which layer causes the hitches.
export function PlaybackDebug({
  videoRef,
  mode,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).has("debug"));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const v = videoRef.current;
    if (!v) return;
    let waits = 0;
    let janks = 0;
    let worstJank = 0;
    const log: string[] = [];
    const push = (s: string) => {
      log.unshift(`${v.currentTime.toFixed(2)}s ${s}`);
      log.length = Math.min(log.length, 5);
    };
    const onWaiting = () => {
      waits++;
      push("WAITING (buffer)");
    };
    const onStalled = () => push("STALLED (network)");
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onStalled);
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      if (!v.paused && dt > 120) {
        janks++;
        worstJank = Math.max(worstJank, dt);
        push(`JANK ${Math.round(dt)}ms (UI)`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const iv = setInterval(() => {
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
          ahead = v.buffered.end(i) - v.currentTime;
        }
      }
      const q = v.getVideoPlaybackQuality?.();
      setText(
        [
          `${modeRef.current ?? ""} ${v.paused ? "paused" : "playing"} · ready=${v.readyState} · buffer +${ahead.toFixed(1)}s · ${v.playbackRate}×`,
          `waits=${waits} · janks=${janks} (max ${Math.round(worstJank)}ms)`,
          `dropped=${q?.droppedVideoFrames ?? "?"}/${q?.totalVideoFrames ?? "?"}`,
          ...log,
        ].join("\n"),
      );
    }, 300);
    return () => {
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onStalled);
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, [enabled, videoRef]);
  if (!enabled) return null;
  return (
    <pre className="pointer-events-none absolute left-2 top-2 z-30 whitespace-pre rounded-md bg-black/75 p-2 font-mono text-[10px] leading-tight text-green-300">
      {text}
    </pre>
  );
}
