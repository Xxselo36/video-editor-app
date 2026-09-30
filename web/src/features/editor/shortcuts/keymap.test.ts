import { describe, expect, it, vi } from "vitest";
import { actionFor, dispatchShortcut, keyTargetAllowed, shortcutLabel, type KeyLike, type KeyTarget } from "./keymap";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: key === " " ? "Space" : undefined,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

/** A fake element that matches the given selectors (by exact list item). */
function el(...matches: string[]): KeyTarget {
  return {
    closest(selector: string) {
      const parts = selector.split(",").map((s) => s.trim());
      return parts.some((p) => matches.includes(p)) ? {} : null;
    },
  };
}

describe("actionFor (editor.md §4.6)", () => {
  it("maps the plain keys", () => {
    expect(actionFor(k(" "))).toBe("playPause");
    expect(actionFor(k("k"))).toBe("playPause");
    expect(actionFor(k("K"))).toBe("playPause");
    expect(actionFor(k("ArrowLeft"))).toBe("stepBack");
    expect(actionFor(k("ArrowRight"))).toBe("stepForward");
    expect(actionFor(k("ArrowUp"))).toBe("prevLine");
    expect(actionFor(k("ArrowDown"))).toBe("nextLine");
    expect(actionFor(k("s"))).toBe("split");
    expect(actionFor(k("Delete"))).toBe("delete");
    expect(actionFor(k("Backspace"))).toBe("delete");
    expect(actionFor(k("h"))).toBe("hide");
    expect(actionFor(k("e"))).toBe("emphasize");
    expect(actionFor(k("Enter"))).toBe("edit");
    expect(actionFor(k("Escape"))).toBe("escape");
    expect(actionFor(k("="))).toBe("zoomIn");
    expect(actionFor(k("-"))).toBe("zoomOut");
    expect(actionFor(k("m"))).toBe("mute");
    expect(actionFor(k("f"))).toBe("fullscreen");
  });

  it("maps Shift combinations", () => {
    expect(actionFor(k("ArrowLeft", { shiftKey: true }))).toBe("stepBackLong");
    expect(actionFor(k("ArrowRight", { shiftKey: true }))).toBe("stepForwardLong");
    expect(actionFor(k("Z", { shiftKey: true }))).toBe("zoomFit");
    expect(actionFor(k("+", { shiftKey: true }))).toBe("zoomIn");
    expect(actionFor(k("S", { shiftKey: true }))).toBeNull();
    expect(actionFor(k(" ", { shiftKey: true }))).toBeNull();
  });

  it("maps ⌘ / Ctrl combinations", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(actionFor(k("z", mod))).toBe("undo");
      expect(actionFor(k("z", { ...mod, shiftKey: true }))).toBe("redo");
      expect(actionFor(k("Z", { ...mod, shiftKey: true }))).toBe("redo");
      expect(actionFor(k("y", mod))).toBe("redo");
      expect(actionFor(k("f", mod))).toBe("find");
      expect(actionFor(k("e", mod))).toBe("export");
      expect(actionFor(k("Enter", mod))).toBe("export");
      expect(actionFor(k("b", mod))).toBe("split");
      // ⌘S, ⌘C, ⌘K … stay the browser's.
      expect(actionFor(k("s", mod))).toBeNull();
      expect(actionFor(k("c", mod))).toBeNull();
      expect(actionFor(k("k", mod))).toBeNull();
    }
  });

  it("leaves Alt combinations and unknown keys alone", () => {
    expect(actionFor(k("k", { altKey: true }))).toBeNull();
    expect(actionFor(k("x"))).toBeNull();
    expect(actionFor(k("Tab"))).toBeNull();
  });
});

describe("keyTargetAllowed (UX3 target filtering)", () => {
  it("handles keys on the page and inside the editor", () => {
    expect(keyTargetAllowed(k(" "), null, true)).toBe(true);
    expect(keyTargetAllowed(k(" "), el("[data-editor-root]"), false)).toBe(true);
  });

  it("ignores keys aimed at other parts of the app (a dialog, the header)", () => {
    expect(keyTargetAllowed(k(" "), el(), false)).toBe(false);
    expect(keyTargetAllowed(k("z", { metaKey: true }), el("button"), false)).toBe(false);
  });

  it("never handles keys typed into text fields, even with ⌘", () => {
    for (const f of ["input", "textarea", "select", "[contenteditable]:not([contenteditable=false])"]) {
      expect(keyTargetAllowed(k(" "), el("[data-editor-root]", f), false)).toBe(false);
      expect(keyTargetAllowed(k("z", { metaKey: true }), el("[data-editor-root]", f), false)).toBe(false);
    }
  });

  it("ignores keys inside a search bar, a dialog / sheet or a menu", () => {
    for (const o of ["[role=search]", "[role=dialog]", "[role=menu]"]) {
      const t = el("[data-editor-root]", o);
      expect(keyTargetAllowed(k("s"), t, false)).toBe(false);
      expect(keyTargetAllowed(k("Backspace"), t, false)).toBe(false);
      expect(keyTargetAllowed(k("z", { metaKey: true }), t, false)).toBe(false);
    }
  });

  it("leaves focused controls their own keys unless ⌘/Ctrl is held", () => {
    for (const c of ["button", "a", "[role=tab]", "[role=button]", "[role=menuitem]", "[role=slider]", "summary"]) {
      const t = el("[data-editor-root]", c);
      expect(keyTargetAllowed(k(" "), t, false)).toBe(false);
      expect(keyTargetAllowed(k("Backspace"), t, false)).toBe(false);
      expect(keyTargetAllowed(k("z", { metaKey: true }), t, false)).toBe(true);
      expect(keyTargetAllowed(k("z", { ctrlKey: true }), t, false)).toBe(true);
    }
  });

  it("respects defaultPrevented", () => {
    expect(keyTargetAllowed(k(" ", { defaultPrevented: true }), null, true)).toBe(false);
  });
});

describe("dispatchShortcut", () => {
  it("runs the handler and reports it handled", () => {
    const playPause = vi.fn();
    expect(dispatchShortcut(k(" "), null, true, { playPause })).toBe(true);
    expect(playPause).toHaveBeenCalledOnce();
  });

  it("a handler returning false keeps the key's default", () => {
    const del = vi.fn(() => false);
    expect(dispatchShortcut(k("Backspace"), null, true, { delete: del })).toBe(false);
    expect(del).toHaveBeenCalledOnce();
  });

  it("nothing happens without a handler or on a filtered target", () => {
    const split = vi.fn();
    expect(dispatchShortcut(k("x"), null, true, { split })).toBe(false);
    expect(dispatchShortcut(k("s"), el("[data-editor-root]", "input"), false, { split })).toBe(false);
    expect(dispatchShortcut(k("s"), null, true, {})).toBe(false);
    expect(split).not.toHaveBeenCalled();
  });
});

describe("shortcutLabel", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere", () => {
    expect(shortcutLabel("⌘Z", true)).toBe("⌘Z");
    expect(shortcutLabel("⌘Z", false)).toBe("Ctrl+Z");
    expect(shortcutLabel("⇧⌘Z", false)).toBe("Shift+Ctrl+Z");
  });
});
