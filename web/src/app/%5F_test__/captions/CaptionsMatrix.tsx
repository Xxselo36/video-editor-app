"use client";
/**
 * The caption test matrix: every preset × 4 moments × de/en/ru/hi, drawn
 * by the real engine (fonts from /fonts/captions, bitmap cache path) on a
 * 540×960 canvas over a plain dark gradient, then kept as an image.
 *
 * Query: ?lang=de,en  ?preset=power,clipper  ?size=1080x1920
 * Output for the parity suite: window.__captionsLayout (one entry per
 * cell: preset, lang, moment, t, frame state, rounded layout JSON) and
 * window.__captionsReady = true when every cell is drawn.
 */
import { useEffect, useState } from "react";
import {
  CaptionRenderer,
  LAUNCH_PRESETS,
  PRESET_NAMES,
  browserSurface,
  ensureFonts,
  layoutJSON,
  presetSupport,
  resolveStyle,
  type CaptionWord,
  type Ctx2D,
} from "@/lib/captions";
import samplesJson from "@/lib/captions/samples.json";

const LANGS = ["de", "en", "ru", "hi"] as const;
const MOMENTS = ["page start", "mid page", "word 4", "next page"] as const;
const SAMPLES = samplesJson.samples as Record<string, string>;

type Cell = {
  preset: string;
  lang: string;
  moment: string;
  t: number;
  support: string;
  src?: string;
  approximate?: boolean;
};

type LayoutRecord = Omit<Cell, "src"> & { state: unknown; page: unknown };

declare global {
  interface Window {
    __captionsLayout?: LayoutRecord[];
    __captionsReady?: boolean;
    __captionsErrors?: string[];
  }
}

// "Nobody waits ten seconds for you to get to the point." (audit clip timings)
const AUDIT_SENTENCE: CaptionWord[] = (
  [
    ["Nobody", 0.0, 0.34], ["waits", 0.37, 0.663], ["ten", 0.693, 0.894], ["seconds", 0.924, 1.31],
    ["for", 1.34, 1.541], ["you", 1.571, 1.772], ["to", 1.802, 1.957], ["get", 1.987, 2.188],
    ["to", 2.218, 2.373], ["the", 2.403, 2.604], ["point.", 2.634, 2.974],
  ] as const
).map(([text, start, end], i) => ({ id: `a${i}`, text, start, end }));

function timed(text: string): CaptionWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t, i) => ({ id: `w${i}`, text: t, start: +(i * 0.32).toFixed(3), end: +(i * 0.32 + 0.28).toFixed(3) }));
}

function wordsFor(lang: string): CaptionWord[] {
  return lang === "en" ? AUDIT_SENTENCE : timed(SAMPLES[lang]);
}

function param(name: string): string[] | null {
  const v = new URLSearchParams(window.location.search).get(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
}

function background(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#3a4252");
  g.addColorStop(0.55, "#232834");
  g.addColorStop(1, "#11141b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // a soft "subject" shape so shadows and glows read like over video
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.42, W * 0.22, H * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
}

async function run(onCell: (c: Cell) => void): Promise<void> {
  const size = param("size")?.[0]?.split("x").map(Number);
  const W = size && size[0] > 0 ? size[0] : 540;
  const H = size && size[1] > 0 ? size[1] : 960;
  const langs = param("lang") ?? [...LANGS];
  const presets = param("preset") ?? [...LAUNCH_PRESETS];
  const records: LayoutRecord[] = [];
  const errors: string[] = [];
  window.__captionsLayout = records;
  window.__captionsErrors = errors;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  for (const lang of langs) {
    const words = wordsFor(lang);
    for (const preset of presets) {
      const support = presetSupport(preset, lang).level;
      const style = resolveStyle(preset, {}, { W, H });
      if (!style) continue;
      const status = await ensureFonts(style, { lang, text: words.map((w) => w.text) });
      if (!status.ok) errors.push(`${preset}/${lang}: ${status.failed.map((f) => f.face).join(", ")}`);
      const r = new CaptionRenderer({ words, style, W, H, lang, surface: browserSurface });
      const p0 = r.pages[0];
      const p1 = r.pages[1] ?? p0;
      const w4 = words[Math.min(3, words.length - 1)];
      const times = [p0.start + 0.02, (p0.start + p0.end) / 2, w4.start + 0.05, p1.start + 0.2];
      MOMENTS.forEach((moment, i) => {
        const t = +times[i].toFixed(3);
        background(ctx, W, H);
        const state = r.draw(ctx as unknown as Ctx2D, t);
        const page = state ? r.pages[state.page] : null;
        const layout = state ? r.layout(state.page) : null;
        const cell: Cell = { preset, lang, moment, t, support, approximate: layout?.approximate };
        records.push({
          ...cell,
          state: state && { page: state.page, active: state.active, key: state.key, sweep: state.sweep },
          page: page && layout ? layoutJSON(page, layout) : null,
        });
        onCell({ ...cell, src: canvas.toDataURL("image/jpeg", 0.85) });
      });
      r.dispose();
      // yield so the page stays responsive
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  window.__captionsReady = true;
}

export default function CaptionsMatrix() {
  const [cells, setCells] = useState<Cell[]>([]);
  const [done, setDone] = useState(false);
  const [thumb, setThumb] = useState(81);

  useEffect(() => {
    let cancelled = false;
    const pending: Cell[] = [];
    const size = Number(param("thumb")?.[0]);
    run((c) => {
      pending.push(c);
    })
      .catch((e) => {
        (window.__captionsErrors ??= []).push(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setCells(pending.slice());
        setDone(true);
      });
    const timer = setInterval(() => {
      if (cancelled) return;
      if (size > 0) setThumb(size);
      setCells(pending.slice());
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const groups = new Map<string, Cell[]>();
  for (const c of cells) {
    const key = `${c.lang}|${c.preset}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  return (
    <main style={{ padding: 16, background: "#0b0a10", color: "#e8e6f0", minHeight: "100vh", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Caption engine · test matrix</h1>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }} data-testid="captions-status">
        {done ? `done · ${cells.length} frames` : `drawing… ${cells.length}`} · layout JSON in window.__captionsLayout
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {[...groups.entries()].map(([key, list]) => {
          const [lang, preset] = key.split("|");
          const name = PRESET_NAMES.en[preset as keyof typeof PRESET_NAMES.en]?.name ?? preset;
          const off = list[0].support === "unavailable";
          return (
            <section key={key} data-testid={`cell-${preset}-${lang}`} style={{ opacity: off ? 0.45 : 1 }}>
              <div style={{ fontSize: 12, margin: "0 0 4px", color: "#ffd25a" }}>
                {name} · {lang}
                {list[0].support !== "native" ? ` · ${list[0].support === "fallback" ? "fallback font" : "unavailable"}` : ""}
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                {list.map((c) => (
                  // eslint-disable-next-line @next/next/no-img-element -- data URLs of canvas frames
                  <img
                    key={c.moment}
                    src={c.src}
                    alt={`${preset} ${lang} ${c.moment}`}
                    title={`${c.moment} · t=${c.t}s`}
                    width={thumb}
                    height={Math.round((thumb * 16) / 9)}
                    style={{ display: "block", borderRadius: 3 }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
