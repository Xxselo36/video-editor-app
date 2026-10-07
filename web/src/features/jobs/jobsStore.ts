/**
 * One jobs store (UX12, tech.md §6.3): every screen that shows projects
 * reads them from here (useProjects), every flow that changes one writes
 * here. It replaces the three browser lists of before (the dashboard
 * cards in `cleocuts.activeJobs.v1`, the library in `cleo-library-v1`
 * and the server list merged on top of both, twice).
 *
 * Sources:
 *   - this device's list, `cleocuts.jobs.v2` (per user with accounts on,
 *     lib/auth storageScope): ids, names and upload records only — never
 *     a status or an English message (projects.ts);
 *   - accounts on: the account's list, GET /jobs?fields=summary (ETag);
 *   - the batched status poll, GET /jobs/status (lib/jobStatus, ETag) for
 *     what is still running — and once, when the page opens, for every
 *     id of this device's list that the account's list doesn't cover.
 *
 * The poll runs while a screen uses the projects and the tab is visible
 * (review G9): every 2 s, every 5 s after a minute without a change.
 *
 * The lists of before UX12 are read once per device (and user) into the
 * new one; they stay as they are (rollback), but nothing writes them.
 * Signed in, the ids of this device are claimed for the account
 * (claim.ts, POST /me/claim) and the ones it can't have are dropped.
 */
import { useEffect, useSyncExternalStore } from "react";
import { ACTIVE_JOBS_KEY, dropLegacyActiveJob, liveUploads } from "@/lib/activeJobs";
import { runningUploads, uploadLocks } from "@/lib/uploadLock";
import { track } from "@/lib/analytics";
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED, getAuthState, storageScope, subscribeAuth } from "@/lib/auth";
import { legacyCardCode, type CodedError } from "@/lib/errors";
import { JobStatusPoller, STATUS_BATCH_MAX } from "@/lib/jobStatus";
import { LIBRARY_KEY } from "@/lib/library";
import { foldScopedKeys, JOBS_KEY } from "@/lib/scopedStorage";
import { claimLocalJobs } from "./claim";
import { hasExportHint, setExportHint } from "./localJobs";
import {
  capLocal,
  isUploadId,
  mergeLocal,
  mergeProjects,
  migrateLegacy,
  MISSING,
  needsPoll,
  parseLocal,
  remoteFrom,
  type LocalJob,
  type Project,
  type Remote,
  type RemoteJob,
  type UploadRecord,
} from "./projects";

export { JOBS_KEY };
export type { LocalJob, Project, UploadRecord };

/** Set once this device's (user's) lists of before UX12 were read. */
export const MIGRATED_KEY = "cleocuts.jobs.v2.migrated";

// Dashboard status poll: every 2 s, every 5 s after a minute unchanged.
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 5000;
const POLL_BACKOFF_AFTER_MS = 60_000;

const hasWindow = () => typeof window !== "undefined";

// ── state ────────────────────────────────────────────────────────────

let loadedScope: string | null = null;
let locals: LocalJob[] = [];
const remotes = new Map<string, Remote>();
/** Accounts on: the ids of the account's list (null = not loaded). */
let serverIds: string[] | null = null;
/** Ids whose queued status is an export (seen in review / exported). */
const exportHints = new Set<string>();
/** The first full refresh after the page opened is done. */
let refreshed = false;

const subs = new Set<() => void>();
let version = 0;
let snapshot: { version: number; ready: boolean; serverLoaded: boolean; projects: Project[] } = {
  version: -1,
  ready: false,
  serverLoaded: false,
  projects: [],
};

function emit(): void {
  version++;
  subs.forEach((f) => f());
}

export function subscribeJobs(cb: () => void): () => void {
  ensureLoaded();
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

// ── this device's list ───────────────────────────────────────────────

const key = () => {
  foldScopedKeys(JOBS_KEY);
  return JOBS_KEY + storageScope();
};

function readStored(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Write this device's list; false when the browser refused (quota,
 *  blocked storage) — the list then stays in memory for this page. */
function persist(): boolean {
  if (!hasWindow()) return false;
  try {
    localStorage.setItem(key(), JSON.stringify(locals));
    return true;
  } catch {
    return false;
  }
}

/** Ids removed from this device's list (deleted, cancelled, not this
 *  account's): never brought back from the lists of before. */
const DELETED_KEY = "cleocuts.jobs.v2.deleted";
const MAX_DELETED = 500;

function readDeleted(scope: string): Set<string> {
  try {
    const v = JSON.parse(readStored(DELETED_KEY + scope) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function noteDeleted(ids: string[]): void {
  if (!hasWindow() || ids.length === 0) return;
  const scope = storageScope();
  const all = readDeleted(scope);
  ids.forEach((id) => all.add(id));
  try {
    localStorage.setItem(DELETED_KEY + scope, JSON.stringify([...all].slice(-MAX_DELETED)));
  } catch {
    /* blocked: nothing to bring back from either */
  }
}

/**
 * The lists of before UX12 (dashboard cards, library) → this list. The
 * first time per device and user everything is taken over (an upload
 * card of an earlier page load as a stopped upload). On every later load
 * the jobs a tab still on the old build added since are taken over too:
 * ids not on this list and not removed from it (idempotent; their
 * upload cards stay with that tab). The flag is only set once the list
 * was written.
 */
function migrate(scope: string): void {
  const flag = MIGRATED_KEY + scope;
  const first = !readStored(flag);
  if (first) dropLegacyActiveJob();
  foldScopedKeys(ACTIVE_JOBS_KEY);
  foldScopedKeys(LIBRARY_KEY);
  const m = migrateLegacy(
    readStored(ACTIVE_JOBS_KEY + scope),
    readStored(LIBRARY_KEY + scope),
    (text) => legacyCardCode(text),
  );
  const deleted = readDeleted(scope);
  const have = new Set(locals.map((j) => j.jobId));
  const add = m.jobs.filter(
    (j) => !have.has(j.jobId) && !deleted.has(j.jobId) && (first || !isUploadId(j.jobId)),
  );
  m.exporting.forEach((id) => exportHints.add(id));
  if (add.length === 0 && !first) return;
  locals = mergeLocal(locals, add);
  if (!persist() || !first) return;
  try {
    localStorage.setItem(flag, "1");
  } catch {
    /* blocked: taken over again next time (idempotent) */
  }
}

/** Read the list of the current scope (user) — again after a sign-in. */
function ensureLoaded(): void {
  if (!hasWindow()) return;
  installListeners();
  const scope = storageScope();
  if (loadedScope === scope) return;
  const switched = loadedScope !== null;
  loadedScope = scope;
  locals = parseLocal(readStored(key()));
  migrate(scope);
  if (switched) {
    remotes.clear();
    serverIds = null;
    refreshed = false;
  }
  maybeClaim();
  if (switched) {
    emit();
    if (pollers > 0) void refreshAll();
  }
}

let listening = false;
function installListeners(): void {
  if (listening || !hasWindow()) return;
  listening = true;
  // Another tab changed the list (an upload there, a delete).
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== JOBS_KEY + storageScope()) return;
    locals = parseLocal(readStored(key()));
    emit();
    schedule(true);
  });
  // Signed in / out / another user: that user's list. (After the auth
  // provider moved the beta's lists over: lib/account adoptLegacyLocalData
  // runs right after the state is published.)
  if (AUTH_ENABLED) subscribeAuth(() => setTimeout(ensureLoaded, 0));
}

let claiming = false;
function maybeClaim(): void {
  if (!AUTH_ENABLED || claiming) return;
  const { signedIn, userId } = getAuthState();
  if (!signedIn || !userId) return;
  const ids = locals.map((j) => j.jobId).filter((id) => !isUploadId(id));
  if (ids.length === 0) return;
  claiming = true;
  void claimLocalJobs(userId, ids)
    .then(({ drop, claimed }) => {
      if (drop.length) forgetJobs(drop);
      if ((claimed.length || drop.length) && pollers > 0) void refreshAll();
    })
    .finally(() => {
      claiming = false;
    });
}

export function getLocalJobs(): LocalJob[] {
  ensureLoaded();
  return locals;
}

export function getLocalJob(id: string): LocalJob | null {
  ensureLoaded();
  return locals.find((j) => j.jobId === id) ?? null;
}

function setLocals(next: LocalJob[]): void {
  locals = capLocal(next);
  persist();
  emit();
}

/** Add (or replace) a project on this device's list. */
export function rememberJob(entry: LocalJob): void {
  ensureLoaded();
  setLocals([entry, ...locals.filter((j) => j.jobId !== entry.jobId)]);
  schedule(true);
  maybeClaim();
}

export function updateLocalJob(id: string, patch: Partial<LocalJob>): void {
  ensureLoaded();
  if (!locals.some((j) => j.jobId === id)) return;
  setLocals(locals.map((j) => (j.jobId === id ? { ...j, ...patch } : j)));
}

/** Off this device's list (deleted, cancelled, or not this account's). */
export function forgetJobs(ids: string[]): void {
  ensureLoaded();
  const drop = new Set(ids);
  noteDeleted(ids.filter((id) => !isUploadId(id)));
  for (const id of ids) {
    remotes.delete(id);
    exportHints.delete(id);
  }
  if (serverIds) serverIds = serverIds.filter((id) => !drop.has(id));
  setLocals(locals.filter((j) => !drop.has(j.jobId)));
}

export const removeJob = (id: string) => forgetJobs([id]);

// ── uploads (features/upload) ────────────────────────────────────────

/** Uploads running in THIS page. Module state, so it is empty again
 *  after a reload — which is exactly when an upload record has lost its
 *  request and can never finish. */
export { liveUploads };

/** Put up a new upload (its temporary id until POST /jobs names the job). */
export function addUpload(tempId: string, entry: Omit<LocalJob, "jobId" | "timestamp" | "upload">, upload: UploadRecord): void {
  rememberJob({ ...entry, jobId: tempId, timestamp: Date.now(), upload: { pct: 0, lastProgressAt: Date.now(), ...upload } });
}

export function updateUpload(tempId: string, patch: Partial<UploadRecord>): void {
  ensureLoaded();
  const cur = locals.find((j) => j.jobId === tempId);
  if (!cur) return;
  setLocals(locals.map((j) => (j.jobId === tempId ? { ...j, upload: { ...j.upload, ...patch } } : j)));
}

/** The upload stopped: its code (lib/errors) on the record. */
export function uploadFailed(tempId: string, e: CodedError): void {
  updateUpload(tempId, { errorCode: e.code ?? "processing_failed", errorParams: e.params ?? null, resuming: false, starting: false });
}

/** POST /jobs created the job: the upload record becomes the project. */
export function uploadCreated(
  tempId: string,
  jobId: string,
  info: { filename: string; fileSize?: number; presetId?: string | null; presetLabel?: string | null },
  { cancelTooLate = false }: { cancelTooLate?: boolean } = {},
): void {
  ensureLoaded();
  // (Cancelled too late, the record is gone already: the name comes from
  // the upload itself.)
  const cur = locals.find((j) => j.jobId === tempId);
  const entry: LocalJob = {
    filename: cur?.filename || info.filename,
    fileSize: cur?.fileSize ?? info.fileSize,
    presetId: cur?.presetId ?? info.presetId ?? null,
    presetLabel: cur?.presetLabel ?? info.presetLabel ?? null,
    ...(cur?.name ? { name: cur.name } : {}),
    jobId,
    timestamp: cur?.timestamp || Date.now(),
    ...(cancelTooLate ? { note: "cancel_too_late" } : {}),
  };
  remotes.set(jobId, pendingRemote(jobId));
  setLocals([entry, ...locals.filter((j) => j.jobId !== tempId && j.jobId !== jobId)]);
  schedule(true);
}

function pendingRemote(id: string): RemoteJob {
  return remoteFrom({ id, status: "pending", progress: 0, message: "" });
}

/**
 * Upload records whose upload no longer exists become failed uploads
 * ("Try again"), instead of staying frozen at their last percentage: not
 * this page's, not running in another tab (its Web Lock: lib/uploadLock)
 * and — where Web Locks are missing — no heartbeat for `idleMs`.
 */
export function markStaleUploads(idleMs = 20_000): void {
  if (!uploadLocks()) return markStale(idleMs, null);
  void runningUploads().then((running) => markStale(idleMs, running));
}

function markStale(idleMs: number, running: Set<string> | null): void {
  ensureLoaded();
  const now = Date.now();
  let changed = false;
  const next = locals.map((j) => {
    if (!isUploadId(j.jobId) || j.upload?.errorCode || liveUploads.has(j.jobId) || running?.has(j.jobId)) return j;
    if (now - (j.upload?.lastProgressAt ?? j.timestamp) < idleMs) return j;
    changed = true;
    return { ...j, upload: { ...j.upload, errorCode: "upload_interrupted", resuming: false } };
  });
  if (changed) setLocals(next);
}

// ── renders (the editor) ─────────────────────────────────────────────


/** An export was just started (the editor): shown as exporting at once
 *  (and a queued run of it counts as the export, also on /app/p). */
export function noteExporting(id: string): void {
  exportHints.add(id);
  setExportHint(id);
  const r = remotes.get(id);
  if (r && r !== MISSING) {
    remotes.set(id, { ...r, status: "processing", stage: r.stage?.startsWith("render.") ? r.stage : "render.prepare", renderFailed: false });
  }
  emit();
  schedule(true);
}

/** A running job of `id` is an export (not the analysis), as far as this
 *  tab knows. */
export function exportHinted(id: string): boolean {
  return exportHints.has(id) || hasExportHint(id);
}

// ── rename / delete ──────────────────────────────────────────────────

/** Rename a project: on the server (PATCH /jobs/{id} {title}) and here.
 *  False when the server refused or couldn't be reached. */
export async function renameProject(id: string, name: string): Promise<boolean> {
  const title = name.trim().slice(0, 120);
  const r = remotes.get(id);
  try {
    const res = await apiFetch(`/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  if (r && r !== MISSING) remotes.set(id, { ...r, title: title || null });
  if (locals.some((j) => j.jobId === id)) updateLocalJob(id, { name: title || null });
  else emit();
  try {
    // The v2 editor's title field reads this (EditorShell).
    if (title) localStorage.setItem(`cleocuts.editor.title.${id}`, title);
    else localStorage.removeItem(`cleocuts.editor.title.${id}`);
  } catch {
    /* ignore */
  }
  return true;
}

/** Delete a project on the server (video, edits, exports) and here.
 *  "busy": it's still processing (409) — try again later. */
export async function deleteProject(id: string): Promise<"ok" | "busy" | "failed"> {
  if (!isUploadId(id)) {
    try {
      const r = await apiFetch(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 404: gone already — fine.
      if (r.status === 409) return "busy";
      if (!r.ok && r.status !== 404) return "failed";
    } catch {
      return "failed";
    }
  }
  forgetJobs([id]);
  return "ok";
}

/** The full job (outputs, post text) of a project — for the tile's menu. */
export async function fetchJob(id: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await apiFetch(`/jobs/${encodeURIComponent(id)}`);
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── the poll ─────────────────────────────────────────────────────────

let pollers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;
let lastChange = Date.now();
const poller = new JobStatusPoller();
let listEtag: string | null = null;
let listBody: Record<string, unknown>[] | null = null;

function projectsNow(): Project[] {
  return mergeProjects(locals, remotes, serverIds, { now: Date.now(), exportHints });
}

function setRemote(row: Record<string, unknown>): boolean {
  const next = remoteFrom(row);
  const prev = remotes.get(next.id);
  if (prev && prev !== MISSING) {
    if (prev.status === "awaiting_review" || prev.status === "done") exportHints.add(next.id);
    // An export finished while the page watched it.
    if (prev.status === "processing" && next.status === "done") track("export_done", { outputs: 1, hooks: 0 });
    if (next.status === "done" || next.status === "error") exportHints.delete(next.id);
    if (JSON.stringify(prev) === JSON.stringify(next)) return false;
  } else if (next.status === "awaiting_review" || next.status === "done") {
    exportHints.add(next.id);
  }
  remotes.set(next.id, next);
  return true;
}

/** Accounts on: the account's list (304 = as before). */
async function loadServerList(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (listEtag && listBody) headers["If-None-Match"] = listEtag;
    const r = await apiFetch("/jobs?fields=summary", { headers, cache: "no-store" });
    let rows: Record<string, unknown>[];
    if (r.status === 304 && listBody) rows = listBody;
    else if (!r.ok) return false;
    else {
      const body = (await r.json()) as unknown;
      rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
      listEtag = r.headers.get("ETag");
      listBody = rows;
    }
    let changed = serverIds === null;
    serverIds = rows.map((x) => String(x.id ?? "")).filter(Boolean);
    for (const row of rows) changed = setRemote(row) || changed;
    return changed;
  } catch {
    return false;
  }
}

/** Status rows for `ids` (in batches); unknown ids are MISSING. */
async function loadStatuses(ids: string[], p: JobStatusPoller | null): Promise<boolean> {
  let changed = false;
  for (let i = 0; i < ids.length; i += STATUS_BATCH_MAX) {
    const chunk = ids.slice(i, i + STATUS_BATCH_MAX);
    const res = await (p ?? new JobStatusPoller()).poll(chunk);
    if (!res) continue;
    for (const row of res.rows) changed = setRemote(row as unknown as Record<string, unknown>) || changed;
    for (const id of res.missing) {
      // Accounts on, a job of the account's list can't be "missing".
      if (serverIds?.includes(id)) continue;
      if (remotes.get(id) !== MISSING) {
        remotes.set(id, MISSING);
        changed = true;
      }
    }
  }
  return changed;
}

/** Everything once: the account's list (accounts on) and the status of
 *  every id of this device's list it doesn't cover. */
async function refreshAll(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    let changed = false;
    if (AUTH_ENABLED && getAuthState().signedIn) changed = (await loadServerList()) || changed;
    const covered = new Set(serverIds ?? []);
    const ids = locals.map((j) => j.jobId).filter((id) => !isUploadId(id) && !covered.has(id));
    if (ids.length) changed = (await loadStatuses(ids, null)) || changed;
    if (!refreshed) {
      refreshed = true;
      changed = true;
    }
    if (changed) {
      lastChange = Date.now();
      emit();
    }
  } finally {
    running = false;
  }
  if (again) {
    again = false;
    return tick();
  }
  schedule();
}

const polledIds = () => projectsNow().filter((p) => needsPoll(p) && !isUploadId(p.id)).map((p) => p.id);

async function tick(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (pollers === 0 || document.hidden) return;
  if (running) {
    again = true;
    return;
  }
  const ids = polledIds();
  if (ids.length) {
    running = true;
    try {
      const changed = await loadStatuses(ids.slice(0, STATUS_BATCH_MAX), poller);
      if (changed) {
        lastChange = Date.now();
        emit();
      }
    } catch {
      /* offline / transient — next tick retries */
    } finally {
      running = false;
    }
  }
  if (again) {
    again = false;
    return tick();
  }
  schedule();
}

/** The next tick (`now`: a project joined the polled set — at once). */
function schedule(now = false): void {
  if (pollers === 0 || !hasWindow()) return;
  if (now) {
    lastChange = Date.now();
    if (!refreshed) return; // refreshAll runs and schedules
    void tick();
    return;
  }
  clearTimeout(timer);
  timer = undefined;
  if (document.hidden || polledIds().length === 0) return;
  const quiet = Date.now() - lastChange > POLL_BACKOFF_AFTER_MS;
  timer = setTimeout(() => void tick(), quiet ? POLL_SLOW_MS : POLL_FAST_MS);
}

function onVisibility(): void {
  if (document.hidden) {
    clearTimeout(timer);
    timer = undefined;
    return;
  }
  // Back: fresh status of everything now, quick ticks again.
  lastChange = Date.now();
  void refreshAll();
}

/** Start the poll while a screen shows projects; returns the stop. */
function acquirePolling(): () => void {
  ensureLoaded();
  pollers++;
  if (pollers === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    void refreshAll();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pollers--;
    if (pollers === 0) {
      clearTimeout(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

// ── hooks ────────────────────────────────────────────────────────────

export type ProjectsSnapshot = {
  /** This device's list was read and the first refresh is done. */
  ready: boolean;
  /** Accounts on: the account's list (GET /jobs) was loaded. */
  serverLoaded: boolean;
  projects: Project[];
};

const SERVER_SNAPSHOT: ProjectsSnapshot = { ready: false, serverLoaded: false, projects: [] };

function getSnapshot(): ProjectsSnapshot {
  if (snapshot.version !== version) {
    snapshot = { version, ready: refreshed, serverLoaded: serverIds !== null, projects: projectsNow() };
  }
  return snapshot;
}

/** Ask the server again now (the page's "Try again"). */
export function refreshProjects(): void {
  lastChange = Date.now();
  void refreshAll().then(() => emit());
}

/** The projects (polled while mounted). */
export function useProjects(): ProjectsSnapshot {
  useEffect(() => acquirePolling(), []);
  return useSyncExternalStore(subscribeJobs, getSnapshot, () => SERVER_SNAPSHOT);
}

/** The projects of this device's list, without the poll (e.g. "is there
 *  anything to go back to?"). */
export function useLocalJobs(): LocalJob[] {
  return useSyncExternalStore(subscribeJobs, getLocalJobs, () => EMPTY);
}
const EMPTY: LocalJob[] = [];

/** For tests: forget everything. */
export function _resetForTests(): void {
  loadedScope = null;
  locals = [];
  remotes.clear();
  serverIds = null;
  exportHints.clear();
  refreshed = false;
  listEtag = null;
  listBody = null;
  version++;
}
