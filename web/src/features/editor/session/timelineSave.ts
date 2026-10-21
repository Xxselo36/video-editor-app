/**
 * Autosave of the timeline (the clip list): POST /jobs/{id}/edit-segments
 * with the edit doc's revision rule (backend _save_edit_segments, review
 * F3): base_rev = the rev the server has, rev = a newer one, unique to the
 * request (state/docSave.ts uniqueRev). The trim flow round:
 *
 *   - One save on the wire at a time (F4): the next one goes once the
 *     server has STORED this one — its answer, or GET /jobs/{id} showing
 *     its rev, whichever comes first (the answer itself comes only after
 *     the server's preview re-encode). Edits made meanwhile are not
 *     queued one by one: the newest state goes next, the ones between are
 *     never sent. "saved" only once the newest state is acknowledged.
 *   - 409 stale_rev: the server is at a rev only this request could have
 *     set → our write committed and its answer was lost (success); at a
 *     rev an earlier request of ours set (a keepalive flush that overtook
 *     it, the last visit's) → sent again on that one; any other rev →
 *     another tab or device saved: "conflict", nothing more is sent
 *     (never overwrites silently), onConflict reloads. The refused change
 *     stays this device's (round 3): onConflict gets it (the editor offers
 *     it back) and the backup keeps it until the next edit, so leaving now
 *     still finds it offered on the next open.
 *   - Network errors and 5xx: "retrying", the same body again with
 *     backoff (it may have committed: see the 409 rule); other refusals
 *     (job gone, out of review): "failed".
 *   - What the server hasn't acknowledged is kept locally (backup, per
 *     job, save-11): the next open offers it back when the server doesn't
 *     have it (session/unsaved.ts).
 *   - Leaving: close() sends what is pending now and keeps going (a few
 *     retries) after the editor is gone; a hidden or unloading page sends
 *     it at once with keepalive, on top of a save still on the wire.
 *
 * Framework-free (fetch and timers injected) so it is unit-tested;
 * useEditSession wires it to the editor.
 */
import { uniqueRev } from "@/features/editor/state/docSave";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { sameTimeline, type TimelineSeg } from "@/lib/editSave";

export const TL_DEBOUNCE_MS = 800;
const BACKOFF_MS = [1000, 3000, 5000, 10_000, 20_000];
/** Bodies over this go without keepalive (the browser's 64 KB budget). */
const KEEPALIVE_LIMIT = 60_000;

export type TimelineSaveState = "saved" | "saving" | "retrying" | "failed" | "conflict";

/**
 * What the save's answer says about the preview (preview mode swaps it
 * in). A backend that rebuilds in the background answers once the save is
 * stored, with `preview_status` ("building" while a rebuild is queued or
 * running, "ready", "failed", "stale": none is being built); one from
 * before answers after its rebuild (preview_ok, superseded) and has none.
 */
export type PreviewStatus = "ready" | "building" | "failed" | "stale";
export type TimelineAnswer = {
  preview_ok?: boolean;
  superseded?: boolean;
  preview_segments?: [number, number][];
  preview_version?: number;
  preview_status?: PreviewStatus;
  edit_rev?: number;
};

/** The local copy of a timeline the server hasn't acknowledged (save-11). */
export type TimelineBackup = {
  segs: EditorSeg[];
  /** The server rev the edit was made on. */
  base: number;
  /** Revs this editor sent (a later open knows them as its own). */
  known: number[];
  at: number;
};

export type TimelineSaverDeps = {
  jobId: string;
  /** The video's length (sameTimeline clamps like the backend). */
  duration: number;
  /** apiFetch-like. */
  fetch: (path: string, init: RequestInit & { unloading?: boolean }) => Promise<Response>;
  onState?: (s: TimelineSaveState) => void;
  /** A save's OK answer (after the server's preview rebuild). */
  onAnswer?: (data: TimelineAnswer, payload: TimelineSeg[]) => void;
  /** Another tab or device saved: the autosave stopped (reset() starts it
   *  again). `refused`: this device's newest change the server didn't take. */
  onConflict?: (serverRev: number | null, refused: EditorSeg[] | null) => void;
  /** Every request's outcome (lib/pendingSaves trackSave). */
  track?: (p: Promise<unknown>) => void;
  /** The unacknowledged state, or null once the server has it. */
  backup?: (b: TimelineBackup | null) => void;
  /** Revs of this device's earlier visits (a backup's). */
  known?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
  debounceMs?: number;
  /** Stored-check polling of GET /jobs/{id}: first after, then every, give up after (ms). */
  poll?: { firstMs: number; everyMs: number; timeoutMs: number };
};

/** The clips a save sends: enabled, over 0.05 s (the backend drops shorter), with effects. */
export function timelinePayload(segs: readonly EditorSeg[]): TimelineSeg[] {
  return segs
    .filter((s) => !s.disabled && s.end - s.start > 0.05)
    .map((s) => ({
      start: s.start,
      end: s.end,
      speed: s.speed,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      volume: s.volume,
    }));
}

type Sent = {
  rev: number;
  base: number;
  payload: TimelineSeg[];
  body: string;
  acked: boolean;
  /** Ends what lib/pendingSaves tracks: stored, or the request is over. */
  release?: () => void;
};

const POLL = { firstMs: 200, everyMs: 500, timeoutMs: 15_000 };

export class TimelineSaver {
  private ack: { rev: number; payload: TimelineSeg[] | null };
  /** The newest committed clip list the server isn't known to have (null: none). */
  private latest: EditorSeg[] | null = null;
  /** A change a conflict refused (and the rev it was made on): kept in the
   *  backup until the next edit — offered back, never sent by itself. */
  private refused: { segs: EditorSeg[]; base: number } | null = null;
  private inflight: Sent | null = null;
  /** A save whose outcome is unknown: sent again as it is. */
  private retry: Sent | null = null;
  private attempt = 0;
  private debounce: unknown = null;
  private backoff: unknown = null;
  private state: TimelineSaveState = "saved";
  private stopped = false;
  private closing = false;
  private rebases = 0;
  private readonly known: Set<number>;
  private readonly byRev = new Map<number, TimelineSeg[]>();
  private waiters: (() => void)[] = [];
  private readonly d: Required<Pick<TimelineSaverDeps, "setTimer" | "clearTimer" | "now" | "debounceMs" | "poll">> &
    TimelineSaverDeps;

  constructor(rev: number, saved: TimelineSeg[] | null, deps: TimelineSaverDeps) {
    this.ack = { rev, payload: saved };
    this.known = new Set(deps.known ?? []);
    this.known.add(rev);
    this.d = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      debounceMs: TL_DEBOUNCE_MS,
      poll: POLL,
      ...deps,
    };
  }

  get status(): TimelineSaveState {
    return this.state;
  }
  /** The rev the server is known to have. */
  get rev(): number {
    return this.ack.rev;
  }
  /** The timeline the server is known to have (null: not known). */
  get stored(): TimelineSeg[] | null {
    return this.ack.payload;
  }
  /** Something the server isn't known to have (or a save on the wire). */
  get dirty(): boolean {
    return this.latest !== null || this.inflight !== null || this.retry !== null;
  }

  private set(s: TimelineSaveState) {
    if (this.state === s) return;
    this.state = s;
    if (!this.closing) this.d.onState?.(s);
    if (s === "saved" || s === "failed" || s === "conflict") {
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    }
  }

  private writeBackup() {
    if (!this.d.backup) return;
    if (this.latest === null || this.state === "conflict") {
      // A refused change stays: the next open offers it (the server moved
      // on). No revs of ours with it: it must never come back by itself.
      const r = this.refused;
      this.d.backup(r ? { segs: r.segs, base: r.base, known: [], at: this.d.now() } : null);
      return;
    }
    this.d.backup({ segs: this.latest, base: this.ack.rev, known: [...this.known].slice(-20), at: this.d.now() });
  }

  /** A committed clip list: saved TL_DEBOUNCE_MS after the last one. */
  schedule(segs: EditorSeg[]): void {
    if (this.state === "conflict") return;
    this.latest = segs;
    this.refused = null;
    this.writeBackup();
    if (this.state === "saved") this.set("saving");
    if (this.debounce) this.d.clearTimer(this.debounce);
    this.debounce = this.d.setTimer(() => {
      this.debounce = null;
      this.pump();
    }, this.d.debounceMs);
  }

  /** Send what is pending now (no debounce). */
  flush(): void {
    if (this.debounce) {
      this.d.clearTimer(this.debounce);
      this.debounce = null;
    }
    this.pump();
  }

  /**
   * Everything acknowledged? Sends what is pending now and resolves true
   * once the server has the newest state, false when it failed, conflicts
   * or `timeoutMs` passed (export: never render an older cut).
   */
  settle(timeoutMs = 15_000): Promise<boolean> {
    this.flush();
    if (!this.dirty) return Promise.resolve(this.state !== "conflict" && this.state !== "failed");
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(!this.dirty && this.state === "saved");
      };
      const h = this.d.setTimer(finish, timeoutMs);
      this.waiters.push(() => {
        this.d.clearTimer(h);
        finish();
      });
    });
  }

  /** A failed save: try again now. */
  retryNow(): void {
    if (this.state === "conflict") return;
    if (this.backoff) {
      this.d.clearTimer(this.backoff);
      this.backoff = null;
    }
    this.stopped = false;
    this.attempt = 0;
    if (this.state === "failed") this.set(this.dirty ? "saving" : "saved");
    this.flush();
  }

  /** Ask for the timeline the server has to be saved again (a preview rebuild that failed). */
  resend(): void {
    if (this.stopped || this.inflight || this.retry) return;
    if (!this.latest && this.ack.payload) {
      const want = this.ack.payload;
      if (!want.length) return;
      this.send(this.fresh(want));
      return;
    }
    this.pump();
  }

  /** After a conflict (or a reload): the server's timeline is the base again. */
  reset(rev: number, payload: TimelineSeg[] | null): void {
    this.clearTimers();
    this.ack = { rev, payload };
    this.known.add(rev);
    this.latest = null;
    this.inflight = null;
    this.retry = null;
    this.stopped = false;
    this.rebases = 0;
    this.attempt = 0;
    this.state = "saved";
    this.d.onState?.("saved");
    this.writeBackup();
  }

  /**
   * The page is hidden (iOS: no pagehide on an app switch, timers freeze)
   * or unloading: what is pending goes NOW with keepalive — on top of a
   * save still on the wire (its rev as the base: the server stores that
   * one first; if this one overtakes it, its 409 names a rev of ours).
   */
  flushNow(unloading: boolean): void {
    if (this.stopped || this.state === "conflict") return;
    if (this.debounce) {
      this.d.clearTimer(this.debounce);
      this.debounce = null;
    }
    const want = this.latest ? timelinePayload(this.latest) : null;
    if (!want || !want.length) return;
    const on = this.inflight ?? this.retry;
    if (!on) {
      if (this.ack.payload && sameTimeline(this.ack.payload, want, this.d.duration)) return;
      this.send(this.fresh(want), true, unloading);
      return;
    }
    if (sameTimeline(on.payload, want, this.d.duration)) return;
    // chained on the save on the wire; never the one the queue tracks
    this.send(this.fresh(want, on.rev), true, unloading, true);
  }

  /**
   * The editor goes (unmount): the pending state goes now, retried a few
   * times; no state reaches the editor any more. Resolves when the server
   * has it, or it gave up (reopening waits for this, pendingSaves).
   */
  close(tries = 4): Promise<void> {
    this.closing = true;
    let left = tries;
    const run = async (): Promise<void> => {
      this.flush();
      while (this.dirty && !this.stopped && this.state !== "conflict") {
        const ok = await this.settle(12_000);
        if (ok || !this.dirty) return;
        if (--left <= 0) return;
        if (this.state === "failed") return;
      }
    };
    return run();
  }

  /** Stop: nothing more is sent (the editor is gone for good). */
  stop(): void {
    this.closing = true;
    this.stopped = true;
    this.clearTimers();
  }

  // ── internals ────────────────────────────────────────────────────

  private clearTimers() {
    if (this.debounce) this.d.clearTimer(this.debounce);
    if (this.backoff) this.d.clearTimer(this.backoff);
    this.debounce = null;
    this.backoff = null;
  }

  private fresh(payload: TimelineSeg[], base = this.ack.rev): Sent {
    const rev = Math.max(uniqueRev(base), ...[...this.known].map((k) => Math.floor(k) + 1));
    return { rev, base, payload, body: JSON.stringify({ segments: payload, base_rev: base, rev }), acked: false };
  }

  private settleState() {
    if (this.stopped || this.state === "conflict" || this.state === "failed") return;
    if (!this.dirty && !this.debounce) this.set("saved");
    else if (this.state === "saved") this.set("saving");
  }

  private pump(): void {
    if (this.stopped || this.state === "conflict" || this.inflight || this.backoff) return;
    if (this.retry) {
      this.send(this.retry);
      return;
    }
    const want = this.latest ? timelinePayload(this.latest) : null;
    if (!want || !want.length || (this.ack.payload && sameTimeline(this.ack.payload, want, this.d.duration))) {
      // nothing to save (an empty timeline is never sent: the backend refuses it)
      this.latest = null;
      this.writeBackup();
      this.settleState();
      return;
    }
    this.send(this.fresh(want));
  }

  private send(sent: Sent, keepalive = false, unloading = false, chained = false): void {
    this.known.add(sent.rev);
    this.byRev.set(sent.rev, sent.payload);
    if (!chained) this.inflight = sent;
    this.writeBackup();
    if (this.state === "saved") this.set("saving");
    const res = this.d.fetch(`/jobs/${this.d.jobId}/edit-segments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: sent.body,
      ...(keepalive && sent.body.length < KEEPALIVE_LIMIT ? { keepalive: true } : {}),
      ...(unloading ? { unloading: true } : {}),
    });
    // reopening the job waits until the server has it (or the request is
    // over) — not for the preview re-encode its answer waits for
    const stored = new Promise<void>((r) => (sent.release = r));
    void this.handle(sent, res, chained).finally(() => sent.release?.());
    this.d.track?.(stored);
  }

  /** Poll GET /jobs/{id} until it shows `sent` stored (its rev), the answer came, or the time is up. */
  private async pollStored(sent: Sent, answered: () => boolean): Promise<void> {
    const { firstMs, everyMs, timeoutMs } = this.d.poll;
    const until = this.d.now() + timeoutMs;
    let wait = firstMs;
    for (;;) {
      await new Promise<void>((r) => this.d.setTimer(r, wait));
      wait = everyMs;
      if (answered() || sent.acked || this.stopped || this.d.now() > until) return;
      try {
        const r = await this.d.fetch(`/jobs/${this.d.jobId}`, { cache: "no-store" });
        if (answered() || sent.acked) return;
        if (r.status === 404 || r.status === 410) return;
        if (!r.ok) continue;
        const j = (await r.json()) as { edit_rev?: unknown; status?: unknown };
        if (j.edit_rev === sent.rev) {
          this.acked(sent);
          return;
        }
        if (typeof j.status === "string" && j.status !== "awaiting_review") return;
      } catch {
        /* a hiccup: ask again */
      }
    }
  }

  private async handle(sent: Sent, res: Promise<Response>, chained: boolean): Promise<void> {
    let answered = false;
    void this.pollStored(sent, () => answered);
    let r: Response;
    try {
      r = await res;
    } catch {
      answered = true;
      if (!sent.acked && !chained) this.retryLater(sent);
      return;
    }
    answered = true;
    if (r.ok) {
      this.acked(sent);
      const data = (await r.json().catch(() => null)) as TimelineAnswer | null;
      if (data && !this.stopped) this.d.onAnswer?.(data, sent.payload);
      return;
    }
    let code: string | null = null;
    let serverRev: number | null = null;
    try {
      const j = (await r.json()) as { detail?: unknown; rev?: unknown };
      code = typeof j.detail === "string" ? j.detail : null;
      serverRev = typeof j.rev === "number" ? j.rev : null;
    } catch {
      /* no body */
    }
    if (r.status === 409 && code === "stale_rev") {
      // our own write committed and its answer was lost
      if (serverRev === sent.rev) {
        this.acked(sent);
        return;
      }
      if (serverRev !== null && this.known.has(serverRev) && this.rebases < 3) {
        this.rebases++;
        this.rebase(sent, serverRev);
        return;
      }
      if (chained) return;
      this.conflict(serverRev);
      return;
    }
    if (sent.acked) {
      // stored (the poll saw it); the rebuild behind the answer failed
      if (r.status >= 500 && !this.stopped) this.d.onAnswer?.({ preview_ok: false, superseded: false }, sent.payload);
      return;
    }
    if (chained) return;
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      this.retryLater(sent);
      return;
    }
    this.fail(sent);
  }

  private acked(sent: Sent) {
    if (sent.acked) return;
    sent.acked = true;
    sent.release?.();
    this.rebases = 0;
    this.attempt = 0;
    if (this.retry === sent) this.retry = null;
    if (sent.rev > this.ack.rev) this.ack = { rev: sent.rev, payload: sent.payload };
    if (this.inflight === sent) this.inflight = null;
    if (this.latest && sameTimeline(timelinePayload(this.latest), this.ack.payload ?? [], this.d.duration)) this.latest = null;
    this.writeBackup();
    if (this.state === "retrying" || this.state === "failed") this.set("saving");
    if (!this.debounce && !this.inflight) this.pump();
    this.settleState();
  }

  /** The server has what an earlier request of ours wrote (rev `serverRev`): go on from there. */
  private rebase(sent: Sent, serverRev: number) {
    if (serverRev !== this.ack.rev) this.ack = { rev: serverRev, payload: this.byRev.get(serverRev) ?? null };
    if (this.inflight === sent) this.inflight = null;
    if (this.retry === sent) this.retry = null;
    // what was refused is still `latest` (cleared only once acknowledged): it goes again on this rev
    if (!this.inflight) this.pump();
  }

  private conflict(serverRev: number | null) {
    const mine = this.latest;
    if (mine) this.refused = { segs: mine, base: this.ack.rev };
    this.clearTimers();
    this.inflight = null;
    this.retry = null;
    this.latest = null;
    this.stopped = true;
    this.set("conflict");
    this.writeBackup();
    if (!this.closing) this.d.onConflict?.(serverRev, mine);
  }

  private fail(sent: Sent) {
    if (this.inflight === sent) this.inflight = null;
    if (this.retry === sent) this.retry = null;
    this.set("failed");
    this.settleWaiters();
  }

  private settleWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** The answer to `sent` is unknown (it may have committed): send it again as it is. */
  private retryLater(sent: Sent) {
    if (this.inflight === sent) this.inflight = null;
    if (this.stopped) return;
    this.retry = sent;
    this.set("retrying");
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    if (this.backoff) this.d.clearTimer(this.backoff);
    this.backoff = this.d.setTimer(() => {
      this.backoff = null;
      this.pump();
    }, ms);
    if (this.closing && this.attempt > 4) this.settleWaiters();
  }
}
