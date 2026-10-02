"use client";
/**
 * Timeline filmstrip (UX7b): the clips' thumbnails, from one sprite per
 * job (GET /jobs/{id}/filmstrip; meta {n, interval, tileW, tileH} in GET
 * /jobs/{id}). Each clip draws the frames of its own source range, scaled
 * to its height, in the visible window only (filmstrip.ts).
 *
 * A job from before the filmstrip has no meta: the editor asks for it
 * (`?meta=1`), the backend makes it from the stored proxy meanwhile (202
 * while it works) — a few polls, then the clips stay plain. The tiles show
 * once the sprite has loaded; a sprite that fails to load shows nothing.
 */
import { memo, useEffect, useState, type CSSProperties } from "react";
import { mediaUrl, useMediaReady } from "@/lib/api";
import { clipTiles, tileWidth, validMeta, type FilmstripMeta } from "./filmstrip";
import s from "../editor.module.css";

/** A loaded sprite: its URL and layout. */
export type FilmSource = { url: string; meta: FilmstripMeta };

/** Polls of an old job's lazily made filmstrip (every POLL_MS). */
const MAX_POLLS = 20;
const POLL_MS = 3000;

/**
 * The job's sprite once it has loaded, else null. `initial`: the meta from
 * GET /jobs/{id} (null: a job from before UX7b — asked for, made lazily).
 */
export function useFilmstrip(jobId: string, initial: FilmstripMeta | null | undefined): FilmSource | null {
  const ready = useMediaReady();
  const [meta, setMeta] = useState<{ job: string; meta: FilmstripMeta } | null>(null);
  const [loaded, setLoaded] = useState<FilmSource | null>(null);
  const known = validMeta(initial) ? initial : meta?.job === jobId ? meta.meta : null;

  // an old job: ask for the meta (the backend makes the sprite meanwhile)
  const asking = !known && ready;
  useEffect(() => {
    if (!asking) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const ask = () => {
      polls++;
      fetch(mediaUrl(jobId, "filmstrip", { meta: 1 }))
        .then(async (r) => {
          if (!live) return;
          if (r.status === 200) {
            const m: unknown = await r.json();
            if (live && validMeta(m)) setMeta({ job: jobId, meta: m });
          } else if (r.status === 202 && polls < MAX_POLLS) {
            timer = setTimeout(ask, POLL_MS);
          }
        })
        .catch(() => {
          /* no filmstrip: plain clips */
        });
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asking, jobId]);

  // load the sprite before drawing tiles with it
  const url = known && ready ? mediaUrl(jobId, "filmstrip", { v: `${known.n}-${known.interval}-${known.tileW}` }) : null;
  useEffect(() => {
    if (!url || !known) return;
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (live) setLoaded({ url, meta: known });
    };
    img.onerror = () => {
      if (live) setLoaded(null);
    };
    img.src = url;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [url, known]);
  return loaded && loaded.url === url ? loaded : null;
}

export type FilmstripProps = {
  film: FilmSource;
  /** The clip's source range (s). */
  start: number;
  end: number;
  /** The clip in the strip (px). */
  left: number;
  width: number;
  /** Clip height (px): the tiles' height. */
  h: number;
  /** The window tiles are drawn for (strip px, filmWindow). */
  lo: number;
  hi: number;
};

/** One clip's tiles (inside its body, under the badges and fades). */
export const Filmstrip = memo(function Filmstrip(p: FilmstripProps) {
  const { meta, url } = p.film;
  const tiles = clipTiles(meta, p);
  if (!tiles.length) return null;
  const dw = tileWidth(meta, p.h);
  const vars = {
    "--film-src": `url("${url}")`,
    "--film-size": `${meta.n * dw}px ${p.h}px`,
  } as CSSProperties;
  return (
    <div className={s.film} style={vars} aria-hidden data-testid="ed-film">
      {tiles.map((t) => (
        <span
          key={t.x}
          className={s.filmTile}
          data-tile={t.idx}
          style={{ left: t.x, width: Math.ceil(t.w), backgroundPosition: `${-t.idx * dw}px 0` }}
        />
      ))}
    </div>
  );
});
