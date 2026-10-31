/**
 * The pick-time check (D9): a video the server would refuse is refused
 * before any byte goes up (an audio file, over the size or length limit,
 * under the minimum; with billing enforced, no plan or too few minutes),
 * so the reason shows on "New video" and nothing is uploaded or listed.
 * The server's rules; it checks again anyway, and so does uploadJob.
 */
import type { Me, Paywall } from "@/lib/account";
import { uploadLimitHit } from "@/lib/chunkedUpload";
import { getConfig, type Limits } from "@/lib/config";
import type { VideoProbe } from "@/features/start/probe";

/** A code with its params (lib/errors words it), or the plan dialog. */
export type Refusal = { code: string; params: Record<string, number> } | { paywall: Paywall };

/** Why this video can't go up, or null. `duration` null: the browser
 *  can't read it (the server probes); `billing` null: off or not known. */
export function uploadRefusal(i: {
  size: number;
  type: string;
  duration: number | null;
  limits: Limits;
  billing: { enforce: boolean; plan: string | null; remainingSeconds: number | null } | null;
}): Refusal | null {
  // (The server answers no_video once it probed the file.)
  if (i.type.startsWith("audio/")) return { code: "no_video", params: {} };
  const limit = uploadLimitHit(i.size, i.duration, i.limits);
  if (limit) return { code: limit.code, params: limit.params };
  const b = i.billing;
  if (!b?.enforce) return null;
  if (!b.plan) return { paywall: { code: "subscription_required" } };
  if (b.remainingSeconds === null) return null;
  // As backend _paywall_soft_check: whole seconds needed, and no minutes
  // left refuses a video of unknown length too.
  const needed = i.duration === null ? 0 : Math.ceil(i.duration);
  if (b.remainingSeconds > 0 && needed <= b.remainingSeconds) return null;
  return {
    paywall: { code: "quota_exceeded", remainingSeconds: Math.round(b.remainingSeconds), neededSeconds: needed || null },
  };
}

/** uploadRefusal with the deployment's limits (GET /config), the probe's
 *  length and the account's plan and minutes (GET /me; `billingOn`: the
 *  billing config says billing is on). */
export async function precheckUpload(
  file: File,
  probe: VideoProbe | null,
  me: Me | null,
  billingOn: boolean,
): Promise<Refusal | null> {
  const { limits } = await getConfig();
  const minutes = me?.minutes;
  return uploadRefusal({
    size: file.size,
    type: file.type,
    duration: probe?.duration ?? null,
    limits,
    billing:
      billingOn && me?.billing?.enabled
        ? {
            enforce: me.billing.enforce,
            plan: me.plan ?? null,
            remainingSeconds: minutes ? (minutes.remaining_seconds ?? minutes.remaining * 60) : null,
          }
        : null,
  });
}
