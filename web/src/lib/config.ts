/**
 * The deployment's settings from GET /config (UX5): upload limits,
 * formats, caption presets, billing, incident banner. Replaces the
 * NEXT_PUBLIC_MAX_* build variables: the backend's own limits apply
 * without a rebuild.
 *
 * Cached for this page (a minute, like the answer's Cache-Control) and
 * in localStorage (the last known answer, used at once on the next
 * visit). Until an answer is there, DEFAULT_CONFIG — the backend's
 * defaults — applies; the server checks again anyway.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type Limits = {
  max_upload_bytes: number;
  /** null: no length cap. */
  max_seconds: number | null;
  min_seconds: number;
};

export type AppConfig = {
  limits: Limits;
  formats: string[];
  caption_presets: { id: string; name_key: string; status: string; scripts: string[] | null }[];
  spoken_languages: string[];
  free_renders: number | null;
  billing: { enabled: boolean };
  incident: { key: string; severity: string } | null;
};

/** backend/main.py's defaults (CLEO_MAX_UPLOAD_GB=4, CLEO_MAX_MINUTES=30,
 *  CLEO_MIN_SECONDS=3). */
export const DEFAULT_LIMITS: Limits = { max_upload_bytes: 4e9, max_seconds: 30 * 60, min_seconds: 3 };

export const DEFAULT_CONFIG: AppConfig = {
  limits: DEFAULT_LIMITS,
  formats: ["9:16", "1:1", "16:9"],
  caption_presets: [],
  spoken_languages: ["auto"],
  free_renders: null,
  billing: { enabled: false },
  incident: null,
};

const STORAGE_KEY = "cleocuts.config.v1";
const TTL_MS = 60_000;

let cached: { at: number; config: AppConfig } | null = null;
let inflight: Promise<AppConfig> | null = null;

function isConfig(v: unknown): v is AppConfig {
  const c = v as AppConfig | null;
  return Boolean(c && typeof c === "object" && c.limits && typeof c.limits.max_upload_bytes === "number");
}

/** The last known config without waiting (this page's, else the stored
 *  one, else the defaults). */
export function currentConfig(): AppConfig {
  if (cached) return cached.config;
  if (typeof window !== "undefined") {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (isConfig(v)) return v;
    } catch {
      /* storage blocked / junk */
    }
  }
  return DEFAULT_CONFIG;
}

/** GET /config (cached a minute); the last known config if the backend
 *  doesn't answer within `timeoutMs`. Never throws. */
export async function getConfig(timeoutMs = 4000): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.config;
  if (!inflight) {
    inflight = (async () => {
      try {
        const r = await apiFetch("/config");
        if (!r.ok) return currentConfig();
        const v: unknown = await r.json();
        if (!isConfig(v)) return currentConfig();
        cached = { at: Date.now(), config: v };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {
          /* quota / blocked */
        }
        return v;
      } catch {
        return currentConfig();
      } finally {
        inflight = null;
      }
    })();
  }
  const timeout = new Promise<AppConfig>((resolve) => setTimeout(() => resolve(currentConfig()), timeoutMs));
  return Promise.race([inflight, timeout]);
}

/** The config for a component: the last known one at once, refreshed. */
export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    let alive = true;
    // Deliberately after mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(currentConfig());
    void getConfig().then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return config;
}

/** For tests: forget the cached answer. */
export function _resetConfigCache(): void {
  cached = null;
  inflight = null;
}
