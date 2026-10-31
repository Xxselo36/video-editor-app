"use client";
/**
 * Desktop: the video with the picked style (mockup 2-untertitel-desktop)
 * in the format it gets (Hochkant 9:16, Quer 16:9, Original its own),
 * the frame covering it. The caption engine draws the style on the whole
 * frame (captions-ui/snapshot); a new drawing fades in over the last.
 * "Ohne Untertitel": the frame alone. Decorative: the tiles are the
 * choice.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { drawCaptionSnapshot, sampleWords } from "@/features/captions-ui/snapshot";
import { loadEngine } from "@/features/landing/captions/engine";
import { translate, useLang, useT } from "@/i18n";
import { presetSupport } from "@/lib/captions/scripts";
import { outputShape } from "./choices";
import { useStartView } from "./pendingStart";
import s from "./start.module.css";

export function StylePreview({ frame }: { frame: HTMLImageElement | null }) {
  const t = useT();
  const lang = useLang();
  const { start } = useStartView();
  const { choices, probe } = start;
  const { presetId, overrides } = choices.style;
  const shape = outputShape(choices, probe);
  const ratio = shape ? shape.width / shape.height : 9 / 16;
  const one = useRef<HTMLCanvasElement>(null);
  const two = useRef<HTMLCanvasElement>(null);
  const own = presetSupport(presetId, lang).level !== "unavailable";
  const sample = own ? t("app.start.styleSample") : translate("en", "app.start.styleSample");
  const drawLang = own ? lang : "en";

  useEffect(() => {
    const a = one.current;
    const b = two.current;
    if (!a || !b) return;
    if (presetId === "none") {
      delete a.dataset.drawn;
      delete b.dataset.drawn;
      return;
    }
    // Drawn on the canvas that isn't showing, which then shows instead.
    const next = a.dataset.drawn === undefined ? a : b;
    const last = next === a ? b : a;
    const ac = new AbortController();
    void (async () => {
      const engine = await loadEngine().catch(() => null);
      if (!engine || ac.signal.aborted) return;
      const drawn = await drawCaptionSnapshot(
        next,
        {
          engine,
          presetId,
          overrides,
          frame,
          frameW: frame?.naturalWidth ?? 0,
          frameH: frame?.naturalHeight ?? 0,
          words: sampleWords(sample.split(" "), presetId),
          lang: drawLang,
          crop: "frame",
        },
        { signal: ac.signal },
      );
      if (!drawn.ok || ac.signal.aborted) return;
      next.dataset.drawn = "";
      delete last.dataset.drawn;
    })();
    return () => ac.abort();
  }, [presetId, overrides, frame, ratio, sample, drawLang]);

  return (
    <div className={s.preview} style={{ "--ar": ratio } as CSSProperties} data-testid="start-preview" aria-hidden>
      {frame && <div className={s.picture} style={{ backgroundImage: `url("${frame.src}")` }} />}
      <canvas ref={one} />
      <canvas ref={two} />
    </div>
  );
}
