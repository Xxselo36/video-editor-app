"use client";
// Small browser hooks of the v2 shell.
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

/** A media query's current answer (the shell is client-only). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below 900 px wide or 500 px high: the phone layout (bottom tabs + sheets). */
export const PHONE_QUERY = "(max-width: 899.98px), (max-height: 499.98px)";

/** A phone held sideways (short and wide): side-by-side phone layout. */
export const LANDSCAPE_QUERY = "(max-height: 499.98px) and (orientation: landscape)";

/**
 * viewport-fit=cover while the editor is open (UX7c): the safe-area
 * insets then reach the CSS (env(safe-area-inset-*): the phone root's
 * padding, the tab bar, the sheets, the iPhone pseudo-fullscreen), and
 * the landscape notch sides are ours instead of letterboxed. The rest of
 * the site keeps its viewport.
 */
export function useViewportFitCover(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const before = meta.content;
    if (/viewport-fit\s*=/.test(before)) return;
    meta.content = `${before}${before.trim() ? ", " : ""}viewport-fit=cover`;
    return () => {
      meta.content = before;
    };
  }, []);
}

/** The keyboard (or anything else) hides more than this of the screen. */
const KEYBOARD_MIN = 120;

/**
 * The on-screen keyboard on phones (UX7c): iOS Safari (and Chrome since
 * 108) shrink only the *visual* viewport, so a fixed full-height editor
 * keeps its bottom — the sheet and the word field — behind the keyboard.
 * While an input is focused and the visual viewport is clearly shorter
 * than the layout one, the root gets data-keyboard plus --ed-vv-top /
 * --ed-vv-h, and the CSS fits the editor into the visible part.
 */
export function useKeyboardInset(root: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!root || !enabled || !vv) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const a = document.activeElement;
      const typing = !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
      const hidden = window.innerHeight - vv.height;
      if (typing && hidden > KEYBOARD_MIN) {
        root.setAttribute("data-keyboard", "");
        root.style.setProperty("--ed-vv-top", `${Math.round(vv.offsetTop)}px`);
        root.style.setProperty("--ed-vv-h", `${Math.round(vv.height)}px`);
      } else if (root.hasAttribute("data-keyboard")) {
        root.removeAttribute("data-keyboard");
        root.style.removeProperty("--ed-vv-top");
        root.style.removeProperty("--ed-vv-h");
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.removeAttribute("data-keyboard");
      root.style.removeProperty("--ed-vv-top");
      root.style.removeProperty("--ed-vv-h");
    };
  }, [root, enabled]);
}

/** navigator.onLine, following the online/offline events. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** The editor's root element: popovers portal into it (tokens apply). */
export const EditorRootContext = createContext<HTMLElement | null>(null);
export function useEditorRoot(): HTMLElement | null {
  return useContext(EditorRootContext);
}

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘Z" on macOS, "Ctrl+Z" elsewhere. */
export function kbd(combo: string): string {
  return IS_MAC ? combo : combo.replace(/⇧⌘/g, "Ctrl+Shift+").replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
}
