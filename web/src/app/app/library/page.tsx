"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
    <main className="flex min-h-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-zinc-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link href="/app" className="text-xl font-bold tracking-tight">
            Cleo
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-xs text-zinc-500">Library</span>
        </div>
        <Link
          href="/app"
          className="rounded-lg bg-violet-500 px-4 py-2 text-xs font-medium text-white hover:bg-violet-400"
        >
          + New project
        </Link>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 px-5 py-8">
        {entries === null ? (
          <div className="mt-32 text-center text-sm text-zinc-500">
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.15em] text-zinc-500">
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
    <div className="mx-auto mt-24 max-w-sm text-center">
      <div className="mb-4 text-5xl">📁</div>
      <div className="mb-2 text-xl font-semibold">No projects yet</div>
      <div className="mb-8 text-sm text-zinc-500">
        Renders you finish will show up here so you can re-download outputs and
        share captions later.
      </div>
      <Link
        href="/app"
        className="inline-block rounded-xl bg-violet-500 px-6 py-3 text-sm font-semibold hover:bg-violet-400"
      >
        Pick a workflow
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
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            {entry.presetIcon && (
              <span className="text-lg">{entry.presetIcon}</span>
            )}
            <span className="text-sm font-semibold text-white">
              {entry.presetLabel ?? "Custom"}
            </span>
            <span className="text-zinc-700">·</span>
            <span className="text-[11px] text-zinc-500">
              {formatRelativeTime(entry.timestamp)}
            </span>
          </div>
          <div className="truncate text-xs text-zinc-500">{entry.filename}</div>
        </div>
        <button
          onClick={() => onDelete(entry.jobId)}
          className="shrink-0 text-zinc-700 hover:text-red-400"
          aria-label="Delete project"
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
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              f === "primary"
                ? "bg-violet-500 text-white hover:bg-violet-400"
                : "border border-violet-400/40 text-violet-100 hover:bg-violet-500/10"
            }`}
          >
            ⬇ {formatLabel(f)}
          </a>
        ))}
        {entry.hookClips.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
          >
            {entry.hookClips.length} hook{entry.hookClips.length === 1 ? "" : "s"}{" "}
            {expanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {expanded && entry.hookClips.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800 pt-3">
          {entry.hookClips.map((h) => (
            <a
              key={h.key}
              href={`${backendUrl()}/jobs/${entry.jobId}/download?format=${encodeURIComponent(h.key)}`}
              download
              className="block rounded-lg border border-zinc-800 p-2 hover:border-violet-400/60"
            >
              <div className="mb-0.5 flex items-center justify-between text-xs">
                <div className="font-semibold text-white">{h.title}</div>
                <div className="text-[10px] text-zinc-500">
                  {(h.end - h.start).toFixed(0)}s
                </div>
              </div>
              {h.reason && (
                <div className="line-clamp-2 text-[11px] text-zinc-500">
                  {h.reason}
                </div>
              )}
            </a>
          ))}
        </div>
      )}

      {(entry.socialCaption || hashtagLine) && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Caption
            </span>
            <button
              onClick={copyCaption}
              className="text-[10px] uppercase tracking-wider text-violet-400 hover:text-violet-300"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
          {entry.socialCaption && (
            <div className="text-xs text-zinc-300">{entry.socialCaption}</div>
          )}
          {hashtagLine && (
            <div className="mt-1 text-[11px] text-violet-300">{hashtagLine}</div>
          )}
        </div>
      )}
    </div>
  );
}
