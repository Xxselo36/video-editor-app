"use client";
/**
 * The v1 "done" screen, kept aside (moved from app/app/page.tsx
 * in UX4). Nothing renders it since the dashboard cards took over;
 * UX11 revives it as the project's Done view.
 */
import { useT } from "@/i18n";
import { mediaUrl, useMediaUrl } from "@/lib/api";
import { EXPORT_FORMAT_OPTIONS } from "@/features/start/presets.legacy";

export type HookClip = {
  key: string;
  title: string;
  reason: string;
  start: number;
  end: number;
};

export function DoneView({
  jobId,
  outputs,
  socialCaption,
  socialHashtags,
  hookClips,
  onReset,
}: {
  jobId: string;
  outputs: string[];
  socialCaption: string;
  socialHashtags: string[];
  hookClips: HookClip[];
  onReset: () => void;
}) {
  const t = useT();
  const formatLabel = (f: string) =>
    f === "primary" ? t("app.done.downloadPrimary") : t("app.done.downloadFormat", { format: f });
  const formatSub = (f: string) => {
    const opt = EXPORT_FORMAT_OPTIONS.find((o) => o.id === f);
    return opt ? t(opt.descKey) : t("app.done.mainEdit");
  };

  const watchSrc = useMediaUrl(jobId, "watch");
  const posterSrc = useMediaUrl(jobId, "thumbnail");
  const hashtagLine = socialHashtags
    .map((h) => `#${h.replace(/^#/, "")}`)
    .join(" ");
  const copyText = (text: string) => {
    if (!text) return;
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center gap-5 py-4">
      {/* Peak-moment preview: user sees their finished video inline
          before scrolling to Download. Autoplay muted + playsInline
          works in iOS Safari; poster falls back to the thumbnail. */}
      <div
        className="w-full max-w-[360px] overflow-hidden rounded-2xl"
        style={{
          background: "#000",
          border: "1px solid var(--border-hover)",
          boxShadow:
            "0 0 0 1px rgba(139,92,246,0.25), 0 12px 40px rgba(139,92,246,0.28)",
        }}
      >
        {watchSrc && (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <video
            src={watchSrc}
            poster={posterSrc ?? undefined}
            controls
            autoPlay
            muted
            loop
            playsInline
            className="block w-full"
            style={{ maxHeight: "60vh" }}
          />
        )}
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--brand-strong)" }}>
        <span className="text-base">✨</span> {t("app.done.readyToPost")}
      </div>

      {(socialCaption || hashtagLine) && (
        <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
              {t("app.done.captionSuggestion")}
            </span>
            <button
              onClick={() => copyText(`${socialCaption}\n\n${hashtagLine}`.trim())}
              className="text-[10px] uppercase tracking-wider text-[var(--brand)] hover:text-[var(--brand-hover)]"
            >
              {t("app.done.copy")}
            </button>
          </div>
          {socialCaption && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-strong)]">
              {socialCaption}
            </div>
          )}
          {hashtagLine && (
            <div className="mt-2 text-xs text-[var(--brand-hover)]">{hashtagLine}</div>
          )}
        </div>
      )}

      <div className="flex w-full max-w-xs flex-col gap-2">
        {outputs
          .filter((f) => !f.startsWith("hook_"))
          .map((f) => (
            <a
              key={f}
              href={mediaUrl(jobId, "download", { format: f })}
              download
              className={`rounded-xl px-5 py-3 text-center font-semibold ${
                f === "primary"
                  ? "bg-[var(--brand-solid)] text-white hover:bg-[var(--brand-solid-hover)]"
                  : "border border-[var(--brand)] text-[var(--brand-strong)] hover:bg-[var(--brand)]/10"
              }`}
            >
              <div className="text-sm">{formatLabel(f)}</div>
              <div className="text-[10px] font-normal text-[var(--text-strong)]/70">
                {formatSub(f)}
              </div>
            </a>
          ))}
      </div>

      {hookClips.length > 0 && (
        <div className="w-full max-w-md">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
            <span>{t("app.done.bonusClips")}</span>
            <span className="rounded bg-[var(--brand)]/15 px-1.5 py-0.5 text-[var(--brand-hover)]">
              {t("app.done.aiPicked")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {hookClips.map((h) => {
              const dur = h.end - h.start;
              return (
                <a
                  key={h.key}
                  href={mediaUrl(jobId, "download", { format: h.key })}
                  download
                  className="block rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 hover:border-[var(--brand)]"
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[var(--text-strong)]">
                      {h.title}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                      {dur.toFixed(0)}s
                    </div>
                  </div>
                  {h.reason && (
                    <div className="line-clamp-2 text-xs text-[var(--text-muted)]">
                      {h.reason}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      )}
      <button
        onClick={onReset}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
      >
        {t("app.done.processAnother")}
      </button>
    </div>
  );
}
