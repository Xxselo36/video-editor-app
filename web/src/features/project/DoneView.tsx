"use client";
/**
 * The Done view (UX11, flows.md §3.7, PLAN 3.7), revived from the v1
 * DoneScreen: the project page of a finished video (/app/p/[jobId]) and
 * the export sheet's last state in the v2 editor.
 *
 *   preview          autoplay, muted, loop; a play button when the
 *                    browser refuses autoplay
 *   Save / Share…    phones with file sharing: the file is fetched when
 *                    the view opens ("Preparing…") and shared from the
 *                    tap itself (share.ts); else / above 250 MB Download
 *   downloads        one per distinct file ("9:16 · 12 MB"), named after
 *                    the project by the backend
 *   post text        editable (saved on blur), Copy; no regenerate (G7)
 *   SRT · VTT        the export's captions as files (F8)
 *   bonus clips      only what the backend kept (untouched timeline,
 *                    ≥ 90 s: G6)
 *   Edit again       POST /reopen; the free-exports counter when billed
 *   tip              "Cleo cut" while recording (E3), dismissible
 *   survey           "Did you have to edit this video anywhere else?"
 *                    from this browser's 2nd export, ≤ once a week (A5)
 */
import { Check, Copy, Download, FileText, Pencil, Play, Plus, Share2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { mediaUrl, useMediaReady, useMediaUrl } from "@/lib/api";
import type { JobStatus } from "@/features/jobs/types";
import {
  clock,
  dismissTip,
  downloadLabel,
  editAgainNote,
  noteExport,
  surveyAnswered,
  tipDismissed,
} from "./exportsInfo";
import { saveSocialCaption, sendSurvey } from "./projectApi";
import { downloadUrl, prefetchFile, shareFile, shareMode } from "./share";

export type HookClip = {
  key: string;
  title: string;
  reason: string;
  start: number;
  end: number;
};

type ShareState = "off" | "preparing" | "ready" | "failed";

function initialPostText(job: JobStatus): string {
  if (job.social_caption_edited != null) return job.social_caption_edited;
  const tags = (job.social_hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return [job.social_caption ?? "", tags].filter(Boolean).join("\n\n");
}

export function DoneView({
  job,
  onEditAgain,
  onNewVideo,
  editAgainBusy = false,
  editAgainError = null,
  inEditor = false,
}: {
  job: JobStatus;
  onEditAgain: () => void;
  onNewVideo: () => void;
  editAgainBusy?: boolean;
  editAgainError?: string | null;
  /** Shown in the editor's export sheet (smaller preview). */
  inEditor?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const watchSrc = useMediaUrl(job.id, "watch", { v: job.renders_ok ?? 0 });
  const posterSrc = useMediaUrl(job.id, "thumbnail", { v: job.renders_ok ?? 0 });
  const downloads = useMemo(
    () =>
      job.downloads?.length
        ? job.downloads
        : (job.outputs ?? ["primary"]).filter((f) => !f.startsWith("hook_")).map((f) => ({ format: f, bytes: null })),
    [job.downloads, job.outputs],
  );
  const primary = downloads.find((d) => d.format === "primary") ?? downloads[0];
  const names = job.download_names ?? {};
  // name=v2: the backend names the file after the project (UX11).
  const dl = (format: string) => mediaUrl(job.id, "download", { format, name: "v2" });
  const aspect = job.output_aspect ?? null;

  // ── preview ──────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !watchSrc) return;
    const p = v.play();
    if (p) p.catch(() => setNeedsTap(true));
  }, [watchSrc]);

  // ── Save / Share (phones) ────────────────────────────────────────
  const [share, setShare] = useState<ShareState>("off");
  const fileRef = useRef<File | null>(null);
  // With accounts on, media URLs need the day token: prefetch once it's set.
  const mediaReady = useMediaReady();
  useEffect(() => {
    if (!primary || !mediaReady) return;
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (!coarse || shareMode(primary.bytes) !== "share") return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the prefetch starts with the view
    setShare("preparing");
    prefetchFile(dl(primary.format), names[primary.format] ?? "video.mp4", ctrl.signal)
      .then((f) => {
        fileRef.current = f;
        setShare("ready");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setShare("failed");
      });
    return () => ctrl.abort();
    // names: fixed per export
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, primary?.format, primary?.bytes, job.renders_ok, mediaReady]);

  const onShare = () => {
    const file = fileRef.current;
    const url = dl(primary?.format ?? "primary");
    const name = names[primary?.format ?? "primary"] ?? "video.mp4";
    if (!file) {
      downloadUrl(url, name);
      return;
    }
    // Synchronously from the tap: iOS opens the sheet only then.
    void shareFile(file).then((outcome) => {
      if (outcome === "shared") track("share_used", { bytes: file.size });
      if (outcome === "failed") {
        track("share_failed", {});
        downloadUrl(url, name);
      }
    });
  };

  // ── post text ────────────────────────────────────────────────────
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

  // ── tip, survey ──────────────────────────────────────────────────
  const [tip, setTip] = useState(false);
  const [survey, setSurvey] = useState<"off" | "ask" | "what" | "thanks">("off");
  const [surveyText, setSurveyText] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists in the browser
    setTip(!(job.scene_events && job.scene_events.length) && !tipDismissed());
    if (noteExport(`${job.id}:${job.renders_ok ?? 0}`)) setSurvey("ask");
  }, [job.id, job.renders_ok, job.scene_events]);
  const answer = (a: "yes" | "no") => {
    if (a === "yes") {
      setSurvey("what");
      return;
    }
    sendSurvey(job.id, "no");
    surveyAnswered();
    setSurvey("thanks");
  };

  const note = editAgainNote(job, t, lang);
  const hooks = (job.hook_clips ?? []) as HookClip[];
  const shareFirst = share === "preparing" || share === "ready";

  return (
    <div className={`flex flex-col items-center gap-5 ${inEditor ? "py-1" : "py-4"}`} data-testid="done-view">
      <div
        className="relative w-full overflow-hidden rounded-2xl"
        style={{
          maxWidth: inEditor ? 220 : aspect === "16:9" ? 560 : 340,
          background: "#000",
          border: "1px solid var(--border-hover)",
          boxShadow: "var(--shadow-glow)",
        }}
      >
        {watchSrc && (
          <video
            ref={videoRef}
            src={watchSrc}
            poster={posterSrc ?? undefined}
            muted
            loop
            playsInline
            autoPlay
            controls={!needsTap}
            className="block w-full"
            style={{ maxHeight: inEditor ? "38vh" : "60vh" }}
            data-testid="done-video"
          />
        )}
        {needsTap && (
          <button
            type="button"
            aria-label={t("app.done.play")}
            onClick={() => {
              setNeedsTap(false);
              void videoRef.current?.play().catch(() => setNeedsTap(true));
            }}
            className="absolute inset-0 flex items-center justify-center bg-black/30"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/90 text-black">
              <Icon icon={Play} size={24} />
            </span>
          </button>
        )}
      </div>

      <h2 className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--text-strong)" }}>
        <Icon icon={Check} className="text-[var(--success)]" size={18} strokeWidth={2.5} />
        {t("app.done.readyToPost")}
      </h2>

      <div className="flex w-full max-w-sm flex-col gap-2">
        {shareFirst && (
          <Button
            size="md"
            className="flex w-full items-center justify-center gap-2 py-3"
            onClick={onShare}
            disabled={share === "preparing"}
            data-testid="done-share"
          >
            <Icon icon={Share2} size={16} />
            {share === "preparing" ? t("app.done.preparing") : t("app.done.saveShare")}
          </Button>
        )}
        {downloads.map((d) => {
          const main = d.format === primary?.format && !shareFirst;
          return (
            <a
              key={d.format}
              href={dl(d.format)}
              download={names[d.format] ?? true}
              className={`flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold ${
                main
                  ? "bg-[var(--brand-solid)] text-white hover:bg-[var(--brand-solid-hover)]"
                  : "border border-[var(--border-hover)] text-[var(--text-strong)] hover:border-[var(--brand)]"
              }`}
              data-testid="done-download"
              data-format={d.format}
            >
              <Icon icon={Download} size={16} />
              <span>{t("app.done.download")}</span>
              <span className="font-normal opacity-75">{downloadLabel(d.format, d.bytes, aspect, t)}</span>
            </a>
          );
        })}
      </div>

      <section className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left">
        <div className="mb-2 flex items-center justify-between gap-2">
          <label htmlFor={`post-${job.id}`} className="text-xs font-semibold text-[var(--text-body)]">
            {t("app.done.postText")}
          </label>
          <button
            type="button"
            onClick={copyPost}
            disabled={!post}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-[var(--brand-hover)] hover:bg-[var(--brand-tint)] disabled:opacity-50"
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
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-2 text-sm leading-relaxed text-[var(--text-strong)] focus:border-[var(--brand)] focus:outline-none"
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

      {job.has_captions_file && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-body)]" data-testid="done-captions">
          <Icon icon={FileText} size={14} />
          <span>{t("app.done.captionFiles")}</span>
          {(["srt", "vtt"] as const).map((kind) => (
            <a
              key={kind}
              href={mediaUrl(job.id, `captions.${kind}`)}
              download
              onClick={() => track("srt_downloaded", { kind })}
              className="rounded-md border border-[var(--border-hover)] px-2 py-0.5 font-semibold uppercase text-[var(--text-strong)] hover:border-[var(--brand)]"
              data-testid={`done-${kind}`}
            >
              {kind}
            </a>
          ))}
        </div>
      )}

      {hooks.length > 0 && (
        <section className="w-full max-w-md" data-testid="done-hooks">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-body)]">
            <Icon icon={Sparkles} size={14} />
            {t("app.done.bonusClips")}
            <span className="rounded bg-[var(--brand-tint)] px-1.5 py-0.5 text-[10px] text-[var(--brand-strong)]">
              {t("app.done.aiPicked")}
            </span>
          </h3>
          <div className="flex flex-col gap-2">
            {hooks.map((h) => (
              <a
                key={h.key}
                href={dl(h.key)}
                download={names[h.key] ?? true}
                className="block rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 hover:border-[var(--brand)]"
              >
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--text-strong)]">{h.title}</span>
                  <span className="flex items-center gap-1 text-xs tabular-nums text-[var(--text-muted)]">
                    {clock(h.end - h.start)}
                    <Icon icon={Download} size={13} />
                  </span>
                </div>
                {h.reason && <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{h.reason}</p>}
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="flex w-full max-w-sm flex-col items-center gap-1.5">
        <div className="flex w-full gap-2">
          <Button
            variant="tint"
            className="flex flex-1 items-center justify-center gap-2"
            onClick={onEditAgain}
            disabled={editAgainBusy}
            data-testid="done-edit-again"
          >
            <Icon icon={Pencil} size={15} />
            {editAgainBusy ? t("app.header.opening") : t("app.done.editAgain")}
          </Button>
          <Button
            variant="tint"
            className="flex flex-1 items-center justify-center gap-2"
            onClick={onNewVideo}
            data-testid="done-new-video"
          >
            <Icon icon={Plus} size={15} />
            {t("app.done.newVideo")}
          </Button>
        </div>
        {note && (
          <p className="text-center text-xs text-[var(--text-muted)]" data-testid="done-counter">
            {note}
          </p>
        )}
        {editAgainError && (
          <p role="alert" className="text-center text-xs text-[var(--danger)]" data-testid="done-edit-error">
            {editAgainError}
          </p>
        )}
      </div>

      {tip && (
        <p
          className="flex w-full max-w-md items-start gap-2 rounded-lg bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--text-body)]"
          data-testid="done-tip"
        >
          <span className="flex-1">{t("app.done.cleoCutTip")}</span>
          <button
            type="button"
            aria-label={t("app.done.dismiss")}
            className="text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            onClick={() => {
              dismissTip();
              setTip(false);
            }}
          >
            <Icon icon={X} size={14} />
          </button>
        </p>
      )}

      {survey !== "off" && (
        <section
          className="w-full max-w-md rounded-xl border border-[var(--border)] p-3 text-center text-sm text-[var(--text-body)]"
          data-testid="done-survey"
          aria-live="polite"
        >
          {survey === "thanks" ? (
            <p>{t("app.done.surveyThanks")}</p>
          ) : (
            <>
              <p className="mb-2">{t("app.done.surveyQuestion")}</p>
              {survey === "ask" ? (
                <div className="flex justify-center gap-2">
                  <Button size="sm" variant="tint" onClick={() => answer("yes")} data-testid="done-survey-yes">
                    {t("app.done.surveyYes")}
                  </Button>
                  <Button size="sm" variant="tint" onClick={() => answer("no")} data-testid="done-survey-no">
                    {t("app.done.surveyNo")}
                  </Button>
                </div>
              ) : (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendSurvey(job.id, "yes", surveyText.trim() || undefined);
                    surveyAnswered();
                    setSurvey("thanks");
                  }}
                >
                  <input
                    value={surveyText}
                    onChange={(e) => setSurveyText(e.target.value)}
                    maxLength={300}
                    aria-label={t("app.done.surveyWhat")}
                    placeholder={t("app.done.surveyWhat")}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1 text-sm text-[var(--text-strong)]"
                  />
                  <Button size="sm" type="submit" data-testid="done-survey-send">
                    {t("app.done.surveySend")}
                  </Button>
                </form>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
