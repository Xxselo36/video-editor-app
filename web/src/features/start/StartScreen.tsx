"use client";
/**
 * /app/new on the v2 editor (D1 to D9, approved mockups 1-video and
 * 2-untertitel): "Neues Video" (PickScreen), then "Untertitel wählen"
 * (StyleScreen) for the video picked there. The picked video uploads at
 * once; its job waits for "Los geht's" (pendingStart.ts holds it, so
 * leaving the screen neither starts nor discards it, and coming back
 * shows it again).
 *
 * This component owns the file inputs and the iOS pick logic:
 * - After the chooser closes, "Video wird vorbereitet…" until the file
 *   arrives (./usePreparing; iOS may download or convert it first) and
 *   while it is checked: the pick-time check (D9: an audio file, size,
 *   length, plan and minutes) refuses here, before any byte goes up.
 * - On iOS the chooser offers the original formats (./videoPicker); when
 *   iOS gives up on a very large video (./pickWatch), a hint says why and
 *   "Pick anyway" opens the chooser without a format filter (iOS converts
 *   the video). The same with an original over the upload cap; "Other
 *   video formats" opens that chooser at once. An upload from it resumes
 *   with it.
 * - The same file uploading in this page already: its card in Projects.
 *   Unless that upload was just cancelled (X, then the same file again):
 *   the pick waits until it has wound down, then starts anew.
 * - The same video as a stopped upload (a reload while it waited for
 *   "Los geht's": the resume card, or the file picked again): it
 *   continues with the choices it had (its record keeps them).
 */
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getLiveUpload, isCancelling, isUploading, loadUploadCode, whenFree } from "@/features/upload/uploadManager";
import { setPaywall } from "@/features/upload/uploadState";
import { useLang, useT } from "@/i18n";
import { fmtMinutes, useBillingConfig, useMe } from "@/lib/account";
import { track } from "@/lib/analytics";
import { useConfig } from "@/lib/config";
import { describeError } from "@/lib/errors";
import { initialChoices, resumedChoices, settingsOf, styleTags, styleTiles } from "./choices";
import {
  beginStart,
  cancelStart,
  changeChoices,
  getPendingStart,
  goStart,
  offerChoices,
  restoreStart,
  retryStart,
  showStart,
  StartActionsContext,
  StartViewContext,
  usePendingStart,
  type StartActions,
  type StartView,
} from "./pendingStart";
import { DROP_ID, PickScreen, type PickStatus } from "./PickScreen";
import { STALL_MS, usePickWatch } from "./pickWatch";
import { probeVideo } from "./probe";
import { StyleScreen, TITLE_ID } from "./StyleScreen";
import { usePreparing } from "./usePreparing";
import { usePrefs } from "./usePrefs";
import { originalTooBig, overLimitGb, pickedKind, useIsIOS, useVideoAccept } from "./videoPicker";
import s from "./start.module.css";

/** How long a pick waits for a cancelled upload of the same file to wind
 *  down (the stored parts discarded on the server; usually a second, at
 *  most about 10 s: lib/uploadResume ABORT_TIMEOUT_MS). */
const CANCEL_WAIT_MS = 15_000;

export function StartScreen() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const config = useConfig();
  const prefs = usePrefs();
  const { me } = useMe();
  const billingOn = useBillingConfig()?.enabled === true;
  const start = usePendingStart();
  // iPhone/iPad: read after mount (the first render says no).
  const ios = useIsIOS();
  // The chooser's formats: the original ones on iOS (./videoPicker).
  const accept = useVideoAccept();
  // iOS gave up on the video (the chooser closed, no file came), or no
  // word from it for a long while (stalled).
  const { missed, stalled, watch } = usePickWatch(ios);
  // "Video wird vorbereitet…": on iOS until the file or a cancel comes
  // (the pick watch speaks up after STALL_MS); elsewhere off after STALL_MS.
  const { preparing, slow, arm: armPreparing, done: donePreparing } = usePreparing(ios ? null : STALL_MS);
  // The picked file is being checked (the pick-time check).
  const [checking, setChecking] = useState(false);
  // Why the last "Pick anyway" file wasn't taken (not a video).
  const [pickError, setPickError] = useState<string | null>(null);
  // iOS: the original picked is over the upload cap (its message).
  const [tooBig, setTooBig] = useState<string | null>(null);
  // The pick-time check said no (its message).
  const [refusal, setRefusal] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // iOS: "Pick anyway" (no format filter: iOS converts the video).
  const anyRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  // A file is being checked: a second pick, drop or double tap meanwhile
  // must not start a second upload (a second job, charged twice).
  const busy = useRef(false);
  // Where focus goes once the other screen is up.
  const focusNext = useRef<"title" | "drop" | null>(null);
  const live = config.caption_styles_live;
  const { limits } = config;

  // Before the first paint: a start that went (Projects shows it now) or
  // was given up on its tile isn't shown; the one waiting for "Los
  // geht's" is, with the focus on its heading as after the pick. Its job
  // created while shown: on to Projects.
  useLayoutEffect(() => {
    restoreStart();
    if (getPendingStart()) focusNext.current = "title";
    return showStart(() => router.push("/app"));
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    // The upload code now, not when the file is picked (a deploy
    // meanwhile would take this build's chunk away).
    loadUploadCode().catch(() => {});
    // Links from before UX6 (/app/new?step=file|settings): one screen now.
    if (new URLSearchParams(window.location.search).has("step")) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  // The account's prefs or the live styles came after the pick: they
  // decide the choices the user hasn't touched yet.
  useEffect(() => {
    if (!prefs.ready) return;
    offerChoices(initialChoices({ saved: prefs.saved, standard: prefs.captionStyle, lastStyle: prefs.lastStyle, live }));
  }, [prefs, live]);

  const screen = start ? "style" : "pick";
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target) document.getElementById(target === "title" ? TITLE_ID : DROP_ID)?.focus();
  }, [screen]);

  // While a video waits here, a file dropped beside the card would make
  // the browser open it (and the page would go).
  useEffect(() => {
    if (screen !== "style") return;
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, [screen]);

  /** Check `f` and start its upload: "Untertitel wählen" follows. `source`
   *  "any": from the unfiltered iOS input (kept with the upload: a resume
   *  opens that input again). */
  const take = async (f: File | null, source?: "any") => {
    donePreparing();
    if (!f || busy.current || !mounted.current) return;
    // (A slow export that arrives after all: the hint goes.)
    watch.arrived();
    setPickError(null);
    setTooBig(null);
    setRefusal(null);
    // This very file uploads in this page already (its card is in
    // Projects): no second upload.
    if (isUploading(f) && !isCancelling(f)) {
      router.push("/app");
      return;
    }
    busy.current = true;
    setChecking(true);
    try {
      // Given up a moment ago (X): a new upload waits until that one has
      // wound down; it would resume the parts being discarded. Still
      // going after a while (a slow connection): the card again, saying
      // why (picked again a moment later, it starts).
      if (isUploading(f) && !(await whenFree(f, CANCEL_WAIT_MS))) {
        if (mounted.current) setRefusal(t("app.start.pickBusy"));
        return;
      }
      if (!mounted.current) return;
      const probe = await probeVideo(f);
      if (!mounted.current) return;
      const code = await loadUploadCode();
      const no = await code.precheckUpload(f, probe, me, billingOn);
      if (!mounted.current) return;
      if (no) {
        if ("paywall" in no) setPaywall(no.paywall);
        else setRefusal(describeError(no, t, { v2: true }));
        return;
      }
      // One 720 px frame: the tiles, the preview and the Projects thumbnail.
      const frame = import("@/features/upload/grabFrame").then((m) => m.grabFrame(f, 6000, 720)).catch(() => null);
      // This video's upload stopped (a reload while it waited for "Los
      // geht's"): it continues with the choices it had (D3, D7).
      const stopped = await code.stoppedUploadOf(f).catch(() => null);
      if (!mounted.current) {
        void frame.then((url) => url && URL.revokeObjectURL(url));
        return;
      }
      const resumed = stopped && resumedChoices(stopped, live);
      const choices =
        resumed || initialChoices({ saved: prefs.saved, standard: prefs.captionStyle, lastStyle: prefs.lastStyle, live });
      if (!beginStart(f, { source, probe, frame, choices, touched: Boolean(resumed) })) {
        router.push("/app");
        return;
      }
      focusNext.current = "title";
      track("file_chosen", { preset: "start", size_mb: Math.round(f.size / 1e6), video: f.type.startsWith("video/") });
    } catch {
      // The upload code didn't load: offline, or this build's chunk went
      // with a deploy (a reload fixes that).
      if (mounted.current) {
        setRefusal(describeError({ code: navigator.onLine === false ? "connection_lost" : "app_updated" }, t, { v2: true }));
      }
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  const gb = fmtMinutes(limits.max_upload_bytes / 1e9, lang);
  /** The original-formats input: on iOS an original over the upload cap
   *  isn't uploaded; "Pick anyway" sends the converted copy instead. */
  const takeOriginal = (input: HTMLInputElement) => {
    const f = input.files?.[0] ?? null;
    // (The same video again must fire change again: after X, say.)
    input.value = "";
    if (f && !busy.current && originalTooBig(f.size, limits.max_upload_bytes, { ios, original: true })) {
      donePreparing();
      watch.arrived();
      setPickError(null);
      setTooBig(t("app.start.pickTooBig", { size: fmtMinutes(overLimitGb(f.size), lang), max: gb }));
      return;
    }
    void take(f);
  };
  // iOS: a photo or an audio file picked without the format filter isn't
  // uploaded (the hint says so and stays).
  const takeAnyway = (f: File | null) => {
    if (!f) return;
    const kind = pickedKind(f);
    if (kind !== "video") {
      donePreparing();
      watch.closed();
      setPickError(t(kind === "audio" ? "app.errors.noVideoTrack" : "app.start.notVideo"));
      return;
    }
    void take(f, "any");
  };

  useEffect(() => {
    // A cancelled chooser: nothing is coming (iOS: maybe it gave up).
    const inputs = [inputRef.current, anyRef.current].filter((i): i is HTMLInputElement => i !== null);
    const onCancel = () => {
      donePreparing();
      watch.cancelled();
    };
    inputs.forEach((i) => i.addEventListener("cancel", onCancel));
    return () => inputs.forEach((i) => i.removeEventListener("cancel", onCancel));
  }, [ios, watch, donePreparing]);

  // The screens' actions stay the same objects (memoized tiles read them);
  // they run the handlers of the latest render.
  const handlers = {
    choose: () => {
      if (busy.current) return;
      if (ios) {
        watch.opened();
        setPickError(null);
        setTooBig(null);
      }
      setRefusal(null);
      armPreparing();
      inputRef.current?.click();
    },
    chooseAny: (fromHint: boolean) => {
      if (busy.current) return;
      setPickError(null);
      setRefusal(null);
      if (!fromHint) setTooBig(null);
      watch.opened({ any: true, fromHint });
      armPreparing();
      anyRef.current?.click();
    },
    drop: (f: File | null) => void take(f),
    go: () => {
      const cur = getPendingStart();
      if (!cur || cur.committed) return;
      const settings = settingsOf(cur.choices, cur.probe);
      goStart();
      track("start_go", {
        style: cur.choices.style.presetId,
        captions_only: settings.pace === "none",
        fillers: settings.removeFillers,
        aspect: settings.targetAspect,
        language_set: settings.spokenLanguage !== "auto",
        standard: prefs.captionStyle?.presetId === cur.choices.style.presetId,
        waited: !getLiveUpload(cur.tempId)?.uploaded,
      });
    },
    cancel: () => {
      cancelStart();
      if (!getPendingStart()) focusNext.current = "drop";
    },
    retry: () => {
      // The button goes with the failure: focus starts over at the heading
      // (or, the File gone, at the card to pick it again).
      if (retryStart()) requestAnimationFrame(() => document.getElementById(TITLE_ID)?.focus());
      else focusNext.current = "drop";
    },
  };
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const actions = useMemo<StartActions>(
    () => ({
      choose: () => latest.current.choose(),
      chooseAny: (fromHint) => latest.current.chooseAny(fromHint),
      drop: (f) => latest.current.drop(f),
      setChoices: changeChoices,
      go: () => latest.current.go(),
      cancel: () => latest.current.cancel(),
      retry: () => latest.current.retry(),
    }),
    [],
  );

  const standard = prefs.captionStyle;
  const lastStyle = prefs.lastStyle;
  const tiles = useMemo(() => styleTiles(live), [live]);
  const tags = useMemo(() => styleTags({ standard, lastStyle, live }), [standard, lastStyle, live]);
  const languages = config.spoken_languages;
  const view = useMemo<StartView | null>(
    () => (start ? { start, tiles, tags, standard, languages } : null),
    [start, tiles, tags, standard, languages],
  );

  const status: PickStatus = {
    ios,
    preparing: preparing || checking,
    slow,
    stalled,
    missed,
    pickError,
    tooBig,
    refusal,
  };

  return (
    <StartActionsContext value={actions}>
      <div className={s.root} data-testid="start-screen" data-screen={screen}>
        {view ? (
          <StartViewContext value={view}>
            <StyleScreen />
          </StartViewContext>
        ) : (
          <PickScreen status={status} limits={limits} />
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          data-testid="upload-input"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => takeOriginal(e.target)}
        />
        {ios && (
          <input
            ref={anyRef}
            type="file"
            data-testid="upload-input-any"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              // The same file again must fire change again.
              e.target.value = "";
              takeAnyway(f);
            }}
          />
        )}
      </div>
    </StartActionsContext>
  );
}
