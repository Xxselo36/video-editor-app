/**
 * The pure part of the jobs store (UX12, PLAN_TECH §UX12 / tech.md §6.3):
 * what this device keeps of a project, what the server says about it,
 * and how the two make the project a tile shows. No storage, no network
 * — jobsStore.ts does that; this file is what the unit tests cover.
 *
 * localStorage keeps ids, display names and upload records only — never
 * a status or an English message (the server is asked for those).
 */
import type { ErrorParams } from "@/lib/errors";
import type { JobStatusRow } from "@/lib/jobStatus";
import type { UploadSettings } from "@/features/upload/uploadJob";

/** An upload that has no job yet (its id is `upl-…`). */
export type UploadRecord = {
  /** 0–100, as of the last heartbeat (the live value is in memory). */
  pct?: number;
  /** Last heartbeat of the tab that uploads (ms epoch): another tab — or
   *  this one after a reload — tells a live upload from a dead one. */
  lastProgressAt?: number;
  /** Continues an interrupted upload of the same file. */
  resuming?: boolean;
  /** The file is stored and POST /jobs went out: the job may exist —
   *  no cancel any more ("Starting…"). */
  starting?: boolean;
  /** Why it stopped (lib/errors.ts codes); none while it runs. */
  errorCode?: string | null;
  errorParams?: ErrorParams | null;
  /** What POST /jobs gets: "Try again" after a reload asks for the file
   *  again and starts it with these. */
  settings?: UploadSettings;
};

/** What this device keeps of a project (cleocuts.jobs.v2). */
export type LocalJob = {
  jobId: string;
  /** Created (ms epoch). */
  timestamp: number;
  /** The uploaded file's name. */
  filename: string;
  fileSize?: number;
  /** The name the user gave it here (the server's title wins). */
  name?: string | null;
  presetId?: string | null;
  /** English label of a pre-UX6 workflow (presets.legacy). */
  presetLabel?: string | null;
  upload?: UploadRecord;
  /** "cancel_too_late": cancelled after POST /jobs had created the job,
   *  which was already running (the tile says so). */
  note?: string;
};

/** What the server says about a project (GET /jobs?fields=summary, the
 *  status rows). Times in ms. */
export type RemoteJob = {
  id: string;
  status: string;
  message: string;
  progress: number;
  queuePosition: number | null;
  stage: string | null;
  stageParams: ErrorParams | null;
  errorCode: string | null;
  errorParams: ErrorParams | null;
  refunded: boolean | null;
  hasOutput: boolean;
  expiresAt: number | null;
  title: string | null;
  filename: string | null;
  createdAt: number | null;
  duration: number | null;
  presetId: string | null;
  presetLabel: string | null;
  /** Back in review after a failed export (edits kept). */
  renderFailed: boolean;
  /** ms; changes with every edit, export and rename (a revision). */
  updatedAt: number | null;
};

/** The server doesn't know the job (deleted after its retention, or not
 *  this account's). */
export const MISSING = "missing" as const;
export type Remote = RemoteJob | typeof MISSING;

export type ProjectState =
  | "uploading"
  | "upload_failed"
  | "unknown" // not asked yet
  | "processing"
  | "ready" // in review, never exported
  | "edited" // in review again after an export
  | "exporting"
  | "exported"
  | "failed"
  | "expired";

export type Project = {
  id: string;
  state: ProjectState;
  /** Title, name or file name ("" = untitled). */
  name: string;
  filename: string;
  /** ms epoch. */
  createdAt: number;
  duration: number | null;
  presetId: string | null;
  presetLabel: string | null;
  progress: number;
  queuePosition: number | null;
  stage: string | null;
  stageParams: ErrorParams | null;
  errorCode: string | null;
  errorParams: ErrorParams | null;
  refunded: boolean | null;
  hasOutput: boolean;
  /** ms epoch, null = kept. */
  expiresAt: number | null;
  renderFailed: boolean;
  /** The server's updated_at (ms): the project's revision. */
  updatedAt: number | null;
  /** LocalJob.note. */
  note: string | null;
  upload: UploadRecord | null;
  /** On this device's list (else: only the account's server list). */
  local: boolean;
};

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): ErrorParams | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ErrorParams) : null;

/** Unix seconds or ms → ms. */
export function toMsTime(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** A server row (summary list, status row or full job) → RemoteJob. */
export function remoteFrom(raw: Record<string, unknown> | JobStatusRow): RemoteJob {
  const r = raw as Record<string, unknown>;
  const status = String(r.status ?? "");
  const errorCode = str(r.error_code);
  return {
    id: String(r.id ?? ""),
    status,
    message: typeof r.message === "string" ? r.message : "",
    progress: num(r.progress) ?? 0,
    queuePosition: num(r.queue_position) && (r.queue_position as number) > 0 ? (r.queue_position as number) : null,
    stage: str(r.stage),
    stageParams: obj(r.stage_params),
    errorCode,
    errorParams: obj(r.error_params),
    refunded: typeof r.refunded === "boolean" ? r.refunded : null,
    hasOutput: Boolean(r.has_output),
    expiresAt: toMsTime(r.expires_at),
    title: str(r.title),
    filename: str(r.filename),
    createdAt: toMsTime(r.created_at),
    duration: num(r.duration) && (r.duration as number) > 0 ? (r.duration as number) : null,
    presetId: str(r.preset_id),
    presetLabel: str(r.preset_label),
    renderFailed: status === "awaiting_review" && Boolean(errorCode || str(r.error)),
    updatedAt: toMsTime(r.updated_at),
  };
}

export const isUploadId = (id: string) => id.startsWith("upl-");

/** A running job is an export (not an analysis): its stage says so, or —
 *  waiting for a render slot ("queued") — it was in review or exported
 *  before (`exportHint`). */
function exporting(r: RemoteJob, exportHint: boolean): boolean {
  if (r.stage?.startsWith("render.")) return true;
  if (r.stage?.startsWith("analyze.")) return false;
  return exportHint || r.hasOutput || /render/i.test(r.message);
}

export function stateOf(
  local: LocalJob | undefined,
  remote: Remote | undefined,
  { now, exportHint = false }: { now: number; exportHint?: boolean },
): ProjectState {
  if (local && (isUploadId(local.jobId) || local.upload)) {
    return local.upload?.errorCode ? "upload_failed" : "uploading";
  }
  if (remote === MISSING) return "expired";
  if (!remote) return "unknown";
  if (remote.expiresAt !== null && remote.expiresAt <= now) return "expired";
  switch (remote.status) {
    case "pending":
    case "processing":
      return exporting(remote, exportHint) ? "exporting" : "processing";
    case "awaiting_review":
      return remote.hasOutput ? "edited" : "ready";
    case "done":
      return "exported";
    case "error":
    case "cancelled":
      return "failed";
    default:
      return "unknown";
  }
}

/** Polled until it settles: running on the server, or not asked yet. */
export function needsPoll(p: Project): boolean {
  return p.state === "processing" || p.state === "exporting" || p.state === "unknown";
}

export function buildProject(
  id: string,
  local: LocalJob | undefined,
  remote: Remote | undefined,
  opts: { now: number; exportHint?: boolean },
): Project {
  const r = remote && remote !== MISSING ? remote : null;
  return {
    id,
    state: stateOf(local, remote, opts),
    name: r?.title ?? local?.name ?? (local?.filename || r?.filename || ""),
    filename: local?.filename || r?.filename || "",
    createdAt: local?.timestamp ?? r?.createdAt ?? 0,
    duration: r?.duration ?? null,
    presetId: local?.presetId ?? r?.presetId ?? null,
    presetLabel: local?.presetLabel ?? r?.presetLabel ?? null,
    progress: local?.upload?.pct ?? r?.progress ?? 0,
    queuePosition: r?.queuePosition ?? null,
    stage: r?.stage ?? null,
    stageParams: r?.stageParams ?? null,
    errorCode: local?.upload?.errorCode ?? r?.errorCode ?? null,
    errorParams: local?.upload?.errorParams ?? r?.errorParams ?? null,
    refunded: r?.refunded ?? null,
    hasOutput: r?.hasOutput ?? false,
    expiresAt: r?.expiresAt ?? null,
    renderFailed: r?.renderFailed ?? false,
    updatedAt: r?.updatedAt ?? null,
    note: local?.note ?? null,
    upload: local?.upload ?? (local && isUploadId(local.jobId) ? {} : null),
    local: Boolean(local),
  };
}

/** Every project of the device's list and the account's server list (if
 *  any), newest first. */
export function mergeProjects(
  locals: LocalJob[],
  remotes: Map<string, Remote>,
  serverIds: string[] | null,
  opts: { now: number; exportHints?: Set<string> },
): Project[] {
  const byId = new Map<string, Project>();
  const hint = (id: string) => opts.exportHints?.has(id) ?? false;
  for (const l of locals) {
    byId.set(l.jobId, buildProject(l.jobId, l, remotes.get(l.jobId), { now: opts.now, exportHint: hint(l.jobId) }));
  }
  for (const id of serverIds ?? []) {
    if (byId.has(id)) continue;
    byId.set(id, buildProject(id, undefined, remotes.get(id), { now: opts.now, exportHint: hint(id) }));
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// ── the stored list ──────────────────────────────────────────────────

/** At most this many projects are kept on a device (oldest go first). */
export const MAX_LOCAL = 100;

/** The stored list, cleaned: one entry per id (the first), newest first. */
export function parseLocal(raw: string | null): LocalJob[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: LocalJob[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const j = e as Partial<LocalJob>;
    if (typeof j.jobId !== "string" || !j.jobId || seen.has(j.jobId)) continue;
    seen.add(j.jobId);
    out.push({
      ...j,
      jobId: j.jobId,
      timestamp: typeof j.timestamp === "number" ? j.timestamp : 0,
      filename: typeof j.filename === "string" ? j.filename : "",
    } as LocalJob);
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** The list to store: newest first, capped (uploads are never dropped). */
export function capLocal(list: LocalJob[]): LocalJob[] {
  const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);
  if (sorted.length <= MAX_LOCAL) return sorted;
  const keep = sorted.filter((j) => isUploadId(j.jobId));
  for (const j of sorted) {
    if (keep.length >= MAX_LOCAL) break;
    if (!isUploadId(j.jobId)) keep.push(j);
  }
  return keep.sort((a, b) => b.timestamp - a.timestamp);
}

// ── migration from the lists of before UX12 ──────────────────────────

/** A card of lib/activeJobs (cleocuts.activeJobs.v1), as stored. */
type LegacyCard = {
  jobId?: unknown;
  phase?: unknown;
  timestamp?: unknown;
  filename?: unknown;
  fileSize?: unknown;
  presetId?: unknown;
  presetLabel?: unknown;
  uploadPct?: unknown;
  error?: unknown;
  errorCode?: unknown;
  errorParams?: unknown;
};

/** An entry of lib/library (cleo-library-v1), as stored. */
type LegacyEntry = { jobId?: unknown; timestamp?: unknown; filename?: unknown; presetId?: unknown; presetLabel?: unknown };

function list(raw: string | null): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object") : [];
  } catch {
    return [];
  }
}

export type Migrated = {
  jobs: LocalJob[];
  /** Ids whose card said "rendering": a queued status is an export. */
  exporting: string[];
};

/**
 * The cards (activeJobs) and the library of a device from before UX12 as
 * the new list: ids, names and upload records — the statuses and English
 * sentences they stored are dropped (the server is asked). An upload card
 * left from an earlier page load can't be running any more: it becomes a
 * failed upload ("Try again"). `legacyCode` maps a card's stored English
 * sentence to its code (lib/errors legacyCardCode).
 */
export function migrateLegacy(
  activeRaw: string | null,
  libraryRaw: string | null,
  legacyCode: (text: string) => { code: string | null; params?: ErrorParams | null },
): Migrated {
  const jobs = new Map<string, LocalJob>();
  const exportingIds: string[] = [];
  for (const c of list(activeRaw) as LegacyCard[]) {
    if (typeof c.jobId !== "string" || !c.jobId || jobs.has(c.jobId)) continue;
    const entry: LocalJob = {
      jobId: c.jobId,
      timestamp: typeof c.timestamp === "number" ? c.timestamp : 0,
      filename: typeof c.filename === "string" ? c.filename : "",
      presetId: typeof c.presetId === "string" ? c.presetId : null,
      presetLabel: typeof c.presetLabel === "string" ? c.presetLabel : null,
    };
    if (typeof c.fileSize === "number") entry.fileSize = c.fileSize;
    if (c.phase === "uploading" || isUploadId(c.jobId)) {
      if (!isUploadId(c.jobId)) continue; // can't happen; never a job id with an upload record
      const coded =
        typeof c.errorCode === "string" && c.errorCode
          ? { code: c.errorCode, params: (c.errorParams as ErrorParams) ?? null }
          : typeof c.error === "string" && c.error
            ? legacyCode(c.error)
            : { code: "upload_interrupted", params: null };
      entry.upload = {
        pct: typeof c.uploadPct === "number" ? c.uploadPct : 0,
        errorCode: coded.code ?? "upload_interrupted",
        errorParams: coded.params ?? null,
      };
    } else if (c.phase === "rendering") {
      exportingIds.push(c.jobId);
    }
    jobs.set(c.jobId, entry);
  }
  for (const e of list(libraryRaw) as LegacyEntry[]) {
    if (typeof e.jobId !== "string" || !e.jobId) continue;
    const prev = jobs.get(e.jobId);
    const entry: LocalJob = {
      jobId: e.jobId,
      timestamp: typeof e.timestamp === "number" ? e.timestamp : 0,
      filename: typeof e.filename === "string" ? e.filename : "",
      presetId: typeof e.presetId === "string" ? e.presetId : null,
      presetLabel: typeof e.presetLabel === "string" ? e.presetLabel : null,
    };
    // A job on both lists: the card's (older) creation time and name.
    jobs.set(e.jobId, prev ? { ...entry, ...prev, filename: prev.filename || entry.filename } : entry);
  }
  return { jobs: [...jobs.values()], exporting: exportingIds };
}

/** `extra` added to `base` where `base` lacks the id. */
export function mergeLocal(base: LocalJob[], extra: LocalJob[]): LocalJob[] {
  const ids = new Set(base.map((j) => j.jobId));
  return capLocal([...base, ...extra.filter((j) => !ids.has(j.jobId))]);
}

// ── what the page shows ──────────────────────────────────────────────

/**
 * Accounts on and no project to show: on to the start screen only when
 * the account's list really loaded and is empty ("redirect"); when it
 * couldn't be loaded (offline, a 5xx) the page says so with a retry
 * ("retry") — a transient error must not look like "no projects".
 * "wait" until the first answer; "show" when there is something.
 */
export function emptyListAction(s: {
  ready: boolean;
  serverLoaded: boolean;
  count: number;
}): "wait" | "show" | "redirect" | "retry" {
  if (s.count > 0) return "show";
  if (!s.ready) return "wait";
  return s.serverLoaded ? "redirect" : "retry";
}

export type Filter = "all" | "edit" | "exported";

export function matchesFilter(p: Project, f: Filter): boolean {
  if (f === "edit") return p.state === "ready" || p.state === "edited";
  if (f === "exported") return p.state === "exported";
  return true;
}

export function matchesSearch(p: Project, q: string): boolean {
  const s = q.trim().toLocaleLowerCase();
  if (!s) return true;
  return `${p.name} ${p.filename}`.toLocaleLowerCase().includes(s);
}

/** "Folge_12_mit_einem_sehr_langen_Namen.mp4" → "Folge_12_mit…Namen.mp4"
 *  (the extension stays visible). */
export function middleEllipsis(name: string, max = 34): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const tail = Math.max(8, Math.floor((max - 1) * 0.4));
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** Whole days until `expiresAt` (≥ 0), or null. */
export function daysLeft(expiresAt: number | null, now: number): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 86_400_000));
}

/** Seconds of analysis we expect for a video of `duration` s (≈ 72 s per
 *  minute of 1080p, measured; flows.md §3.4), at least 20 s. */
export function analysisEta(duration: number | null): number | null {
  if (!duration || duration <= 0) return null;
  return Math.max(20, Math.round(duration * 1.2));
}
