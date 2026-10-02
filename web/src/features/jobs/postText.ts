/**
 * The post text (caption + hashtags) a project tile's menu copies (UX12).
 * Fetched when the menu opens and kept for the next open — but only a
 * successful answer, and only while the project is the same revision:
 * its status, whether it has an output and its updated_at (a new export
 * or edit changes the text).
 */
import type { Project } from "./projects";

export type PostTextEntry = {
  /** What the entry was fetched for (postTextKey). */
  key: string;
  promise: Promise<string>;
  /** The text once known ("" = none); null while loading. */
  text: string | null;
  /** The fetch failed: not reused (the next open asks again). */
  failed: boolean;
};

export function postTextKey(p: Pick<Project, "id" | "state" | "hasOutput" | "updatedAt">): string {
  return `${p.id}|${p.state}|${p.hasOutput ? 1 : 0}|${p.updatedAt ?? ""}`;
}

/** The caption and hashtags of a full job as one text ("" = none). */
export function postTextOf(job: Record<string, unknown>): string {
  const caption = typeof job.social_caption === "string" ? job.social_caption : "";
  const tags = Array.isArray(job.social_hashtags) ? (job.social_hashtags as unknown[]).filter((x) => typeof x === "string") : [];
  return [caption, tags.map((h) => `#${String(h).replace(/^#/, "")}`).join(" ")].filter(Boolean).join("\n\n");
}

/** `cached` if it can be used for `key`, else a new fetch. */
export function postTextEntry(
  cached: PostTextEntry | null,
  key: string,
  fetchJob: () => Promise<Record<string, unknown> | null>,
): PostTextEntry {
  if (cached && cached.key === key && !cached.failed) return cached;
  const entry: PostTextEntry = { key, text: null, failed: false, promise: Promise.resolve("") };
  entry.promise = fetchJob().then(
    (job) => {
      if (!job) {
        entry.failed = true;
        return "";
      }
      entry.text = postTextOf(job);
      return entry.text;
    },
    () => {
      entry.failed = true;
      return "";
    },
  );
  return entry;
}
