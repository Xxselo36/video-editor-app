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
 * device keeps changes the server doesn't have (the editor's copies of
 * the timeline or the text, finish.ts unsavedOnDevice): then only
 * "Feinschliff öffnen" (the editor brings them back; an export now would
 * miss them). So does a server that can't render the edit as stored
 * (sentence edits without an edit document: the editor's export has
 * them). From the tap on Fertigstellen until the render runs or didn't
 * start there is no Feinschliff; the button keeps its name until the
 * POST is out ("Änderungen werden gespeichert…" under it meanwhile).
 *
 * The title row (name, length, ⋯ to rename or delete) is in every state.
 * ProjectPage loads this with next/dynamic: the players and the caption
 * layer come in this chunk, out of the route's first load. (Not a
 * next/dynamic of their own: one inside a dynamic chunk makes Turbopack
 * copy the i18n and API modules into every route's first load, +16 KB.)
 */
import { useRouter } from "next/navigation";
import { ChevronRight, Download, Film, TriangleAlert } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import { useMediaReady, useMediaUrl } from "@/lib/api";
import { fmtClock } from "@/lib/clock";
import { describeError, jobErrorText } from "@/lib/errors";
import { hasPendingSaves } from "@/lib/pendingSaves";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { readDocCopy, unsavedDocKey } from "@/features/editor/session/unsavedDoc";
import { fetchDoc, type Fetched } from "@/features/editor/state/docFetch";
import { copyIsStored, readUnsaved, unsavedKey } from "@/features/editor/session/unsavedKey";
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
import { costLine, downloadLabel } from "./exportsInfo";
import ExportedVideo from "./ExportedVideo";
import { unsavedOnDevice } from "./finish";
import { markRefine } from "./nav";
import { isWide } from "./player";
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
const OPEN_ID = "preview-open-refine";
const WHY_ID = "preview-open-why";
// The render failures Fertigstellen tries again ("your edits are saved");
// another code says what it is (the rule of the editor's export sheet).
const RENDER_FAILURES = new Set(["render_failed", "render_unavailable", "render_timeout"]);

/** Another tab's copies (the storage event): read once they stop changing for this long. */
const STORAGE_CHECK_MS = 250;

/** An upload runs in this page: closing it would stop the upload. */
function useUploadsHere(): boolean {
  return useSyncExternalStore(subscribeUploads, () => getLiveUploads().length > 0, () => false);
}

/**
 * Changes this device keeps that the server doesn't have (finish.ts
 * unsavedOnDevice: the editor's copies of the timeline and of the text).
 * Not while this job's saves are still out: their copies are what they
 * send, Fertigstellen waits for them (D12), and the page waits with it.
 * Read again once they settle (useJobPoll's `settled`, with the job
 * asked for after them), when the stored timeline changes, and when an
 * editor of this job in another tab writes or drops a copy (the storage
 * event); `check` reads them right before Fertigstellen's POST. A copy
 * of the text needs the server's doc to tell: `checking` until that
 * answer (Fertigstellen waits, it never shows for a moment and goes);
 * checks while one read of it is out share it.
 */
function useUnsavedHere(
  job: JobStatus,
  settled: number,
): { unsaved: boolean; checking: boolean; check: () => Promise<boolean | null> } {
  const id = job.id;
  const latest = useRef(job);
  useEffect(() => {
    latest.current = job;
  });
  // The timeline's copy at once (no Fertigstellen shown for a moment);
  // the text's needs the server's doc, read below.
  const [unsaved, setUnsaved] = useState(() => {
    const b = hasPendingSaves(id) ? null : readUnsaved(id);
    return !!b && !copyIsStored(b, job.edit_segments, job.duration ?? 0);
  });
  // Reads of the text's copy whose answer is still to come (the first one
  // from the first frame on).
  const [checking, setChecking] = useState(() => !hasPendingSaves(id) && readDocCopy(id) !== null);
  // The server's doc while it is being read: a check meanwhile takes its
  // answer (one a save overtook can only say "unsaved": nothing renders).
  const docRead = useRef<Promise<Fetched | null> | null>(null);
  const readDoc = useCallback((jobId: string) => {
    if (docRead.current) return docRead.current;
    const read = fetchDoc(jobId).catch(() => null);
    docRead.current = read;
    void read.then(() => {
      if (docRead.current === read) docRead.current = null;
    });
    return read;
  }, []);
  // The answer of the last read only.
  const reads = useRef(0);
  const check = useCallback(async () => {
    const n = ++reads.current;
    const withText = readDocCopy(latest.current.id) !== null;
    if (withText) setChecking(true);
    const u = await unsavedOnDevice(latest.current, readDoc);
    if (n === reads.current) {
      setChecking(false);
      if (u !== null) setUnsaved(u);
    }
    return u;
  }, [readDoc]);
  const stored = `${job.edit_rev ?? 0}:${JSON.stringify(job.edit_segments ?? [])}`;
  useEffect(() => {
    if (!hasPendingSaves(id)) void check();
  }, [check, id, settled, stored]);
  useEffect(() => {
    const keys = [unsavedKey(id), unsavedDocKey(id)];
    // An editor writes its copy while edits come (at most twice a
    // second): one check for a burst, and none while this page is hidden
    // (it checks when it shows: nothing can be tapped meanwhile).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;
    const run = () => {
      if (document.hidden) missed = true;
      else if (!hasPendingSaves(id)) void check();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && !keys.includes(e.key)) return;
      clearTimeout(timer);
      timer = setTimeout(run, STORAGE_CHECK_MS);
    };
    const onShow = () => {
      if (document.hidden || !missed) return;
      missed = false;
      run();
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [check, id]);
  // (the poll's answers and `settled` render again when they settle)
  return { unsaved: unsaved && !hasPendingSaves(id), checking: checking && !hasPendingSaves(id), check };
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

/** A word this long may not fit the desktop title's line. */
const LONG_WORD = 10;

/** The last two letters of the text's last word when that word is long; null otherwise. */
function longTail(text: string): string | null {
  const word = Array.from(text.split(/\s/).pop() ?? "");
  return word.length >= LONG_WORD ? word.slice(-2).join("") : null;
}

/** A "." or "-" between two digits belongs to a number, a date or a
 *  time ("31.10.2026", "12.00.00", "2.10"): no break of ours there. A
 *  "_" still breaks: camera names run their date and time together
 *  ("VID_20261031_123456"). */
const DIGIT_LAST = /\d$/;
const DIGIT_FIRST = /^\d/;
const inNumber = (sep: string, before: string, after: string) => sep !== "_" && DIGIT_LAST.test(before) && DIGIT_FIRST.test(after);

/** A file name is one long word: the desktop title (40 px, it wraps)
 *  breaks it at its parts ("_", "-", "."), not anywhere, and hyphenates a
 *  word too long for the line (preview.module.css). After such a word the
 *  separator is a box of its own: Chromium hyphenates no word that runs
 *  into a "_", "." or "-". The box stays on the line of the word's last
 *  two letters (a line never starts with a "-" that reads like a minus).
 *  Numbers keep their dots and hyphens (inNumber), as plain text.
 *  (Not on phones: Chrome breaks at <wbr> even in a nowrap line.) */
function breakable(name: string): ReactNode[] {
  const parts = name.split(/([_.-])/);
  const out: ReactNode[] = [];
  // plain text runs as one text node
  let text = "";
  const breaksAfter = (i: number) => i < parts.length && !inNumber(parts[i], parts[i - 1], parts[i + 1] ?? "");
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      // a long word's last two letters go with the separator after it
      const tail = breaksAfter(i + 1) ? longTail(part) : null;
      text += tail ? part.slice(0, part.length - tail.length) : part;
      return;
    }
    if (!breaksAfter(i)) {
      text += part;
      return;
    }
    const tail = longTail(parts[i - 1]);
    if (!tail) text += part;
    out.push(text);
    text = "";
    out.push(
      <Fragment key={i}>
        {tail ? (
          <span className={s.tail}>
            {tail}
            <span className={s.sep}>{part}</span>
          </span>
        ) : null}
        <wbr />
      </Fragment>,
    );
  });
  if (text) out.push(text);
  return out;
}

/**
 * Desktop, a 16:9 frame: it gives up height so that what is under it
 * (the note, the title, the actions) stays in view on a laptop screen.
 * The frame's top (--above) and the height of what is under it
 * (--below), as laid out, go to its cap (preview.module.css). Measured
 * at each render and when they change size (a title on two lines, a
 * notice, the note), then a frame later: a cap changed in the
 * observer's own callback would change a size it watches. `hold`: from
 * the tap on Fertigstellen until it is done or didn't start, the frame
 * keeps its size while the buttons under it come and go (the pressed
 * one would move under the pointer); measured once if it never was (a
 * page opened while it runs).
 */
function useRoomForInfo(watch: RefObject<HTMLDivElement | null>, on: boolean, hold: boolean) {
  const held = useRef(hold);
  useLayoutEffect(() => {
    held.current = hold;
    const w = watch.current;
    if (on && w && !(hold && measured(w))) measureRoom(w);
  });
  useEffect(() => {
    const w = watch.current;
    if (!on || !w) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!(held.current && measured(w))) measureRoom(w);
      });
    });
    for (const el of Array.from(w.children)) ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [on, watch]);
}

/** useRoomForInfo measured the .watch box `w` already. */
const measured = (w: HTMLElement) => w.style.getPropertyValue("--below") !== "";

/** useRoomForInfo's measure of the .watch box `w`. */
function measureRoom(w: HTMLElement) {
  const frame = w.querySelector(`.${CSS.escape(ps.frame)}`);
  const info = w.querySelector(`.${CSS.escape(s.info)}`);
  if (!frame || !info) return;
  const f = frame.getBoundingClientRect();
  w.style.setProperty("--above", `${Math.round(f.top + window.scrollY)}px`);
  w.style.setProperty("--below", `${Math.ceil(info.getBoundingClientRect().bottom - f.bottom)}px`);
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
      {/* Named as it reads: breakable()'s separator boxes would add spaces to the name. */}
      <h1 id={TITLE_ID} className={s.title} tabIndex={-1} aria-label={name} data-testid="preview-title">
        {desktop ? breakable(name) : name}
      </h1>
      {seconds > 0 && (
        <span className={s.len} data-testid="preview-length">
          {fmtClock(seconds)}
        </span>
      )}
      <span className={s.menu}>
        <ProjectMenu p={project} size="lg" onAction={onMenu} onOpen={onOpen} />
      </span>
    </div>
  );
}

export default function PreviewScreen({
  job,
  setJob,
  settled,
  previewFailed,
}: {
  job: JobStatus;
  setJob: (job: JobStatus) => void;
  /** useJobPoll's: grows with the first job asked for after this job's
   *  pending saves settled. */
  settled: number;
  /** useJobPoll's: the preview of the stored timeline couldn't be built. */
  previewFailed: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const state = previewStateOf(job);
  const here = useUnsavedHere(job, settled);
  const finish = useFinish(job, setJob, here.check, settled);
  const online = useOnline();
  const uploadsHere = useUploadsHere();
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

  const wide = isWide(job);
  const watch = useRef<HTMLDivElement>(null);
  useRoomForInfo(watch, useIsDesktop() && wide && state !== "processing", finish.busy || state === "finishing");
  const local = useMemo(() => readLocalJobs().find((j) => j.jobId === job.id), [job.id]);
  // The name as the title shows it (no file extension; "" untitled): the
  // ⋯ menu, rename and delete say it too.
  const shownName = displayName(job.title || local?.name || local?.filename || job.filename || "");
  const name = shownName || t("app.library.untitled");
  const [now] = useState(() => Date.now());
  const project = {
    ...buildProject(job.id, local, remoteFrom(job), { now, exportHint: hasExportHint(job.id) }),
    name: shownName,
  };

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

  // Changes only Feinschliff can bring into the video (this device's, or
  // edits the server can't render as stored): only "Feinschliff öffnen".
  const editable = state === "ready" || state === "edited";
  const toRefine = editable && !finish.busy && (here.unsaved || finish.needsEditor);
  // Fertigstellen's button went away with the focus: on to "Feinschliff öffnen".
  const wasToRefine = useRef(toRefine);
  useEffect(() => {
    if (wasToRefine.current === toRefine) return;
    wasToRefine.current = toRefine;
    if (!toRefine || (document.activeElement && document.activeElement !== document.body)) return;
    document.getElementById(OPEN_ID)?.focus({ preventScroll: true });
  }, [toRefine]);

  const openEditor = (href = `/app/edit/${job.id}`) => {
    // Not from the tap on Fertigstellen until its render runs or didn't
    // start (a menu tap meanwhile does nothing): the editor would open a
    // job that is about to render the cut it was opened to change.
    if (finish.busy || state === "finishing") return;
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
  else frame = <PreviewVideo job={job} settled={settled} failed={previewFailed} />;

  // A billed export says what it costs; with billing off it is free.
  const cost = job.fair_use?.billed ? costLine(job, t, lang).text : null;
  const failedCode = renderFailed(job);
  const failedText = failedCode
    ? RENDER_FAILURES.has(failedCode)
      ? t("app.card.renderFailedNote")
      : jobErrorText(job, t)
    : null;

  let actions: ReactNode = null;
  if (toRefine) {
    actions = (
      <>
        {finish.needsEditor ? (
          <p key="needsEditor" id={WHY_ID} className={s.notice} data-testid="preview-needs-editor">
            {t("app.preview.needsEditor")}
          </p>
        ) : (
          <p key="unsaved" id={WHY_ID} className={s.notice} data-testid="preview-unsaved">
            {t("app.preview.unsavedHere")}
          </p>
        )}
        <Button
          key="refine"
          id={OPEN_ID}
          size="lg"
          className={s.act}
          aria-describedby={WHY_ID}
          onClick={() => openEditor()}
          data-testid="preview-refine"
        >
          {t("app.preview.openRefine")}
        </Button>
      </>
    );
  } else if (editable || state === "finishing") {
    // "Wird fertiggestellt…" once the POST is out (and while it renders);
    // before that (waiting for the editor's saves, reading this device's
    // copies) the button keeps its name, unavailable, the wait said under it.
    const working = state === "finishing" || finish.starting;
    // (also while this device's copy of the text is checked: it may hold Fertigstellen)
    const waiting = !working && (finish.busy || here.checking);
    const off = !working && !waiting && !online;
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
          aria-disabled={working || waiting || off || undefined}
          onClick={working || waiting || off ? undefined : finish.finish}
          data-testid="preview-finish"
          data-state={working ? "working" : waiting ? "waiting" : "idle"}
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
        {/* Not from the tap until the render runs or didn't start (the
            mockup's working state hides it). */}
        {state !== "finishing" && !finish.busy && (
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
        <div
          ref={watch}
          className={s.watch}
          data-shape={wide ? "wide" : "tall"}
          data-more={(state === "done" && more) || undefined}
        >
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
                    <BonusClips job={job} level={2} />
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
      {/* Done during the visit: said once, wherever the focus is (the
          button pressed may still have it). There from the start, so a
          screen reader announces the change. */}
      <p className="sr-only" role="status">
        {state === "done" && finishedHere ? t("app.export.doneTitle") : null}
      </p>
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
