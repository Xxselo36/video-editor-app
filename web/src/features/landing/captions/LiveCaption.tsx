"use client";
/**
 * A caption drawn by the real engine on a transparent canvas over a
 * frame (the frame's Scene shows through). It plays the sample sentence
 * with the style's own pages, entrance and highlight, exactly as the
 * export draws them.
 *
 * - The engine and the style's font load once the frame is near the
 *   viewport. Until then (or if they fail) `children` show: a CSS poster
 *   of the settled caption, so a frame is never empty.
 * - `playing` advances the caption's clock on the page's one rAF ticker;
 *   when false the current frame holds (first time: the settled last
 *   word). Loops after the last word plus `hold`; with `loop={false}` it
 *   plays once, holds the settled last page and leaves the ticker.
 * - `restartKey` starts over from the first word (a style switch).
 * - The handle lets a score (the hero) seek the clock.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PresetId, StyleOverrides } from "@/lib/captions/types";
import type { CaptionRenderer } from "@/lib/captions/cache";
import { cx } from "@/components/ui/cx";
import { loadEngine } from "./engine";
import { subscribe } from "./ticker";
import { captionWords, spokenUntil } from "./words";
import styles from "./LiveCaption.module.css";

export type LiveCaptionHandle = {
  /** Jump to time `t` (seconds from the first word's lead-in). */
  seek(t: number): void;
  /** The last word's end plus the hold. */
  readonly duration: number;
};

export function LiveCaption({
  preset,
  overrides,
  text,
  lang,
  playing,
  loop = true,
  hold = 1,
  restartKey,
  onCycle,
  onReady,
  className,
  handle,
  children,
}: {
  preset: PresetId;
  /** Style overrides (e.g. a larger size on a small frame). */
  overrides?: StyleOverrides;
  text: string;
  lang: string;
  playing: boolean;
  loop?: boolean;
  hold?: number;
  restartKey?: string | number;
  onCycle?: () => void;
  onReady?: () => void;
  className?: string;
  handle?: React.Ref<LiveCaptionHandle>;
  /** The CSS poster shown until the engine draws. */
  children?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const words = useMemo(() => captionWords(text, lang), [text, lang]);
  const end = spokenUntil(words) + hold;
  // The settled frame: the last word fully spoken (karaoke fills it).
  const lastEnd = spokenUntil(words);
  const poster = words.length ? Math.max(words[words.length - 1].start + 0.3, lastEnd - 0.02) : 0;
  const overridesKey = JSON.stringify(overrides ?? {});
  const [ready, setReady] = useState(false);
  const live = useRef({
    renderer: null as CaptionRenderer | null,
    t: poster,
    started: false,
    done: false,
    end,
    poster,
    lastEnd,
    loop,
    onCycle,
  });
  useEffect(() => {
    live.current.end = end;
    live.current.poster = poster;
    live.current.lastEnd = lastEnd;
    live.current.loop = loop;
    live.current.onCycle = onCycle;
  });

  const draw = (force = false) => {
    const L = live.current;
    const ctx = canvasRef.current?.getContext("2d");
    if (!L.renderer || !ctx) return;
    // during the hold after the last word, keep its page on screen
    L.renderer.drawFrame(ctx as never, Math.min(L.t, L.lastEnd - 0.02), { force });
  };

  useImperativeHandle(
    handle,
    () => ({
      seek(t: number) {
        live.current.t = Math.max(0, t);
        live.current.started = true;
        draw();
      },
      get duration() {
        return live.current.end;
      },
    }),
    [],
  );

  // Engine, font and renderer: when the frame is near, and again for a
  // new style, text, language or size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    let alive = true;
    let size = { W: 0, H: 0 };
    let near = false;
    const build = async () => {
      if (!near || !size.W || !size.H) return;
      const { W, H } = size;
      const engine = await loadEngine().catch(() => null);
      if (!alive || !engine) return;
      const style = engine.resolveStyle(preset, JSON.parse(overridesKey) as StyleOverrides, { W, H });
      if (!style) return;
      const fonts = await engine.ensureFonts(style, { lang, text: words.map((w) => w.text) }).catch(() => null);
      if (!alive || !fonts?.ok || size.W !== W || size.H !== H) return;
      canvas.width = W;
      canvas.height = H;
      live.current.renderer?.dispose();
      live.current.renderer = new engine.CaptionRenderer({ words, style, W, H, lang });
      draw(true);
      setReady(true);
      onReady?.();
    };
    const ro = new ResizeObserver(([entry]) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(entry.contentRect.width * dpr);
      const H = Math.round(entry.contentRect.height * dpr);
      if (W === size.W && H === size.H) return;
      size = { W, H };
      void build();
    });
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          near = true;
          void build();
        }
      },
      { rootMargin: "800px 0px" },
    );
    ro.observe(canvas);
    io.observe(canvas);
    const L = live.current;
    return () => {
      alive = false;
      ro.disconnect();
      io.disconnect();
      L.renderer?.dispose();
      L.renderer = null;
    };
    // onReady is a notification; a new one must not rebuild the renderer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, lang, words, overridesKey]);

  // A new style or sentence starts from its first word.
  useEffect(() => {
    live.current.t = playing ? 0 : poster;
    live.current.started = playing;
    live.current.done = false;
    draw(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartKey, preset, words]);

  // The clock. A one-pass caption leaves the ticker when it is done (the
  // page can idle); a restart (the effect above, which runs first) clears
  // `done` and this one subscribes again.
  useEffect(() => {
    if (!playing || !ready) return;
    const L = live.current;
    if (L.done) return;
    if (!L.started) {
      L.t = 0;
      L.started = true;
    }
    const stop = subscribe((dt) => {
      L.t += dt;
      if (L.t >= L.end) {
        if (L.loop) {
          L.t = 0;
          L.onCycle?.();
        } else {
          // one pass: hold the settled last page until restarted
          L.t = L.poster;
          L.done = true;
          stop();
        }
      }
      draw();
    });
    return stop;
  }, [playing, ready, restartKey, preset, words]);

  return (
    <span className={cx(styles.live, className)} data-ready={ready} aria-hidden="true">
      {children && <span className={styles.poster}>{children}</span>}
      <canvas ref={canvasRef} className={styles.canvas} />
    </span>
  );
}
