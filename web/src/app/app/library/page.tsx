"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import { IconArrowRight } from "@/components/Icons";
import {
  deleteEntry,
  formatRelativeTime,
  getLibrary,
  type LibraryEntry,
} from "@/lib/library";

function backendUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

function formatLabel(f: string): string {
  if (f === "primary") return "Main edit";
  if (f.startsWith("hook_")) return `Hook clip ${f.split("_")[1]}`;
  return f;
}

export default function Library() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);

  useEffect(() => {
    setEntries(getLibrary());
  }, []);

  const remove = (jobId: string) => {
    if (!confirm("Delete this project from your library?")) return;
    deleteEntry(jobId);
    setEntries(getLibrary());
  };

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ background: "var(--surface-0)", color: "var(--text-strong)" }}
    >
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-3">
          <Link
            href="/app"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
          >
            <LogoMark size={24} />
            <span
              className="text-xl font-bold tracking-tight"
              style={{ color: "var(--text-strong)" }}
            >
              Cleo
            </span>
          </Link>
          <span style={{ color: "var(--text-faint)" }}>/</span>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Library
          </span>
        </div>
        <Link
          href="/app"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-transform hover:scale-105"
          style={{
            background: "var(--brand)",
            color: "white",
            boxShadow: "var(--shadow-md)",
          }}
        >
          New project <IconArrowRight size={14} />
        </Link>
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
              {entries.length} project{entries.length === 1 ? "" : "s"}
            </div>
            {entries.map((e) => (
              <LibraryCard key={e.jobId} entry={e} onDelete={remove} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
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
        Your library is empty
      </div>
      <div
        className="mb-8 text-base leading-relaxed"
        style={{ color: "var(--text-body)" }}
      >
        Every video you finish here shows up in this space. You can
        re-download, grab your captions, and share hook clips whenever.
      </div>
      <Link
        href="/app"
        className="inline-flex items-center gap-1.5 rounded-full px-6 py-3 text-sm font-semibold transition-transform hover:scale-105"
        style={{
          background: "var(--brand)",
          color: "white",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        Start your first project <IconArrowRight size={16} />
      </Link>
    </div>
  );
}

function LibraryCard({
  entry,
  onDelete,
}: {
  entry: LibraryEntry;
  onDelete: (jobId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
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

  const mainOutputs = entry.outputs.filter((f) => !f.startsWith("hook_"));

  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 flex-wrap">
            <span
              className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
              style={{
                background: "var(--brand-tint)",
                color: "var(--brand-strong)",
              }}
            >
              {entry.presetLabel ?? "Custom"}
            </span>
            <span
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {formatRelativeTime(entry.timestamp)}
            </span>
          </div>
          <div
            className="truncate text-sm"
            style={{ color: "var(--text-body)" }}
          >
            {entry.filename}
          </div>
        </div>
        <button
          onClick={() => onDelete(entry.jobId)}
          className="shrink-0 transition-colors"
          style={{ color: "var(--text-faint)" }}
          aria-label="Delete project"
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
        {mainOutputs.map((f) => (
          <a
            key={f}
            href={`${backendUrl()}/jobs/${entry.jobId}/download?format=${encodeURIComponent(f)}`}
            download
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-105"
            style={
              f === "primary"
                ? {
                    background: "var(--brand)",
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
            ↓ {formatLabel(f)}
          </a>
        ))}
        {entry.hookClips.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-full px-3 py-1.5 text-xs transition-colors"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
            }}
          >
            {entry.hookClips.length} hook{entry.hookClips.length === 1 ? "" : "s"}{" "}
            {expanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {expanded && entry.hookClips.length > 0 && (
        <div
          className="mt-3 flex flex-col gap-2 pt-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          {entry.hookClips.map((h) => (
            <a
              key={h.key}
              href={`${backendUrl()}/jobs/${entry.jobId}/download?format=${encodeURIComponent(h.key)}`}
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
                  {(h.end - h.start).toFixed(0)}s
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
              Caption
            </span>
            <button
              onClick={copyCaption}
              className="text-[11px] font-semibold uppercase tracking-wider transition-colors"
              style={{ color: "var(--brand-strong)" }}
            >
              {copied ? "copied" : "copy"}
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
