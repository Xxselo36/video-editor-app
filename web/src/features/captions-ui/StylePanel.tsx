"use client";
/**
 * The Style tab of the v2 editor with live captions (UT5; PLAN_TECH UT5
 * StylePanel / PresetGrid / PresetTile / StyleControls, DF mock
 * Desktop-Stil / Handy-Stil).
 *
 * - Tiles: a static snapshot per style, drawn once by the caption engine
 *   over the video's current frame with the transcript's own first words
 *   (so in its script), cropped to the caption band. A tile draws (and
 *   loads its font) only when it scrolls into view. Static like the
 *   approved mock: no tile animates.
 * - "Recommended for your video" on top (server: script, words per
 *   second, format), then all other live styles; a style that can't
 *   caption the transcript's script is greyed with the reason. "Off".
 * - "Customize", collapsed: size, position, words per caption, case,
 *   text and highlight colour, animation, sync offset, button zones;
 *   "Reset to the style's look". Every change is one doc step (undo,
 *   autosave); a slider commits when it is let go.
 */
import { ChevronRight, CaptionsOff, RotateCcw } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLang, useT, type TFn } from "@/i18n";
import {
  ensureFonts,
  getPreset,
  listPresets,
  resolveStyle,
  CaptionRenderer,
  type CaptionWord,
  type Ctx2D,
  type PresetId,
  type StyleOverrides,
} from "@/lib/captions";
import { setStyle, type EditDoc } from "@/features/editor/state/doc";
import { useDocStore, type DocState, type DocStore } from "@/features/editor/state/store";
import type { MessageKey } from "@/i18n/messages/en";
import { shownWords, tileOrder, type TileInfo } from "./live";
import c from "./captions.module.css";

export type StylePanelProps = {
  doc: DocStore;
  apply: (op: (d: EditDoc) => EditDoc) => boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  presetsLive: string[] | null;
  recommended: string[];
  phone: boolean;
  zones: boolean;
  onZones: (on: boolean) => void;
  readOnly?: boolean;
};

const selStyle = (st: DocState) => st.present.style;
const selWords = (st: DocState) => st.present.words;
const selLang = (st: DocState) => st.present.language;

const COLORS = ["#FFFFFF", "#FFE600", "#22E55B", "#38BDF8", "#FF5CA8", "#FF8A00"] as const;
const HAS = Object.fromEntries(listPresets().map((p) => [p.id, p])) as Record<PresetId, ReturnType<typeof listPresets>[number]>;

const nameKey = (id: PresetId) => `editor.style.preset.${id}` as MessageKey;

/** Language name for "not available for …" (the transcript's language, in the UI language). */
function languageName(code: string | null | undefined, ui: string): string {
  if (!code) return "";
  try {
    const dn = new Intl.DisplayNames([ui], { type: "language" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}

// ── one tile ──────────────────────────────────────────────────────────

/** The sample: the transcript's first two shown words (one for One Word), as spoken words. */
function sampleWords(words: readonly { text: string }[], id: PresetId): CaptionWord[] {
  const n = id === "punch" ? 1 : 2;
  const picked = words.slice(0, n).map((w) => w.text);
  const texts = picked.length ? picked : ["Aa"];
  return texts.map((text, i) => ({ id: `s${i}`, text, start: i * 0.5, end: i * 0.5 + 0.45 }));
}

type TileProps = {
  info: TileInfo;
  selected: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  sample: readonly { text: string }[];
  lang: string | undefined;
  why: string;
  disabled: boolean;
  onPick: (id: PresetId) => void;
  label: string;
};

const TILE_W = 540;

const PresetTile = memo(function PresetTile({ info, selected, videoRef, sample, lang, why, disabled, onPick, label }: TileProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !info.available) return;
    let alive = true;
    let drawnWithFrame = false;
    let started = false;
    const draw = async () => {
      started = true;
      const v = videoRef.current;
      const vw = v?.videoWidth || 9;
      const vh = v?.videoHeight || 16;
      // a virtual frame of the video's shape, short side 540
      const k = TILE_W / Math.min(vw, vh);
      const W = Math.round(vw * k);
      const H = Math.round(vh * k);
      const style = resolveStyle(info.id, {}, { W, H });
      if (!style) return;
      const words = sampleWords(sample, info.id);
      setState((s) => (s === "done" ? s : "loading"));
      const fonts = await ensureFonts(style, { lang, text: words.map((w) => w.text) }).catch(() => null);
      if (!alive || !fonts?.ok) return;
      const frame = document.createElement("canvas");
      frame.width = W;
      frame.height = H;
      const fctx = frame.getContext("2d");
      if (!fctx) return;
      fctx.fillStyle = "#1B1B21";
      fctx.fillRect(0, 0, W, H);
      if (v && v.readyState >= 2 && v.videoWidth) {
        try {
          fctx.drawImage(v, 0, 0, W, H);
          drawnWithFrame = true;
        } catch {
          /* not decodable yet */
        }
      }
      const r = new CaptionRenderer({ words, style, W, H, lang });
      // the last sample word is being spoken, its animation settled
      const at = words[words.length - 1].start + 0.3;
      const st = r.state(at);
      r.draw(fctx as unknown as Ctx2D, at);
      const box = st ? r.layout(st.page).box : { left: W * 0.3, right: W * 0.7, top: H * 0.6, bottom: H * 0.7 };
      r.dispose();
      // crop the caption band: about half the frame wide (the mock's zoom), never cutting the caption
      const cw = canvas.clientWidth || 100;
      const ch = canvas.clientHeight || 72;
      const cropW = Math.min(W, Math.max(W * 0.55, (box.right - box.left) * 1.12));
      const cropH = (cropW * ch) / cw;
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const sx = Math.min(Math.max(0, cx - cropW / 2), W - cropW);
      const sy = Math.min(Math.max(0, cy - cropH / 2), Math.max(0, H - cropH));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(frame, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
      frame.width = 0;
      setState("done");
    };
    // fonts load only when the tile is (nearly) visible
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                io?.disconnect();
                void draw();
              }
            },
            { rootMargin: "120px" },
          )
        : null;
    if (io) io.observe(canvas);
    else void draw();
    // the video's frame arrives later: draw once more with it
    const v = videoRef.current;
    const again = () => {
      if (started && !drawnWithFrame) void draw();
    };
    v?.addEventListener("loadeddata", again);
    v?.addEventListener("seeked", again);
    return () => {
      alive = false;
      io?.disconnect();
      v?.removeEventListener("loadeddata", again);
      v?.removeEventListener("seeked", again);
    };
  }, [info.id, info.available, sample, lang, videoRef]);
  return (
    <li>
      <button
        type="button"
        className={c.tile}
        aria-pressed={selected}
        disabled={disabled || !info.available}
        title={info.available ? label : why}
        onClick={() => onPick(info.id)}
        data-testid={`ed-tile-${info.id}`}
        data-state={state}
        style={{ width: "100%" }}
      >
        <span className={c.ti}>
          <canvas ref={ref} aria-hidden />
          <span className={c.ring} />
          {state === "loading" && <span className={c.loading} aria-hidden />}
        </span>
        <span className={c.tn}>{label}</span>
        {!info.available && <span className={c.why}>{why}</span>}
      </button>
    </li>
  );
});

// ── Customize ─────────────────────────────────────────────────────────

function Seg<T extends string | number>({
  label,
  value,
  options,
  onPick,
  disabled,
  testId,
}: {
  label: string;
  value: T | null;
  options: { v: T; label: string }[];
  onPick: (v: T) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className={c.row}>
      <span className={c.rowLabel}>{label}</span>
      <div className={c.seg} role="group" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button key={String(o.v)} type="button" aria-pressed={value === o.v} disabled={disabled} onClick={() => onPick(o.v)} style={{ flex: 1 }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A range that commits once when let go (one undo step per drag). */
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  disabled,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
  disabled?: boolean;
  testId: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <label className={c.row}>
      <span className={c.rowLabel}>
        <span>{label}</span>
        <span className={c.rowValue}>{format(shown)}</span>
      </span>
      <input
        type="range"
        className={c.range}
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        data-testid={testId}
      />
    </label>
  );
}

function Swatches({
  label,
  value,
  presetColor,
  onPick,
  disabled,
  t,
  testId,
}: {
  label: string;
  value: string | undefined;
  presetColor: string;
  onPick: (v: string | undefined) => void;
  disabled?: boolean;
  t: TFn;
  testId: string;
}) {
  const colors = [presetColor.toUpperCase(), ...COLORS.filter((x) => x !== presetColor.toUpperCase())].slice(0, 6);
  const cur = (value ?? presetColor).toUpperCase();
  return (
    <div className={c.row}>
      <span className={c.rowLabel}>{label}</span>
      <div className={c.swatches} role="group" aria-label={label} data-testid={testId}>
        {colors.map((col, i) => (
          <button
            key={col}
            type="button"
            className={c.swatch}
            style={{ background: col }}
            aria-pressed={cur === col}
            aria-label={i === 0 ? t("editor.style.colorStyle") : col}
            title={i === 0 ? t("editor.style.colorStyle") : col}
            disabled={disabled}
            onClick={() => onPick(i === 0 ? undefined : col)}
          />
        ))}
      </div>
    </div>
  );
}

// ── the panel ─────────────────────────────────────────────────────────

export default function StylePanel(p: StylePanelProps) {
  const t = useT();
  const ui = useLang();
  const style = useDocStore(p.doc, selStyle);
  const words = useDocStore(p.doc, selWords);
  const lang = useDocStore(p.doc, selLang) ?? undefined;
  const [open, setOpen] = useState(false);
  // the transcript's first words, for the tiles (stable while the first words stay)
  const first = useMemo(() => shownWords(words).slice(0, 2), [words]);
  const sampleKey = first.map((w) => w.text).join(" ");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sample = useMemo(() => first, [sampleKey]);
  const tiles = useMemo(() => tileOrder(p.presetsLive, p.recommended, lang), [p.presetsLive, p.recommended, lang]);
  const current = style.presetId;
  const o = (style.overrides ?? {}) as StyleOverrides;
  const why = t("editor.style.unavailable", { lang: languageName(lang, ui) });
  const off = current === "none";
  const preset = !off ? getPreset((current as PresetId) ?? "power") : null;

  const pick = (id: PresetId | "none") => {
    p.apply((d) => setStyle(d, { presetId: id, overrides: d.style.overrides ?? {} }));
  };
  const setO = (patch: Partial<Record<keyof StyleOverrides, unknown>>) => {
    p.apply((d) => {
      const next: Record<string, unknown> = { ...(d.style.overrides ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      return setStyle(d, { presetId: d.style.presetId, overrides: next });
    });
  };
  const resetStyle = () => {
    p.apply((d) => {
      const cur = (d.style.overrides ?? {}) as StyleOverrides;
      return setStyle(d, { presetId: d.style.presetId, overrides: cur.captions ? { captions: cur.captions } : {} });
    });
  };

  const tile = (info: TileInfo) => (
    <PresetTile
      key={info.id}
      info={info}
      selected={current === info.id}
      videoRef={p.videoRef}
      sample={sample}
      lang={lang}
      why={why}
      disabled={!!p.readOnly}
      onPick={pick}
      label={t(nameKey(info.id))}
    />
  );

  const posValue = o.y === undefined ? "bottom" : o.y < 0.35 ? "top" : o.y < 0.6 ? "middle" : "bottom";
  const resolved = resolveStyle(off ? "power" : current, o);
  const hasHighlight = !off && HAS[current as PresetId]?.hasHighlight;
  const presetHighlight = preset
    ? preset.highlight.mode === "box"
      ? (preset.highlight.boxColor ?? "#FFFFFF")
      : (preset.highlight.color ?? "#FFFFFF")
    : "#FFFFFF";
  const hasOverrides = Object.keys(o).some((k) => k !== "captions");

  return (
    <div className={`${c.panel} ${p.phone ? c.phone : ""}`} data-testid="ed-style" data-live="1">
      {tiles.recommended.length > 0 && (
        <>
          <div className={c.label}>{t("editor.style.recommended")}</div>
          <ul className={c.grid} data-testid="ed-style-recommended">
            {tiles.recommended.map(tile)}
          </ul>
          <div className={c.label} style={{ marginTop: 16 }}>
            {t("editor.style.all")}
          </div>
        </>
      )}
      <ul className={c.grid} data-testid="ed-style-all">
        {tiles.rest.map(tile)}
      </ul>
      <button
        type="button"
        className={c.off}
        aria-pressed={off}
        disabled={p.readOnly}
        onClick={() => pick("none")}
        data-testid="ed-tile-none"
      >
        <CaptionsOff size={16} strokeWidth={1.75} aria-hidden />
        <span>{t("editor.style.off")}</span>
      </button>
      <div className={c.sep} />
      <button
        type="button"
        className={c.disclosure}
        aria-expanded={open}
        aria-controls="ed-style-customize"
        onClick={() => setOpen(!open)}
        data-testid="ed-style-customize"
      >
        <span>{t("editor.style.customize")}</span>
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden className={c.chev} />
      </button>
      {open && (
        <div id="ed-style-customize" className={c.controls}>
          <Slider
            label={t("editor.style.size")}
            value={Math.round((o.sizeScale ?? 1) * 100)}
            min={60}
            max={160}
            step={5}
            format={(v) => `${v} %`}
            onCommit={(v) => setO({ sizeScale: v === 100 ? undefined : v / 100 })}
            disabled={off || p.readOnly}
            testId="ed-style-size"
          />
          <Seg
            label={t("editor.style.position")}
            value={posValue}
            options={[
              { v: "top", label: t("editor.style.top") },
              { v: "middle", label: t("editor.style.middle") },
              { v: "bottom", label: t("editor.style.bottom") },
            ]}
            onPick={(v) => setO({ y: v === "top" ? 0.25 : v === "middle" ? 0.5 : undefined })}
            disabled={off || p.readOnly}
            testId="ed-style-position"
          />
          <Seg
            label={t("editor.style.words")}
            value={o.wordsPerPage ?? "auto"}
            options={[
              { v: 1, label: "1" },
              { v: 2, label: "2" },
              { v: 3, label: "3" },
              { v: "auto", label: t("editor.style.auto") },
            ]}
            onPick={(v) => setO({ wordsPerPage: v === "auto" ? undefined : v })}
            disabled={off || p.readOnly}
            testId="ed-style-words"
          />
          <Seg
            label={t("editor.style.case")}
            value={resolved?.font.case ?? "none"}
            options={[
              { v: "none", label: "Aa" },
              { v: "upper", label: "AA" },
            ]}
            onPick={(v) => setO({ case: preset && preset.font.case === v ? undefined : v })}
            disabled={off || p.readOnly}
            testId="ed-style-case"
          />
          <Swatches
            label={t("editor.style.textColor")}
            value={o.textColor}
            presetColor={preset?.fill.color ?? "#FFFFFF"}
            onPick={(v) => setO({ textColor: v })}
            disabled={off || p.readOnly}
            t={t}
            testId="ed-style-text-color"
          />
          {hasHighlight && (
            <Swatches
              label={t("editor.style.highlightColor")}
              value={o.highlightColor}
              presetColor={presetHighlight}
              onPick={(v) => setO({ highlightColor: v })}
              disabled={off || p.readOnly}
              t={t}
              testId="ed-style-highlight-color"
            />
          )}
          <Seg
            label={t("editor.style.animation")}
            value={o.animation ?? null}
            options={[
              { v: "none", label: t("editor.style.animNone") },
              { v: "pop", label: t("editor.style.animPop") },
              { v: "fade", label: t("editor.style.animFade") },
            ]}
            onPick={(v) => setO({ animation: o.animation === v ? undefined : v })}
            disabled={off || p.readOnly}
            testId="ed-style-animation"
          />
          <Slider
            label={t("editor.style.sync")}
            value={o.offsetMs ?? 0}
            min={-300}
            max={300}
            step={50}
            format={(v) => `${v > 0 ? "+" : ""}${v} ms`}
            onCommit={(v) => setO({ offsetMs: v === 0 ? undefined : v })}
            disabled={off || p.readOnly}
            testId="ed-style-sync"
          />
          <label className={c.check}>
            <input type="checkbox" checked={p.zones} onChange={(e) => p.onZones(e.target.checked)} data-testid="ed-style-zones" />
            <span>{t("editor.style.zones")}</span>
          </label>
        </div>
      )}
      <button
        type="button"
        className={c.reset}
        disabled={!hasOverrides || p.readOnly}
        title={t("editor.style.resetTip")}
        onClick={resetStyle}
        data-testid="ed-style-reset"
      >
        <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
        {t("editor.style.reset")}
      </button>
    </div>
  );
}
