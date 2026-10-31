"use client";
/**
 * The caption styles (D4, D8): the live presets as tiles in launch order
 * and "Ohne Untertitel" under them, one radio group. The arrow keys move
 * by the grid's columns and pick as they go, Home and End go to the
 * ends. "Dein Standard" and "Zuletzt benutzt" are chips on their tiles
 * (on the "Ohne Untertitel" row, at its end).
 */
import { CaptionsOff } from "lucide-react";
import { useMemo, useRef, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { outputShape, tileStyle, type StyleChoice } from "./choices";
import { useStartActions, useStartView } from "./pendingStart";
import { StyleTile } from "./StyleTile";
import s from "./start.module.css";

export function StylePicker({ labelledBy, frame }: { labelledBy: string; frame: HTMLImageElement | null }) {
  const t = useT();
  const { start, tiles, tags, standard } = useStartView();
  const { setChoices } = useStartActions();
  const group = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const selected = start.choices.style.presetId;
  // POST /jobs has the choices (read when it went out): no changes.
  const locked = start.sent || start.starting;
  // What each radio picks: "Dein Standard" with its look, the rest plain.
  const looks = useMemo(
    () => new Map<string, StyleChoice>([...tiles, "none"].map((id) => [id, tileStyle(id, standard)])),
    [tiles, standard],
  );
  // The tiles lay their caption out in the format the video gets (a wide
  // video made Hochkant shows Hochkant captions), as the result has them.
  const out = outputShape(start.choices, start.probe);
  const ow = out?.width ?? 0;
  const oh = out?.height ?? 0;
  const shape = useMemo(() => (ow && oh ? { width: ow, height: oh } : undefined), [ow, oh]);
  // The group's one Tab stop: the picked style (or the first, should it
  // not be offered).
  const stop = looks.has(selected) ? selected : (tiles[0] ?? "none");
  const pick = (id: string) => {
    const look = looks.get(id);
    if (look && !locked && id !== selected) setChoices((c) => ({ ...c, style: look }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const radios = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const i = radios.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || !grid.current) return;
    const cols = getComputedStyle(grid.current).gridTemplateColumns.split(" ").length;
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    let j: number;
    if (e.key === "Home") j = 0;
    else if (e.key === "End") j = radios.length - 1;
    else if (e.key in steps) j = Math.max(0, Math.min(radios.length - 1, i + steps[e.key]));
    else return;
    e.preventDefault();
    radios[j].focus();
    pick(radios[j].dataset.style ?? "");
  };

  const noneTag = tags.none;
  return (
    <div ref={group} role="radiogroup" aria-labelledby={labelledBy} className={s.styles} onKeyDown={onKeyDown}>
      <div ref={grid} className={s.grid}>
        {tiles.map((id) => (
          <StyleTile
            key={id}
            presetId={id}
            look={looks.get(id)!}
            selected={selected === id}
            tabbable={stop === id}
            tag={tags[id]}
            frame={frame}
            shape={shape}
            locked={locked}
          />
        ))}
      </div>
      <button
        type="button"
        role="radio"
        aria-checked={selected === "none"}
        aria-disabled={locked || undefined}
        aria-describedby={noneTag ? "start-style-none-tag" : undefined}
        tabIndex={stop === "none" ? 0 : -1}
        className={s.off}
        data-testid="start-style-none"
        data-style="none"
        onClick={() => pick("none")}
      >
        <Icon icon={CaptionsOff} size={18} />
        {t("app.start.noCaptions")}
        {noneTag && (
          <span id="start-style-none-tag" className={s.offTag} aria-hidden data-testid="start-style-tag">
            {t(noneTag)}
          </span>
        )}
      </button>
    </div>
  );
}
