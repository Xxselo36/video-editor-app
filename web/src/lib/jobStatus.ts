/**
 * Dashboard status polling: ONE `GET /jobs/status?ids=a,b` per tick for
 * all cards instead of one full `GET /jobs/{id}` per card. The backend
 * answers with a weak ETag; sending it back as If-None-Match turns an
 * unchanged answer into an empty 304.
 *
 * Backends from before the batch endpoint route `/jobs/status` to
 * `/jobs/{id}` and answer 404: from then on (for this page's lifetime)
 * each card is fetched on its own, as before.
 */
import { apiFetch } from "@/lib/api";

/** One card's state, as GET /jobs/status lists it. */
export type JobStatusRow = {
  id: string;
  status: string;
  message: string;
  progress: number;
  /** 1-based place in line while the job waits (message "queued"). */
  queue_position: number | null;
  error: string | null;
  /** Machine-readable cause of a failure ("no_speech", "no_audio", …). */
  error_code?: string | null;
  /** Its numbers ({"max_minutes": 30}), UX5. */
  error_params?: Record<string, string | number | boolean | null> | null;
  /** The failed job's minutes were credited back. */
  refunded?: boolean | null;
  /** Where a running job is (backend/errors.py STAGES), UX5. */
  stage?: string | null;
  stage_params?: Record<string, string | number | boolean | null> | null;
  has_output?: boolean;
  updated_at?: number | null;
  preview_version?: number | null;
  /** The full job dict — only on the per-job fallback path. */
  full?: Record<string, unknown>;
};

export type StatusPollResult = {
  rows: JobStatusRow[];
  /** Ids the server doesn't know (expired, redeployed, not the caller's). */
  missing: string[];
  /** Anything different from the previous answer (drives the backoff). */
  changed: boolean;
};

/** Ids per call the backend accepts. The dashboard keeps ≤ 20 cards
 *  (activeJobs cap), so one call always covers them. */
export const STATUS_BATCH_MAX = 50;

// False once the backend answered the batch endpoint with 404.
let batchSupported = true;

const num = (v: unknown, dflt: number) => (typeof v === "number" && isFinite(v) ? v : dflt);

const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | number | boolean | null>) : null;

function toRow(id: string, raw: Record<string, unknown>): JobStatusRow {
  const qp = raw.queue_position;
  return {
    id,
    status: String(raw.status ?? ""),
    message: typeof raw.message === "string" ? raw.message : "",
    progress: num(raw.progress, 0),
    queue_position: typeof qp === "number" && qp > 0 ? qp : null,
    error: typeof raw.error === "string" ? raw.error : null,
    error_code: typeof raw.error_code === "string" ? raw.error_code : null,
    error_params: obj(raw.error_params),
    refunded: typeof raw.refunded === "boolean" ? raw.refunded : null,
    stage: typeof raw.stage === "string" ? raw.stage : null,
    stage_params: obj(raw.stage_params),
    has_output: Boolean(raw.has_output),
    updated_at: typeof raw.updated_at === "number" ? raw.updated_at : null,
    preview_version: typeof raw.preview_version === "number" ? raw.preview_version : null,
  };
}

/** What a card shows; the change signal for the backoff. */
function signature(rows: JobStatusRow[], missing: string[]): string {
  return JSON.stringify([
    rows.map((r) => [r.id, r.status, r.message, r.progress, r.queue_position, r.error, r.error_code, r.refunded, r.stage]),
    missing,
  ]);
}

/**
 * Remembers the last answer so a 304 can be handed out as the same rows
 * (callers process every tick idempotently — a step that failed, like
 * fetching a finished job's outputs, is retried on the next one).
 */
export class JobStatusPoller {
  private etag: string | null = null;
  private idsKey = "";
  private last: { rows: JobStatusRow[]; missing: string[] } | null = null;
  private lastSig = "";

  /** null = no usable answer this tick (offline, 401, 5xx): retry later. */
  async poll(ids: string[]): Promise<StatusPollResult | null> {
    const wanted = ids.slice(0, STATUS_BATCH_MAX);
    if (wanted.length === 0) return { rows: [], missing: [], changed: false };
    const key = wanted.join(",");
    if (key !== this.idsKey) {
      // Another set of cards: the old ETag describes another answer.
      this.idsKey = key;
      this.etag = null;
      this.last = null;
    }
    let got: { rows: JobStatusRow[]; missing: string[] } | null | "unchanged" = null;
    if (batchSupported) got = await this.batch(wanted);
    if (!batchSupported) got = await perJob(wanted);
    if (got === null) return null;
    if (got === "unchanged") {
      if (this.last) return { ...this.last, changed: false };
      // 304 without an answer to repeat (can't happen: the ETag goes
      // with `last`) — ask again without it next tick.
      this.etag = null;
      return null;
    }
    this.last = got;
    const sig = signature(got.rows, got.missing);
    const changed = sig !== this.lastSig;
    this.lastSig = sig;
    return { ...got, changed };
  }

  private async batch(
    ids: string[],
  ): Promise<{ rows: JobStatusRow[]; missing: string[] } | null | "unchanged"> {
    let r: Response;
    try {
      const headers: Record<string, string> = {};
      if (this.etag && this.last) headers["If-None-Match"] = this.etag;
      r = await apiFetch(`/jobs/status?ids=${ids.map(encodeURIComponent).join(",")}`, {
        headers,
        // Our own If-None-Match decides; the HTTP cache must not answer.
        cache: "no-store",
      });
    } catch {
      return null;
    }
    if (r.status === 304) return "unchanged";
    if (r.status === 404) {
      batchSupported = false; // older backend: /jobs/status = /jobs/{id}
      return null;
    }
    if (!r.ok) return null;
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return null;
    }
    // [{…}] or {"jobs": [{…}], "missing": [ids]}; anything asked for and
    // not listed is gone either way.
    const list = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { jobs?: unknown }).jobs)
        ? ((body as { jobs: unknown[] }).jobs)
        : null;
    if (!list) return null;
    const asked = new Set(ids);
    const rows: JobStatusRow[] = [];
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const id = String((x as { id?: unknown }).id ?? "");
      if (asked.has(id)) rows.push(toRow(id, x as Record<string, unknown>));
    }
    const seen = new Set(rows.map((x) => x.id));
    this.etag = r.headers.get("ETag");
    return { rows, missing: ids.filter((id) => !seen.has(id)) };
  }
}

/** Fallback: GET /jobs/{id} per card (one after another, as before). */
async function perJob(ids: string[]): Promise<{ rows: JobStatusRow[]; missing: string[] } | null> {
  const rows: JobStatusRow[] = [];
  const missing: string[] = [];
  let answered = false;
  for (const id of ids) {
    try {
      const r = await apiFetch(`/jobs/${id}`);
      if (r.status === 404) {
        answered = true;
        missing.push(id);
        continue;
      }
      if (!r.ok) continue;
      const full = (await r.json()) as Record<string, unknown>;
      rows.push({ ...toRow(id, full), full });
      answered = true;
    } catch {
      /* offline / transient — next tick retries */
    }
  }
  return answered ? { rows, missing } : null;
}

/** The full job (outputs, captions, hook clips) of a finished card. */
export async function fetchFullJob(id: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await apiFetch(`/jobs/${id}`);
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
