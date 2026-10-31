"use client";
/**
 * The post text of an export (UX11): the AI caption and hashtags,
 * editable (saved on blur), Copy; no regenerate (G7). The editor's Done
 * view and the Vorschau's "Mehr zum Video".
 */
import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import type { JobStatus } from "@/features/jobs/types";
import { saveSocialCaption } from "../projectApi";

function initialPostText(job: JobStatus): string {
  if (job.social_caption_edited != null) return job.social_caption_edited;
  const tags = (job.social_hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return [job.social_caption ?? "", tags].filter(Boolean).join("\n\n");
}

export function PostText({ job }: { job: JobStatus }) {
  const t = useT();
  const [post, setPost] = useState(() => initialPostText(job));
  const savedPost = useRef(post);
  const [postState, setPostState] = useState<"idle" | "saving" | "saved" | "failed" | "copied">("idle");
  const savePost = () => {
    if (post === savedPost.current) return;
    const text = post;
    setPostState("saving");
    saveSocialCaption(job.id, text)
      .then(() => {
        savedPost.current = text;
        setPostState("saved");
      })
      .catch(() => setPostState("failed"));
  };
  const copyPost = () => {
    if (!post || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(post)
      .then(() => setPostState("copied"))
      .catch(() => {});
  };

  return (
    <section className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label htmlFor={`post-${job.id}`} className="text-xs font-semibold text-[var(--text-body)]">
          {t("app.done.postText")}
        </label>
        <button
          type="button"
          onClick={copyPost}
          disabled={!post}
          // The tap area reaches 44 px high (::after).
          className="relative inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-[var(--brand-hover)] after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] hover:bg-[var(--brand-tint)] disabled:opacity-50"
          data-testid="done-copy"
        >
          <Icon icon={postState === "copied" ? Check : Copy} size={13} />
          {postState === "copied" ? t("app.done.copied") : t("app.done.copyText")}
        </button>
      </div>
      <textarea
        id={`post-${job.id}`}
        value={post}
        onChange={(e) => {
          setPost(e.target.value);
          if (postState !== "saving") setPostState("idle");
        }}
        onBlur={savePost}
        rows={4}
        maxLength={5000}
        placeholder={t("app.done.postPlaceholder")}
        // 16 px on touch screens: iOS zooms into a smaller field.
        className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-2 text-sm leading-relaxed text-[var(--text-strong)] focus:border-[var(--brand)] focus:outline-none pointer-coarse:text-base"
        data-testid="done-post"
      />
      <div className="mt-1 min-h-4 text-[11px] text-[var(--text-muted)]" aria-live="polite" data-testid="done-post-state">
        {postState === "saving"
          ? t("app.done.saving")
          : postState === "saved"
            ? t("app.done.saved")
            : postState === "failed"
              ? t("app.done.saveFailed")
              : ""}
      </div>
    </section>
  );
}
