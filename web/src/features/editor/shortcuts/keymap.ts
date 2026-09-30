/**
 * Editor keyboard shortcuts (editor.md §4.6), as pure functions so the
 * mapping and the target filter are unit-tested (UX7d).
 *
 *   Space / K          play / pause
 *   ← / →              step 0.1 s (Shift: 1 s)
 *   ↑ / ↓              previous / next caption line
 *   S, ⌘B              split at the playhead
 *   ⌫ / Del            delete the selected clip (UX10: cut selected words)
 *   H / E              hide / emphasize selected words (UX8; no-op until then)
 *   Enter / Esc        edit the selected word (UX8) / close or deselect
 *   ⌘Z, ⌘⇧Z / ⌘Y       undo / redo
 *   ⌘F                 find
 *   = / - / ⇧Z         zoom the timeline in / out / fit
 *   ⌘E, ⌘↵             export
 *   M / F              mute / fullscreen (tooltips of the player bar)
 * ⌘ is Ctrl outside macOS. Shortcuts are shown in tooltips; there is no
 * "?" sheet (review G3).
 */

export type EditorAction =
  | "playPause"
  | "stepBack"
  | "stepForward"
  | "stepBackLong"
  | "stepForwardLong"
  | "prevLine"
  | "nextLine"
  | "split"
  | "delete"
  | "hide"
  | "emphasize"
  | "edit"
  | "escape"
  | "undo"
  | "redo"
  | "find"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  | "export"
  | "mute"
  | "fullscreen";

export type KeyLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
};

/** The action a key press asks for, or null. */
export function actionFor(e: KeyLike): EditorAction | null {
  if (e.altKey) return null;
  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (meta) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y" && !e.shiftKey) return "redo";
    if (e.shiftKey) return null;
    if (key === "f") return "find";
    if (key === "e" || key === "Enter") return "export";
    if (key === "b") return "split";
    return null;
  }
  if (key === " " || e.code === "Space") return e.shiftKey ? null : "playPause";
  if (key === "ArrowLeft") return e.shiftKey ? "stepBackLong" : "stepBack";
  if (key === "ArrowRight") return e.shiftKey ? "stepForwardLong" : "stepForward";
  if (e.shiftKey) {
    if (key === "z") return "zoomFit";
    // "+" is Shift+= on US keyboards.
    if (key === "+") return "zoomIn";
    return null;
  }
  switch (key) {
    case "k":
      return "playPause";
    case "ArrowUp":
      return "prevLine";
    case "ArrowDown":
      return "nextLine";
    case "s":
      return "split";
    case "Delete":
    case "Backspace":
      return "delete";
    case "h":
      return "hide";
    case "e":
      return "emphasize";
    case "Enter":
      return "edit";
    case "Escape":
      return "escape";
    case "=":
    case "+":
      return "zoomIn";
    case "-":
      return "zoomOut";
    case "m":
      return "mute";
    case "f":
      return "fullscreen";
    default:
      return null;
  }
}

/** What the filter needs of the event target (an Element in the app). */
export type KeyTarget = { closest(selector: string): unknown } | null;

const TEXT_FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
const OWN_KEYS = "button, a, [role=tab], [role=button], [role=menuitem], [role=slider], summary";

/**
 * Whether the editor may handle a key (moved from TimelineEditor, UX3 /
 * tech.md T4):
 *   - not when something already handled it;
 *   - only for keys aimed at the editor (`[data-editor-root]`) or the page
 *     itself (`onPage`: target is body / html / none) — not a dialog or
 *     other parts of the app;
 *   - never in text fields;
 *   - without ⌘/Ctrl, never on a focused button, tab, link, menu item or
 *     slider: those keep their own Space / Enter / Backspace / arrows.
 */
export function keyTargetAllowed(e: KeyLike, target: KeyTarget, onPage: boolean): boolean {
  if (e.defaultPrevented) return false;
  if (!onPage && !target?.closest("[data-editor-root]")) return false;
  if (target?.closest(TEXT_FIELDS)) return false;
  const meta = e.metaKey || e.ctrlKey;
  if (!meta && target?.closest(OWN_KEYS)) return false;
  return true;
}

export type ShortcutHandlers = Partial<Record<EditorAction, () => boolean | void>>;

/**
 * Runs the handler a key press asks for. True when it was handled (the
 * caller then prevents the default); a handler returning `false` did
 * nothing, so the key keeps its default.
 */
export function dispatchShortcut(
  e: KeyLike,
  target: KeyTarget,
  onPage: boolean,
  handlers: ShortcutHandlers,
): boolean {
  if (!keyTargetAllowed(e, target, onPage)) return false;
  const action = actionFor(e);
  const run = action ? handlers[action] : undefined;
  if (!run) return false;
  return run() !== false;
}

/** Tooltip suffix with the platform's modifier ("⌘Z" / "Ctrl+Z"). */
export function shortcutLabel(combo: string, mac: boolean): string {
  return mac ? combo : combo.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
}
