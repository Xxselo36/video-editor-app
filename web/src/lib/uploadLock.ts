/**
 * Which upload records belong to an upload running in some tab (PR #66
 * review): the page that runs an upload holds a Web Lock named after its
 * record for the upload's whole life, and the browser lets it go however
 * the page goes. Another tab then never takes a running upload for a dead
 * one (markStaleUploads), even when the page that runs it is suspended
 * (iOS, another tab in front) or throttled (a hidden desktop tab) and its
 * heartbeat is late. Where Web Locks are missing, nothing changes: the
 * heartbeat alone decides, as before.
 */
const PREFIX = "cleocuts-upload-rec:";

type LockManagerLike = {
  request(name: string, cb: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
};

function locks(): LockManagerLike | null {
  try {
    const l = (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks;
    return l && typeof l.request === "function" && typeof l.query === "function" ? l : null;
  } catch {
    return null;
  }
}

/** This browser can tell running uploads by their lock. */
export const uploadLocks = (): boolean => locks() !== null;

/** Hold the lock of upload record `id` until the returned call. */
export function holdUploadLock(id: string): () => void {
  const l = locks();
  if (!l) return () => {};
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  void l.request(PREFIX + id, () => held).catch(() => {});
  return release;
}

/** The upload records some tab runs now; null: can't tell here. */
export async function runningUploads(): Promise<Set<string> | null> {
  const l = locks();
  if (!l) return null;
  try {
    const { held = [] } = await l.query();
    return new Set(held.map((h) => h.name ?? "").filter((n) => n.startsWith(PREFIX)).map((n) => n.slice(PREFIX.length)));
  } catch {
    return null;
  }
}
