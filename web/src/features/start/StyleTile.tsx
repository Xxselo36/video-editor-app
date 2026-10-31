"use client";
/**
 * One caption style on "Untertitel wählen" (D8): the caption band of the
 * user's own frame, in the format the video gets, with "Hallo zusammen"
 * in the style, drawn by the real caption engine (captions-ui/snapshot,
 * shared with the editor's Style tab). Drawn once it is near the
 * viewport; until the video's frame is decoded on the neutral backdrop,
 * then again with the frame, which fades in over it. A soft light runs
 * over the band while its fonts load. A style that can't write the UI
 * language's script shows the English sample.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { drawCaptionSnapshot, sampleWords } from "@/features/captions-ui/snapshot";
import { loadEngine } from "@/features/landing/captions/engine";
import { translate, useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { presetSupport } from "@/lib/captions/scripts";
import type { PresetId } from "@/lib/captions/types";
import type { StyleChoice } from "./choices";
import { useStartActions } from "./pendingStart";
import s from "./start.module.css";

type TileProps = {
  presetId: PresetId;
  /** What the tile draws and a tap picks ("Dein Standard" with its look). */
  look: StyleChoice;
  selected: boolean;
  /** The group's one Tab stop (roving tabindex). */
  tabbable: boolean;
  tag: MessageKey | undefined;
  frame: HTMLImageElement | null;
  /** The format the video gets (choices.ts outputShape; unknown: the frame's). */
  shape: { width: number; height: number } | undefined;
  /** POST /jobs is out: the choice can't change any more. */
  locked: boolean;
};

export const StyleTile = memo(function StyleTile({ presetId, look, selected, tabbable, tag, frame, shape, locked }: TileProps) {
  const t = useT();
  const lang = useLang();
  const { setChoices } = useStartActions();
  const tagId = useId();
  const band = useRef<HTMLSpanElement>(null);
  const plain = useRef<HTMLCanvasElement>(null);
  const framed = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const own = presetSupport(presetId, lang).level !== "unavailable";
  const sample = own ? t("app.start.styleSample") : translate("en", "app.start.styleSample");
  const drawLang = own ? lang : "en";
  const words = useMemo(() => sampleWords(sample.split(" "), presetId), [sample, presetId]);

  useEffect(() => {
    const el = band.current;
    // The frame's drawing goes on its own canvas, above the plain one.
    const canvas = frame ? framed.current : plain.current;
    if (!el || !canvas) return;
    const ac = new AbortController();
    const draw = async () => {
      const engine = await loadEngine().catch(() => null);
      if (!engine || ac.signal.aborted) return;
      const drawn = await drawCaptionSnapshot(
        canvas,
        {
          engine,
          presetId,
          overrides: look.overrides,
          frame,
          frameW: frame?.naturalWidth ?? 0,
          frameH: frame?.naturalHeight ?? 0,
          shape,
          words,
          lang: drawLang,
          crop: "band",
        },
        { signal: ac.signal, onFontsLoading: () => setState((st) => (st === "done" ? st : "loading")) },
      );
      if (ac.signal.aborted) return;
      if (!drawn.ok) {
        // Its fonts didn't load: the backdrop stays, without the shimmer.
        setState((st) => (st === "loading" ? "idle" : st));
        return;
      }
      canvas.dataset.drawn = "";
      setState("done");
    };
    // Fonts load only for a tile that is (nearly) on screen.
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void draw();
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => {
      ac.abort();
      io.disconnect();
    };
  }, [presetId, look, frame, shape, words, drawLang]);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={locked || undefined}
      aria-describedby={tag ? tagId : undefined}
      tabIndex={tabbable ? 0 : -1}
      className={s.tile}
      data-testid={`start-style-${presetId}`}
      data-style={presetId}
      data-state={state}
      onClick={() => {
        if (!locked && !selected) setChoices((c) => ({ ...c, style: look }));
      }}
    >
      <span ref={band} className={s.band} aria-hidden>
        <canvas ref={plain} />
        <canvas ref={framed} />
        {state === "loading" && <span className={s.shimmer} />}
      </span>
      <span className={s.tname}>{t(`editor.style.preset.${presetId}` as MessageKey)}</span>
      {tag && (
        <span id={tagId} className={s.tag} aria-hidden data-testid="start-style-tag">
          {t(tag)}
        </span>
      )}
    </button>
  );
});
