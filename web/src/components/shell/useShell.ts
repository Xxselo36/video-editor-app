"use client";
/**
 * What the app shell (./AppShell) shares with the screens in it: whether
 * a screen is inside it, the phone top bar's title and the bar's slot
 * for a screen's own action (components/PageTitle), and whether this
 * document has gone from one app screen to another yet.
 */
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";

export type ShellValue = {
  /** The phone top bar's end, where a screen puts its action (PageTitle `trailing`). */
  trailing: HTMLElement | null;
};

export const ShellContext = createContext<ShellValue | null>(null);

/** The shell, or null outside it (v1 keeps the page header of before). */
export function useShell(): ShellValue | null {
  return useContext(ShellContext);
}

export function useInShell(): boolean {
  return useContext(ShellContext) !== null;
}

let navigations = 0;

/** AppShell: the path changed (a menu link, any link, Back, Forward). */
export function noteNavigation(): void {
  navigations += 1;
}

/**
 * Whether this document has gone from one app screen to another yet. The
 * first screen of a visit may send an empty Projekte page on to Neues
 * Video; reached through the menu, it shows its empty state (plan D17).
 */
export function navigatedInApp(): boolean {
  return navigations > 0;
}

export type TopBar = { title: string; edge: "line" | "none" };

// The titles screens ask for, oldest first: the newest one shows (a
// screen that replaces another mounts before the old one is gone).
let asked: { bar: TopBar }[] = [];
let current: TopBar | null = null;
const listeners = new Set<() => void>();

function publish() {
  current = asked.length ? asked[asked.length - 1].bar : null;
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/**
 * PageTitle: `title` in the phone top bar while the screen is mounted;
 * `edge` "none" when the screen draws the line under the bar itself
 * (the upload strip of "Untertitel wählen"). Off outside the shell.
 */
export function useTopBarTitle(title: string, edge: TopBar["edge"], on: boolean): void {
  useLayoutEffect(() => {
    if (!on) return;
    const entry = { bar: { title, edge } };
    asked = [...asked, entry];
    publish();
    return () => {
      asked = asked.filter((e) => e !== entry);
      publish();
    };
  }, [title, edge, on]);
}

/** AppShell: the title the screen asked for, null until one did. */
export function useTopBar(): TopBar | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
