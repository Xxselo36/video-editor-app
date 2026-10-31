/**
 * The height of a bar that sticks to "Untertitel wählen" on phones (the
 * upload strip at the top, the go bar at the bottom) as a CSS variable on
 * <html>. The page's scroll padding (globals.css) is that much, so what
 * gets focus or is scrolled to stays clear of the bar whatever it shows:
 * a paused line, a failure, a label on two lines. Gone with the bar.
 */
import { useEffect, type RefObject } from "react";

export type BarVar = "--start-strip-h" | "--start-go-h";

export function useBarHeight(ref: RefObject<HTMLElement | null>, name: BarVar): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const set = () => root.style.setProperty(name, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el, { box: "border-box" });
    return () => {
      ro.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
