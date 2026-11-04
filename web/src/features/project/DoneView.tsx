"use client";
/**
 * The Done view (UX11, flows.md §3.7, PLAN 3.7), revived from the v1
 * DoneScreen: the export sheet's last state in the v2 editor (a finished
 * project's page is the Vorschau, PreviewScreen, which shares its parts:
 * done/).
 *
 *   preview          autoplay, muted, loop; a play button when the
 *                    browser refuses autoplay
 *   Save / Share…    phones with file sharing: the file is fetched when
 *                    the view opens ("Preparing…") and shared from the
 *                    tap itself (done/useShareFile); else / above 250 MB
 *                    Download
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
import { Check, Download, Pencil, Play, Plus, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import type { JobStatus } from "@/features/jobs/types";
import { useMediaQuery } from "@/features/editor/v2/hooks";
import { BonusClips } from "./done/BonusClips";
import { CaptionFiles } from "./done/CaptionFiles";
import { PostText } from "./done/PostText";
import { Survey } from "./done/Survey";
import { Tip } from "./done/Tip";
import { downloadHref, exportFiles, useShareFile } from "./done/useShareFile";
import { downloadLabel, editAgainNote } from "./exportsInfo";

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
  const { all: downloads, primary } = exportFiles(job);
  const names = job.download_names ?? {};
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
  const coarse = useMediaQuery("(pointer: coarse)");
  const share = useShareFile(job, primary, { on: coarse, prefetch: true });
  const shareFirst = share.state === "preparing" || share.state === "ready";

  const note = editAgainNote(job, t, lang);

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
            onClick={share.share}
            disabled={share.state === "preparing"}
            data-testid="done-share"
          >
            <Icon icon={Share2} size={16} />
            {share.state === "preparing" ? t("app.done.preparing") : t("app.done.saveShare")}
          </Button>
        )}
        {downloads.map((d) => {
          const main = d.format === primary?.format && !shareFirst;
          return (
            <a
              key={d.format}
              href={downloadHref(job.id, d.format)}
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

      <PostText job={job} />
      <CaptionFiles job={job} />
      <BonusClips job={job} />

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

      <Tip job={job} />
      <Survey job={job} />
    </div>
  );
}
