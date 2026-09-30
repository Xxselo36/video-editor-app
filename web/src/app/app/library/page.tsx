"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import { IconArrowRight } from "@/components/Icons";
import {
  deleteEntry,
  getLibrary,
  type LibraryEntry,
} from "@/lib/library";
import { VideoModal } from "@/components/VideoModal";
import { LanguageSwitcher, useT, type TFn } from "@/i18n";
import { AUTH_ENABLED } from "@/lib/auth";
import { apiFetch, mediaUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import { fetchServerJobs, serverJobToLibraryEntry } from "@/lib/account";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";

function formatLabel(f: string, t: TFn): string {
  if (f === "primary") return t("library.format.primary");
  if (f.startsWith("hook_")) return t("library.format.hook", { n: f.split("_")[1] });
  return f;
}

/** Localized twin of formatRelativeTime() from lib/library (same thresholds). */
function relativeTime(ts: number, t: TFn): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t("library.time.justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("library.time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("library.time.hoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t("library.time.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString();
}

export default function Library() {
  const t = useT();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  // expires_at from the server list (accounts on) — saves a GET per card.
  const [serverExpiry, setServerExpiry] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!AUTH_ENABLED) {
      setEntries(getLibrary());
      return;
    }
    // Accounts on: the server list is the source of truth (all devices).
    // Local entries it doesn't list stay visible — old beta projects
    // (their card's GET assigns them to this account) or expired ones.
    let cancelled = false;
    void fetchServerJobs().then((list) => {
      if (cancelled) return;
      const local = getLibrary();
      if (!list) {
        setEntries(local);
        return;
      }
      const done = list.filter((j) => j.has_output);
      const ids = new Set(done.map((j) => j.id));
      setServerExpiry(Object.fromEntries(done.map((j) => [j.id, j.expires_at ?? null])));
      setEntries(
        [...done.map(serverJobToLibraryEntry), ...local.filter((e) => !ids.has(e.jobId))].sort(
          (a, b) => b.timestamp - a.timestamp,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (jobId: string) => {
    if (!confirm(t("library.confirmDelete"))) return;
    // Delete on the server first (video, edits, renders). 404 = already
    // gone, fine; anything else (e.g. 409 still processing) keeps the
    // entry so the user can retry.
    try {
      const r = await apiFetch(`/jobs/${jobId}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        alert(t("library.deleteFailed"));
        return;
      }
    } catch {
      alert(t("library.deleteFailed"));
      return;
    }
    deleteEntry(jobId);
    if (AUTH_ENABLED) setEntries((prev) => (prev ?? []).filter((e) => e.jobId !== jobId));
    else setEntries(getLibrary());
  };

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      <header
        className="flex items-center justify-between gap-2 px-4 py-4 sm:px-6"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/app"
            className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-80"
            aria-label={t("library.header.homeAria")}
          >
            <LogoMark size={24} />
            {/* Wordmark hidden on phones to make room for the language picker. */}
            <span
              className="hidden text-xl font-bold tracking-tight sm:inline"
              style={{ color: "var(--text-strong)" }}
            >
              CleoCuts
            </span>
          </Link>
          <span style={{ color: "var(--text-faint)" }}>/</span>
          <span className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
            {t("library.header.title")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PricingLink className="mr-1 hidden sm:inline" />
          <LanguageSwitcher />
          <AccountMenu />
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-xs font-medium transition-transform hover:scale-105 sm:px-4"
            style={{
              background: "var(--brand-solid)",
              color: "white",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {t("library.header.newProject")} <IconArrowRight size={14} />
          </Link>
        </div>
      </header>

      <div className="phase-fade mx-auto w-full max-w-3xl flex-1 px-5 py-10">
        {entries === null ? (
          <div className="flex flex-col gap-3">
            <div className="mb-2 skeleton h-3 w-24" />
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-2xl p-5"
                style={{
                  background: "var(--surface-1)",
                  border: "1px solid var(--border)",
                }}
              >
                <div className="mb-3 skeleton h-4 w-40" />
                <div className="mb-4 skeleton h-3 w-64" />
                <div className="flex gap-2">
                  <div className="skeleton h-8 w-24" />
                  <div className="skeleton h-8 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className="mb-1 text-xs font-semibold uppercase tracking-[0.15em]"
              style={{ color: "var(--text-muted)" }}
            >
              {t(entries.length === 1 ? "library.count.one" : "library.count.other", {
                count: entries.length,
              })}
            </div>
            {entries.map((e) => (
              <LibraryCard
                key={e.jobId}
                entry={e}
                expiresAt={serverExpiry[e.jobId]}
                onDelete={remove}
                onPlay={setPlayingJobId}
              />
            ))}
          </div>
        )}
      </div>

      {playingJobId && (
        <VideoModal
          jobId={playingJobId}
          onClose={() => setPlayingJobId(null)}
        />
      )}
    </main>
  );
}


function EmptyState() {
  const t = useT();
  return (
    <div className="mx-auto mt-20 max-w-md text-center">
      <div
        className="mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{
          background: "var(--brand-tint)",
          color: "var(--brand-strong)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M3 7l3-3h5l2 2h8v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div
        className="mb-2 text-2xl font-bold"
        style={{ color: "var(--text-strong)" }}
      >
        {t("library.empty.title")}
      </div>
      <div
        className="mb-8 text-base leading-relaxed"
        style={{ color: "var(--text-body)" }}
      >
        {t("library.empty.body")}
      </div>
      <Link
        href="/app"
        className="inline-flex items-center gap-1.5 rounded-full px-6 py-3 text-sm font-semibold transition-transform hover:scale-105"
        style={{
          background: "var(--brand-solid)",
          color: "white",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {t("library.empty.cta")} <IconArrowRight size={16} />
      </Link>
    </div>
  );
}

function LibraryCard({
  entry,
  expiresAt,
  onDelete,
  onPlay,
}: {
  entry: LibraryEntry;
  /** Known from the server list (accounts on); undefined → ask per card. */
  expiresAt?: number | null;
  onDelete: (jobId: string) => void;
  onPlay: (jobId: string) => void;
}) {
  const t = useT();
  const [thumbFailed, setThumbFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Media URLs carry the per-user token when accounts are on: wait for it.
  const mediaReady = useMediaReady();
  const thumbSrc = useMediaUrl(entry.jobId, "thumbnail");
  // Server-side lifetime: expires_at (unix s) or "gone" once deleted.
  const [expiry, setExpiry] = useState<number | "gone" | null>(expiresAt ?? null);
  useEffect(() => {
    if (expiresAt !== undefined) return;
    let cancelled = false;
    apiFetch(`/jobs/${entry.jobId}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) setExpiry("gone");
        else if (r.ok) {
          const j = await r.json();
          if (!cancelled && typeof j.expires_at === "number") setExpiry(j.expires_at);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry.jobId, expiresAt]);
  const daysLeft =
    typeof expiry === "number" ? Math.ceil((expiry * 1000 - Date.now()) / 86400000) : null;
  const hashtagLine = entry.socialHashtags
    .map((h) => `#${h.replace(/^#/, "")}`)
    .join(" ");
  const copyCaption = () => {
    const text = [entry.socialCaption, hashtagLine].filter(Boolean).join("\n\n");
    if (!text || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  // Older entries were saved with numeric indices ("0", "1") because
  // an earlier bug ran Object.keys() on an array. Detect that and fall
  // back to just "primary" so the download links point at real files.
  const looksLikeLegacyIndices =
    entry.outputs.length > 0 && entry.outputs.every((f) => /^\d+$/.test(f));
  const outputsSafe = looksLikeLegacyIndices ? ["primary"] : entry.outputs;
  const mainOutputs = outputsSafe.filter((f) => !f.startsWith("hook_"));

  return (
    <div
      className="rounded-2xl p-5"
      data-testid="library-card"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="flex items-start gap-4">
        {/* Thumbnail — click to open inline video modal. Falls back to
            a plain preset-color tile if the thumbnail didn't render. */}
        <button
          onClick={() => onPlay(entry.jobId)}
          className="group relative shrink-0 overflow-hidden rounded-xl transition-transform hover:scale-[1.02]"
          style={{
            width: "88px",
            aspectRatio: "9 / 16",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
          }}
          aria-label={t("library.card.playAria", { name: entry.filename })}
        >
          {!thumbFailed && thumbSrc && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={thumbSrc}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setThumbFailed(true)}
              loading="lazy"
            />
          )}
          {thumbFailed && (
            <div
              className="flex h-full w-full items-center justify-center text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: "var(--text-faint)" }}
            >
              {t("library.card.noPreview")}
            </div>
          )}
          {/* Play triangle overlay */}
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          >
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full"
              style={{
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(4px)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 flex-wrap">
            <span
              className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
              style={{
                background: "var(--brand-tint)",
                color: "var(--brand-strong)",
              }}
            >
              {entry.presetLabel ?? t("library.card.customPreset")}
            </span>
            <span
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {relativeTime(entry.timestamp, t)}
            </span>
          </div>
          <div
            className="truncate text-sm"
            style={{ color: "var(--text-body)" }}
          >
            {entry.filename || t("app.library.untitled")}
          </div>
          {(expiry === "gone" || daysLeft !== null) && (
            <div
              className="mt-1 text-[11px]"
              data-testid="library-card-expiry"
              style={{
                color:
                  expiry === "gone" || (daysLeft !== null && daysLeft <= 3)
                    ? "var(--danger)"
                    : "var(--text-muted)",
              }}
            >
              {expiry === "gone"
                ? t("library.card.expired")
                : daysLeft !== null && daysLeft <= 1
                  ? t("library.card.expiresSoon")
                  : t("library.card.expiresDays", { n: daysLeft ?? 0 })}
            </div>
          )}
        </div>
        <button
          onClick={() => onDelete(entry.jobId)}
          className="shrink-0 transition-colors"
          style={{ color: "var(--text-faint)" }}
          aria-label={t("library.card.deleteAria")}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = "var(--danger)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = "var(--text-faint)")
          }
        >
          ✕
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {expiry !== "gone" && mediaReady && mainOutputs.map((f) => (
          <a
            key={f}
            href={mediaUrl(entry.jobId, "download", { format: f })}
            download
            data-testid="library-download"
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-105"
            style={
              f === "primary"
                ? {
                    background: "var(--brand-solid)",
                    color: "white",
                    boxShadow: "var(--shadow-sm)",
                  }
                : {
                    background: "var(--surface-2)",
                    color: "var(--brand-strong)",
                    border: "1px solid var(--border-hover)",
                  }
            }
          >
            ↓ {formatLabel(f, t)}
          </a>
        ))}
        {expiry !== "gone" && entry.hookClips.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-full px-3 py-1.5 text-xs transition-colors"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
            }}
          >
            {t(entry.hookClips.length === 1 ? "library.card.hooks.one" : "library.card.hooks.other", {
              count: entry.hookClips.length,
            })}{" "}
            {expanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {expanded && expiry !== "gone" && mediaReady && entry.hookClips.length > 0 && (
        <div
          className="mt-3 flex flex-col gap-2 pt-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          {entry.hookClips.map((h) => (
            <a
              key={h.key}
              href={mediaUrl(entry.jobId, "download", { format: h.key })}
              download
              className="block rounded-xl p-3 transition-colors"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="mb-0.5 flex items-center justify-between text-sm">
                <div
                  className="font-semibold"
                  style={{ color: "var(--text-strong)" }}
                >
                  {h.title}
                </div>
                <div
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("library.card.hookSeconds", { seconds: (h.end - h.start).toFixed(0) })}
                </div>
              </div>
              {h.reason && (
                <div
                  className="line-clamp-2 text-xs"
                  style={{ color: "var(--text-body)" }}
                >
                  {h.reason}
                </div>
              )}
            </a>
          ))}
        </div>
      )}

      {(entry.socialCaption || hashtagLine) && (
        <div
          className="mt-4 pt-4"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <div className="mb-1 flex items-center justify-between">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {t("library.card.caption")}
            </span>
            <button
              onClick={copyCaption}
              className="text-[11px] font-semibold uppercase tracking-wider transition-colors"
              style={{ color: "var(--brand-strong)" }}
            >
              {copied ? t("library.card.copied") : t("library.card.copy")}
            </button>
          </div>
          {entry.socialCaption && (
            <div className="text-sm" style={{ color: "var(--text-strong)" }}>
              {entry.socialCaption}
            </div>
          )}
          {hashtagLine && (
            <div
              className="mt-1 text-xs font-medium"
              style={{ color: "var(--brand-strong)" }}
            >
              {hashtagLine}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
