/**
 * The video "Neues Video" is starting (D1 to D3): picked and uploading,
 * its POST /jobs waiting for "Los geht's". A module singleton like the
 * uploads themselves: leaving the screen neither starts nor discards it,
 * and opening Neues Video again shows it once more ("Untertitel wählen"
 * with the same upload, choices and frame). One at a time: the store
 * points at the start the screen shows.
 *
 * Each start's upload callbacks and settings source close over the start
 * itself, never over a component, so they work while no screen is
 * mounted: POST /jobs reads the choices when it goes out, and the
 * choices it went with become the last used (lastUsed.ts).
 *
 * - created: let go (a screen showing it goes on to Projects first);
 * - cancelled (X here, or Cancel on its Projects tile): let go;
 * - failed: kept, for "Nochmal versuchen" (its record says why; "Try
 *   again" on its Projects tile goes on with the same callbacks);
 * - a screen mounting lets go of one that already went ("Los geht's":
 *   Projects shows it now) or that was given up on its tile (also while
 *   that upload still winds down), and shows the one still waiting as it
 *   was left (prefs read again on the way back don't change its
 *   choices).
 *
 * Also the screens' two contexts: what they can do (StartScreen's
 * actions, stable) and what they show (no upload progress: UploadStatus
 * and GoBar subscribe to that themselves).
 */
import { createContext, use, useSyncExternalStore } from "react";
import { createGate, type Gate } from "@/features/upload/gate";
import type { UploadSettings } from "@/features/upload/settings";
import { cancelUpload, retryUpload } from "@/features/upload/uploadControls";
import { startUpload, updateUploadSettings, type EndHow, type StartOpts } from "@/features/upload/uploadManager";
import { getLiveUpload, isAwaitingGo } from "@/features/upload/uploadState";
import type { MessageKey } from "@/i18n/messages/en";
import type { PresetId } from "@/lib/captions/types";
import { sameCaptionStyle } from "./captionDefault";
import { lastUsedPrefs, settingsOf, type Choices, type StyleChoice } from "./choices";
import { uploadSettings } from "./defaults";
import { saveLastUsed } from "./lastUsed";
import type { VideoProbe } from "./probe";

export type PendingStart = {
  /** The upload's record (a new one after "Nochmal versuchen"). */
  tempId: string;
  file: File;
  /** POST /jobs waits for it ("Los geht's" opens it). */
  gate: Gate;
  choices: Choices;
  probe: VideoProbe | null;
  /** The frame the style tiles draw on (an object URL that is the
   *  upload's thumbnail: uploadState moves it to the job or revokes it). */
  frame: Promise<string | null>;
  /** The user changed a choice, or came back to this start: prefs that
   *  come later leave the choices be. */
  touched: boolean;
  /** "Los geht's" was pressed. */
  committed: boolean;
  /** POST /jobs read the choices: locked. (The legacy upload sends the
   *  bytes with the request, so this comes before `starting`.) */
  sent: boolean;
  /** POST /jobs is out: the choices are read, so they are locked. */
  starting: boolean;
  /** The upload failed (its record says why). */
  failed: boolean;
};

type Slot = { state: PendingStart };

let current: Slot | null = null;
// The mounted screen's way on to Projects once the job of the start it
// shows exists.
let onShownCreated: (() => void) | null = null;
const subs = new Set<() => void>();

function emit(): void {
  for (const f of subs) f();
}

function patch(slot: Slot, p: Partial<PendingStart>): void {
  slot.state = { ...slot.state, ...p };
  if (slot === current) emit();
}

function release(slot: Slot): void {
  if (slot !== current) return;
  current = null;
  emit();
}

/** What POST /jobs sends for this start, read when it goes out. */
function settingsSource(slot: Slot): () => UploadSettings {
  return () => {
    const { choices, probe } = slot.state;
    return uploadSettings(settingsOf(choices, probe), { captionStyle: choices.style });
  };
}

/** The record follows every choice: "Try again" after a reload starts
 *  with them (and remembers them as wanted), and the same video picked
 *  again comes back with them. */
function recordChoices(slot: Slot): void {
  updateUploadSettings(slot.state.tempId, settingsSource(slot)(), lastUsedPrefs(slot.state.choices));
}

function callbacks(slot: Slot): Pick<StartOpts, "onCard" | "onSettingsRead" | "onStarting" | "onEnd"> {
  return {
    onCard: (tempId) => {
      patch(slot, { tempId, failed: false });
      // (A new record: its choices as wanted too.)
      recordChoices(slot);
    },
    // From here on a change wouldn't reach the job: locked.
    onSettingsRead: () => patch(slot, { sent: true }),
    onStarting: () => {
      // The choices POST /jobs goes with come back for the next video.
      void saveLastUsed(lastUsedPrefs(slot.state.choices));
      patch(slot, { sent: true, starting: true });
    },
    onEnd: (_jobId: string | null, how: EndHow) => {
      if (how === "failed") {
        patch(slot, { failed: true, sent: false, starting: false });
        return;
      }
      // Created while shown: the screen stays as it is on its way to
      // Projects; the next visit lets the start go (it went).
      if (how === "created" && slot === current && onShownCreated) {
        onShownCreated();
        return;
      }
      release(slot);
    },
  };
}

/**
 * Start uploading `file` for "Untertitel wählen": its POST /jobs waits
 * for "Los geht's". `touched`: the choices are this video's already (it
 * continues its stopped upload), prefs that answer later leave them be.
 * False (nothing started) when this very file already uploads in this
 * page.
 */
export function beginStart(
  file: File,
  init: { source?: "any"; probe: VideoProbe | null; frame: Promise<string | null>; choices: Choices; touched?: boolean },
): boolean {
  const slot: Slot = {
    state: {
      tempId: "",
      file,
      gate: createGate(),
      choices: init.choices,
      probe: init.probe,
      frame: init.frame,
      touched: init.touched ?? false,
      committed: false,
      sent: false,
      starting: false,
      failed: false,
    },
  };
  void startUpload(file, settingsSource(slot), null, {
    gate: slot.state.gate,
    source: init.source,
    thumb: init.frame,
    duration: init.probe?.duration ?? null,
    ...callbacks(slot),
  });
  // The upload's card goes up before startUpload awaits anything; it
  // calls nothing when the file already uploads here.
  if (!slot.state.tempId) {
    void init.frame.then((url) => url && URL.revokeObjectURL(url));
    return false;
  }
  current = slot;
  emit();
  return true;
}

/** Change the choices. Not once POST /jobs has read them. */
export function changeChoices(next: (c: Choices) => Choices): void {
  const slot = current;
  if (!slot || slot.state.sent || slot.state.starting) return;
  patch(slot, { choices: next(slot.state.choices), touched: true });
  recordChoices(slot);
}

function sameChoices(a: Choices, b: Choices): boolean {
  return (
    sameCaptionStyle(a.style, b.style) &&
    a.captionsOnly === b.captionsOnly &&
    a.fillers === b.fillers &&
    a.aspect === b.aspect &&
    a.language === b.language
  );
}

/** The prefs answered after the pick (the account's, the live styles):
 *  their choices, unless the user changed one or already went. */
export function offerChoices(choices: Choices): void {
  const slot = current;
  if (!slot) return;
  const s = slot.state;
  if (s.touched || s.committed || s.sent || s.starting || sameChoices(s.choices, choices)) return;
  patch(slot, { choices });
  recordChoices(slot);
}

/** "Los geht's": POST /jobs goes once the bytes are up. */
export function goStart(): void {
  const slot = current;
  if (!slot || slot.state.committed) return;
  patch(slot, { committed: true });
  slot.state.gate.open();
}

/** X: the upload stops and its record goes; nothing was started. Not
 *  once POST /jobs is out (unless it waits for the connection). */
export function cancelStart(): void {
  const slot = current;
  if (!slot) return;
  const live = getLiveUpload(slot.state.tempId);
  if (live?.starting && !live.paused) return;
  release(slot);
  void cancelUpload(slot.state.tempId);
}

/** "Nochmal versuchen": the same File again (R2 resumes its parts), with
 *  the same gate. False when this page lost the File: picked anew then. */
export function retryStart(): boolean {
  const slot = current;
  if (!slot?.state.failed) return false;
  const opts = { gate: slot.state.gate, duration: slot.state.probe?.duration ?? null, ...callbacks(slot) };
  if (retryUpload(slot.state.tempId, opts)) return true;
  release(slot);
  return false;
}

/** A screen mounts: it shows the pending start, unless that one went
 *  already (Projects has it) or was given up on its tile (no longer
 *  waiting for "Los geht's": Cancel or Remove, also while the upload
 *  still winds down). Shown again, it keeps its choices: the prefs the
 *  new screen reads don't replace them (D3). */
export function restoreStart(): void {
  const slot = current;
  if (!slot) return;
  const { committed, tempId, touched } = slot.state;
  if (committed || !isAwaitingGo(tempId)) release(slot);
  else if (!touched) patch(slot, { touched: true });
}

/** The screen shows the pending start: `onCreated` takes the user on
 *  once its job exists. Returns the cleanup. */
export function showStart(onCreated: () => void): () => void {
  onShownCreated = onCreated;
  return () => {
    if (onShownCreated === onCreated) onShownCreated = null;
  };
}

export function subscribeStart(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export function getPendingStart(): PendingStart | null {
  return current?.state ?? null;
}

export function usePendingStart(): PendingStart | null {
  return useSyncExternalStore(subscribeStart, getPendingStart, () => null);
}

// ── the screens' contexts ────────────────────────────────────────────

/** What the start screens can do (StartScreen; stable). */
export type StartActions = {
  /** The file chooser ("Video wählen", "Dasselbe Video wählen"). */
  choose(): void;
  /** iOS: the chooser without a format filter; `fromHint`: "Trotzdem
   *  wählen" (a cancel brings the hint back). */
  chooseAny(fromHint: boolean): void;
  /** A file dropped on the card. */
  drop(file: File | null): void;
  setChoices(next: (c: Choices) => Choices): void;
  go(): void;
  cancel(): void;
  retry(): void;
};

/** What "Untertitel wählen" shows besides the upload's progress. */
export type StartView = {
  start: PendingStart;
  /** The style tiles, in launch order (the live ones). */
  tiles: readonly PresetId[];
  /** "Dein Standard" / "Zuletzt benutzt" by preset id ("none": the
   *  "Ohne Untertitel" row's chip). */
  tags: Partial<Record<string, MessageKey>>;
  /** "Dein Standard": its tile draws it with its look. */
  standard: StyleChoice | null;
  /** The spoken languages a video can be in (GET /config). */
  languages: readonly string[];
};

export const StartActionsContext = createContext<StartActions | null>(null);
export const StartViewContext = createContext<StartView | null>(null);

export function useStartActions(): StartActions {
  const a = use(StartActionsContext);
  if (!a) throw new Error("useStartActions outside StartScreen");
  return a;
}

export function useStartView(): StartView {
  const v = use(StartViewContext);
  if (!v) throw new Error("useStartView outside a pending start");
  return v;
}
