"use client";
/**
 * The Vorschau (PR2, plan D11 to D14, D21; approved mockups
 * docs/mockups/start/4-vorschau, -fertigstellen, -sichern): a project of
 * the v2 editor in every state, on /app/p/[jobId] (ProjectPage).
 *
 *   processing  the analysis as a checklist (ProcessingView)
 *   ready       the preview of the stored edit, with its captions;
 *               Fertigstellen (the server renders the edit as stored,
 *               useFinish) and Feinschliff (the editor; its back comes
 *               back here)
 *   edited      ready again after an export: the previous version stays
 *               downloadable until the new one is done
 *   finishing   Fertigstellen runs: the working button, "you can close
 *               this page", the place in line
 *   done        the export: "Video sichern" on an iPhone or iPad (the
 *               share sheet saves it to Photos), else "Herunterladen";
 *               Feinschliff (POST /reopen); "Mehr zum Video" (post text,
 *               SRT / VTT, bonus clips, other formats); survey and tip
 *   failed      the reason, "Anderes Video probieren"
 *
 * Ready and edited also say when an export failed (Fertigstellen tries
 * again), when the browser is offline (no Fertigstellen), and when this
 * device keeps timeline changes the server doesn't have: then only
 * "Feinschliff öffnen" (the editor brings them back; an export now would
 * miss them).
 *
 * The title row (name, length, ⋯ to rename or delete) is in every state.
 * ProjectPage loads this with next/dynamic: the players and the caption
 * layer come in this chunk, out of the route's first load. (Not a
 * next/dynamic of their own: one inside a dynamic chunk makes Turbopack
 * copy the i18n and API modules into every route's first load, +16 KB.)
 */
import { useRouter } from "next/navigation";
import { ChevronRight, Download, Film, TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import { useMediaReady, useMediaUrl } from "@/lib/api";
import { describeError, jobErrorText } from "@/lib/errors";
import { hasPendingSaves, waitForSaves } from "@/lib/pendingSaves";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { hasUnsavedTimeline } from "@/features/editor/session/unsavedKey";
import { useOnline } from "@/features/editor/v2/hooks";
import { hasExportHint, readLocalJobs } from "@/features/jobs/localJobs";
import { DeleteDialog, RenameDialog } from "@/features/jobs/ProjectDialogs";
import { ProjectMenu } from "@/features/jobs/ProjectMenu";
import { buildProject, displayName, remoteFrom, timelineSeconds, type Project } from "@/features/jobs/projects";
import type { JobStatus } from "@/features/jobs/types";
import { useIsIOS } from "@/features/start/videoPicker";
import { getLiveUploads, subscribe as subscribeUploads } from "@/features/upload/uploadState";
import { BonusClips } from "./done/BonusClips";
import { CaptionFiles } from "./done/CaptionFiles";
import { PostText } from "./done/PostText";
import { Survey } from "./done/Survey";
import { Tip } from "./done/Tip";
import { downloadHref, exportFiles, prefetchAhead, useShareFile, type Connection } from "./done/useShareFile";
import { clock, costLine, downloadLabel } from "./exportsInfo";
import ExportedVideo from "./ExportedVideo";
import { markRefine } from "./nav";
import { ProcessingView } from "./ProcessingView";
import PreviewVideo from "./PreviewVideo";
import { previewStateOf, renderFailed } from "./previewState";
import { reopenJob } from "./projectApi";
import { useFinish } from "./useFinish";
import ps from "./player.module.css";
import s from "./preview.module.css";

const TITLE_ID = "preview-title";
const SAVE_ID = "preview-save";
const PANEL_ID = "preview-more-panel";
/** How long a render waits for the editor's last saves (useFinish's too). */
const SAVES_WAIT_MS = 8000;
// The render failures Fertigstellen tries again ("your edits are saved");
// another code says what it is (the rule of the editor's export sheet).
const RENDER_FAILURES = new Set(["render_failed", "render_unavailable", "render_timeout"]);

/** An upload runs in this page: closing it would stop the upload. */
function useUploadsHere(): boolean {
  return useSyncExternalStore(subscribeUploads, () => getLiveUploads().length > 0, () => false);
}

/** Timeline changes this device keeps that the server doesn't have (the
 *  editor's backup, editor/session/unsavedKey). Read once this job's last
 *  saves settled: a save still out keeps its backup until it lands. */
function useUnsavedHere(jobId: string): boolean {
  const [settled, setSettled] = useState(() => !hasPendingSaves(jobId));
  useEffect(() => {
    if (settled) return;
    let live = true;
    void waitForSaves(jobId, SAVES_WAIT_MS).then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [jobId, settled]);
  return useMemo(() => settled && hasUnsavedTimeline(jobId), [jobId, settled]);
}

/** A failed video's frame: its first frame, else the film. */
function FailedFrame({ job, wide }: { job: JobStatus; wide: boolean }) {
  const poster = useMediaUrl(job.id, "poster");
  return (
    <div className={ps.player} data-shape={wide ? "wide" : "tall"}>
      <div className={ps.frame}>
        {job.has_poster && poster ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className={s.still} src={poster} alt="" />
        ) : (
          <span className={s.blank}>
            <Icon icon={Film} size={28} strokeWidth={1.5} />
          </span>
        )}
      </div>
    </div>
  );
}

/** A file name is one long word: the desktop title (40 px, it wraps)
 *  breaks it at its parts ("_", "-", "."), not anywhere. (Not on phones:
 *  Chrome breaks at <wbr> even in a nowrap line.) */
function breakable(name: string): ReactNode[] {
  return name.split(/([_.-])/).map((part, i) =>
    i % 2 ? (
      <Fragment key={i}>
        {part}
        <wbr />
      </Fragment>
    ) : (
      part
    ),
  );
}

/** Name · length · ⋯ (rename, delete, and what the tile's menu has). */
function TitleRow({
  name,
  seconds,
  project,
  onMenu,
  onOpen,
}: {
  name: string;
  /** The edit's length; 0 while there is none. */
  seconds: number;
  project: Project;
  onMenu: (action: "rename" | "delete") => void;
  onOpen: (href: string) => void;
}) {
  const desktop = useIsDesktop();
  return (
    <div className={s.trow}>
      <h1 id={TITLE_ID} className={s.title} tabIndex={-1} data-testid="preview-title">
        {desktop ? breakable(name) : name}
      </h1>
      {seconds > 0 && (
        <span className={s.len} data-testid="preview-length">
          {clock(seconds)}
        </span>
      )}
      <span className={s.menu}>
        <ProjectMenu p={project} size="lg" onAction={onMenu} onOpen={onOpen} />
      </span>
    </div>
  );
}

export default function PreviewScreen({ job, setJob }: { job: JobStatus; setJob: (job: JobStatus) => void }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const state = previewStateOf(job);
  const finish = useFinish(job, setJob);
  const online = useOnline();
  const uploadsHere = useUploadsHere();
  const unsaved = useUnsavedHere(job.id);
  const ios = useIsIOS();
  const mediaReady = useMediaReady();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [more, setMore] = useState(false);
  const [reopen, setReopen] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  // Fertigstellen ran while the page was open (an instant export too).
  const [finishedHere, setFinishedHere] = useState(false);
  if (!finishedHere && (state === "finishing" || finish.starting)) setFinishedHere(true);
  // The job as last shown, for a rename that answers after a newer poll.
  const latest = useRef(job);
  useEffect(() => {
    latest.current = job;
  });

  const wide = job.output_aspect === "16:9";
  const local = useMemo(() => readLocalJobs().find((j) => j.jobId === job.id), [job.id]);
  const name = displayName(job.title || local?.name || local?.filename || job.filename || "") || t("app.library.untitled");
  const [now] = useState(() => Date.now());
  const project = buildProject(job.id, local, remoteFrom(job), { now, exportHint: hasExportHint(job.id) });

  // Saving the export (D21): the share sheet on an iPhone / iPad.
  const files = exportFiles(job);
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  const share = useShareFile(job, files.primary, {
    on: ios && state === "done",
    prefetch: prefetchAhead(finishedHere, connection),
  });

  // The page changed in place: focus that was on a control that went
  // away goes on to the export's save (it is done) or to the title. The
  // actions are keyed by what they do, so none takes another's focus.
  const shown = useRef(state);
  useEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.getElementById(state === "done" ? SAVE_ID : TITLE_ID)?.focus({ preventScroll: true });
  }, [state]);

  const openEditor = (href = `/app/edit/${job.id}`) => {
    // The editor's back returns here (router.back(), not a new entry).
    markRefine(job.id);
    router.push(href);
  };
  const refineExport = async () => {
    setReopen({ busy: true, error: null });
    try {
      await reopenJob(job.id, "done_view");
      openEditor();
    } catch (e) {
      setReopen({ busy: false, error: describeError(e, t) });
    }
  };
  const panel = useRef<HTMLDivElement>(null);
  const toggleMore = () => {
    const open = !more;
    setMore(open);
    const el = panel.current;
    if (!open || !el) return;
    // Opened under the fold: once it has its height, it comes up.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(
      () => {
        if (el.closest("[data-more]")) el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      },
      reduce ? 0 : 320,
    );
  };

  const titleRow = (
    <TitleRow
      name={name}
      seconds={timelineSeconds(job.edit_segments)}
      project={project}
      onMenu={setDialog}
      onOpen={openEditor}
    />
  );

  let frame: ReactNode;
  if (state === "done") frame = <ExportedVideo job={job} />;
  else if (state === "failed") frame = <FailedFrame job={job} wide={wide} />;
  else frame = <PreviewVideo job={job} />;

  // A billed export says what it costs; with billing off it is free.
  const cost = job.fair_use?.billed ? costLine(job, t, lang).text : null;
  const failedCode = renderFailed(job);
  const failedText = failedCode
    ? RENDER_FAILURES.has(failedCode)
      ? t("app.card.renderFailedNote")
      : jobErrorText(job, t)
    : null;

  let actions: ReactNode = null;
  if ((state === "ready" || state === "edited") && unsaved) {
    actions = (
      <>
        <p key="unsaved" className={s.notice} data-testid="preview-unsaved">
          {t("app.preview.unsavedHere")}
        </p>
        <Button key="refine" size="lg" className={s.act} onClick={() => openEditor()} data-testid="preview-refine">
          {t("app.preview.openRefine")}
        </Button>
      </>
    );
  } else if (state === "ready" || state === "edited" || state === "finishing") {
    const working = state === "finishing" || finish.starting || finish.saving;
    const off = !working && !online;
    actions = (
      <>
        {failedText && state !== "finishing" && (
          <p key="failed" className={s.notice} data-tone="warn" role="alert" data-testid="preview-failed">
            <Icon icon={TriangleAlert} size={16} />
            <span>{failedText}</span>
          </p>
        )}
        <Button
          key="finish"
          size="lg"
          variant={working ? "tint" : "primary"}
          className={cx(s.act, working && s.working)}
          aria-disabled={working || off || undefined}
          onClick={working || off ? undefined : finish.finish}
          data-testid="preview-finish"
          data-state={working ? "working" : "idle"}
        >
          {t(working ? "editor.exporting" : "editor.export")}
        </Button>
        <div key="status" className={s.status} role="status">
          {finish.saving && (
            <p className={s.note} data-testid="preview-saving">
              {t("app.preview.saving")}
            </p>
          )}
          {state === "finishing" && !uploadsHere && (
            <p className={s.note} data-testid="preview-note">
              {t("app.processing.closeTabExport")}
            </p>
          )}
          {state === "finishing" && job.queue_position ? (
            <p className={s.note} data-testid="preview-queue">
              {t("app.export.queued", { n: job.queue_position })}
            </p>
          ) : null}
          {off && (
            <p className={s.note} data-tone="warn" data-testid="preview-offline">
              {t("editor.exportOffline")}
            </p>
          )}
        </div>
        {cost && !working && (
          <p key="cost" className={s.note} data-testid="preview-cost">
            {cost}
          </p>
        )}
        {finish.error && (
          <p key="error" className={s.error} role="alert" data-testid="preview-error">
            {finish.error}
          </p>
        )}
        {state !== "finishing" && (
          <Button key="refine" size="lg" variant="tint" className={s.act} onClick={() => openEditor()} data-testid="preview-refine">
            {t("app.preview.refine")}
          </Button>
        )}
        {state === "edited" && (
          <>
            <a
              key="previous"
              className={s.quiet}
              href={mediaReady ? downloadHref(job.id, "primary") : undefined}
              download={job.download_names?.primary ?? true}
              data-testid="done-download-previous"
            >
              <Icon icon={Download} size={16} />
              {t("app.preview.previousVersion")}
            </a>
            <p key="previousStays" className={s.note}>
              {t("app.export.previousStays")}
            </p>
          </>
        )}
      </>
    );
  } else if (state === "done") {
    const sharing = share.state !== "off" && share.state !== "failed";
    const preparing = share.state === "preparing";
    actions = (
      <>
        {sharing ? (
          <Button
            key="save"
            id={SAVE_ID}
            size="lg"
            className={s.act}
            aria-disabled={preparing || undefined}
            onClick={preparing ? undefined : share.share}
            data-testid="done-share"
            data-state={share.state}
          >
            <Icon icon={Download} size={19} />
            {t(preparing ? "app.done.preparing" : "app.preview.save")}
          </Button>
        ) : (
          <a
            key="save"
            id={SAVE_ID}
            className={cx(buttonClass("primary", "lg"), s.act)}
            href={mediaReady ? downloadHref(job.id, files.primary?.format ?? "primary") : undefined}
            download={job.download_names?.[files.primary?.format ?? "primary"] ?? true}
            data-testid="done-download"
            data-format={files.primary?.format ?? "primary"}
          >
            <Icon icon={Download} size={19} />
            {t("app.done.download")}
          </a>
        )}
        <Button
          key="refine"
          size="lg"
          variant="tint"
          className={s.act}
          aria-disabled={reopen.busy || undefined}
          onClick={reopen.busy ? undefined : () => void refineExport()}
          data-testid="preview-refine"
        >
          {t(reopen.busy ? "app.header.opening" : "app.preview.refine")}
        </Button>
        {reopen.error && (
          <p key="error" className={s.error} role="alert" data-testid="preview-error">
            {reopen.error}
          </p>
        )}
      </>
    );
  } else if (state === "failed") {
    actions = (
      <>
        <p key="reason" className={s.notice} data-tone="failed" data-testid="preview-reason">
          <Icon icon={TriangleAlert} size={16} />
          <span>{describeError({ code: job.error_code ?? null, params: job.error_params, refunded: job.refunded }, t, { v2: true })}</span>
        </p>
        {/* (no_speech says it in its own words) */}
        {job.refunded && job.error_code !== "no_speech" && (
          <p key="refund" className={s.note} data-testid="preview-refund">
            {t("app.errors.refunded")}
          </p>
        )}
        <Button key="another" size="lg" className={s.act} onClick={() => router.push("/app/new")} data-testid="preview-another">
          {t("app.errors.tryAnotherVideo")}
        </Button>
      </>
    );
  }

  const others = files.all.filter((d) => d.format !== files.primary?.format);

  return (
    <section className={s.root} data-testid="preview" data-state={state} aria-labelledby={TITLE_ID}>
      {state === "processing" ? (
        <div className={s.processing}>
          {titleRow}
          <ProcessingView job={job} canLeave={!uploadsHere} />
        </div>
      ) : (
        <div className={s.watch} data-shape={wide ? "wide" : "tall"} data-more={(state === "done" && more) || undefined}>
          <div className={s.media}>{frame}</div>
          <div className={s.info}>
            {titleRow}
            <div className={s.acts}>{actions}</div>
            {state === "done" && (
              <button
                type="button"
                className={s.disc}
                aria-expanded={more}
                aria-controls={PANEL_ID}
                onClick={toggleMore}
                data-testid="preview-more"
              >
                {t("app.preview.more")}
                <Icon icon={ChevronRight} size={17} />
              </button>
            )}
          </div>
          {state === "done" && (
            <div className={s.after}>
              <div ref={panel} id={PANEL_ID} className={s.panel} data-testid="preview-more-panel">
                <div className={s.panelClip} inert={!more}>
                  <div className={s.moreBody}>
                    <PostText job={job} />
                    <CaptionFiles job={job} />
                    <BonusClips job={job} />
                    {others.length > 0 && (
                      <div className={s.files}>
                        {others.map((d) => (
                          <a
                            key={d.format}
                            className={s.file}
                            href={mediaReady ? downloadHref(job.id, d.format) : undefined}
                            download={job.download_names?.[d.format] ?? true}
                            data-testid="done-download"
                            data-format={d.format}
                          >
                            <Icon icon={Download} size={16} />
                            {t("app.done.download")}
                            <span className={s.fileMeta}>{downloadLabel(d.format, d.bytes, job.output_aspect ?? null, t)}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className={s.extras}>
                <Tip job={job} />
                <Survey job={job} />
              </div>
            </div>
          )}
        </div>
      )}
      {/* Outside the states: a new poll answer never closes them. */}
      {dialog === "rename" && (
        <RenameDialog
          p={project}
          onClose={() => setDialog(null)}
          onRenamed={(title) => setJob({ ...latest.current, title })}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog p={project} onClose={() => setDialog(null)} onDeleted={() => router.replace("/app")} />
      )}
    </section>
  );
}
