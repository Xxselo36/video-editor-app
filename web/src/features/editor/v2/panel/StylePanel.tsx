"use client";
/**
 * "Style" (UX7 placeholder): the 12 caption styles of the engine as static
 * tiles over a frame of the user's video, the job's style marked. Live
 * switching, the recommended row and "Customize" come with UT5
 * (features/captions-ui StylePanel) into this tab.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useLang, useT } from "@/i18n";
import { migratePresetId } from "@/lib/captions/migrate";
import { presetName } from "@/lib/captions/presetNames";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import s from "../editor.module.css";

/** The video's current frame, cropped to the tile (neck/chest band). */
function FrameCanvas({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    const c = ref.current;
    if (!v || !c) return;
    const draw = () => {
      if (v.readyState < 2 || !v.videoWidth) return false;
      const W = (c.width = c.clientWidth * 2 || 200);
      const H = (c.height = c.clientHeight * 2 || 144);
      const ctx = c.getContext("2d");
      if (!ctx) return true;
      // cover, anchored at 66 % of the height (mock: object-position 50% 66%)
      const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      try {
        ctx.drawImage(v, (W - w) / 2, (H - h) * 0.66, w, h);
      } catch {
        /* not decodable yet */
      }
      return true;
    };
    if (draw()) return;
    const once = () => {
      if (draw()) v.removeEventListener("loadeddata", once);
    };
    v.addEventListener("loadeddata", once);
    v.addEventListener("seeked", once);
    return () => {
      v.removeEventListener("loadeddata", once);
      v.removeEventListener("seeked", once);
    };
  }, [videoRef]);
  return <canvas ref={ref} aria-hidden />;
}

export function StylePanel({
  captionPreset,
  videoRef,
}: {
  captionPreset: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const t = useT();
  const lang = useLang();
  const current = migratePresetId(captionPreset).presetId;
  return (
    <div className={`${s.scroll} ${s.styleScroll}`} data-testid="ed-style">
      <div className={s.label}>{t("editor.style.heading")}</div>
      <ul className={s.tiles}>
        {LAUNCH_PRESETS.map((id) => (
          <li key={id} className={s.tile} aria-current={id === current ? "true" : undefined} data-testid={`ed-tile-${id}`}>
            <span className={s.tileImg}>
              <FrameCanvas videoRef={videoRef} />
              <span className={s.tileRing} />
            </span>
            <span className={s.tileName}>{presetName(id, lang).name}</span>
          </li>
        ))}
      </ul>
      <p className={s.note}>{t("editor.style.note")}</p>
    </div>
  );
}
